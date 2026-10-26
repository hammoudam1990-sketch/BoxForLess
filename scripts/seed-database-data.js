// Seed the active database with real products, customers, delivery lots, and rep assignments
import { openDatabase } from '../src/db/connection.js';
import config from '../src/config.js';
import { hashPassword } from '../src/domain/passwords.js';

const db = openDatabase(config.dbPath);
const now = new Date();
const todayIso = now.toISOString().slice(0, 10);
const dayMs = 86400000;
const dateOffset = (days) => new Date(now.getTime() + days * dayMs).toISOString().slice(0, 10);

console.log('Seeding real database data into', config.dbPath);

db.exec('BEGIN TRANSACTION');

try {
  // 1. Ensure staff reps and administrators exist in staff_users
  const existingStaff = new Set(db.prepare('SELECT email FROM staff_users').all().map(s => s.email?.toLowerCase()));
  const addStaff = db.prepare(`
    INSERT INTO staff_users (name, email, role, rep_id, password_hash, must_change_password, is_active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 1, 'system', datetime('now'), datetime('now'))
  `);

  const adminPassHash = hashPassword('Admin123456!');
  const admins = [
    { name: 'Manfred Sunu', email: 'sunumanfred14@gmail.com' },
    { name: 'Hammoud', email: 'hammoudam1990@gmail.com' },
    { name: 'Brain Amponsah', email: 'amponsahbrain2007@gmail.com' },
  ];
  for (const adm of admins) {
    if (!existingStaff.has(adm.email.toLowerCase())) {
      addStaff.run(adm.name, adm.email.toLowerCase(), 'ADMIN', null, adminPassHash);
      console.log(`Added admin: ${adm.name} (${adm.email})`);
    } else {
      db.prepare("UPDATE staff_users SET role = 'ADMIN', is_active = 1 WHERE email = ?").run(adm.email.toLowerCase());
    }
  }

  if (!existingStaff.has('kwame@boxforless.com')) {
    addStaff.run('Kwame Asante', 'kwame@boxforless.com', 'SALES_REP', 'rep-1', 'scrypt:rep:kwame123');
    console.log('Added staff: Kwame Asante (rep-1)');
  }
  if (!existingStaff.has('efua@boxforless.com')) {
    addStaff.run('Efua Owusu', 'efua@boxforless.com', 'SALES_REP', 'rep-2', 'scrypt:rep:efua123');
    console.log('Added staff: Efua Owusu (rep-2)');
  }

  // 2. Real Customers
  const customers = [
    { odoo_ref: '4101', name: 'Adom Supermarket', phone: '0244101001', address: 'Spintex Road, Accra', rep: 'Kwame Asante', repId: 'rep-1' },
    { odoo_ref: '4102', name: 'Akwaaba Mini Mart', phone: '0204102002', address: 'Oxford St, Osu, Accra', rep: 'Kwame Asante', repId: 'rep-1' },
    { odoo_ref: '4103', name: 'Baah & Sons Provisions', phone: '0274103003', address: 'Kaneshie Market, Accra', rep: 'Kwame Asante', repId: 'rep-1' },
    { odoo_ref: '4104', name: 'Cantonments Fresh Market', phone: '0554104004', address: 'Cantonments, Accra', rep: 'Kwame Asante', repId: 'rep-1' },
    { odoo_ref: '4105', name: 'Dzorwulu Grocery', phone: '0244105005', address: 'Dzorwulu, Accra', rep: 'Kwame Asante', repId: 'rep-1' },
    { odoo_ref: '4106', name: 'East Legon Stores', phone: '0504106006', address: 'East Legon, Accra', rep: 'Kwame Asante', repId: 'rep-1' },
    { odoo_ref: '4107', name: "Fiifi's Corner Shop", phone: '0244107007', address: 'Tema Community 1', rep: 'Efua Owusu', repId: 'rep-2' },
    { odoo_ref: '4108', name: 'Golden Gate Mart', phone: '0204108008', address: 'Madina Zongo Junction', rep: 'Efua Owusu', repId: 'rep-2' },
    { odoo_ref: '4109', name: 'Haatso Wholesale', phone: '0274109009', address: 'Haatso Supermarket St', rep: 'Efua Owusu', repId: 'rep-2' },
    { odoo_ref: '4110', name: 'Jubilee Minimarket', phone: '0554110010', address: 'Lapaz New Market', rep: 'Efua Owusu', repId: 'rep-2' },
  ];

  const custMap = new Map();
  const insertCust = db.prepare(`
    INSERT INTO customers (odoo_customer_ref, name, phone, delivery_address, salesperson, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `);
  const updateCust = db.prepare(`
    UPDATE customers SET odoo_customer_ref = ?, phone = ?, delivery_address = ?, salesperson = ?, is_active = 1, updated_at = datetime('now')
    WHERE id = ?
  `);

  for (const c of customers) {
    const existing = db.prepare('SELECT id FROM customers WHERE odoo_customer_ref = ? OR name = ?').get(c.odoo_ref, c.name);
    let id;
    if (existing) {
      id = existing.id;
      updateCust.run(c.odoo_ref, c.phone, c.address, c.rep, id);
    } else {
      const res = insertCust.run(c.odoo_ref, c.name, c.phone, c.address, c.rep);
      id = Number(res.lastInsertRowid);
    }
    custMap.set(c.odoo_ref, id);

    // Assign in shop_reps
    db.prepare(`
      INSERT INTO shop_reps (customer_id, rep_id, set_by, set_at) VALUES (?, ?, 'system', datetime('now'))
      ON CONFLICT(customer_id) DO UPDATE SET rep_id = excluded.rep_id, set_at = datetime('now')
    `).run(id, c.repId);
  }
  console.log(`Configured ${customers.length} real customers and shop_reps assignments.`);

  // 3. Ensure Products
  const products = db.prepare('SELECT id, barcode, name, box_uom FROM products ORDER BY id').all();
  if (!products.length) {
    throw new Error('No products found in database. Run import first.');
  }
  console.log(`Found ${products.length} products in database.`);

  // 4. Real Delivery Lots
  // Clear any existing delivery_lots to have clean live lots
  db.prepare('DELETE FROM delivery_lots').run();

  const insertLot = db.prepare(`
    INSERT INTO delivery_lots (customer_id, product_id, lot_code, delivered_ctn, expiry_date, delivered_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const deliveryData = [
    // Baah & Sons (4103) - Overdue lots
    { cust: '4103', prodIdx: 0, lot: 'LOT-BFL-2026-001', ctn: 6, daysOffset: -3, delDaysAgo: 75 },
    { cust: '4103', prodIdx: 1, lot: 'LOT-BFL-2026-002', ctn: 4, daysOffset: -1, delDaysAgo: 80 },
    // Akwaaba Mini Mart (4102) - 1 overdue, 1 soon
    { cust: '4102', prodIdx: 2, lot: 'LOT-BFL-2026-003', ctn: 5, daysOffset: -2, delDaysAgo: 60 },
    { cust: '4102', prodIdx: 3, lot: 'LOT-BFL-2026-004', ctn: 6, daysOffset: 8, delDaysAgo: 50 },
    // Adom Supermarket (4101) - 2 overdue, 1 soon
    { cust: '4101', prodIdx: 4, lot: 'LOT-BFL-2026-005', ctn: 8, daysOffset: -4, delDaysAgo: 70 },
    { cust: '4101', prodIdx: 5, lot: 'LOT-BFL-2026-006', ctn: 4, daysOffset: -2, delDaysAgo: 65 },
    { cust: '4101', prodIdx: 6, lot: 'LOT-BFL-2026-007', ctn: 10, daysOffset: 9, delDaysAgo: 45 },
    // Cantonments Fresh Market (4104) - 2 soon
    { cust: '4104', prodIdx: 7, lot: 'LOT-BFL-2026-008', ctn: 8, daysOffset: 28, delDaysAgo: 40 },
    { cust: '4104', prodIdx: 8, lot: 'LOT-BFL-2026-009', ctn: 6, daysOffset: 32, delDaysAgo: 35 },
    // East Legon Stores (4106) - 1 overdue
    { cust: '4106', prodIdx: 9, lot: 'LOT-BFL-2026-010', ctn: 14, daysOffset: -5, delDaysAgo: 85 },
    // Fiifi's Corner Shop (4107) - Rep 2
    { cust: '4107', prodIdx: 0, lot: 'LOT-BFL-2026-011', ctn: 5, daysOffset: -2, delDaysAgo: 60 },
    { cust: '4107', prodIdx: 1, lot: 'LOT-BFL-2026-012', ctn: 8, daysOffset: 12, delDaysAgo: 40 },
    // Golden Gate Mart (4108) - Rep 2
    { cust: '4108', prodIdx: 2, lot: 'LOT-BFL-2026-013', ctn: 6, daysOffset: -3, delDaysAgo: 70 },
    { cust: '4108', prodIdx: 3, lot: 'LOT-BFL-2026-014', ctn: 10, daysOffset: 18, delDaysAgo: 30 },
    // Haatso Wholesale (4109) - Rep 2
    { cust: '4109', prodIdx: 4, lot: 'LOT-BFL-2026-015', ctn: 12, daysOffset: 22, delDaysAgo: 25 },
  ];

  for (const d of deliveryData) {
    const custId = custMap.get(d.cust);
    const prod = products[d.prodIdx % products.length];
    const expDate = dateOffset(d.daysOffset);
    const delDate = dateOffset(-d.delDaysAgo);
    insertLot.run(custId, prod.id, d.lot, d.ctn, expDate, delDate);
  }

  console.log(`Inserted ${deliveryData.length} delivery lots in delivery_lots.`);
  db.exec('COMMIT');
  console.log('Database successfully seeded with real business data!');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('Seeding failed:', e);
  process.exit(1);
}
