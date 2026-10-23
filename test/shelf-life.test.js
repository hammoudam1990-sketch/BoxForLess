// Customer minimum shelf life (W3) on a customer's request. Sample lots only — no Odoo.
//
// What is at risk: a customer with a 90-day minimum being sent stock with 25 days left WITHOUT
// agreeing to it, and that agreement not being recorded.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';
import {
  getMinShelfLifeDays, setMinShelfLifeDays, checkRequestLines, requireAcceptance, acceptancesFor,
  searchCustomersForShelfLife, ShelfLifeError, SHORT_DATED_CODE, MAX_MIN_SHELF_LIFE_DAYS,
} from '../src/domain/shelf-life.js';

beforeEach(() => resetAccessAttempts());

// Sample lots for these real barcodes (fixtures/expiry-sample.json):
//   5283001117266  one lot with ~25 days left (16 cartons) and one with ~200 days left (40 cartons)
//   5283001117303  one lot with ~85 days left (9 cartons) and nothing better
//   5283001117433  one lot with ~330 days left (70 cartons)
//   5290000000999  no lot data at all
const SPICE = '5283001117266';
const CORIANDER = '5283001117303';
const BAY = '5283001117433';
const NO_LOTS = '5290000000999';
const TODAY = '2026-10-21';
const check = (db, id, lines) => checkRequestLines(db, id, lines, { today: TODAY });
const line = (barcode, quantityCtn) => ({ barcode, quantityCtn });

function customer(db, name = 'Adom Supermarket', minDays = null) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  if (minDays) setMinShelfLifeDays(db, id, minDays);
  return id;
}

function stock(db, barcodes = [SPICE, CORIANDER, BAY, NO_LOTS]) {
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES (?,?,?,?,?)').run('t.xlsx', 'COMPLETED', ts, ts, ts);
  for (const b of barcodes) {
    db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)').run(b, `PRODUCT ${b}`, 'CTN12', 500, ts, ts);
  }
}

// ===========================================================================
// the setting
// ===========================================================================
test('1. a customer\'s minimum is stored, read back, changed and cleared', () => {
  const db = freshDb();
  const id = customer(db);
  assert.equal(getMinShelfLifeDays(db, id), null, 'no minimum by default');
  assert.deepEqual(setMinShelfLifeDays(db, id, 90), { id, minShelfLifeDays: 90 });
  assert.equal(getMinShelfLifeDays(db, id), 90);
  setMinShelfLifeDays(db, id, '120');
  assert.equal(getMinShelfLifeDays(db, id), 120, 'a number typed as text is accepted');
  setMinShelfLifeDays(db, id, '');
  assert.equal(getMinShelfLifeDays(db, id), null);
  setMinShelfLifeDays(db, id, 60);
  setMinShelfLifeDays(db, id, null);
  assert.equal(getMinShelfLifeDays(db, id), null);
});

test('2. a minimum must be a whole number of days within range; an unknown customer is a 404', () => {
  const db = freshDb();
  const id = customer(db);
  for (const bad of [0, -5, 1.5, 'abc', MAX_MIN_SHELF_LIFE_DAYS + 1, Infinity]) {
    assert.throws(() => setMinShelfLifeDays(db, id, bad), ShelfLifeError, String(bad));
  }
  assert.equal(getMinShelfLifeDays(db, id), null, 'nothing was stored');
  assert.throws(() => setMinShelfLifeDays(db, 9999, 90), (e) => e.status === 404);
  assert.doesNotThrow(() => setMinShelfLifeDays(db, id, MAX_MIN_SHELF_LIFE_DAYS));
});

test('3. staff can find a customer by name to set it', () => {
  const db = freshDb();
  const a = customer(db, 'Adom Supermarket', 90);
  customer(db, 'Akwaaba Mini Mart');
  assert.deepEqual(searchCustomersForShelfLife(db, 'adom').map((c) => [c.id, c.minShelfLifeDays]), [[a, 90]]);
  assert.equal(searchCustomersForShelfLife(db, 'a').length, 2);
  assert.equal(searchCustomersForShelfLife(db, 'ak').length, 1);
  assert.deepEqual(searchCustomersForShelfLife(db, '').map((c) => c.id), [a], 'with no search, only customers that have a minimum');
  assert.equal(searchCustomersForShelfLife(db, '%').length, 0, 'wildcards are not special');
});

// ===========================================================================
// the check
// ===========================================================================
test('4. a customer with no minimum is never warned', () => {
  const db = freshDb();
  const id = customer(db);
  assert.deepEqual(check(db, id, [line(CORIANDER, 5), line(SPICE, 30)]), { minDays: null, warnings: [] });
});

test('5. enough stock that meets the minimum: no warning', () => {
  const db = freshDb();
  const id = customer(db, 'A', 90);
  assert.deepEqual(check(db, id, [line(SPICE, 30)]).warnings, [], '40 cartons have ~200 days left');
  assert.deepEqual(check(db, id, [line(BAY, 70)]).warnings, []);
});

test('6. more than the long-dated stock can cover: the rest would come from short-dated stock, and is warned', () => {
  const db = freshDb();
  const id = customer(db, 'A', 90);
  const r = check(db, id, [line(SPICE, 50)]);                 // 40 meet 90 days; 10 more would be the ~25-day lot
  assert.equal(r.minDays, 90);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].barcode, SPICE);
  assert.equal(r.warnings[0].shortCartons, 10);
  assert.match(r.warnings[0].message, /^Available stock expires on \d{1,2} [A-Z][a-z]{2} \d{4}, below your 90-day minimum$/);
});

test('7. only stock below the minimum exists: the line is warned from the first carton', () => {
  const db = freshDb();
  const id = customer(db, 'A', 90);
  const r = check(db, id, [line(CORIANDER, 1)]);              // the only lot has ~85 days
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].shortCartons, 1);
  assert.deepEqual(check(db, customer(db, 'B', 60), [line(CORIANDER, 1)]).warnings, [], 'a 60-day customer is fine with 85 days');
});

test('8. a product with no lot data is not checked (nothing to say)', () => {
  const db = freshDb();
  const id = customer(db, 'A', 365);
  assert.deepEqual(check(db, id, [line(NO_LOTS, 5)]).warnings, []);
});

test('9. only the warned lines are returned, and nothing but a message and a date reaches the customer', () => {
  const db = freshDb();
  const id = customer(db, 'A', 90);
  const r = check(db, id, [line(BAY, 5), line(CORIANDER, 2), line(NO_LOTS, 1)]);
  assert.deepEqual(r.warnings.map((w) => w.barcode), [CORIANDER]);
});

test('10. clearance stock is not used to fill a customer\'s order', () => {
  const db = freshDb();
  const id = customer(db, 'A', 90);
  const loader = () => ({
    source: 'TEST',
    lots: [
      { barcode: 'X', lotName: 'GOOD', expiryDate: '2027-06-01', cartons: 3, location: 'MAIN' },
      { barcode: 'X', lotName: 'CLEAR', expiryDate: '2026-11-15', cartons: 500, location: 'CLEARANCE' },
    ],
  });
  const r = checkRequestLines(db, id, [line('X', 10)], { today: TODAY, loader });
  assert.deepEqual(r.warnings, [], 'the 500 clearance cartons are ignored; there is simply not enough long-dated stock');
});

// ===========================================================================
// acceptance
// ===========================================================================
test('11. a warned line must be accepted: unaccepted is refused with a message for that product', () => {
  const db = freshDb();
  const c = check(db, customer(db, 'A', 90), [line(CORIANDER, 2), line(SPICE, 50)]);
  assert.equal(c.warnings.length, 2);
  assert.throws(() => requireAcceptance(c, []), (e) => e.details.errors.length === 2
    && e.details.errors.every((x) => x.code === SHORT_DATED_CODE && /Tick the box to accept it, or remove this product/.test(x.message)));
  assert.throws(() => requireAcceptance(c, [CORIANDER]), (e) => e.details.errors.length === 1 && e.details.errors[0].barcode === SPICE);
  assert.throws(() => requireAcceptance(c, undefined), /shorter shelf life/);
  assert.throws(() => requireAcceptance(c, 'not an array'), /shorter shelf life/);
  assert.equal(requireAcceptance(c, [CORIANDER, SPICE]).length, 2);
  assert.equal(requireAcceptance({ warnings: [] }, []).length, 0, 'nothing to accept');
});

// ===========================================================================
// over HTTP: the customer's own session
// ===========================================================================
function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const post = (base, path, body, cookie) => fetch(base + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];
async function signIn(base, db, id) {
  const res = await post(base, '/api/catalog/access', { code: issueAccessCode(db, id) });
  assert.equal(res.status, 200);
  return cookieOf(res);
}

test('12. the shelf-check route needs a signed-in customer and answers for THAT customer only', async () => {
  const db = freshDb();
  stock(db);
  const strict = customer(db, 'Strict Shop', 90);
  const easy = customer(db, 'Easy Shop');
  const { server, base } = await startApp(db);
  try {
    assert.equal((await post(base, '/api/catalog/requests/shelf-check', { lines: [line(CORIANDER, 1)] })).status, 401, 'no session, no answer');

    const strictCookie = await signIn(base, db, strict);
    const r = await post(base, '/api/catalog/requests/shelf-check', { lines: [line(CORIANDER, 1)], customerId: easy, minDays: 1 }, strictCookie);
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.minDays, 90, 'identity and minimum come from the session, not the body');
    assert.deepEqual(Object.keys(body.warnings[0]).sort(), ['barcode', 'expiryDate', 'message'], 'no quantities, no lot names');

    const easyCookie = await signIn(base, db, easy);
    assert.deepEqual((await (await post(base, '/api/catalog/requests/shelf-check', { lines: [line(CORIANDER, 1)] }, easyCookie)).json()).warnings, []);
  } finally { server.close(); }
});

test('13. submitting without accepting is refused and writes nothing; accepting records it with the request', async () => {
  const db = freshDb();
  stock(db);
  const id = customer(db, 'Strict Shop', 90);
  const { server, base } = await startApp(db);
  try {
    let cookie = await signIn(base, db, id);
    const lines = [line(CORIANDER, 2), line(BAY, 3)];

    const refused = await post(base, '/api/catalog/requests', { lines }, cookie);
    const refusedBody = await refused.json();
    assert.equal(refused.status, 409);
    assert.deepEqual(refusedBody.errors.map((e) => [e.barcode, e.code]), [[CORIANDER, SHORT_DATED_CODE]]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0, 'nothing was saved');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM request_shelf_acceptances').get().n, 0);

    // ticking a barcode that was NOT warned changes nothing: the warned one is still missing
    const wrongTick = await post(base, '/api/catalog/requests', { lines, acceptedShortDated: [BAY] }, cookie);
    assert.equal(wrongTick.status, 409);

    const ok = await post(base, '/api/catalog/requests', { lines, acceptedShortDated: [CORIANDER] }, cookie);
    assert.equal(ok.status, 201);
    const rows = acceptancesFor(db, db.prepare('SELECT id FROM requests').get().id);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].barcode, rows[0].minDays, rows[0].shortCartons], [CORIANDER, 90, 2]);
    assert.match(rows[0].expiryDate, /^\d{4}-\d{2}-\d{2}$/);
  } finally { server.close(); }
});

test('14. a customer with no minimum submits exactly as before', async () => {
  const db = freshDb();
  stock(db);
  const id = customer(db, 'Easy Shop');
  const { server, base } = await startApp(db);
  try {
    const cookie = await signIn(base, db, id);
    const res = await post(base, '/api/catalog/requests', { lines: [line(CORIANDER, 2)] }, cookie);
    assert.equal(res.status, 201);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM request_shelf_acceptances').get().n, 0);
  } finally { server.close(); }
});

test('15. a request that fails validation leaves no acceptance behind', async () => {
  const db = freshDb();
  stock(db, [CORIANDER]);                                   // BAY is not in the catalogue: the line is refused
  const id = customer(db, 'Strict Shop', 90);
  const { server, base } = await startApp(db);
  try {
    const cookie = await signIn(base, db, id);
    const res = await post(base, '/api/catalog/requests', { lines: [line(CORIANDER, 1), line('NOT-A-PRODUCT', 1)], acceptedShortDated: [CORIANDER] }, cookie);
    assert.equal(res.status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM request_shelf_acceptances').get().n, 0, 'the acceptance is rolled back with the request');
  } finally { server.close(); }
});

test('16. staff set the minimum over HTTP; a bad value is a 400', async () => {
  const db = freshDb();
  const id = customer(db, 'Adom Supermarket');
  const { server, base } = await startApp(db);
  try {
    const put = (days) => fetch(`${base}/api/expiry/customers/${id}/min-shelf-life`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', origin: base }, body: JSON.stringify({ days }),
    });
    assert.equal((await put(90)).status, 200);
    assert.equal(getMinShelfLifeDays(db, id), 90);
    assert.equal((await put('soon')).status, 400);
    assert.equal(getMinShelfLifeDays(db, id), 90, 'unchanged');
    const found = await (await fetch(`${base}/api/expiry/customers?q=adom`)).json();
    assert.equal(found.customers[0].minShelfLifeDays, 90);
  } finally { server.close(); }
});

test('17. the minimum-shelf-life staff routes are staff-only', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  const db = freshDb();
  const id = customer(db, 'Adom Supermarket');
  const { server, base } = await startApp(db);
  try {
    for (const [method, url] of [['GET', '/api/expiry/customers?q=a'], ['PUT', `/api/expiry/customers/${id}/min-shelf-life`]]) {
      const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'PUT' ? '{"days":5}' : undefined });
      assert.ok([401, 403, 503].includes(res.status), `${method} ${url} -> ${res.status}`);
    }
    assert.equal(getMinShelfLifeDays(db, id), null);
  } finally {
    server.close();
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});
