// A sales rep placing an order for one of their own customers.
//
// The order is the customer's: it goes through exactly the checks a customer's own request does (placeRequest: stock,
// minimum shelf life, credit, discounted offers) and becomes the same draft quotation for Odoo, with a note saying which
// rep placed it. A person still approves it in Odoo.
//
// Who may order for whom is decided HERE, on the server: the rep comes from the signed-in session, and the customer in the
// request must be one the Sales Manager has given to that rep (customers.salesperson is the rep's name). A rep cannot name
// anyone else's customer; asking for one looks like the customer does not exist.
import { allReps } from './reps.js';
import { searchCatalog } from './catalog.js';
import { pricesForCustomer, CURRENCY, PRICE_SOURCE } from './prices.js';
import { clearanceOffersFor } from './lot-discounts.js';
import { validateRequest } from './requests.js';
import { checkRequestLines } from './shelf-life.js';
import { checkCredit, estimateValue, ORDER_STATE_LABEL } from './orders.js';
import { placeRequest, readLines } from './place-request.js';

export class RepOrderError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'RepOrderError'; this.status = status; }
}

const repName = (db, repId) => allReps(db).find((r) => r.id === String(repId ?? ''))?.name || null;

/** The customers this rep may order for: active BFL customers whose salesperson is this rep. */
export function repCustomers(db, repId, q = '') {
  const name = repName(db, repId);
  if (!name) return [];
  const needle = String(q || '').trim();
  const like = `%${needle.replace(/[%_]/g, '')}%`;
  const rows = needle
    ? db.prepare(`SELECT id, name, odoo_customer_ref, customer_type FROM customers
                   WHERE is_active = 1 AND salesperson = ? AND (name LIKE ? OR odoo_customer_ref LIKE ?) ORDER BY name LIMIT 100`).all(name, like, like)
    : db.prepare('SELECT id, name, odoo_customer_ref, customer_type FROM customers WHERE is_active = 1 AND salesperson = ? ORDER BY name LIMIT 100').all(name);
  return rows.map((c) => ({ id: c.id, name: c.name, odooId: c.odoo_customer_ref || '', cash: c.customer_type === 'CASH' }));
}

/** The customer row if it is on this rep's list; otherwise it is treated as not existing. */
export function assertMyCustomer(db, repId, customerId) {
  const name = repName(db, repId);
  const c = name && Number.isInteger(Number(customerId))
    ? db.prepare('SELECT id, name, odoo_customer_ref FROM customers WHERE id = ? AND is_active = 1 AND salesperson = ?').get(Number(customerId), name)
    : null;
  if (!c) throw new RepOrderError('That customer is not on your list.', 404);
  return c;
}

/** Products this customer may buy, as that customer sees them (hidden products stay hidden), with the customer's own price. */
export function productsFor(db, repId, customerId, { search = '', limit, offset } = {}) {
  assertMyCustomer(db, repId, customerId);
  const page = searchCatalog(db, { search, availableOnly: true, limit, offset, viewer: { customerId: Number(customerId) } });
  const prices = pricesForCustomer(db, Number(customerId), page.items.map((p) => p.barcode));
  const offers = clearanceOffersFor(db, Number(customerId));
  return {
    total: page.total, limit: page.limit, offset: page.offset,
    currency: CURRENCY, per: 'carton', source: PRICE_SOURCE,
    items: page.items.map((p) => {
      const o = offers.get(String(p.barcode));
      return {
        barcode: p.barcode, name: p.name, pack: p.pack, requestable: p.requestable, availability: p.availability,
        price: prices.prices[p.barcode] ?? null,
        offer: o ? { discountPct: o.discountPct, maxCartons: o.cartons, discountedPrice: o.discountedPrice, bestBefore: o.expiryDate } : null,
      };
    }),
  };
}

/** A dry run of the order: what it comes to, whether stock and credit allow it, which lines need the customer's say-so. Writes nothing. */
export function reviewOrder(db, repId, body = {}) {
  const customer = assertMyCustomer(db, repId, body.customer);
  const lines = readLines(body);
  const verdict = validateRequest(db, lines, { viewer: { customerId: customer.id } });
  const credit = checkCredit(db, customer.id, lines);
  const shelf = checkRequestLines(db, customer.id, lines);
  return {
    customer: { id: customer.id, name: customer.name },
    currency: CURRENCY,
    estimate: estimateValue(db, customer.id, lines),
    canSubmit: verdict.stock.hasData && verdict.stock.fresh,
    errors: verdict.errors.map((e) => ({ barcode: e.barcode, code: e.code, message: e.message })),
    credit: { checked: credit.checked, ok: credit.ok, available: credit.available ?? null, orderValue: credit.orderValue ?? null },
    shelf: { minDays: shelf.minDays, warnings: shelf.warnings.map((w) => ({ barcode: w.barcode, message: w.message, expiryDate: w.expiryDate })) },
  };
}

/** Place the order for the customer, as this rep. */
export function placeRepOrder(db, repId, staff, body = {}) {
  const customer = assertMyCustomer(db, repId, body.customer);
  const name = repName(db, repId);
  const result = placeRequest(db, { customerId: customer.id, body, placedBy: { staffId: staff.id, name } });
  return { reference: result.reference, items: result.lineCount, customer: customer.name };
}

/** The orders this rep account has placed, newest first. */
export function repOrders(db, staffId, limit = 30) {
  return db.prepare(`SELECT r.reference, r.submitted_at AS placedAt, c.name AS customer, o.state, o.odoo_number AS odooNumber,
                            (SELECT COALESCE(SUM(i.quantity_ctn), 0) FROM request_items i WHERE i.request_id = r.id) AS cartons
                       FROM requests r
                       JOIN customers c ON c.id = r.customer_id
                       LEFT JOIN odoo_orders o ON o.request_id = r.id
                      WHERE r.placed_by_staff_id = ?
                      ORDER BY r.id DESC LIMIT ?`).all(Number(staffId), Math.min(Math.max(Number(limit) || 30, 1), 100))
    .map((r) => ({ reference: r.reference, placedAt: r.placedAt, customer: r.customer, cartons: r.cartons, odooNumber: r.odooNumber || null, status: ORDER_STATE_LABEL[r.state] || 'Received' }));
}
