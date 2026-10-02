-- Box for Less — Product Master schema (Phase 1)
-- Engine: SQLite (node:sqlite). All timestamps are ISO-8601 UTC strings.
--
-- Identity principle:
--   products.id (surrogate autoincrement) is the ONE stable internal identity.
--   It is NEVER derived from row position or barcode.
--   source_odoo_id is the preferred external stable id when a future export
--   provides it. barcode is an important BUSINESS identifier but is mutable
--   and never used as the immutable DB key.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- categories
--
-- RULE CHANGE (2026-10-02, Stage 2.1): Odoo is now the source of truth for the
-- product category, so the import DOES populate this table from the export's
-- "Product Category" path. The narrowing is deliberate and limited:
--   * the import may create category nodes and set products.category_id;
--   * every category change is written to import_changes (never silent);
--   * IMAGES remain fully application-controlled and are NEVER touched by import.
-- The full Odoo path is also stored verbatim on products.odoo_category_path, so
-- this table is a derived index over Odoo's truth, not a second source of it.
-- ---------------------------------------------------------------------------
-- `name` is the display SEGMENT and is deliberately NOT unique: real Odoo data
-- contains a child repeating its parent's name
-- ("DRINKS & BEVERAGES / JUICES & NECTARS / JUICES & NECTARS").
-- `path` — the complete Odoo path — is the stable unique key.
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  path        TEXT    NOT NULL UNIQUE,
  level       INTEGER NOT NULL DEFAULT 1,   -- 1 = top level
  parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_categories_parent ON categories(parent_id);
CREATE INDEX IF NOT EXISTS ix_categories_level  ON categories(level);

-- ---------------------------------------------------------------------------
-- products  (the Product Master)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,

  -- identity
  source_odoo_id          TEXT,            -- preferred stable external id (nullable until Odoo exposes it)
  barcode                 TEXT NOT NULL,   -- business identifier (mutable; changes are reviewed)
  name                    TEXT NOT NULL,
  box_uom                 TEXT,

  -- Odoo-controlled stock (informational; updated by import)
  on_hand                 REAL NOT NULL DEFAULT 0,
  free_to_use             REAL NOT NULL DEFAULT 0,
  incoming                REAL NOT NULL DEFAULT 0,
  outgoing                REAL NOT NULL DEFAULT 0,
  forecasted              REAL NOT NULL DEFAULT 0,

  -- lifecycle
  is_active               INTEGER NOT NULL DEFAULT 1,

  -- Odoo-controlled category (source of truth = the export's "Product Category")
  odoo_category_path      TEXT,            -- complete verbatim path, e.g. "FOOD / SPICES & SEASONINGS / GROUND SPICES"

  -- application-controlled relationships
  primary_image_id        INTEGER REFERENCES product_images(id) ON DELETE SET NULL, -- NEVER touched by import
  category_id             INTEGER REFERENCES categories(id)     ON DELETE SET NULL, -- derived leaf of odoo_category_path

  -- review / data-quality flags
  barcode_change_pending  INTEGER NOT NULL DEFAULT 0,
  uom_change_pending      INTEGER NOT NULL DEFAULT 0,
  pending_barcode         TEXT,            -- incoming barcode awaiting review (value NOT applied yet)
  pending_uom             TEXT,            -- incoming UoM awaiting review (value NOT applied yet)
  data_quality_status     TEXT NOT NULL DEFAULT 'OK',   -- OK | WARNING | ERROR
  data_quality_notes      TEXT,

  -- provenance / audit
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  last_import_id          INTEGER REFERENCES import_batches(id) ON DELETE SET NULL, -- last import to update Odoo-controlled data
  last_seen_import_id     INTEGER REFERENCES import_batches(id) ON DELETE SET NULL  -- last import in which this product appeared
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_products_source_odoo_id
  ON products(source_odoo_id) WHERE source_odoo_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_products_barcode  ON products(barcode);
CREATE INDEX IF NOT EXISTS ix_products_name     ON products(name);
CREATE INDEX IF NOT EXISTS ix_products_active    ON products(is_active);
-- ix_products_category / ix_products_odoo_category_path are created by
-- applyMigrations() instead, AFTER the odoo_category_path column has been added
-- to pre-existing databases — an index here would run before that ALTER.

-- ---------------------------------------------------------------------------
-- product_images  (separate relationship; import NEVER writes here)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  is_primary    INTEGER NOT NULL DEFAULT 0,
  filename      TEXT,
  url_reference TEXT,
  uploaded_at   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_product_images_product ON product_images(product_id);

-- ---------------------------------------------------------------------------
-- import_batches  (one row per import attempt; audit header)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  filename             TEXT NOT NULL,
  file_hash            TEXT,
  stored_path          TEXT,
  imported_at          TEXT NOT NULL,     -- when preview was created
  confirmed_at         TEXT,
  completed_at         TEXT,

  total_rows           INTEGER NOT NULL DEFAULT 0,
  valid_rows           INTEGER NOT NULL DEFAULT 0,
  invalid_rows         INTEGER NOT NULL DEFAULT 0,

  created_count        INTEGER NOT NULL DEFAULT 0,
  updated_count        INTEGER NOT NULL DEFAULT 0,
  unchanged_count      INTEGER NOT NULL DEFAULT 0,
  inactive_count       INTEGER NOT NULL DEFAULT 0,
  reactivated_count    INTEGER NOT NULL DEFAULT 0,
  barcode_change_count INTEGER NOT NULL DEFAULT 0,
  uom_change_count     INTEGER NOT NULL DEFAULT 0,
  warning_count        INTEGER NOT NULL DEFAULT 0,
  error_count          INTEGER NOT NULL DEFAULT 0,

  status               TEXT NOT NULL DEFAULT 'PREVIEW',  -- PREVIEW | CONFIRMED | COMPLETED | FAILED
  preview_json         TEXT,              -- cached preview payload for the UI
  notes                TEXT
);
CREATE INDEX IF NOT EXISTS ix_import_batches_status ON import_batches(status);

-- ---------------------------------------------------------------------------
-- import_changes  (per-event change log)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_changes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  import_batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL, -- null for validation errors on uncreated rows
  change_type     TEXT NOT NULL,   -- PRODUCT_CREATED | PRODUCT_UPDATED | BARCODE_CHANGE_DETECTED
                                   -- | UOM_CHANGE_DETECTED | PRODUCT_MARKED_INACTIVE
                                   -- | PRODUCT_REACTIVATED | VALIDATION_ERROR
  field           TEXT,
  old_value       TEXT,
  new_value       TEXT,
  row_number      INTEGER,         -- source spreadsheet row (1-based data row) for traceability
  barcode         TEXT,
  review_status   TEXT NOT NULL DEFAULT 'NA',  -- NA | PENDING | ACCEPTED | REJECTED
  message         TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_import_changes_batch   ON import_changes(import_batch_id);
CREATE INDEX IF NOT EXISTS ix_import_changes_product ON import_changes(product_id);
CREATE INDEX IF NOT EXISTS ix_import_changes_review  ON import_changes(review_status);
CREATE INDEX IF NOT EXISTS ix_import_changes_type    ON import_changes(change_type);

-- ===========================================================================
-- FORWARD-COMPATIBILITY SKELETON  (Phases 3-6)
-- Created now, UNUSED in Phase 1, so Product Master never needs restructuring
-- when these phases arrive. No Phase 1 code reads or writes these tables.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS customers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  reference   TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS sales_users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  email       TEXT UNIQUE,
  role        TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT,
  updated_at  TEXT
);
CREATE TABLE IF NOT EXISTS requests (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id   INTEGER REFERENCES customers(id)   ON DELETE SET NULL,
  sales_user_id INTEGER REFERENCES sales_users(id) ON DELETE SET NULL,
  status        TEXT,
  created_at    TEXT,
  updated_at    TEXT
);
CREATE TABLE IF NOT EXISTS request_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT, -- history protected
  quantity    REAL,
  created_at  TEXT
);
CREATE TABLE IF NOT EXISTS quotations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id     INTEGER REFERENCES requests(id) ON DELETE SET NULL,
  odoo_reference TEXT,
  status         TEXT,
  created_at     TEXT,
  updated_at     TEXT
);
