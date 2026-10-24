// Placing a request for a customer: the one path a customer's own request and a sales rep's request both take, so
// the two can never check different things. Stock, shelf life, credit, discounted offers and the draft quotation
// for Odoo all run here, on the server, whatever the browser says.
import { submitRequest, RequestValidationError } from './requests.js';
import { checkRequestLines, requireAcceptance, saveAcceptances } from './shelf-life.js';
import { createOrderForRequest, assertCredit, checkCredit, CREDIT_LIMIT_EXCEEDED } from './orders.js';
import { applyClearance } from './lot-discounts.js';
import { logCreditBlock } from './order-log.js';

/**
 * Lines from a request body, normalised to { barcode, quantityCtn }.
 * @param {object} body
 */
export function readLines(body) {
  const raw = Array.isArray(body?.lines) ? body.lines : [];
  return raw.slice(0, 200).map((l) => ({
    barcode: String(l?.barcode ?? '').trim(),
    quantityCtn: l?.quantityCtn,
  }));
}

/**
 * Place a request for a customer. Identity is the caller's job: `customerId` comes from the customer's own session,
 * or, for a sales rep, from a customer the server has checked is on that rep's list (see rep-orders.js).
 * @param {object} db
 * @param {{ customerId:number, body:object, placedBy?:{ staffId:number, name:string } }} input
 * @returns {{ reference:string, lineCount:number }}
 */
export function placeRequest(db, { customerId, body = {}, placedBy = null }) {
  const lines = readLines(body);
  // A customer with a minimum shelf life must accept any line that would be filled with shorter-dated stock.
  const shelf = checkRequestLines(db, customerId, lines);
  const accepted = requireAcceptance(shelf, body.acceptedShortDated);
  // Over the customer's available credit? Refuse and log it (the report counts blocked orders). The same check runs
  // again inside the transaction below, so two requests at once cannot both pass.
  const credit = checkCredit(db, customerId, lines);
  if (!credit.ok) {
    logCreditBlock(db, customerId, credit);
    throw new RequestValidationError('Over your available credit.', { errors: [{ code: CREDIT_LIMIT_EXCEEDED, message: credit.message }] });
  }
  return submitRequest(db, {
    lines,
    // saved in the same transaction as the request itself, and the order for it, with its draft quotation queued for Odoo
    onInsert: (requestId) => {
      assertCredit(db, customerId, lines);
      saveAcceptances(db, requestId, customerId, shelf.minDays, accepted);
      // which cartons are on a discounted near-expiry offer (re-read here on the server, never taken from the browser)
      applyClearance(db, requestId, customerId);
      if (placedBy) db.prepare('UPDATE requests SET placed_by_rep = ?, placed_by_staff_id = ? WHERE id = ?').run(String(placedBy.name), Number(placedBy.staffId), requestId);
      createOrderForRequest(db, requestId);
    },
    customerId,
    unlisted: null,
    // An address typed for THIS order. Empty falls back to the one stored on the customer; see submitRequest.
    deliveryAddress: body.deliveryAddress ? String(body.deliveryAddress).slice(0, 500) : null,
    notes: body.notes ? String(body.notes).slice(0, 2000) : null,
  });
}
