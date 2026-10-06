// CLI import of the Odoo contact export: preview, and optionally confirm.
//
//   node scripts/import-customers-cli.js "<Contact (res.partner).xlsx>" [--confirm]
//
// Mirrors import-cli.js, which does the same for the product export. Preview
// writes nothing; nothing lands until --confirm.
//
// Confirming also issues an access code to every customer that does not yet have
// one, so a company appearing in a later export can be sent their code straight
// away. A code already held is never regenerated.
import openDatabase from '../src/db/connection.js';
import { createCustomerPreview, confirmCustomerImport } from '../src/import/customer-service.js';
import config from '../src/config.js';

function main() {
  const file = process.argv[2];
  const doConfirm = process.argv.includes('--confirm');
  // Absence is not deletion: a contact export is often a filtered view, so
  // customers missing from the file are left active unless this is passed.
  const deactivateMissing = process.argv.includes('--deactivate-missing');

  if (!file) {
    console.error('Usage: node scripts/import-customers-cli.js "<Contact (res.partner).xlsx>" [--confirm] [--deactivate-missing]');
    process.exit(1);
  }

  const db = openDatabase(config.dbPath);

  const { batchId, preview } = createCustomerPreview(db, file, file.split(/[\\/]/).pop());
  console.log(`\n=== PREVIEW (customer import #${batchId}) ===`);

  const s = preview.summary;
  console.table({
    total_rows: s.total_rows,
    valid: s.valid_rows,
    invalid: s.invalid_rows,
    duplicates_in_file: s.duplicate_rows,
    new_customers: s.new_count,
    updated: s.updated_count,
    unchanged: s.unchanged_count,
    warnings: s.warning_count,
  });

  if (!preview.hasStableId) {
    console.log('Note: this export carries no stable Odoo customer id, so rows are matched on');
    console.log('      display name. Renaming a company in Odoo creates a SECOND record with a');
    console.log('      new code. See IMPORT_RULES.md.');
  }
  if (preview.ignoredColumns?.length) {
    console.log('Ignored columns:', preview.ignoredColumns.join(', '));
  }
  if (preview.errorRows.length) {
    console.log(`\nRefused rows (${preview.errorRows.length}):`);
    for (const r of preview.errorRows.slice(0, 20)) {
      console.log(`  row ${r.rowNumber}  ${r.name ?? '(no name)'}  — ${r.errors.join('; ')}`);
    }
    if (preview.errorRows.length > 20) console.log(`  …and ${preview.errorRows.length - 20} more`);
  }

  if (!doConfirm) {
    console.log('\nPreview only — nothing was written. Re-run with --confirm to apply.');
    db.close();
    return;
  }

  console.log('\nConfirming…');
  const result = confirmCustomerImport(db, batchId, { deactivateMissing });
  console.log('=== COMPLETED ===');
  console.table(result.counts);
  if (result.counts.codesIssued) {
    console.log(`${result.counts.codesIssued} access code(s) issued to customers that had none.`);
    console.log('See them in the staff area under Access Codes.');
  }
  db.close();
}

main();
