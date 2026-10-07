// Give every active customer an access code, without touching anyone who has one.
//
//   node scripts/issue-access-codes.js            # report what WOULD be issued
//   node scripts/issue-access-codes.js --confirm  # issue them
//
// Reissuing an existing code is deliberately NOT done here: that would invalidate
// codes already sent to customers. Reissue one at a time from the staff screen.
import { openDatabase } from '../src/db/connection.js';
import { backfillAccessCodes, formatAccessCode } from '../src/domain/access-codes.js';

const confirm = process.argv.includes('--confirm');
const db = openDatabase();

const missing = db.prepare(
  "SELECT COUNT(*) n FROM customers WHERE is_active = 1 AND (access_code IS NULL OR access_code = '')"
).get().n;
const have = db.prepare("SELECT COUNT(*) n FROM customers WHERE access_code IS NOT NULL AND access_code != ''").get().n;

console.log(`Active customers without a code: ${missing}`);
console.log(`Already holding a code:          ${have}`);

if (!confirm) {
  console.log('\nPreview only — nothing was written. Re-run with --confirm to issue.');
  process.exit(0);
}

const issued = backfillAccessCodes(db);
console.log(`\nIssued ${issued} code${issued === 1 ? '' : 's'}.`);

for (const row of db.prepare(
  'SELECT name, access_code FROM customers WHERE access_code IS NOT NULL ORDER BY name COLLATE NOCASE LIMIT 5'
).all()) {
  console.log(`  ${formatAccessCode(row.access_code)}  ${row.name}`);
}
console.log('  …see the full list in the staff area under Access Codes.');
