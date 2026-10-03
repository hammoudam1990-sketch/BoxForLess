// Schema UPGRADE path.
//
// Every other test opens a fresh database built from the CURRENT schema, so none of
// them traverses the upgrade path at all — a migration can be completely broken
// while the whole suite is green. That is not hypothetical: adding an index to
// schema.sql for a column that applyMigrations had not yet added broke the real
// database twice, and no test noticed either time.
//
// These tests build a database at an OLD shape, then open it through the real
// upgrade path and assert both the new shape and the preserved data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import openDatabase from '../src/db/connection.js';

const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-mig-')), 'old.db');
const columnsOf = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

/**
 * A database at the PRE-STAGE-3 shape: products already carry the Stage 2.1
 * category columns, while customers/requests/request_items are still the original
 * untouched forward-compatibility skeleton.
 */
function buildPreStage3Db(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
      level INTEGER NOT NULL DEFAULT 1, parent_id INTEGER REFERENCES categories(id),
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE product_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0, filename TEXT, url_reference TEXT,
      uploaded_at TEXT, is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_odoo_id TEXT, barcode TEXT NOT NULL,
      name TEXT NOT NULL, box_uom TEXT,
      on_hand REAL NOT NULL DEFAULT 0, free_to_use REAL NOT NULL DEFAULT 0,
      incoming REAL NOT NULL DEFAULT 0, outgoing REAL NOT NULL DEFAULT 0,
      forecasted REAL NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1,
      odoo_category_path TEXT, primary_image_id INTEGER, category_id INTEGER,
      barcode_change_pending INTEGER NOT NULL DEFAULT 0, uom_change_pending INTEGER NOT NULL DEFAULT 0,
      pending_barcode TEXT, pending_uom TEXT,
      data_quality_status TEXT NOT NULL DEFAULT 'OK', data_quality_notes TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      last_import_id INTEGER, last_seen_import_id INTEGER);
    CREATE TABLE import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, file_hash TEXT, stored_path TEXT,
      imported_at TEXT NOT NULL, confirmed_at TEXT, completed_at TEXT,
      total_rows INTEGER NOT NULL DEFAULT 0, valid_rows INTEGER NOT NULL DEFAULT 0,
      invalid_rows INTEGER NOT NULL DEFAULT 0, created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0, unchanged_count INTEGER NOT NULL DEFAULT 0,
      inactive_count INTEGER NOT NULL DEFAULT 0, reactivated_count INTEGER NOT NULL DEFAULT 0,
      barcode_change_count INTEGER NOT NULL DEFAULT 0, uom_change_count INTEGER NOT NULL DEFAULT 0,
      warning_count INTEGER NOT NULL DEFAULT 0, error_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PREVIEW', preview_json TEXT, notes TEXT);
    CREATE TABLE import_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, import_batch_id INTEGER NOT NULL, product_id INTEGER,
      change_type TEXT NOT NULL, field TEXT, old_value TEXT, new_value TEXT, row_number INTEGER,
      barcode TEXT, review_status TEXT NOT NULL DEFAULT 'NA', message TEXT, created_at TEXT NOT NULL);
    CREATE TABLE sales_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE, role TEXT,
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
    CREATE TABLE quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER, odoo_reference TEXT, status TEXT,
      created_at TEXT, updated_at TEXT);

    -- the ORIGINAL skeleton shapes, before Stage 3
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, reference TEXT,
      is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT);
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER, sales_user_id INTEGER,
      status TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE request_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, request_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
      quantity REAL, created_at TEXT);
  `);
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (barcode, name, box_uom, free_to_use, odoo_category_path, primary_image_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run('5283013330912', 'PLEIN SOLEIL CHICKEN STOCK', 'CTN24', 13, 'FOOD / SPICES & SEASONINGS / STOCK & BOUILLON', 8, now, now);
  db.prepare(
    'INSERT INTO product_images (id, product_id, is_primary, filename, is_active) VALUES (8,1,1,?,1)'
  ).run('1739-photo.jpg');
  db.close();
}

test('a pre-Stage-3 database upgrades without losing data', () => {
  const file = tmpDb();
  buildPreStage3Db(file);

  const db = openDatabase(file); // the REAL upgrade path

  // new columns present
  for (const c of ['odoo_customer_ref', 'phone', 'country']) {
    assert.ok(columnsOf(db, 'customers').includes(c), `customers.${c} added`);
  }
  for (const c of ['reference', 'unlisted_company', 'unlisted_contact', 'unlisted_phone',
    'needs_customer_match', 'notes', 'submitted_at', 'stock_as_of']) {
    assert.ok(columnsOf(db, 'requests').includes(c), `requests.${c} added`);
  }
  for (const c of ['quantity_ctn', 'product_name_at_request', 'barcode_at_request',
    'box_uom_at_request', 'available_ctn_at_request']) {
    assert.ok(columnsOf(db, 'request_items').includes(c), `request_items.${c} added`);
  }

  // existing data survived, untouched
  const p = db.prepare('SELECT * FROM products WHERE barcode = ?').get('5283013330912');
  assert.equal(p.name, 'PLEIN SOLEIL CHICKEN STOCK');
  assert.equal(p.free_to_use, 13);
  assert.equal(p.odoo_category_path, 'FOOD / SPICES & SEASONINGS / STOCK & BOUILLON');
  assert.equal(p.primary_image_id, 8, 'image association preserved');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_images').get().n, 1, 'image row preserved');
  db.close();
});

test('the upgrade is idempotent — opening twice is safe', () => {
  const file = tmpDb();
  buildPreStage3Db(file);
  const a = openDatabase(file);
  const firstShape = columnsOf(a, 'customers').length;
  a.close();
  const b = openDatabase(file);
  assert.equal(columnsOf(b, 'customers').length, firstShape, 'no duplicate columns on re-open');
  assert.equal(b.prepare('SELECT COUNT(*) n FROM products').get().n, 1, 'data still intact');
  b.close();
});

test('the upgrade adds NOTHING to products — the Product Master cannot regress', () => {
  const file = tmpDb();
  buildPreStage3Db(file);
  const before = (() => { const d = new DatabaseSync(file); const c = columnsOf(d, 'products'); d.close(); return c; })();
  const db = openDatabase(file);
  assert.deepEqual(columnsOf(db, 'products'), before, 'products table untouched by the Stage 3 migration');
  db.close();
});
