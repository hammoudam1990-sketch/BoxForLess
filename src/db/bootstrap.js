// Idempotent startup bootstrap for local development (npm run dev / npm start) and Vercel builds.
// Ensures the database has products, featured product photos, staff accounts for every role,
// customer accounts with price classes & credit limits, orders, invoices, payments, delivery lots,
// shelf visits, returns, clearance offers, payment reminders, and report targets.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';
import { createPreview, confirmImport } from '../import/service.js';
import { seedFeaturedProductImages, FEATURED_PHOTO_PRODUCTS } from '../domain/images.js';
import { fileUncategorised, refileGuessedNonFood } from '../domain/category-guess.js';
import { hashPassword } from '../domain/passwords.js';
import { seedHistory, historyLoaded } from '../domain/sample-history.js';
import { recomputeFinance } from '../domain/sample-odoo.js';
import { runReminders } from '../domain/payments.js';
import { setTarget } from '../domain/reports.js';
import { setLotDiscount, DiscountKind } from '../domain/lot-discounts.js';

export function bootstrapDatabase(db) {
  try {
    const now = new Date();
    const todayIso = now.toISOString().slice(0, 10);
    const dayMs = 86_400_000;
    const dateOffset = (days) => new Date(now.getTime() + days * dayMs).toISOString().slice(0, 10);

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

    // Ensure stock freshness timestamp is current for local/dev order submissions
    const latestBatch = db.prepare("SELECT id FROM import_batches WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1").get();
    if (latestBatch) {
      db.prepare('UPDATE import_batches SET completed_at = ?, confirmed_at = ? WHERE id = ?')
        .run(now.toISOString(), now.toISOString(), latestBatch.id);
    } else {
      db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('bootstrap.xlsx', 'COMPLETED', ?, ?, ?)")
        .run(now.toISOString(), now.toISOString(), now.toISOString());
    }

    // 2. Ensure the 4 featured product images are copied and linked
    seedFeaturedProductImages(db);

    // 2b. Ensure every active product has a category path & category_id so category filters and reports work. Odoo's
    //     category wins whenever the export carries one; these are filed by name until then (domain/category-guess.js).
    fileUncategorised(db, now.toISOString());
    // 2c. Products filed by name before the non-food rules existed (perfumes, detergents, shampoos under FOOD /
    //     SPICES & SEASONINGS): moved to their NON-FOOD category, each move logged, never one Odoo categorised.
    refileGuessedNonFood(db, { keep: FEATURED_PHOTO_PRODUCTS.map((p) => p.barcode), now: now.toISOString() });

    // 3. Ensure default staff accounts for ALL roles (ADMIN, SALES_MANAGER, WAREHOUSE, SALES_REP) exist
    const defaultPassHash = hashPassword('Admin123456!');
    const staffSeeds = [
      { name: 'Manfred Sunu', email: 'sunumanfred14@gmail.com', phone: '0244000010', phoneKey: '244000010', role: 'ADMIN', repId: null },
      { name: 'Hammoud', email: 'hammoudam1990@gmail.com', phone: '0244000011', phoneKey: '244000011', role: 'ADMIN', repId: null },
      { name: 'Brain Amponsah', email: 'amponsahbrain2007@gmail.com', phone: '0244000012', phoneKey: '244000012', role: 'ADMIN', repId: null },
      { name: 'Ama Boateng (Sales Manager)', email: 'sales@boxforless.com', phone: '0244000001', phoneKey: '244000001', role: 'SALES_MANAGER', repId: null },
      { name: 'Kofi Mensah (Warehouse)', email: 'warehouse@boxforless.com', phone: '0244000002', phoneKey: '244000002', role: 'WAREHOUSE', repId: null },
      { name: 'Kwame Asante', email: 'kwame@boxforless.com', phone: '0244000003', phoneKey: '244000003', role: 'SALES_REP', repId: 'rep-1' },
      { name: 'Efua Owusu', email: 'efua@boxforless.com', phone: '0244000004', phoneKey: '244000004', role: 'SALES_REP', repId: 'rep-2' },
    ];

    const insertStaff = db.prepare(`
      INSERT INTO staff_users (name, email, phone, phone_key, role, rep_id, password_hash, must_change_password, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 'system', datetime('now'), datetime('now'))
    `);

    for (const s of staffSeeds) {
      const existing = db.prepare('SELECT id, password_hash FROM staff_users WHERE lower(email) = ?').get(s.email.toLowerCase());
      if (!existing) {
        insertStaff.run(s.name, s.email.toLowerCase(), s.phone, s.phoneKey, s.role, s.repId, defaultPassHash);
      } else if (!String(existing.password_hash || '').startsWith('scrypt$')) {
        db.prepare('UPDATE staff_users SET password_hash = ?, role = ?, is_active = 1 WHERE id = ?')
          .run(defaultPassHash, s.role, existing.id);
      }
    }

    // 4. Ensure default customer accounts exist with price classes, contact details, and rep assignments
    const customerSeeds = [
      { odoo_ref: '4101', name: 'Adom Supermarket', contact: 'Ama Serwaa', phone: '0244101001', email: 'orders@adomsupermarket.gh', address: 'Spintex Road, Accra', pricelist: 'CLASS A (GHS)', rep: 'Kwame Asante', repId: 'rep-1' },
      { odoo_ref: '4102', name: 'Akwaaba Mini Mart', contact: 'Kojo Antwi', phone: '0204102002', email: 'buying@akwaabamart.gh', address: 'Oxford St, Osu, Accra', pricelist: 'CLASS A (GHS)', rep: 'Kwame Asante', repId: 'rep-1' },
      { odoo_ref: '4103', name: 'Baah & Sons Provisions', contact: 'Yaw Baah', phone: '0274103003', email: 'baahprovisions@gmail.com', address: 'Kaneshie Market, Accra', pricelist: 'CLASS B (GHS)', rep: 'Kwame Asante', repId: 'rep-1' },
      { odoo_ref: '4104', name: 'Cantonments Fresh Market', contact: 'Abena Osei', phone: '0554104004', email: 'supply@cantonmentsfresh.gh', address: 'Cantonments, Accra', pricelist: 'CLASS A (GHS)', rep: 'Kwame Asante', repId: 'rep-1' },
      { odoo_ref: '4105', name: 'Dzorwulu Grocery', contact: 'Nana Yaw', phone: '0244105005', email: 'dzorwulugrocery@gmail.com', address: 'Dzorwulu, Accra', pricelist: 'CLASS B (GHS)', rep: 'Kwame Asante', repId: 'rep-1' },
      { odoo_ref: '4106', name: 'East Legon Stores', contact: 'Esi Mansa', phone: '0504106006', email: 'orders@eastlegonstores.gh', address: 'East Legon, Accra', pricelist: 'CLASS A (GHS)', rep: 'Kwame Asante', repId: 'rep-1' },
      { odoo_ref: '4107', name: "Fiifi's Corner Shop", contact: 'Fiifi Quansah', phone: '0244107007', email: 'fiificornershop@gmail.com', address: 'Tema Community 1', pricelist: 'CLASS C (GHS)', rep: 'Efua Owusu', repId: 'rep-2' },
      { odoo_ref: '4108', name: 'Golden Gate Mart', contact: 'Kwesi Arthur', phone: '0204108008', email: 'goldengatemart@gmail.com', address: 'Madina Zongo Junction', pricelist: 'CLASS B (GHS)', rep: 'Efua Owusu', repId: 'rep-2' },
      { odoo_ref: '4109', name: 'Haatso Wholesale', contact: 'Akua Danso', phone: '0274109009', email: 'haatsowholesale@gmail.com', address: 'Haatso Supermarket St', pricelist: 'SHOPRITE (GHS)', rep: 'Efua Owusu', repId: 'rep-2' },
      { odoo_ref: '4110', name: 'Jubilee Minimarket', contact: 'Baffour Gyan', phone: '0554110010', email: 'jubileeminimarket@gmail.com', address: 'Lapaz New Market', pricelist: 'CLASS B (GHS)', rep: 'Efua Owusu', repId: 'rep-2' },
    ];

    const insertCust = db.prepare(`
      INSERT INTO customers (odoo_customer_ref, name, phone, email, delivery_address, salesperson, pricelist, customer_type, access_code, password_hash, password_set_at, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'CREDIT', ?, ?, ?, 1, datetime('now'), datetime('now'))
    `);

    const codeCust = db.prepare("SELECT id FROM customers WHERE access_code = '2N4YRNWP' OR odoo_customer_ref = '4100'").get();
    if (!codeCust) {
      insertCust.run('4100', 'Accra Supermart Ltd', '0241987650', 'accrasupermart@ghana.com', 'Ring Road Central, Accra', 'Kwame Asante', 'CLASS A (GHS)', '2N4YRNWP', null, null);
    } else {
      db.prepare(`
        UPDATE customers
           SET pricelist = COALESCE(pricelist, 'CLASS A (GHS)'),
               customer_type = COALESCE(customer_type, 'CREDIT'),
               phone = COALESCE(phone, '0241987650'),
               email = COALESCE(email, 'accrasupermart@ghana.com'),
               delivery_address = COALESCE(delivery_address, 'Ring Road Central, Accra'),
               salesperson = COALESCE(salesperson, 'Kwame Asante')
         WHERE id = ?
      `).run(codeCust.id);
    }

    const emailCust = db.prepare("SELECT id, password_hash FROM customers WHERE lower(email) = 'kofi@accramart.gh' AND (odoo_customer_ref IS NULL OR odoo_customer_ref = '')").get();
    if (!emailCust) {
      insertCust.run(null, 'Accra Supermart Ltd', '0241987654', 'kofi@accramart.gh', 'Ring Road Central, Accra', 'Kwame Asante', 'CLASS A (GHS)', 'TZSWJWD8', defaultPassHash, now.toISOString());
    } else {
      db.prepare(`
        UPDATE customers
           SET password_hash = COALESCE(password_hash, ?),
               password_set_at = COALESCE(password_set_at, datetime('now')),
               pricelist = COALESCE(pricelist, 'CLASS A (GHS)'),
               customer_type = COALESCE(customer_type, 'CREDIT'),
               delivery_address = COALESCE(delivery_address, 'Ring Road Central, Accra'),
               salesperson = COALESCE(salesperson, 'Kwame Asante')
         WHERE id = ?
      `).run(defaultPassHash, emailCust.id);
    }

    for (const c of customerSeeds) {
      const existing = db.prepare('SELECT id FROM customers WHERE odoo_customer_ref = ?').get(c.odoo_ref);
      let id;
      if (existing) {
        id = existing.id;
        db.prepare(`
          UPDATE customers
             SET password_hash = COALESCE(password_hash, ?),
                 password_set_at = COALESCE(password_set_at, datetime('now')),
                 pricelist = COALESCE(pricelist, ?),
                 customer_type = COALESCE(customer_type, 'CREDIT'),
                 phone = COALESCE(phone, ?),
                 email = COALESCE(email, ?),
                 delivery_address = COALESCE(delivery_address, ?),
                 salesperson = COALESCE(salesperson, ?)
           WHERE id = ?
        `).run(defaultPassHash, c.pricelist, c.phone, c.email, c.address, c.rep, id);
      } else {
        const res = insertCust.run(c.odoo_ref, c.name, c.phone, c.email, c.address, c.rep, c.pricelist, null, defaultPassHash, now.toISOString());
        id = Number(res.lastInsertRowid);
      }
      db.prepare(`
        INSERT INTO shop_reps (customer_id, rep_id, set_by, set_at) VALUES (?, ?, 'system', datetime('now'))
        ON CONFLICT(customer_id) DO UPDATE SET rep_id = excluded.rep_id, set_at = datetime('now')
      `).run(id, c.repId);
    }

    // 5. Ensure delivery_lots are populated for Sales Rep shop visits & shelf expiry tracking
    const lotCount = db.prepare('SELECT COUNT(*) AS c FROM delivery_lots').get()?.c || 0;
    const products = db.prepare('SELECT id, barcode, name, box_uom, odoo_category_path FROM products WHERE is_active = 1 ORDER BY id').all();
    const custRows = db.prepare('SELECT id, odoo_customer_ref, name, salesperson FROM customers WHERE is_active = 1 ORDER BY id').all();
    if (lotCount === 0 && products.length >= 6 && custRows.length >= 4) {
      const insLot = db.prepare(`
        INSERT INTO delivery_lots (customer_id, product_id, lot_code, delivered_ctn, expiry_date, delivered_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `);
      const lotSpecs = [
        { custIdx: 2, prodIdx: 0, lot: 'LOT-2026-101', ctn: 14, expDays: 18, delivDays: -45 },
        { custIdx: 2, prodIdx: 1, lot: 'LOT-2026-102', ctn: 8, expDays: 35, delivDays: -30 },
        { custIdx: 3, prodIdx: 2, lot: 'LOT-2026-103', ctn: 12, expDays: 12, delivDays: -50 },
        { custIdx: 4, prodIdx: 3, lot: 'LOT-2026-104', ctn: 20, expDays: 25, delivDays: -40 },
        { custIdx: 5, prodIdx: 4, lot: 'LOT-2026-105', ctn: 10, expDays: 42, delivDays: -25 },
        { custIdx: 6, prodIdx: 5, lot: 'LOT-2026-106', ctn: 16, expDays: 15, delivDays: -35 },
        { custIdx: 7, prodIdx: 0, lot: 'LOT-2026-107', ctn: 9, expDays: 28, delivDays: -20 },
        { custIdx: 8, prodIdx: 1, lot: 'LOT-2026-108', ctn: 11, expDays: 19, delivDays: -32 },
      ];
      for (const spec of lotSpecs) {
        const cust = custRows[spec.custIdx % custRows.length];
        const prod = products[spec.prodIdx % products.length];
        insLot.run(cust.id, prod.id, spec.lot, spec.ctn, dateOffset(spec.expDays), dateOffset(spec.delivDays));
      }
    }

    // 6. Seed 14 months of historical & active orders, invoices, payments, credit notes, and stock snapshots
    if (!historyLoaded(db) && products.length >= 10) {
      seedHistory(db, todayIso, now);
    }

    // Ensure every active credit customer (including 4100 and kofi@accramart.gh) has credit finance & at least 1 order/invoice
    for (const c of custRows) {
      db.prepare(`
        INSERT INTO odoo_customer_finance (customer_id, credit_limit, amount_owed, overdue, updated_at)
        VALUES (?, 60000, 0, 0, ?)
        ON CONFLICT(customer_id) DO UPDATE SET credit_limit = COALESCE(credit_limit, 60000)
      `).run(c.id, now.toISOString());

      const hasOrder = db.prepare('SELECT 1 FROM odoo_orders WHERE customer_id = ? LIMIT 1').get(c.id);
      if (!hasOrder && products.length >= 2) {
        const p1 = products[0];
        const p2 = products[1];
        const placedIso = `${dateOffset(-5)}T09:30:00.000Z`;
        const ref = `REQ-${todayIso.slice(0, 4)}-B${String(c.id).padStart(3, '0')}`;
        const reqId = Number(db.prepare(`
          INSERT INTO requests (reference, customer_id, status, delivery_address, submitted_at, stock_as_of, created_at, updated_at)
          VALUES (?, ?, 'ACCEPTED', 'Ring Road Central, Accra', ?, ?, ?, ?)
        `).run(ref, c.id, placedIso, placedIso, placedIso, placedIso).lastInsertRowid);
        db.prepare(`
          INSERT INTO request_items (request_id, product_id, quantity_ctn, product_name_at_request, barcode_at_request, box_uom_at_request, available_ctn_at_request, created_at)
          VALUES (?, ?, 4, ?, ?, ?, 100, ?)
        `).run(reqId, p1.id, p1.name, p1.barcode, p1.box_uom, placedIso);
        db.prepare(`
          INSERT INTO request_items (request_id, product_id, quantity_ctn, product_name_at_request, barcode_at_request, box_uom_at_request, available_ctn_at_request, created_at)
          VALUES (?, ?, 2, ?, ?, ?, 100, ?)
        `).run(reqId, p2.id, p2.name, p2.barcode, p2.box_uom, placedIso);

        const ordId = Number(db.prepare(`
          INSERT INTO odoo_orders (request_id, customer_id, odoo_number, state, amount_total, cartons_ordered, cartons_delivered, received_at, sent_at, approved_at, dispatched_at, invoiced_at, updated_at)
          VALUES (?, ?, ?, 'INVOICED', 1480, 6, 6, ?, ?, ?, ?, ?, ?)
        `).run(reqId, c.id, `S90${String(c.id).padStart(3, '0')}`, placedIso, placedIso, placedIso, placedIso, placedIso, placedIso).lastInsertRowid);

        const invNum = `INV/${todayIso.slice(0, 4)}/90${String(c.id).padStart(2, '0')}`;
        const invId = Number(db.prepare(`
          INSERT INTO odoo_invoices (number, customer_id, order_id, amount, amount_due, invoice_date, due_date, state)
          VALUES (?, ?, ?, 1480, 1480, ?, ?, 'OPEN')
        `).run(invNum, c.id, ordId, dateOffset(-4), dateOffset(26)).lastInsertRowid);
        db.prepare(`
          INSERT INTO odoo_invoice_lines (invoice_id, barcode, product_name, category, cartons, amount, discount)
          VALUES (?, ?, ?, ?, 6, 1480, 0)
        `).run(invId, p1.barcode, p1.name, p1.odoo_category_path || 'FOOD');
      }
      recomputeFinance(db, c.id, now);
    }

    // 7. Ensure sample warehouse returns exist for the Returns screen (#/returns)
    const retCount = db.prepare('SELECT COUNT(*) AS c FROM odoo_returns').get()?.c || 0;
    if (retCount === 0 && products.length >= 2 && custRows.length >= 3) {
      const c1 = custRows[2];
      const c2 = custRows[3];
      const p1 = products[0];
      const p2 = products[1];
      const r1 = Number(db.prepare(`
        INSERT INTO odoo_returns (number, customer_kind, customer_ref, customer_name, rep_name, sales_order, received_on, created_at)
        VALUES ('RET/2026/0001', 'BFL', ?, ?, 'Kwame Asante', 'S00001', ?, ?)
      `).run(String(c1.id), c1.name, dateOffset(-2), now.toISOString()).lastInsertRowid);
      db.prepare(`
        INSERT INTO odoo_return_lines (return_id, barcode, product_name, lot_name, category, cartons)
        VALUES (?, ?, ?, 'LOT-2026-101', ?, 2)
      `).run(r1, p1.barcode, p1.name, p1.odoo_category_path || 'FOOD');

      const r2 = Number(db.prepare(`
        INSERT INTO odoo_returns (number, customer_kind, customer_ref, customer_name, rep_name, sales_order, received_on, created_at)
        VALUES ('RET/2026/0002', 'BFL', ?, ?, 'Kwame Asante', 'S00002', ?, ?)
      `).run(String(c2.id), c2.name, dateOffset(-4), now.toISOString()).lastInsertRowid);
      db.prepare(`
        INSERT INTO odoo_return_lines (return_id, barcode, product_name, lot_name, category, cartons)
        VALUES (?, ?, ?, 'LOT-2026-102', ?, 3)
      `).run(r2, p2.barcode, p2.name, p2.odoo_category_path || 'FOOD');
    }

    // 8. Ensure monthly report targets exist for CEO / Sales / Rep reports
    const targetCount = db.prepare('SELECT COUNT(*) AS c FROM report_targets').get()?.c || 0;
    if (targetCount === 0) {
      setTarget(db, { scope: 'COMPANY', scopeValue: '', measure: 'net_sales', month: 'DEFAULT', value: 120000 }, 'system', now);
      setTarget(db, { scope: 'COMPANY', scopeValue: '', measure: 'collections', month: 'DEFAULT', value: 100000 }, 'system', now);
      setTarget(db, { scope: 'COMPANY', scopeValue: '', measure: 'active_customers', month: 'DEFAULT', value: 8 }, 'system', now);
      setTarget(db, { scope: 'COMPANY', scopeValue: '', measure: 'new_customers', month: 'DEFAULT', value: 2 }, 'system', now);
      setTarget(db, { scope: 'COMPANY', scopeValue: '', measure: 'avg_order_value', month: 'DEFAULT', value: 2500 }, 'system', now);
      setTarget(db, { scope: 'COMPANY', scopeValue: '', measure: 'fill_rate', month: 'DEFAULT', value: 95 }, 'system', now);
      setTarget(db, { scope: 'REP', scopeValue: 'Kwame Asante', measure: 'net_sales', month: 'DEFAULT', value: 65000 }, 'system', now);
      setTarget(db, { scope: 'REP', scopeValue: 'Kwame Asante', measure: 'collections', month: 'DEFAULT', value: 55000 }, 'system', now);
      setTarget(db, { scope: 'REP', scopeValue: 'Kwame Asante', measure: 'active_customers', month: 'DEFAULT', value: 5 }, 'system', now);
      setTarget(db, { scope: 'REP', scopeValue: 'Efua Owusu', measure: 'net_sales', month: 'DEFAULT', value: 55000 }, 'system', now);
      setTarget(db, { scope: 'REP', scopeValue: 'Efua Owusu', measure: 'collections', month: 'DEFAULT', value: 45000 }, 'system', now);
      setTarget(db, { scope: 'REP', scopeValue: 'Efua Owusu', measure: 'active_customers', month: 'DEFAULT', value: 4 }, 'system', now);
    }

    // 9. Ensure at least one active clearance discount offer exists on an expiring warehouse lot
    const discCount = db.prepare('SELECT COUNT(*) AS c FROM lot_discounts').get()?.c || 0;
    if (discCount === 0) {
      setLotDiscount(db, DiscountKind.CLEARANCE, '5283001117266|LOT-SP-2408|MAIN', 15, 'Ama Boateng (Sales Manager)', now);
      setLotDiscount(db, DiscountKind.CLEARANCE, '5283001109209|LOT-CL-2411|MAIN', 20, 'Ama Boateng (Sales Manager)', now);
    }

    // 10. Generate due/overdue payment reminders from open invoices
    runReminders(db, todayIso, now);
  } catch (err) {
    console.warn('[bootstrap] Non-fatal seed warning:', err.message);
  }
}
