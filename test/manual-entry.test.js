// Manual barcode entry — the scanner's fallback for a label the camera can't read.
//
// The feature performs no lookup of its own: it hands the typed value to the same
// onDetected() path a camera scan uses. So these tests cover the two things that
// are genuinely new — how typed input is prepared, and that the shared lookup
// behaves correctly for typed values — plus the guarantee that looking something
// up never changes anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { freshDb, runImport, row, getProduct, tmpUploads } from './helpers.js';
import { prepareManualBarcode, pickExactProduct, normalizeBarcode } from '../src/public/js/scan-core.js';
import { createApp } from '../src/server/index.js';

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

const CHICKEN = { barcode: '6281003101428', name: 'PLEIN SOLEIL CHICKEN STOCK 20G * 24', uom: 'CTN24', free: 10 };
const LEADING_ZERO = { barcode: '0001234567895', name: 'LEADING ZERO PRODUCT', uom: 'CTN12', free: 4 };
const SPACED = { barcode: 'SIP CAKE 47*60*11', name: 'SIP GOURMET CAKE BOX 3', uom: 'CTN1', free: 2 };
const ALL = [CHICKEN, LEADING_ZERO, SPACED];

function seed() {
  const db = freshDb();
  runImport(db, ALL.map(row), { uploadsDir: tmpUploads() });
  return db;
}

/** The exact lookup the scan page performs, over HTTP. */
async function lookup(base, code) {
  const res = await fetch(`${base}/api/products?search=${encodeURIComponent(code)}&limit=10`);
  const data = await res.json();
  return pickExactProduct(data.items, code);
}

/** Fingerprint every product row, to prove a lookup mutates nothing. */
function fingerprint(db) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all()))
    .digest('hex');
}

// ===========================================================================
// Input preparation
// ===========================================================================
test('1 & 3. a typed barcode is accepted and leading zeros are preserved', () => {
  assert.deepEqual(prepareManualBarcode('6281003101428'), { ok: true, code: '6281003101428', error: null });
  assert.equal(prepareManualBarcode('0001234567895').code, '0001234567895', 'leading zeros intact');
  assert.equal(prepareManualBarcode('  0001234567895  ').code, '0001234567895', 'zeros survive trimming too');
  assert.equal(prepareManualBarcode('00').code, '00', 'an all-zero value is not collapsed');
});

test('2. leading and trailing whitespace is trimmed', () => {
  for (const raw of ['  6281003101428', '6281003101428  ', '\t 6281003101428 \n', '​6281003101428﻿']) {
    assert.equal(prepareManualBarcode(raw).code, '6281003101428', `"${raw}" should normalise`);
  }
});

test('internal characters are PRESERVED — real barcodes contain spaces and symbols', () => {
  // normalizeBarcode() squashes all whitespace, which is right for a scanned 1D
  // code but would make these products untypeable. The manual path must not.
  assert.equal(prepareManualBarcode('  SIP CAKE 47*60*11  ').code, 'SIP CAKE 47*60*11');
  assert.equal(normalizeBarcode('SIP CAKE 47*60*11'), 'SIPCAKE47*60*11',
    'scanned-path behaviour unchanged — documents WHY manual entry needs its own helper');
});

test('6. an empty or whitespace-only barcode is rejected', () => {
  for (const raw of ['', '   ', '\t\n', null, undefined, '​']) {
    const r = prepareManualBarcode(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} must be rejected`);
    assert.match(r.error, /enter a barcode/i);
  }
});

test('an absurdly long value is rejected rather than sent to the server', () => {
  const r = prepareManualBarcode('9'.repeat(65));
  assert.equal(r.ok, false);
  assert.match(r.error, /too long/i);
  assert.equal(prepareManualBarcode('9'.repeat(64)).ok, true, '64 is still fine');
});

// ===========================================================================
// Lookup behaviour — the shared server path
// ===========================================================================
test('1. a valid typed barcode returns the correct product', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const p = await lookup(base, prepareManualBarcode(' 6281003101428 ').code);
    assert.ok(p, 'product found');
    assert.equal(p.barcode, CHICKEN.barcode);
    assert.equal(p.name, CHICKEN.name);
    assert.equal(p.box_uom, 'CTN24');
    assert.equal(p.stock_status, 'IN_STOCK', 'same enriched record the scanner shows');
  } finally { server.close(); }
  db.close();
});

test('3. a leading-zero barcode resolves to the right product', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const p = await lookup(base, prepareManualBarcode('0001234567895').code);
    assert.ok(p, 'found despite leading zeros');
    assert.equal(p.barcode, '0001234567895');
    assert.equal(p.name, LEADING_ZERO.name);
    // the dangerous failure: zeros stripped somewhere, matching a different code
    assert.equal(await lookup(base, '1234567895'), null, 'the zero-stripped form must NOT match');
  } finally { server.close(); }
  db.close();
});

test('a barcode containing spaces is findable by typing', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const p = await lookup(base, prepareManualBarcode('  SIP CAKE 47*60*11 ').code);
    assert.ok(p, 'spaced barcode found');
    assert.equal(p.name, SPACED.name);
  } finally { server.close(); }
  db.close();
});

test('4. an unknown barcode returns a controlled not-found, never a product', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    for (const unknown of ['0000000000000', '9999999999999', 'NOPE']) {
      assert.equal(await lookup(base, unknown), null, `${unknown} must not resolve`);
    }
    // and the endpoint answers cleanly rather than erroring
    const res = await fetch(`${base}/api/products?search=0000000000000&limit=10`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).items.length, 0);
  } finally { server.close(); }
  db.close();
});

test('5. a partial or fuzzy barcode does NOT return a product', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    // the server search is a substring match, so these DO come back as candidates…
    const partial = await (await fetch(`${base}/api/products?search=628100310&limit=10`)).json();
    assert.ok(partial.items.length > 0, 'substring search finds candidates');
    // …but the exact-match gate is what decides, and it refuses every one of them
    for (const near of ['628100310', '6281003101', '628100310142', '62810031014289', '6281003101427']) {
      assert.equal(pickExactProduct(partial.items, near), null, `${near} must not be accepted`);
    }
    // only the exact value passes
    assert.ok(pickExactProduct(partial.items, '6281003101428'));
  } finally { server.close(); }
  db.close();
});

test('5b. a name fragment never resolves as a barcode', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const hits = await (await fetch(`${base}/api/products?search=CHICKEN&limit=10`)).json();
    assert.ok(hits.items.length > 0, 'name search works for the search box');
    assert.equal(pickExactProduct(hits.items, 'CHICKEN'), null, 'but it is not a barcode match');
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// Safety
// ===========================================================================
test('7. a manual lookup does not modify the database', async () => {
  const db = seed();
  const before = fingerprint(db);
  const counts = {
    products: db.prepare('SELECT COUNT(*) n FROM products').get().n,
    changes: db.prepare('SELECT COUNT(*) n FROM import_changes').get().n,
  };
  const { server, base } = await startApp(db);
  try {
    await lookup(base, '6281003101428');   // found
    await lookup(base, '0000000000000');   // not found — must not create anything
    await lookup(base, 'NOPE');
  } finally { server.close(); }
  assert.equal(fingerprint(db), before, 'no product row changed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, counts.products, 'no product created');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_changes').get().n, counts.changes, 'no change logged');
  db.close();
});

test('6b. an unknown barcode does not create a product (explicit)', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    await lookup(base, '7777777777777');
    assert.equal(getProduct(db, '7777777777777'), undefined, 'nothing was created');
  } finally { server.close(); }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, ALL.length);
  db.close();
});

test('7b. the lookup endpoint rejects mutation attempts', async () => {
  const db = seed();
  const before = fingerprint(db);
  const { server, base } = await startApp(db);
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/products?search=6281003101428`, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ barcode: 'HACKED' }),
      });
      assert.ok(res.status >= 400, `${method} must not be accepted (got ${res.status})`);
    }
  } finally { server.close(); }
  assert.equal(fingerprint(db), before, 'database untouched');
  db.close();
});

test('8. the lookup exposes no customer, pricing or cost data', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const text = await (await fetch(`${base}/api/products?search=6281003101428&limit=10`)).text();
    for (const forbidden of ['price', 'cost', 'margin', 'pricelist', 'customer', 'odoo_customer_ref']) {
      assert.ok(!text.toLowerCase().includes(forbidden), `lookup leaked "${forbidden}"`);
    }
  } finally { server.close(); }
  db.close();
});

test('the manual path reuses the scanner lookup — same product, same shape', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    // camera path: value arrives already scanned
    const scanned = await lookup(base, normalizeBarcode('6281003101428'));
    // manual path: value arrives typed, with stray spaces
    const typed = await lookup(base, prepareManualBarcode('  6281003101428  ').code);
    assert.deepEqual(typed, scanned, 'identical record — one lookup implementation, not two');
  } finally { server.close(); }
  db.close();
});
