// Stage 2 — Customer Digital Product Catalog.
//
// The catalog is a customer-safe PROJECTION of the Product Master. These tests
// cover the two things that can go wrong: the wrong products being visible, and
// internal data leaking into a customer payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDb, runImport, row, getProduct, tmpUploads } from './helpers.js';
import {
  searchCatalog, getCatalogProduct, toCatalogProduct, catalogFacets, publicId,
  CUSTOMER_SAFE_FIELDS, FORBIDDEN_CUSTOMER_FIELDS,
} from '../src/domain/catalog.js';
import { saveProductImage } from '../src/domain/images.js';
import { searchProducts, getProductDetail } from '../src/domain/products.js';
import { createApp } from '../src/server/index.js';
import config from '../src/config.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 9)]);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-cat-'));

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((res) => server.listen(0, () => res({
    server, base: `http://127.0.0.1:${server.address().port}`,
  })));
}

// Distinctive quantities: if any of these numbers reaches a customer, the
// leak tests below will see it in the raw response text.
const Q = { IN: 777, LIMITED: 3, OUT: 0 };

const CHICKEN = { barcode: '5283013330912', name: 'PLEIN SOLEIL CHICKEN STOCK 20G * 24', uom: 'CTN24', free: Q.IN, on_hand: 888, incoming: 999, outgoing: 111, forecasted: 222 };
const BEEF = { barcode: '5283013330929', name: 'PLEIN SOLEIL BEEF STOCK 20G * 12', uom: 'CTN12', free: Q.LIMITED };
const RICE = { barcode: '5283013330936', name: 'GOLDEN RICE 1KG * 10', uom: 'CTN10', free: Q.OUT };

/** A seeded catalog database with the three availability states represented. */
function seed() {
  const db = freshDb();
  runImport(db, [row(CHICKEN), row(BEEF), row(RICE)], { uploadsDir: tmpUploads() });
  return db;
}

/**
 * Make a product inactive THE REAL WAY: a later import that no longer contains
 * it. This proves catalog visibility derives from Product Master lifecycle
 * rather than from a flag a test poked directly.
 */
function deactivateRice(db) {
  runImport(db, [row(CHICKEN), row(BEEF)], { uploadsDir: tmpUploads() });
  assert.equal(getProduct(db, RICE.barcode).is_active, 0, 'precondition: rice is now inactive');
}

const names = (r) => r.items.map((i) => i.name);

// ===========================================================================
// 1-2. Active / inactive visibility
// ===========================================================================
test('1. an active product appears in the customer catalog', () => {
  const db = seed();
  assert.ok(names(searchCatalog(db)).includes(CHICKEN.name));
  db.close();
});

test('2. an inactive product does NOT appear in the customer catalog', () => {
  const db = seed();
  assert.ok(names(searchCatalog(db)).includes(RICE.name), 'visible while active');
  deactivateRice(db);
  const after = searchCatalog(db);
  assert.ok(!names(after).includes(RICE.name), 'hidden once inactive');
  assert.equal(after.total, 2, 'total reflects the exclusion, not just the page');
  // and it is still in the Product Master — never deleted
  assert.ok(getProduct(db, RICE.barcode), 'product still exists in the Product Master');
  db.close();
});

test('2b. an inactive product is excluded from search, filters and facets alike', () => {
  const db = seed();
  deactivateRice(db);
  assert.equal(searchCatalog(db, { search: 'GOLDEN' }).total, 0, 'not findable by search');
  assert.equal(searchCatalog(db, { search: RICE.barcode }).total, 0, 'not findable by barcode');
  assert.equal(searchCatalog(db, { availability: 'OUT_OF_STOCK' }).total, 0, 'not in the filter');
  assert.equal(catalogFacets(db).all, 2, 'not counted in facets');
  db.close();
});

// ===========================================================================
// 3-4. Images
// ===========================================================================
test('3. a product WITH an image exposes an image URL (no filename, no internal id)', () => {
  const db = seed();
  const storageDir = tmpDir();
  saveProductImage(db, getProduct(db, CHICKEN.barcode).id, JPEG, 'image/jpeg', { storageDir });

  const p = getCatalogProduct(db, CHICKEN.barcode);
  assert.ok(p.image, 'image present');
  assert.equal(p.image.url, `/api/catalog/products/${CHICKEN.barcode}/image`);
  assert.ok(!/\.jpg|\.png/.test(JSON.stringify(p)), 'storage filename never disclosed');
  assert.ok(!p.image.url.includes('/api/products/'), 'does not use the internal-id image route');
  db.close();
});

test('4. a product with NO image yields image: null so the UI shows the placeholder', () => {
  const db = seed();
  const p = getCatalogProduct(db, BEEF.barcode);
  assert.equal(p.image, null);
  db.close();
});

test('4b. the image endpoint serves the image by PUBLIC id and 404s when absent', async () => {
  const db = seed();
  config.productImagesDir = tmpDir();
  saveProductImage(db, getProduct(db, CHICKEN.barcode).id, JPEG, 'image/jpeg');

  const { server, base } = await startApp(db);
  try {
    const ok = await fetch(`${base}/api/catalog/products/${CHICKEN.barcode}/image`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/jpeg');

    const none = await fetch(`${base}/api/catalog/products/${BEEF.barcode}/image`);
    assert.equal(none.status, 404, 'no image = 404, not a server error');
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// 5-8. Search
// ===========================================================================
test('5. search by product name', () => {
  const db = seed();
  assert.deepEqual(names(searchCatalog(db, { search: 'GOLDEN RICE 1KG * 10' })), [RICE.name]);
  db.close();
});

test('6. partial-name search matches mid-word and across the catalog', () => {
  const db = seed();
  assert.equal(searchCatalog(db, { search: 'SOLEIL' }).total, 2, 'two Plein Soleil products');
  assert.deepEqual(names(searchCatalog(db, { search: 'CHICKEN' })), [CHICKEN.name]);
  assert.deepEqual(names(searchCatalog(db, { search: 'RICE' })), [RICE.name]);
  db.close();
});

test('7. barcode search — full and partial', () => {
  const db = seed();
  assert.deepEqual(names(searchCatalog(db, { search: '5283013330912' })), [CHICKEN.name]);
  assert.equal(searchCatalog(db, { search: '528301333' }).total, 3, 'shared barcode prefix');
  db.close();
});

test('8. search is case-insensitive in both directions', () => {
  const db = seed();
  for (const q of ['soleil', 'SOLEIL', 'SoLeIl', 'chicken stock', 'Chicken Stock']) {
    assert.ok(searchCatalog(db, { search: q }).total > 0, `"${q}" must match`);
  }
  assert.deepEqual(names(searchCatalog(db, { search: 'chicken stock' })), [CHICKEN.name]);
  db.close();
});

// ===========================================================================
// 9-11. Availability — three states, no quantities
// ===========================================================================
test('9. In Stock status is derived from the Product Master classification', () => {
  const db = seed();
  const p = getCatalogProduct(db, CHICKEN.barcode);
  assert.equal(p.availability.status, 'IN_STOCK');
  assert.equal(p.availability.label, 'In Stock');
  db.close();
});

test('10. Limited Stock status', () => {
  const db = seed();
  const p = getCatalogProduct(db, BEEF.barcode);
  assert.equal(p.availability.status, 'LIMITED_STOCK');
  assert.equal(p.availability.label, 'Limited Stock');
  db.close();
});

test('11. Out of Stock status', () => {
  const db = seed();
  const p = getCatalogProduct(db, RICE.barcode);
  assert.equal(p.availability.status, 'OUT_OF_STOCK');
  assert.equal(p.availability.label, 'Out of Stock');
  db.close();
});

test('11b. the customer classification MATCHES the Product Master classification exactly', () => {
  const db = seed();
  // same product, both sides: the catalog must not invent its own rule
  const master = searchProducts(db, { filter: 'active', limit: 1000 }).items;
  for (const m of master) {
    const c = getCatalogProduct(db, m.barcode);
    assert.equal(c.availability.status, m.stock_status,
      `${m.name}: catalog ${c.availability.status} vs master ${m.stock_status}`);
  }
  db.close();
});

test('11c. availability filters select exactly the matching products', () => {
  const db = seed();
  assert.deepEqual(names(searchCatalog(db, { availability: 'IN_STOCK' })), [CHICKEN.name]);
  assert.deepEqual(names(searchCatalog(db, { availability: 'LIMITED_STOCK' })), [BEEF.name]);
  assert.deepEqual(names(searchCatalog(db, { availability: 'OUT_OF_STOCK' })), [RICE.name]);
  const f = catalogFacets(db);
  assert.deepEqual(
    { all: f.all, in_stock: f.in_stock, limited: f.limited, out_of_stock: f.out_of_stock },
    { all: 3, in_stock: 1, limited: 1, out_of_stock: 1 },
  );
  db.close();
});

// ===========================================================================
// 12. Customer product detail
// ===========================================================================
test('12. customer product detail returns the customer-safe record over HTTP', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const res = await fetch(`${base}/api/catalog/products/${CHICKEN.barcode}`);
    assert.equal(res.status, 200);
    const p = await res.json();
    assert.equal(p.name, CHICKEN.name);
    assert.equal(p.barcode, CHICKEN.barcode);
    assert.equal(p.pack, 'CTN24');
    assert.equal(p.availability.label, 'In Stock');
    assert.equal(p.id, CHICKEN.barcode, 'public id is the barcode, not products.id');

    const missing = await fetch(`${base}/api/catalog/products/0000000000000`);
    assert.equal(missing.status, 404);
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// 13-16. SECURITY — the server must not emit internal data
// ===========================================================================

/** Every key appearing anywhere in a nested payload. */
function allKeys(value, acc = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { acc.add(k); allKeys(v, acc); }
  }
  return acc;
}

test('13. sensitive/internal fields are NOT present anywhere in a customer payload', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    for (const url of [
      `/api/catalog/products?search=SOLEIL`,
      `/api/catalog/products/${CHICKEN.barcode}`,
      `/api/catalog/facets`,
    ]) {
      const payload = await (await fetch(base + url)).json();
      const keys = allKeys(payload);
      for (const forbidden of FORBIDDEN_CUSTOMER_FIELDS) {
        assert.ok(!keys.has(forbidden), `${url} leaked key "${forbidden}"`);
      }
    }
  } finally { server.close(); }
  db.close();
});

test('13b. the serializer emits EXACTLY the declared customer-safe field set', () => {
  const db = seed();
  const p = getCatalogProduct(db, CHICKEN.barcode);
  assert.deepEqual(Object.keys(p).sort(), [...CUSTOMER_SAFE_FIELDS].sort(),
    'a new field reached customers without being added to CUSTOMER_SAFE_FIELDS');
  db.close();
});

test('13c. the serializer cannot pass through an unknown column added to products', () => {
  // simulates a future migration adding a sensitive column
  const leaked = toCatalogProduct({
    name: 'X', barcode: '1234567890123', box_uom: 'CTN1', free_to_use: 1,
    cost_price: 42.5, secret_margin: 0.3, id: 99,
  });
  assert.deepEqual(Object.keys(leaked).sort(), [...CUSTOMER_SAFE_FIELDS].sort());
  assert.ok(!JSON.stringify(leaked).includes('42.5'));
  assert.ok(!JSON.stringify(leaked).includes('secret_margin'));
});

test('13d. the public id is the barcode even when the row CARRIES products.id', () => {
  // The queries deliberately do not SELECT p.id, which masks a wrong publicId().
  // These assertions bite on the serializer directly, so the guarantee does not
  // depend on which columns a future query happens to select.
  const rowWithInternalId = { id: 99, name: 'X', barcode: '1234567890123', box_uom: 'CTN1', free_to_use: 1, primary_image_id: 7 };
  assert.equal(publicId(rowWithInternalId), '1234567890123');
  const dto = toCatalogProduct(rowWithInternalId);
  assert.equal(dto.id, '1234567890123');
  assert.notEqual(String(dto.id), '99');
  assert.ok(!JSON.stringify(dto).includes('99'), 'the internal id appears nowhere, image URL included');
  assert.equal(dto.image.url, '/api/catalog/products/1234567890123/image');
});

test('14. internal database IDs are NOT returned', async () => {
  const db = seed();
  const internalId = getProduct(db, CHICKEN.barcode).id;
  const { server, base } = await startApp(db);
  try {
    const detail = await (await fetch(`${base}/api/catalog/products/${CHICKEN.barcode}`)).json();
    assert.notEqual(detail.id, internalId, 'the public id is not products.id');
    assert.equal(detail.id, CHICKEN.barcode);
    const keys = allKeys(detail);
    assert.ok(!keys.has('product_id'));
    assert.ok(!keys.has('primary_image_id'));
    assert.ok(!keys.has('category_id'));
    // and the internal image route is never referenced
    assert.ok(!JSON.stringify(detail).includes('/api/products/'));
  } finally { server.close(); }
  db.close();
});

test('15. source Odoo ID is NOT returned, even when populated', async () => {
  const db = freshDb();
  runImport(db, [row({ ...CHICKEN, odooId: 'ODOO-SECRET-4242' })], { uploadsDir: tmpUploads() });
  assert.equal(getProduct(db, CHICKEN.barcode).source_odoo_id, 'ODOO-SECRET-4242', 'precondition');

  const { server, base } = await startApp(db);
  try {
    for (const url of [`/api/catalog/products`, `/api/catalog/products/${CHICKEN.barcode}`]) {
      const text = await (await fetch(base + url)).text();
      assert.ok(!text.includes('ODOO-SECRET-4242'), `${url} leaked the Odoo id`);
      assert.ok(!text.includes('source_odoo_id'), `${url} leaked the Odoo id field`);
    }
  } finally { server.close(); }
  db.close();
});

test('16. exact stock quantities are NOT returned in any form', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    for (const url of [`/api/catalog/products`, `/api/catalog/products/${CHICKEN.barcode}`]) {
      const text = await (await fetch(base + url)).text();
      // the distinctive seeded quantities must appear nowhere in the bytes
      for (const qty of ['777', '888', '999', '111', '222']) {
        assert.ok(!text.includes(qty), `${url} leaked the quantity ${qty}`);
      }
      for (const field of ['on_hand', 'free_to_use', 'incoming', 'outgoing', 'forecasted']) {
        assert.ok(!text.includes(field), `${url} leaked the field ${field}`);
      }
    }
  } finally { server.close(); }
  db.close();
});

test('16b. facets expose counts of products, never stock quantities', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const text = await (await fetch(`${base}/api/catalog/facets`)).text();
    for (const qty of ['777', '888', '999']) assert.ok(!text.includes(qty));
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// 17. Inactive products are unreachable through every customer entry point
// ===========================================================================
test('17. an inactive product cannot be retrieved through the customer catalog', async () => {
  const db = seed();
  config.productImagesDir = tmpDir();
  const riceId = getProduct(db, RICE.barcode).id;
  saveProductImage(db, riceId, JPEG, 'image/jpeg'); // it even has an image
  deactivateRice(db);

  assert.equal(getCatalogProduct(db, RICE.barcode), null, 'domain lookup returns null');

  const { server, base } = await startApp(db);
  try {
    const detail = await fetch(`${base}/api/catalog/products/${RICE.barcode}`);
    assert.equal(detail.status, 404, 'detail endpoint 404s');
    // the 404 must not reveal that a hidden product exists
    const body = await detail.json();
    assert.ok(!JSON.stringify(body).includes(RICE.name), '404 body must not name the hidden product');

    const img = await fetch(`${base}/api/catalog/products/${RICE.barcode}/image`);
    assert.equal(img.status, 404, 'image endpoint 404s for an inactive product');

    const list = await (await fetch(`${base}/api/catalog/products?search=GOLDEN`)).json();
    assert.equal(list.total, 0, 'absent from search results');
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// 18. The Product Master baseline is untouched
// ===========================================================================
test('18. existing Product Master functionality remains intact', async () => {
  const db = seed();
  config.productImagesDir = tmpDir();
  const pid = getProduct(db, CHICKEN.barcode).id;
  saveProductImage(db, pid, JPEG, 'image/jpeg');

  // the admin side still sees everything the catalog hides
  const master = searchProducts(db, { search: 'SOLEIL' });
  assert.equal(master.total, 2);
  const m = master.items.find((i) => i.barcode === CHICKEN.barcode);
  assert.equal(m.free_to_use, Q.IN, 'admin still sees exact stock');
  assert.equal(m.on_hand, 888);
  assert.equal(m.stock_status, 'IN_STOCK');

  const detail = getProductDetail(db, pid);
  assert.ok(detail.product.primary_image_id, 'admin detail still carries the image id');
  assert.ok(Array.isArray(detail.changeHistory), 'admin change history still present');

  const { server, base } = await startApp(db);
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/products?search=SOLEIL`)).status, 200);
    assert.equal((await fetch(`${base}/api/products/${pid}`)).status, 200);
    assert.equal((await fetch(`${base}/api/products/${pid}/image`)).status, 200,
      'the existing internal image route still works');
    assert.equal((await fetch(`${base}/api/imports`)).status, 200);
    assert.equal((await fetch(`${base}/api/reviews`)).status, 200);
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// Sorting, paging and page shell
// ===========================================================================
test('sorting is name A->Z / Z->A only, and never uses stock', () => {
  const db = seed();
  const asc = names(searchCatalog(db, { sort: 'name_asc' }));
  const desc = names(searchCatalog(db, { sort: 'name_desc' }));
  assert.deepEqual(asc, [...asc].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(desc, [...asc].reverse());
  // an unknown / injected sort falls back to the safe default
  assert.deepEqual(names(searchCatalog(db, { sort: 'free_to_use DESC' })), asc);
  db.close();
});

test('pagination caps the page size and reports an accurate total', () => {
  const db = seed();
  const page1 = searchCatalog(db, { limit: 2, offset: 0 });
  assert.equal(page1.items.length, 2);
  assert.equal(page1.total, 3, 'total counts all matches, not the page');
  const page2 = searchCatalog(db, { limit: 2, offset: 2 });
  assert.equal(page2.items.length, 1);
  assert.equal(searchCatalog(db, { limit: 10000 }).limit, 60, 'page size is capped');
  db.close();
});

test('the catalog pages are served at /catalog and /catalog/product/:id', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    for (const url of ['/catalog', `/catalog/product/${CHICKEN.barcode}`]) {
      const res = await fetch(base + url);
      assert.equal(res.status, 200, `${url} must serve the catalog shell`);
      const html = await res.text();
      assert.ok(html.includes('Digital Product Catalog'), `${url} returns the catalog page`);
      assert.ok(html.includes('/js/catalog.js'), `${url} loads assets by absolute path`);
    }
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// Available Now vs Full Catalogue
// ===========================================================================
test('Available Now shows active products with stock; Full Catalogue shows all active', () => {
  const db = seed();
  // CHICKEN 777 (in), BEEF 3 (limited), RICE 0 (out)
  const available = searchCatalog(db, { availableOnly: true });
  assert.equal(available.total, 2, 'the out-of-stock product is excluded');
  assert.ok(!names(available).includes(RICE.name));
  assert.ok(names(available).includes(BEEF.name), 'limited stock IS available now');

  const full = searchCatalog(db, { availableOnly: false });
  assert.equal(full.total, 3, 'full catalogue includes out-of-stock');
  assert.ok(names(full).includes(RICE.name));
  db.close();
});

test('Available Now never shows an INACTIVE product', () => {
  const db = seed();
  deactivateRice(db);
  assert.equal(searchCatalog(db, { availableOnly: true }).total, 2);
  assert.equal(searchCatalog(db, { availableOnly: false }).total, 2, 'inactive excluded from both views');
  db.close();
});

test('the view is selected over HTTP by ?view=, defaulting to Available Now', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const def = await (await fetch(`${base}/api/catalog/products`)).json();
    assert.equal(def.total, 2, 'default view is Available Now');
    const full = await (await fetch(`${base}/api/catalog/products?view=full`)).json();
    assert.equal(full.total, 3);
    const avail = await (await fetch(`${base}/api/catalog/products?view=available`)).json();
    assert.equal(avail.total, 2);
    const junk = await (await fetch(`${base}/api/catalog/products?view=../etc`)).json();
    assert.equal(junk.total, 2, 'an unrecognised view falls back to Available Now');
  } finally { server.close(); }
  db.close();
});

test('with_image filter returns only products that have one', () => {
  const db = seed();
  const storageDir = tmpDir();
  saveProductImage(db, getProduct(db, CHICKEN.barcode).id, JPEG, 'image/jpeg', { storageDir });
  assert.deepEqual(names(searchCatalog(db, { withImage: true })), [CHICKEN.name]);
  assert.equal(catalogFacets(db).with_image, 1);
  db.close();
});
