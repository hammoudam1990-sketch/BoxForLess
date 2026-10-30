// The Sales Manager's dashboard: one read of what BFL holds, for one period.
//
// Where every figure comes from (the same definitions as the monthly reports, reports.js):
//   SALES        posted Odoo invoices (by invoice date) minus credit notes (by issue date), before tax, in GHS.
//                Never orders: an order becomes a sale when Odoo invoices it, so nothing is counted twice, and a
//                cancelled order (never invoiced) never counts.
//   A REP'S SALES the sales of the customers whose salesperson they are (customers.salesperson, from Odoo); a credit note
//                on a shop counts against the shop's rep. Sales of customers with no salesperson are "Unassigned".
//   TARGETS      the net-sales targets the Sales Manager sets per month (report_targets; a month's own value, else the
//                "every month" default). The target covers the WHOLE calendar period (this month = the full month, this
//                week = Monday to Sunday); a period that is not whole months gets the months' targets spread evenly over
//                their days — a week of October carries 7/31 of October's target. "Expected so far" is that share for the
//                days up to today, and that is what a rep is judged against. Nothing is assumed earned on the 1st.
//   ORDERS       orders placed on BFL (odoo_orders), not cancelled, by the day they were received.
//   OUTSTANDING  every invoice still unpaid at the end of the period (or today): payments and credit notes up to that
//                day are taken off, so part-payments count correctly and a paid invoice does not count.
//   ACTIVE REPS  sales rep accounts that are active (plus the two sample reps that stand in for Odoo's salespeople).
//
// Nothing here writes, reads a cost, or returns a phone number or address.
import { getTarget, setTarget, targetHistory, openInvoicesAt } from './reports.js';
import { allReps } from './reps.js';
import { ORDER_STATE_LABEL } from './orders.js';
import { toDay, formatDay } from './expiry.js';
import { periodRange, previousRange, fullRange, daysOf, daysInMonthOf, monthKeyOf, PERIOD_LABELS, PeriodError } from './periods.js';
import { sampleOdooEnabled } from './sample-odoo.js';
import { AWAITING_SQL } from './payment-due.js';

export class SalesDashboardError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'SalesDashboardError'; this.status = status; }
}

export const SALES_PERIODS = Object.freeze(['today', 'week', 'month', 'last_month', 'quarter', 'year', 'custom']);
export const DEFAULT_SALES_PERIOD = 'month';
export const UNASSIGNED = 'Unassigned';

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const change = (now, then) => (then ? Math.round(((now - then) / Math.abs(then)) * 1000) / 10 : null);
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

/** The period, as calendar days; a bad custom range is a 400. */
export function salesRange({ period, from, to } = {}, today) {
  try {
    return periodRange(period, { from, to }, today, { allowed: SALES_PERIODS, fallback: DEFAULT_SALES_PERIOD });
  } catch (e) {
    if (e instanceof PeriodError) throw new SalesDashboardError(e.message, e.status);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------
// settings: the team-performance thresholds (configurable, not hard-coded)
// ---------------------------------------------------------------------------------------------
export const DEFAULT_THRESHOLDS = Object.freeze({ onTrackPct: 100, atRiskPct: 80 });

export function getThresholds(db) {
  const r = db.prepare('SELECT on_track_pct, at_risk_pct, updated_by, updated_at FROM sales_dashboard_settings WHERE id = 1').get();
  return r ? { onTrackPct: r.on_track_pct, atRiskPct: r.at_risk_pct, updatedBy: r.updated_by, updatedAt: r.updated_at } : { ...DEFAULT_THRESHOLDS, updatedBy: null, updatedAt: null };
}

export function setThresholds(db, { onTrackPct, atRiskPct } = {}, by = null, now = new Date()) {
  const on = Number(onTrackPct);
  const risk = Number(atRiskPct);
  if (!Number.isFinite(on) || on < 50 || on > 150) throw new SalesDashboardError('"On target" is a percentage from 50 to 150.');
  if (!Number.isFinite(risk) || risk < 10 || risk >= on) throw new SalesDashboardError('"At risk" is a percentage from 10 up to, but not including, "on target".');
  db.prepare(`INSERT INTO sales_dashboard_settings (id, on_track_pct, at_risk_pct, updated_by, updated_at) VALUES (1, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET on_track_pct = excluded.on_track_pct, at_risk_pct = excluded.at_risk_pct, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(on, risk, by, now.toISOString());
  return getThresholds(db);
}

export const PerformanceStatus = Object.freeze({ ON_TRACK: 'ON_TRACK', AT_RISK: 'AT_RISK', BELOW: 'BELOW_TARGET', NO_TARGET: 'NO_TARGET' });

/** On track / at risk / below target: sales against what was EXPECTED by now (the target's share of the days gone). */
export function classify(sales, expected, thresholds) {
  if (expected === null || expected === undefined || expected <= 0) return PerformanceStatus.NO_TARGET;
  const ratio = (sales / expected) * 100;
  if (ratio >= thresholds.onTrackPct) return PerformanceStatus.ON_TRACK;
  if (ratio >= thresholds.atRiskPct) return PerformanceStatus.AT_RISK;
  return PerformanceStatus.BELOW;
}

// ---------------------------------------------------------------------------------------------
// targets spread over days
// ---------------------------------------------------------------------------------------------
/**
 * The net-sales target for some days: each day carries its month's target ÷ the days in that month.
 * @returns {{target:number|null, expected:number|null, covered:number, days:number}} target for all the days, the
 *   share for the days up to `today`, and how many days had a target at all (null when none did).
 */
export function targetForDays(db, scope, scopeValue, days, today) {
  const t = toDay(today);
  const perMonth = new Map();
  let target = 0; let expected = 0; let covered = 0;
  for (const d of days) {
    const key = monthKeyOf(d);
    if (!perMonth.has(key)) perMonth.set(key, getTarget(db, scope, scopeValue, 'net_sales', key));
    const monthly = perMonth.get(key);
    if (monthly === null || monthly === undefined) continue;
    const share = monthly / daysInMonthOf(d);
    target += share;
    if (d <= t) expected += share;
    covered += 1;
  }
  return covered ? { target: money(target), expected: money(expected), covered, days: days.length } : { target: null, expected: null, covered: 0, days: days.length };
}

// ---------------------------------------------------------------------------------------------
// the building blocks
// ---------------------------------------------------------------------------------------------
/** Net sales per day in a range: Map 'YYYY-MM-DD' -> GHS (invoices minus credit notes). */
function netByDay(db, start, end) {
  const m = new Map();
  for (const r of db.prepare('SELECT invoice_date d, SUM(amount) s FROM odoo_invoices WHERE invoice_date BETWEEN ? AND ? GROUP BY invoice_date').all(start, end)) m.set(r.d, (m.get(r.d) || 0) + r.s);
  for (const r of db.prepare('SELECT issued_on d, SUM(amount) s FROM odoo_credit_notes WHERE issued_on BETWEEN ? AND ? GROUP BY issued_on').all(start, end)) m.set(r.d, (m.get(r.d) || 0) - r.s);
  return m;
}
const netSalesIn = (db, start, end) => money([...netByDay(db, start, end).values()].reduce((s, v) => s + v, 0));

/** Net sales per rep NAME in a range (customers with no salesperson under UNASSIGNED). */
function netByRep(db, start, end) {
  const m = new Map();
  const bump = (k, v) => m.set(k || UNASSIGNED, (m.get(k || UNASSIGNED) || 0) + v);
  for (const r of db.prepare(`SELECT c.salesperson rep, SUM(i.amount) s FROM odoo_invoices i LEFT JOIN customers c ON c.id = i.customer_id
                               WHERE i.invoice_date BETWEEN ? AND ? GROUP BY c.salesperson`).all(start, end)) bump(r.rep, r.s);
  for (const r of db.prepare(`SELECT CASE WHEN n.customer_kind = 'BFL' THEN c.salesperson ELSE n.rep_name END rep, SUM(n.amount) s
                                FROM odoo_credit_notes n LEFT JOIN customers c ON n.customer_kind = 'BFL' AND c.id = CAST(n.customer_ref AS INTEGER)
                               WHERE n.issued_on BETWEEN ? AND ? GROUP BY 1`).all(start, end)) bump(r.rep, -r.s);
  for (const [k, v] of m) m.set(k, money(v));
  return m;
}

/** Orders placed on BFL in a range, not cancelled. */
const validOrdersIn = (db, start, end) => db.prepare(`SELECT COUNT(*) n FROM odoo_orders WHERE state <> 'CANCELLED' AND substr(received_at, 1, 10) BETWEEN ? AND ?`).get(start, end).n;

/** What was still owed at the end of `day`, in total and per customer. */
function outstandingAt(db, day) {
  const rows = openInvoicesAt(db, day);
  const byCustomer = new Map();
  for (const r of rows) byCustomer.set(r.customer_id, money((byCustomer.get(r.customer_id) || 0) + r.due));
  return { total: money(rows.reduce((s, r) => s + r.due, 0)), customers: byCustomer.size, byCustomer, invoices: rows.length };
}

/**
 * Every rep the dashboard knows: the reps (reps.js allReps), plus any salesperson with sales who is not one. `account`
 * is true only for a rep with an ACTIVE sales rep staff account — those are the team that is counted and classified;
 * a sample rep with no account, or an Odoo salesperson with none, is listed with their sales but not counted.
 */
function repList(db, extraNames = []) {
  const accounts = new Map(db.prepare("SELECT rep_id, is_active FROM staff_users WHERE role = 'SALES_REP' AND rep_id IS NOT NULL").all().map((r) => [r.rep_id, r.is_active]));
  const reps = allReps(db).map((r) => {
    const account = accounts.get(r.id) === 1;
    return { id: r.id, name: r.name, sample: Boolean(r.sample) && !account, account };
  });
  const known = new Set(reps.map((r) => r.name));
  for (const name of extraNames) {
    if (name && name !== UNASSIGNED && !known.has(name)) { reps.push({ id: `name:${name}`, name, sample: false, account: false }); known.add(name); }
  }
  return reps;
}

/** The latest sales activity of a rep: an order from one of their customers, an order they placed, or a shop visit. */
function lastActivityOf(db, rep) {
  const candidates = [];
  const o = db.prepare(`SELECT o.received_at at, r.reference ref FROM odoo_orders o JOIN customers c ON c.id = o.customer_id JOIN requests r ON r.id = o.request_id
                         WHERE c.salesperson = ? ORDER BY o.received_at DESC LIMIT 1`).get(rep.name);
  if (o) candidates.push({ at: o.at, what: `Order ${o.ref}` });
  const placed = db.prepare('SELECT submitted_at at, reference ref FROM requests WHERE placed_by_rep = ? ORDER BY submitted_at DESC LIMIT 1').get(rep.name);
  if (placed) candidates.push({ at: placed.at, what: `Placed order ${placed.ref}` });
  const visit = db.prepare('SELECT MAX(visited_on) at FROM shelf_visits WHERE rep_id = ?').get(rep.id);
  if (visit && visit.at) candidates.push({ at: visit.at, what: 'Shop visit' });
  return candidates.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}

/** Each rep's row for a range: target (spread over its days), sales, remaining, progress, status, last activity. */
function repRows(db, range, today, thresholds) {
  const sales = netByRep(db, range.start, range.end);
  const days = daysOf(fullRange(range));          // the target covers the whole period; sales are to date
  const customersOf = new Map(db.prepare("SELECT salesperson s, COUNT(*) n FROM customers WHERE is_active = 1 AND salesperson IS NOT NULL AND salesperson <> '' GROUP BY salesperson").all().map((r) => [r.s, r.n]));
  const ordersOf = new Map(db.prepare(`SELECT c.salesperson s, COUNT(*) n FROM odoo_orders o JOIN customers c ON c.id = o.customer_id
                                        WHERE o.state <> 'CANCELLED' AND substr(o.received_at, 1, 10) BETWEEN ? AND ? GROUP BY c.salesperson`).all(range.start, range.end).map((r) => [r.s, r.n]));
  return repList(db, [...sales.keys()]).map((rep) => {
    const achieved = sales.get(rep.name) || 0;
    const t = targetForDays(db, 'REP', rep.name, days, today);
    const remaining = t.target === null ? null : money(Math.max(0, t.target - achieved));
    return {
      id: rep.id, name: rep.name, initials: initials(rep.name), sample: rep.sample, account: rep.account,
      customers: customersOf.get(rep.name) || 0, orders: ordersOf.get(rep.name) || 0,
      target: t.target, expected: t.expected, achieved,
      remaining, exceededBy: t.target !== null && achieved > t.target ? money(achieved - t.target) : 0,
      progressPct: t.target ? pct(achieved, t.target) : null,
      expectedPct: t.target && t.expected !== null ? pct(t.expected, t.target) : null,
      status: classify(achieved, t.expected, thresholds),
      lastActivity: lastActivityOf(db, rep),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// the chart: actual vs target over the period, cumulative
// ---------------------------------------------------------------------------------------------
function granularityOf(range) {
  if (['today', 'week', 'month', 'last_month'].includes(range.period)) return 'day';
  if (['quarter', 'year'].includes(range.period)) return 'month';
  return daysOf(range).length <= 62 ? 'day' : 'month';
}

/**
 * Sales against target across the period, bucket by bucket (days, or months for a quarter or a year), with running
 * totals. The target line is the period's target spread over its days, so it climbs steadily — never all on day one.
 */
function performanceSeries(db, range, today) {
  const byDay = netByDay(db, range.start, range.end);
  const days = daysOf(fullRange(range));          // the whole period: the target line runs on past today
  const unit = granularityOf(range);
  const buckets = new Map();
  const tday = toDay(today);
  const monthTargets = new Map();
  let anyTarget = false;
  for (const d of days) {
    const key = unit === 'day' ? formatDay(d) : monthKeyOf(d);
    const b = buckets.get(key) || { key, start: formatDay(d), end: formatDay(d), actual: 0, target: 0, future: true };
    b.end = formatDay(d);
    b.actual += byDay.get(formatDay(d)) || 0;
    const mk = monthKeyOf(d);
    if (!monthTargets.has(mk)) monthTargets.set(mk, getTarget(db, 'COMPANY', '', 'net_sales', mk));
    const monthly = monthTargets.get(mk);
    if (monthly !== null && monthly !== undefined) { b.target += monthly / daysInMonthOf(d); anyTarget = true; }
    if (d <= tday) b.future = false;
    buckets.set(key, b);
  }
  let cumA = 0; let cumT = 0;
  const points = [...buckets.values()].map((b) => {
    cumA += b.actual; cumT += b.target;
    return { key: b.key, start: b.start, end: b.end, actual: money(b.actual), target: anyTarget ? money(b.target) : null, cumActual: b.future ? null : money(cumA), cumTarget: anyTarget ? money(cumT) : null };
  });
  return {
    unit, points, hasTarget: anyTarget,
    method: 'Each month\'s target is spread evenly over its days; the lines show running totals from the start of the period.',
  };
}

// ---------------------------------------------------------------------------------------------
// recent orders
// ---------------------------------------------------------------------------------------------
const STATE_TONE = { RECEIVED: 'info', WAITING_FOR_APPROVAL: 'info', APPROVED: 'warning', DISPATCHED: 'warning', INVOICED: 'success', PAID: 'success', CANCELLED: 'danger' };

function orderRow(o) {
  return {
    requestId: o.request_id, reference: o.reference, odooNumber: o.odoo_number || null, customer: o.customer || 'Unknown customer',
    customerId: o.customer_id || null, rep: o.rep || o.placed_by_rep || null,
    amount: o.amount_total ?? o.amount_open ?? null, amountKind: o.amount_total !== null && o.amount_total !== undefined ? 'INVOICED' : (o.amount_open !== null && o.amount_open !== undefined ? 'ESTIMATE' : null),
    state: o.state, stateLabel: ORDER_STATE_LABEL[o.state] || o.state, tone: STATE_TONE[o.state] || 'neutral',
    placedAt: o.received_at, dueDate: o.due_date || null, customerType: o.customer_type || null,
  };
}
const ORDER_SELECT = `SELECT o.request_id, o.customer_id, o.odoo_number, o.state, o.amount_total, o.amount_open, o.received_at,
                             r.reference, r.placed_by_rep, c.name customer, c.salesperson rep, c.customer_type, d.due_date
                        FROM odoo_orders o JOIN requests r ON r.id = o.request_id LEFT JOIN customers c ON c.id = o.customer_id
                        LEFT JOIN order_payment_due d ON d.order_id = o.id`;

// ---------------------------------------------------------------------------------------------
// the dashboard
// ---------------------------------------------------------------------------------------------
export function salesDashboard(db, query = {}, today) {
  const range = salesRange(query, today);
  const prev = previousRange(range);
  const thresholds = getThresholds(db);
  const days = daysOf(fullRange(range));
  const asOf = range.end < today ? range.end : today;

  const sales = netSalesIn(db, range.start, range.end);
  const salesBefore = netSalesIn(db, prev.start, prev.end);
  const team = targetForDays(db, 'COMPANY', '', days, today);
  const orders = validOrdersIn(db, range.start, range.end);
  const ordersBefore = validOrdersIn(db, prev.start, prev.end);
  const owed = outstandingAt(db, asOf);
  const reps = repRows(db, range, today, thresholds);
  const accounts = db.prepare("SELECT COUNT(*) total, SUM(is_active) active FROM staff_users WHERE role = 'SALES_REP'").get();
  const repsWithAccount = reps.filter((r) => r.account);
  const activeReps = repsWithAccount.length;
  const inactiveAccounts = Math.max(0, (accounts.total || 0) - (accounts.active || 0));

  // sales by rep, for the donut: biggest first, Unassigned included so the slices add up to the total
  const byRep = netByRep(db, range.start, range.end);
  const slices = [...byRep.entries()].filter(([, v]) => v > 0).map(([name, value]) => {
    const rep = reps.find((r) => r.name === name);
    return { name, repId: rep ? rep.id : null, value, share: pct(value, sales > 0 ? sales : [...byRep.values()].reduce((s, v) => s + Math.max(0, v), 0)) };
  }).sort((a, b) => b.value - a.value);

  const counts = { ON_TRACK: 0, AT_RISK: 0, BELOW_TARGET: 0, NO_TARGET: 0 };
  for (const r of repsWithAccount) counts[r.status] += 1;
  const withTarget = repsWithAccount.length - counts.NO_TARGET;

  const recent = db.prepare(`${ORDER_SELECT} WHERE o.state <> 'CANCELLED' AND substr(o.received_at, 1, 10) BETWEEN ? AND ? ORDER BY o.received_at DESC, o.id DESC LIMIT 5`).all(range.start, range.end).map(orderRow);

  return {
    range, previous: prev, asOf, currency: 'GHS', source: sampleOdooEnabled() ? 'SAMPLE' : 'ODOO', thresholds,
    kpis: {
      totalSales: { value: sales, previous: salesBefore, changePct: change(sales, salesBefore) },
      target: {
        value: team.target, expected: team.expected, achievedPct: team.target ? pct(sales, team.target) : null,
        partial: team.target !== null && team.covered < team.days, wholeMonth: ['month', 'last_month'].includes(range.period),
        monthTarget: ['month', 'last_month'].includes(range.period) ? getTarget(db, 'COMPANY', '', 'net_sales', range.start.slice(0, 7)) : null,
      },
      remaining: { value: team.target === null ? null : money(Math.max(0, team.target - sales)), exceededBy: team.target !== null && sales > team.target ? money(sales - team.target) : 0 },
      activeReps: { value: activeReps, total: activeReps + inactiveAccounts, withSales: reps.filter((r) => r.achieved > 0).length },
      totalOrders: { value: orders, previous: ordersBefore, changePct: change(orders, ordersBefore) },
      outstanding: { value: owed.total, customers: owed.customers, invoices: owed.invoices, asOf },
    },
    performance: performanceSeries(db, range, today),
    salesByRep: { total: sales, slices },
    team: { counts, withTarget, reps: repsWithAccount.length, status: teamStatusOf(sales, team.expected, thresholds) },
    reps: repsWithAccount.concat(reps.filter((r) => !r.account)),
    recentOrders: recent,
  };
}

const teamStatusOf = (sales, expected, thresholds) => classify(sales, expected, thresholds);

// ---------------------------------------------------------------------------------------------
// one rep in detail
// ---------------------------------------------------------------------------------------------
export function repDetail(db, repId, query = {}, today) {
  const range = salesRange(query, today);
  const thresholds = getThresholds(db);
  const rows = repRows(db, range, today, thresholds);
  const rep = rows.find((r) => r.id === String(repId));
  if (!rep) throw new SalesDashboardError('That sales rep was not found.', 404);
  const asOf = range.end < today ? range.end : today;
  const owed = outstandingAt(db, asOf);
  const invoicesIn = (ids) => db.prepare(`SELECT customer_id id, COUNT(*) n, SUM(amount) s FROM odoo_invoices WHERE invoice_date BETWEEN ? AND ? GROUP BY customer_id`).all(range.start, range.end).filter((r) => ids.has(r.id));
  const customers = db.prepare('SELECT id, name, odoo_customer_ref ref, customer_type type FROM customers WHERE is_active = 1 AND salesperson = ? ORDER BY name').all(rep.name);
  const ids = new Set(customers.map((c) => c.id));
  const inv = new Map(invoicesIn(ids).map((r) => [r.id, r]));
  const lastOrder = new Map(db.prepare(`SELECT customer_id id, MAX(received_at) at FROM odoo_orders WHERE state <> 'CANCELLED' GROUP BY customer_id`).all().map((r) => [r.id, r.at]));
  const invoiceCount = [...inv.values()].reduce((s, r) => s + r.n, 0);
  // the last six months, month by month, against the rep's target
  const months = [];
  const [y, m] = today.split('-').map(Number);
  for (let k = 5; k >= 0; k -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - k, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const start = `${key}-01`;
    const end = formatDay(toDay(start) + daysInMonthOf(toDay(start)) - 1);
    months.push({ month: key, sales: netByRep(db, start, end < today ? end : today).get(rep.name) || 0, target: getTarget(db, 'REP', rep.name, 'net_sales', key) });
  }
  return {
    range, rep,
    averageInvoice: invoiceCount ? money(rep.achieved / invoiceCount) : null, invoices: invoiceCount,
    outstanding: money(customers.reduce((s, c) => s + (owed.byCustomer.get(c.id) || 0), 0)),
    customers: customers.map((c) => ({
      id: c.id, name: c.name, ref: c.ref || null, type: c.type || 'CREDIT', sales: money(inv.get(c.id)?.s || 0), invoices: inv.get(c.id)?.n || 0,
      outstanding: owed.byCustomer.get(c.id) || 0, lastOrder: lastOrder.get(c.id) || null,
    })).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name)),
    trend: months,
    orders: db.prepare(`${ORDER_SELECT} WHERE c.salesperson = ? AND substr(o.received_at, 1, 10) BETWEEN ? AND ? ORDER BY o.received_at DESC LIMIT 20`).all(rep.name, range.start, range.end).map(orderRow),
  };
}

// ---------------------------------------------------------------------------------------------
// orders and customers (lists with filters)
// ---------------------------------------------------------------------------------------------
const clampInt = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt; };
const ORDER_STATES = Object.keys(ORDER_STATE_LABEL);

export function ordersList(db, query = {}, today) {
  const range = salesRange(query, today);
  const where = ['substr(o.received_at, 1, 10) BETWEEN ? AND ?'];
  const params = [range.start, range.end];
  const state = String(query.state || '').toUpperCase();
  if (state === 'AWAITING_DUE_DATE') {
    where.push(`${AWAITING_SQL} AND d.due_date IS NULL`);
  } else if (ORDER_STATES.includes(state)) { where.push('o.state = ?'); params.push(state); }
  const rep = String(query.rep || '').trim();
  if (rep === UNASSIGNED) where.push("(c.salesperson IS NULL OR c.salesperson = '')");
  else if (rep) { where.push('c.salesperson = ?'); params.push(rep); }
  const search = String(query.search || '').trim().slice(0, 100);
  if (search) {
    where.push('(r.reference LIKE ? OR COALESCE(o.odoo_number, \'\') LIKE ? OR COALESCE(c.name, \'\') LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const sql = `${ORDER_SELECT} WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(...params).n;
  const limit = clampInt(query.limit, 1, 100, 25);
  const offset = clampInt(query.offset, 0, 1e6, 0);
  const items = db.prepare(`${sql} ORDER BY o.received_at DESC, o.id DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).map(orderRow);
  return { range, total, limit, offset, items, states: ORDER_STATE_LABEL, reps: repList(db).map((r) => r.name) };
}

export const ActivityStatus = Object.freeze({ ACTIVE: 'ACTIVE', QUIET: 'QUIET', DORMANT: 'DORMANT', NEW: 'NEW' });
/** Active = ordered or invoiced in the last 30 days; quiet = 31–90 days; dormant = longer; new = never. */
export function activityOf(lastAt, today) {
  if (!lastAt) return ActivityStatus.NEW;
  const days = toDay(today) - toDay(String(lastAt).slice(0, 10));
  return days <= 30 ? ActivityStatus.ACTIVE : days <= 90 ? ActivityStatus.QUIET : ActivityStatus.DORMANT;
}

export function customersList(db, query = {}, today) {
  const range = salesRange(query, today);
  const owed = outstandingAt(db, today);
  const salesBy = new Map(db.prepare('SELECT customer_id id, SUM(amount) s FROM odoo_invoices WHERE invoice_date BETWEEN ? AND ? GROUP BY customer_id').all(range.start, range.end).map((r) => [r.id, r.s]));
  const creditsBy = new Map(db.prepare("SELECT CAST(customer_ref AS INTEGER) id, SUM(amount) s FROM odoo_credit_notes WHERE customer_kind = 'BFL' AND issued_on BETWEEN ? AND ? GROUP BY customer_ref").all(range.start, range.end).map((r) => [r.id, r.s]));
  const ordersBy = new Map(db.prepare("SELECT customer_id id, COUNT(*) n FROM odoo_orders WHERE state <> 'CANCELLED' AND substr(received_at, 1, 10) BETWEEN ? AND ? GROUP BY customer_id").all(range.start, range.end).map((r) => [r.id, r.n]));
  const lastOrder = new Map(db.prepare("SELECT customer_id id, MAX(received_at) at FROM odoo_orders WHERE state <> 'CANCELLED' GROUP BY customer_id").all().map((r) => [r.id, r.at]));
  const lastInvoice = new Map(db.prepare('SELECT customer_id id, MAX(invoice_date) at FROM odoo_invoices GROUP BY customer_id').all().map((r) => [r.id, r.at]));
  let rows = db.prepare('SELECT id, name, odoo_customer_ref ref, customer_type type, salesperson rep, pricelist FROM customers WHERE is_active = 1').all().map((c) => {
    const last = [lastOrder.get(c.id), lastInvoice.get(c.id)].filter(Boolean).sort().pop() || null;
    return {
      id: c.id, name: c.name, ref: c.ref || null, type: c.type || 'CREDIT', rep: c.rep || null, priceClass: c.pricelist || null,
      sales: money((salesBy.get(c.id) || 0) - (creditsBy.get(c.id) || 0)), orders: ordersBy.get(c.id) || 0,
      outstanding: owed.byCustomer.get(c.id) || 0, lastActivity: last, activity: activityOf(last, today),
    };
  });
  const search = String(query.search || '').trim().toLowerCase().slice(0, 100);
  if (search) rows = rows.filter((c) => c.name.toLowerCase().includes(search) || String(c.ref || '').toLowerCase().includes(search));
  const rep = String(query.rep || '').trim();
  if (rep === UNASSIGNED) rows = rows.filter((c) => !c.rep);
  else if (rep) rows = rows.filter((c) => c.rep === rep);
  const activity = String(query.activity || '').toUpperCase();
  if (ActivityStatus[activity]) rows = rows.filter((c) => c.activity === activity);
  if (query.owing === '1' || query.owing === 'true') rows = rows.filter((c) => c.outstanding > 0);
  const sorts = {
    name: (a, b) => a.name.localeCompare(b.name), sales: (a, b) => b.sales - a.sales || a.name.localeCompare(b.name),
    outstanding: (a, b) => b.outstanding - a.outstanding || a.name.localeCompare(b.name),
    activity: (a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')) || a.name.localeCompare(b.name),
  };
  const sort = sorts[query.sort] ? query.sort : 'name';
  rows.sort(sorts[sort]);
  const counts = Object.fromEntries(Object.keys(ActivityStatus).map((k) => [k, rows.filter((c) => c.activity === k).length]));
  const limit = clampInt(query.limit, 1, 100, 25);
  const offset = clampInt(query.offset, 0, 1e6, 0);
  return { range, total: rows.length, limit, offset, sort, counts, items: rows.slice(offset, offset + limit), reps: repList(db).map((r) => r.name) };
}

export function customerDetail(db, customerId, query = {}, today) {
  const range = salesRange(query, today);
  const c = db.prepare('SELECT id, name, odoo_customer_ref ref, customer_type type, salesperson rep, pricelist, is_active FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) throw new SalesDashboardError('That customer was not found.', 404);
  const f = db.prepare('SELECT credit_limit, amount_owed, overdue, updated_at FROM odoo_customer_finance WHERE customer_id = ?').get(c.id);
  const owed = outstandingAt(db, today);
  const months = [];
  const [y, m] = today.split('-').map(Number);
  for (let k = 5; k >= 0; k -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - k, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const start = `${key}-01`;
    const end = formatDay(toDay(start) + daysInMonthOf(toDay(start)) - 1);
    const inv = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM odoo_invoices WHERE customer_id = ? AND invoice_date BETWEEN ? AND ?').get(c.id, start, end).s;
    const cr = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM odoo_credit_notes WHERE customer_kind = 'BFL' AND customer_ref = ? AND issued_on BETWEEN ? AND ?").get(String(c.id), start, end).s;
    months.push({ month: key, sales: money(inv - cr) });
  }
  const openInv = openInvoicesAt(db, today).filter((r) => r.customer_id === c.id).map((r) => ({ number: r.number, amount: money(r.amount), due: r.due, dueDate: r.due_date }));
  const salesIn = db.prepare('SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM odoo_invoices WHERE customer_id = ? AND invoice_date BETWEEN ? AND ?').get(c.id, range.start, range.end);
  const last = db.prepare("SELECT MAX(received_at) at FROM odoo_orders WHERE customer_id = ? AND state <> 'CANCELLED'").get(c.id).at;
  return {
    range,
    customer: { id: c.id, name: c.name, ref: c.ref || null, type: c.type || 'CREDIT', rep: c.rep || null, priceClass: c.pricelist || null, active: Boolean(c.is_active) },
    finance: c.type === 'CASH' ? null : { creditLimit: f?.credit_limit ?? null, amountOwed: f?.amount_owed ?? 0, overdue: f?.overdue ?? 0, asOf: f?.updated_at ?? null },
    outstanding: owed.byCustomer.get(c.id) || 0,
    sales: { value: money(salesIn.s), invoices: salesIn.n },
    lastOrder: last || null, activity: activityOf(last, today),
    trend: months, openInvoices: openInv,
    orders: db.prepare(`${ORDER_SELECT} WHERE o.customer_id = ? ORDER BY o.received_at DESC LIMIT 20`).all(c.id).map(orderRow),
  };
}

// ---------------------------------------------------------------------------------------------
// targets screen
// ---------------------------------------------------------------------------------------------
export function targetsOverview(db, month, today) {
  const key = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || '')) ? month : today.slice(0, 7);
  const own = (scope, value) => db.prepare("SELECT value, set_by, set_at FROM report_targets WHERE scope = ? AND scope_value = ? AND measure = 'net_sales' AND month = ?").get(scope, value, key);
  const dflt = (scope, value) => db.prepare("SELECT value FROM report_targets WHERE scope = ? AND scope_value = ? AND measure = 'net_sales' AND month = 'DEFAULT'").get(scope, value);
  const start = `${key}-01`;
  const end = formatDay(toDay(start) + daysInMonthOf(toDay(start)) - 1);
  const salesEnd = end < today ? end : today;
  const sales = start <= today ? netByRep(db, start, salesEnd) : new Map();
  const teamSales = start <= today ? netSalesIn(db, start, salesEnd) : 0;
  const describe = (scope, value) => {
    const o = own(scope, value);
    const d = dflt(scope, value);
    return { value: o ? o.value : d ? d.value : null, source: o ? 'MONTH' : d ? 'DEFAULT' : null, setBy: o?.set_by || null, setAt: o?.set_at || null, defaultValue: d ? d.value : null };
  };
  const team = { ...describe('COMPANY', ''), achieved: teamSales };
  const reps = repList(db).filter((r) => r.account).map((r) => ({ id: r.id, name: r.name, ...describe('REP', r.name), achieved: sales.get(r.name) || 0 }));
  const sumReps = money(reps.reduce((s, r) => s + (r.value || 0), 0));
  return {
    month: key, start, end, monthToDate: end >= today,
    team: { ...team, achievedPct: team.value ? pct(teamSales, team.value) : null },
    reps: reps.map((r) => ({ ...r, achievedPct: r.value ? pct(r.achieved, r.value) : null })),
    reconciliation: { sumOfReps: sumReps, team: team.value, difference: team.value === null ? null : money(team.value - sumReps), repsWithoutTarget: reps.filter((r) => r.value === null).map((r) => r.name) },
  };
}

/**
 * Set the team's or one rep's net-sales target for a month (or "every month"). Changing a target that is already set
 * needs a reason; every change is kept (reports.setTarget writes report_target_changes). A value of '' clears it.
 */
export function setSalesTarget(db, { scope, rep, month, value, reason } = {}, by = null, now = new Date()) {
  const s = scope === 'REP' ? 'REP' : scope === 'COMPANY' ? 'COMPANY' : null;
  if (!s) throw new SalesDashboardError('A target is for the team or for a rep.');
  const name = s === 'REP' ? String(rep || '').trim() : '';
  if (s === 'REP' && !repList(db).some((r) => r.account && r.name === name)) throw new SalesDashboardError('Choose one of the sales reps.');
  const m = String(month || '');
  if (m !== 'DEFAULT' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new SalesDashboardError('Choose a month, or "every month".');
  const old = db.prepare("SELECT value FROM report_targets WHERE scope = ? AND scope_value = ? AND measure = 'net_sales' AND month = ?").get(s, name, m);
  const clearing = value === '' || value === null || value === undefined;
  const n = clearing ? null : Number(value);
  if (!clearing && (!Number.isFinite(n) || n < 0 || n > 1e12)) throw new SalesDashboardError('A target is an amount in GHS, 0 or more.');
  const changing = old && (clearing || old.value !== n);
  if (changing && String(reason || '').trim().length < 3) throw new SalesDashboardError('Say why the target is changing.');
  setTarget(db, { scope: s, scopeValue: name, measure: 'net_sales', month: m, value: clearing ? '' : n, reason }, by, now);
  return { scope: s, rep: name || null, month: m, value: n, history: targetHistory(db, { scope: s, scopeValue: name, month: m, limit: 20 }) };
}

// ---------------------------------------------------------------------------------------------
// search and notifications
// ---------------------------------------------------------------------------------------------
export function salesSearch(db, q) {
  const term = String(q || '').trim().slice(0, 100);
  if (term.length < 2) return { term, orders: [], customers: [], products: [], reps: [] };
  const like = `%${term}%`;
  return {
    term,
    orders: db.prepare(`${ORDER_SELECT} WHERE r.reference LIKE ? OR COALESCE(o.odoo_number, '') LIKE ? OR COALESCE(c.name, '') LIKE ? ORDER BY o.received_at DESC LIMIT 8`).all(like, like, like).map(orderRow),
    customers: db.prepare('SELECT id, name, odoo_customer_ref ref, salesperson rep FROM customers WHERE is_active = 1 AND (name LIKE ? OR COALESCE(odoo_customer_ref, \'\') LIKE ?) ORDER BY name LIMIT 8').all(like, like),
    products: db.prepare('SELECT id, name, barcode FROM products WHERE is_active = 1 AND (name LIKE ? OR barcode LIKE ?) ORDER BY name LIMIT 8').all(like, like),
    reps: repList(db).filter((r) => r.account && r.name.toLowerCase().includes(term.toLowerCase())).map((r) => ({ id: r.id, name: r.name })),
  };
}

export function salesNotifications(db, today) {
  const items = [];
  const add = (key, level, count, title, detail, href) => { if (count > 0) items.push({ key, level, count, title, detail, href }); };
  const n = (sql, ...p) => db.prepare(sql).get(...p).n;
  add('access', 'amber', n("SELECT COUNT(*) n FROM access_requests WHERE status = 'PENDING'"), 'Registrations waiting for approval', 'Companies that asked to buy on Box for Less.', '#/access');
  add('requests', 'amber', n("SELECT COUNT(*) n FROM requests WHERE status = 'SUBMITTED'"), 'Requests not accepted yet', 'Customer requests waiting for the team.', '#/requests');
  add('due', 'amber', n(`SELECT COUNT(*) n FROM odoo_orders o JOIN customers c ON c.id = o.customer_id WHERE ${AWAITING_SQL}
                           AND NOT EXISTS (SELECT 1 FROM order_payment_due d WHERE d.order_id = o.id)`),
  'Orders without a payment due date', 'New credit orders, not invoiced yet: set when each is to be paid.', '#/orders?state=AWAITING_DUE_DATE');
  add('overdue', 'red', n(`SELECT COUNT(*) n FROM odoo_invoices i LEFT JOIN order_payment_due d ON d.order_id = i.order_id
                             WHERE i.state = 'OPEN' AND i.amount_due > 0 AND COALESCE(d.due_date, i.due_date) < ?`, today),
  'Invoices past their payment date', 'Unpaid after the date they were due.', '#/payments');
  add('reminders', 'amber', n("SELECT COUNT(*) n FROM payment_reminders WHERE status = 'PENDING'"), 'Payment reminders to send', 'Composed and ready to copy to the customer.', '#/payments');
  add('blocked', 'red', n("SELECT COUNT(*) n FROM order_check_log WHERE kind = 'CREDIT' AND substr(at, 1, 10) >= ?", formatDay(toDay(today) - 6)),
    'Orders blocked by the credit check this week', 'Customers who could not order because of their credit limit.', '#/reports');
  return { asOf: today, items, count: items.length };
}

export { PERIOD_LABELS };
