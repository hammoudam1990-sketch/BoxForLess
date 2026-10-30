// Monthly reports (screen S06): the CEO summary, the Sales Manager report and the Warehouse report.
//
// Every figure comes from what BFL has read from Odoo (invoices, credit notes, payments, orders, stock,
// lots, deliveries, returns) or from BFL's own records (visits, reasons, the order-check log, targets).
// There is no cost data anywhere: no margin, no stock value, no write-off cost. Sales means INVOICED sales
// minus credit notes, before tax, in GHS — never orders placed. Quantities are cartons. Months are calendar
// months. Customer names and amounts only: never a phone number or an address.
//
// SAMPLE until the Odoo sync exists: the Odoo-side tables are filled by domain/sample-odoo.js, and a
// "Load sample history" button there fills fourteen months so every number has something to compare with.
// For the month in progress the report is month-to-date.
import { toDay, formatDay, formatDay as fmtDay } from './expiry.js';
import { buildExpiryList } from './expiry-list.js';
import { shelfRecords, ShelfState } from './shelf.js';
import { REASON_LABEL } from './returns.js';

export class ReportError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ReportError'; this.status = status; }
}

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ---------------------------------------------------------------------------------------------
// months
// ---------------------------------------------------------------------------------------------
export const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));
function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function range(month) {
  const start = `${month}-01`;
  const next = `${shiftMonth(month, 1)}-01`;
  const end = formatDay(toDay(next) - 1);
  return { month, start, end, startDay: toDay(start), endDay: toDay(end) };
}
/** Today's month, as the report month when none is asked for. */
export const monthOf = (todayStr) => todayStr.slice(0, 7);

// ---------------------------------------------------------------------------------------------
// targets and notes (BFL's own records)
// ---------------------------------------------------------------------------------------------
export const TARGET_MEASURES = Object.freeze({
  net_sales: 'Net sales (GHS)', active_customers: 'Active customers', new_customers: 'New customers',
  collections: 'Collections (GHS)', avg_order_value: 'Average order value (GHS)', fill_rate: 'Fill rate (%)',
});

/** A target for a month: the month's own, else the default for every month, else null. */
export function getTarget(db, scope, scopeValue, measure, month) {
  const r = db.prepare(`SELECT value FROM report_targets WHERE scope = ? AND scope_value = ? AND measure = ? AND month IN (?, 'DEFAULT')
                        ORDER BY (month = 'DEFAULT') LIMIT 1`).get(scope, scopeValue || '', measure, month);
  return r ? r.value : null;
}

/**
 * Set (or clear) a target. Every change is kept in report_target_changes — the old value, the new one, who, when and
 * the reason given — so a target is never overwritten without a trace. Setting the value it already has records nothing.
 */
export function setTarget(db, { scope, scopeValue, measure, month, value, reason }, by = null, now = new Date()) {
  if (!['COMPANY', 'REP'].includes(scope)) throw new ReportError('A target is for the company or for a rep.');
  if (!TARGET_MEASURES[measure]) throw new ReportError('That measure has no target.');
  if (month !== 'DEFAULT' && !isMonth(month)) throw new ReportError('Choose a month, or "every month".');
  if (scope === 'REP' && measure !== 'net_sales' && measure !== 'collections' && measure !== 'active_customers') throw new ReportError('A rep has targets for net sales, collections and active customers.');
  const rep = scope === 'REP' ? String(scopeValue || '').trim() : '';
  if (scope === 'REP' && !rep) throw new ReportError('Choose the rep.');
  const old = db.prepare('SELECT value FROM report_targets WHERE scope = ? AND scope_value = ? AND measure = ? AND month = ?').get(scope, rep, measure, month);
  const why = String(reason ?? '').trim().slice(0, 300) || null;
  const log = (newValue) => db.prepare(`INSERT INTO report_target_changes (scope, scope_value, measure, month, old_value, new_value, reason, changed_by, changed_at)
                                        VALUES (?,?,?,?,?,?,?,?,?)`).run(scope, rep, measure, month, old ? old.value : null, newValue, why, by, now.toISOString());
  if (value === '' || value === null || value === undefined) {
    if (old) {
      db.prepare('DELETE FROM report_targets WHERE scope = ? AND scope_value = ? AND measure = ? AND month = ?').run(scope, rep, measure, month);
      log(null);
    }
    return { cleared: true };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new ReportError('A target is a number, 0 or more.');
  if (old && old.value === n) return { cleared: false, value: n };
  db.prepare(`INSERT INTO report_targets (scope, scope_value, measure, month, value, set_by, set_at) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(scope, scope_value, measure, month) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`)
    .run(scope, rep, measure, month, n, by, now.toISOString());
  log(n);
  return { cleared: false, value: n };
}

/** The history of one target (newest first), or of every target when no key is given. */
export function targetHistory(db, { scope = null, scopeValue = null, measure = 'net_sales', month = null, limit = 100 } = {}) {
  const where = ['measure = ?'];
  const params = [measure];
  if (scope) { where.push('scope = ?'); params.push(scope); }
  if (scopeValue !== null && scopeValue !== undefined) { where.push('scope_value = ?'); params.push(String(scopeValue)); }
  if (month) { where.push('month = ?'); params.push(month); }
  return db.prepare(`SELECT scope, scope_value AS scopeValue, measure, month, old_value AS oldValue, new_value AS newValue, reason, changed_by AS changedBy, changed_at AS changedAt
                       FROM report_target_changes WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params, Math.min(Math.max(Number(limit) || 100, 1), 500));
}

export function listTargets(db) {
  return db.prepare('SELECT scope, scope_value AS scopeValue, measure, month, value, set_by AS setBy, set_at AS setAt FROM report_targets ORDER BY scope, scope_value, measure, month').all();
}

/** The three lines the report owner writes before the report goes out: what happened, why, what we will do. */
export function getNotes(db, report, month) {
  return db.prepare('SELECT what, why, action, written_by AS writtenBy, written_at AS writtenAt FROM report_notes WHERE report = ? AND month = ?').get(report, month)
    || { what: '', why: '', action: '', writtenBy: null, writtenAt: null };
}
export function saveNotes(db, report, month, { what, why, action }, by = null, now = new Date()) {
  if (!['CEO', 'SALES', 'WAREHOUSE'].includes(report)) throw new ReportError('Unknown report.', 404);
  if (!isMonth(month)) throw new ReportError('Choose a month.');
  const clean = (v) => String(v ?? '').trim().slice(0, 500);
  db.prepare(`INSERT INTO report_notes (report, month, what, why, action, written_by, written_at) VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(report, month) DO UPDATE SET what = excluded.what, why = excluded.why, action = excluded.action, written_by = excluded.written_by, written_at = excluded.written_at`)
    .run(report, month, clean(what), clean(why), clean(action), by, now.toISOString());
  return getNotes(db, report, month);
}

// ---------------------------------------------------------------------------------------------
// the building blocks: sums over Odoo's tables
// ---------------------------------------------------------------------------------------------
const invoiced = (db, a, b) => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM odoo_invoices WHERE invoice_date BETWEEN ? AND ?').get(a, b).s;
const credited = (db, a, b) => db.prepare('SELECT COALESCE(SUM(amount),0) s FROM odoo_credit_notes WHERE issued_on BETWEEN ? AND ?').get(a, b).s;
const netSales = (db, a, b) => money(invoiced(db, a, b) - credited(db, a, b));
const collectionsIn = (db, a, b) => money(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM odoo_payments WHERE paid_on BETWEEN ? AND ?').get(a, b).s);

/** Each unpaid invoice at the end of a day: what is still due then. Payments and credit notes after that day do not count. */
function openAt(db, day) {
  return db.prepare(`
    SELECT i.id, i.number, i.customer_id, i.amount, i.due_date,
           (SELECT COALESCE(SUM(p.amount),0) FROM odoo_payments p WHERE p.invoice_id = i.id AND p.paid_on <= ?) AS paid,
           (SELECT COALESCE(SUM(n.amount),0) FROM odoo_credit_notes n WHERE n.invoice_number = i.number AND n.issued_on <= ?) AS credited
      FROM odoo_invoices i WHERE i.invoice_date <= ?`).all(day, day, day)
    .map((r) => ({ ...r, due: money(r.amount - r.paid - r.credited) })).filter((r) => r.due > 0.004);
}

/** Every invoice still (partly) unpaid at the end of `day`: payments and credit notes up to that day are taken off. */
export const openInvoicesAt = (db, day) => openAt(db, day);

const isCredit = "(c.customer_type IS NULL OR c.customer_type = 'CREDIT')";

function customersInvoiced(db, a, b, creditOnly = true) {
  return new Set(db.prepare(`SELECT DISTINCT i.customer_id id FROM odoo_invoices i JOIN customers c ON c.id = i.customer_id
                              WHERE i.invoice_date BETWEEN ? AND ? ${creditOnly ? `AND ${isCredit}` : ''}`).all(a, b).map((r) => r.id));
}

function moneyOwed(db, day) {
  const rows = openAt(db, day);
  const total = money(rows.reduce((s, r) => s + r.due, 0));
  const dayN = toDay(day);
  const over60 = money(rows.filter((r) => dayN - toDay(r.due_date) > 60).reduce((s, r) => s + r.due, 0));
  return { total, over60, share: total ? pct(over60, total) : 0 };
}

// ---------------------------------------------------------------------------------------------
// Report 1 — the CEO summary: twelve measures
// ---------------------------------------------------------------------------------------------
const MEASURES = [
  { key: 'net_sales', name: 'Net sales', unit: 'ghs', dir: 'up', hint: 'Posted invoices in the month minus posted credit notes, before tax' },
  { key: 'net_sales_vs_target', name: 'Net sales vs target', unit: 'pct', dir: 'up', hint: 'Net sales against the company target for the month' },
  { key: 'active_customers', name: 'Active customers', unit: 'int', dir: 'up', hint: 'Credit customers with at least one posted invoice in the month (the shared cash account is cash sales, not a customer)' },
  { key: 'new_customers', name: 'New customers', unit: 'int', dir: 'up', hint: 'Customers whose first-ever posted invoice is in the month' },
  { key: 'lapsed_customers', name: 'Lapsed customers', unit: 'int', dir: 'down', hint: 'Invoiced in the 3 months before last month, with no invoice in the last 2 months' },
  { key: 'avg_order_value', name: 'Average order value', unit: 'ghs', dir: 'up', hint: 'Total before tax of orders confirmed in the month, divided by their number' },
  { key: 'money_owed', name: 'Money owed', unit: 'ghs', dir: 'down', hint: 'Unpaid amount of all posted invoices at month end' },
  { key: 'dso', name: 'Days of sales outstanding', unit: 'days', dir: 'down', hint: 'Money owed at month end divided by the average daily net sales of the last 90 days' },
  { key: 'collections', name: 'Collections', unit: 'ghs', dir: 'up', hint: 'Customer payments received in the month' },
  { key: 'expiry_loss', name: 'Expiry loss (sales value)', unit: 'ghs', dir: 'down', hint: 'Expiry credit notes in the month plus discounts given on clearance lines' },
  { key: 'fill_rate', name: 'Fill rate', unit: 'pct', dir: 'up', hint: 'Cartons delivered divided by cartons ordered, for orders dispatched in the month' },
  { key: 'orders_through_bfl', name: 'Orders through BFL', unit: 'pct', dir: 'up', hint: 'Share of orders confirmed in the month that came from the BFL platform', needs: 'Needs Odoo sales orders from every source' },
];

function measureValues(db, month) {
  const r = range(month);
  const sales = netSales(db, r.start, r.end);
  const target = getTarget(db, 'COMPANY', '', 'net_sales', month);
  const active = customersInvoiced(db, r.start, r.end);
  const everBefore = new Set(db.prepare(`SELECT DISTINCT i.customer_id id FROM odoo_invoices i JOIN customers c ON c.id = i.customer_id WHERE i.invoice_date < ? AND ${isCredit}`).all(r.start).map((x) => x.id));
  const newOnes = [...active].filter((id) => !everBefore.has(id)).length;
  const before = customersInvoiced(db, `${shiftMonth(month, -4)}-01`, range(shiftMonth(month, -2)).end);
  const recent = customersInvoiced(db, `${shiftMonth(month, -1)}-01`, r.end);
  const lapsed = [...before].filter((id) => !recent.has(id)).length;
  const orders = db.prepare(`SELECT COALESCE(amount_total, amount_open) AS v FROM odoo_orders WHERE state <> 'CANCELLED' AND approved_at IS NOT NULL AND substr(approved_at,1,10) BETWEEN ? AND ?`).all(r.start, r.end);
  const owed = moneyOwed(db, r.end);
  const sales90 = netSales(db, formatDay(r.endDay - 89), r.end);
  const dispatched = db.prepare(`SELECT COALESCE(SUM(cartons_ordered),0) o, COALESCE(SUM(cartons_delivered),0) d FROM odoo_orders WHERE dispatched_at IS NOT NULL AND cartons_ordered IS NOT NULL AND substr(dispatched_at,1,10) BETWEEN ? AND ?`).get(r.start, r.end);
  const expiry = db.prepare(`SELECT COALESCE(SUM(n.amount),0) s FROM odoo_credit_notes n LEFT JOIN return_classifications c ON c.return_id = n.return_id
                              WHERE n.issued_on BETWEEN ? AND ? AND (n.kind = 'DISCOUNT' OR (n.kind = 'RETURN' AND c.reason = 'EXPIRED'))`).get(r.start, r.end).s
    + db.prepare('SELECT COALESCE(SUM(l.discount),0) s FROM odoo_invoice_lines l JOIN odoo_invoices i ON i.id = l.invoice_id WHERE i.invoice_date BETWEEN ? AND ?').get(r.start, r.end).s;
  return {
    net_sales: sales,
    net_sales_vs_target: target ? pct(sales, target) : null,
    active_customers: active.size,
    new_customers: newOnes,
    lapsed_customers: lapsed,
    avg_order_value: orders.length ? money(orders.reduce((s, o) => s + o.v, 0) / orders.length) : null,
    money_owed: owed.total,
    dso: sales90 > 0 ? Math.round((owed.total / (sales90 / 90)) * 10) / 10 : null,
    collections: collectionsIn(db, r.start, r.end),
    expiry_loss: money(expiry),
    fill_rate: dispatched.o ? pct(dispatched.d, dispatched.o) : null,
    orders_through_bfl: null,
    _extra: { money_owed: owed.total ? `${owed.share}% is more than 60 days overdue` : null },
    _target: target,
  };
}

/** green / amber / red against the target, or last year where there is no target; null when there is nothing to compare with. */
export function mark(value, ref, dir) {
  if (value === null || value === undefined || ref === null || ref === undefined) return null;
  if (dir === 'up') {
    if (ref === 0) return value > 0 ? 'green' : null;
    const q = value / ref;
    return q >= 1 ? 'green' : q >= 0.9 ? 'amber' : 'red';
  }
  if (value <= ref) return 'green';
  return value <= ref * 1.1 ? 'amber' : 'red';
}

function ceoReport(db, month) {
  const now = measureValues(db, month);
  const last = measureValues(db, shiftMonth(month, -1));
  const year = measureValues(db, shiftMonth(month, -12));
  const targets = { net_sales: now._target, net_sales_vs_target: now._target ? 100 : null };
  for (const k of ['active_customers', 'new_customers', 'collections', 'avg_order_value', 'fill_rate']) targets[k] = getTarget(db, 'COMPANY', '', k, month);
  const measures = MEASURES.map((m) => {
    const target = targets[m.key] ?? null;
    const ref = target ?? year[m.key] ?? null;
    return {
      key: m.key, name: m.name, unit: m.unit, dir: m.dir, hint: m.hint, unavailable: m.needs && now[m.key] === null ? m.needs : null,
      thisMonth: now[m.key], lastMonth: last[m.key], lastYear: year[m.key], target,
      against: target !== null ? 'target' : (year[m.key] !== null && year[m.key] !== undefined ? 'last year' : null),
      mark: mark(now[m.key], ref, m.dir), extra: now._extra[m.key] || null,
    };
  });
  return { measures, sections: [] };
}

// ---------------------------------------------------------------------------------------------
// Report 2 — the Sales Manager report: named lists to act on
// ---------------------------------------------------------------------------------------------
const section = (id, title, intro, source, action, columns, rows, extra = {}) => ({ id, title, intro, source, action, columns, rows, ...extra });
const col = (key, label, type = 'text') => ({ key, label, type });

/** Everyone who bought or was credited, keyed "BFL:<id>" or "SHELF:<id>", with their rep and price class. */
function entities(db) {
  const m = new Map();
  for (const c of db.prepare('SELECT id, name, salesperson, pricelist FROM customers').all()) m.set(`BFL:${c.id}`, { name: c.name, rep: c.salesperson || null, cls: c.pricelist || null });
  for (const r of db.prepare('SELECT DISTINCT customer_kind k, customer_ref ref, customer_name name, rep_name rep FROM odoo_credit_notes WHERE customer_kind = \'SHELF\'').all()) if (!m.has(`SHELF:${r.ref}`)) m.set(`SHELF:${r.ref}`, { name: r.name, rep: r.rep, cls: null });
  return m;
}

function perEntity(db, a, b) {
  const out = new Map();
  const bump = (k, f, v) => { const o = out.get(k) || { sales: 0, credits: 0, collections: 0 }; o[f] += v; out.set(k, o); };
  for (const r of db.prepare('SELECT customer_id id, SUM(amount) s FROM odoo_invoices WHERE invoice_date BETWEEN ? AND ? GROUP BY customer_id').all(a, b)) bump(`BFL:${r.id}`, 'sales', r.s);
  for (const r of db.prepare('SELECT customer_kind k, customer_ref ref, SUM(amount) s FROM odoo_credit_notes WHERE issued_on BETWEEN ? AND ? GROUP BY customer_kind, customer_ref').all(a, b)) bump(`${r.k}:${r.ref}`, 'credits', r.s);
  for (const r of db.prepare('SELECT customer_id id, SUM(amount) s FROM odoo_payments WHERE paid_on BETWEEN ? AND ? GROUP BY customer_id').all(a, b)) bump(`BFL:${r.id}`, 'collections', r.s);
  return out;
}

const net = (o) => money((o?.sales || 0) - (o?.credits || 0));
const change = (now, then) => (then ? Math.round(((now - then) / Math.abs(then)) * 1000) / 10 : null);

function salesReport(db, month, todayStr) {
  const r = range(month);
  const lm = range(shiftMonth(month, -1));
  const ly = range(shiftMonth(month, -12));
  const ents = entities(db);
  const now = perEntity(db, r.start, r.end);
  const last = perEntity(db, lm.start, lm.end);
  const year = perEntity(db, ly.start, ly.end);
  const total = [...now.values()].reduce((s, o) => s + net(o), 0);
  const repOf = (k) => ents.get(k)?.rep || '(no rep)';
  const sections = [];

  // 1. sales by rep
  const shelf = shelfRecords(db, todayStr);
  const repNames = new Map(shelf.shelf.reps.map((x) => [x.id, x.name]));
  const visits = new Map();
  for (const v of db.prepare('SELECT rep_id, COUNT(*) n FROM shelf_visits WHERE visited_on BETWEEN ? AND ? GROUP BY rep_id').all(r.start, r.end)) visits.set(repNames.get(v.rep_id) || v.rep_id, v.n);
  const reps = new Set([...repNames.values(), ...[...now.keys()].map(repOf)]);
  const activeBy = new Map();
  for (const id of customersInvoiced(db, r.start, r.end)) { const rp = repOf(`BFL:${id}`); activeBy.set(rp, (activeBy.get(rp) || 0) + 1); }
  sections.push(section('sales_by_rep', 'Sales by rep', 'Net sales, active customers, collections and shop visits per rep, each against target. A rep is the customer\'s salesperson in Odoo.',
    'Odoo invoices and payments; BFL visits; targets in BFL', 'Coaching and follow-up',
    [col('rep', 'Rep'), col('netSales', 'Net sales', 'ghs'), col('target', 'Target', 'ghs'), col('vsTarget', 'vs target', 'pct'), col('active', 'Active customers', 'int'), col('collections', 'Collections', 'ghs'), col('visits', 'Shop visits', 'int')],
    [...reps].sort().map((rp) => {
      const mine = [...now.entries()].filter(([k]) => repOf(k) === rp);
      const sales = money(mine.reduce((s, [, o]) => s + net(o), 0));
      const t = getTarget(db, 'REP', rp, 'net_sales', month);
      return { rep: rp, netSales: sales, target: t, vsTarget: t ? pct(sales, t) : null, active: activeBy.get(rp) || 0, collections: money(mine.reduce((s, [, o]) => s + o.collections, 0)), visits: visits.get(rp) || 0 };
    }).filter((x) => x.netSales || x.active || x.visits || x.collections || x.target)));

  // 2. top 20 customers
  const top = [...now.entries()].map(([k, o]) => ({ k, sales: net(o) })).filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, 20);
  sections.push(section('top_customers', 'Top 20 customers', 'Net sales, share of total, and change against last month and the same month last year.', 'Odoo invoices', 'Protect the biggest accounts',
    [col('customer', 'Customer'), col('rep', 'Rep'), col('netSales', 'Net sales', 'ghs'), col('share', 'Share of total', 'pct'), col('vsLastMonth', 'vs last month', 'pct'), col('vsLastYear', 'vs last year', 'pct')],
    top.map((x) => ({ customer: ents.get(x.k)?.name || x.k, rep: ents.get(x.k)?.rep || '', netSales: x.sales, share: pct(x.sales, total), vsLastMonth: change(x.sales, net(last.get(x.k))), vsLastYear: change(x.sales, net(year.get(x.k))) }))));

  // 3. dormant customers
  const endN = r.endDay;
  const lastInv = db.prepare(`SELECT i.customer_id id, MAX(i.invoice_date) last FROM odoo_invoices i JOIN customers c ON c.id = i.customer_id WHERE i.invoice_date <= ? AND ${isCredit} GROUP BY i.customer_id`).all(r.end);
  sections.push(section('dormant', 'Dormant customers', 'Customers with no invoice for 30, 60 or 90 days, with the last invoice date and rep.', 'Odoo invoices', "This month's call list per rep",
    [col('customer', 'Customer'), col('rep', 'Rep'), col('lastInvoice', 'Last invoice', 'date'), col('days', 'Days since', 'int'), col('band', 'Band')],
    lastInv.map((x) => ({ x, days: endN - toDay(x.last) })).filter((x) => x.days >= 30).sort((a, b) => b.days - a.days)
      .map(({ x, days }) => ({ customer: ents.get(`BFL:${x.id}`)?.name, rep: ents.get(`BFL:${x.id}`)?.rep || '', lastInvoice: x.last, days, band: days >= 90 ? '90+ days' : days >= 60 ? '60+ days' : '30+ days' }))));

  // 4. products and categories
  const lines = db.prepare(`SELECT l.barcode, l.product_name name, l.category, SUM(l.cartons) cartons, SUM(l.amount) amount FROM odoo_invoice_lines l JOIN odoo_invoices i ON i.id = l.invoice_id
                             WHERE i.invoice_date BETWEEN ? AND ? GROUP BY l.barcode ORDER BY amount DESC`).all(r.start, r.end);
  const totalLines = lines.reduce((s, l) => s + l.amount, 0);
  const prodCols = [col('product', 'Product'), col('barcode', 'Barcode'), col('cartons', 'Cartons', 'int'), col('netSales', 'Net sales', 'ghs'), col('share', 'Share', 'pct')];
  const prodRow = (l) => ({ product: l.name, barcode: l.barcode, cartons: l.cartons, netSales: money(l.amount), share: pct(l.amount, totalLines) });
  sections.push(section('products_top', 'Top 20 products', 'By net sales; cartons alongside.', 'Odoo invoice lines', 'Focus range', prodCols, lines.slice(0, 20).map(prodRow)));
  sections.push(section('products_bottom', 'Bottom 20 products', 'The slowest sellers among products that sold this month.', 'Odoo invoice lines', 'Review C items', prodCols, [...lines].reverse().slice(0, 20).map(prodRow)));
  const byCat = new Map(); const byBrand = new Map();
  for (const l of lines) {
    const top1 = String(l.category || 'Uncategorised').split(' / ')[0];
    const c = byCat.get(top1) || { cartons: 0, amount: 0 }; c.cartons += l.cartons; c.amount += l.amount; byCat.set(top1, c);
    const brand = String(l.name || '').trim().split(/\s+/)[0] || 'Unknown';
    const b = byBrand.get(brand) || { cartons: 0, amount: 0 }; b.cartons += l.cartons; b.amount += l.amount; byBrand.set(brand, b);
  }
  const groupRows = (m, key) => [...m.entries()].sort((a, b) => b[1].amount - a[1].amount).map(([k, v]) => ({ [key]: k, cartons: v.cartons, netSales: money(v.amount), share: pct(v.amount, totalLines) }));
  sections.push(section('categories', 'Sales by category', 'Top-level Odoo category.', 'Odoo invoice lines', 'Focus range', [col('category', 'Category'), col('cartons', 'Cartons', 'int'), col('netSales', 'Net sales', 'ghs'), col('share', 'Share', 'pct')], groupRows(byCat, 'category')));
  sections.push(section('brands', 'Sales by brand', 'Brand is the first word of the product name until the Brand field is filled in Odoo.', 'Odoo invoice lines; brand field', 'Focus range', [col('brand', 'Brand'), col('cartons', 'Cartons', 'int'), col('netSales', 'Net sales', 'ghs'), col('share', 'Share', 'pct')], groupRows(byBrand, 'brand')));
  let cum = 0;
  const abc = lines.map((l) => { const before = cum; cum += l.amount; return { ...prodRow(l), abc: totalLines && before / totalLines < 0.8 ? 'A' : totalLines && before / totalLines < 0.95 ? 'B' : 'C' }; });
  const abcCount = ['A', 'B', 'C'].map((c) => ({ class: c, products: abc.filter((x) => x.abc === c).length, netSales: money(abc.filter((x) => x.abc === c).reduce((s, x) => s + x.netSales, 0)) }));
  sections.push(section('abc', 'ABC ranking', 'A = the products making the first 80% of sales, B the next 15%, C the last 5%.', 'Odoo invoice lines', 'Focus range, review C items',
    [col('class', 'Class'), col('products', 'Products', 'int'), col('netSales', 'Net sales', 'ghs')], abcCount));

  // 5. price classes
  const byClass = new Map();
  for (const [k, o] of now.entries()) { const cl = ents.get(k)?.cls || '(none)'; const x = byClass.get(cl) || { sales: 0, customers: new Set() }; x.sales += net(o); if (o.sales > 0) x.customers.add(k); byClass.set(cl, x); }
  const discByClass = new Map(db.prepare(`SELECT c.pricelist cl, COALESCE(SUM(l.discount),0) d FROM odoo_invoice_lines l JOIN odoo_invoices i ON i.id = l.invoice_id JOIN customers c ON c.id = i.customer_id WHERE i.invoice_date BETWEEN ? AND ? GROUP BY c.pricelist`).all(r.start, r.end).map((x) => [x.cl || '(none)', x.d]));
  sections.push(section('price_classes', 'Price classes', 'Net sales and number of customers per price class; discounts given.', 'Odoo invoices, sales orders, customer price class', 'Check the class mix',
    [col('class', 'Price class'), col('customers', 'Customers', 'int'), col('netSales', 'Net sales', 'ghs'), col('discounts', 'Discounts given', 'ghs')],
    [...byClass.entries()].sort((a, b) => b[1].sales - a[1].sales).map(([cl, x]) => ({ class: cl, customers: x.customers.size, netSales: money(x.sales), discounts: money(discByClass.get(cl) || 0) }))));

  // 6. BFL quotations
  const created = db.prepare("SELECT COUNT(*) n FROM odoo_orders WHERE substr(received_at,1,10) BETWEEN ? AND ?").get(r.start, r.end).n;
  const approved = db.prepare("SELECT received_at, approved_at FROM odoo_orders WHERE approved_at IS NOT NULL AND substr(approved_at,1,10) BETWEEN ? AND ?").all(r.start, r.end);
  const rejected = db.prepare("SELECT COUNT(*) n FROM odoo_orders WHERE approved_at IS NULL AND cancelled_at IS NOT NULL AND substr(cancelled_at,1,10) BETWEEN ? AND ?").get(r.start, r.end).n;
  const waiting = db.prepare(`SELECT COUNT(*) n FROM odoo_orders WHERE substr(received_at,1,10) <= ? AND (approved_at IS NULL OR substr(approved_at,1,10) > ?) AND (cancelled_at IS NULL OR substr(cancelled_at,1,10) > ?)`).get(r.end, r.end, r.end).n;
  const hours = approved.map((o) => (new Date(o.approved_at) - new Date(o.received_at)) / 3_600_000);
  sections.push(section('quotations', 'BFL quotations', 'Created, approved, rejected and still waiting; median time from submission to approval.', 'BFL outbox; Odoo sales orders', 'Speed up approvals',
    [col('measure', 'Measure'), col('value', 'Value')],
    [{ measure: 'Created', value: created }, { measure: 'Approved', value: approved.length }, { measure: 'Rejected (cancelled before approval)', value: rejected }, { measure: 'Still waiting at month end', value: waiting },
      { measure: 'Median hours from submission to approval', value: hours.length ? Math.round(median(hours) * 10) / 10 : null }]));

  // 7. lost demand
  sections.push(section('lost_demand', 'Lost demand', 'Cartons customers wanted but could not order because stock was too low, by product.', 'BFL order checks', 'Input for purchasing',
    [col('product', 'Product'), col('barcode', 'Barcode'), col('attempts', 'Times', 'int'), col('wanted', 'Cartons wanted', 'int'), col('short', 'Cartons short', 'int')],
    db.prepare(`SELECT product_name product, barcode, COUNT(*) attempts, SUM(cartons_wanted) wanted, SUM(cartons_short) short FROM order_check_log
                 WHERE kind = 'LOW_STOCK' AND substr(at,1,10) BETWEEN ? AND ? GROUP BY barcode ORDER BY short DESC LIMIT 50`).all(r.start, r.end)));

  // 8. money owed by age
  const dayN = r.endDay;
  const byCust = new Map();
  for (const o of openAt(db, r.end)) {
    const late = dayN - toDay(o.due_date);
    const band = late <= 0 ? 'notDue' : late <= 30 ? 'd30' : late <= 60 ? 'd60' : late <= 90 ? 'd90' : 'over90';
    const x = byCust.get(o.customer_id) || { notDue: 0, d30: 0, d60: 0, d90: 0, over90: 0, total: 0 };
    x[band] += o.due; x.total += o.due; byCust.set(o.customer_id, x);
  }
  sections.push(section('owed_by_age', 'Money owed by age', 'Unpaid invoices per customer at month end, in bands of days overdue.', 'Odoo invoices', 'Collection calls',
    [col('customer', 'Customer'), col('rep', 'Rep'), col('notDue', 'Not due', 'ghs'), col('d30', '1–30', 'ghs'), col('d60', '31–60', 'ghs'), col('d90', '61–90', 'ghs'), col('over90', 'Over 90', 'ghs'), col('total', 'Total', 'ghs')],
    [...byCust.entries()].sort((a, b) => b[1].total - a[1].total).map(([id, x]) => ({ customer: ents.get(`BFL:${id}`)?.name, rep: ents.get(`BFL:${id}`)?.rep || '', notDue: money(x.notDue), d30: money(x.d30), d60: money(x.d60), d90: money(x.d90), over90: money(x.over90), total: money(x.total) }))));

  // 9. credit limits
  const owedNow = new Map([...byCust.entries()].map(([id, x]) => [id, x.total]));
  sections.push(section('credit_over', 'Customers over their credit limit', 'Owed at month end against the limit Odoo holds today.', 'Odoo customers', 'Review limits',
    [col('customer', 'Customer'), col('rep', 'Rep'), col('limit', 'Credit limit', 'ghs'), col('owed', 'Owed', 'ghs'), col('over', 'Over by', 'ghs')],
    db.prepare('SELECT customer_id id, credit_limit FROM odoo_customer_finance WHERE credit_limit IS NOT NULL').all()
      .map((f) => ({ f, owed: owedNow.get(f.id) || 0 })).filter((x) => x.owed > x.f.credit_limit).sort((a, b) => (b.owed - b.f.credit_limit) - (a.owed - a.f.credit_limit))
      .map(({ f, owed }) => ({ customer: ents.get(`BFL:${f.id}`)?.name, rep: ents.get(`BFL:${f.id}`)?.rep || '', limit: f.credit_limit, owed: money(owed), over: money(owed - f.credit_limit) }))));
  sections.push(section('credit_blocked', 'Orders blocked by the credit check', 'Requests refused in the month because they would go over available credit.', 'BFL credit check log', 'Review limits',
    [col('customer', 'Customer'), col('rep', 'Rep'), col('times', 'Times blocked', 'int'), col('value', 'Value refused', 'ghs')],
    db.prepare(`SELECT customer_id id, COUNT(*) n, COALESCE(SUM(order_value),0) v FROM order_check_log WHERE kind = 'CREDIT' AND substr(at,1,10) BETWEEN ? AND ? GROUP BY customer_id ORDER BY n DESC`).all(r.start, r.end)
      .map((x) => ({ customer: ents.get(`BFL:${x.id}`)?.name || 'Unknown', rep: ents.get(`BFL:${x.id}`)?.rep || '', times: x.n, value: money(x.v) }))));

  // 10. returns and credit notes
  const rn = db.prepare(`SELECT n.kind, n.amount, n.customer_name cust, n.rep_name rep, c.reason, (SELECT COALESCE(SUM(cartons),0) FROM odoo_return_lines WHERE return_id = n.return_id) cartons
                           FROM odoo_credit_notes n LEFT JOIN return_classifications c ON c.return_id = n.return_id WHERE n.issued_on BETWEEN ? AND ?`).all(r.start, r.end);
  const reasonOf = (x) => (x.kind === 'DISCOUNT' ? 'Expiry discount (no return)' : x.kind === 'RETURN' ? (x.reason ? REASON_LABEL[x.reason] : 'Not classified yet') : 'Other credit notes');
  const group = (keyFn, label) => { const m = new Map(); for (const x of rn) { const k = keyFn(x) || '(none)'; const g = m.get(k) || { n: 0, value: 0, cartons: 0 }; g.n += 1; g.value += x.amount; g.cartons += x.cartons || 0; m.set(k, g); } return [...m.entries()].sort((a, b) => b[1].value - a[1].value).map(([k, g]) => ({ [label]: k, count: g.n, cartons: g.cartons, value: money(g.value) })); };
  const rcols = (label, text) => [col(label, text), col('count', 'Credit notes', 'int'), col('cartons', 'Cartons returned', 'int'), col('value', 'Value', 'ghs')];
  sections.push(section('returns_reason', 'Returns and credit notes — by reason', 'Count and GHS value by reason (damaged, expired, other). The reason is recorded in BFL on the Returns screen.', 'Odoo credit notes and returns; reasons from BFL', 'Fix the causes', rcols('reason', 'Reason'), group(reasonOf, 'reason')));
  sections.push(section('returns_customer', 'Returns and credit notes — by customer', '', 'Odoo credit notes and returns', 'Fix the causes', rcols('customer', 'Customer'), group((x) => x.cust, 'customer')));
  sections.push(section('returns_rep', 'Returns and credit notes — by rep', '', 'Odoo credit notes and returns', 'Fix the causes', rcols('rep', 'Rep'), group((x) => x.rep, 'rep')));
  return { sections };
}

// ---------------------------------------------------------------------------------------------
// Report 3 — the Warehouse report: stock, expiry and fulfilment (cartons; money only as a sales value)
// ---------------------------------------------------------------------------------------------
const top1 = (p) => String(p || 'Uncategorised').split(' / ')[0];

/** Take (or refresh) today's stock snapshot by top-level category, so month-end figures can be read back later. */
export function takeStockSnapshot(db, todayStr) {
  const rows = db.prepare('SELECT odoo_category_path p, COALESCE(on_hand,0) oh, COALESCE(free_to_use,0) fr FROM products WHERE is_active = 1').all();
  const by = new Map();
  for (const r of rows) { const k = top1(r.p); const x = by.get(k) || { oh: 0, fr: 0 }; x.oh += r.oh; x.fr += r.fr; by.set(k, x); }
  const up = db.prepare(`INSERT INTO stock_snapshots (snap_on, category, on_hand, free) VALUES (?,?,?,?)
                         ON CONFLICT(snap_on, category) DO UPDATE SET on_hand = excluded.on_hand, free = excluded.free`);
  for (const [k, x] of by) up.run(todayStr, k, Math.round(x.oh * 100) / 100, Math.round(x.fr * 100) / 100);
  return by.size;
}

/** Stock by category at the end of a month: the latest snapshot on or before it (live, for the month in progress). */
function stockAt(db, month, todayStr) {
  const end = range(month).end;
  if (end >= todayStr) {
    const live = new Map();
    for (const r of db.prepare('SELECT odoo_category_path p, COALESCE(on_hand,0) oh, COALESCE(free_to_use,0) fr FROM products WHERE is_active = 1').all()) {
      const k = top1(r.p); const x = live.get(k) || { onHand: 0, free: 0 }; x.onHand += r.oh; x.free += r.fr; live.set(k, x);
    }
    return { live: true, byCat: live };
  }
  const snap = db.prepare('SELECT MAX(snap_on) d FROM stock_snapshots WHERE snap_on <= ?').get(end).d;
  if (!snap) return { live: false, byCat: null };
  return { live: false, asOf: snap, byCat: new Map(db.prepare('SELECT category, on_hand, free FROM stock_snapshots WHERE snap_on = ?').all(snap).map((r) => [r.category, { onHand: r.on_hand, free: r.free }])) };
}

function warehouseReport(db, month, todayStr) {
  const r = range(month);
  const sections = [];

  // 1. stock by category
  const cur = stockAt(db, month, todayStr);
  const prev = stockAt(db, shiftMonth(month, -1), todayStr);
  const cats = new Set([...(cur.byCat?.keys() || []), ...(prev.byCat?.keys() || [])]);
  sections.push(section('stock_by_category', 'Stock by category', `Cartons on hand and free to sell at month end${cur.live ? ' (today, for the month in progress)' : cur.asOf ? ` (snapshot of ${cur.asOf})` : ' (no snapshot for that date)'}, against last month.`,
    'Odoo stock', 'Spot build-ups',
    [col('category', 'Category'), col('onHand', 'On hand', 'int'), col('free', 'Free to sell', 'int'), col('lastMonth', 'On hand last month', 'int'), col('change', 'Change', 'int')],
    [...cats].sort().map((k) => { const a = cur.byCat?.get(k); const b = prev.byCat?.get(k); return { category: k, onHand: a ? Math.round(a.onHand) : null, free: a ? Math.round(a.free) : null, lastMonth: b ? Math.round(b.onHand) : null, change: a && b ? Math.round(a.onHand - b.onHand) : null }; })));

  // delivered cartons per product over the 90 days to month end
  const from = formatDay(r.endDay - 89);
  const delivered = new Map(db.prepare(`SELECT l.barcode, SUM(l.cartons) c FROM odoo_invoice_lines l JOIN odoo_invoices i ON i.id = l.invoice_id WHERE i.invoice_date BETWEEN ? AND ? GROUP BY l.barcode`).all(from, r.end).map((x) => [x.barcode, x.c]));
  const prods = db.prepare('SELECT barcode, name, odoo_category_path p, COALESCE(on_hand,0) oh, COALESCE(free_to_use,0) fr FROM products WHERE is_active = 1').all();

  // 2. days of stock
  const catDel = new Map(); const catOn = new Map();
  for (const p of prods) { const k = top1(p.p); catOn.set(k, (catOn.get(k) || 0) + p.oh); catDel.set(k, (catDel.get(k) || 0) + (delivered.get(p.barcode) || 0)); }
  const days = (oh, del) => (del > 0 ? Math.round((oh / (del / 90)) * 10) / 10 : null);
  sections.push(section('days_of_stock', 'Days of stock — by category', 'Cartons on hand divided by the average daily cartons delivered over the last 90 days (stock as it is today).', 'Odoo stock and delivered quantities', 'Order less of what sits too long',
    [col('category', 'Category'), col('onHand', 'On hand', 'int'), col('delivered', 'Delivered, 90 days', 'int'), col('days', 'Days of stock', 'days')],
    [...catOn.keys()].sort().map((k) => ({ category: k, onHand: Math.round(catOn.get(k)), delivered: catDel.get(k) || 0, days: days(catOn.get(k), catDel.get(k) || 0) }))));
  sections.push(section('days_of_stock_products', 'Days of stock — top 50 products', 'The 50 products delivered most in the last 90 days.', 'Odoo stock and delivered quantities', 'Order less of what sits too long',
    [col('product', 'Product'), col('barcode', 'Barcode'), col('onHand', 'On hand', 'int'), col('delivered', 'Delivered, 90 days', 'int'), col('days', 'Days of stock', 'days')],
    prods.map((p) => ({ product: p.name, barcode: p.barcode, onHand: Math.round(p.oh), delivered: delivered.get(p.barcode) || 0 })).filter((x) => x.delivered > 0).sort((a, b) => b.delivered - a.delivered).slice(0, 50)
      .map((x) => ({ ...x, days: days(x.onHand, x.delivered) }))));

  // 3. out of stock and 4. slow / dead
  sections.push(section('out_of_stock', 'Out-of-stock lines', 'Products with zero free stock that sold in the last 90 days.', 'Odoo stock and invoices', 'Reorder',
    [col('product', 'Product'), col('barcode', 'Barcode'), col('delivered', 'Delivered, 90 days', 'int')],
    prods.filter((p) => p.fr <= 0 && (delivered.get(p.barcode) || 0) > 0).map((p) => ({ product: p.name, barcode: p.barcode, delivered: delivered.get(p.barcode) })).sort((a, b) => b.delivered - a.delivered).slice(0, 100)));
  sections.push(section('slow_dead', 'Slow and dead stock', 'Products with stock but no delivery in 90 days, in cartons.', 'Odoo stock and deliveries', 'Clearance or supplier return',
    [col('product', 'Product'), col('barcode', 'Barcode'), col('category', 'Category'), col('onHand', 'On hand', 'int')],
    prods.filter((p) => p.oh > 0 && !(delivered.get(p.barcode) > 0)).sort((a, b) => b.oh - a.oh).slice(0, 100).map((p) => ({ product: p.name, barcode: p.barcode, category: top1(p.p), onHand: Math.round(p.oh) }))));

  // 5. expiry in the warehouse, 6. clearance
  const ex = buildExpiryList(db, { today: todayStr });
  const bands = ['EXPIRED', 'CRITICAL', 'WARNING', 'EARLY', 'OK', 'NO_DATE'];
  const bandText = { EXPIRED: 'Expired', CRITICAL: 'Critical', WARNING: 'Warning', EARLY: 'Early warning', OK: 'Fine', NO_DATE: 'No date' };
  sections.push(section('expiry_bands', 'Expiry in the warehouse', 'Cartons and lots in each band (the bands are the Warehouse tab\'s, per category), and decisions made against decisions still open.', 'Odoo lots and stock per lot; BFL action list', 'Clearance decisions',
    [col('band', 'Band'), col('lots', 'Lots', 'int'), col('cartons', 'Cartons', 'int'), col('done', 'Decided and done', 'int'), col('inProgress', 'In progress', 'int'), col('open', 'Still open', 'int')],
    bands.map((b) => {
      const rows = ex.rows.filter((x) => x.band === b);
      const actionable = rows.filter((x) => x.actionable);
      const done = actionable.filter((x) => x.status === 'DONE').length;
      const inProgress = actionable.filter((x) => x.status === 'IN_PROGRESS').length;
      return { band: bandText[b], lots: rows.length, cartons: rows.reduce((n, x) => n + (x.cartons || 0), 0), done, inProgress, open: actionable.length - done - inProgress };
    })));
  // Lots on the clearance location, and every lot the Sales Manager has put a customer discount on (now or earlier):
  // the cartons invoiced from it at the discount this month and the discount given, from the invoice lines.
  const everDiscounted = new Set(db.prepare("SELECT lot_key FROM lot_discounts WHERE kind = 'CLEARANCE'").all().map((x) => x.lot_key));
  const soldByLot = new Map(db.prepare(`SELECT l.barcode b, l.lot_name lot, COALESCE(SUM(l.cartons),0) n, COALESCE(SUM(l.discount),0) d
                                          FROM odoo_invoice_lines l JOIN odoo_invoices i ON i.id = l.invoice_id
                                         WHERE l.lot_name IS NOT NULL AND l.discount > 0 AND i.invoice_date BETWEEN ? AND ? GROUP BY l.barcode, l.lot_name`).all(r.start, r.end)
    .map((x) => [`${x.b}|${x.lot}`, x]));
  const clearance = ex.rows.filter((x) => x.location === 'CLEARANCE' || everDiscounted.has(x.key) || soldByLot.has(x.key));
  sections.push(section('clearance', 'Clearance results', 'Lots on the clearance location and lots with a customer discount: what is on offer, cartons left, cartons invoiced at the discount this month and the discount given.', 'Odoo invoice lines; BFL discounts', 'Is clearance working?',
    [col('product', 'Product'), col('lot', 'Lot'), col('expiry', 'Expires', 'date'), col('offer', 'Discount offered', 'pct'), col('left', 'Cartons left', 'int'), col('sold', 'Cartons sold at discount', 'int'), col('discount', 'Discount given', 'ghs')],
    clearance.map((x) => { const sold = soldByLot.get(x.key); return { product: x.productName, lot: x.lotName, expiry: x.expiryDate, offer: x.discountPct ?? null, left: x.cartons, sold: sold ? sold.n : 0, discount: sold ? money(sold.d) : 0 }; })));

  // 7. customer-shelf expiry
  const { shelf, records } = shelfRecords(db, todayStr);
  const repName = new Map(shelf.reps.map((x) => [x.id, x.name]));
  const custRep = new Map(shelf.customers.map((c) => [c.id, repName.get(c.repId)]));
  const lines = db.prepare(`SELECT v.rep_id, v.visited_on, l.record_key, l.outcome FROM shelf_visit_lines l JOIN shelf_visits v ON v.id = l.visit_id WHERE v.visited_on BETWEEN ? AND ?`).all(r.start, r.end);
  const recByKey = new Map(records.map((x) => [x.key, x]));
  const repRows = shelf.reps.map((rep) => {
    const mine = lines.filter((l) => l.rep_id === rep.id);
    const open = records.filter((x) => custRep.get(x.customerId) === rep.name && x.alerting && x.state === ShelfState.OPEN);
    const onTime = mine.filter((l) => { const rec = recByKey.get(l.record_key); return rec && rec.dueOn && toDay(l.visited_on) <= toDay(rec.dueOn) + 7; }).length;
    const count = (o) => mine.filter((l) => l.outcome === o).length;
    return { rep: rep.name, open: open.length, overdue: open.filter((x) => x.overdue).length, visited: mine.length, onTime, sold: count('SOLD_OUT'), discount: count('DISCOUNT_AGREED'), returned: count('RETURN_EXPECTED'), notChecked: count('NOT_CHECKED') };
  });
  sections.push(section('customer_shelf', 'Customer-shelf expiry', 'Alerts open now, lots visited this month and how many on time, and what the visits found, by rep.', 'BFL alerts and visits; Odoo deliveries with lots', 'Visit discipline',
    [col('rep', 'Rep'), col('open', 'Open alerts', 'int'), col('overdue', 'Overdue', 'int'), col('visited', 'Lots visited', 'int'), col('onTime', 'On time', 'int'), col('sold', 'Sold', 'int'), col('discount', 'Discount agreed', 'int'), col('returned', 'Return expected', 'int'), col('notChecked', 'Not checked', 'int')], repRows));

  // 8. shelf-life exceptions
  const mins = new Map(db.prepare('SELECT id, min_shelf_life_days d FROM customers WHERE min_shelf_life_days IS NOT NULL').all().map((c) => [c.id, c.d]));
  const accepted = new Set(db.prepare('SELECT customer_id, barcode FROM request_shelf_acceptances').all().map((a) => `${a.customer_id}|${a.barcode}`));
  const exceptions = records.filter((x) => mins.get(x.customerId) && toDay(x.expiryDate) - toDay(x.deliveredOn) < mins.get(x.customerId) && !accepted.has(`${x.customerId}|${x.barcode}`))
    .map((x) => ({ customer: shelf.customers.find((c) => c.id === x.customerId)?.name, product: x.productName, lot: x.lotName, delivered: x.deliveredOn, expiry: x.expiryDate, minimum: mins.get(x.customerId) }));
  sections.push(section('exceptions', 'Shelf-life exceptions', 'Deliveries where a lot went to a customer below their minimum shelf life without their recorded acceptance.', 'Odoo deliveries and lots; BFL acceptances', 'Prevent returns',
    [col('customer', 'Customer'), col('product', 'Product'), col('lot', 'Lot'), col('delivered', 'Delivered', 'date'), col('expiry', 'Expires', 'date'), col('minimum', 'Their minimum (days)', 'int')], exceptions));

  // 9. fulfilment
  const ful = db.prepare(`SELECT COALESCE(SUM(cartons_ordered),0) o, COALESCE(SUM(cartons_delivered),0) d FROM odoo_orders WHERE dispatched_at IS NOT NULL AND cartons_ordered IS NOT NULL AND substr(dispatched_at,1,10) BETWEEN ? AND ?`).get(r.start, r.end);
  const waits = db.prepare(`SELECT approved_at, dispatched_at FROM odoo_orders WHERE approved_at IS NOT NULL AND dispatched_at IS NOT NULL AND substr(dispatched_at,1,10) BETWEEN ? AND ?`).all(r.start, r.end)
    .map((o) => (new Date(o.dispatched_at) - new Date(o.approved_at)) / 86_400_000);
  sections.push(section('fulfilment', 'Fulfilment', 'Fill rate, and median time from order approval to truck dispatch.', 'Odoo sales orders and deliveries', 'Service level',
    [col('measure', 'Measure'), col('value', 'Value')],
    [{ measure: 'Fill rate (cartons delivered ÷ ordered)', value: ful.o ? `${pct(ful.d, ful.o)}%` : null }, { measure: 'Cartons ordered', value: ful.o }, { measure: 'Cartons delivered', value: ful.d },
      { measure: 'Median days from approval to dispatch', value: waits.length ? Math.round(median(waits) * 10) / 10 : null }]));

  // 10. returns received
  const back = db.prepare(`SELECT COALESCE(c.reason, 'UNCLASSIFIED') reason, SUM(l.cartons) cartons, COUNT(DISTINCT r.id) n FROM odoo_returns r JOIN odoo_return_lines l ON l.return_id = r.id
                             LEFT JOIN return_classifications c ON c.return_id = r.id WHERE r.received_on BETWEEN ? AND ? GROUP BY 1`).all(r.start, r.end);
  sections.push(section('returns_received', 'Returns received', 'Cartons returned by reason. Every return goes to the quarantine location, never back into sellable stock.', 'Odoo return deliveries; reasons from BFL', 'Fix the causes',
    [col('reason', 'Reason'), col('returns', 'Returns', 'int'), col('cartons', 'Cartons (moved to quarantine)', 'int')],
    back.map((b) => ({ reason: b.reason === 'UNCLASSIFIED' ? 'Not classified yet' : REASON_LABEL[b.reason], returns: b.n, cartons: b.cartons }))));
  return { sections };
}

// ---------------------------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------------------------
export const REPORTS = Object.freeze({
  CEO: { title: 'CEO monthly summary', purpose: 'One page: how the month went', recipients: 'CEO, Sales Manager, Operations', owner: 'Sales Manager' },
  SALES: { title: 'Sales Manager report', purpose: 'Named lists to act on: reps, customers, products, money owed', recipients: 'Sales Manager', owner: 'Sales Manager' },
  WAREHOUSE: { title: 'Warehouse report', purpose: 'Stock, expiry and fulfilment', recipients: 'Operations, Warehouse lead, Sales Manager', owner: 'Operations' },
});

/** Build one report for one month. For the month in progress it is month-to-date. */
export function buildReport(db, which, month, todayStr) {
  if (!REPORTS[which]) throw new ReportError('Unknown report.', 404);
  if (!isMonth(month)) throw new ReportError('Choose a month.');
  const body = which === 'CEO' ? ceoReport(db, month) : which === 'SALES' ? salesReport(db, month, todayStr) : warehouseReport(db, month, todayStr);
  const monthToDate = range(month).end >= todayStr;
  // A month still in progress is month-to-date: comparing it with whole months would paint everything red, so the marks wait for the month to end.
  if (monthToDate && body.measures) for (const m of body.measures) m.mark = null;
  return {
    report: which, ...REPORTS[which], month, source: 'SAMPLE', asOf: todayStr, monthToDate,
    generatedAt: new Date().toISOString(), notes: getNotes(db, which, month), measures: body.measures || null, sections: body.sections || [],
  };
}

/** CSV of one section (or of the CEO measures). A leading = + - @ is defused so a spreadsheet never runs it. */
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function sectionCsv(sec) {
  const head = sec.columns.map((c) => csvCell(c.label)).join(',');
  return `${[head, ...sec.rows.map((row) => sec.columns.map((c) => csvCell(row[c.key])).join(','))].join('\r\n')}\r\n`;
}
export function measuresCsv(measures) {
  const head = ['Measure', 'This month', 'Last month', 'Same month last year', 'Target', 'Mark'].map(csvCell).join(',');
  return `${[head, ...measures.map((m) => [m.name, m.thisMonth, m.lastMonth, m.lastYear, m.target, m.mark].map(csvCell).join(','))].join('\r\n')}\r\n`;
}

/**
 * What a sales rep may see: their own customers and figures only, for the month. Never company-wide numbers.
 * @param {string} repName  the rep's name as it is on their customers (from their login, never from the request)
 */
export function repMonth(db, repName, month, todayStr) {
  const r = range(month);
  const mine = db.prepare('SELECT id, name FROM customers WHERE salesperson = ?').all(repName);
  const ids = mine.map((c) => c.id);
  const q = (sql, ...extra) => (ids.length ? db.prepare(sql.replace('%IDS%', ids.map(() => '?').join(','))).all(...ids, ...extra) : []);
  const sales = q('SELECT customer_id id, SUM(amount) s FROM odoo_invoices WHERE customer_id IN (%IDS%) AND invoice_date BETWEEN ? AND ? GROUP BY customer_id', r.start, r.end);
  const pay = q('SELECT COALESCE(SUM(amount),0) s FROM odoo_payments WHERE customer_id IN (%IDS%) AND paid_on BETWEEN ? AND ?', r.start, r.end)[0]?.s || 0;
  const credits = q("SELECT COALESCE(SUM(amount),0) s FROM odoo_credit_notes WHERE customer_kind = 'BFL' AND CAST(customer_ref AS INTEGER) IN (%IDS%) AND issued_on BETWEEN ? AND ?", r.start, r.end)[0]?.s || 0;
  const lastInv = q('SELECT customer_id id, MAX(invoice_date) last FROM odoo_invoices WHERE customer_id IN (%IDS%) AND invoice_date <= ? GROUP BY customer_id', r.end);
  // credit notes on her shops (expiry-list customers that are not BFL customers) count against her too, as in the Sales Manager report
  const shopCredits = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM odoo_credit_notes WHERE customer_kind = 'SHELF' AND rep_name = ? AND issued_on BETWEEN ? AND ?").get(repName, r.start, r.end).s;
  const total = money(sales.reduce((s, x) => s + x.s, 0) - credits - shopCredits);
  const target = getTarget(db, 'REP', repName, 'net_sales', month);
  return {
    month, rep: repName, monthToDate: r.end >= todayStr, netSales: total, target, vsTarget: target ? pct(total, target) : null,
    activeCustomers: sales.length, customers: mine.length, collections: money(pay),
    dormant: lastInv.map((x) => ({ x, days: r.endDay - toDay(x.last) })).filter((x) => x.days >= 30).sort((a, b) => b.days - a.days)
      .map(({ x, days }) => ({ customer: mine.find((c) => c.id === x.id)?.name, lastInvoice: x.last, days })),
  };
}

export { shiftMonth, range as monthRange, fmtDay };
