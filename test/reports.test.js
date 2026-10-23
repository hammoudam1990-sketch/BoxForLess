// Monthly reports (S06): the numbers, who may open which report, and what a report may never contain.
//
// The fixture is small and hand-checked, for March 2026 (a complete month, "today" is 21 Oct 2026):
//   invoices   March: A 1000 (5 Mar), B 500 (10 Mar), D-cash 200 (12 Mar)   February: A 800, C 400   Dec 2025: E 300   March 2025: A 600
//   credit notes (March): A 100 return of expired goods against A's invoice, B 50 expiry discount
//   payments   March: A 400, B 500        February: A 800
//   so  net sales (March) = 1000+500+200 - 150 = 1550,  Feb = 1200,  Mar 2025 = 600
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import {
  buildReport, mark, sectionCsv, measuresCsv, setTarget, getTarget, saveNotes, getNotes, repMonth, isMonth, shiftMonth, takeStockSnapshot, ReportError,
} from '../src/domain/reports.js';
import { seedHistory, historyLoaded } from '../src/domain/sample-history.js';
import { SampleOdooError } from '../src/domain/sample-odoo.js';

const TODAY = '2026-10-21';
const MONTH = '2026-03';
const PHONE = '0244-SECRET-111';
const ADDRESS = '12 Private Road, Accra';

function customer(db, name, extra = {}) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries({ customer_type: 'CREDIT', pricelist: 'CLASS A (GHS)', salesperson: 'Kwame Asante', phone: PHONE, delivery_address: ADDRESS, ...extra })) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}
let n = 0;
function invoice(db, cid, date, amount, { due, lines = [], paid = 0, state } = {}) {
  n += 1;
  const number = `INV/T/${String(n).padStart(4, '0')}`;
  const id = Number(db.prepare(`INSERT INTO odoo_invoices (number, customer_id, amount, amount_due, invoice_date, due_date, state) VALUES (?,?,?,?,?,?,?)`)
    .run(number, cid, amount, amount - paid, date, due || formatPlus(date, 30), state || (amount - paid > 0 ? 'OPEN' : 'PAID')).lastInsertRowid);
  for (const l of lines) db.prepare('INSERT INTO odoo_invoice_lines (invoice_id, barcode, product_name, category, cartons, amount, discount) VALUES (?,?,?,?,?,?,?)').run(id, l.barcode, l.name, l.category, l.cartons, l.amount, l.discount || 0);
  return { id, number };
}
const formatPlus = (d, days) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const pay = (db, cid, inv, amount, date) => db.prepare('INSERT INTO odoo_payments (customer_id, invoice_id, amount, paid_on) VALUES (?,?,?,?)').run(cid, inv.id, amount, date);
let cn = 0;
function creditNote(db, { cid, name, rep = 'Kwame Asante', invoice: inv = null, returnId = null, kind, amount, date }) {
  cn += 1;
  db.prepare(`INSERT INTO odoo_credit_notes (number, customer_kind, customer_ref, customer_name, rep_name, invoice_number, return_id, kind, amount, issued_on) VALUES (?, 'BFL', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`CN/T/${cn}`, String(cid), name, rep, inv, returnId, kind, amount, date);
}

function fixture() {
  const db = freshDb();
  const A = customer(db, 'Alpha Stores'); const B = customer(db, 'Bravo Mart', { salesperson: 'Efua Owusu' }); const C = customer(db, 'Charlie Shop');
  const D = customer(db, 'Delta Cash Buyer', { customer_type: 'CASH', pricelist: 'CASH ACCOUNT (GHS)', salesperson: null }); const E = customer(db, 'Echo Traders');
  const spice = { barcode: '111', name: 'ABIDO ALL SPICE', category: 'FOOD / SPICES', cartons: 10, amount: 600 };
  const cola = { barcode: '222', name: 'COLA 500ML', category: 'DRINKS / SOFT', cartons: 5, amount: 400 };
  const iA = invoice(db, A, '2026-03-05', 1000, { lines: [spice, cola], paid: 400 }); pay(db, A, iA, 400, '2026-03-20');
  const iB = invoice(db, B, '2026-03-10', 500, { lines: [{ barcode: '333', name: 'RICE 25KG', category: 'FOOD / GRAINS', cartons: 5, amount: 500 }], paid: 500 }); pay(db, B, iB, 500, '2026-03-25');
  invoice(db, D, '2026-03-12', 200, { lines: [{ barcode: '222', name: 'COLA 500ML', category: 'DRINKS / SOFT', cartons: 2, amount: 200 }] });
  const fA = invoice(db, A, '2026-02-10', 800, { lines: [spice], paid: 800 }); pay(db, A, fA, 800, '2026-02-20');
  invoice(db, C, '2026-02-10', 400, { lines: [cola] });
  invoice(db, E, '2025-12-10', 300, { lines: [cola] });
  const lastYear = invoice(db, A, '2025-03-08', 600, { paid: 600 }); pay(db, A, lastYear, 600, '2025-03-30');
  // a return of expired goods, classified, with its credit note against A's March invoice
  const ts = new Date().toISOString();
  const ret = Number(db.prepare(`INSERT INTO odoo_returns (number, customer_kind, customer_ref, customer_name, rep_name, received_on, created_at) VALUES ('RET/T/1','BFL',?,?,?,?,?)`).run(String(A), 'Alpha Stores', 'Kwame Asante', '2026-03-15', ts).lastInsertRowid);
  db.prepare("INSERT INTO odoo_return_lines (return_id, barcode, product_name, cartons) VALUES (?, '111', 'ABIDO ALL SPICE', 4)").run(ret);
  db.prepare("INSERT INTO return_classifications (return_id, reason, classified_at) VALUES (?, 'EXPIRED', ?)").run(ret, ts);
  creditNote(db, { cid: A, name: 'Alpha Stores', invoice: iA.number, returnId: ret, kind: 'RETURN', amount: 100, date: '2026-03-18' });
  creditNote(db, { cid: B, name: 'Bravo Mart', rep: 'Efua Owusu', kind: 'DISCOUNT', amount: 50, date: '2026-03-22' });
  // orders: two confirmed in March (one dispatched short), one cancelled
  const order = (cid, amount, approved, dispatched, ordered, delivered, state = 'PAID', received = approved, cancelled = null) => {
    const req = Number(db.prepare("INSERT INTO requests (reference, customer_id, status, created_at, updated_at) VALUES (?,?, 'ACCEPTED', ?, ?)").run(`R${Math.random()}`, cid, ts, ts).lastInsertRowid);
    db.prepare(`INSERT INTO odoo_orders (request_id, customer_id, state, amount_total, cartons_ordered, cartons_delivered, received_at, approved_at, dispatched_at, cancelled_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(req, cid, state, amount, ordered, delivered, received, approved, dispatched, cancelled, ts);
  };
  order(A, 1000, '2026-03-05T09:00:00.000Z', '2026-03-07T09:00:00.000Z', 10, 10, 'PAID', '2026-03-04T09:00:00.000Z');
  order(B, 500, '2026-03-10T09:00:00.000Z', '2026-03-12T09:00:00.000Z', 10, 9, 'PAID', '2026-03-09T21:00:00.000Z');
  order(C, 9999, null, null, null, null, 'CANCELLED', '2026-03-15T09:00:00.000Z', '2026-03-16T09:00:00.000Z');
  return { db, A, B, C, D, E, iA };
}
const measure = (r, key) => r.measures.find((m) => m.key === key);
const section = (r, id) => r.sections.find((s) => s.id === id);

// ===========================================================================
// the twelve measures
// ===========================================================================
test('1. net sales is invoices minus credit notes, before tax, for the calendar month', () => {
  const { db } = fixture();
  const r = buildReport(db, 'CEO', MONTH, TODAY);
  assert.deepEqual([measure(r, 'net_sales').thisMonth, measure(r, 'net_sales').lastMonth, measure(r, 'net_sales').lastYear], [1550, 1200, 600]);
  assert.equal(r.monthToDate, false);
  assert.equal(r.measures.length, 12);
});

test('2. active, new and lapsed customers: credit customers only, the cash account is not a customer', () => {
  const { db } = fixture();
  const r = buildReport(db, 'CEO', MONTH, TODAY);
  assert.equal(measure(r, 'active_customers').thisMonth, 2, 'A and B; the cash buyer D is cash sales');
  assert.equal(measure(r, 'active_customers').lastMonth, 2, 'February: A and C');
  assert.equal(measure(r, 'new_customers').thisMonth, 1, 'B\'s first invoice is in March');
  assert.equal(measure(r, 'lapsed_customers').thisMonth, 1, 'E was invoiced in Dec, not since');
});

test('3. average order value counts orders confirmed in the month and not cancelled', () => {
  const { db } = fixture();
  assert.equal(measure(buildReport(db, 'CEO', MONTH, TODAY), 'avg_order_value').thisMonth, 750);
});

test('4. money owed at month end honours payments and linked credit notes after that day, and the over-60-days share', () => {
  const { db } = fixture();
  const r = buildReport(db, 'CEO', MONTH, TODAY);
  // A 1000 - 400 paid - 100 credited = 500; D 200; E 300; C 400
  assert.equal(measure(r, 'money_owed').thisMonth, 1400);
  assert.equal(measure(r, 'money_owed').extra, '21.4% is more than 60 days overdue', 'only E (due 9 Jan) is over 60 days: 300 of 1400');
  // a day earlier in time, before A's payment, A still owed the lot
  const early = buildReport(db, 'CEO', '2026-04', TODAY);
  assert.equal(measure(early, 'money_owed').thisMonth, 1400, 'nothing changed in April');
});

test('5. days of sales outstanding = owed ÷ the average daily net sales of the last 90 days', () => {
  const { db } = fixture();
  assert.equal(measure(buildReport(db, 'CEO', MONTH, TODAY), 'dso').thisMonth, 45.8);
});

test('6. collections are the payments received in the month', () => {
  const { db } = fixture();
  const r = buildReport(db, 'CEO', MONTH, TODAY);
  assert.deepEqual([measure(r, 'collections').thisMonth, measure(r, 'collections').lastMonth, measure(r, 'collections').lastYear], [900, 800, 600]);
});

test('7. expiry loss = expiry discounts + credit notes for goods returned as expired', () => {
  const { db } = fixture();
  assert.equal(measure(buildReport(db, 'CEO', MONTH, TODAY), 'expiry_loss').thisMonth, 150);
  // a return that was damaged, not expired, is not an expiry loss
  db.prepare("UPDATE return_classifications SET reason = 'DAMAGED'").run();
  assert.equal(measure(buildReport(db, 'CEO', MONTH, TODAY), 'expiry_loss').thisMonth, 50);
  // a clearance line discount counts too
  db.prepare("UPDATE odoo_invoice_lines SET discount = 25 WHERE id = (SELECT MIN(id) FROM odoo_invoice_lines)").run();
  assert.equal(measure(buildReport(db, 'CEO', MONTH, TODAY), 'expiry_loss').thisMonth, 75);
});

test('8. fill rate = cartons delivered ÷ ordered for orders dispatched in the month; orders through BFL says what it needs', () => {
  const { db } = fixture();
  const r = buildReport(db, 'CEO', MONTH, TODAY);
  assert.equal(measure(r, 'fill_rate').thisMonth, 95);
  const bfl = measure(r, 'orders_through_bfl');
  assert.equal(bfl.thisMonth, null);
  assert.match(bfl.unavailable, /Odoo sales orders/);
});

// ===========================================================================
// targets, marks, notes
// ===========================================================================
test('9. a target comes from the month, else the default for every month; "vs target" is blank without one', () => {
  const { db } = fixture();
  assert.equal(measure(buildReport(db, 'CEO', MONTH, TODAY), 'net_sales_vs_target').thisMonth, null);
  setTarget(db, { scope: 'COMPANY', measure: 'net_sales', month: 'DEFAULT', value: 1000 }, 'Esi');
  setTarget(db, { scope: 'COMPANY', measure: 'net_sales', month: MONTH, value: 2000 }, 'Esi');
  assert.equal(getTarget(db, 'COMPANY', '', 'net_sales', MONTH), 2000);
  assert.equal(getTarget(db, 'COMPANY', '', 'net_sales', '2026-02'), 1000);
  const r = buildReport(db, 'CEO', MONTH, TODAY);
  assert.equal(measure(r, 'net_sales_vs_target').thisMonth, 77.5);
  assert.equal(measure(r, 'net_sales_vs_target').lastMonth, 120, 'February: 1200 against the default 1000');
  assert.equal(measure(r, 'net_sales').target, 2000);
  assert.equal(measure(r, 'net_sales').against, 'target');
  assert.equal(measure(r, 'net_sales').mark, 'red', '1550 of 2000 is under 90%');
  setTarget(db, { scope: 'COMPANY', measure: 'net_sales', month: MONTH, value: '' });
  assert.equal(getTarget(db, 'COMPANY', '', 'net_sales', MONTH), 1000, 'clearing the month falls back to the default');
});

test('10. targets are validated', () => {
  const db = freshDb();
  for (const bad of [{ scope: 'EVERYONE', measure: 'net_sales', month: 'DEFAULT', value: 1 }, { scope: 'COMPANY', measure: 'margin', month: 'DEFAULT', value: 1 },
    { scope: 'COMPANY', measure: 'net_sales', month: '2026-13', value: 1 }, { scope: 'COMPANY', measure: 'net_sales', month: 'DEFAULT', value: -5 },
    { scope: 'REP', scopeValue: '', measure: 'net_sales', month: 'DEFAULT', value: 5 }, { scope: 'REP', scopeValue: 'X', measure: 'fill_rate', month: 'DEFAULT', value: 5 }]) {
    assert.throws(() => setTarget(db, bad), ReportError, JSON.stringify(bad));
  }
});

test('11. marks: green / amber / red against target, or last year without one, and the right way round for "lower is better"', () => {
  assert.equal(mark(100, 100, 'up'), 'green');
  assert.equal(mark(95, 100, 'up'), 'amber');
  assert.equal(mark(80, 100, 'up'), 'red');
  assert.equal(mark(50, 0, 'up'), 'green');
  assert.equal(mark(100, 100, 'down'), 'green');
  assert.equal(mark(105, 100, 'down'), 'amber');
  assert.equal(mark(150, 100, 'down'), 'red');
  assert.equal(mark(null, 100, 'up'), null);
  assert.equal(mark(100, null, 'up'), null, 'nothing to compare with: no colour');
});

test('12. without a target the mark is against last year, and a month in progress has no marks (it is month-to-date)', () => {
  const { db } = fixture();
  const r = buildReport(db, 'CEO', MONTH, TODAY);
  assert.equal(measure(r, 'collections').against, 'last year');
  assert.equal(measure(r, 'collections').mark, 'green', '900 against 600 last year');
  const mtd = buildReport(db, 'CEO', '2026-10', TODAY);
  assert.equal(mtd.monthToDate, true);
  assert.ok(mtd.measures.every((m) => m.mark === null));
});

test('13. the report owner\'s three lines are kept per report and month', () => {
  const db = freshDb();
  assert.deepEqual(getNotes(db, 'CEO', MONTH), { what: '', why: '', action: '', writtenBy: null, writtenAt: null });
  saveNotes(db, 'CEO', MONTH, { what: 'Sales fell', why: 'Fewer orders', action: 'Call dormant customers' }, 'Esi');
  assert.equal(getNotes(db, 'CEO', MONTH).what, 'Sales fell');
  assert.equal(getNotes(db, 'SALES', MONTH).what, '', 'another report is separate');
  saveNotes(db, 'CEO', MONTH, { what: 'x'.repeat(900), why: '', action: '' });
  assert.equal(getNotes(db, 'CEO', MONTH).what.length, 500);
  assert.throws(() => saveNotes(db, 'NOPE', MONTH, {}), ReportError);
  assert.throws(() => saveNotes(db, 'CEO', 'March', {}), ReportError);
});

// ===========================================================================
// the Sales Manager report
// ===========================================================================
test('14. sales by rep, against their own targets; top customers with their share and change', () => {
  const { db } = fixture();
  setTarget(db, { scope: 'REP', scopeValue: 'Kwame Asante', measure: 'net_sales', month: MONTH, value: 1000 });
  const r = buildReport(db, 'SALES', MONTH, TODAY);
  const kwame = section(r, 'sales_by_rep').rows.find((x) => x.rep === 'Kwame Asante');
  assert.deepEqual([kwame.netSales, kwame.active, kwame.collections, kwame.target, kwame.vsTarget], [900, 1, 400, 1000, 90]); // A: 1000 less the 100 credit note; the cash buyer has no rep
  const efua = section(r, 'sales_by_rep').rows.find((x) => x.rep === 'Efua Owusu');
  assert.deepEqual([efua.netSales, efua.collections], [450, 500]);
  const top = section(r, 'top_customers').rows;
  assert.equal(top[0].customer, 'Alpha Stores');
  assert.equal(top[0].netSales, 900);
  assert.equal(top[0].share, 58.1);
  assert.equal(top[0].vsLastMonth, 12.5, '900 against 800');
  assert.equal(top[0].vsLastYear, 50, '900 against 600');
  assert.deepEqual(top.map((x) => x.customer), ['Alpha Stores', 'Bravo Mart', 'Delta Cash Buyer']);
});

test('15. dormant customers are listed with how long, oldest first, in bands', () => {
  const { db } = fixture();
  const rows = section(buildReport(db, 'SALES', MONTH, TODAY), 'dormant').rows;
  const echo = rows.find((x) => x.customer === 'Echo Traders');
  assert.equal(echo.lastInvoice, '2025-12-10');
  assert.equal(echo.band, '90+ days');
  const charlie = rows.find((x) => x.customer === 'Charlie Shop');
  assert.equal(charlie.days, 49);
  assert.equal(charlie.band, '30+ days');
  assert.ok(!rows.some((x) => x.customer === 'Alpha Stores'), 'an active customer is not dormant');
});

test('16. products and categories: top and bottom, category, brand and the ABC ranking', () => {
  const { db } = fixture();
  const r = buildReport(db, 'SALES', MONTH, TODAY);
  const top = section(r, 'products_top').rows;
  assert.deepEqual(top.map((x) => x.netSales), [600, 600, 500]);
  assert.equal(section(r, 'products_bottom').rows[0].product, 'RICE 25KG');
  assert.equal(top.find((x) => x.product === 'COLA 500ML').cartons, 7, 'cartons add up across invoices');
  const cats = Object.fromEntries(section(r, 'categories').rows.map((x) => [x.category, x.netSales]));
  assert.deepEqual(cats, { FOOD: 1100, DRINKS: 600 });
  const brands = Object.fromEntries(section(r, 'brands').rows.map((x) => [x.brand, x.netSales]));
  assert.equal(brands.ABIDO, 600, 'brand = the first word of the name until the Brand field is filled');
  const abc = section(r, 'abc').rows;
  assert.equal(abc.reduce((s, x) => s + x.products, 0), 3);
  assert.equal(abc.reduce((s, x) => s + x.netSales, 0), 1700);
});

test('17. price classes, BFL quotations, lost demand and credit blocks', () => {
  const { db, A, B } = fixture();
  const ts = (d) => `${d}T10:00:00.000Z`;
  const log = db.prepare('INSERT INTO order_check_log (customer_id, kind, barcode, product_name, cartons_wanted, cartons_short, order_value, available_credit, at) VALUES (?,?,?,?,?,?,?,?,?)');
  log.run(A, 'LOW_STOCK', '111', 'ABIDO ALL SPICE', 10, 4, null, null, ts('2026-03-04'));
  log.run(B, 'LOW_STOCK', '111', 'ABIDO ALL SPICE', 6, 6, null, null, ts('2026-03-20'));
  log.run(A, 'LOW_STOCK', '111', 'ABIDO ALL SPICE', 5, 5, null, null, ts('2026-04-02'));   // another month
  log.run(A, 'CREDIT', null, null, null, null, 4200, 1500, ts('2026-03-09'));
  const r = buildReport(db, 'SALES', MONTH, TODAY);
  const cls = section(r, 'price_classes').rows;
  assert.equal(cls.find((x) => x.class === 'CLASS A (GHS)').netSales, 1350, 'A, B, C… invoices less credits: 1000+500-150');
  assert.equal(cls.find((x) => x.class === 'CASH ACCOUNT (GHS)').netSales, 200);
  const q = Object.fromEntries(section(r, 'quotations').rows.map((x) => [x.measure, x.value]));
  assert.equal(q.Created, 3);
  assert.equal(q.Approved, 2);
  assert.equal(q['Rejected (cancelled before approval)'], 1);
  assert.equal(q['Median hours from submission to approval'], 18, '24 hours and 12 hours: the median is 18');
  const lost = section(r, 'lost_demand').rows;
  assert.deepEqual([lost[0].attempts, lost[0].wanted, lost[0].short], [2, 16, 10], 'only March, summed');
  const blocked = section(r, 'credit_blocked').rows;
  assert.deepEqual([blocked[0].customer, blocked[0].times, blocked[0].value], ['Alpha Stores', 1, 4200]);
});

test('18. money owed by age in bands per customer, and customers over their limit', () => {
  const { db, C } = fixture();
  db.prepare('INSERT INTO odoo_customer_finance (customer_id, credit_limit, amount_owed, overdue, updated_at) VALUES (?,?,?,?,?)').run(C, 300, 0, 0, new Date().toISOString());
  const r = buildReport(db, 'SALES', MONTH, TODAY);
  const rows = Object.fromEntries(section(r, 'owed_by_age').rows.map((x) => [x.customer, x]));
  assert.equal(rows['Echo Traders'].over90, 0, '81 days overdue is in 61–90');
  assert.equal(rows['Echo Traders'].d90, 300);
  assert.equal(rows['Charlie Shop'].d30, 400, '19 days overdue');
  assert.equal(rows['Alpha Stores'].notDue, 500);
  assert.equal(rows['Alpha Stores'].total, 500);
  const over = section(r, 'credit_over').rows;
  assert.deepEqual(over.map((x) => [x.customer, x.limit, x.owed, x.over]), [['Charlie Shop', 300, 400, 100]]);
});

test('19. returns and credit notes by reason, customer and rep', () => {
  const { db } = fixture();
  const r = buildReport(db, 'SALES', MONTH, TODAY);
  const by = Object.fromEntries(section(r, 'returns_reason').rows.map((x) => [x.reason, x]));
  assert.deepEqual([by.Expired.count, by.Expired.cartons, by.Expired.value], [1, 4, 100]);
  assert.deepEqual([by['Expiry discount (no return)'].count, by['Expiry discount (no return)'].value], [1, 50]);
  assert.equal(section(r, 'returns_customer').rows.find((x) => x.customer === 'Alpha Stores').value, 100);
  assert.equal(section(r, 'returns_rep').rows.find((x) => x.rep === 'Efua Owusu').value, 50);
});

// ===========================================================================
// the Warehouse report
// ===========================================================================
test('20. stock by category reads the month-end snapshot against the month before; days of stock, out of stock and slow stock come from delivered cartons', () => {
  const { db } = fixture();
  const ts = new Date().toISOString();
  const prod = db.prepare('INSERT INTO products (barcode, name, box_uom, on_hand, free_to_use, odoo_category_path, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)');
  prod.run('111', 'ABIDO ALL SPICE', 'CTN', 90, 80, 'FOOD / SPICES', ts, ts);
  prod.run('222', 'COLA 500ML', 'CTN', 0, 0, 'DRINKS / SOFT', ts, ts);
  prod.run('999', 'DUSTY TINS', 'CTN', 40, 40, 'FOOD / CANNED', ts, ts);
  const snap = db.prepare('INSERT INTO stock_snapshots (snap_on, category, on_hand, free) VALUES (?,?,?,?)');
  snap.run('2026-03-31', 'FOOD', 200, 150); snap.run('2026-02-28', 'FOOD', 260, 200); snap.run('2026-03-31', 'DRINKS', 30, 20);
  const r = buildReport(db, 'WAREHOUSE', MONTH, TODAY);
  const food = section(r, 'stock_by_category').rows.find((x) => x.category === 'FOOD');
  assert.deepEqual([food.onHand, food.free, food.lastMonth, food.change], [200, 150, 260, -60]);
  const out = section(r, 'out_of_stock').rows;
  assert.deepEqual(out.map((x) => x.product), ['COLA 500ML'], 'no free stock, and it sold in the 90 days to month end (Cola 5 + 2 cartons)');
  const slow = section(r, 'slow_dead').rows.map((x) => x.product);
  assert.ok(slow.includes('DUSTY TINS') && !slow.includes('ABIDO ALL SPICE'));
  const spice = section(r, 'days_of_stock_products').rows.find((x) => x.product === 'ABIDO ALL SPICE');
  assert.equal(spice.delivered, 20, '10 (Feb) + 10 (March) cartons in the 90 days to month end');
  assert.equal(spice.days, 405, '90 on hand ÷ (20 ÷ 90 a day)');
});

test('21. fulfilment and returns received', () => {
  const { db } = fixture();
  const r = buildReport(db, 'WAREHOUSE', MONTH, TODAY);
  const ful = Object.fromEntries(section(r, 'fulfilment').rows.map((x) => [x.measure, x.value]));
  assert.equal(ful['Fill rate (cartons delivered ÷ ordered)'], '95%');
  assert.equal(ful['Median days from approval to dispatch'], 2);
  const ret = section(r, 'returns_received').rows;
  assert.deepEqual([ret[0].reason, ret[0].cartons], ['Expired', 4]);
});

test('22. the warehouse report carries money only as sales values, and no cost, margin or stock value anywhere', () => {
  const { db } = fixture();
  for (const which of ['CEO', 'SALES', 'WAREHOUSE']) {
    const text = JSON.stringify(buildReport(db, which, MONTH, TODAY));
    assert.ok(!/margin|standard_price|cost_price|"cost"|valuation|supplier_price/i.test(text.replace(/"hint":"[^"]*"/g, '')), `${which} contains a cost word`);
  }
});

// ===========================================================================
// what a report may not contain; CSV
// ===========================================================================
test('23. no report holds a phone number or an address', () => {
  const { db } = fixture();
  for (const which of ['CEO', 'SALES', 'WAREHOUSE']) {
    const text = JSON.stringify(buildReport(db, which, MONTH, TODAY)) + JSON.stringify(repMonth(db, 'Kwame Asante', MONTH, TODAY));
    assert.ok(!text.includes(PHONE) && !text.includes('Private Road'), which);
  }
});

test('24. CSV: every section downloads, the header is the labels, and a leading = + - @ is defused', () => {
  const { db } = fixture();
  customer(db, '=HYPERLINK("http://x")', {});
  db.prepare("INSERT INTO odoo_invoices (number, customer_id, amount, amount_due, invoice_date, due_date, state) VALUES ('INV/X', (SELECT MAX(id) FROM customers), 900, 900, '2026-03-02', '2026-04-01', 'OPEN')").run();
  const r = buildReport(db, 'SALES', MONTH, TODAY);
  const csv = sectionCsv(section(r, 'top_customers'));
  assert.equal(csv.split('\r\n')[0], 'Customer,Rep,Net sales,Share of total,vs last month,vs last year');
  assert.ok(csv.includes("'=HYPERLINK"), 'a customer name starting with = is not a formula');
  assert.ok(measuresCsv(buildReport(db, 'CEO', MONTH, TODAY).measures).startsWith('Measure,This month,Last month,Same month last year,Target,Mark'));
  for (const s of r.sections) assert.ok(sectionCsv(s).endsWith('\r\n'));
});

test('25. a sales rep sees only their own customers and figures', () => {
  const { db } = fixture();
  const kwame = repMonth(db, 'Kwame Asante', MONTH, TODAY);
  assert.deepEqual([kwame.netSales, kwame.activeCustomers, kwame.collections], [900, 1, 400], 'A only (C, D, E have Kwame as rep but did not buy... A is the only active)');
  assert.deepEqual(kwame.dormant.map((x) => x.customer).sort(), ['Charlie Shop', 'Echo Traders']);
  const efua = repMonth(db, 'Efua Owusu', MONTH, TODAY);
  assert.deepEqual([efua.netSales, efua.activeCustomers, efua.customers], [450, 1, 1]);
  assert.ok(!JSON.stringify(efua).includes('Alpha'), 'no other rep\'s customer');
  assert.equal(repMonth(db, 'Nobody', MONTH, TODAY).customers, 0);
});

test('26. month helpers', () => {
  assert.ok(isMonth('2026-03') && !isMonth('2026-13') && !isMonth('2026-3') && !isMonth('March'));
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-11', 3), '2027-02');
});

// ===========================================================================
// sample history
// ===========================================================================
test('27. sample history fills fourteen months once, and every report then has numbers to compare', () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  for (let i = 0; i < 40; i += 1) db.prepare('INSERT INTO products (barcode, name, box_uom, on_hand, free_to_use, odoo_category_path, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)').run(`50${i}`, `PRODUCT ${i}`, 'CTN', 50 + i, 40 + i, i % 2 ? 'FOOD / SPICES' : 'DRINKS / SOFT', ts, ts);
  assert.throws(() => seedHistory(db, TODAY), (e) => e instanceof SampleOdooError && /three credit customers/.test(e.message));
  for (let i = 0; i < 6; i += 1) customer(db, `Sample Co ${i}`, { salesperson: null });
  const out = seedHistory(db, TODAY);
  assert.ok(out.orders > 100 && out.invoices === out.orders);
  assert.equal(historyLoaded(db), true);
  assert.throws(() => seedHistory(db, TODAY), (e) => e.status === 409);
  const r = buildReport(db, 'CEO', '2026-09', TODAY);
  assert.ok(measure(r, 'net_sales').thisMonth > 0 && measure(r, 'net_sales').lastMonth > 0 && measure(r, 'net_sales').lastYear > 0);
  assert.ok(measure(r, 'fill_rate').thisMonth > 90);
  const w = buildReport(db, 'WAREHOUSE', '2026-09', TODAY);
  assert.ok(section(w, 'stock_by_category').rows.some((x) => x.lastMonth !== null), 'month-end stock exists');
  assert.ok(db.prepare("SELECT COUNT(*) n FROM customers WHERE salesperson IS NOT NULL").get().n >= 6, 'reps were filled where blank');
  // the numbers add up: invoice lines equal their invoice
  const bad = db.prepare('SELECT COUNT(*) n FROM odoo_invoices i WHERE ABS(i.amount - (SELECT SUM(amount) FROM odoo_invoice_lines WHERE invoice_id = i.id)) > 0.01').get().n;
  assert.equal(bad, 0);
});

// ===========================================================================
// over the web: who may open what
// ===========================================================================
test('28. the reports API: roles, targets, notes and CSV', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.BFL_STAFF_USERNAME = 'owner'; process.env.BFL_STAFF_PASSWORD = 'owner-secret-passphrase'; process.env.BFL_SESSION_SECRET = 'x'.repeat(40);
  try {
    const { db } = fixture();
    const staff = await import('../src/domain/staff-accounts.js');
    const { resetStaffAttempts } = await import('../src/server/staff-auth.js');
    const mk = (role, extra = {}) => {
      const { user, temporaryPassword } = staff.createStaffUser(db, { name: role, email: `${role.toLowerCase()}@bfl.test`, role, repId: role === 'SALES_REP' ? 'rep-1' : undefined, ...extra }, 'ADMIN');
      staff.changeStaffPassword(db, user.id, temporaryPassword, 'a long enough password');
    };
    ['SALES_MANAGER', 'SALES_REP', 'WAREHOUSE'].forEach((r) => mk(r));
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (id, pw = 'a long enough password') => {
      resetStaffAttempts();
      const res = await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: id, password: pw }) });
      assert.equal(res.status, 200);
      return res.headers.getSetCookie().join('; ').split(';')[0];
    };
    const get = (path, cookie) => fetch(base + path, { headers: { cookie } });
    const put = (path, cookie, body) => fetch(base + path, { method: 'PUT', headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    try {
      const mgr = await login('sales_manager@bfl.test'); const rep = await login('sales_rep@bfl.test'); const wh = await login('warehouse@bfl.test'); const admin = await login('owner', 'owner-secret-passphrase');
      const status = async (path, cookie) => (await get(path, cookie)).status;
      for (const [cookie, ceo, sales, warehouse] of [[mgr, 200, 200, 200], [admin, 200, 200, 200], [wh, 403, 403, 200], [rep, 403, 403, 403]]) {
        assert.equal(await status(`/api/reports/report?report=CEO&month=${MONTH}`, cookie), ceo);
        assert.equal(await status(`/api/reports/report?report=SALES&month=${MONTH}`, cookie), sales);
        assert.equal(await status(`/api/reports/report?report=WAREHOUSE&month=${MONTH}`, cookie), warehouse);
      }
      assert.equal(await status(`/api/reports/csv?report=SALES&month=${MONTH}&section=top_customers`, rep), 403);
      assert.equal(await status(`/api/reports/targets`, wh), 403, 'only managers set targets');
      assert.equal(await status(`/api/reports/report?report=CEO&month=${MONTH}`, ''), 401);

      const csv = await get(`/api/reports/csv?report=CEO&month=${MONTH}&section=measures`, mgr);
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-type'), /text\/csv/);
      assert.match(csv.headers.get('content-disposition'), /ceo-2026-03-measures\.csv/);

      assert.equal((await put('/api/reports/targets', mgr, { scope: 'COMPANY', measure: 'net_sales', month: MONTH, value: 2000 })).status, 200);
      assert.equal((await put('/api/reports/targets', wh, { scope: 'COMPANY', measure: 'net_sales', month: MONTH, value: 1 })).status, 403);
      assert.equal(((await (await get(`/api/reports/report?report=CEO&month=${MONTH}`, mgr)).json()).measures.find((m) => m.key === 'net_sales_vs_target')).thisMonth, 77.5);

      // notes: managers write the CEO and Sales reports', the warehouse writes its own
      assert.equal((await put('/api/reports/notes', mgr, { report: 'CEO', month: MONTH, what: 'a', why: 'b', action: 'c' })).status, 200);
      assert.equal((await put('/api/reports/notes', wh, { report: 'CEO', month: MONTH, what: 'x' })).status, 403);
      assert.equal((await put('/api/reports/notes', wh, { report: 'WAREHOUSE', month: MONTH, what: 'stock fine' })).status, 200);
      assert.equal((await put('/api/reports/notes', mgr, { report: 'WAREHOUSE', month: MONTH, what: 'x' })).status, 403, 'the report owner for the warehouse report is Operations');
      assert.equal((await (await get(`/api/reports/report?report=CEO&month=${MONTH}`, mgr)).json()).notes.what, 'a');

      // the start screen lists only what this person may open
      assert.deepEqual((await (await get('/api/reports', wh)).json()).reports.map((r) => r.key), ['WAREHOUSE']);
      assert.deepEqual((await (await get('/api/reports', mgr)).json()).reports.map((r) => r.key), ['CEO', 'SALES', 'WAREHOUSE']);

      // a rep gets only /my, from their own login (rep-1 = Kwame Asante) — never a name from the request
      const mine = await (await get(`/api/reports/my?month=${MONTH}&rep=Efua%20Owusu`, rep)).json();
      assert.equal(mine.rep, 'Kwame Asante');
      assert.ok(!JSON.stringify(mine).includes('Bravo'));
      assert.equal(await status('/api/reports/my', mgr), 403);
    } finally { server.close(); }
  } finally { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; }
});

test('29. the report code reads no cost data and deletes nothing', () => {
  for (const f of ['src/domain/reports.js', 'src/server/routes/reports.js', 'src/domain/sample-history.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/standard_price|cost_price|\bcost\b|valuation|supplier_price/i.test(src), f);
  }
  const src = fs.readFileSync(new URL('../src/domain/reports.js', import.meta.url), 'utf8');
  assert.ok(!/\bDELETE\s+FROM\s+(?!report_targets)/i.test(src), 'reports delete nothing except a cleared target');
});

test('30. taking a stock snapshot twice in a day keeps one row per category', () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO products (barcode, name, box_uom, on_hand, free_to_use, odoo_category_path, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)').run('1', 'A', 'CTN', 10, 8, 'FOOD / X', ts, ts);
  takeStockSnapshot(db, '2026-10-21');
  db.prepare('UPDATE products SET on_hand = 12').run();
  takeStockSnapshot(db, '2026-10-21');
  assert.deepEqual(db.prepare('SELECT category, on_hand FROM stock_snapshots').all().map((r) => ({ ...r })), [{ category: 'FOOD', on_hand: 12 }]);
});
