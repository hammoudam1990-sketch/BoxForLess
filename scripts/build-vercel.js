import fs from 'node:fs';
import path from 'node:path';
import openDatabase from '../src/db/connection.js';
import { createPreview, confirmImport } from '../src/import/service.js';
import { ROOT } from '../src/config.js';
import { hashPassword } from '../src/domain/passwords.js';
import { seedFeaturedProductImages } from '../src/domain/images.js';

const dbPath = path.join(ROOT, 'data', 'product_master.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

console.log('[build] Preparing Box for Less database for Vercel deployment at', dbPath);
const db = openDatabase(dbPath);

// 1. Check if products exist; if not, import fixtures/sample-products.xlsx
try {
  const productCount = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
  if (productCount === 0) {
    const xlsxPath = path.join(ROOT, 'fixtures', 'sample-products.xlsx');
    if (fs.existsSync(xlsxPath)) {
      console.log('[build] Importing sample products from fixtures/sample-products.xlsx...');
      const { batchId, preview } = createPreview(db, xlsxPath, 'sample-products.xlsx');
      if (preview.ok) {
        confirmImport(db, batchId);
        console.log('[build] Successfully imported products from sample fixture.');
      } else {
        console.warn('[build] Sample products import warning:', preview.fatal);
      }
    }
  } else {
    console.log(`[build] Database already has ${productCount} products.`);
  }
} catch (e) {
  console.warn('[build] Products check/import notice:', e.message);
}

try {
  seedFeaturedProductImages(db);
  console.log('[build] Seeded featured photographed products and images.');
} catch (e) {
  console.warn('[build] Featured product images notice:', e.message);
}

// 2. Seed admins, reps, customers, delivery lots
try {
  const existingStaff = new Set(db.prepare('SELECT email FROM staff_users').all().map(s => s.email?.toLowerCase()));
  const addStaff = db.prepare(`
    INSERT INTO staff_users (name, email, role, rep_id, password_hash, must_change_password, is_active, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, 1, 'system', datetime('now'), datetime('now'))
  `);

  const adminPassHash = hashPassword('Admin123456!');
  const admins = [
    { name: 'Brain Amponsah', email: 'amponsahbrain2007@gmail.com' },
    { name: 'Hammoud', email: 'hammoudam1990@gmail.com' },
    { name: 'Manfred Sunu', email: 'sunumanfred14@gmail.com' },
  ];
  for (const adm of admins) {
    if (!existingStaff.has(adm.email.toLowerCase())) {
      addStaff.run(adm.name, adm.email.toLowerCase(), 'ADMIN', null, adminPassHash);
    }
  }
  if (!existingStaff.has('kwame@boxforless.com')) {
    addStaff.run('Kwame Asante', 'kwame@boxforless.com', 'SALES_REP', 'rep-1', 'scrypt:rep:kwame123');
  }
  if (!existingStaff.has('efua@boxforless.com')) {
    addStaff.run('Efua Owusu', 'efua@boxforless.com', 'SALES_REP', 'rep-2', 'scrypt:rep:efua123');
  }

  // Real customers
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
  for (const c of customers) {
    const existing = db.prepare('SELECT id FROM customers WHERE odoo_customer_ref = ? OR name = ?').get(c.odoo_ref, c.name);
    let id;
    if (existing) {
      id = existing.id;
    } else {
      const res = db.prepare(`
        INSERT INTO customers (odoo_customer_ref, name, phone, delivery_address, salesperson, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      `).run(c.odoo_ref, c.name, c.phone, c.address, c.rep);
      id = Number(res.lastInsertRowid);
    }
    db.prepare(`
      INSERT INTO shop_reps (customer_id, rep_id, set_by, set_at) VALUES (?, ?, 'system', datetime('now'))
      ON CONFLICT(customer_id) DO UPDATE SET rep_id = excluded.rep_id, set_at = datetime('now')
    `).run(id, c.repId);
  }

  // Delivery lots
  const prods = db.prepare('SELECT id FROM products ORDER BY id').all();
  if (prods.length > 0) {
    const custs = db.prepare('SELECT id FROM customers ORDER BY id').all();
    const lotsCount = db.prepare('SELECT COUNT(*) AS c FROM delivery_lots').get().c;
    if (lotsCount === 0 && custs.length > 0) {
      const insertLot = db.prepare(`
        INSERT INTO delivery_lots (customer_id, product_id, lot_code, delivered_ctn, expiry_date, delivered_at, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      insertLot.run(custs[0].id, prods[0].id, 'LOT-BFL-2026-001', 6, '2026-11-15');
      insertLot.run(custs[0].id, prods[1 % prods.length].id, 'LOT-BFL-2026-002', 4, '2026-11-20');
      insertLot.run(custs[1 % custs.length].id, prods[2 % prods.length].id, 'LOT-BFL-2026-003', 8, '2026-12-01');
    }
  }
} catch (err) {
  console.warn('[build] Non-fatal seeding note:', err.message);
}

db.close();
console.log('[build] Vercel build complete. SQLite database prepared successfully at', dbPath);
