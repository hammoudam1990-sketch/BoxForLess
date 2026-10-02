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
}

export default openDatabase;
