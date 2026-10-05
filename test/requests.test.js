// Stage 3 — customer request cart & submission (CTN only).
//
// The two things that can go wrong here: a customer gets a quantity the business
// cannot supply, or internal data leaks through the request flow. Everything below
// aims at those.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb, runImport, row, getProduct, tmpUploads } from './helpers.js';
import { wholeCartons, isFresh, ManualImportStockSource } from '../src/domain/stock-source.js';
import {
  validateRequest, submitRequest, isValidQuantity, nextReference,
  RejectionCode, RequestValidationError, listRequests, getRequest,
} from '../src/domain/requests.js';
import {
  importCustomers, searchCustomers, mapCustomerHeaders, normalizeCustomer,
  customerHandle, resolveCustomerHandle,
  CustomerImportError, CUSTOMER_FORBIDDEN_COLUMNS,
} from '../src/domain/customers.js';
import { computeStockStatus } from '../src/domain/stock.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const post = (base, path, body, cookie = null) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});

/**
 * Identify as a customer with their access code, returning the session cookie.
 * Submitting requires one now: the server reads WHO is requesting from this
 * signed session rather than from anything the browser sends.
 */
async function asCustomer(base, db, customerId) {
  const code = issueAccessCode(db, customerId);
  const res = await post(base, '/api/catalog/access', { code });
  assert.equal(res.status, 200, 'the access code should be accepted');
  return (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];
}

/** Create a bare customer and return its id — for tests that just need someone. */
function someCustomer(db, name = 'Test Customer Ltd') {
  const ts = new Date().toISOString();
  return Number(db.prepare(
    'INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)'
  ).run(name, ts, ts).lastInsertRowid);
}

// free = whole cartons available unless stated; FRACTIONAL mirrors the 40 real
// products that are "Limited Stock" but hold less than one complete carton.
const PLENTY = { barcode: '5283013330912', name: 'PLEIN SOLEIL CHICKEN STOCK', uom: 'CTN24', free: 10 };
const THREE = { barcode: '5283013330929', name: 'THREE CHEFS FETA', uom: 'CTN12', free: 3 };
const FRACTIONAL = { barcode: '5283013330936', name: 'ABIDO BAY LEAVES', uom: 'CTN50', free: 0.46 };
const PARTIAL = { barcode: '5283013330943', name: 'AL-AMIR ORANGE WATER', uom: 'CTN24', free: 8.46 };
const OUT = { barcode: '5283013330950', name: 'GOLDEN RICE', uom: 'CTN10', free: 0 };
const ALL = [PLENTY, THREE, FRACTIONAL, PARTIAL, OUT];

function seed(rows = ALL) {
  const db = freshDb();
  runImport(db, rows.map(row), { uploadsDir: tmpUploads() });
  return db;
}
/** Push the last import's completed_at into the past to simulate stale stock. */
function ageStockBy(db, hours) {
  const when = new Date(Date.now() - hours * 3_600_000).toISOString();
  db.prepare('UPDATE import_batches SET completed_at = ? WHERE completed_at IS NOT NULL').run(when);
}
const line = (p, q) => ({ barcode: p.barcode, quantityCtn: q });
const counts = (db) => ({
  requests: db.prepare('SELECT COUNT(*) n FROM requests').get().n,
  items: db.prepare('SELECT COUNT(*) n FROM request_items').get().n,
  customers: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
});

// ===========================================================================
// Carton arithmetic — floor, never round
// ===========================================================================
test('wholeCartons floors a decimal carton count and never rounds up', () => {
  assert.equal(wholeCartons(8.46), 8);
  assert.equal(wholeCartons(0.46), 0, 'less than one carton is zero, not one');
  assert.equal(wholeCartons(2.9), 2, 'floor, not round');
  assert.equal(wholeCartons(3), 3);
  assert.equal(wholeCartons(0), 0);
  assert.equal(wholeCartons(-5), 0);
  assert.equal(wholeCartons(null), 0);
  assert.equal(wholeCartons('abc'), 0);
});

test('a quantity must be a whole number of cartons, at least one', () => {
  for (const ok of [1, 2, 100]) assert.equal(isValidQuantity(ok), true, `${ok} valid`);
  for (const bad of [0, -1, 2.5, 0.5, NaN, null, undefined, 'two', '']) {
    assert.equal(isValidQuantity(bad), false, `${bad} invalid`);
  }
});

// ===========================================================================
// Requestability
// ===========================================================================
test('a sub-1-CTN product keeps its Limited Stock badge but cannot be requested', () => {
  const db = seed();
  const p = getProduct(db, FRACTIONAL.barcode);
  assert.equal(computeStockStatus(p), 'LIMITED_STOCK', 'badge unchanged — Stage 2 behaviour intact');

  const v = validateRequest(db, [line(FRACTIONAL, 1)]);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, RejectionCode.NOT_REQUESTABLE);
  db.close();
});

test('a partial-carton product is requestable up to its FLOORED carton count', () => {
  const db = seed();
  assert.equal(validateRequest(db, [line(PARTIAL, 8)]).ok, true, '8 of 8.46 allowed');
  const over = validateRequest(db, [line(PARTIAL, 9)]);
  assert.equal(over.ok, false);
  assert.equal(over.errors[0].code, RejectionCode.INSUFFICIENT_STOCK);
  db.close();
});

test('over-stock is rejected exactly at the boundary', () => {
  const db = seed();
  assert.equal(validateRequest(db, [line(THREE, 3)]).ok, true, 'exactly available is allowed');
  assert.equal(validateRequest(db, [line(THREE, 4)]).ok, false, 'one more is refused');
  db.close();
});

test('an out-of-stock product cannot be requested', () => {
  const db = seed();
  const v = validateRequest(db, [line(OUT, 1)]);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, RejectionCode.NOT_REQUESTABLE);
  db.close();
});

test('an inactive product cannot be requested', () => {
  const db = seed();
  runImport(db, [row(THREE)], { uploadsDir: tmpUploads() }); // others vanish -> inactive
  assert.equal(getProduct(db, PLENTY.barcode).is_active, 0, 'precondition');
  const v = validateRequest(db, [line(PLENTY, 1)]);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, RejectionCode.PRODUCT_UNAVAILABLE);
  assert.match(v.errors[0].message, new RegExp(PLENTY.name),
    'names the product, rather than quoting a barcode at the customer');
  db.close();
});

test('the inactive guard in validateRequest holds ON ITS OWN', () => {
  // Two layers independently exclude inactive products: the product lookup in
  // validateRequest, and the is_active filter inside getCtnAvailability. Each
  // masks a break in the other, so neither is really tested by the end-to-end
  // case. This stock source deliberately reports availability for EVERYTHING,
  // leaving validateRequest's own guard as the only thing standing.
  const db = seed();
  runImport(db, [row(THREE)], { uploadsDir: tmpUploads() }); // PLENTY -> inactive
  const pid = db.prepare('SELECT id FROM products WHERE barcode = ?').get(PLENTY.barcode).id;

  const permissiveSource = {
    getStockStatus: () => ({ asOf: new Date().toISOString(), hasData: true, fresh: true, source: 'test' }),
    getCtnAvailability: (_db, ids) => new Map(
      ids.map((id) => [id, { availableCtn: 99, raw: 99, name: 'X', barcode: PLENTY.barcode, boxUom: 'CTN24' }])
    ),
  };
  assert.ok(permissiveSource.getCtnAvailability(db, [pid]).has(pid), 'the stub really would allow it');

  const v = validateRequest(db, [line(PLENTY, 1)], { stockSource: permissiveSource });
  assert.equal(v.ok, false, 'an inactive product must still be refused');
  assert.equal(v.errors[0].code, RejectionCode.PRODUCT_UNAVAILABLE);
  db.close();
});

test('an unknown barcode is refused without pretending to know the product', () => {
  const db = seed();
  const v = validateRequest(db, [{ barcode: '0000000000000', quantityCtn: 1 }]);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, RejectionCode.PRODUCT_UNAVAILABLE);
  db.close();
});

test('every failing line is reported, not just the first', () => {
  const db = seed();
  const v = validateRequest(db, [line(PLENTY, 1), line(THREE, 99), line(OUT, 1)]);
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 2, 'both bad lines reported so the customer fixes them in one pass');
  db.close();
});

// ===========================================================================
// Freshness gate
// ===========================================================================
test('isFresh respects a configurable threshold', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const hoursAgo = (h) => new Date(now.getTime() - h * 3_600_000).toISOString();
  assert.equal(isFresh(hoursAgo(1), now, 24), true);
  assert.equal(isFresh(hoursAgo(23.9), now, 24), true);
  assert.equal(isFresh(hoursAgo(25), now, 24), false);
  assert.equal(isFresh(hoursAgo(25), now, 48), true, 'threshold is configurable, not hard-coded');
  assert.equal(isFresh(hoursAgo(2), now, 1), false);
  assert.equal(isFresh(null, now, 24), false, 'no data is not fresh');
  assert.equal(isFresh('not-a-date', now, 24), false);
});

test('fresh stock allows submission', () => {
  const db = seed();
  assert.equal(validateRequest(db, [line(PLENTY, 1)]).ok, true);
  db.close();
});

test('STALE stock blocks submission while browsing stays available', () => {
  const db = seed();
  ageStockBy(db, 48);
  const v = validateRequest(db, [line(PLENTY, 1)]);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, RejectionCode.STOCK_STALE);
  assert.match(v.errors[0].message, /refreshed/i);
  // browsing is untouched — the catalog still returns the product
  assert.ok(getProduct(db, PLENTY.barcode), 'product still browsable');
  db.close();
});

test('MISSING stock data blocks submission', () => {
  const db = seed();
  db.prepare('UPDATE import_batches SET completed_at = NULL').run();
  const v = validateRequest(db, [line(PLENTY, 1)]);
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, RejectionCode.STOCK_STALE);
  db.close();
});

test('the freshness threshold is honoured from config, not hard-coded', () => {
  const db = seed();
  ageStockBy(db, 10);
  const strict = new ManualImportStockSource({ freshnessHours: 5 });
  const lax = new ManualImportStockSource({ freshnessHours: 100 });
  assert.equal(validateRequest(db, [line(PLENTY, 1)], { stockSource: strict }).ok, false);
  assert.equal(validateRequest(db, [line(PLENTY, 1)], { stockSource: lax }).ok, true);
  db.close();
});

test('a stale-stock rejection happens BEFORE line checks and writes nothing', () => {
  const db = seed();
  ageStockBy(db, 48);
  const before = counts(db);
  assert.throws(
    () => submitRequest(db, { lines: [line(PLENTY, 1)], unlisted: { company: 'A', contact: 'B', phone: '0240000000' } }),
    (e) => e instanceof RequestValidationError && e.details.errors[0].code === RejectionCode.STOCK_STALE
  );
  assert.deepEqual(counts(db), before, 'nothing written');
  db.close();
});

// ===========================================================================
// Submission — atomicity and snapshots
// ===========================================================================
test('a valid submission persists the request with snapshots', () => {
  const db = seed();
  const res = submitRequest(db, {
    lines: [line(PLENTY, 2), line(THREE, 3)],
    unlisted: { company: 'Melcom Ltd', contact: 'Ama', phone: '0240000000' },
    notes: 'deliver Friday',
  });
  assert.match(res.reference, /^REQ-\d{4}-0001$/);
  assert.equal(res.lineCount, 2);

  const { request, items } = getRequest(db, res.requestId);
  assert.equal(request.status, 'SUBMITTED');
  assert.equal(request.needs_customer_match, 1, 'unlisted customer flagged for staff');
  assert.equal(request.unlisted_company, 'Melcom Ltd');
  assert.ok(request.stock_as_of, 'records which import it was validated against');

  const it = items.find((i) => i.barcode_at_request === PLENTY.barcode);
  assert.equal(it.quantity_ctn, 2);
  assert.equal(it.product_name_at_request, PLENTY.name, 'name snapshotted');
  assert.equal(it.box_uom_at_request, 'CTN24', 'pack reference snapshotted');
  assert.equal(it.available_ctn_at_request, 10, 'availability snapshotted');
  db.close();
});

test('ONE bad line rejects the WHOLE submission — nothing partially written', () => {
  const db = seed();
  const before = counts(db);
  assert.throws(
    () => submitRequest(db, {
      lines: [line(PLENTY, 1), line(THREE, 99)],   // second line impossible
      unlisted: { company: 'A', contact: 'B', phone: '0240000000' },
    }),
    (e) => e instanceof RequestValidationError
  );
  assert.deepEqual(counts(db), before, 'no request and no items written');
  db.close();
});

test('a failure after insert rolls the whole submission back', () => {
  const db = seed();
  const before = counts(db);
  assert.throws(() => submitRequest(db, {
    lines: [line(PLENTY, 1)],
    unlisted: { company: 'A', contact: 'B', phone: '0240000000' },
  }, { faultHook: () => { throw new Error('boom'); } }), /boom/);
  assert.deepEqual(counts(db), before, 'transaction rolled back');
  db.close();
});

test('a request must be attributable — anonymous submission is refused', () => {
  const db = seed();
  const before = counts(db);
  assert.throws(
    () => submitRequest(db, { lines: [line(PLENTY, 1)] }),
    (e) => e instanceof RequestValidationError && e.details.errors[0].code === RejectionCode.CUSTOMER_REQUIRED
  );
  // New Customer requires a NAME and a PHONE; company is optional
  assert.throws(() => submitRequest(db, { lines: [line(PLENTY, 1)], unlisted: { company: 'A', phone: '024' } }),
    (e) => e instanceof RequestValidationError, 'customer name is required');
  assert.throws(() => submitRequest(db, { lines: [line(PLENTY, 1)], unlisted: { contact: 'B' } }),
    (e) => e instanceof RequestValidationError, 'phone is required');
  assert.deepEqual(counts(db), before);
  db.close();
});

test('an unlisted customer never creates a customer master record', () => {
  const db = seed();
  submitRequest(db, { lines: [line(PLENTY, 1)], unlisted: { company: 'Brand New Co', contact: 'X', phone: '0240000000' } });
  assert.equal(counts(db).customers, 0, 'customer master untouched — staff reconcile instead');
  db.close();
});

test('references increment and stay unique', () => {
  const db = seed();
  const a = submitRequest(db, { lines: [line(PLENTY, 1)], unlisted: { company: 'A', contact: 'B', phone: '0240000000' } });
  const b = submitRequest(db, { lines: [line(PLENTY, 1)], unlisted: { company: 'A', contact: 'B', phone: '0240000000' } });
  assert.notEqual(a.reference, b.reference);
  assert.match(b.reference, /0002$/);
  assert.match(nextReference(db), /0003$/);
  db.close();
});

test('a request does NOT reserve stock — the same carton can be requested twice', () => {
  const db = seed();
  submitRequest(db, { lines: [line(THREE, 3)], unlisted: { company: 'A', contact: 'B', phone: '0240000000' } });
  // documented Stage 3 limitation: availability is unchanged by a request
  assert.equal(validateRequest(db, [line(THREE, 3)]).ok, true);
  assert.equal(getProduct(db, THREE.barcode).free_to_use, 3, 'stock untouched');
  db.close();
});

// ===========================================================================
// Customer master
// ===========================================================================
// Mirrors the real contact export's columns, plus the optional Customer ID.
const CUST_HEADERS = ['Customer ID', 'Avatar 128', 'Display Name', 'Email', 'Pricelist', 'Phone', 'Activities', 'Country', 'Stats'];
const custRow = (o) => ({
  'Customer ID': o.ref ?? null, 'Display Name': o.name, Email: o.email ?? null,
  Phone: o.phone ?? null, Country: o.country ?? null, Pricelist: 'CLASS A (GHS)',
  'Avatar 128': 'PD94bWwBLOB', Activities: 'something', Stats: '[{"label":"Opportunities"}]',
});
function importCusts(db, rows, opts) {
  const { mapping } = mapCustomerHeaders(CUST_HEADERS);
  return importCustomers(db, rows.map((r) => normalizeCustomer(custRow(r), mapping)), opts);
}

test('contact header mapping reads only the allow-listed columns', () => {
  const { mapping, ignored, hasStableId } = mapCustomerHeaders(CUST_HEADERS);
  assert.equal(mapping.odoo_customer_ref, 'Customer ID');
  assert.equal(mapping.name, 'Display Name');
  assert.equal(mapping.pricelist, 'Pricelist', 'imported for STAFF use (never customer-facing)');
  assert.equal(hasStableId, true);
  for (const bad of ['Avatar 128', 'Stats', 'Activities']) {
    assert.ok(ignored.includes(bad), `${bad} must be ignored`);
  }
});

test('avatar, stats and activities are NEVER imported; pricelist is staff-only', () => {
  const db = seed();
  importCusts(db, [{ ref: 'P1', name: 'Melcom Ltd', phone: '0240', country: 'Ghana' }]);
  const stored = db.prepare('SELECT * FROM customers').all();
  const text = JSON.stringify(stored);
  for (const forbidden of ['PD94bWwBLOB', 'Opportunities']) {
    assert.ok(!text.includes(forbidden), `leaked ${forbidden} into the customer master`);
  }
  // pricelist IS stored (approved 2026-10-03) — a price-TIER name for staff. The
  // customer-facing leak tests below prove it never reaches a browser.
  assert.equal(stored[0].pricelist, 'CLASS A (GHS)');
  const cols = db.prepare('PRAGMA table_info(customers)').all().map((c) => c.name.toLowerCase());
  for (const bad of CUSTOMER_FORBIDDEN_COLUMNS) {
    assert.ok(!cols.includes(bad), `customers table must not have a ${bad} column`);
  }
  db.close();
});

test('an export WITHOUT an Odoo Customer ID imports, and no id is invented', () => {
  // Approved 2026-10-03: this phase has no Odoo API and does not require an Odoo
  // id. Rows are keyed on display name; odoo_customer_ref stays NULL rather than
  // being fabricated, so real ids can be backfilled later.
  const db = seed();
  const { mapping } = mapCustomerHeaders(['Display Name', 'Phone']);
  const recs = [normalizeCustomer({ 'Display Name': 'Melcom Ltd', Phone: '0240' }, mapping)];
  const r = importCustomers(db, recs);
  assert.equal(r.created, 1);
  const c = db.prepare('SELECT * FROM customers').get();
  assert.equal(c.name, 'Melcom Ltd');
  assert.equal(c.odoo_customer_ref, null, 'no Odoo id invented');
  assert.equal(c.phone, '0240', 'phone stored as a string, never as identity');
  db.close();
});

test('a row with no name is still refused', () => {
  const db = seed();
  assert.throws(() => importCustomers(db, [{ name: null, phone: '024' }]),
    (e) => e instanceof CustomerImportError && /display name/i.test(e.message));
  assert.equal(counts(db).customers, 0);
  db.close();
});

test('stable id is BACKFILLED onto a name-matched customer and never overwritten', () => {
  const db = seed();
  importCusts(db, [{ name: 'Melcom Ltd' }], { requireStableId: false }); // pre-id record
  assert.equal(db.prepare('SELECT odoo_customer_ref FROM customers').get().odoo_customer_ref, null);

  const c1 = importCusts(db, [{ ref: 'RP-77', name: 'Melcom Ltd' }]);
  assert.equal(c1.created, 0, 'matched, not duplicated');
  assert.equal(c1.backfilled, 1);
  assert.equal(db.prepare('SELECT odoo_customer_ref FROM customers').get().odoo_customer_ref, 'RP-77');

  importCusts(db, [{ ref: 'RP-77', name: 'Melcom Limited' }]); // renamed in Odoo
  const after = db.prepare('SELECT * FROM customers').get();
  assert.equal(after.odoo_customer_ref, 'RP-77', 'identity survives a rename');
  assert.equal(after.name, 'Melcom Limited', 'display name follows Odoo');
  assert.equal(counts(db).customers, 1, 'rename did not create a second record');
  db.close();
});

test('re-importing identical customer data changes nothing (idempotent)', () => {
  const db = seed();
  importCusts(db, [{ ref: 'RP-1', name: 'Melcom Ltd', phone: '0240', country: 'Ghana' }]);
  const again = importCusts(db, [{ ref: 'RP-1', name: 'Melcom Ltd', phone: '0240', country: 'Ghana' }]);
  assert.deepEqual(
    { created: again.created, updated: again.updated, unchanged: again.unchanged, backfilled: again.backfilled },
    { created: 0, updated: 0, unchanged: 1, backfilled: 0 },
    're-import must be a true no-op; a backfill must not be re-counted on an id that is already set'
  );
  db.close();
});

test('a customer absent from the export goes inactive ONLY when asked, never deleted', () => {
  const db = seed();
  importCusts(db, [{ ref: 'A', name: 'Alpha' }, { ref: 'B', name: 'Beta' }]);

  // default: absence is NOT treated as deletion — a contact export is often a
  // filtered view, and a deactivated customer cannot be selected on a request
  const soft = importCusts(db, [{ ref: 'A', name: 'Alpha' }]);
  assert.equal(soft.deactivated, 0, 'left alone by default');
  assert.equal(db.prepare("SELECT is_active FROM customers WHERE odoo_customer_ref='B'").get().is_active, 1);

  const r = importCusts(db, [{ ref: 'A', name: 'Alpha' }], { deactivateMissing: true });
  assert.equal(r.deactivated, 1);
  assert.equal(counts(db).customers, 2, 'still present');
  assert.equal(db.prepare("SELECT is_active FROM customers WHERE odoo_customer_ref='B'").get().is_active, 0);
  db.close();
});

test('duplicate Customer IDs are refused', () => {
  const db = seed();
  assert.throws(() => importCusts(db, [{ ref: 'X', name: 'One' }, { ref: 'X', name: 'Two' }]),
    (e) => e instanceof CustomerImportError);
  db.close();
});

test('customer search needs a minimum query length and caps results', () => {
  const db = seed();
  importCusts(db, Array.from({ length: 40 }, (_, i) => ({ ref: `R${i}`, name: `Melcom Branch ${i}` })));
  assert.deepEqual(searchCustomers(db, 'Me').items, [], 'under the minimum returns nothing');
  assert.deepEqual(searchCustomers(db, '').items, [], 'blank cannot enumerate the list');
  const hits = searchCustomers(db, 'Melcom').items;
  assert.ok(hits.length > 0);
  assert.equal(hits.length, 20, 'capped');
  db.close();
});

test('customer search returns NAME + an OPAQUE handle — never the Odoo customer id', () => {
  const db = seed();
  importCusts(db, [{ ref: 'RP-9', name: 'Melcom Ltd', phone: '0540000000', country: 'Ghana' }]);
  const item = searchCustomers(db, 'Melcom').items[0];
  assert.deepEqual(Object.keys(item).sort(), ['handle', 'name']);
  const text = JSON.stringify(item);
  for (const bad of ['RP-9', '0540000000', 'Ghana', 'CLASS A', 'GHS']) {
    assert.ok(!text.includes(bad), `search leaked ${bad}`);
  }
  assert.ok(item.handle && item.handle.length >= 16, 'handle is substantial');
  db.close();
});

test('a handle resolves back to its customer, and a forged one does not', () => {
  const db = seed();
  importCusts(db, [{ ref: 'RP-9', name: 'Melcom Ltd' }, { ref: 'RP-10', name: 'Shoprite' }]);
  const { handle } = searchCustomers(db, 'Melcom').items[0];
  assert.equal(resolveCustomerHandle(db, handle).odoo_customer_ref, 'RP-9');
  assert.equal(resolveCustomerHandle(db, 'not-a-real-handle'), null);
  assert.equal(resolveCustomerHandle(db, 'RP-9'), null, 'the Odoo id itself is not a valid handle');
  assert.equal(resolveCustomerHandle(db, ''), null);
  // distinct customers get distinct handles
  assert.notEqual(customerHandle('RP-9'), customerHandle('RP-10'));
  // and the handle is stable, so a page reload keeps working
  assert.equal(customerHandle('RP-9'), customerHandle('RP-9'));
  db.close();
});

test('an inactive customer\'s handle stops resolving', () => {
  const db = seed();
  importCusts(db, [{ ref: 'RP-9', name: 'Melcom Ltd' }, { ref: 'RP-10', name: 'Other Co' }]);
  const h = customerHandle('RP-9');
  importCusts(db, [{ ref: 'RP-10', name: 'Other Co' }], { deactivateMissing: true }); // RP-9 deactivated
  assert.equal(resolveCustomerHandle(db, h), null);
  db.close();
});

test('an inactive customer is not findable', () => {
  const db = seed();
  importCusts(db, [{ ref: 'A', name: 'Alpha Co' }, { ref: 'B', name: 'Alpha Two' }]);
  importCusts(db, [{ ref: 'A', name: 'Alpha Co' }], { deactivateMissing: true }); // B deactivated
  assert.deepEqual(searchCustomers(db, 'Alpha').items.map((i) => i.name), ['Alpha Co']);
  db.close();
});

test('a request links to a selected customer by stable ref', () => {
  const db = seed();
  importCusts(db, [{ ref: 'RP-100', name: 'Melcom Ltd' }]);
  const res = submitRequest(db, { lines: [line(PLENTY, 1)], customerRef: 'RP-100' });
  const { request } = getRequest(db, res.requestId);
  assert.ok(request.customer_id);
  assert.equal(request.needs_customer_match, 0);
  assert.equal(request.odoo_customer_ref, 'RP-100');
  db.close();
});

test('an unknown customer ref is refused and writes nothing', () => {
  const db = seed();
  const before = counts(db);
  assert.throws(() => submitRequest(db, { lines: [line(PLENTY, 1)], customerRef: 'NOPE' }),
    (e) => e instanceof RequestValidationError);
  assert.deepEqual(counts(db), before);
  db.close();
});

// ===========================================================================
// HTTP — customer-facing data boundary
// ===========================================================================
test('the customer request API never returns stock figures or internal ids', async () => {
  const db = seed();
  importCusts(db, [{ ref: 'RP-1', name: 'Melcom Ltd', phone: '0540000000', country: 'Ghana' }]);
  const { server, base } = await startApp(db);
  try {
    const customer = db.prepare('SELECT id FROM customers WHERE name = ?').get('Melcom Ltd');
    const cookie = await asCustomer(base, db, customer.id);

    const texts = [];
    texts.push(await (await fetch(`${base}/api/catalog/requests/stock-status`)).text());
    texts.push(await (await fetch(`${base}/api/catalog/access`, { headers: { cookie } })).text());
    texts.push(await (await post(base, '/api/catalog/requests/validate', { lines: [{ barcode: THREE.barcode, quantityCtn: 99 }] })).text());
    const created = await post(base, '/api/catalog/requests', {
      lines: [{ barcode: PLENTY.barcode, quantityCtn: 1 }],
    }, cookie);
    assert.equal(created.status, 201, 'an identified customer can submit');
    texts.push(await created.text());

    for (const t of texts) {
      for (const bad of ['free_to_use', 'availableCtn', 'available_ctn', 'product_id', 'customer_id',
        'odoo_customer_ref', 'source_odoo_id', 'requestId', '0540000000', 'Ghana', 'CLASS A',
        '"RP-1"', 'RP-1"']) {
        assert.ok(!t.includes(bad), `customer API leaked "${bad}" in ${t.slice(0, 120)}`);
      }
      // the seeded availability figures must not appear either
      assert.ok(!/\b(10|8\.46|0\.46)\b/.test(t.replace(/REQ-\d{4}-\d{4}/g, '')) || !t.includes('available'),
        'no availability figure disclosed');
    }
  } finally { server.close(); }
  db.close();
});

test('an over-stock rejection returns 409 and discloses no number', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const cookie = await asCustomer(base, db, someCustomer(db));
    const before = counts(db);
    const res = await post(base, '/api/catalog/requests', {
      lines: [{ barcode: THREE.barcode, quantityCtn: 5 }],
    }, cookie);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.errors[0].code, RejectionCode.INSUFFICIENT_STOCK);
    assert.match(body.errors[0].message, /no longer available/i);
    assert.ok(!/\b3\b/.test(body.errors[0].message), 'must not reveal that 3 are available');
    assert.deepEqual(counts(db), before, 'nothing written');
  } finally { server.close(); }
  db.close();
});

test('the customer stock-status endpoint reveals the verdict but not the timestamp', async () => {
  const db = seed();
  const { server, base } = await startApp(db);
  try {
    const fresh = await (await fetch(`${base}/api/catalog/requests/stock-status`)).json();
    assert.equal(fresh.canSubmit, true);
    assert.deepEqual(Object.keys(fresh).sort(), ['canSubmit', 'message']);

    ageStockBy(db, 48);
    const stale = await (await fetch(`${base}/api/catalog/requests/stock-status`)).json();
    assert.equal(stale.canSubmit, false);
    assert.match(stale.message, /refreshed/i);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(JSON.stringify(stale)), 'no timestamp to the customer');
  } finally { server.close(); }
  db.close();
});

test('staff DO see the stock timestamp and the submitted requests', async () => {
  const db = seed();
  submitRequest(db, { lines: [line(PLENTY, 2)], unlisted: { company: 'Melcom', contact: 'Ama', phone: '0240000000' } });
  const { server, base } = await startApp(db);
  try {
    const status = await (await fetch(`${base}/api/requests/stock-status`)).json();
    assert.ok(status.asOf, 'staff see the last import timestamp');
    assert.equal(status.source, 'manual-import');

    const list = await (await fetch(`${base}/api/requests`)).json();
    assert.equal(list.total, 1);
    assert.equal(list.items[0].item_count, 1);
    assert.equal(list.items[0].needs_customer_match, 1);
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// Agreement with the approved Stage 2 banding
// ===========================================================================
test('the stock band and requestability never contradict each other', () => {
  const db = seed();
  for (const p of db.prepare('SELECT * FROM products WHERE is_active=1').all()) {
    const band = computeStockStatus(p);
    const requestable = wholeCartons(p.free_to_use) >= 1;
    if (band === 'OUT_OF_STOCK') assert.equal(requestable, false, `${p.name}: out of stock must not be requestable`);
    if (band === 'IN_STOCK') assert.equal(requestable, true, `${p.name}: in stock must be requestable`);
    // LIMITED_STOCK may be either — that is the documented sub-1-CTN case
  }
  db.close();
});

test('existing Product Master and catalog behaviour is unaffected', () => {
  const db = seed();
  const p = getProduct(db, PLENTY.barcode);
  assert.equal(p.free_to_use, 10, 'stock untouched by request code');
  assert.equal(listRequests(db).total, 0);
  db.close();
});
