// Payment reminders (S07): schedules, which day a payment is expected, and who is reminded when.
//
// What is at risk, in order:
//   1. Reminding the wrong person, or listing someone else's invoices in a reminder.
//   2. Reminding someone who has paid, or too often (or not at all).
//   3. A reminder blocking an order — it must never.
// 2026-10-21 is a Wednesday; the weekday cases below rely on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import { toDay, formatDay } from '../src/domain/expiry.js';
import {
  paymentDayFor, reminderDays, validateSchedule, describeSchedule, setSchedule, runReminders, markReminderSent, paymentsOverview,
  openInvoices, PaymentError, ScheduleKind, ReminderKind,
} from '../src/domain/payments.js';
import { accountFor } from '../src/domain/orders.js';

const DUE = { kind: 'DUE_DATE' };
const WED = { kind: 'WEEKLY', weekday: 3, dayOfMonth: null };
const day = (s) => toDay(s);
const fmt = (n) => formatDay(n);

function customer(db, name, extra = {}) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries({ customer_type: 'CREDIT', email: `${name.split(' ')[0].toLowerCase()}@example.com`, ...extra })) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}
let seq = 0;
function invoice(db, customerId, { amount = 100, date = '2026-10-01', due = '2026-10-31', state = 'OPEN' } = {}) {
  seq += 1;
  const id = Number(db.prepare(`INSERT INTO odoo_invoices (number, customer_id, amount, amount_due, invoice_date, due_date, state) VALUES (?,?,?,?,?,?,?)`)
    .run(`INV/2026/${String(seq).padStart(4, '0')}`, customerId, amount, state === 'OPEN' ? amount : 0, date, due, state).lastInsertRowid);
  return { id, number: `INV/2026/${String(seq).padStart(4, '0')}` };
}
const payInvoice = (db, id) => db.prepare("UPDATE odoo_invoices SET state = 'PAID', amount_due = 0 WHERE id = ?").run(id);
const reminders = (db) => db.prepare('SELECT * FROM payment_reminders ORDER BY id').all();

// ===========================================================================
// the payment day
// ===========================================================================
test('1. the payment day: the due date, or the first scheduled weekday or date on or after the invoice', () => {
  assert.equal(fmt(paymentDayFor('2026-10-01', '2026-10-31', DUE)), '2026-10-31');
  assert.equal(fmt(paymentDayFor('2026-10-19', '2026-11-18', WED)), '2026-10-21', 'Monday invoice, paid that Wednesday');
  assert.equal(fmt(paymentDayFor('2026-10-21', '2026-11-20', WED)), '2026-10-21', 'invoiced on a Wednesday: that day');
  assert.equal(fmt(paymentDayFor('2026-10-22', '2026-11-21', WED)), '2026-10-28', 'Thursday invoice: next Wednesday');
  const m25 = { kind: 'MONTHLY', weekday: null, dayOfMonth: 25 };
  assert.equal(fmt(paymentDayFor('2026-10-10', '2026-11-09', m25)), '2026-10-25');
  assert.equal(fmt(paymentDayFor('2026-10-26', '2026-11-25', m25)), '2026-11-25');
  const m31 = { kind: 'MONTHLY', weekday: null, dayOfMonth: 31 };
  assert.equal(fmt(paymentDayFor('2027-02-01', '2027-03-03', m31)), '2027-02-28', 'a short month uses its last day');
});

test('2. reminders fall the day before, on the day, then every 7 days while unpaid', () => {
  const P = day('2026-11-20');
  const upTo = (n) => reminderDays(P, P + n).map((r) => [r.day - P, r.kind]);
  assert.deepEqual(upTo(-2), [], 'nothing yet');
  assert.deepEqual(upTo(-1), [[-1, ReminderKind.BEFORE]]);
  assert.deepEqual(upTo(0), [[-1, 'BEFORE'], [0, 'DUE']]);
  assert.deepEqual(upTo(6), [[-1, 'BEFORE'], [0, 'DUE']], 'quiet for six days');
  assert.deepEqual(upTo(7), [[-1, 'BEFORE'], [0, 'DUE'], [7, 'OVERDUE']]);
  assert.deepEqual(upTo(14).map((x) => x[0]), [-1, 0, 7, 14]);
});

test('3. schedules are validated and described in plain words', () => {
  assert.deepEqual(validateSchedule({}), { kind: 'DUE_DATE', weekday: null, dayOfMonth: null });
  assert.deepEqual(validateSchedule({ kind: 'WEEKLY', weekday: '3' }), WED);
  assert.deepEqual(validateSchedule({ kind: 'MONTHLY', dayOfMonth: 25 }), { kind: 'MONTHLY', weekday: null, dayOfMonth: 25 });
  for (const bad of [{ kind: 'DAILY' }, { kind: 'WEEKLY' }, { kind: 'WEEKLY', weekday: 7 }, { kind: 'MONTHLY', dayOfMonth: 0 }, { kind: 'MONTHLY', dayOfMonth: 32 }, { kind: 'MONTHLY', dayOfMonth: 2.5 }]) {
    assert.throws(() => validateSchedule(bad), PaymentError, JSON.stringify(bad));
  }
  assert.equal(describeSchedule(DUE), "Each invoice's due date");
  assert.equal(describeSchedule(WED), 'Every Wednesday');
  assert.equal(describeSchedule({ kind: 'MONTHLY', dayOfMonth: 25 }), 'The 25th of each month');
  assert.equal(describeSchedule({ kind: 'MONTHLY', dayOfMonth: 1 }), 'The 1st of each month');
  assert.equal(describeSchedule({ kind: 'MONTHLY', dayOfMonth: 22 }), 'The 22nd of each month');
  assert.equal(describeSchedule({ kind: 'MONTHLY', dayOfMonth: 11 }), 'The 11th of each month');
});

test('4. only the Sales Manager\'s schedule applies, only to credit customers, and it can be changed', () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders');
  const cash = customer(db, 'Ama Mensah', { customer_type: 'CASH' });
  assert.throws(() => setSchedule(db, cash, WED), /cash/);
  assert.throws(() => setSchedule(db, 9999, WED), /does not exist/);
  assert.throws(() => setSchedule(db, id, { kind: 'WEEKLY' }), PaymentError);
  assert.equal(setSchedule(db, id, { kind: 'WEEKLY', weekday: 3 }, 'Esi').description, 'Every Wednesday');
  assert.equal(setSchedule(db, id, { kind: 'MONTHLY', dayOfMonth: 25 }).description, 'The 25th of each month');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_schedules').get().n, 1, 'one schedule per customer');
  invoice(db, id, { date: '2026-10-10', due: '2026-11-09' });
  assert.equal(openInvoices(db, id, day('2026-10-21'))[0].payBy, '2026-10-25');
});

// ===========================================================================
// who is reminded, and when
// ===========================================================================
test('5. the cycle for one invoice: before, on the day, quiet, then weekly until paid; paying stops it', () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders');
  const inv = invoice(db, id, { date: '2026-10-21', due: '2026-11-20', amount: 433.62 });
  const run = (d) => runReminders(db, d).length;

  assert.equal(run('2026-11-18'), 0, 'two days before: nothing');
  assert.equal(run('2026-11-19'), 1, 'the day before');
  assert.equal(run('2026-11-19'), 0, 'running again the same day does nothing');
  assert.equal(run('2026-11-20'), 1, 'payment day');
  for (const d of ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']) assert.equal(run(d), 0, d);
  assert.equal(run('2026-11-27'), 1, 'a week overdue');
  assert.equal(run('2026-12-04'), 1, 'and every 7 days after');
  assert.deepEqual(reminders(db).map((r) => [r.remind_on, r.kind]),
    [['2026-11-19', 'BEFORE'], ['2026-11-20', 'DUE'], ['2026-11-27', 'OVERDUE'], ['2026-12-04', 'OVERDUE']]);
  payInvoice(db, inv.id);
  assert.equal(run('2026-12-11'), 0, 'paid in Odoo: the reminders stop');
});

test('6. a server that was off on the day still sends one reminder when it is back, not a backlog', () => {
  const db = freshDb();
  const a = customer(db, 'Kofi Traders');
  invoice(db, a, { date: '2026-09-01', due: '2026-10-01' });
  assert.equal(runReminders(db, '2026-10-30').length, 1, 'four overdue weeks missed: ONE reminder');
  const b = customer(db, 'Esi Stores');
  invoice(db, b, { date: '2026-10-01', due: '2026-11-01' });
  assert.equal(runReminders(db, '2026-11-03').length, 1, 'missed by two days: sent now');
  assert.equal(runReminders(db, '2026-11-03').length, 0);
});

test('7. only credit customers with open invoices are reminded', () => {
  const db = freshDb();
  const credit = customer(db, 'Kofi Traders');
  const cash = customer(db, 'Ama Mensah', { customer_type: 'CASH' });
  const paid = customer(db, 'Paid Co');
  const inactive = customer(db, 'Gone Co', { is_active: 0 });
  invoice(db, credit, { due: '2026-11-20' });
  invoice(db, cash, { due: '2026-11-20' });              // should not exist, but must never be reminded
  invoice(db, paid, { due: '2026-11-20', state: 'PAID' });
  invoice(db, inactive, { due: '2026-11-20' });
  const made = runReminders(db, '2026-11-20');
  assert.deepEqual(made.map((m) => m.customerId), [credit]);
});

test('8. a reminder lists only that customer\'s own open invoices, in plain words', () => {
  const db = freshDb();
  const a = customer(db, 'Kofi Traders');
  const b = customer(db, 'Esi Stores');
  const i1 = invoice(db, a, { amount: 433.62, due: '2026-11-20' });
  const i2 = invoice(db, a, { amount: 120, due: '2026-11-10' });
  const other = invoice(db, b, { amount: 9999.99, due: '2026-11-20' });
  invoice(db, a, { amount: 55, due: '2026-11-20', state: 'PAID' });
  runReminders(db, '2026-11-20');
  const r = reminders(db).find((x) => x.customer_id === a);
  assert.equal(r.invoice_count, 2);
  assert.equal(r.total_due, 553.62);
  assert.match(r.body, /Hello Kofi Traders/);
  assert.ok(r.body.includes(i1.number) && r.body.includes('GHS 433.62') && r.body.includes('due today'));
  assert.ok(r.body.includes(i2.number) && /was due .*10 Nov 2026 \(10 days overdue\)/.test(r.body));
  assert.match(r.body, /Total outstanding: GHS 553\.62/);
  assert.match(r.body, /ignore this message/);
  assert.ok(!r.body.includes(other.number) && !r.body.includes('9,999') && !r.body.includes('Esi Stores'), "never another customer's invoices");
  assert.ok(!/credit limit|available credit/i.test(r.body), 'no credit figures in a reminder');
  assert.equal(r.kind, 'DUE');
});

test('9. a weekly schedule says so, and the message follows the schedule', () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders');
  setSchedule(db, id, WED);
  invoice(db, id, { date: '2026-10-19', due: '2026-11-18' });       // Monday: payment day is Wed 21st
  assert.equal(runReminders(db, '2026-10-20').length, 1, 'the day before that Wednesday');
  assert.match(reminders(db)[0].body, /Your payment day is: every wednesday/i);
  assert.match(reminders(db)[0].subject, /^Payment reminder/);
});

test('10. overdue reminders are worded as overdue', () => {
  const db = freshDb();
  invoice(db, customer(db, 'Kofi Traders'), { due: '2026-11-01' });
  runReminders(db, '2026-11-08');
  const r = reminders(db)[0];
  assert.equal(r.kind, 'OVERDUE');
  assert.match(r.subject, /^Overdue payment reminder/);
  assert.match(r.body, /now overdue/);
});

test('11. the address is the email, else the phone, else the reminder is logged as having no contact', () => {
  const db = freshDb();
  const withEmail = customer(db, 'Kofi Traders', { email: 'kofi@example.com', phone: '0244111222' });
  const phoneOnly = customer(db, 'Esi Stores', { email: null, phone: '0201777888' });
  const nothing = customer(db, 'Quiet Co', { email: null, phone: null });
  for (const id of [withEmail, phoneOnly, nothing]) invoice(db, id, { due: '2026-11-20' });
  runReminders(db, '2026-11-20');
  const by = (id) => reminders(db).find((r) => r.customer_id === id);
  assert.deepEqual([by(withEmail).to_address, by(withEmail).status], ['kofi@example.com', 'PENDING']);
  assert.deepEqual([by(phoneOnly).to_address, by(phoneOnly).status], ['0201777888', 'PENDING']);
  assert.deepEqual([by(nothing).to_address, by(nothing).status], [null, 'NO_CONTACT']);
});

test('12. "sent" is something a person records, once, on a reminder that is waiting', () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders');
  const quiet = customer(db, 'Quiet Co', { email: null, phone: null });
  invoice(db, id, { due: '2026-11-20' }); invoice(db, quiet, { due: '2026-11-20' });
  runReminders(db, '2026-11-20');
  const mine = reminders(db).find((r) => r.customer_id === id);
  const none = reminders(db).find((r) => r.customer_id === quiet);
  markReminderSent(db, mine.id, 'Esi');
  const row = db.prepare('SELECT status, sent_by, sent_at FROM payment_reminders WHERE id = ?').get(mine.id);
  assert.deepEqual([row.status, row.sent_by], ['SENT', 'Esi']);
  assert.ok(row.sent_at);
  assert.throws(() => markReminderSent(db, mine.id), /not waiting/);
  assert.throws(() => markReminderSent(db, none.id), /not waiting/);
  assert.throws(() => markReminderSent(db, 9999), /does not exist/);
});

// ===========================================================================
// the screens
// ===========================================================================
test('13. the overview buckets invoices into overdue, due this week and later, with totals', () => {
  const db = freshDb();
  const a = customer(db, 'Kofi Traders');
  const b = customer(db, 'Esi Stores');
  invoice(db, a, { amount: 100, due: '2026-10-15' });   // overdue (6 days)
  invoice(db, a, { amount: 200, due: '2026-10-21' });   // today: this week
  invoice(db, b, { amount: 300, due: '2026-10-27' });   // 6 days: this week
  invoice(db, b, { amount: 400, due: '2026-10-28' });   // 7 days: later
  const o = paymentsOverview(db, '2026-10-21');
  assert.deepEqual(o.summary.overdue, { count: 1, amount: 100 });
  assert.deepEqual(o.summary.thisWeek, { count: 2, amount: 500 });
  assert.deepEqual(o.summary.later, { count: 1, amount: 400 });
  assert.deepEqual(o.invoices.map((i) => i.bucket), ['OVERDUE', 'THIS_WEEK', 'THIS_WEEK', 'LATER']);
  assert.ok(o.schedules.some((s) => s.customer === 'Kofi Traders' && s.description === "Each invoice's due date"));
});

test('14. the customer sees their own "pay by" day and schedule, and nothing of anyone else\'s', () => {
  const db = freshDb();
  const a = customer(db, 'Kofi Traders');
  const b = customer(db, 'Esi Stores');
  setSchedule(db, a, WED);
  const mine = invoice(db, a, { amount: 50, date: '2026-10-22', due: '2026-11-21' });
  const theirs = invoice(db, b, { amount: 70, due: '2026-11-21' });
  const acc = accountFor(db, a, '2026-10-22');
  assert.equal(acc.paymentSchedule, 'Every Wednesday');
  assert.equal(acc.invoices.length, 1);
  assert.equal(acc.invoices[0].number, mine.number);
  assert.equal(acc.invoices[0].payBy, '2026-10-28');
  assert.ok(!JSON.stringify(acc).includes(theirs.number));
});

// ===========================================================================
// the routes
// ===========================================================================
async function withApp(db, fn) {
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}
const call = (base, path, method = 'GET', body = null) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', origin: base }, body: body ? JSON.stringify(body) : undefined,
});

test('15. the staff API: schedule, run, list, mark sent', async () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders');
  invoice(db, id, { due: '2020-01-01' });                     // long overdue: today's run catches the latest weekly reminder
  await withApp(db, async (base) => {
    const put = await call(base, `/api/payments/customers/${id}/schedule`, 'PUT', { kind: 'MONTHLY', dayOfMonth: 25 });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).description, 'The 25th of each month');
    assert.equal((await call(base, `/api/payments/customers/${id}/schedule`, 'PUT', { kind: 'MONTHLY', dayOfMonth: 99 })).status, 400);
    assert.equal((await call(base, '/api/payments/customers/9999/schedule', 'PUT', { kind: 'DUE_DATE' })).status, 404);

    const view = await (await call(base, '/api/payments')).json();
    assert.equal(view.invoices.length, 1);
    assert.equal(view.invoices[0].schedule, 'The 25th of each month');

    // a reminder exists only for a recent reminder day; make today the 7-day mark of an invoice due long ago
    db.prepare("UPDATE odoo_invoices SET due_date = date('now', '-7 days'), invoice_date = date('now', '-37 days')").run();
    db.prepare("DELETE FROM payment_schedules").run();
    const run = await (await call(base, '/api/payments/run', 'POST', {})).json();
    assert.equal(run.created, 1);
    assert.equal((await (await call(base, '/api/payments/run', 'POST', {})).json()).created, 0);
    const list = await (await call(base, '/api/payments')).json();
    assert.equal(list.reminders.length, 1);
    assert.equal(list.summary.remindersWaiting, 1);
    assert.equal((await call(base, `/api/payments/reminders/${list.reminders[0].id}/sent`, 'POST', {})).status, 200);
    assert.equal((await call(base, `/api/payments/reminders/${list.reminders[0].id}/sent`, 'POST', {})).status, 409);
    assert.equal((await (await call(base, '/api/payments')).json()).summary.remindersSent, 1);
  });
});

test('16. the payments API is staff-only', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const db = freshDb();
    invoice(db, customer(db, 'Kofi Traders'));
    await withApp(db, async (base) => {
      for (const [method, url] of [['GET', '/api/payments'], ['POST', '/api/payments/run'], ['PUT', '/api/payments/customers/1/schedule'], ['POST', '/api/payments/reminders/1/sent']]) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
        assert.ok([401, 403, 503].includes(res.status), `${method} ${url} -> ${res.status}`);
        assert.ok(!(await res.text()).includes('Kofi'));
      }
    });
  } finally { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; }
});

test('17. a reminder never blocks an order: the credit check ignores reminders and overdue invoices', async () => {
  const { checkCredit } = await import('../src/domain/orders.js');
  const { setCreditLimit } = await import('../src/domain/sample-odoo.js');
  const db = freshDb();
  const id = customer(db, 'Kofi Traders', { pricelist: 'CLASS A (GHS)' });
  setCreditLimit(db, id, 100000);
  invoice(db, id, { amount: 10, due: '2026-09-01' });
  db.prepare("UPDATE odoo_customer_finance SET amount_owed = 10, overdue = 10 WHERE customer_id = ?").run(id);
  runReminders(db, '2026-10-30');
  assert.ok(reminders(db).length >= 1);
  assert.equal(checkCredit(db, id, [{ barcode: '5283001117266', quantityCtn: 1 }]).ok, true);
});

test('18. the reminder code reads no cost data', () => {
  for (const f of ['src/domain/payments.js', 'src/server/routes/payments.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/standard_price|cost_price|\bcost\b|valuation|purchase|supplier_price/i.test(src), f);
    assert.ok(!/\bDELETE\s+FROM\b/i.test(src), `${f} must not delete rows`);
  }
});
