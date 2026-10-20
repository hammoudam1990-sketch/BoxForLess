// Fill a LOCAL database with demo delivery lots (with expiry dates) for the sales rep app.
// Run after the product import and `node scripts/demo-seed.js --confirm`.
//
//   node scripts/demo-seed-lots.js            # report what WOULD be added
//   node scripts/demo-seed-lots.js --confirm  # add it
//
// Safety: only demo customers (name ends "(Demo)") get lots; a customer that already has
// lots is skipped, so running it twice adds nothing the second time.
import { openDatabase } from '../src/db/connection.js';

const confirm = process.argv.includes('--confirm');
// [days until expiry, delivered cartons] — a spread of red / amber / green lots per shop.
const PATTERNS = [
  [[4, 120], [12, 120], [18, 80]],
  [[9, 60], [25, 90]],
  [[-2, 40], [6, 50], [40, 100]],
  [[15, 70]],
  [[3, 30], [20, 60], [33, 45], [55, 80]],
  [[28, 50], [47, 90]],
];

const db = openDatabase();
const customers = db.prepare("SELECT id, name FROM customers WHERE name LIKE '%(Demo)' ORDER BY id").all();
const products = db.prepare('SELECT id FROM products WHERE is_active = 1 ORDER BY id LIMIT 30').all();
if (!customers.length || !products.length) {
  console.error('Need demo customers and products first (see scripts/demo-seed.js).');
  process.exit(1);
}

const has = db.prepare('SELECT 1 FROM delivery_lots WHERE customer_id = ? LIMIT 1');
const add = db.prepare(`INSERT INTO delivery_lots (customer_id, product_id, lot_code, delivered_ctn, expiry_date, delivered_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
let added = 0;
db.exec('BEGIN');
try {
  customers.forEach((c, ci) => {
    if (has.get(c.id)) return;
    PATTERNS[ci % PATTERNS.length].forEach(([days, qty], li) => {
      const product = products[(ci * 5 + li * 3) % products.length];
      added += 1;
      if (!confirm) return;
      add.run(c.id, product.id, `L-${String(ci + 1).padStart(2, '0')}-${String(li + 1).padStart(4, '0')}`, qty, day(days), day(-30), new Date().toISOString());
    });
  });
  db.exec(confirm ? 'COMMIT' : 'ROLLBACK');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(confirm ? `Added ${added} demo lots.` : `Would add ${added} demo lots. Re-run with --confirm.`);
