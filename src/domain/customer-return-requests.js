// Customer return requests are a BFL review workflow. They do not create an
// Odoo return, credit note, stock movement, or any other Odoo write.
import { randomUUID } from 'node:crypto';

const MAX_REASON_LENGTH = 1000;

export class CustomerReturnRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CustomerReturnRequestError';
    this.status = status;
  }
}

function eligibleItemsQuery() {
  return `
    SELECT r.reference AS orderReference, ri.barcode_at_request AS barcode,
           ri.product_name_at_request AS productName, ri.box_uom_at_request AS unit,
           SUM(ri.quantity_ctn) AS purchasedCartons,
           SUM(ri.quantity_ctn) - COALESCE(MAX((
             SELECT SUM(cr.cartons) FROM customer_return_requests cr
             WHERE cr.order_reference = r.reference
               AND cr.barcode = ri.barcode_at_request
               AND cr.status != 'DECLINED'
           )), 0) AS availableCartons
    FROM requests r
    JOIN odoo_orders o ON o.request_id = r.id
    JOIN request_items ri ON ri.request_id = r.id
    WHERE o.customer_id = ?
      AND o.state IN ('DISPATCHED','INVOICED','PAID')
    GROUP BY r.reference, ri.barcode_at_request, ri.product_name_at_request, ri.box_uom_at_request
    ORDER BY r.reference DESC, ri.product_name_at_request`;
}

export function listReturnableItems(db, customerId) {
  return db.prepare(eligibleItemsQuery()).all(customerId)
    .filter((item) => item.availableCartons > 0);
}

export function listCustomerReturnRequests(db, customerId) {
  return db.prepare(`
    SELECT reference, order_reference AS orderReference, product_name AS productName,
           barcode, cartons, reason, status, decline_reason AS declineReason,
           created_at AS createdAt, reviewed_at AS reviewedAt
    FROM customer_return_requests
    WHERE customer_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(customerId);
}

export function createCustomerReturnRequest(db, customerId, input = {}, now = new Date()) {
  const orderReference = typeof input.orderReference === 'string' ? input.orderReference.trim().slice(0, 64) : '';
  const barcode = typeof input.barcode === 'string' ? input.barcode.trim().slice(0, 128) : '';
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  const cartons = Number(input.cartons);

  if (!orderReference || !barcode) throw new CustomerReturnRequestError('Choose a product from one of your eligible orders.');
  if (!reason || reason.length > MAX_REASON_LENGTH) {
    throw new CustomerReturnRequestError(`Enter a return reason of up to ${MAX_REASON_LENGTH} characters.`);
  }
  if (!Number.isSafeInteger(cartons) || cartons < 1) {
    throw new CustomerReturnRequestError('Enter a whole-carton quantity of at least one.');
  }

  const matchingLines = db.prepare(`
    SELECT ri.id, ri.product_name_at_request AS productName,
           ri.quantity_ctn AS purchasedCartons
    FROM requests r
    JOIN odoo_orders o ON o.request_id = r.id
    JOIN request_items ri ON ri.request_id = r.id
    WHERE o.customer_id = ?
      AND o.state IN ('DISPATCHED','INVOICED','PAID')
      AND r.reference = ?
      AND ri.barcode_at_request = ?
  `).all(customerId, orderReference, barcode);
  if (!matchingLines.length) {
    throw new CustomerReturnRequestError('That product is not on one of your eligible orders.', 404);
  }

  const returned = db.prepare(`
    SELECT COALESCE(SUM(cr.cartons), 0) AS cartons
    FROM customer_return_requests cr
    WHERE cr.customer_id = ? AND cr.order_reference = ? AND cr.barcode = ?
      AND cr.status != 'DECLINED'
  `).get(customerId, orderReference, barcode).cartons;
  const purchased = matchingLines.reduce((sum, line) => sum + line.purchasedCartons, 0);
  if (cartons > purchased - returned) {
    throw new CustomerReturnRequestError('The requested quantity exceeds the cartons still available to return.');
  }

  const reference = `RET-${randomUUID().toUpperCase()}`;
  const createdAt = now.toISOString();
  db.prepare(`
    INSERT INTO customer_return_requests
      (reference, customer_id, request_item_id, order_reference, barcode, product_name,
       cartons, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)
  `).run(reference, customerId, matchingLines[0].id, orderReference, barcode,
    matchingLines[0].productName, cartons, reason, createdAt);
  return { reference, orderReference, productName: matchingLines[0].productName, barcode, cartons, reason, status: 'PENDING', createdAt };
}

export function listStaffCustomerReturnRequests(db) {
  return db.prepare(`
    SELECT cr.reference, cr.order_reference AS orderReference, cr.product_name AS productName,
           cr.barcode, cr.cartons, cr.reason, cr.status, cr.decline_reason AS declineReason,
           cr.created_at AS createdAt, cr.reviewed_at AS reviewedAt, cr.reviewed_by AS reviewedBy,
           c.name AS customerName
    FROM customer_return_requests cr
    JOIN customers c ON c.id = cr.customer_id
    ORDER BY CASE cr.status WHEN 'PENDING' THEN 0 ELSE 1 END, cr.created_at DESC
  `).all();
}

export function decideCustomerReturnRequest(db, reference, input = {}, reviewer, now = new Date()) {
  const decision = typeof input.decision === 'string' ? input.decision.trim().toUpperCase() : '';
  const declineReason = typeof input.declineReason === 'string' ? input.declineReason.trim() : '';
  if (!['APPROVED', 'DECLINED'].includes(decision)) {
    throw new CustomerReturnRequestError('Choose approve or decline.');
  }
  if (decision === 'DECLINED' && (!declineReason || declineReason.length > MAX_REASON_LENGTH)) {
    throw new CustomerReturnRequestError(`A decline reason is required (up to ${MAX_REASON_LENGTH} characters).`);
  }
  const row = db.prepare('SELECT status FROM customer_return_requests WHERE reference = ?').get(reference);
  if (!row) throw new CustomerReturnRequestError('Return request not found.', 404);
  if (row.status !== 'PENDING') throw new CustomerReturnRequestError('This return request has already been decided.', 409);

  const reviewedAt = now.toISOString();
  const result = db.prepare(`
    UPDATE customer_return_requests
    SET status = ?, decline_reason = ?, reviewed_at = ?, reviewed_by = ?
    WHERE reference = ? AND status = 'PENDING'
  `).run(decision, decision === 'DECLINED' ? declineReason : null, reviewedAt, reviewer || 'Staff', reference);
  if (!result.changes) throw new CustomerReturnRequestError('This return request has already been decided.', 409);
  return { reference, status: decision, declineReason: decision === 'DECLINED' ? declineReason : null, reviewedAt };
}
