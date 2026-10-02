// CLI import: preview, and optionally confirm.
//   node scripts/import-cli.js "<path-to.xlsx>" [--confirm]
import openDatabase from '../src/db/connection.js';
import { createPreview, confirmImport } from '../src/import/service.js';
import config from '../src/config.js';

function main() {
  const file = process.argv[2];
  const doConfirm = process.argv.includes('--confirm');
  if (!file) {
    console.error('Usage: node scripts/import-cli.js "<file.xlsx>" [--confirm]');
    process.exit(1);
  }
  const db = openDatabase(config.dbPath);

  const { batchId, status, preview } = createPreview(db, file, file.split(/[\\/]/).pop());
  console.log(`\n=== PREVIEW (batch #${batchId}, status ${status}) ===`);
  if (!preview.ok) {
    console.error('FATAL:', preview.fatal);
    db.close();
    process.exit(2);
  }
  const s = preview.summary;
  console.table({
    total_rows: s.total_rows, valid: s.valid_rows, invalid: s.invalid_rows,
    new: s.created, updated: s.updated, unchanged: s.unchanged,
    will_inactivate: s.inactivated, reactivate: s.reactivated,
    barcode_changes: s.barcode_changes, uom_changes: s.uom_changes,
    warnings: s.warnings, errors: s.errors, duplicate_barcodes: s.duplicate_barcodes,
  });
  if (preview.unexpectedColumns.length) console.log('Unexpected columns (ignored):', preview.unexpectedColumns.join(', '));
  if (preview.missingColumns.length) console.log('Missing required columns:', preview.missingColumns.join(', '));

  if (!doConfirm) {
    console.log('\nPreview only. Re-run with --confirm to apply.');
    db.close();
    return;
  }

  console.log('\nConfirming...');
  const result = confirmImport(db, batchId);
  console.log('=== COMPLETED ===');
  console.table(result.counts);
  db.close();
}

main();
