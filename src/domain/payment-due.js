// The payment due date of an order: set by the Sales Manager after the purchase.
//
// When a credit customer places an order, the Sales Manager (or an administrator) agrees when it is to be paid and
// records that date here. From then on it is the date that counts on BFL:
//   - the payment reminders fall on it (payments.js openInvoices uses it before any schedule),
//   - the customer sees it as "Pay by" on their orders, invoices, balance and statement.
// It is BFL's own record, never written to Odoo (BFL never writes invoices or payment terms): Odoo keeps its own invoice
// due date, which BFL still shows where it is Odoo's figure.
//
// Every change is kept (order_payment_due_changes): the old date, the new one, who, when and — for a change — why.
// A cash order is paid on delivery and has no due date; a cancelled or paid order cannot be given one.
import { toDay, formatDay } from './expiry.js';

export class PaymentDueError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'PaymentDueError'; this.status = status; }
}

/** The latest a due date may be after the order was placed. */
export const MAX_DAYS_AFTER_ORDER = 365;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const orderOfRequest = (db, requestId) => db.prepare(`
  SELECT o.id, o.request_id, o.state, o.received_at, o.paid_at, o.customer_id, r.reference, c.customer_type, c.name AS customer
    FROM odoo_orders o JOIN requests r ON r.id = o.request_id LEFT JOIN customers c ON c.id = o.customer_id
   WHERE o.request_id = ?`).get(Number(requestId));

/** The due date set for an order (odoo_orders.id), or null. */
export function dueDateOfOrder(db, orderId) {
  const r = db.prepare('SELECT due_date, set_by, set_at FROM order_payment_due WHERE order_id = ?').get(Number(orderId));
  return r ? { dueDate: r.due_date, setBy: r.set_by, setAt: r.set_at } : null;
}

/** Can this order be given a due date? null when it can, else the reason it cannot. */
function blockedReason(o) {
  if (o.customer_type === 'CASH') return 'A cash order is paid on delivery, so it has no payment due date.';
  if (o.state === 'CANCELLED') return 'This order was cancelled.';
  if (o.state === 'PAID') return 'This order is already paid.';
  return null;
}

/**
 * The payment due date panel for one request: the order's current date, whether it can be set, and its history.
 * Staff only (the route decides who).
 */
export function paymentDueFor(db, requestId) {
  const o = orderOfRequest(db, requestId);
  if (!o) return { applies: false, reason: 'There is no order for this request yet.', dueDate: null, history: [] };
  const current = dueDateOfOrder(db, o.id);
  const history = db.prepare(`SELECT old_date AS oldDate, new_date AS newDate, reason, changed_by AS changedBy, changed_at AS changedAt
                                FROM order_payment_due_changes WHERE order_id = ? ORDER BY id DESC`).all(o.id);
  const blocked = blockedReason(o);
  const placed = String(o.received_at).slice(0, 10);
  return {
    applies: !blocked, reason: blocked, reference: o.reference, state: o.state,
    placedOn: placed, earliest: placed, latest: formatDay(toDay(placed) + MAX_DAYS_AFTER_ORDER),
    dueDate: current?.dueDate || null, setBy: current?.setBy || null, setAt: current?.setAt || null, history,
  };
}

/**
 * Set (or change) an order's payment due date. Changing a date already set needs a reason; nothing is overwritten
 * without a trace.
 * @param {number} requestId  the BFL request the order belongs to
 * @param {{dueDate:string, reason?:string}} input
 * @param {string|null} by  the staff member's name, from their session
 */
export function setPaymentDue(db, requestId, input = {}, by = null, now = new Date()) {
  const o = orderOfRequest(db, requestId);
  if (!o) throw new PaymentDueError('There is no order for this request yet.', 404);
  const blocked = blockedReason(o);
  if (blocked) throw new PaymentDueError(blocked, 409);
  const due = String(input.dueDate || '').trim();
  if (!DATE.test(due) || toDay(due) === null || formatDay(toDay(due)) !== due) throw new PaymentDueError('Choose a valid date.');
  const placed = toDay(String(o.received_at).slice(0, 10));
  if (toDay(due) < placed) throw new PaymentDueError('The due date cannot be before the order was placed.');
  if (toDay(due) > placed + MAX_DAYS_AFTER_ORDER) throw new PaymentDueError(`The due date must be within ${MAX_DAYS_AFTER_ORDER} days of the order.`);
  const reason = String(input.reason ?? '').trim().slice(0, 300);
  const current = dueDateOfOrder(db, o.id);
  if (current && current.dueDate === due) return paymentDueFor(db, requestId);
  if (current && reason.length < 3) throw new PaymentDueError('Say why the due date is changing.');
  const at = now.toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO order_payment_due (order_id, due_date, set_by, set_at) VALUES (?,?,?,?)
                ON CONFLICT(order_id) DO UPDATE SET due_date = excluded.due_date, set_by = excluded.set_by, set_at = excluded.set_at`)
      .run(o.id, due, by, at);
    db.prepare(`INSERT INTO order_payment_due_changes (order_id, old_date, new_date, reason, changed_by, changed_at) VALUES (?,?,?,?,?,?)`)
      .run(o.id, current?.dueDate || null, due, reason || null, by, at);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return paymentDueFor(db, requestId);
}

/** Credit orders that are not cancelled or paid and have no due date yet: the Sales Manager's to-do list, oldest first. */
export function ordersAwaitingDueDate(db, limit = 50) {
  return db.prepare(`
    SELECT o.request_id AS requestId, r.reference, o.odoo_number AS odooNumber, c.name AS customer, c.salesperson AS rep,
           o.state, o.received_at AS placedAt, COALESCE(o.amount_total, o.amount_open) AS amount
      FROM odoo_orders o JOIN requests r ON r.id = o.request_id JOIN customers c ON c.id = o.customer_id
     WHERE (c.customer_type IS NULL OR c.customer_type = 'CREDIT') AND o.state NOT IN ('CANCELLED', 'PAID')
       AND NOT EXISTS (SELECT 1 FROM order_payment_due d WHERE d.order_id = o.id)
     ORDER BY o.received_at, o.id LIMIT ?`).all(Math.min(Math.max(Number(limit) || 50, 1), 500));
}
