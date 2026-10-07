// Stage 2.1 — Odoo product categories.
//
// Odoo is the source of truth for the category. The complete path is preserved
// and remains decomposable into top level / parent / name. Images, identity and
// history must survive the re-import untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import { freshDb, tmpUploads, getProduct } from './helpers.js';
import { createPreview, confirmImport } from '../src/import/service.js';
import { parseCategoryPath, normalizeCategoryPath, ensureCategoryPath, ancestorPaths } from '../src/domain/categories.js';
import { mapHeaders } from '../src/import/headers.js';
import { searchCatalog, getCatalogProduct, categoryFacets } from '../src/domain/catalog.js';
import { saveProductImage } from '../src/domain/images.js';
import { createApp } from '../src/server/index.js';
import { ChangeType } from '../src/domain/constants.js';
import config from '../src/config.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-cat21-'));
function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

// The REAL header set of the new Odoo export, in the real column order.
const HEADERS = ['Internal Reference', 'Barcode', 'Name', 'Product Category', 'Box UoM',
  'On Hand (CTN, decimal)', 'Free To Use (CTN)', 'Incoming (CTN)', 'Outgoing (CTN)', 'Forecasted (CTN, decimal)'];

function row({ ref, barcode, name, category, uom = 'CTN12', free = 10, onHand = 10 }) {
  return {
    'Internal Reference': ref, Barcode: barcode, Name: name, 'Product Category': category,
    'Box UoM': uom, 'On Hand (CTN, decimal)': onHand, 'Free To Use (CTN)': free,
    'Incoming (CTN)': 0, 'Outgoing (CTN)': 0, 'Forecasted (CTN, decimal)': onHand,
  };
}

function writeXlsx(rows) {
  const ws = xlsx.utils.json_to_sheet(rows, { header: HEADERS });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-x-')), 'import.xlsx');
  xlsx.writeFile(wb, f);
  return f;
}

function runImport(db, rows) {
  const { batchId } = createPreview(db, writeXlsx(rows), 'odoo.xlsx', { uploadsDir: tmpUploads() });
  return confirmImport(db, batchId);
}

const CHICKEN = { ref: 'BL01745', barcode: '5283013330912', name: 'PLEIN SOLEIL CHICKEN STOCK 20G * 24', category: 'FOOD / SPICES & SEASONINGS / STOCK & BOUILLON', uom: 'CTN24', free: 13 };
const SHAMPOO = { ref: 'BL00123', barcode: '5283013330929', name: 'SUNSILK SHAMPOO 400ML', category: 'NON-FOOD / PERSONAL CARE — HAIR / SHAMPOO & CONDITIONER', free: 3 };
const JUICE = { ref: 'BL00456', barcode: '5283013330936', name: 'RANI FLOAT ORANGE 240ML', category: 'DRINKS & BEVERAGES / JUICES & NECTARS / JUICES & NECTARS', free: 0 };
const PETFOOD = { ref: 'BL00789', barcode: '5283013330943', name: 'WHISKAS TUNA 400G', category: 'PETS / PET FOOD', free: 50 };
const ALL = [CHICKEN, SHAMPOO, JUICE, PETFOOD];

function seed() {
  const db = freshDb();
  runImport(db, ALL.map(row));
  return db;
}

// ===========================================================================
// Header mapping — the regression that would have inverted the Product Master
// ===========================================================================
test('REGRESSION: "Internal Reference" maps to source_odoo_id, NOT barcode', () => {
  const m = mapHeaders(HEADERS);
  assert.equal(m.mapping.source_odoo_id.header, 'Internal Reference');
  assert.equal(m.mapping.barcode.header, 'Barcode', 'the REAL barcode column must win');
  assert.equal(m.mapping.category_path.header, 'Product Category');
  assert.deepEqual(m.duplicateTargets, [], 'no column may be silently dropped as a duplicate');
  assert.deepEqual(m.unexpected, [], 'every column of the real export is understood');
  assert.deepEqual(m.missingRequired, []);
});

// ===========================================================================
// 1-4. Category import, full path, top level, parent
// ===========================================================================
test('1. new Odoo category data is imported', () => {
  const db = seed();
  const p = getProduct(db, CHICKEN.barcode);
  assert.equal(p.odoo_category_path, CHICKEN.category);
  assert.ok(p.category_id, 'linked to a materialised category node');
  db.close();
});

test('2. the COMPLETE category path is preserved verbatim', () => {
  const db = seed();
  for (const r of ALL) {
    assert.equal(getProduct(db, r.barcode).odoo_category_path, r.category);
  }
  db.close();
});

test('3. top-level category is preserved and recoverable', () => {
  assert.equal(parseCategoryPath(CHICKEN.category).topLevel, 'FOOD');
  assert.equal(parseCategoryPath(SHAMPOO.category).topLevel, 'NON-FOOD');
  assert.equal(parseCategoryPath(JUICE.category).topLevel, 'DRINKS & BEVERAGES');
  assert.equal(parseCategoryPath(PETFOOD.category).topLevel, 'PETS');
});

test('4. parent category is preserved and distinct from the leaf', () => {
  const c = parseCategoryPath('FOOD / SPICES & SEASONINGS / GROUND SPICES');
  assert.equal(c.topLevel, 'FOOD');
  assert.equal(c.parent, 'SPICES & SEASONINGS');
  assert.equal(c.name, 'GROUND SPICES');
  assert.equal(c.path, 'FOOD / SPICES & SEASONINGS / GROUND SPICES');
  assert.equal(c.level, 3);
});

test('4b. a 2-level path reports no parent rather than inventing one', () => {
  const c = parseCategoryPath('NON-FOOD / FOOD SERVICE & PACKAGING');
  assert.equal(c.topLevel, 'NON-FOOD');
  assert.equal(c.parent, null);
  assert.equal(c.name, 'FOOD SERVICE & PACKAGING');
  assert.equal(c.level, 2);
});

test('4c. a child may repeat its parent name (real Odoo data)', () => {
  const db = freshDb();
  const id = ensureCategoryPath(db, JUICE.category);
  const nodes = db.prepare('SELECT name, path, level FROM categories ORDER BY level').all();
  assert.equal(nodes.length, 3);
  assert.equal(nodes[1].name, 'JUICES & NECTARS');
  assert.equal(nodes[2].name, 'JUICES & NECTARS', 'duplicate NAME at a different path is allowed');
  assert.notEqual(nodes[1].path, nodes[2].path, 'path is the unique key');
  assert.equal(db.prepare('SELECT path FROM categories WHERE id=?').get(id).path, JUICE.category);
  db.close();
});

test('4d. the hierarchy is materialised with parent links, idempotently', () => {
  const db = freshDb();
  assert.deepEqual(ancestorPaths(CHICKEN.category), [
    'FOOD', 'FOOD / SPICES & SEASONINGS', 'FOOD / SPICES & SEASONINGS / STOCK & BOUILLON',
  ]);
  const a = ensureCategoryPath(db, CHICKEN.category);
  const countA = db.prepare('SELECT COUNT(*) n FROM categories').get().n;
  const b = ensureCategoryPath(db, CHICKEN.category); // again
  assert.equal(a, b, 'same leaf id');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM categories').get().n, countA, 'no duplicate nodes');
  const leaf = db.prepare('SELECT * FROM categories WHERE id=?').get(a);
  const parent = db.prepare('SELECT * FROM categories WHERE id=?').get(leaf.parent_id);
  assert.equal(parent.name, 'SPICES & SEASONINGS');
  assert.equal(db.prepare('SELECT * FROM categories WHERE id=?').get(parent.parent_id).name, 'FOOD');
  db.close();
});

test('4e. path normalization tolerates spacing noise without altering meaning', () => {
  assert.equal(normalizeCategoryPath('FOOD/SPICES & SEASONINGS/GROUND SPICES'), 'FOOD / SPICES & SEASONINGS / GROUND SPICES');
  assert.equal(normalizeCategoryPath('  FOOD  /  SPICES   & SEASONINGS  '), 'FOOD / SPICES & SEASONINGS');
  assert.equal(normalizeCategoryPath(''), null);
  assert.equal(normalizeCategoryPath(null), null);
});

// ===========================================================================
// 5-7. Change detection, creation, update
// ===========================================================================
test('5. a category change is DETECTED and written to history, not silently applied', () => {
  const db = seed();
  const before = getProduct(db, CHICKEN.barcode);
  const moved = { ...CHICKEN, category: 'FOOD / CONDIMENTS, SAUCES & PASTES / SPREADS & DIPS' };
  const res = runImport(db, [row(moved), row(SHAMPOO), row(JUICE), row(PETFOOD)]);

  assert.equal(res.counts.category_changes, 1);
  const after = getProduct(db, CHICKEN.barcode);
  assert.equal(after.odoo_category_path, moved.category, 'Odoo value applied');
  assert.notEqual(after.category_id, before.category_id, 'relinked to the new node');

  const log = db.prepare(
    'SELECT * FROM import_changes WHERE product_id=? AND change_type=? ORDER BY id DESC'
  ).all(before.id, ChangeType.CATEGORY_CHANGE_DETECTED);
  assert.ok(log.length >= 2, 'initial set + the change are both in history');
  assert.equal(log[0].old_value, CHICKEN.category, 'the PREVIOUS category is preserved in history');
  assert.equal(log[0].new_value, moved.category);
  db.close();
});

test('6. a NEW product is created with its category', () => {
  const db = seed();
  const extra = { ref: 'BL09999', barcode: '5283013330950', name: 'LARTISAN CAKE BOX', category: 'NON-FOOD / FOOD SERVICE & PACKAGING / FOOD CONTAINERS & PLATES' };
  const res = runImport(db, [...ALL, extra].map(row));
  assert.equal(res.counts.created, 1);
  const p = getProduct(db, extra.barcode);
  assert.equal(p.odoo_category_path, extra.category);
  assert.ok(p.category_id);
  db.close();
});

test('7. an EXISTING product has its category updated from Odoo', () => {
  const db = seed();
  const moved = { ...SHAMPOO, category: 'NON-FOOD / PERSONAL CARE — BODY / SHOWER & BATH' };
  runImport(db, [row(CHICKEN), row(moved), row(JUICE), row(PETFOOD)]);
  const p = getProduct(db, SHAMPOO.barcode);
  assert.equal(p.odoo_category_path, moved.category);
  assert.equal(parseCategoryPath(p.odoo_category_path).parent, 'PERSONAL CARE — BODY');
  db.close();
});

test('7b. re-importing identical data changes nothing (idempotent)', () => {
  const db = seed();
  const res = runImport(db, ALL.map(row));
  assert.equal(res.counts.updated, 0);
  assert.equal(res.counts.created, 0);
  assert.equal(res.counts.category_changes, 0);
  assert.equal(res.counts.unchanged, 4);
  db.close();
});

// ===========================================================================
// 8-11. Lifecycle, images, identity
// ===========================================================================
test('8. a product missing from the new export follows the existing inactive rule', () => {
  const db = seed();
  const res = runImport(db, [row(CHICKEN), row(SHAMPOO), row(JUICE)]); // PETS dropped
  assert.equal(res.counts.inactivated, 1);
  const p = getProduct(db, PETFOOD.barcode);
  assert.ok(p, 'NOT deleted');
  assert.equal(p.is_active, 0);
  assert.equal(p.odoo_category_path, PETFOOD.category, 'its category history is kept too');
  db.close();
});

test('9. an existing product IMAGE survives a re-import that changes its category', () => {
  const db = seed();
  config.productImagesDir = tmpDir();
  const before = getProduct(db, CHICKEN.barcode);
  saveProductImage(db, before.id, JPEG, 'image/jpeg');
  const withImage = getProduct(db, CHICKEN.barcode);
  assert.ok(withImage.primary_image_id, 'precondition: photo attached');

  const moved = { ...CHICKEN, category: 'FOOD / PANTRY & DRY GOODS / RICE & GRAINS', free: 99 };
  runImport(db, [row(moved), row(SHAMPOO), row(JUICE), row(PETFOOD)]);

  const after = getProduct(db, CHICKEN.barcode);
  assert.equal(after.id, before.id, 'same product identity');
  assert.equal(after.primary_image_id, withImage.primary_image_id, 'SAME image still attached');
  assert.equal(after.odoo_category_path, moved.category, 'category updated from Odoo');
  assert.equal(after.free_to_use, 99, 'stock updated from Odoo');
  const img = db.prepare('SELECT * FROM product_images WHERE id=?').get(after.primary_image_id);
  assert.ok(img && img.is_active === 1, 'image row intact and active');
  db.close();
});

test('10. the barcode remains stable across the re-import', () => {
  const db = seed();
  const before = getProduct(db, CHICKEN.barcode);
  runImport(db, ALL.map(row));
  const after = getProduct(db, CHICKEN.barcode);
  assert.equal(after.id, before.id);
  assert.equal(after.barcode, CHICKEN.barcode);
  assert.equal(after.barcode_change_pending, 0);
  db.close();
});

test('11. Internal Reference is stored as the stable Odoo identifier', () => {
  const db = seed();
  assert.equal(getProduct(db, CHICKEN.barcode).source_odoo_id, 'BL01745');
  db.close();
});

test('11c. a product that predates the stable id has it BACKFILLED on match', () => {
  const db = seed();
  // simulate the real Product Master: matched by barcode, no stable id yet
  db.prepare('UPDATE products SET source_odoo_id = NULL').run();
  assert.equal(getProduct(db, CHICKEN.barcode).source_odoo_id, null, 'precondition');

  const res = runImport(db, ALL.map(row));
  assert.equal(res.counts.created, 0, 'backfill must NOT create duplicates');
  assert.equal(getProduct(db, CHICKEN.barcode).source_odoo_id, 'BL01745');
  assert.equal(getProduct(db, PETFOOD.barcode).source_odoo_id, 'BL00789');
  db.close();
});

test('11d. backfill NEVER overwrites an existing stable id', () => {
  const db = seed();
  const before = getProduct(db, CHICKEN.barcode);
  db.prepare('UPDATE products SET source_odoo_id = ? WHERE id = ?').run('KEEP-ME', before.id);
  // the export says BL01745; matching now happens by barcode, id must be kept
  runImport(db, ALL.map(row));
  assert.equal(getProduct(db, CHICKEN.barcode).source_odoo_id, 'KEEP-ME');
  db.close();
});

test('11b. once stored, identity matches on the stable id and a barcode change becomes REVIEWABLE', () => {
  const db = seed();
  const before = getProduct(db, CHICKEN.barcode);
  // same Internal Reference, different barcode -> must be the SAME product, flagged
  const rebarcoded = { ...CHICKEN, barcode: '9999999999999' };
  const res = runImport(db, [row(rebarcoded), row(SHAMPOO), row(JUICE), row(PETFOOD)]);

  assert.equal(res.counts.created, 0, 'NOT treated as a new product');
  assert.equal(res.counts.barcode_changes, 1);
  const after = db.prepare('SELECT * FROM products WHERE id=?').get(before.id);
  assert.equal(after.barcode, CHICKEN.barcode, 'old barcode still in force — change is NOT auto-applied');
  assert.equal(after.barcode_change_pending, 1);
  assert.equal(after.pending_barcode, '9999999999999');
  db.close();
});

// ===========================================================================
// 12-13. Customer API safety
// ===========================================================================
test('12. the customer API exposes category NAMES and PATH only', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const p = await (await fetch(`${base}/api/catalog/products/${CHICKEN.barcode}`)).json();
    assert.deepEqual(p.category, {
      top_level: 'FOOD', parent: 'SPICES & SEASONINGS',
      name: 'STOCK & BOUILLON', path: CHICKEN.category,
    });
    const cats = await (await fetch(`${base}/api/catalog/categories`)).json();
    assert.ok(cats.items.length > 0);
    for (const c of cats.items) {
      assert.deepEqual(Object.keys(c).sort(), ['count', 'level', 'name', 'parent', 'path', 'top_level']);
    }
  } finally { server.close(); }
  db.close();
});

test('13. the customer API does NOT expose internal category IDs', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const realId = getProduct(db, CHICKEN.barcode).category_id;
    assert.ok(realId, 'precondition: an internal category id exists');
    for (const url of ['/api/catalog/products', `/api/catalog/products/${CHICKEN.barcode}`, '/api/catalog/categories']) {
      const text = await (await fetch(base + url)).text();
      assert.ok(!text.includes('category_id'), `${url} leaked category_id`);
      assert.ok(!text.includes('parent_id'), `${url} leaked parent_id`);
      assert.ok(!text.includes('odoo_category_path'), `${url} leaked the raw column name`);
      const json = JSON.parse(text);
      const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === 'object') {
          for (const [k, val] of Object.entries(v)) {
            assert.ok(!/(^|_)id$/.test(k) || k === 'id', `${url} exposed an id-ish key: ${k}`);
            walk(val);
          }
        }
      };
      walk(json);
    }
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// 14-17. The four top-level categories filter correctly
// ===========================================================================
const TOP_CASES = [
  ['14. FOOD', 'FOOD', CHICKEN],
  ['15. NON-FOOD', 'NON-FOOD', SHAMPOO],
  ['16. DRINKS & BEVERAGES', 'DRINKS & BEVERAGES', JUICE],
  ['17. PETS', 'PETS', PETFOOD],
];
for (const [label, top, expected] of TOP_CASES) {
  test(`${label} products filter correctly`, () => {
    const db = seed();
    const res = searchCatalog(db, { topLevel: top });
    assert.equal(res.total, 1, `${top} must match exactly its own product`);
    assert.equal(res.items[0].barcode, expected.barcode);
    assert.equal(res.items[0].category.top_level, top);
    db.close();
  });
}

test('14b. the four real top-level categories are all present and never merged', () => {
  const db = seed();
  const tops = categoryFacets(db).filter((c) => c.level === 1).map((c) => c.name).sort();
  assert.deepEqual(tops, ['DRINKS & BEVERAGES', 'FOOD', 'NON-FOOD', 'PETS']);
  db.close();
});

test('14c. a deeper path filter selects that subtree only', () => {
  const db = seed();
  assert.equal(searchCatalog(db, { categoryPath: 'FOOD / SPICES & SEASONINGS' }).total, 1);
  assert.equal(searchCatalog(db, { categoryPath: 'FOOD / SPICES & SEASONINGS / STOCK & BOUILLON' }).total, 1);
  assert.equal(searchCatalog(db, { categoryPath: 'NON-FOOD' }).total, 1);
  db.close();
});

test('14e. a category chip counts the SAME products the list beneath it shows', () => {
  // Reported from a real session: HOT DRINKS read "5" above a list of 2. The
  // chips counted the whole catalogue while the list was filtered to Available
  // Now, so the three products without stock were counted but not shown. A count
  // that disagrees with its own list makes the customer distrust both.
  const db = seed();

  for (const view of ['available', 'full']) {
    for (const chip of categoryFacets(db, { view })) {
      const listed = searchCatalog(db, { categoryPath: chip.path, view }).total;
      assert.equal(
        chip.count, listed,
        `${view}: chip "${chip.path}" says ${chip.count} but the list shows ${listed}`,
      );
    }
  }

  // and the two views genuinely differ, or the check above proves nothing
  const available = categoryFacets(db, { view: 'available' });
  const full = categoryFacets(db, { view: 'full' });
  assert.ok(
    full.some((f) => (available.find((a) => a.path === f.path)?.count ?? 0) < f.count),
    'Available Now should count fewer products than Full Catalogue somewhere',
  );
  db.close();
});

test('14d. category filters exclude INACTIVE products', () => {
  const db = seed();
  runImport(db, [row(SHAMPOO), row(JUICE), row(PETFOOD)]); // FOOD product dropped
  assert.equal(searchCatalog(db, { topLevel: 'FOOD' }).total, 0);
  assert.ok(!categoryFacets(db).some((c) => c.name === 'FOOD'));
  db.close();
});

test('14e. category facet counts roll up through the hierarchy', () => {
  const db = seed();
  const f = categoryFacets(db);
  const byPath = Object.fromEntries(f.map((c) => [c.path, c.count]));
  assert.equal(byPath['FOOD'], 1);
  assert.equal(byPath['FOOD / SPICES & SEASONINGS'], 1);
  assert.equal(byPath['FOOD / SPICES & SEASONINGS / STOCK & BOUILLON'], 1);
  db.close();
});

// ===========================================================================
// 18-19. Baselines
// ===========================================================================
test('18-19. an export with NO category column leaves stored categories alone', () => {
  const db = seed();
  const before = getProduct(db, CHICKEN.barcode);
  // legacy-shaped file: no "Product Category" column at all
  const legacyHeaders = HEADERS.filter((h) => h !== 'Product Category');
  const ws = xlsx.utils.json_to_sheet(ALL.map((r) => {
    const o = row(r); delete o['Product Category']; return o;
  }), { header: legacyHeaders });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-x-')), 'legacy.xlsx');
  xlsx.writeFile(wb, f);
  const { batchId } = createPreview(db, f, 'legacy.xlsx', { uploadsDir: tmpUploads() });
  const res = confirmImport(db, batchId);

  assert.equal(res.counts.category_changes, 0, 'absent column = no information, not "clear it"');
  const after = getProduct(db, CHICKEN.barcode);
  assert.equal(after.odoo_category_path, before.category_path ?? CHICKEN.category);
  assert.equal(after.category_id, before.category_id);
  db.close();
});

test('19. the customer catalog still serves products that have no category', () => {
  const db = freshDb();
  runImport(db, [row({ ...CHICKEN, category: null })]);
  const p = getCatalogProduct(db, CHICKEN.barcode);
  assert.equal(p.category, null, 'null category, not a crash or an invented one');
  assert.equal(p.name, CHICKEN.name);
  assert.equal(searchCatalog(db).total, 1);
  db.close();
});
