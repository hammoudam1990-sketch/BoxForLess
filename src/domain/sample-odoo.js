// A STAND-IN for Odoo, so the whole order journey can be tested before Odoo is connected.
//
// In the real system none of this exists in BFL. The people below act in ODOO — the outbox worker
// sends the quotation, the Sales Manager confirms it, the warehouse validates the delivery,
// Finance posts the invoice and records the payment — and BFL's sync only READS the result into
// the same tables (`odoo_orders`, `odoo_invoices`, `odoo_payments`, `odoo_customer_finance`) that
// this module fills. BFL itself must never confirm, send or cancel an order, or write an invoice or
// a payment; that is why this module is separate, is reachable only from a staff-only
// "Sample Odoo" screen, and switches itself off the moment the real connection is declared
// (`BFL_ODOO_CONNECTED=1`). Delete it when the sync is accepted.
import { OrderState, openOrdersValue } from './orders.js';
import { OutboxStatus } from './outbox.js';
import { cartonPriceFor, priceClassOf, DEFAULT_PRICE_CLASS } from './prices.js';
import { loadShelf } from './shelf.js';
import { toDay } from './expiry.js';

export const SAMPLE_CREDIT_LIMIT = 10000;
export const PAYMENT_TERMS_DAYS = 30;

export class SampleOdooError extends Error {
  constructor(message, status = 409) { super(message); this.name = 'SampleOdooError'; this.status = status; }
}

/** Off as soon as the real Odoo connection is declared. */
export const sampleOdooEnabled = () => process.env.BFL_ODOO_CONNECTED !== '1';

const dayOf = (date) => date.toISOString().slice(0, 10);
const addDays = (date, n) => new Date(date.getTime() + n * 86_400_000);
const money = (n) => Math.round(n * 100) / 100;

function getOrder(db, id) {
  const o = db.prepare('SELECT * FROM odoo_orders WHERE id = ?').get(Number(id));
  if (!o) throw new SampleOdooError('That order does not exist.', 404);
  return o;
}

function mustBe(order, ...states) {
  if (!states.includes(order.state)) {
    throw new SampleOdooError(`This order is ${order.state.toLowerCase().replaceAll('_', ' ')}; that step is not possible now.`);
  }
}

function move(db, order, state, stampColumn, now, extra = {}) {
  const ts = now.toISOString();
  const sets = ['state = ?', 'updated_at = ?'];
  const args = [state, ts];
  if (stampColumn) { sets.push(`${stampColumn} = ?`); args.push(ts); }
  for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); args.push(v); }
  db.prepare(`UPDATE odoo_orders SET ${sets.join(', ')} WHERE id = ?`).run(...args, order.id);
}

/** The next number with this prefix, e.g. S00012 or INV/2026/0003. */
export function nextNumber(db, table, column, prefix, width) {
  const last = db.prepare(`SELECT ${column} AS n FROM ${table} WHERE ${column} LIKE ? ORDER BY ${column} DESC LIMIT 1`).get(`${prefix}%`)?.n;
  const seq = last ? Number(String(last).slice(prefix.length)) : 0;
  return `${prefix}${String((Number.isFinite(seq) ? seq : 0) + 1).padStart(width, '0')}`;
}

/**
 * The lines Odoo would invoice: cartons × the customer's carton price, in their price class. A line with clearance
 * cartons becomes two, as on the quotation: the ordinary cartons, and the clearance cartons at the discount, which
 * name their lot and record the discount given (GHS).
 */
function orderLines(db, order) {
  const cls = priceClassOf(db, order.customer_id) || DEFAULT_PRICE_CLASS;
  return db.prepare(`SELECT i.barcode_at_request AS barcode, i.product_name_at_request AS name, i.quantity_ctn AS cartons, p.odoo_category_path AS category,
                              i.clearance_cartons AS cc, i.clearance_pct AS pct, i.clearance_lot_name AS lot
                       FROM request_items i LEFT JOIN products p ON p.id = i.product_id WHERE i.request_id = ? ORDER BY i.id`).all(order.request_id)
    .flatMap((l) => {
      const price = cartonPriceFor(l.barcode, cls) ?? 0;
      const c = l.cc || 0;
      const out = [];
      if (l.cartons - c > 0) out.push({ barcode: l.barcode, name: l.name, category: l.category, cartons: l.cartons - c, amount: money(price * (l.cartons - c)), discount: 0, lot: null });
      if (c > 0) out.push({ barcode: l.barcode, name: l.name, category: l.category, cartons: c, amount: money(price * c * (1 - l.pct / 100)), discount: money(price * c * (l.pct / 100)), lot: l.lot });
      return out;
    });
}
function orderValue(db, order) {
  return money(orderLines(db, order).reduce((sum, l) => sum + l.amount, 0));
}

function financeRow(db, customerId, now) {
  const c = db.prepare('SELECT customer_type FROM customers WHERE id = ?').get(customerId);
  if (!db.prepare('SELECT 1 FROM odoo_customer_finance WHERE customer_id = ?').get(customerId)) {
    db.prepare('INSERT INTO odoo_customer_finance (customer_id, credit_limit, amount_owed, overdue, updated_at) VALUES (?,?,0,0,?)')
      .run(customerId, c?.customer_type === 'CASH' ? null : SAMPLE_CREDIT_LIMIT, now.toISOString());
  }
}

/** What Odoo would report after any money movement: what is owed and what is past due. */
export function recomputeFinance(db, customerId, now) {
  financeRow(db, customerId, now);
  const today = dayOf(now);
  const owed = db.prepare("SELECT COALESCE(SUM(amount_due),0) s FROM odoo_invoices WHERE customer_id = ? AND state = 'OPEN'").get(customerId).s;
  const overdue = db.prepare("SELECT COALESCE(SUM(amount_due),0) s FROM odoo_invoices WHERE customer_id = ? AND state = 'OPEN' AND due_date < ?").get(customerId, today).s;
  db.prepare('UPDATE odoo_customer_finance SET amount_owed = ?, overdue = ?, updated_at = ? WHERE customer_id = ?')
    .run(money(owed), money(overdue), now.toISOString(), customerId);
}

/** Everything the Sample Odoo screen shows. */
export function overview(db) {
  const orders = db.prepare(`SELECT o.id, o.odoo_number, o.state, o.amount_total, o.received_at, o.updated_at, r.reference, c.name AS customer, c.customer_type
                               FROM odoo_orders o JOIN requests r ON r.id = o.request_id LEFT JOIN customers c ON c.id = o.customer_id
                              ORDER BY o.id DESC LIMIT 100`).all();
  const invoices = db.prepare(`SELECT i.id, i.number, i.amount, i.amount_due, i.due_date, i.state, c.name AS customer
                                 FROM odoo_invoices i JOIN customers c ON c.id = i.customer_id ORDER BY i.id DESC LIMIT 50`).all();
  const returns = db.prepare(`SELECT r.id, r.number, r.customer_name, r.received_on, (SELECT SUM(cartons) FROM odoo_return_lines WHERE return_id = r.id) AS cartons,
                                     (SELECT number FROM odoo_credit_notes WHERE return_id = r.id) AS credit_note FROM odoo_returns r ORDER BY r.id DESC LIMIT 30`).all();
  const finance = db.prepare(`SELECT c.id AS customer_id, c.name AS customer, f.credit_limit, COALESCE(f.amount_owed, 0) AS amount_owed, COALESCE(f.overdue, 0) AS overdue
                                FROM customers c LEFT JOIN odoo_customer_finance f ON f.customer_id = c.id
                               WHERE c.customer_type = 'CREDIT' AND (f.customer_id IS NOT NULL OR EXISTS (SELECT 1 FROM odoo_orders o WHERE o.customer_id = c.id))
                               ORDER BY c.name LIMIT 100`).all();
  return {
    orders: orders.map((o) => ({
      id: o.id, reference: o.reference, odooNumber: o.odoo_number, state: o.state, customer: o.customer, customerType: o.customer_type,
      amountTotal: o.amount_total, receivedAt: o.received_at, updatedAt: o.updated_at, next: NEXT_STEP[o.state] || [],
    })),
    returns: returns.map((r) => ({ id: r.id, number: r.number, customer: r.customer_name, receivedOn: r.received_on, cartons: r.cartons, creditNote: r.credit_note })),
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, customer: i.customer, amount: i.amount, amountDue: i.amount_due, dueDate: i.due_date, state: i.state })),
    finance: finance.map((f) => {
      const open = openOrdersValue(db, f.customer_id);
      return {
        customerId: f.customer_id, customer: f.customer, creditLimit: f.credit_limit, amountOwed: f.amount_owed, overdue: f.overdue,
        openOrders: open, available: f.credit_limit === null ? null : money(f.credit_limit - f.amount_owed - open),
      };
    }),
  };
}

/** Which Odoo step can follow which state (what the screen offers as buttons). */
export const NEXT_STEP = Object.freeze({
  RECEIVED: ['send'],
  WAITING_FOR_APPROVAL: ['confirm', 'cancel'],
  APPROVED: ['deliver', 'cancel'],
  DISPATCHED: ['invoice'],
  INVOICED: ['pay'],
});

/** The outbox worker sends the draft quotation; Odoo gives it a number such as S00012. */
export function sendQuotation(db, orderId, now = new Date()) {
  const o = getOrder(db, orderId);
  mustBe(o, OrderState.RECEIVED);
  const ref = db.prepare('SELECT reference FROM requests WHERE id = ?').get(o.request_id).reference;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("UPDATE odoo_outbox SET status = ?, attempts = attempts + 1, sent_at = ? WHERE dedupe_key = ?")
      .run(OutboxStatus.SENT, now.toISOString(), `quotation:${ref}`);
    move(db, o, OrderState.WAITING_FOR_APPROVAL, 'sent_at', now, { odoo_number: nextNumber(db, 'odoo_orders', 'odoo_number', 'S', 5) });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** The Sales Manager confirms the quotation in Odoo. */
export function confirmOrder(db, orderId, now = new Date()) {
  const o = getOrder(db, orderId);
  mustBe(o, OrderState.WAITING_FOR_APPROVAL);
  move(db, o, OrderState.APPROVED, 'approved_at', now);
}

/** The warehouse has prepared the order; the truck is loaded; the delivery is validated. */
export function validateDelivery(db, orderId, now = new Date()) {
  const o = getOrder(db, orderId);
  mustBe(o, OrderState.APPROVED);
  // everything ordered is delivered (the stand-in has no shortages); Odoo records ordered and delivered per line
  const n = db.prepare('SELECT COALESCE(SUM(quantity_ctn), 0) n FROM request_items WHERE request_id = ?').get(o.request_id).n;
  move(db, o, OrderState.DISPATCHED, 'dispatched_at', now, { cartons_ordered: n, cartons_delivered: n });
}

/** Finance posts the invoice: the customer's balance goes up. */
export function postInvoice(db, orderId, now = new Date()) {
  const o = getOrder(db, orderId);
  mustBe(o, OrderState.DISPATCHED);
  const amount = orderValue(db, o);
  const year = now.getUTCFullYear();
  db.exec('BEGIN IMMEDIATE');
  try {
    const number = nextNumber(db, 'odoo_invoices', 'number', `INV/${year}/`, 4);
    const invId = Number(db.prepare(`INSERT INTO odoo_invoices (number, customer_id, order_id, amount, amount_due, invoice_date, due_date, state)
                VALUES (?,?,?,?,?,?,?, 'OPEN')`).run(number, o.customer_id, o.id, amount, amount, dayOf(now), dayOf(addDays(now, PAYMENT_TERMS_DAYS))).lastInsertRowid);
    const insLine = db.prepare('INSERT INTO odoo_invoice_lines (invoice_id, barcode, product_name, category, cartons, amount, discount, lot_name) VALUES (?,?,?,?,?,?,?,?)');
    for (const l of orderLines(db, o)) insLine.run(invId, l.barcode, l.name, l.category ?? null, l.cartons, l.amount, l.discount, l.lot);
    move(db, o, OrderState.INVOICED, 'invoiced_at', now, { amount_total: amount });
    recomputeFinance(db, o.customer_id, now);
    db.exec('COMMIT');
    return { number, amount };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Finance records the customer's payment in Odoo: the balance goes down. */
export function recordPayment(db, orderId, now = new Date()) {
  const o = getOrder(db, orderId);
  mustBe(o, OrderState.INVOICED);
  const inv = db.prepare("SELECT * FROM odoo_invoices WHERE order_id = ? AND state = 'OPEN'").get(o.id);
  if (!inv) throw new SampleOdooError('There is no open invoice for this order.');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO odoo_payments (customer_id, invoice_id, amount, paid_on) VALUES (?,?,?,?)').run(o.customer_id, inv.id, inv.amount_due, dayOf(now));
    db.prepare("UPDATE odoo_invoices SET amount_due = 0, state = 'PAID' WHERE id = ?").run(inv.id);
    move(db, o, OrderState.PAID, 'paid_at', now);
    recomputeFinance(db, o.customer_id, now);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** The quotation is cancelled in Odoo (before it is delivered). The record is kept. */
export function cancelOrder(db, orderId, now = new Date()) {
  const o = getOrder(db, orderId);
  mustBe(o, OrderState.WAITING_FOR_APPROVAL, OrderState.APPROVED);
  move(db, o, OrderState.CANCELLED, 'cancelled_at', now);
}

/** Make an invoice overdue (for testing the overdue figure and, later, the reminders). */
export function ageInvoice(db, invoiceId, now = new Date()) {
  const inv = db.prepare("SELECT * FROM odoo_invoices WHERE id = ? AND state = 'OPEN'").get(Number(invoiceId));
  if (!inv) throw new SampleOdooError('That invoice is not open.', 404);
  db.prepare('UPDATE odoo_invoices SET due_date = ? WHERE id = ?').run(dayOf(addDays(now, -5)), inv.id);
  recomputeFinance(db, inv.customer_id, now);
}

/** Set a credit customer's limit (in Odoo this belongs to Finance / the Sales Manager). */
export function setCreditLimit(db, customerId, limit, now = new Date()) {
  const c = db.prepare('SELECT id, customer_type FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) throw new SampleOdooError('That customer does not exist.', 404);
  if (c.customer_type === 'CASH') throw new SampleOdooError('A cash customer has no credit limit.');
  const n = Number(limit);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw new SampleOdooError('A credit limit is a number from 0 up.', 400);
  financeRow(db, c.id, now);
  db.prepare('UPDATE odoo_customer_finance SET credit_limit = ?, updated_at = ? WHERE customer_id = ?').run(money(n), now.toISOString(), c.id);
}

// ---------------------------------------------------------------------------------------------
// Returns and credit notes — what happens in Odoo when goods come back.
//
// The warehouse receives a return delivery into QUARANTINE (never back into sellable stock) and Finance
// issues the credit note. BFL reads both; the REASON is BFL's own record (S04).
// ---------------------------------------------------------------------------------------------

/** What can be returned: shelf deliveries (net of returns already received) and BFL orders that were delivered. */
export function returnOptions(db, todayStr) {
  const shelf = loadShelf(todayStr);
  const back = new Map(db.prepare(`SELECT r.customer_ref AS c, l.barcode, l.lot_name AS lot, SUM(l.cartons) AS n
                                    FROM odoo_return_lines l JOIN odoo_returns r ON r.id = l.return_id WHERE r.customer_kind = 'SHELF' GROUP BY 1, 2, 3`).all()
    .map((r) => [`${r.c}|${r.barcode}|${r.lot}`, r.n]));
  const options = shelf.records.map((r) => {
    const cust = shelf.customers.find((c) => c.id === r.customerId);
    const left = r.deliveredCartons - (back.get(`${r.customerId}|${r.barcode}|${r.lotName}`) || 0);
    return { id: `SHELF:${r.key}`, label: `${cust?.name} — ${r.productName} — lot ${r.lotName} (${left} cartons delivered, order ${r.salesOrder})`, left };
  }).filter((o) => o.left > 0);
  const orders = db.prepare(`SELECT o.id, o.odoo_number, c.name FROM odoo_orders o JOIN customers c ON c.id = o.customer_id
                               WHERE o.state IN ('DISPATCHED','INVOICED','PAID') ORDER BY o.id DESC LIMIT 30`).all();
  for (const o of orders) {
    for (const l of db.prepare('SELECT i.barcode_at_request AS barcode, i.product_name_at_request AS name, i.quantity_ctn AS n FROM request_items i JOIN odoo_orders x ON x.request_id = i.request_id WHERE x.id = ?').all(o.id)) {
      const got = db.prepare("SELECT COALESCE(SUM(l.cartons),0) n FROM odoo_return_lines l JOIN odoo_returns r ON r.id = l.return_id WHERE r.customer_kind = 'BFL' AND r.sales_order = ? AND l.barcode = ?").get(o.odoo_number, l.barcode).n;
      if (l.n - got > 0) options.push({ id: `ORDER:${o.id}:${l.barcode}`, label: `${o.name} — ${l.name} (${l.n - got} cartons delivered, order ${o.odoo_number || 'no number'})`, left: l.n - got });
    }
  }
  return options;
}

/** The warehouse receives a return delivery into quarantine. `optionId` comes from returnOptions. */
export function createReturn(db, { optionId, cartons } = {}, todayStr, now = new Date()) {
  const n = Number(cartons);
  const opt = returnOptions(db, todayStr).find((o) => o.id === optionId);
  if (!opt) throw new SampleOdooError('Choose what is being returned.', 400);
  if (!Number.isInteger(n) || n < 1 || n > opt.left) throw new SampleOdooError(`Return between 1 and ${opt.left} cartons.`, 400);
  const year = now.getUTCFullYear();
  let who; let line;
  if (optionId.startsWith('SHELF:')) {
    const [cust, barcode, lot, salesOrder] = optionId.slice(6).split('|');
    const shelf = loadShelf(todayStr);
    const rec = shelf.records.find((r) => String(r.customerId) === cust && r.barcode === barcode && r.lotName === lot && r.salesOrder === salesOrder);
    const c = shelf.customers.find((x) => String(x.id) === cust);
    who = { kind: 'SHELF', ref: cust, name: c?.name ?? `Customer ${cust}`, rep: shelf.reps.find((r) => r.id === c?.repId)?.name ?? null, salesOrder };
    line = { barcode, name: rec?.productName ?? barcode, lot, category: rec?.categoryPath ?? null };
  } else {
    const [, orderId, barcode] = optionId.split(':');
    const o = db.prepare('SELECT o.id, o.odoo_number, o.customer_id, c.name, c.salesperson FROM odoo_orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?').get(Number(orderId));
    const item = db.prepare('SELECT i.product_name_at_request AS name, p.odoo_category_path AS category FROM request_items i LEFT JOIN products p ON p.id = i.product_id JOIN odoo_orders x ON x.request_id = i.request_id WHERE x.id = ? AND i.barcode_at_request = ?').get(o.id, barcode);
    who = { kind: 'BFL', ref: String(o.customer_id), name: o.name, rep: o.salesperson, salesOrder: o.odoo_number };
    line = { barcode, name: item?.name ?? barcode, lot: null, category: item?.category ?? null };
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const number = nextNumber(db, 'odoo_returns', 'number', `RET/${year}/`, 4);
    const id = Number(db.prepare(`INSERT INTO odoo_returns (number, customer_kind, customer_ref, customer_name, rep_name, sales_order, received_on, created_at)
                                  VALUES (?,?,?,?,?,?,?,?)`).run(number, who.kind, who.ref, who.name, who.rep, who.salesOrder, dayOf(now), now.toISOString()).lastInsertRowid);
    db.prepare('INSERT INTO odoo_return_lines (return_id, barcode, product_name, lot_name, category, cartons) VALUES (?,?,?,?,?,?)').run(id, line.barcode, line.name, line.lot, line.category, n);
    db.exec('COMMIT');
    return { id, number };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Finance issues the credit note for a return: the value of the goods at the customer's price, before tax. */
export function issueReturnCreditNote(db, returnId, now = new Date()) {
  const r = db.prepare('SELECT * FROM odoo_returns WHERE id = ?').get(Number(returnId));
  if (!r) throw new SampleOdooError('That return does not exist.', 404);
  if (db.prepare('SELECT 1 FROM odoo_credit_notes WHERE return_id = ?').get(r.id)) throw new SampleOdooError('A credit note was already issued for this return.');
  const cls = r.customer_kind === 'BFL' ? (priceClassOf(db, Number(r.customer_ref)) || DEFAULT_PRICE_CLASS) : DEFAULT_PRICE_CLASS;
  const amount = money(db.prepare('SELECT barcode, cartons FROM odoo_return_lines WHERE return_id = ?').all(r.id)
    .reduce((sum, l) => sum + (cartonPriceFor(l.barcode, cls) ?? 0) * l.cartons, 0));
  db.exec('BEGIN IMMEDIATE');
  try {
    const number = nextNumber(db, 'odoo_credit_notes', 'number', `CN/${now.getUTCFullYear()}/`, 4);
    let invoiceNumber = null;
    if (r.customer_kind === 'BFL') {
      // a credit note against the customer's open invoice for that order lowers what they owe
      const inv = db.prepare(`SELECT i.* FROM odoo_invoices i JOIN odoo_orders o ON o.id = i.order_id WHERE o.odoo_number = ? AND i.state = 'OPEN'`).get(r.sales_order);
      if (inv) {
        const applied = Math.min(amount, inv.amount_due);
        db.prepare("UPDATE odoo_invoices SET amount_due = ?, state = CASE WHEN ? <= 0 THEN 'PAID' ELSE state END WHERE id = ?").run(money(inv.amount_due - applied), money(inv.amount_due - applied), inv.id);
        invoiceNumber = inv.number;
        recomputeFinance(db, inv.customer_id, now);
      }
    }
    db.prepare(`INSERT INTO odoo_credit_notes (number, customer_kind, customer_ref, customer_name, rep_name, invoice_number, return_id, kind, amount, issued_on)
                VALUES (?,?,?,?,?,?,?, 'RETURN', ?, ?)`).run(number, r.customer_kind, r.customer_ref, r.customer_name, r.rep_name, invoiceNumber, r.id, amount, dayOf(now));
    db.exec('COMMIT');
    return { number, amount };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const STEP_ACTIONS = Object.freeze({
  send: sendQuotation, confirm: confirmOrder, deliver: validateDelivery, invoice: postInvoice, pay: recordPayment, cancel: cancelOrder,
});
