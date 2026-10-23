// Credit check: available credit = limit − owed − open orders not yet invoiced; a request that would
// go over it is refused. Only the limit blocks — overdue invoices do not.
//
// What is at risk, in order:
//   1. Blocking a customer who is within their credit (or everyone, because of a gap in our data).
//   2. Letting a customer spend credit they do not have — including by sending two requests at once.
//   3. Telling a customer anything about anyone else's account.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import { submitRequest } from '../src/domain/requests.js';
import {
  createOrderForRequest, checkCredit, assertCredit, creditPosition, estimateValue, openOrdersValue, accountFor, CREDIT_LIMIT_EXCEEDED,
} from '../src/domain/orders.js';
import { setCreditLimit, sendQuotation, confirmOrder, validateDelivery, postInvoice, recordPayment, cancelOrder, ageInvoice, overview } from '../src/domain/sample-odoo.js';
import { cartonPriceFor } from '../src/domain/prices.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';

beforeEach(() => resetAccessAttempts());

const SPICE = '5283001117266';
const CLOVE = '5283001109209';
const priceA = (b) => cartonPriceFor(b, 'CLASS A (GHS)');

function stock(db) {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  for (const b of [SPICE, CLOVE]) {
    db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)').run(b, `PRODUCT ${b}`, 'CTN12', 5000, ts, ts);
  }
}
function customer(db, name, extra = {}) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries({ customer_type: 'CREDIT', pricelist: 'CLASS A (GHS)', ...extra })) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}
const lines = (n, barcode = SPICE) => [{ barcode, quantityCtn: n }];
/** Submit a request the way the route does (credit check included). */
function submit(db, customerId, ls) {
  return submitRequest(db, { lines: ls, customerId, onInsert: (rid) => { assertCredit(db, customerId, ls); createOrderForRequest(db, rid); } });
}
const orderId = (db, requestId) => db.prepare('SELECT id FROM odoo_orders WHERE request_id = ?').get(requestId).id;
const owe = (db, id, amount) => db.prepare('UPDATE odoo_customer_finance SET amount_owed = ? WHERE customer_id = ?').run(amount, id);
const counts = (db) => ({
  requests: db.prepare('SELECT COUNT(*) n FROM requests').get().n,
  orders: db.prepare('SELECT COUNT(*) n FROM odoo_orders').get().n,
  outbox: db.prepare('SELECT COUNT(*) n FROM odoo_outbox').get().n,
});

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
async function withApp(db, fn) {
  const { server, base } = await startApp(db);
  try { return await fn(base); } finally { server.close(); }
}
const send = (base, path, method = 'GET', body = null, cookie = null) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
async function signIn(base, db, id) {
  const res = await send(base, '/api/catalog/access', 'POST', { code: issueAccessCode(db, id) });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];
}

// ===========================================================================
// the sum
// ===========================================================================
test('1. the specification\'s example: limit 10,000, owed 6,000, an open order of 2,500 leaves 1,500, not 4,000', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  setCreditLimit(db, id, 10000);
  owe(db, id, 6000);
  const r = submit(db, id, lines(1));                       // an earlier request, still waiting
  db.prepare('UPDATE odoo_orders SET amount_open = 2500 WHERE request_id = ?').run(r.requestId);
  sendQuotation(db, orderId(db, r.requestId));              // waiting for approval
  assert.deepEqual(creditPosition(db, id), { limit: 10000, owed: 6000, open: 2500, available: 1500 });
  assert.equal(accountFor(db, id).availableCredit, 1500, 'the balance page shows the same figure');
  assert.equal(accountFor(db, id).openOrders, 2500);
  // 25 cartons ≈ GHS 1,396 fits; 28 ≈ 1,564 does not
  assert.equal(checkCredit(db, id, lines(25)).ok, true);
  const over = checkCredit(db, id, lines(28));
  assert.equal(over.ok, false);
  assert.equal(over.available, 1500);
  assert.match(over.message, /more than your available credit of GHS 1,500\.00/);
});

test('2. a request exactly equal to the available credit is allowed; a cent over is not', () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders Ltd');
  const v = estimateValue(db, id, lines(3));
  setCreditLimit(db, id, v);
  assert.equal(checkCredit(db, id, lines(3)).ok, true);
  setCreditLimit(db, id, Math.round((v - 0.01) * 100) / 100);
  assert.equal(checkCredit(db, id, lines(3)).ok, false);
});

test('3. a request is valued at the customer\'s own price class', () => {
  const db = freshDb();
  const a = customer(db, 'A Co', { pricelist: 'CLASS A (GHS)' });
  const d = customer(db, 'D Co', { pricelist: 'CLASS D (GHS)' });
  assert.equal(estimateValue(db, a, [{ barcode: SPICE, quantityCtn: 2 }, { barcode: CLOVE, quantityCtn: 1 }]), Math.round((priceA(SPICE) * 2 + priceA(CLOVE)) * 100) / 100);
  assert.ok(estimateValue(db, d, lines(2)) < estimateValue(db, a, lines(2)));
});

// ===========================================================================
// when there is nothing to check against, nobody is blocked
// ===========================================================================
test('4. a cash customer, a customer with no known limit, and a customer with no price class are never blocked', () => {
  const db = freshDb();
  const cash = customer(db, 'Ama', { customer_type: 'CASH', pricelist: 'CASH ACCOUNT (GHS)' });
  const noLimit = customer(db, 'No Limit Co');                       // no finance row at all
  const noClass = customer(db, 'No Class Co', { pricelist: null });
  setCreditLimit(db, noClass, 1);
  for (const id of [cash, noLimit, noClass]) {
    const r = checkCredit(db, id, lines(500));
    assert.deepEqual({ checked: r.checked, ok: r.ok }, { checked: false, ok: true });
    assert.doesNotThrow(() => assertCredit(db, id, lines(500)));
  }
  assert.equal(creditPosition(db, cash), null);
  const zero = customer(db, 'Zero Limit Co');
  setCreditLimit(db, zero, 0);
  assert.equal(checkCredit(db, zero, lines(1)).ok, false, 'a limit of 0 is a limit; only a MISSING limit is not checked');
  assert.match(checkCredit(db, zero, lines(1)).message, /no available credit/);
});

test('5. an overdue invoice does not block; only the limit does', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  setCreditLimit(db, id, 5000);
  const r = submit(db, id, lines(2));
  const oid = orderId(db, r.requestId);
  sendQuotation(db, oid); confirmOrder(db, oid); validateDelivery(db, oid); postInvoice(db, oid);
  ageInvoice(db, db.prepare('SELECT id FROM odoo_invoices').get().id);
  assert.ok(accountFor(db, id).overdue > 0);
  assert.equal(checkCredit(db, id, lines(1)).ok, true, 'overdue, but within the limit: allowed');
});

// ===========================================================================
// open orders count until invoiced
// ===========================================================================
test('6. an order counts while it is open, moves to "owed" when invoiced, and frees its credit when paid or cancelled', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  setCreditLimit(db, id, 10000);
  const v = estimateValue(db, id, lines(10));
  const r = submit(db, id, lines(10));
  const oid = orderId(db, r.requestId);
  assert.equal(openOrdersValue(db, id), v, 'received');
  sendQuotation(db, oid);   assert.equal(openOrdersValue(db, id), v, 'waiting for approval');
  confirmOrder(db, oid);    assert.equal(openOrdersValue(db, id), v, 'approved');
  validateDelivery(db, oid); assert.equal(openOrdersValue(db, id), v, 'dispatched');
  assert.equal(creditPosition(db, id).available, 10000 - v);
  postInvoice(db, oid);
  assert.equal(openOrdersValue(db, id), 0, 'invoiced: no longer an open order…');
  assert.equal(creditPosition(db, id).owed, v, '…it is owed instead');
  assert.equal(creditPosition(db, id).available, 10000 - v, 'so the available credit does not jump');
  recordPayment(db, oid);
  assert.equal(creditPosition(db, id).available, 10000, 'paid: the credit is back');

  const r2 = submit(db, id, lines(10));
  assert.equal(creditPosition(db, id).available, 10000 - v);
  const oid2 = orderId(db, r2.requestId);
  sendQuotation(db, oid2);
  cancelOrder(db, oid2);
  assert.equal(creditPosition(db, id).available, 10000, 'cancelled: the credit is back');
});

test('7. only this customer\'s own open orders count against them', () => {
  const db = freshDb(); stock(db);
  const a = customer(db, 'A Co'); const b = customer(db, 'B Co');
  setCreditLimit(db, a, 10000); setCreditLimit(db, b, 10000);
  submit(db, a, lines(20));
  assert.equal(openOrdersValue(db, b), 0);
  assert.equal(creditPosition(db, b).available, 10000);
});

// ===========================================================================
// submitting
// ===========================================================================
test('8. a refused request leaves nothing behind: no request, no order, no quotation queued', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  setCreditLimit(db, id, 100);
  assert.throws(() => submit(db, id, lines(10)), (e) => e.status === 409
    && e.details.errors.length === 1 && e.details.errors[0].code === CREDIT_LIMIT_EXCEEDED && /available credit/.test(e.details.errors[0].message));
  assert.deepEqual(counts(db), { requests: 0, orders: 0, outbox: 0 });
});

test('9. two requests cannot spend the same credit: the second is refused', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  const v = estimateValue(db, id, lines(10));
  setCreditLimit(db, id, Math.round(v * 1.5 * 100) / 100);        // room for one, not two
  submit(db, id, lines(10));
  assert.throws(() => submit(db, id, lines(10)), /credit/i);
  assert.equal(counts(db).requests, 1);
});

test('10. the route refuses with a message that quotes only the customer\'s own figures', async () => {
  const db = freshDb(); stock(db);
  const a = customer(db, 'Class A Co');
  const b = customer(db, 'Rich Co');
  setCreditLimit(db, a, 100);
  setCreditLimit(db, b, 99999);
  owe(db, b, 12345.67);
  await withApp(db, async (base) => {
    const cookie = await signIn(base, db, a);
    const dry = await (await send(base, '/api/catalog/requests/credit-check', 'POST', { lines: lines(10) }, cookie)).json();
    assert.deepEqual(Object.keys(dry).sort(), ['checked', 'message', 'ok']);
    assert.equal(dry.ok, false);
    assert.match(dry.message, /available credit of GHS 100\.00/);

    const res = await send(base, '/api/catalog/requests', 'POST', { lines: lines(10) }, cookie);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.errors[0].code, CREDIT_LIMIT_EXCEEDED);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('12345') && !text.includes('99999') && !text.includes('Rich Co'), 'nothing about anyone else');
    assert.deepEqual(counts(db), { requests: 0, orders: 0, outbox: 0 });

    // a smaller request is fine and goes through
    const small = await send(base, '/api/catalog/requests', 'POST', { lines: lines(1) }, cookie);
    assert.equal(small.status, 201);
  });
});

test('11. the dry run needs a signed-in customer, and says nothing when there is nothing to check', async () => {
  const db = freshDb(); stock(db);
  const cash = customer(db, 'Ama', { customer_type: 'CASH', pricelist: 'CASH ACCOUNT (GHS)' });
  await withApp(db, async (base) => {
    assert.equal((await send(base, '/api/catalog/requests/credit-check', 'POST', { lines: lines(1) })).status, 401);
    const cookie = await signIn(base, db, cash);
    const r = await (await send(base, '/api/catalog/requests/credit-check', 'POST', { lines: lines(500) }, cookie)).json();
    assert.deepEqual(r, { checked: false, ok: true, message: null });
  });
});

test('12. the Sample Odoo screen lists a credit customer with an order, so a limit can be set before the first invoice', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  assert.equal(overview(db).finance.length, 0);
  const r = submit(db, id, lines(2));
  let row = overview(db).finance.find((f) => f.customerId === id);
  assert.ok(row, 'listed once they have an order');
  assert.equal(row.creditLimit, null);
  assert.equal(row.available, null);
  setCreditLimit(db, id, 5000);
  row = overview(db).finance.find((f) => f.customerId === id);
  assert.equal(row.creditLimit, 5000);
  assert.equal(row.openOrders, estimateValue(db, id, lines(2)));
  assert.equal(row.available, Math.round((5000 - row.openOrders) * 100) / 100);
  assert.ok(r.requestId);
});
