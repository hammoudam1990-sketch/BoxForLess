// Create a named data checkpoint: a consistent copy of the database plus every
// product image, with a manifest describing the state it captured.
//
//   node scripts/checkpoint.js <name> [--note "why"]
//
// Checkpoints live in data/checkpoints/<name>/ and are gitignored (they are data,
// not source). An existing checkpoint is NEVER overwritten — prior checkpoints are
// historical evidence, so the script refuses rather than replacing one.
//
// This is deliberately READ-ONLY with respect to product data. The single write it
// performs is PRAGMA wal_checkpoint(TRUNCATE), which folds the write-ahead log into
// the database file so the copy is a consistent single file. It changes no row.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import config from '../src/config.js';

const ROOT = config.root;
const CHECKPOINT_ROOT = path.join(ROOT, 'data', 'checkpoints');

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function parseArgs(argv) {
  const name = argv[0];
  const noteIdx = argv.indexOf('--note');
  return { name, note: noteIdx >= 0 ? argv[noteIdx + 1] : null };
}

/** Everything worth asserting about the captured state. */
function collectStats(db) {
  const one = (sql) => db.prepare(sql).get();
  const all = (sql) => db.prepare(sql).all();
  const tableExists = (t) => !!db.prepare(
    "SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(t);
  const countIf = (t) => (tableExists(t) ? one(`SELECT COUNT(*) AS n FROM ${t}`).n : null);

  return {
    products: countIf('products'),
    activeProducts: one('SELECT COUNT(*) AS n FROM products WHERE is_active = 1').n,
    inactiveProducts: one('SELECT COUNT(*) AS n FROM products WHERE is_active = 0').n,
    withCategory: one('SELECT COUNT(*) AS n FROM products WHERE odoo_category_path IS NOT NULL').n,
    withStableId: one('SELECT COUNT(*) AS n FROM products WHERE source_odoo_id IS NOT NULL').n,
    categoryNodes: countIf('categories'),
    activeImages: one('SELECT COUNT(*) AS n FROM product_images WHERE is_active = 1').n,
    productsWithPrimaryImage: one('SELECT COUNT(*) AS n FROM products WHERE primary_image_id IS NOT NULL').n,
    importBatches: countIf('import_batches'),
    changeLogRows: countIf('import_changes'),
    pendingReviewRows: one("SELECT COUNT(*) AS n FROM import_changes WHERE review_status = 'PENDING'").n,
    customers: countIf('customers'),
    requests: countIf('requests'),
    requestItems: countIf('request_items'),
    dataQuality: all('SELECT data_quality_status AS status, COUNT(*) AS n FROM products GROUP BY status'),
    topLevelCategories: all(
      `SELECT CASE WHEN instr(odoo_category_path, ' / ') > 0
                   THEN substr(odoo_category_path, 1, instr(odoo_category_path, ' / ') - 1)
                   ELSE odoo_category_path END AS top_level,
              COUNT(*) AS n
         FROM products WHERE is_active = 1
        GROUP BY top_level ORDER BY n DESC`
    ),
  };
}

export function createCheckpoint(name, { note = null, dbPath = config.dbPath, imagesDir = config.productImagesDir } = {}) {
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error('Checkpoint name is required and may contain only letters, digits, dot, dash, underscore.');
  }
  const dir = path.join(CHECKPOINT_ROOT, name);
  if (fs.existsSync(dir)) {
    throw new Error(`Checkpoint "${name}" already exists. Prior checkpoints are never overwritten — choose another name.`);
  }
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // fold the WAL in; changes no row
  const stats = collectStats(db);
  const schemaTables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((r) => r.name);
  db.close();

  fs.mkdirSync(dir, { recursive: true });
  const dbCopy = path.join(dir, path.basename(dbPath));
  fs.copyFileSync(dbPath, dbCopy);
  if (sha256(dbPath) !== sha256(dbCopy)) throw new Error('Database copy failed verification.');

  // every image file, each verified byte-for-byte
  const imgOut = path.join(dir, 'product-images');
  fs.mkdirSync(imgOut, { recursive: true });
  const images = [];
  if (fs.existsSync(imagesDir)) {
    for (const f of fs.readdirSync(imagesDir)) {
      const src = path.join(imagesDir, f);
      if (!fs.statSync(src).isFile()) continue;
      const dst = path.join(imgOut, f);
      fs.copyFileSync(src, dst);
      const hash = sha256(src);
      if (hash !== sha256(dst)) throw new Error(`Image copy failed verification: ${f}`);
      images.push({ file: f, bytes: fs.statSync(dst).size, sha256: hash });
    }
  }

  const manifest = {
    checkpoint: name,
    note,
    created_at: new Date().toISOString(),
    source: { database: dbPath, images: imagesDir },
    schema_tables: schemaTables,
    database: stats,
    image_files: images,
  };
  fs.writeFileSync(path.join(dir, 'MANIFEST.json'), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('checkpoint.js')) {
  const { name, note } = parseArgs(process.argv.slice(2));
  try {
    const { dir, manifest } = createCheckpoint(name, { note });
    console.log(`Checkpoint created: ${dir}`);
    console.log(JSON.stringify(manifest.database, null, 2));
    console.log(`images captured: ${manifest.image_files.length}`);
  } catch (e) {
    console.error(`Checkpoint failed: ${e.message}`);
    process.exit(1);
  }
}

export default createCheckpoint;
