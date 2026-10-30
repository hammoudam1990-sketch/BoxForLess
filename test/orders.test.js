// Sales Management slice 6: an order from "submit" to "paid", and the customer's account.
//
// What is at risk, in order:
//   1. One customer seeing another's orders, invoices or balance — or anyone seeing the shared cash account.
//   2. BFL doing Odoo's job (confirming, cancelling, invoicing) outside the stand-in, or sending a price.
//   3. A request saved without its order and queued quotation, or the reverse.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import { submitRequest } from '../src/domain/requests.js';
import { createOrderForRequest, listOrdersFor, accountFor, OrderState } from '../src/domain/orders.js';
import {
  sendQuotation, confirmOrder, validateDelivery, postInvoice, recordPayment, cancelOrder, ageInvoice,
  setCreditLimit, overview, SampleOdooError, SAMPLE_CREDIT_LIMIT,
} from '../src/domain/sample-odoo.js';
import { listPending, outboxSummary } from '../src/domain/outbox.js';
import { cartonPriceFor } from '../src/domain/prices.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';

beforeEach(() => resetAccessAttempts());

const SPICE = '5283001117266';
const CLOVE = '5283001109209';

function stock(db) {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  for (const b of [SPICE, CLOVE]) {
    db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)').run(b, `PRODUCT ${b}`, 'CTN12', 500, ts, ts);
  }
}
function customer(db, name, extra = {}) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries({ customer_type: 'CREDIT', pricelist: 'CLASS A (GHS)', ...extra })) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}
/** Submit a request the way the route does, so the order and quotation are created with it. */
function order(db, customerId, lines = [{ barcode: SPICE, quantityCtn: 2 }, { barcode: CLOVE, quantityCtn: 1 }], extra = {}) {
  const r = submitRequest(db, { lines, customerId, ...extra, onInsert: (id) => createOrderForRequest(db, id) });
  const orderId = db.prepare('SELECT id FROM odoo_orders WHERE request_id = ?').get(r.requestId).id;
  return { ...r, orderId };
}
const stateOf = (db, id) => db.prepare('SELECT state FROM odoo_orders WHERE id = ?').get(id).state;
/** Walk an order all the way to invoiced. */
function toInvoiced(db, id) {
  sendQuotation(db, id); confirmOrder(db, id); validateDelivery(db, id); return postInvoice(db, id);
}

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
async function withApp(db, fn) {
  const { server, base } = await startApp(db);
  try { return await fn(base); } finally { server.close(); }
}
const send = (base, path, method = 'GET', body = null, cookie = null) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];
async function signIn(base, db, id) {
  const res = await send(base, '/api/catalog/access', 'POST', { code: issueAccessCode(db, id) });
  assert.equal(res.status, 200);
  return cookieOf(res);
}

// ===========================================================================
// submitting
// ===========================================================================
test('1. submitting creates the order and queues a draft quotation with no price', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd', { odoo_customer_ref: '4321' });
  const { reference, orderId } = order(db, id, undefined, { notes: 'Gate B please', deliveryAddress: '12 Ring Road' });
  assert.equal(stateOf(db, orderId), OrderState.RECEIVED);
  const [q] = listPending(db);
  assert.equal(q.kind, 'DRAFT_QUOTATION');
  assert.equal(q.dedupeKey, `quotation:${reference}`);
  assert.equal(q.payload.model, 'sale.order');
  assert.equal(q.payload.state, 'draft');
  assert.equal(q.payload.values.client_order_ref, reference, 'BFL\'s reference travels in client_order_ref');
  assert.deepEqual(q.payload.values.partner, { odoo_ref: '4321', name: 'Kofi Traders Ltd' });
  assert.deepEqual(q.payload.values.lines.map((l) => [l.barcode, l.cartons]), [[SPICE, 2], [CLOVE, 1]]);
  assert.equal(q.payload.values.delivery_address, '12 Ring Road');
  assert.equal(q.payload.values.note, 'Gate B please');
  assert.ok(!/price|amount|total|discount/i.test(JSON.stringify(q.payload)), 'Odoo works the price out; BFL sends none');
  assert.ok(!/access_code/i.test(JSON.stringify(q.payload)));
});

test('2. a cash buyer goes on the shared cash account, with their own details in the note', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Ama Mensah', { customer_type: 'CASH', pricelist: 'CASH ACCOUNT (GHS)', phone: '0201777888' });
  order(db, id, undefined, { deliveryAddress: 'Osu, Accra' });
  const { values } = listPending(db)[0].payload;
  assert.deepEqual(values.partner, { account: 'CASH ACCOUNT', shared: true });
  assert.match(values.note, /Cash buyer: Ama Mensah/);
  assert.match(values.note, /Phone: 0201777888/);
  assert.match(values.note, /Deliver to: Osu, Accra/);
});

test('3. a request is never saved without its order and quotation, or the reverse', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  assert.throws(() => submitRequest(db, {
    lines: [{ barcode: SPICE, quantityCtn: 1 }], customerId: id, onInsert: (rid) => createOrderForRequest(db, rid),
  }, { faultHook: () => { throw new Error('boom'); } }), /boom/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM odoo_orders').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM odoo_outbox').get().n, 0);
});

// ===========================================================================
// Odoo's side of the journey (the stand-in)
// ===========================================================================
test('4. the journey: received, waiting for approval, approved, dispatched, invoiced, paid', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  const { orderId, reference } = order(db, id);

  assert.equal(listOrdersFor(db, id)[0].odooNumber, null, 'no Odoo number until Odoo has the quotation');
  sendQuotation(db, orderId);
  assert.equal(stateOf(db, orderId), 'WAITING_FOR_APPROVAL');
  assert.match(listOrdersFor(db, id)[0].odooNumber, /^S\d{5}$/);
  assert.equal(outboxSummary(db).SENT, 1);
  assert.equal(outboxSummary(db).PENDING, 0);

  confirmOrder(db, orderId);   assert.equal(stateOf(db, orderId), 'APPROVED');
  validateDelivery(db, orderId); assert.equal(stateOf(db, orderId), 'DISPATCHED');
  const inv = postInvoice(db, orderId);
  assert.equal(stateOf(db, orderId), 'INVOICED');
  assert.match(inv.number, /^INV\/\d{4}\/0001$/);
  recordPayment(db, orderId);
  const o = listOrdersFor(db, id)[0];
  assert.equal(o.status, 'PAID');
  assert.equal(o.reference, reference);
  assert.equal(o.step, 6);
});

test('5. the steps cannot be skipped or repeated, and a cancelled order stays on record', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  const { orderId } = order(db, id);
  for (const f of [confirmOrder, validateDelivery, postInvoice, recordPayment, cancelOrder]) {
    assert.throws(() => f(db, orderId), SampleOdooError, 'RECEIVED cannot jump ahead');
  }
  sendQuotation(db, orderId);
  assert.throws(() => sendQuotation(db, orderId), SampleOdooError, 'sent once only');
  cancelOrder(db, orderId);
  assert.equal(stateOf(db, orderId), 'CANCELLED');
  assert.throws(() => confirmOrder(db, orderId), SampleOdooError);
  assert.equal(listOrdersFor(db, id).length, 1, 'cancelled orders are kept, not deleted');
  assert.equal(listOrdersFor(db, id)[0].statusLabel, 'Cancelled');
});

test('6. an order that has left the warehouse can no longer be cancelled', () => {
  const db = freshDb(); stock(db);
  const { orderId } = order(db, customer(db, 'Kofi Traders Ltd'));
  sendQuotation(db, orderId); confirmOrder(db, orderId); validateDelivery(db, orderId);
  assert.throws(() => cancelOrder(db, orderId), SampleOdooError);
});

test('7. an invoice raises the balance; a payment lowers it; overdue is what is past due', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  const { orderId } = order(db, id);
  const expected = Math.round((cartonPriceFor(SPICE, 'CLASS A (GHS)') * 2 + cartonPriceFor(CLOVE, 'CLASS A (GHS)')) * 100) / 100;
  const inv = toInvoiced(db, orderId);
  assert.equal(inv.amount, expected, 'cartons x the customer\'s class price');

  let a = accountFor(db, id);
  assert.equal(a.type, 'CREDIT');
  assert.equal(a.creditLimit, SAMPLE_CREDIT_LIMIT);
  assert.equal(a.amountOwed, expected);
  assert.equal(a.overdue, 0);
  assert.equal(a.availableCredit, SAMPLE_CREDIT_LIMIT - expected);
  assert.equal(a.invoices[0].amountDue, expected);

  ageInvoice(db, db.prepare('SELECT id FROM odoo_invoices').get().id);
  a = accountFor(db, id);
  assert.equal(a.overdue, expected, 'past the due date');

  recordPayment(db, orderId);
  a = accountFor(db, id);
  assert.equal(a.amountOwed, 0);
  assert.equal(a.overdue, 0);
  assert.equal(a.invoices[0].status, 'PAID');
  assert.equal(a.payments[0].amount, expected);
});

test('8. the credit limit is set per customer, and only a credit customer has one', () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  const cash = customer(db, 'Ama Mensah', { customer_type: 'CASH' });
  setCreditLimit(db, id, 2500);
  assert.equal(accountFor(db, id).creditLimit, 2500);
  assert.throws(() => setCreditLimit(db, id, -1), SampleOdooError);
  assert.throws(() => setCreditLimit(db, id, 'lots'), SampleOdooError);
  assert.throws(() => setCreditLimit(db, cash, 100), /cash customer/);
});

// ===========================================================================
// what a customer can see
// ===========================================================================
test('9. a cash customer has no balance, and the shared account is never shown', () => {
  const db = freshDb(); stock(db);
  const cash = customer(db, 'Ama Mensah', { customer_type: 'CASH', pricelist: 'CASH ACCOUNT (GHS)' });
  const { orderId } = order(db, cash);
  toInvoiced(db, orderId);
  const a = accountFor(db, cash);
  assert.deepEqual(Object.keys(a).sort(), ['note', 'type']);
  assert.equal(a.type, 'CASH');
  assert.equal(listOrdersFor(db, cash).length, 1, 'they still see the orders they placed on BFL');
});

test('10. the orders route shows only my orders, in the safe shape, and needs a session', async () => {
  const db = freshDb(); stock(db);
  const a = customer(db, 'Class A Co');
  const b = customer(db, 'Other Co');
  const mine = order(db, a);
  order(db, b);
  sendQuotation(db, mine.orderId);
  await withApp(db, async (base) => {
    assert.equal((await send(base, '/api/catalog/orders')).status, 401);
    assert.equal((await send(base, '/api/catalog/account')).status, 401);
    const cookie = await signIn(base, db, a);
    const res = await send(base, `/api/catalog/orders?customer=${b}&customerId=${b}`, 'GET', null, cookie);
    const body = await res.json();
    assert.equal(body.orders.length, 1);
    assert.equal(body.orders[0].reference, mine.reference);
    assert.deepEqual(Object.keys(body.orders[0]).sort(),
      ['hint', 'items', 'odooNumber', 'paymentDue', 'placedAt', 'reference', 'status', 'statusLabel', 'step', 'steps', 'total', 'updatedAt']);
    const text = JSON.stringify(body);
    assert.ok(!text.includes('Other Co'), 'nothing about another customer');
    assert.equal(body.orders[0].total, null, 'no price before Odoo invoices it');
    assert.ok(!/customer_id|request_id|"id"|pricelist|CLASS/.test(text), 'no internal ids or price class');
  });
});

test('11. the account route returns my figures only; another customer\'s invoices never appear', async () => {
  const db = freshDb(); stock(db);
  const a = customer(db, 'Class A Co');
  const b = customer(db, 'Other Co');
  const mine = order(db, a);
  const theirs = order(db, b);
  toInvoiced(db, mine.orderId);
  const theirInvoice = toInvoiced(db, theirs.orderId);
  await withApp(db, async (base) => {
    const cookie = await signIn(base, db, a);
    const body = await (await send(base, '/api/catalog/account', 'GET', null, cookie)).json();
    assert.equal(body.type, 'CREDIT');
    assert.equal(body.source, 'SAMPLE');
    assert.equal(body.invoices.length, 1);
    assert.ok(!JSON.stringify(body).includes(theirInvoice.number));
    assert.ok(!/customer_id|pricelist|CLASS|"id"/.test(JSON.stringify(body)));
  });
});

test('12. submitting through the route creates the order, and the response gives nothing away', async () => {
  const db = freshDb(); stock(db);
  const id = customer(db, 'Kofi Traders Ltd');
  await withApp(db, async (base) => {
    const cookie = await signIn(base, db, id);
    const res = await send(base, '/api/catalog/requests', 'POST', { lines: [{ barcode: SPICE, quantityCtn: 3 }] }, cookie);
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['items', 'reference', 'submitted']);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM odoo_orders').get().n, 1);
    assert.equal(listPending(db)[0].payload.values.lines[0].cartons, 3);
  });
});

// ===========================================================================
// the stand-in is staff-only and switches itself off
// ===========================================================================
test('13. the Sample Odoo routes are staff-only', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const db = freshDb(); stock(db);
    const { orderId } = order(db, customer(db, 'Kofi Traders Ltd'));
    await withApp(db, async (base) => {
      for (const [method, url] of [['GET', '/api/sample-odoo'], ['POST', `/api/sample-odoo/orders/${orderId}/send`], ['PUT', '/api/sample-odoo/customers/1/credit-limit']]) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
        assert.ok([401, 403, 503].includes(res.status), `${method} ${url} -> ${res.status}`);
      }
    });
    assert.equal(stateOf(db, orderId), 'RECEIVED', 'a refused call changes nothing');
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('14. the stand-in drives an order through the staff API, and stops once Odoo is connected', async () => {
  const db = freshDb(); stock(db);
  const { orderId } = order(db, customer(db, 'Kofi Traders Ltd'));
  await withApp(db, async (base) => {
    for (const step of ['send', 'confirm', 'deliver', 'invoice', 'pay']) {
      const res = await send(base, `/api/sample-odoo/orders/${orderId}/${step}`, 'POST', {});
      assert.equal(res.status, 200, step);
    }
    assert.equal((await send(base, `/api/sample-odoo/orders/${orderId}/pay`, 'POST', {})).status, 409);
    assert.equal((await send(base, `/api/sample-odoo/orders/${orderId}/nonsense`, 'POST', {})).status, 404);
    const view = await (await send(base, '/api/sample-odoo')).json();
    assert.equal(view.source, 'SAMPLE');
    assert.equal(view.orders[0].state, 'PAID');
    assert.equal(view.orders[0].next.length, 0);

    process.env.BFL_ODOO_CONNECTED = '1';
    try {
      assert.equal((await send(base, '/api/sample-odoo')).status, 404, 'off when the real Odoo is connected');
      assert.equal((await send(base, `/api/sample-odoo/orders/${orderId}/send`, 'POST', {})).status, 404);
    } finally { delete process.env.BFL_ODOO_CONNECTED; }
  });
});

test('15. the overview offers only the steps that are legal now', () => {
  const db = freshDb(); stock(db);
  const { orderId } = order(db, customer(db, 'Kofi Traders Ltd'));
  const nextOf = () => overview(db).orders[0].next;
  assert.deepEqual(nextOf(), ['send']);
  sendQuotation(db, orderId);     assert.deepEqual(nextOf(), ['confirm', 'cancel']);
  confirmOrder(db, orderId);      assert.deepEqual(nextOf(), ['deliver', 'cancel']);
  validateDelivery(db, orderId);  assert.deepEqual(nextOf(), ['invoice']);
  postInvoice(db, orderId);       assert.deepEqual(nextOf(), ['pay']);
});

test('16. nothing here deletes history, and nothing reads cost data', () => {
  for (const f of ['src/domain/orders.js', 'src/domain/sample-odoo.js', 'src/server/routes/sample-odoo.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/\bDELETE\s+FROM\b/i.test(src), `${f} must not delete rows`);
    assert.ok(!/standard_price|cost_price|\bcost\b|valuation|purchase|supplier_price/i.test(src), `${f} must not read cost data`);
  }
});
