// The Sales Manager's dashboard (domain/periods.js, domain/sales-dashboard.js, /api/sales-dashboard): every figure from
// records BFL holds, one definition of a sale (invoices minus credit notes), targets spread over days, outstanding net of
// part-payments and credit notes, target changes kept with a reason, and company-wide figures for managers only.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { realAuth, startApp, Person, PW, ADMIN_USER, ADMIN_PASS } from './journey-helpers.js';

const restore = realAuth();
after(restore);

const { createApp } = await import('../src/server/index.js');
const staffAccounts = await import('../src/domain/staff-accounts.js');
const P = await import('../src/domain/periods.js');
const sd = await import('../src/domain/sales-dashboard.js');
const { setTarget, targetHistory } = await import('../src/domain/reports.js');

const TODAY = '2026-10-21';             // a Wednesday, day 21 of a 31-day month
const ts = '2026-10-01T08:00:00.000Z';

/** A small, fully known world: two reps (one inactive account too), three customers, invoices, credit notes, payments, orders. */
function world() {
  const db = freshDb();
  const staff = (name, email, role, active = 1) => {
    const made = staffAccounts.createStaffUser(db, { name, email, role }, 'ADMIN', 'Test');
    staffAccounts.changeStaffPassword(db, made.user.id, made.temporaryPassword, PW);
    if (!active) db.prepare('UPDATE staff_users SET is_active = 0 WHERE id = ?').run(made.user.id);
    return made.user;
  };
  staff('Ama Boateng', 'sm@bfl.test', 'SALES_MANAGER');
  staff('Kofi Warehouse', 'wh@bfl.test', 'WAREHOUSE');
  const rita = staff('Rita Rep', 'rita@bfl.test', 'SALES_REP');
  staff('Otis Rep', 'otis@bfl.test', 'SALES_REP');
  staff('Gone Rep', 'gone@bfl.test', 'SALES_REP', 0);
  const cust = (name, rep, type = 'CREDIT') => Number(db.prepare(`INSERT INTO customers (name, odoo_customer_ref, phone, delivery_address, salesperson, customer_type, is_active, created_at, updated_at)
    VALUES (?, ?, '0244000999', 'Secret Street 1', ?, ?, 1, ?, ?)`).run(name, `R-${name.length}`, rep, type, ts, ts).lastInsertRowid);
  const adom = cust('Adom Supermarket', 'Rita Rep');
  const baah = cust('Baah Provisions', 'Otis Rep');
  const loose = cust('No Rep Shop', null);
  let n = 0;
  const invoice = (customerId, amount, date, due = amount, orderId = null) => Number(db.prepare(`INSERT INTO odoo_invoices (number, customer_id, order_id, amount, amount_due, invoice_date, due_date, state)
    VALUES (?,?,?,?,?,?,?,?)`).run(`INV/T/${++n}`, customerId, orderId, amount, due, date, '2026-11-30', due > 0 ? 'OPEN' : 'PAID').lastInsertRowid);
  const order = (customerId, state, at, amountOpen = 100) => {
    const r = Number(db.prepare("INSERT INTO requests (reference, customer_id, status, submitted_at, created_at, updated_at) VALUES (?, ?, 'ACCEPTED', ?, ?, ?)").run(`REQ-T-${++n}`, customerId, at, at, at).lastInsertRowid);
    return Number(db.prepare('INSERT INTO odoo_orders (request_id, customer_id, state, amount_open, received_at, updated_at) VALUES (?,?,?,?,?,?)').run(r, customerId, state, amountOpen, at, at).lastInsertRowid);
  };
  // October so far: Adom 6,000 (one 4,000 invoice part-paid 1,500 + a 300 credit note), Baah 2,000, the no-rep shop 1,000
  const i1 = invoice(adom, 4000, '2026-10-05', 2200);
  invoice(adom, 2000, '2026-10-20');
  invoice(baah, 2000, '2026-10-12');
  invoice(loose, 1000, '2026-10-02');
  db.prepare('INSERT INTO odoo_payments (customer_id, invoice_id, amount, paid_on) VALUES (?,?,?,?)').run(adom, i1, 1500, '2026-10-15');
  db.prepare(`INSERT INTO odoo_credit_notes (number, customer_kind, customer_ref, customer_name, rep_name, invoice_number, kind, amount, issued_on)
              VALUES ('RCN/T/1', 'BFL', ?, 'Adom Supermarket', 'Rita Rep', 'INV/T/1', 'RETURN', 300, '2026-10-16')`).run(String(adom));
  // September (the "same days last month" comparison is 1–21 Sept): Adom 3,000 on the 10th, Baah 500 on the 25th (outside)
  const s1 = invoice(adom, 3000, '2026-09-10', 0);
  const s2 = invoice(baah, 500, '2026-09-25', 0);
  db.prepare('INSERT INTO odoo_payments (customer_id, invoice_id, amount, paid_on) VALUES (?,?,?,?)').run(adom, s1, 3000, '2026-09-30');
  db.prepare('INSERT INTO odoo_payments (customer_id, invoice_id, amount, paid_on) VALUES (?,?,?,?)').run(baah, s2, 500, '2026-09-30');
  // orders: 3 valid in October, 1 cancelled; 1 in September
  order(adom, 'RECEIVED', '2026-10-20T09:00:00.000Z', 1815.5);
  order(adom, 'INVOICED', '2026-10-04T09:00:00.000Z');
  order(baah, 'APPROVED', '2026-10-11T09:00:00.000Z');
  order(baah, 'CANCELLED', '2026-10-13T09:00:00.000Z');
  order(adom, 'PAID', '2026-09-09T09:00:00.000Z');
  // targets: team 31,000 for every month (1,000 a day in October); Rita 15,500 in October only; Otis 9,300 by default
  setTarget(db, { scope: 'COMPANY', scopeValue: '', measure: 'net_sales', month: 'DEFAULT', value: 31000 }, 'system');
  setTarget(db, { scope: 'REP', scopeValue: 'Rita Rep', measure: 'net_sales', month: '2026-10', value: 15500 }, 'system');
  setTarget(db, { scope: 'REP', scopeValue: 'Otis Rep', measure: 'net_sales', month: 'DEFAULT', value: 9300 }, 'system');
  return { db, adom, baah, loose, rita };
}

// The app with real sign-in starts before any test is declared, so the test-runner bypass stays off for all of them.
const W = world();
const { server, base } = await startApp(createApp, W.db);
after(() => server.close());

// ===========================================================================
// periods
// ===========================================================================
test('1. the periods, and the equivalent period before each one', () => {
  const r = (p, x) => P.periodRange(p, x, TODAY);
  const both = (x) => [x.start, x.end];
  assert.deepEqual(both(r('quarter')), ['2026-10-01', '2026-10-21']);
  assert.deepEqual(both(P.periodRange('quarter', {}, '2026-08-15')), ['2026-07-01', '2026-08-15']);
  assert.deepEqual(both(P.previousRange(r('today'))), ['2026-10-20', '2026-10-20']);
  assert.deepEqual(both(P.previousRange(r('week'))), ['2026-10-12', '2026-10-14']);
  assert.deepEqual(both(P.previousRange(r('month'))), ['2026-09-01', '2026-09-21'], 'the same days of last month');
  assert.deepEqual(both(P.previousRange(P.periodRange('month', {}, '2026-03-31'))), ['2026-02-01', '2026-02-28'], 'cut at the end of a shorter month');
  assert.deepEqual(both(P.previousRange(r('last_month'))), ['2026-08-01', '2026-08-31']);
  assert.deepEqual(both(P.previousRange(r('quarter'))), ['2026-07-01', '2026-07-21']);
  assert.deepEqual(both(P.previousRange(r('year'))), ['2025-01-01', '2025-10-21']);
  assert.deepEqual(both(P.previousRange(r('custom', { from: '2026-10-10', to: '2026-10-14' }))), ['2026-10-05', '2026-10-09']);
  assert.throws(() => sd.salesRange({ period: 'custom', from: '2026-10-09', to: '2026-10-01' }, TODAY), sd.SalesDashboardError);
});

// ===========================================================================
// targets spread over days, and the classification
// ===========================================================================
test('2. a monthly target is spread over its days: a week gets its share, "expected" stops at today', () => {
  const { db } = W;
  const days = P.daysOf(P.periodRange('week', {}, TODAY));            // Mon 19 – Wed 21 Oct
  assert.deepEqual(sd.targetForDays(db, 'COMPANY', '', days, TODAY), { target: 3000, expected: 3000, covered: 3, days: 3 });
  const month = P.daysOf({ start: '2026-10-01', end: '2026-10-31' });
  const t = sd.targetForDays(db, 'REP', 'Rita Rep', month, TODAY);
  assert.deepEqual([t.target, t.expected], [15500, 10500], '21 of 31 days expected by the 21st');
  assert.equal(sd.targetForDays(db, 'REP', 'Nobody', month, TODAY).target, null, 'no target: null, never 0');
  const sept = sd.targetForDays(db, 'REP', 'Rita Rep', P.daysOf({ start: '2026-09-01', end: '2026-09-30' }), TODAY);
  assert.equal(sept.target, null, 'Rita\'s target is for October only');
});

test('3. a rep is judged against what was expected by today, with thresholds the manager sets', () => {
  const th = { onTrackPct: 100, atRiskPct: 80 };
  // the spec's example: 30% of a 30-day month's target on day 5 is AHEAD (5/30 = 16.7% expected)
  assert.equal(sd.classify(3000, 10000 * (5 / 30), th), sd.PerformanceStatus.ON_TRACK);
  assert.equal(sd.classify(85, 100, th), sd.PerformanceStatus.AT_RISK);
  assert.equal(sd.classify(50, 100, th), sd.PerformanceStatus.BELOW);
  assert.equal(sd.classify(50, null, th), sd.PerformanceStatus.NO_TARGET);
  const db = freshDb();
  assert.throws(() => sd.setThresholds(db, { onTrackPct: 90, atRiskPct: 95 }), sd.SalesDashboardError);
  assert.deepEqual([sd.setThresholds(db, { onTrackPct: 95, atRiskPct: 70 }, 'Ama').onTrackPct, sd.getThresholds(db).atRiskPct], [95, 70]);
});

// ===========================================================================
// the dashboard figures
// ===========================================================================
test('4. the six KPIs: sales = invoices − credit notes, orders without cancellations, outstanding net of payments', () => {
  const d = sd.salesDashboard(W.db, { period: 'month' }, TODAY);
  const k = d.kpis;
  assert.equal(k.totalSales.value, 8700, '4,000 + 2,000 + 2,000 + 1,000 − 300');
  assert.equal(k.totalSales.previous, 3000, '1–21 September');
  assert.equal(k.totalSales.changePct, 190);
  assert.deepEqual([k.target.value, k.target.monthTarget, k.target.wholeMonth], [31000, 31000, true], 'this month: the whole month\'s target');
  assert.equal(k.target.expected, 21000, 'expected by the 21st: 21 days of 1,000');
  assert.equal(k.remaining.value, 22300, 'monthly target − sales');
  assert.deepEqual([k.totalOrders.value, k.totalOrders.previous], [3, 1], 'the cancelled order does not count');
  // outstanding at the 21st: INV 1 4,000 − 1,500 paid − 300 credited = 2,200; INV 2 2,000; Baah 2,000; no-rep 1,000
  assert.deepEqual([k.outstanding.value, k.outstanding.customers, k.outstanding.invoices], [7200, 3, 4]);
  assert.deepEqual([k.activeReps.value, k.activeReps.total], [2, 3], 'two active rep accounts of three');
});

test('5. sales by rep add up to the total (Unassigned included); remaining never goes negative', () => {
  const d = sd.salesDashboard(W.db, { period: 'month' }, TODAY);
  const by = Object.fromEntries(d.salesByRep.slices.map((x) => [x.name, x.value]));
  assert.deepEqual(by, { 'Rita Rep': 5700, 'Otis Rep': 2000, Unassigned: 1000 });
  assert.equal(d.salesByRep.slices.reduce((t, x) => t + x.value, 0), d.kpis.totalSales.value);
  const rita = d.reps.find((r) => r.name === 'Rita Rep');
  assert.deepEqual([rita.target, rita.expected, rita.achieved, rita.remaining], [15500, 10500, 5700, 9800]);
  assert.equal(rita.status, sd.PerformanceStatus.BELOW, '5,700 of 10,500 expected = 54%');
  const otis = d.reps.find((r) => r.name === 'Otis Rep');
  assert.equal(otis.status, sd.PerformanceStatus.BELOW, '2,000 of 6,300 expected');
  const week = sd.salesDashboard(W.db, { period: 'week' }, TODAY).reps.find((r) => r.name === 'Rita Rep');
  assert.deepEqual([week.target, week.expected, week.achieved, week.status], [3500, 1500, 2000, sd.PerformanceStatus.ON_TRACK], 'Mon–Sun target, Mon–Wed expected');
  const day = sd.salesDashboard(W.db, { period: 'custom', from: '2026-10-20', to: '2026-10-20' }, TODAY).reps.find((r) => r.name === 'Rita Rep');
  assert.deepEqual([day.target, day.achieved, day.remaining, day.exceededBy], [500, 2000, 0, 1500], 'over target: remaining 0, the excess shown apart');
  assert.deepEqual(Object.values(d.team.counts).reduce((a, b) => a + b, 0), 2, 'every rep account counted once');
});

test('6. the chart climbs steadily to the target (never all on day one) and stops at today', () => {
  const perf = sd.salesDashboard(W.db, { period: 'month' }, TODAY).performance;
  assert.equal(perf.unit, 'day');
  assert.equal(perf.points.length, 31, 'the whole month');
  assert.deepEqual([perf.points[0].cumTarget, perf.points[20].cumTarget, perf.points[30].cumTarget], [1000, 21000, 31000]);
  assert.deepEqual([perf.points[20].cumActual, perf.points[21].cumActual], [8700, null], 'sales stop at today');
  const year = sd.salesDashboard(W.db, { period: 'year' }, TODAY).performance;
  assert.equal(year.unit, 'month');
  assert.equal(year.points.length, 12);
  assert.equal(year.points[11].cumActual, null);
});

test('7. recent orders: the latest valid ones, newest first, with the estimate flagged until Odoo invoices', () => {
  const recent = sd.salesDashboard(W.db, { period: 'month' }, TODAY).recentOrders;
  assert.deepEqual(recent.map((o) => o.state), ['RECEIVED', 'APPROVED', 'INVOICED']);
  assert.deepEqual([recent[0].amount, recent[0].amountKind, recent[0].customer, recent[0].rep], [1815.5, 'ESTIMATE', 'Adom Supermarket', 'Rita Rep']);
});

test('8. orders and customers lists filter and sort; a customer\'s activity follows their last order or invoice', () => {
  const o = sd.ordersList(W.db, { period: 'month', rep: 'Otis Rep' }, TODAY);
  assert.deepEqual(o.items.map((x) => x.state).sort(), ['APPROVED', 'CANCELLED']);
  assert.deepEqual(sd.ordersList(W.db, { period: 'month', state: 'AWAITING_DUE_DATE' }, TODAY).items.map((x) => x.state).sort(), ['APPROVED', 'RECEIVED']);
  assert.equal(sd.ordersList(W.db, { period: 'month', search: 'baah' }, TODAY).total, 2);
  const c = sd.customersList(W.db, { period: 'month', sort: 'outstanding' }, TODAY);
  assert.deepEqual(c.items.map((x) => [x.name, x.outstanding]), [['Adom Supermarket', 4200], ['Baah Provisions', 2000], ['No Rep Shop', 1000]]);
  assert.equal(sd.customersList(W.db, { rep: 'Unassigned' }, TODAY).items[0].name, 'No Rep Shop');
  assert.equal(sd.activityOf(null, TODAY), sd.ActivityStatus.NEW);
  assert.equal(sd.activityOf('2026-06-01', TODAY), sd.ActivityStatus.DORMANT);
});

test('9. a target change needs a reason and is kept: old, new, who and why; the same value records nothing', () => {
  const { db } = world();
  assert.throws(() => sd.setSalesTarget(db, { scope: 'REP', rep: 'Rita Rep', month: '2026-10', value: 20000 }, 'Ama'), /Say why/);
  const r = sd.setSalesTarget(db, { scope: 'REP', rep: 'Rita Rep', month: '2026-10', value: 20000, reason: 'Two new shops' }, 'Ama');
  assert.deepEqual([r.history[0].oldValue, r.history[0].newValue, r.history[0].changedBy, r.history[0].reason], [15500, 20000, 'Ama', 'Two new shops']);
  sd.setSalesTarget(db, { scope: 'REP', rep: 'Rita Rep', month: '2026-10', value: 20000 }, 'Ama');
  assert.equal(targetHistory(db, { scope: 'REP', scopeValue: 'Rita Rep', month: '2026-10' }).length, 2, 'the first set and one change; the repeat adds nothing');
  assert.throws(() => sd.setSalesTarget(db, { scope: 'REP', rep: 'Not A Rep', month: '2026-10', value: 1 }, 'Ama'), /Choose one of the sales reps/);
  const t = sd.targetsOverview(db, '2026-10', TODAY);
  assert.deepEqual([t.reconciliation.sumOfReps, t.reconciliation.team, t.reconciliation.difference], [29300, 31000, 1700]);
});

test('10. nothing here writes to Odoo\'s tables or reads a cost', () => {
  const src = fs.readFileSync(new URL('../src/domain/sales-dashboard.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /standard_price|cost_price|valuation|purchase_order/i);
  assert.doesNotMatch(src, /(INSERT INTO|UPDATE|DELETE FROM)\s+odoo_/i);
});

// ===========================================================================
// the API, with real sign-in
// ===========================================================================
test('11. managers only: the Sales Manager and the administrator read it; warehouse, reps and visitors do not', async () => {
  const sm = new Person(base, 'Sales Manager');
  await sm.staffLogin('sm@bfl.test', PW);
  const d = await sm.ok('/api/sales-dashboard/summary?period=year');
  assert.ok(d.kpis && d.reps.length >= 2);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('0244000999') && !text.includes('Secret Street'), 'no phone numbers or addresses');
  const admin = new Person(base, 'Administrator');
  await admin.staffLogin(ADMIN_USER, ADMIN_PASS);
  await admin.ok('/api/sales-dashboard/notifications');
  for (const [email, label] of [['wh@bfl.test', 'Warehouse'], ['rita@bfl.test', 'Rep']]) {
    const p = new Person(base, label);
    await p.staffLogin(email, PW);
    assert.equal((await p.call('/api/sales-dashboard/summary')).status, 403, label);
    assert.equal((await p.call('/api/sales-dashboard/targets', { method: 'PUT', body: { scope: 'COMPANY', month: 'DEFAULT', value: 1, reason: 'try' } })).status, 403, label);
  }
  assert.equal((await new Person(base, 'Visitor').call('/api/sales-dashboard/summary')).status, 401);
  const bad = await sm.call('/api/sales-dashboard/summary?period=custom&from=2026-10-09&to=2026-10-01');
  assert.equal(bad.status, 400);
});

test('12. a target set through the API carries the manager\'s name from the session, not from the body', async () => {
  const sm = new Person(base, 'Sales Manager');
  await sm.staffLogin('sm@bfl.test', PW);
  const r = await sm.ok('/api/sales-dashboard/targets', { method: 'PUT', body: { scope: 'COMPANY', month: '2026-12', value: 40000, changedBy: 'Someone Else' } });
  assert.equal(r.history[0].changedBy, 'Ama Boateng');
  const missing = await sm.call('/api/sales-dashboard/targets', { method: 'PUT', body: { scope: 'COMPANY', month: '2026-12', value: 45000 } });
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /Say why/);
  const search = await sm.ok('/api/sales-dashboard/search?q=adom');
  assert.equal(search.customers[0].name, 'Adom Supermarket');
});

test('13. the sidebar\'s eight screens all have a route, and the role starts on the dashboard', () => {
  const nav = fs.readFileSync(new URL('../src/public/js/sales-nav.js', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('../src/public/js/app.js', import.meta.url), 'utf8');
  const main = ['sales', 'performance', 'targets', 'orders', 'customers', 'reports', 'notifications', 'sales-settings'];
  for (const r of main) {
    assert.match(nav, new RegExp(`link\\('#/${r}', '${r}'`), `${r} is in the menu`);
    assert.match(app, new RegExp(`path === '${r}'`), `${r} has a route`);
  }
  assert.match(app, /SALES_MANAGER: '#\/sales'/);
  assert.match(nav, /Grow Together/);
});
