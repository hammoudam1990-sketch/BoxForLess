// Tests for Group B Readiness Data Quality Audits (ODOO_CONNECTION_PLAN.md Section 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { runDataQualityAudit } from '../src/domain/data-quality.js';
import { createApp } from '../src/server/index.js';

test('1. B1 detects duplicate customers by name, phone and email', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  // Insert two customers with the same normalized name
  db.prepare("INSERT INTO customers (name, phone, email, is_active, created_at, updated_at) VALUES ('Kofi Stores', '0244111222', 'kofi@example.com', 1, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO customers (name, phone, email, is_active, created_at, updated_at) VALUES ('  kofi stores  ', '0244999888', 'other@example.com', 1, ?, ?)").run(ts, ts);

  const report = runDataQualityAudit(db);
  assert.equal(report.summary.B1.count >= 1, true);
  const nameDup = report.details.B1_duplicate_customers.find((c) => c.type === 'NAME');
  assert.ok(nameDup, 'found name duplicate');
  assert.equal(nameDup.key, 'kofi stores');
  assert.equal(nameDup.count, 2);
});

test('2. B2 detects active customers without an assigned salesperson', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  db.prepare("INSERT INTO customers (name, salesperson, is_active, created_at, updated_at) VALUES ('Ama Ltd', '', 1, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO customers (name, salesperson, is_active, created_at, updated_at) VALUES ('Kojo Enterprises', NULL, 1, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO customers (name, salesperson, is_active, created_at, updated_at) VALUES ('Kwame Ventures', 'Kwame Asante', 1, ?, ?)").run(ts, ts);

  const report = runDataQualityAudit(db);
  assert.equal(report.summary.B2.count, 2);
  const names = report.details.B2_customers_without_salesperson.map((c) => c.name);
  assert.deepEqual(names.sort(), ['Ama Ltd', 'Kojo Enterprises']);
});

test('3. B3 detects customers without an assigned price class', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  db.prepare("INSERT INTO customers (name, pricelist, is_active, created_at, updated_at) VALUES ('No Price Ltd', '', 1, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO customers (name, pricelist, is_active, created_at, updated_at) VALUES ('Class A Shop', 'CLASS A (GHS)', 1, ?, ?)").run(ts, ts);

  const report = runDataQualityAudit(db);
  assert.equal(report.summary.B3.count, 1);
  assert.equal(report.details.B3_customers_without_price_class[0].name, 'No Price Ltd');
});

test('4. B4 detects credit customers without a credit limit', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  const c1 = db.prepare("INSERT INTO customers (name, customer_type, is_active, created_at, updated_at) VALUES ('Credit Co 1', 'CREDIT', 1, ?, ?)").run(ts, ts).lastInsertRowid;
  const c2 = db.prepare("INSERT INTO customers (name, customer_type, is_active, created_at, updated_at) VALUES ('Credit Co 2', 'CREDIT', 1, ?, ?)").run(ts, ts).lastInsertRowid;
  const c3 = db.prepare("INSERT INTO customers (name, customer_type, is_active, created_at, updated_at) VALUES ('Cash Buyer', 'CASH', 1, ?, ?)").run(ts, ts).lastInsertRowid;

  // c1 has finance entry with 0 limit
  db.prepare("INSERT INTO odoo_customer_finance (customer_id, credit_limit, amount_owed, overdue, updated_at) VALUES (?, 0, 0, 0, ?)").run(c1, ts);
  // c2 has no finance entry at all (limit is null/0)
  // c3 is CASH, so it should NOT be flagged under B4

  const report = runDataQualityAudit(db);
  const flagged = report.details.B4_customers_without_credit_limit.map((c) => c.id);
  assert.equal(flagged.includes(Number(c1)), true);
  assert.equal(flagged.includes(Number(c2)), true);
  assert.equal(flagged.includes(Number(c3)), false);
});

test('5. B5 detects customers without both phone and email', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  db.prepare("INSERT INTO customers (name, phone, email, is_active, created_at, updated_at) VALUES ('No Contact Co', '', '', 1, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO customers (name, phone, email, is_active, created_at, updated_at) VALUES ('Phone Only', '0244111222', NULL, 1, ?, ?)").run(ts, ts);

  const report = runDataQualityAudit(db);
  assert.equal(report.summary.B5.count, 1);
  assert.equal(report.details.B5_customers_without_contact[0].name, 'No Contact Co');
});

test('6. B6 detects products without a barcode or category', () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  const catId = db.prepare("INSERT INTO categories (name, path, level, is_active, created_at, updated_at) VALUES ('FOOD', 'FOOD', 1, 1, ?, ?)").run(ts, ts).lastInsertRowid;

  db.prepare("INSERT INTO products (name, barcode, odoo_category_path, category_id, is_active, created_at, updated_at) VALUES ('No Barcode', '', 'FOOD', ?, 1, ?, ?)").run(catId, ts, ts);
  db.prepare("INSERT INTO products (name, barcode, odoo_category_path, category_id, is_active, created_at, updated_at) VALUES ('No Category', '528301', '', NULL, 1, ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO products (name, barcode, odoo_category_path, category_id, is_active, created_at, updated_at) VALUES ('Valid Product', '528302', 'FOOD', ?, 1, ?, ?)").run(catId, ts, ts);

  const report = runDataQualityAudit(db);
  assert.equal(report.summary.B6.count, 2);
  const names = report.details.B6_products_without_barcode_or_category.map((p) => p.name);
  assert.deepEqual(names.sort(), ['No Barcode', 'No Category']);
});

test('7. B7 detects products without an identifiable brand', () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  const catId = db.prepare("INSERT INTO categories (name, path, level, is_active, created_at, updated_at) VALUES ('FOOD', 'FOOD', 1, 1, ?, ?)").run(ts, ts).lastInsertRowid;

  db.prepare("INSERT INTO products (name, barcode, odoo_category_path, category_id, is_active, created_at, updated_at) VALUES ('ABIDO ALL SPICE', '111', 'FOOD', ?, 1, ?, ?)").run(catId, ts, ts);
  db.prepare("INSERT INTO products (name, barcode, odoo_category_path, category_id, is_active, created_at, updated_at) VALUES ('ITEM 24 PIECES', '222', 'FOOD', ?, 1, ?, ?)").run(catId, ts, ts);

  const report = runDataQualityAudit(db);
  const unbranded = report.details.B7_products_without_brand.map((p) => p.name);
  assert.equal(unbranded.includes('ITEM 24 PIECES'), true);
  assert.equal(unbranded.includes('ABIDO ALL SPICE'), false);
});

test('8. B8 detects perishable lots without an expiry date', () => {
  const db = freshDb();
  const ts = new Date().toISOString();

  const cid = db.prepare("INSERT INTO customers (name, is_active, created_at, updated_at) VALUES ('Cust 1', 1, ?, ?)").run(ts, ts).lastInsertRowid;
  const pid = db.prepare("INSERT INTO products (name, barcode, is_active, created_at, updated_at) VALUES ('Prod 1', '999', 1, ?, ?)").run(ts, ts).lastInsertRowid;

  db.prepare("INSERT INTO delivery_lots (customer_id, product_id, lot_code, delivered_ctn, expiry_date, created_at) VALUES (?, ?, 'LOT-A', 5, '', ?)").run(cid, pid, ts);
  db.prepare("INSERT INTO delivery_lots (customer_id, product_id, lot_code, delivered_ctn, expiry_date, created_at) VALUES (?, ?, 'LOT-B', 10, '2026-12-31', ?)").run(cid, pid, ts);

  const report = runDataQualityAudit(db);
  assert.equal(report.summary.B8.count, 1);
  assert.equal(report.details.B8_lots_without_expiry[0].lotCode, 'LOT-A');
});

test('9. overall readiness status reflects discrepancies', () => {
  const db = freshDb();
  const reportClean = runDataQualityAudit(db);
  assert.equal(reportClean.totalIssues, 0);
  assert.equal(reportClean.status, 'READY_FOR_SYNC');
});
