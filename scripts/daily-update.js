// The morning routine: refresh stock and the customer list in one command.
//
//   node scripts/daily-update.js                 # preview both, write nothing
//   node scripts/daily-update.js --confirm       # apply both
//
//   --products  "<path.xlsx>"   use this product export instead of searching
//   --customers "<path.xlsx>"   use this contact export instead of searching
//   --skip-customers            stock only
//   --deactivate-missing        only when the contact file is the COMPLETE book
//
// With no paths given it picks the NEWEST matching export from the Downloads
// folder and prints which files it chose, with their dates, so a stale or wrong
// file is caught before anything is written. Nothing lands without --confirm.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import openDatabase from '../src/db/connection.js';
import config from '../src/config.js';
import { createPreview, confirmImport } from '../src/import/service.js';
import { createCustomerPreview, confirmCustomerImport } from '../src/import/customer-service.js';
import { getStockSource } from '../src/domain/stock-source.js';

const DOWNLOADS = path.join(os.homedir(), 'Downloads');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

/** Newest file in Downloads whose name matches, or null. */
function newestMatching(pattern) {
  let found = null;
  try {
    for (const name of fs.readdirSync(DOWNLOADS)) {
      if (!pattern.test(name) || !name.toLowerCase().endsWith('.xlsx')) continue;
      if (name.startsWith('~$')) continue; // Excel lock file
      const full = path.join(DOWNLOADS, name);
      const at = fs.statSync(full).mtimeMs;
      if (!found || at > found.at) found = { file: full, at };
    }
  } catch { return null; }
  return found;
}

const ageInDays = (ms) => ((Date.now() - ms) / 86_400_000).toFixed(1);

function banner(title) {
  console.log(`\n${'='.repeat(64)}\n  ${title}\n${'='.repeat(64)}`);
}

function main() {
  const confirm = flag('--confirm');
  const db = openDatabase(config.dbPath);
  let wrote = false;

  // ---------------------------------------------------------------- products
  banner('STOCK');
  const productPath = value('--products')
    || newestMatching(/^Product Variant .*\.xlsx$/i)?.file;

  if (!productPath || !fs.existsSync(productPath)) {
    console.log('  No product export found.');
    console.log(`  Looked for "Product Variant (…).xlsx" in ${DOWNLOADS}`);
    console.log('  Pass one with --products "<path>".');
  } else {
    console.log(`  File: ${productPath}`);
    console.log(`  Exported: ${ageInDays(fs.statSync(productPath).mtimeMs)} days ago`);

    const { batchId, preview } = createPreview(db, productPath, path.basename(productPath));
    if (!preview.ok) {
      console.error(`  REFUSED: ${preview.fatal}`);
      console.error('  Nothing was written. Fix the export and run again.');
      db.close();
      process.exit(2);
    }
    const s = preview.summary;
    console.table({
      total_rows: s.total_rows, valid: s.valid_rows, invalid: s.invalid_rows,
      new: s.created, updated: s.updated, unchanged: s.unchanged,
      will_inactivate: s.inactivated, barcode_changes: s.barcode_changes,
      uom_changes: s.uom_changes, warnings: s.warnings,
    });
    if (s.barcode_changes || s.uom_changes) {
      console.log('  Barcode/UoM changes are FLAGGED, never applied silently —');
      console.log('  approve them in the staff area under Change Review.');
    }
    if (confirm) {
      const result = confirmImport(db, batchId);
      console.log('  APPLIED:', JSON.stringify(result.counts));
      wrote = true;
    }
  }

  // --------------------------------------------------------------- customers
  if (!flag('--skip-customers')) {
    banner('CUSTOMERS');
    const customerPath = value('--customers')
      || newestMatching(/^Contact \(res\.partner\).*\.xlsx$/i)?.file;

    if (!customerPath || !fs.existsSync(customerPath)) {
      console.log('  No contact export found.');
      console.log(`  Looked for "Contact (res.partner)(…).xlsx" in ${DOWNLOADS}`);
      console.log('  Pass one with --customers "<path>", or --skip-customers.');
    } else {
      console.log(`  File: ${customerPath}`);
      console.log(`  Exported: ${ageInDays(fs.statSync(customerPath).mtimeMs)} days ago`);

      const { batchId, preview } = createCustomerPreview(db, customerPath, path.basename(customerPath));
      const c = preview.summary;
      console.table({
        total_rows: c.total_rows, valid: c.valid_rows, invalid: c.invalid_rows,
        duplicates_in_file: c.duplicate_rows, new_customers: c.new_count,
        updated: c.updated_count, unchanged: c.unchanged_count, warnings: c.warning_count,
      });
      if (preview.errorRows.length) {
        console.log(`  Refused rows (${preview.errorRows.length}):`);
        for (const r of preview.errorRows.slice(0, 10)) {
          console.log(`    row ${r.rowNumber}  ${r.name ?? '(no name)'} — ${r.errors.join('; ')}`);
        }
      }
      if (confirm) {
        const result = confirmCustomerImport(db, batchId, { deactivateMissing: flag('--deactivate-missing') });
        console.log('  APPLIED:', JSON.stringify(result.counts));
        if (result.counts.codesIssued) {
          console.log(`  ${result.counts.codesIssued} access code(s) issued — see Access Codes in the staff area.`);
        }
        wrote = true;
      }
    }
  }

  // ------------------------------------------------------------------ verdict
  banner(confirm ? 'RESULT' : 'PREVIEW ONLY');
  if (!confirm) {
    console.log('  Nothing was written. Re-run with --confirm to apply:');
    console.log('    node scripts/daily-update.js --confirm');
  } else if (wrote) {
    const stock = getStockSource().getStockStatus(db);
    console.log(`  Customers can submit requests: ${stock.hasData && stock.fresh ? 'YES' : 'NO'}`);
    if (stock.asOf) console.log(`  Stock as of: ${stock.asOf}`);
    console.log('  Submissions stay open for 24 hours from this import.');
  }
  console.log('');
  db.close();
}

main();
