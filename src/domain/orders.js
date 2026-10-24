// A customer's order, from the moment they submit it to the moment Odoo says it is paid.
//
// BFL does exactly one thing here: it queues a DRAFT quotation for Odoo (through the outbox, with
// no price — Odoo calculates it). Everything after that happens in Odoo and BFL only READS it:
//
//   customer submits ─► RECEIVED              BFL has it; the quotation is queued for Odoo
//   quotation arrives ─► WAITING_FOR_APPROVAL  a draft sale.order exists; the customer sees its number
//   Sales Manager confirms in Odoo ─► APPROVED
//   warehouse prepares, truck loaded, delivery validated in Odoo ─► DISPATCHED
//   invoice posted in Odoo ─► INVOICED         the customer's balance goes up
//   payment recorded by Finance in Odoo ─► PAID   the balance goes down
//
// BFL never confirms, sends or cancels an order, and never writes an invoice or a payment. Until the
// Odoo sync exists, domain/sample-odoo.js plays Odoo's part so the whole journey can be tested; the
// tables below are the same ones the real sync will fill.
import { enqueue, OutboxKind } from './outbox.js';
import { CASH_PRICE_CLASS, cartonPriceFor, priceClassOf } from './prices.js';
import { RequestValidationError } from './requests.js';
import { getSchedule, describeSchedule, openInvoices } from './payments.js';
import { toDay } from './expiry.js';
import { clearanceOffersFor } from './lot-discounts.js';

export const OrderState = Object.freeze({
  RECEIVED: 'RECEIVED',
  WAITING_FOR_APPROVAL: 'WAITING_FOR_APPROVAL',
  APPROVED: 'APPROVED',
  DISPATCHED: 'DISPATCHED',
  INVOICED: 'INVOICED',
  PAID: 'PAID',
  CANCELLED: 'CANCELLED',
});

/** What the customer reads. The wording follows the plan: received, waiting for approval, approved, dispatched, invoiced, paid. */
export const ORDER_STATE_LABEL = Object.freeze({
  RECEIVED: 'Received',
  WAITING_FOR_APPROVAL: 'Waiting for approval',
  APPROVED: 'Approved',
  DISPATCHED: 'Dispatched',
  INVOICED: 'Invoiced',
  PAID: 'Paid',
  CANCELLED: 'Cancelled',
});

/** A line of explanation under each state, so nobody has to guess what happens next. */
export const ORDER_STATE_HINT = Object.freeze({
  RECEIVED: 'We have your request and are sending it to our sales system.',
  WAITING_FOR_APPROVAL: 'Our Sales Manager is reviewing your order.',
  APPROVED: 'Approved. The warehouse is preparing it.',
  DISPATCHED: 'Loaded and on its way to you.',
  INVOICED: 'Delivered and invoiced.',
  PAID: 'Paid. Thank you.',
  CANCELLED: 'This order was cancelled.',
});

const STEPS = [OrderState.RECEIVED, OrderState.WAITING_FOR_APPROVAL, OrderState.APPROVED, OrderState.DISPATCHED, OrderState.INVOICED, OrderState.PAID];

/**
 * Record the order and queue its draft quotation. Call INSIDE the request's transaction (from
 * submitRequest's `onInsert`), so a request is never saved without its order, nor an order without
 * its queued quotation.
 *
 * The quotation carries the customer, BFL's reference in `client_order_ref`, the product and the
 * number of cartons per line, and the delivery address — and no price. A cash customer is a buyer
 * on the SHARED cash account: the quotation goes on that account and the buyer's own name, phone
 * and address go in the order note.
 */
export function createOrderForRequest(db, requestId, now = new Date()) {
  const ts = now.toISOString();
  const request = db.prepare('SELECT id, reference, customer_id, delivery_address, notes, placed_by_rep FROM requests WHERE id = ?').get(Number(requestId));
  const customer = db.prepare('SELECT id, name, phone, email, odoo_customer_ref, customer_type FROM customers WHERE id = ?').get(request.customer_id);
  const lines = db.prepare(`SELECT barcode_at_request AS barcode, product_name_at_request AS name, quantity_ctn AS cartons,
                                    clearance_lot_name AS lot, clearance_expiry AS lotExpiry, clearance_cartons AS clearanceCartons, clearance_pct AS clearancePct
                              FROM request_items WHERE request_id = ? ORDER BY id`).all(request.id);
  // a line with clearance cartons becomes two quotation lines: the ordinary cartons, then the clearance cartons,
  // which carry the discount and name their lot (Odoo works out every price; a person approves the order)
  const quoteLines = lines.flatMap((l) => {
    const c = l.clearanceCartons || 0;
    const out = [];
    if (l.cartons - c > 0) out.push({ barcode: l.barcode, product: l.name, cartons: l.cartons - c });
    if (c > 0) out.push({ barcode: l.barcode, product: l.name, cartons: c, discount: l.clearancePct, lot: l.lot, note: `Clearance: ${l.clearancePct}% off, lot ${l.lot}, expires ${l.lotExpiry}. Not returnable.` });
    return out;
  });

  const cash = customer.customer_type === 'CASH';
  const values = {
    client_order_ref: request.reference,
    delivery_address: request.delivery_address,
    note: request.notes || null,
    lines: quoteLines,
  };
  if (cash) {
    values.partner = { account: CASH_PRICE_CLASS.replace(' (GHS)', ''), shared: true };
    values.note = [`Cash buyer: ${customer.name}`, customer.phone ? `Phone: ${customer.phone}` : null,
      request.delivery_address ? `Deliver to: ${request.delivery_address}` : null, request.notes || null].filter(Boolean).join('\n');
  } else {
    values.partner = { odoo_ref: customer.odoo_customer_ref || null, name: customer.name };
  }

  // an order a sales rep placed for the customer says so, so the person who approves it in Odoo knows
  if (request.placed_by_rep) values.note = [`Placed by sales rep ${request.placed_by_rep}.`, values.note].filter(Boolean).join('\n');

  db.prepare(`INSERT INTO odoo_orders (request_id, customer_id, state, amount_open, received_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(request.id, customer.id, OrderState.RECEIVED, estimateValue(db, customer.id, lines.map((l) => ({ barcode: l.barcode, quantityCtn: l.cartons, clearanceCartons: l.clearanceCartons || 0, clearancePct: l.clearancePct || 0 }))), ts, ts);
  enqueue(db, OutboxKind.DRAFT_QUOTATION, `quotation:${request.reference}`, { model: 'sale.order', state: 'draft', values }, now);
}

// ---------------------------------------------------------------------------------------------
// The credit check.
//
//   available credit = credit limit − what they owe − open orders not yet invoiced
//
// Example: limit 10,000, owed 6,000, an earlier order of 2,500 still waiting for approval leaves
// 1,500 — not 4,000. A new request is refused only when it would go OVER that. An overdue invoice or a
// missed payment day triggers reminders, never a block: only the limit blocks.
//
// The limit and what is owed are Odoo's (read in; here from the stand-in). The open orders are BFL's
// own queue plus Odoo's quotations, priced from the customer's price list until Odoo's total is read.
// A request is NOT checked — and so never blocked — when there is nothing to check against: a cash
// customer (no credit), a credit customer whose limit Odoo has not given us, or a customer with no
// price class (we cannot value the request). Failing open here is deliberate: a gap in our data must not
// stop a customer ordering; the Sales Manager still approves every quotation in Odoo.
// ---------------------------------------------------------------------------------------------
export const CREDIT_LIMIT_EXCEEDED = 'CREDIT_LIMIT_EXCEEDED';
const OPEN_STATES = [OrderState.RECEIVED, OrderState.WAITING_FOR_APPROVAL, OrderState.APPROVED, OrderState.DISPATCHED];
const money = (n) => Math.round(n * 100) / 100;
const fmt = (n) => `GHS ${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * What these lines come to at the customer's own carton prices, or null when we cannot say. Cartons on a
 * clearance offer count at the discounted price: a line that already says how many (clearanceCartons,
 * clearancePct) is taken as it is; any other line gets the customer's live offer for that product.
 */
export function estimateValue(db, customerId, lines) {
  const cls = priceClassOf(db, customerId);
  if (!cls) return null;
  let offers = null;
  let total = 0;
  for (const l of Array.isArray(lines) ? lines : []) {
    const p = cartonPriceFor(String(l.barcode), cls);
    if (p === null) return null;
    const q = Number(l.quantityCtn || 0);
    let c = l.clearanceCartons;
    let pct = l.clearancePct;
    if (c === undefined) {
      offers = offers || clearanceOffersFor(db, customerId);
      const o = offers.get(String(l.barcode));
      c = o ? Math.min(q, o.cartons) : 0;
      pct = o ? o.discountPct : 0;
      if (o) o.cartons -= c;   // a second line of the same product cannot take the same cartons
    }
    total += p * (q - c) + p * c * (1 - (pct || 0) / 100);
  }
  return money(total);
}

/** The value of this customer's orders that Odoo has not invoiced yet. */
export function openOrdersValue(db, customerId) {
  const marks = OPEN_STATES.map(() => '?').join(',');
  return money(db.prepare(`SELECT COALESCE(SUM(amount_open), 0) s FROM odoo_orders WHERE customer_id = ? AND state IN (${marks})`).get(Number(customerId), ...OPEN_STATES).s);
}

/** limit / owed / open orders / available for a credit customer with a known limit, else null. */
export function creditPosition(db, customerId) {
  const c = db.prepare('SELECT customer_type FROM customers WHERE id = ?').get(Number(customerId));
  if (!c || c.customer_type === 'CASH') return null;
  const f = db.prepare('SELECT credit_limit, amount_owed FROM odoo_customer_finance WHERE customer_id = ?').get(Number(customerId));
  if (!f || f.credit_limit === null) return null;
  const open = openOrdersValue(db, customerId);
  return { limit: f.credit_limit, owed: f.amount_owed, open, available: money(f.credit_limit - f.amount_owed - open) };
}

/**
 * Would this request go over the customer's available credit?
 * @returns {{checked:boolean, ok:boolean, orderValue?:number, available?:number, message?:string}}
 */
export function checkCredit(db, customerId, lines) {
  const pos = creditPosition(db, customerId);
  if (!pos) return { checked: false, ok: true };
  const value = estimateValue(db, customerId, lines);
  if (value === null) return { checked: false, ok: true };
  if (value <= pos.available) return { checked: true, ok: true, orderValue: value, available: pos.available };
  return {
    checked: true, ok: false, orderValue: value, available: pos.available,
    message: pos.available > 0
      ? `This request comes to about ${fmt(value)}, which is more than your available credit of ${fmt(pos.available)}. Reduce it, or contact Box for Less.`
      : `You have no available credit at the moment (${fmt(pos.available)}). Please contact Box for Less before sending a new request.`,
  };
}

/** Throw the refusal a customer sees. Call inside the request's transaction so two requests cannot both use the same credit. */
export function assertCredit(db, customerId, lines) {
  const r = checkCredit(db, customerId, lines);
  if (!r.ok) throw new RequestValidationError('Over your available credit.', { errors: [{ code: CREDIT_LIMIT_EXCEEDED, message: r.message }] });
}

function shapeOrder(db, o) {
  const items = db.prepare(`SELECT product_name_at_request AS name, quantity_ctn AS cartons, clearance_cartons AS discountedCartons, clearance_pct AS discountPct, clearance_expiry AS bestBefore
                              FROM request_items WHERE request_id = ? ORDER BY id`).all(o.request_id)
    .map((i) => (i.discountedCartons ? i : { name: i.name, cartons: i.cartons }));
  const idx = STEPS.indexOf(o.state);
  return {
    reference: o.reference,                 // BFL's own, e.g. REQ-2026-0004
    odooNumber: o.odoo_number || null,      // Odoo's, e.g. S00012, once it exists
    status: o.state,
    statusLabel: ORDER_STATE_LABEL[o.state],
    hint: ORDER_STATE_HINT[o.state],
    step: idx < 0 ? null : idx + 1,
    steps: STEPS.length,
    placedAt: o.received_at,
    updatedAt: o.updated_at,
    items,
    // the amount appears only once Odoo has invoiced; before that the price is Odoo's to work out
    total: o.amount_total ?? null,
  };
}

/**
 * One customer's own orders, newest first. Built field by field: no database id, no customer id,
 * nothing about anyone else. For a cash customer these are only the orders placed on BFL — cash
 * sales entered straight into Odoo can't be tied to a buyer and are never shown.
 */
export function listOrdersFor(db, customerId, limit = 50) {
  const rows = db.prepare(`SELECT o.request_id, o.odoo_number, o.state, o.amount_total, o.received_at, o.updated_at, r.reference
                             FROM odoo_orders o JOIN requests r ON r.id = o.request_id
                            WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT ?`).all(Number(customerId), Math.min(Number(limit) || 50, 200));
  return rows.map((o) => shapeOrder(db, o));
}

/**
 * The signed-in customer's money, exactly as Odoo reported it: credit limit, what they owe, what is
 * overdue, their open invoices and last payments. BFL adds nothing up on its own. A cash customer
 * has no account: the shared cash account's balance, invoices and history are NEVER shown to
 * anyone, so a cash customer gets an explicit "no balance" answer.
 */
export function accountFor(db, customerId, todayStr = new Date().toISOString().slice(0, 10)) {
  const c = db.prepare('SELECT id, customer_type FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) return null;
  if (c.customer_type === 'CASH') return { type: 'CASH', note: 'You pay in cash. There is no account balance to show.' };
  const f = db.prepare('SELECT credit_limit, amount_owed, overdue, updated_at FROM odoo_customer_finance WHERE customer_id = ?').get(c.id);
  const invoices = db.prepare(`SELECT i.number, i.amount, i.amount_due, i.invoice_date, i.due_date, i.state, r.reference AS order_ref, o.odoo_number
                                 FROM odoo_invoices i
                                 LEFT JOIN odoo_orders o ON o.id = i.order_id
                                 LEFT JOIN requests r ON r.id = o.request_id
                                WHERE i.customer_id = ? ORDER BY i.id DESC LIMIT 30`).all(c.id);
  const payments = db.prepare(`SELECT p.amount, p.paid_on, i.number AS invoice
                                 FROM odoo_payments p LEFT JOIN odoo_invoices i ON i.id = p.invoice_id
                                WHERE p.customer_id = ? ORDER BY p.id DESC LIMIT 10`).all(c.id);
  const payBy = new Map(openInvoices(db, c.id, toDay(todayStr)).map((i) => [i.number, i.payBy]));
  const limit = f?.credit_limit ?? null;
  const owed = f?.amount_owed ?? 0;
  const open = openOrdersValue(db, c.id);
  return {
    type: 'CREDIT',
    currency: 'GHS',
    creditLimit: limit,
    amountOwed: owed,
    overdue: f?.overdue ?? 0,
    openOrders: open,
    availableCredit: limit === null ? null : money(limit - owed - open),
    asOf: f?.updated_at ?? null,
    paymentSchedule: describeSchedule(getSchedule(db, c.id)),
    invoices: invoices.map((i) => ({
      payBy: payBy.get(i.number) || null,
      number: i.number, orderNumber: i.odoo_number || i.order_ref || null, amount: i.amount, amountDue: i.amount_due,
      invoiceDate: i.invoice_date, dueDate: i.due_date, status: i.state,
    })),
    payments: payments.map((p) => ({ amount: p.amount, paidOn: p.paid_on, invoice: p.invoice })),
  };
}
