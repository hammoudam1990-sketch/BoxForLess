// Database connection helper around the built-in node:sqlite module.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/**
 * Open a database connection and ensure the schema exists.
 * @param {string} [dbPath] - file path or ':memory:'. Defaults to config.dbPath.
 * @returns {DatabaseSync}
 */
export function openDatabase(dbPath = config.dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  // Order matters: a table whose SHAPE is incompatible must be rebuilt before
  // applySchema runs, because schema.sql creates indexes on the new columns and
  // would fail against the old table. Additive ALTERs come after, once the
  // tables they target exist.
  rebuildIncompatibleTables(db);
  applySchema(db);
  applyMigrations(db);
  return db;
}

/** Apply the schema file (idempotent — all statements use IF NOT EXISTS). */
export function applySchema(db) {
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(sql);
}

/** Column names of a table. */
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

/**
 * Additive, idempotent upgrades for databases created before a schema change.
 * `schema.sql` only uses CREATE ... IF NOT EXISTS, so it cannot alter a table
 * that already exists — that is this function's job.
 *
 * Every step here is ADDITIVE. Nothing drops or rewrites a table that holds
 * rows: the one rebuild below refuses to run unless the table is empty.
 */
/**
 * Rebuild tables whose SHAPE changed incompatibly. Runs BEFORE applySchema.
 *
 * `categories` originally declared `name` UNIQUE, which real Odoo data violates
 * (a child may repeat its parent's name, e.g. ".../ JUICES & NECTARS / JUICES &
 * NECTARS"). SQLite cannot drop a column constraint in place, so the table is
 * rebuilt — but ONLY while it is empty, which it is in every database built
 * before this change. A populated table is left untouched and the mismatch is
 * raised rather than papered over.
 */
export function rebuildIncompatibleTables(db) {
  const catCols = columnsOf(db, 'categories');
  if (catCols.length && !catCols.includes('path')) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
    if (n > 0) {
      throw new Error(
        'Cannot upgrade `categories`: the table already holds rows and its old '
        + 'UNIQUE(name) constraint is incompatible with Odoo category paths. '
        + 'Migrate those rows manually before continuing.'
      );
    }
    db.exec('DROP TABLE categories');
  }
}

/** Additive, idempotent column/index upgrades. Runs AFTER applySchema. */
export function applyMigrations(db) {
  // --- products.odoo_category_path (Stage 2.1: Odoo category import) ---------
  if (!columnsOf(db, 'products').includes('odoo_category_path')) {
    db.exec('ALTER TABLE products ADD COLUMN odoo_category_path TEXT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_products_category ON products(category_id)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_products_odoo_category_path ON products(odoo_category_path)');

  // --- Stage 3: customer requests (CTN only) --------------------------------
  // Purely additive: new nullable columns on the previously unused skeleton
  // tables. NOTHING is added to `products`, so the Product Master and the
  // customer catalog cannot regress from this migration.
  addColumns(db, 'customers', {
    odoo_customer_ref: 'TEXT',   // Odoo res.partner id when we have one; NOT required
    phone: 'TEXT',               // staff reference only, never customer-facing
    country: 'TEXT',
    // Customer-list import (2026-10-03). Both are STAFF-ONLY and must never reach
    // a customer-facing payload — `pricelist` is a price-tier name, and pricing is
    // excluded from everything the customer sees.
    email: 'TEXT',
    pricelist: 'TEXT',
    // Per-customer access code (2026-10-05). Plain text ON PURPOSE: staff must be
    // able to read a code back to send it to the customer, which a one-way hash
    // would make impossible. See the threat model in domain/access-codes.js.
    access_code: 'TEXT',
    access_code_issued_at: 'TEXT',
    // Where this customer's orders go (2026-10-05). Captured when a new company
    // asks for access, and pre-filled on their requests. Nullable because the
    // customers imported from Odoo have no address — they are asked on their
    // first request instead, never blocked.
    delivery_address: 'TEXT',
  });
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_odoo_ref
             ON customers(odoo_customer_ref) WHERE odoo_customer_ref IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_customers_name ON customers(name)');
  // Unique so two customers can never share a code — a collision would let one
  // company submit requests as another.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_customers_access_code
             ON customers(access_code) WHERE access_code IS NOT NULL`);

  addColumns(db, 'requests', {
    reference: 'TEXT',
    unlisted_company: 'TEXT',
    unlisted_contact: 'TEXT',
    unlisted_phone: 'TEXT',
    needs_customer_match: 'INTEGER NOT NULL DEFAULT 0',
    // optional, New Customer path only — existing requests keep NULL
    delivery_address: 'TEXT',
    notes: 'TEXT',
    submitted_at: 'TEXT',
    stock_as_of: 'TEXT',
  });
  // UNIQUE on an added column needs its own index (ALTER cannot add the constraint).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_requests_reference
             ON requests(reference) WHERE reference IS NOT NULL`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_requests_customer ON requests(customer_id)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_requests_status   ON requests(status)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_requests_match    ON requests(needs_customer_match)');

  addColumns(db, 'request_items', {
    quantity_ctn: 'INTEGER',
    product_name_at_request: 'TEXT',
    barcode_at_request: 'TEXT',
    box_uom_at_request: 'TEXT',
    available_ctn_at_request: 'INTEGER',
  });
  db.exec('CREATE INDEX IF NOT EXISTS ix_request_items_request ON request_items(request_id)');

  // --- Access codes: "I don't have a code" requests --------------------------
  // Created HERE rather than in schema.sql for the same reason as the Stage 3
  // indexes: schema.sql runs before these migrations on an existing database.
  // Nothing references products, so the Product Master cannot regress.
  db.exec(`
    CREATE TABLE IF NOT EXISTS access_requests (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      company          TEXT,
      contact          TEXT NOT NULL,
      phone            TEXT NOT NULL,
      email            TEXT,
      delivery_address TEXT,
      note             TEXT,
      status           TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | APPROVED | REJECTED
      customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      created_at       TEXT NOT NULL,
      reviewed_at      TEXT,
      updated_at       TEXT
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_access_requests_status ON access_requests(status)');
}

/** Add any of `columns` that the table does not already have. Idempotent. */
function addColumns(db, table, columns) {
  const existing = new Set(columnsOf(db, table));
  for (const [name, decl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

export default openDatabase;
