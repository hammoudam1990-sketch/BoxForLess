// The payment due date of an order (domain/payment-due.js): the Sales Manager sets it after the purchase; reminders
// and the customer's "Pay by" follow it; every change is kept; it is never sent to Odoo; only the Sales Manager and the
// administrator may set it, and who set it comes from the session.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { realAuth, startApp, Person, PW, ADMIN_USER, ADMIN_PASS } from './journey-helpers.js';

const restore = realAuth();
after(restore);

const { createApp } = await import('../src/server/index.js');
const staffAccounts = await import('../src/domain/staff-accounts.js');
const { submitRequest } = await import('../src/domain/requests.js');
const { createOrderForRequest } = await import('../src/domain/orders.js');
const { sendQuotation, confirmOrder, validateDelivery, postInvoice, recordPayment, cancelOrder } = await import('../src/domain/sample-odoo.js');
const { openInvoices } = await import('../src/domain/payments.js');
const { issueAccessCode } = await import('../src/domain/access-codes.js');
const { toDay } = await import('../src/domain/expiry.js');
const due = await import('../src/domain/payment-due.js');

const SPICE = '5283001117266';
const ts = new Date().toISOString();
const today = ts.slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function setup() {
  const db = freshDb();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)').run(SPICE, 'ABIDO ALL SPICE', 'CTN12', 500, ts, ts);
  return db;
}
function customer(db, name, type = 'CREDIT') {
  return Number(db.prepare(`INSERT INTO customers (name, customer_type, pricelist, salesperson, is_active, created_at, updated_at)
    VALUES (?, ?, 'CLASS A (GHS)', 'Kwame Asante', 1, ?, ?)`).run(name, type, ts, ts).lastInsertRowid);
}
function order(db, customerId) {
  const r = submitRequest(db, { lines: [{ barcode: SPICE, quantityCtn: 2 }], customerId, onInsert: (id) => createOrderForRequest(db, id) });
  return { requestId: r.requestId, orderId: db.prepare('SELECT id FROM odoo_orders WHERE request_id = ?').get(r.requestId).id };
}

// The app with real sign-in starts before any test is declared, so the test-runner bypass stays off for all of them.
const db = setup();
const adom = customer(db, 'Adom Supermarket');
const other = customer(db, 'Other Co');
const mine = order(db, adom);
const theirs = order(db, other);
const makeStaff = (name, email, role) => {
  const made = staffAccounts.createStaffUser(db, { name, email, role }, 'ADMIN', 'Test');
  staffAccounts.changeStaffPassword(db, made.user.id, made.temporaryPassword, PW);
};
makeStaff('Ama Boateng', 'sm@bfl.test', 'SALES_MANAGER');
makeStaff('Kofi Warehouse', 'wh@bfl.test', 'WAREHOUSE');
makeStaff('Rita Rep', 'rep@bfl.test', 'SALES_REP');
const { server, base } = await startApp(createApp, db);
after(() => server.close());

// ===========================================================================
// the rules
// ===========================================================================
test('1. a new credit order has no due date and is on the Sales Manager\'s list; a cash order is not', () => {
  const db = setup();
  const credit = order(db, customer(db, 'Adom Supermarket'));
  order(db, customer(db, 'Walk-in buyer', 'CASH'));
  const panel = due.paymentDueFor(db, credit.requestId);
  assert.equal(panel.applies, true);
  assert.equal(panel.dueDate, null);
  assert.deepEqual(due.ordersAwaitingDueDate(db).map((o) => o.customer), ['Adom Supermarket']);
});

test('2. setting the date stores it with who set it; changing it needs a reason; every change is kept', () => {
  const db = setup();
  const { requestId } = order(db, customer(db, 'Adom Supermarket'));
  const first = due.setPaymentDue(db, requestId, { dueDate: plusDays(14) }, 'Ama Boateng');
  assert.deepEqual([first.dueDate, first.setBy, first.history.length], [plusDays(14), 'Ama Boateng', 1]);
  assert.equal(due.ordersAwaitingDueDate(db).length, 0, 'no longer waiting for a date');
  assert.throws(() => due.setPaymentDue(db, requestId, { dueDate: plusDays(21) }, 'Ama Boateng'), /Say why/);
  const second = due.setPaymentDue(db, requestId, { dueDate: plusDays(21), reason: 'Customer asked for one more week' }, 'Ama Boateng');
  assert.equal(second.dueDate, plusDays(21));
  assert.deepEqual(second.history.map((x) => [x.oldDate, x.newDate, x.reason]), [
    [plusDays(14), plusDays(21), 'Customer asked for one more week'],
    [null, plusDays(14), null],
  ]);
  const same = due.setPaymentDue(db, requestId, { dueDate: plusDays(21) }, 'Ama Boateng');
  assert.equal(same.history.length, 2, 'the same date again changes nothing');
});

test('3. the date must be real, not before the order and within a year of it', () => {
  const db = setup();
  const { requestId } = order(db, customer(db, 'Adom Supermarket'));
  for (const bad of ['', '2026-02-30', 'tomorrow', plusDays(-3), plusDays(400)]) {
    assert.throws(() => due.setPaymentDue(db, requestId, { dueDate: bad }, 'SM'), due.PaymentDueError, String(bad));
  }
  assert.doesNotThrow(() => due.setPaymentDue(db, requestId, { dueDate: today }, 'SM'), 'the order day itself is allowed');
});

test('4. a cash, cancelled or paid order cannot be given a due date', () => {
  const db = setup();
  const cash = order(db, customer(db, 'Walk-in buyer', 'CASH'));
  assert.throws(() => due.setPaymentDue(db, cash.requestId, { dueDate: plusDays(7) }, 'SM'), /paid on delivery/);
  const cancelled = order(db, customer(db, 'Akwaaba Mini Mart'));
  sendQuotation(db, cancelled.orderId); cancelOrder(db, cancelled.orderId);
  assert.throws(() => due.setPaymentDue(db, cancelled.requestId, { dueDate: plusDays(7) }, 'SM'), /cancelled/);
  const paid = order(db, customer(db, 'Baah & Sons'));
  sendQuotation(db, paid.orderId); confirmOrder(db, paid.orderId); validateDelivery(db, paid.orderId); postInvoice(db, paid.orderId); recordPayment(db, paid.orderId);
  assert.throws(() => due.setPaymentDue(db, paid.requestId, { dueDate: plusDays(7) }, 'SM'), /already paid/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_payment_due').get().n, 0);
});

test('5. reminders and "pay by" follow the Sales Manager\'s date, not Odoo\'s 30-day terms', () => {
  const db = setup();
  const cust = customer(db, 'Adom Supermarket');
  const o = order(db, cust);
  sendQuotation(db, o.orderId); confirmOrder(db, o.orderId); validateDelivery(db, o.orderId); postInvoice(db, o.orderId);
  const before = openInvoices(db, cust, toDay(today))[0];
  assert.equal(before.payBy, plusDays(30), 'Odoo\'s due date until the Sales Manager sets one');
  due.setPaymentDue(db, o.requestId, { dueDate: plusDays(10) }, 'SM');
  const after = openInvoices(db, cust, toDay(today))[0];
  assert.deepEqual([after.payBy, after.daysToPay, after.setBySalesManager], [plusDays(10), 10, true]);
  assert.equal(db.prepare('SELECT due_date FROM odoo_invoices WHERE order_id = ?').get(o.orderId).due_date, plusDays(30), 'Odoo\'s own due date is untouched');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM odoo_outbox WHERE payload LIKE '%due%'").get().n, 0, 'nothing about it is queued for Odoo');
});

// ===========================================================================
// the API, with real sign-in
// ===========================================================================
test('6. the Sales Manager sets it; the name on it is theirs from the session, whatever the body says', async () => {
  const sm = new Person(base, 'Sales Manager');
  await sm.staffLogin('sm@bfl.test', PW);
  const r = await sm.ok(`/api/payments/orders/${mine.requestId}/due-date`, { method: 'PUT', body: { dueDate: plusDays(20), setBy: 'Someone Else', changedBy: 'X' } });
  assert.deepEqual([r.dueDate, r.setBy], [plusDays(20), 'Ama Boateng']);
  const bad = await sm.call(`/api/payments/orders/${mine.requestId}/due-date`, { method: 'PUT', body: { dueDate: plusDays(25) } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Say why/);
  const list = await sm.ok('/api/payments/orders/awaiting-due-date');
  assert.deepEqual(list.items.map((x) => x.customer), ['Other Co']);
  assert.equal((await sm.call('/api/payments/orders/999999/due-date')).json.applies, false);
});

test('7. the administrator may set it too; warehouse staff, sales reps and visitors may not', async () => {
  const admin = new Person(base, 'Administrator');
  await admin.staffLogin(ADMIN_USER, ADMIN_PASS);
  await admin.ok(`/api/payments/orders/${theirs.requestId}/due-date`, { method: 'PUT', body: { dueDate: plusDays(5) } });
  for (const [email, label] of [['wh@bfl.test', 'Warehouse'], ['rep@bfl.test', 'Rep']]) {
    const p = new Person(base, label);
    await p.staffLogin(email, PW);
    assert.equal((await p.call(`/api/payments/orders/${mine.requestId}/due-date`, { method: 'PUT', body: { dueDate: plusDays(1), reason: 'try' } })).status, 403, label);
  }
  assert.equal((await new Person(base, 'Visitor').call(`/api/payments/orders/${mine.requestId}/due-date`)).status, 401);
  assert.equal(due.paymentDueFor(db, mine.requestId).dueDate, plusDays(20), 'unchanged by the refused calls');
});

test('8. the customer sees their own order\'s "pay by" date and nothing about anyone else\'s', async () => {
  const res = await fetch(`${base}/api/catalog/access`, { method: 'POST', headers: { 'Content-Type': 'application/json', origin: base }, body: JSON.stringify({ code: issueAccessCode(db, adom) }) });
  assert.equal(res.status, 200);
  const c = new Person(base, 'Customer');
  c.cookie = (res.headers.getSetCookie?.() || []).map((x) => x.split(';')[0]).join('; ');
  const body = await c.ok('/api/catalog/orders');
  assert.deepEqual(body.orders.map((o) => o.paymentDue), [plusDays(20)]);
  assert.ok(!JSON.stringify(body).includes(plusDays(5)), 'not the other customer\'s date');
  assert.equal((await c.call(`/api/payments/orders/${mine.requestId}/due-date`)).status, 401, 'a customer cannot reach the staff API');
});
