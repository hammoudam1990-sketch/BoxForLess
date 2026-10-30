// Database connection helper around the built-in node:sqlite module.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { hashPassword } from '../domain/passwords.js';

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
  if (dbPath !== ':memory:' && process.env.NODE_ENV !== 'test') {
    ensureInitialStaffUsers(db);
  }
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
  addColumns(db, 'import_batches', {
    source_file_deleted_at: 'TEXT',
  });
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
    // Bumped whenever this customer's sessions must stop working — after they
    // submit an order, and on "Not you?". A session token carries the epoch it
    // was issued under, so an old token is refused even if a browser keeps
    // sending it. Without this, ending a session would depend on the browser
    // honouring a cleared cookie.
    session_epoch: 'INTEGER NOT NULL DEFAULT 0',
    // Minimum shelf life in days (Warehouse: Expiry W3). In the real system this is an Odoo field
    // read by BFL; until then staff set it. NULL = the customer accepts any lot not expired.
    min_shelf_life_days: 'INTEGER',
    // Registration and approval (Sales Management slice 5). CREDIT = a company with an Odoo
    // account; CASH = a buyer on the shared cash account (nothing is created in Odoo for them).
    // `pricelist` (above) is the Odoo price class. `salesperson` is the rep's name as Odoo has it.
    customer_type: 'TEXT',
    salesperson: 'TEXT',
    registration_ref: 'TEXT',
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
    // When a request was withdrawn (2026-10-06). Deleting is a SOFT delete: the
    // row and its item snapshots are kept, so a deleted request can still be read
    // and restored. See deleteRequest().
    deleted_at: 'TEXT',
    // Set when a sales rep placed the request for one of their customers (the rep's name as Odoo has it,
    // and their staff account). The customer is still the request's customer_id.
    placed_by_rep: 'TEXT',
    placed_by_staff_id: 'INTEGER',
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
  addColumns(db, 'access_requests', {
    reference: 'TEXT',        // BFL registration reference, e.g. REG-2026-0007; goes to Odoo in `ref`
    customer_type: 'TEXT',     // what the Sales Manager decided: CREDIT | CASH
  });
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_access_requests_reference ON access_requests(reference) WHERE reference IS NOT NULL');

  // Orders and the customer's account (Sales Management slice 6). These are BFL's READ COPY of what
  // Odoo says: the quotation's number and stage, the invoices, the balance. BFL never decides any of
  // it. Until the Odoo sync exists, domain/sample-odoo.js plays Odoo's part and writes them.
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id    INTEGER NOT NULL UNIQUE REFERENCES requests(id) ON DELETE RESTRICT,
      customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      odoo_number   TEXT,                 -- the sale.order name, e.g. S00012, once Odoo has it
      state         TEXT NOT NULL DEFAULT 'RECEIVED',
      amount_total  REAL,                 -- set when Odoo invoices it
      received_at   TEXT NOT NULL,
      sent_at       TEXT,
      approved_at   TEXT,
      dispatched_at TEXT,
      invoiced_at   TEXT,
      paid_at       TEXT,
      cancelled_at  TEXT,
      updated_at    TEXT NOT NULL
    )`);
  // the value an order carries while it is open (not yet invoiced): Odoo's quotation total once the
  // sync reads it, the price list's figure until then. Used only by the credit check.
  addColumns(db, 'odoo_orders', { amount_open: 'REAL' });
  db.exec('CREATE INDEX IF NOT EXISTS ix_odoo_orders_customer ON odoo_orders(customer_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_invoices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      number       TEXT NOT NULL UNIQUE,
      customer_id  INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      order_id     INTEGER REFERENCES odoo_orders(id) ON DELETE SET NULL,
      amount       REAL NOT NULL,
      amount_due   REAL NOT NULL,
      invoice_date TEXT NOT NULL,
      due_date     TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'OPEN'     -- OPEN | PAID
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_odoo_invoices_customer ON odoo_invoices(customer_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_payments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      invoice_id  INTEGER REFERENCES odoo_invoices(id) ON DELETE SET NULL,
      amount      REAL NOT NULL,
      paid_on     TEXT NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_customer_finance (
      customer_id  INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      credit_limit REAL,
      amount_owed  REAL NOT NULL DEFAULT 0,
      overdue      REAL NOT NULL DEFAULT 0,
      updated_at   TEXT NOT NULL
    )`);

  // An imported Odoo customer is a credit account; only a registered cash buyer is CASH.
  db.exec("UPDATE customers SET customer_type = 'CREDIT' WHERE customer_type IS NULL");

  // Returns and credit notes (S04), and what the monthly reports (S06) read. BFL's READ COPY of Odoo's return
  // deliveries, credit notes and invoice lines — plus BFL's own records: the reason for each return, the
  // log of orders that could not be placed, monthly targets and the report owner's notes. Until the Odoo
  // sync exists, domain/sample-odoo.js fills the Odoo-side tables.
  addColumns(db, 'odoo_orders', { cartons_ordered: 'INTEGER', cartons_delivered: 'INTEGER' });
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_invoice_lines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id   INTEGER NOT NULL REFERENCES odoo_invoices(id) ON DELETE CASCADE,
      barcode      TEXT NOT NULL,
      product_name TEXT,
      category     TEXT,                          -- the product's Odoo category path
      cartons      INTEGER NOT NULL,
      amount       REAL NOT NULL,                 -- before tax, after any line discount
      discount     REAL NOT NULL DEFAULT 0        -- GHS given on this line (clearance discount)
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_invoice_lines_invoice ON odoo_invoice_lines(invoice_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_returns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,         -- e.g. RET/2026/0001
      customer_kind TEXT NOT NULL,                -- BFL (a row in customers) | SHELF (a sample shelf customer)
      customer_ref  TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      rep_name      TEXT,                         -- the customer's salesperson when it came back
      sales_order   TEXT,
      received_on   TEXT NOT NULL,
      created_at    TEXT NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_return_lines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      return_id    INTEGER NOT NULL REFERENCES odoo_returns(id) ON DELETE CASCADE,
      barcode      TEXT NOT NULL,
      product_name TEXT,
      lot_name     TEXT,
      category     TEXT,
      cartons      INTEGER NOT NULL                -- goes to quarantine, never back into sellable stock
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS return_classifications (
      return_id     INTEGER PRIMARY KEY REFERENCES odoo_returns(id) ON DELETE CASCADE,
      reason        TEXT NOT NULL,                -- DAMAGED | EXPIRED | OTHER
      note          TEXT,
      classified_by TEXT,
      classified_at TEXT NOT NULL
    )`);
  // Customer-submitted return requests are a separate local workflow from
  // Odoo's read-copy returns and warehouse classifications. Decisions never
  // change stock, invoices, or Odoo records.
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_return_requests (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      reference          TEXT NOT NULL UNIQUE,
      customer_id        INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      request_item_id    INTEGER NOT NULL REFERENCES request_items(id) ON DELETE RESTRICT,
      order_reference    TEXT NOT NULL,
      barcode            TEXT NOT NULL,
      product_name       TEXT NOT NULL,
      cartons            INTEGER NOT NULL CHECK (cartons > 0),
      reason             TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','DECLINED')),
      decline_reason     TEXT,
      created_at         TEXT NOT NULL,
      reviewed_at        TEXT,
      reviewed_by        TEXT
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_customer_returns_customer ON customer_return_requests(customer_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS ix_customer_returns_status ON customer_return_requests(status, created_at)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_credit_notes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,
      customer_kind TEXT NOT NULL,
      customer_ref  TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      rep_name      TEXT,
      invoice_number TEXT,
      return_id     INTEGER REFERENCES odoo_returns(id) ON DELETE SET NULL,
      kind          TEXT NOT NULL,                -- RETURN | DISCOUNT (expiry discount agreed on a shop visit) | OTHER
      amount        REAL NOT NULL,                -- before tax
      issued_on     TEXT NOT NULL
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_credit_notes_issued ON odoo_credit_notes(issued_on)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_check_log (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id      INTEGER,
      kind             TEXT NOT NULL,             -- LOW_STOCK | CREDIT
      barcode          TEXT,
      product_name     TEXT,
      cartons_wanted   INTEGER,
      cartons_short    INTEGER,                   -- how many it fell short by (LOW_STOCK)
      order_value      REAL,                      -- (CREDIT)
      available_credit REAL,
      at               TEXT NOT NULL
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_order_check_log_at ON order_check_log(at, kind)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS stock_snapshots (
      snap_on  TEXT NOT NULL,
      category TEXT NOT NULL,                     -- top-level category
      on_hand  REAL NOT NULL,
      free     REAL NOT NULL,
      PRIMARY KEY (snap_on, category)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_targets (
      scope      TEXT NOT NULL,                   -- COMPANY | REP
      scope_value TEXT NOT NULL DEFAULT '',       -- the rep's name for REP
      measure    TEXT NOT NULL,
      month      TEXT NOT NULL,                   -- YYYY-MM, or DEFAULT for every month
      value      REAL NOT NULL,
      set_by     TEXT,
      set_at     TEXT NOT NULL,
      PRIMARY KEY (scope, scope_value, measure, month)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_notes (
      report     TEXT NOT NULL,                   -- CEO | SALES | WAREHOUSE
      month      TEXT NOT NULL,
      what       TEXT,
      why        TEXT,
      action     TEXT,
      written_by TEXT,
      written_at TEXT,
      PRIMARY KEY (report, month)
    )`);

  // Discounts the Sales Manager puts on lots close to expiry. CLEARANCE: a lot in our warehouse, offered to
  // customers. SHELF: a lot on a customer's shelf, offered by the rep on a visit. Switched off, never deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS lot_discounts (
      kind      TEXT NOT NULL,                 -- CLEARANCE | SHELF
      lot_key   TEXT NOT NULL,                 -- "<barcode>|<lot name>"
      pct       REAL NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      set_by    TEXT,
      set_at    TEXT NOT NULL,
      ended_by  TEXT,
      ended_at  TEXT,
      PRIMARY KEY (kind, lot_key)
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS lot_discount_log (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      kind     TEXT NOT NULL,
      lot_key  TEXT NOT NULL,
      action   TEXT NOT NULL,                  -- SET | CHANGE | REMOVE
      pct      REAL,
      by_name  TEXT,
      at       TEXT NOT NULL
    )`);
  // the cartons of a request line that are clearance (the line names the lot and carries the discount)
  addColumns(db, 'request_items', {
    clearance_lot_key: 'TEXT',
    clearance_lot_name: 'TEXT',
    clearance_expiry: 'TEXT',
    clearance_cartons: 'INTEGER',
    clearance_pct: 'REAL',
  });

  // an invoice line for clearance cartons names its lot and carries the discount given (GHS), as Odoo's invoice line would
  addColumns(db, 'odoo_invoice_lines', { lot_name: 'TEXT' });

  // what the Sales Manager had offered on a shelf lot when the rep visited (a discount within it is approved at once),
  // plus the return reason & note when a rep records a return expected
  addColumns(db, 'shelf_visit_lines', {
    offered_pct: 'REAL',
    return_reason: 'TEXT',
    return_note: 'TEXT',
  });
  addColumns(db, 'rep_visit_lines', {
    return_reason: 'TEXT',
    return_note: 'TEXT',
  });

  // optional per-product purchasing limitation (max cartons per order), kept in its own table so products schema stays untouched
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_order_limits (
      barcode       TEXT PRIMARY KEY,
      max_order_ctn INTEGER NOT NULL,
      updated_at    TEXT NOT NULL
    )`);

  // Which rep owns a sample shop (the Sales Manager can change the sample list). '' = nobody.
  db.exec(`
    CREATE TABLE IF NOT EXISTS shop_reps (
      customer_id INTEGER PRIMARY KEY,
      rep_id      TEXT NOT NULL,
      set_by      TEXT,
      set_at      TEXT NOT NULL
    )`);

  // Product visibility rules (Sales Management slice 10). Rules only HIDE; removing one switches it off
  // and is logged. Nothing is ever deleted.
  db.exec(`
    CREATE TABLE IF NOT EXISTS visibility_rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_type   TEXT NOT NULL,                 -- ALL | PRICE_CLASS | CUSTOMER
      scope_value  TEXT,                          -- price class name, or the customer's id
      target_type  TEXT NOT NULL,                 -- CATEGORY | PRODUCT | BRAND
      target_value TEXT NOT NULL,                 -- category path, barcode, or brand
      is_active    INTEGER NOT NULL DEFAULT 1,
      created_by   TEXT,
      created_at   TEXT NOT NULL,
      removed_by   TEXT,
      removed_at   TEXT
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_visibility_rules_active ON visibility_rules(is_active, scope_type, scope_value)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS visibility_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      action  TEXT NOT NULL,                      -- ADDED | REMOVED
      by      TEXT,
      at      TEXT NOT NULL,
      detail  TEXT
    )`);

  // Payment reminders (Sales Management slice 9). A schedule per credit customer, and a log of every
  // reminder composed. Nothing here collects money or touches Odoo.
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_schedules (
      customer_id  INTEGER PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
      kind         TEXT NOT NULL DEFAULT 'DUE_DATE',   -- DUE_DATE | WEEKLY | MONTHLY
      weekday      INTEGER,                            -- 0 = Sunday … 6 = Saturday (weekly)
      day_of_month INTEGER,                            -- 1..31 (monthly)
      updated_by   TEXT,
      updated_at   TEXT NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_reminders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
      remind_on     TEXT NOT NULL,                     -- the day this reminder was for
      kind          TEXT NOT NULL,                     -- BEFORE | DUE | OVERDUE
      to_address    TEXT,                              -- email, else phone; null = no contact on file
      subject       TEXT NOT NULL,
      body          TEXT NOT NULL,
      invoice_count INTEGER NOT NULL,
      total_due     REAL NOT NULL,
      status        TEXT NOT NULL,                     -- PENDING | SENT | NO_CONTACT
      created_at    TEXT NOT NULL,
      sent_at       TEXT,
      sent_by       TEXT,
      UNIQUE (customer_id, remind_on)
    )`);

  // Sign-in (Sales Management slice 7). Customers sign in with their Odoo customer ID and a password;
  // staff with an email or phone number and a password. Only a scrypt hash is ever stored.
  addColumns(db, 'customers', {
    password_hash: 'TEXT',
    password_set_at: 'TEXT',
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_users (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT NOT NULL,
      email                TEXT,                      -- lower-cased
      phone                TEXT,                      -- as typed
      phone_key            TEXT,                      -- last nine digits, for matching
      role                 TEXT NOT NULL,             -- SALES_MANAGER | SALES_REP | WAREHOUSE
      rep_id               TEXT,                      -- which sales rep this person is (reps only)
      password_hash        TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 1,
      is_active            INTEGER NOT NULL DEFAULT 1,
      created_by           TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      last_login_at        TEXT
    )`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_users_email ON staff_users(email) WHERE email IS NOT NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_staff_users_phone ON staff_users(phone_key) WHERE phone_key IS NOT NULL');

  // The outbox: every write to Odoo is queued here first (see domain/outbox.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL,                -- CREATE_PARTNER | DRAFT_QUOTATION
      dedupe_key TEXT NOT NULL UNIQUE,         -- the same write is never queued twice
      payload    TEXT NOT NULL,                -- JSON
      status     TEXT NOT NULL DEFAULT 'PENDING',  -- PENDING | SENT | FAILED
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at    TEXT
    )`);

  // The Odoo connection (see src/odoo/): how the outbox worker and the scheduled sync jobs are doing.
  addColumns(db, 'odoo_outbox', {
    next_attempt_at: 'TEXT',      // when the worker may try again (1, 5, 15, 60 minutes, then hourly)
    first_attempt_at: 'TEXT',     // the first try that failed: after 24 hours of failures the entry is FAILED
    odoo_id: 'INTEGER',           // the id Odoo gave the quotation / customer
    odoo_number: 'TEXT',          // the quotation's number, e.g. S00456
  });
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      data_type       TEXT PRIMARY KEY,                -- customers | stock | ...
      cursor          TEXT,                            -- the newest write_date copied so far
      last_success_at TEXT,
      last_attempt_at TEXT,
      last_error      TEXT,
      records_last    INTEGER NOT NULL DEFAULT 0,
      runs_ok         INTEGER NOT NULL DEFAULT 0,
      runs_failed     INTEGER NOT NULL DEFAULT 0
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_changes (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at    TEXT NOT NULL,
      data_type TEXT NOT NULL,
      odoo_id   TEXT,
      change    TEXT NOT NULL,                         -- LINKED_BY_NAME | CREATED | DEACTIVATED | DIFFERS | UNKNOWN_BARCODE ...
      detail    TEXT
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_sync_changes_run ON sync_changes(run_at)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS odoo_call_log (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      at     TEXT NOT NULL,
      model  TEXT NOT NULL,
      method TEXT NOT NULL,
      count  INTEGER,
      ms     INTEGER,
      ok     INTEGER NOT NULL,
      error  TEXT                                      -- never the API key
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_odoo_call_log_at ON odoo_call_log(at)');

  // Site settings & Storefront/Rep Builder configuration
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT
    )`);

  // Products filed by name because the Odoo export had no category (domain/category-guess.js): every move is logged.
  db.exec(`
    CREATE TABLE IF NOT EXISTS category_guess_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
      barcode    TEXT,
      old_path   TEXT,
      new_path   TEXT NOT NULL,
      reason     TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);

  // The payment due date the Sales Manager sets for an order after the purchase (domain/payment-due.js). BFL's own
  // record: it drives reminders and what the customer is told to pay by; it is never written to Odoo. One current date
  // per order, and every change kept with who, when and why.
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_payment_due (
      order_id   INTEGER PRIMARY KEY REFERENCES odoo_orders(id) ON DELETE RESTRICT,
      due_date   TEXT NOT NULL,
      set_by     TEXT,
      set_at     TEXT NOT NULL
    )`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS order_payment_due_changes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   INTEGER NOT NULL REFERENCES odoo_orders(id) ON DELETE RESTRICT,
      old_date   TEXT,
      new_date   TEXT NOT NULL,
      reason     TEXT,
      changed_by TEXT,
      changed_at TEXT NOT NULL
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_payment_due_changes_order ON order_payment_due_changes(order_id)');

  // Sales targets keep their history: report_targets holds the current value, this table every change (who, when, why).
  db.exec(`
    CREATE TABLE IF NOT EXISTS report_target_changes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      scope       TEXT NOT NULL,
      scope_value TEXT NOT NULL,
      measure     TEXT NOT NULL,
      month       TEXT NOT NULL,
      old_value   REAL,
      new_value   REAL,
      reason      TEXT,
      changed_by  TEXT,
      changed_at  TEXT NOT NULL
    )`);
  db.exec('CREATE INDEX IF NOT EXISTS ix_target_changes_key ON report_target_changes(scope, scope_value, measure, month)');

  // The Sales Manager dashboard's team-performance thresholds (domain/sales-dashboard.js). One row.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_dashboard_settings (
      id            INTEGER PRIMARY KEY CHECK (id = 1),
      on_track_pct  REAL NOT NULL,
      at_risk_pct   REAL NOT NULL,
      updated_by    TEXT,
      updated_at    TEXT NOT NULL
    )`);

}

/** Seed default administrators if absent so any cloned repo works out of the box */
function ensureInitialStaffUsers(db) {
  try {
    const existing = new Set(
      db.prepare("SELECT email FROM staff_users WHERE email IS NOT NULL").all().map((r) => r.email?.toLowerCase())
    );
    const hash = hashPassword('Admin123456!');
    const insert = db.prepare(`
      INSERT INTO staff_users (name, email, role, rep_id, password_hash, must_change_password, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, 'ADMIN', null, ?, 0, 1, 'system', datetime('now'), datetime('now'))
    `);
    const admins = [
      { name: 'Brain Amponsah', email: 'amponsahbrain2007@gmail.com' },
      { name: 'Hammoud', email: 'hammoudam1990@gmail.com' },
      { name: 'Manfred Sunu', email: 'sunumanfred14@gmail.com' },
    ];
    for (const a of admins) {
      if (!existing.has(a.email.toLowerCase())) {
        insert.run(a.name, a.email.toLowerCase(), hash);
      }
    }
  } catch {
    // Non-fatal if staff_users table not created yet or during isolated mock tests
  }
}

/** Add any of `columns` that the table does not already have. Idempotent. */
function addColumns(db, table, columns) {
  const existing = new Set(columnsOf(db, table));
  for (const [name, decl] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
  }
}

export default openDatabase;
