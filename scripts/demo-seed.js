// Fill a LOCAL database with demo customers and requests, so the staff screens have
// something to show. Fictional names only. Run after `npm run migrate` and a product import.
//
//   node scripts/demo-seed.js            # report what WOULD be added
//   node scripts/demo-seed.js --confirm  # add it
//
// Safety: refuses to run against a database that already holds real customers (more
// than 50), and never touches an existing row — demo customers are recognised by name,
// so running it twice adds nothing the second time.
import { openDatabase } from '../src/db/connection.js';
import { generateAccessCode, formatAccessCode } from '../src/domain/access-codes.js';

const confirm = process.argv.includes('--confirm');
const DEMO_CUSTOMERS = [
  ['ABC Wholesale (Demo)', '0200000101', 'Shop 3, Demo Market, Accra'],
  ['XYZ Foods (Demo)', '0200000102', 'Unit 9, Demo Industrial Area, Tema'],
  ['Corner Market (Demo)', '0200000103', '12 Demo Road, Kumasi'],
  ['Supply Co (Demo)', '0200000104', 'Plot 5, Demo Avenue, Takoradi'],
  ['Bulk Retail (Demo)', '0200000105', 'Demo Junction, Cape Coast'],
  ['Northern Provisions (Demo)', '0200000106', 'Demo Lane, Tamale'],
];
// [customer index, days ago, hour, status, lines]
const DEMO_REQUESTS = [
  [0, 0, 9, 'SUBMITTED', 3], [1, 0, 8, 'SUBMITTED', 2], [2, 1, 16, 'ACCEPTED', 4],
  [3, 1, 11, 'ACCEPTED', 1], [4, 2, 17, 'DELETED', 2], [5, 2, 13, 'ACCEPTED', 5],
  [0, 3, 10, 'ACCEPTED', 2], [1, 4, 15, 'SUBMITTED', 3], [2, 5, 9, 'ACCEPTED', 2],
  [3, 6, 14, 'ACCEPTED', 3], [4, 8, 12, 'ACCEPTED', 2], [5, 10, 10, 'ACCEPTED', 1],
];

const db = openDatabase();
const realCustomers = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name NOT LIKE '%(Demo)'").get().n;
if (realCustomers > 50) {
  console.error(`Refusing: this database has ${realCustomers} real customers. The demo seed is for local databases only.`);
  process.exit(1);
}
const products = db.prepare(`SELECT id, name, barcode, box_uom FROM products
  WHERE is_active = 1 ORDER BY id LIMIT 40`).all();
if (!products.length) {
  console.error('No active products. Import products first: node scripts/import-cli.js fixtures/sample-products.xlsx --confirm');
  process.exit(1);
}

const findCustomer = db.prepare('SELECT id, access_code FROM customers WHERE name = ?');
const plannedCustomers = DEMO_CUSTOMERS.filter(([name]) => !findCustomer.get(name));
const hasDemoRequests = db.prepare(`SELECT COUNT(*) AS n FROM requests r JOIN customers c ON c.id = r.customer_id
  WHERE c.name LIKE '%(Demo)'`).get().n > 0;

console.log(`Demo customers to add: ${plannedCustomers.length} of ${DEMO_CUSTOMERS.length}`);
console.log(`Demo requests to add:  ${hasDemoRequests ? 0 : DEMO_REQUESTS.length}`);
if (!confirm) {
  console.log('\nNothing written. Run again with --confirm to add them.');
  process.exit(0);
}

const now = new Date();
const iso = (d) => d.toISOString();
db.exec('BEGIN');
try {
  const insertCustomer = db.prepare(`INSERT INTO customers (name, phone, country, is_active, access_code,
    access_code_issued_at, delivery_address, created_at, updated_at) VALUES (?, ?, 'Ghana', 1, ?, ?, ?, ?, ?)`);
  for (const [name, phone, address] of plannedCustomers) {
    insertCustomer.run(name, phone, generateAccessCode(), iso(now), address, iso(now), iso(now));
  }

  if (!hasDemoRequests) {
    const insertRequest = db.prepare(`INSERT INTO requests (reference, customer_id, delivery_address, status,
      submitted_at, stock_as_of, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertItem = db.prepare(`INSERT INTO request_items (request_id, product_id, quantity_ctn,
      product_name_at_request, barcode_at_request, box_uom_at_request, available_ctn_at_request, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const last = db.prepare("SELECT reference FROM requests WHERE reference LIKE ? ORDER BY reference DESC LIMIT 1")
      .get(`REQ-${now.getUTCFullYear()}-%`);
    let seq = last ? Number(last.reference.split('-')[2]) || 0 : 0;
    // oldest first, so the references count up with time
    const ordered = [...DEMO_REQUESTS].sort((a, b) => b[1] - a[1] || a[2] - b[2]);
    ordered.forEach(([ci, daysAgo, hour, status, lines], n) => {
      const customer = findCustomer.get(DEMO_CUSTOMERS[ci][0]);
      const at = new Date(now);
      at.setDate(at.getDate() - daysAgo);
      at.setHours(hour, (n * 7) % 60, 0, 0);
      seq += 1;
      const reference = `REQ-${now.getUTCFullYear()}-${String(seq).padStart(4, '0')}`;
      const { lastInsertRowid } = insertRequest.run(reference, customer.id, DEMO_CUSTOMERS[ci][2], status,
        iso(at), iso(at), status === 'DELETED' ? iso(at) : null, iso(at), iso(at));
      for (let i = 0; i < lines; i++) {
        const p = products[(n * 3 + i) % products.length];
        insertItem.run(lastInsertRowid, p.id, 1 + ((n + i) % 6), p.name, p.barcode, p.box_uom, null, iso(at));
      }
    });
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log('\nDone. Demo customers and their access codes:');
for (const [name] of DEMO_CUSTOMERS) {
  const c = findCustomer.get(name);
  console.log(`  ${formatAccessCode(c.access_code)}  ${name}`);
}
