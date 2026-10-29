// Idempotent startup bootstrap for local development (npm run dev / npm start) and Vercel builds.
// Ensures a freshly-cloned repository has products, featured product photos, staff accounts,
// and customer accounts ready out of the box without touching existing records.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { createPreview, confirmImport } from '../import/service.js';
import { seedFeaturedProductImages } from '../domain/images.js';
import { hashPassword } from '../domain/passwords.js';

export function bootstrapDatabase(db) {
  try {
    // 1. Seed products from fixtures/sample-products.xlsx if the database has no products yet
    const prodCount = db.prepare('SELECT COUNT(*) AS c FROM products').get()?.c || 0;
    if (prodCount === 0) {
      const sampleXlsx = path.join(ROOT, 'fixtures', 'sample-products.xlsx');
      if (fs.existsSync(sampleXlsx)) {
        const { batchId, preview } = createPreview(db, sampleXlsx, 'sample-products.xlsx');
        if (preview.ok) {
          confirmImport(db, batchId);
        }
      }
    }

    // 2. Ensure the 4 featured product images are copied and linked
    seedFeaturedProductImages(db);

    // 3. Ensure default staff accounts (Admins + Sales Reps) exist with valid scrypt hashes
    const defaultPassHash = hashPassword('Admin123456!');
    const staffSeeds = [
      { name: 'Manfred Sunu', email: 'sunumanfred14@gmail.com', role: 'ADMIN', repId: null },
      { name: 'Hammoud', email: 'hammoudam1990@gmail.com', role: 'ADMIN', repId: null },
      { name: 'Brain Amponsah', email: 'amponsahbrain2007@gmail.com', role: 'ADMIN', repId: null },
      { name: 'Kwame Asante', email: 'kwame@boxforless.com', role: 'SALES_REP', repId: 'rep-1' },
      { name: 'Efua Owusu', email: 'efua@boxforless.com', role: 'SALES_REP', repId: 'rep-2' },
    ];

    const insertStaff = db.prepare(`
      INSERT INTO staff_users (name, email, role, rep_id, password_hash, must_change_password, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, 'system', datetime('now'), datetime('now'))
    `);

    for (const s of staffSeeds) {
      const existing = db.prepare('SELECT id, password_hash FROM staff_users WHERE lower(email) = ?').get(s.email.toLowerCase());
      if (!existing) {
        insertStaff.run(s.name, s.email.toLowerCase(), s.role, s.repId, defaultPassHash);
      } else if (!String(existing.password_hash || '').startsWith('scrypt$')) {
        db.prepare('UPDATE staff_users SET password_hash = ?, role = ?, is_active = 1 WHERE id = ?')
          .run(defaultPassHash, s.role, existing.id);
      }
    }

    // 4. Ensure default customer accounts exist and can sign in via ID/email + Admin123456! or access code 2N4Y-RNWP
    const customerSeeds = [
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

    const insertCust = db.prepare(`
      INSERT INTO customers (odoo_customer_ref, name, phone, email, delivery_address, salesperson, access_code, password_hash, password_set_at, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `);

    // Ensure code-only demo customer (4100 / 2N4Y-RNWP) and email demo customer (kofi@accramart.gh) exist
    const codeCust = db.prepare("SELECT id FROM customers WHERE access_code = '2N4YRNWP' OR odoo_customer_ref = '4100'").get();
    if (!codeCust) {
      insertCust.run('4100', 'Accra Supermart Ltd', '0241987650', null, 'Ring Road Central, Accra', 'Kwame Asante', '2N4YRNWP', null, null);
    }

    const emailCust = db.prepare("SELECT id, password_hash FROM customers WHERE lower(email) = 'kofi@accramart.gh' AND (odoo_customer_ref IS NULL OR odoo_customer_ref = '')").get();
    if (!emailCust) {
      insertCust.run(null, 'Accra Supermart Ltd', '0241987654', 'kofi@accramart.gh', 'Ring Road Central, Accra', 'Kwame Asante', 'TZSWJWD8', defaultPassHash, new Date().toISOString());
    } else if (!emailCust.password_hash) {
      db.prepare("UPDATE customers SET password_hash = ?, password_set_at = datetime('now') WHERE id = ?").run(defaultPassHash, emailCust.id);
    }

    for (const c of customerSeeds) {
      const existing = db.prepare('SELECT id, password_hash FROM customers WHERE odoo_customer_ref = ?').get(c.odoo_ref);
      let id;
      if (existing) {
        id = existing.id;
        if (!existing.password_hash) {
          db.prepare("UPDATE customers SET password_hash = ?, password_set_at = datetime('now') WHERE id = ?").run(defaultPassHash, id);
        }
      } else {
        const res = insertCust.run(c.odoo_ref, c.name, c.phone, null, c.address, c.rep, null, defaultPassHash, new Date().toISOString());
        id = Number(res.lastInsertRowid);
      }
      db.prepare(`
        INSERT INTO shop_reps (customer_id, rep_id, set_by, set_at) VALUES (?, ?, 'system', datetime('now'))
        ON CONFLICT(customer_id) DO UPDATE SET rep_id = excluded.rep_id, set_at = datetime('now')
      `).run(id, c.repId);
    }
  } catch (err) {
    console.warn('[bootstrap] Non-fatal seed warning:', err.message);
  }
}
