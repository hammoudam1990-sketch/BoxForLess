// Customer requests: validation and submission.
//
// A request is a customer ASKING for products. It is NOT a reservation and NOT a
// confirmed order — Stage 3 holds no stock, so two customers can both successfully
// request the last carton. That is a deliberate, documented limitation.
//
// Quantities are CTN ONLY. No PCS, no unit selection, no conversion, no parsing of
// "CTN24" strings. `box_uom` travels along purely as a display label.
//
// Validation is ALWAYS server-side and always re-reads stock: the client's idea of
// availability is a stale copy of a copy, and is never trusted.
import { getStockSource } from './stock-source.js';
import config from '../config.js';

function nowIso() { return new Date().toISOString(); }

/** Reasons a line can be refused. Stable codes so the UI need not match prose. */
export const RejectionCode = Object.freeze({
  STOCK_STALE: 'STOCK_STALE',
  PRODUCT_UNAVAILABLE: 'PRODUCT_UNAVAILABLE',
  QUANTITY_INVALID: 'QUANTITY_INVALID',
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  NOT_REQUESTABLE: 'NOT_REQUESTABLE',
  EMPTY_REQUEST: 'EMPTY_REQUEST',
  CUSTOMER_REQUIRED: 'CUSTOMER_REQUIRED',
});

export class RequestValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RequestValidationError';
    this.code = 'REQUEST_INVALID';
    this.status = 409;
    this.details = details;
  }
}

/**
 * Is a requested quantity structurally valid? Whole cartons, at least one.
 * Rejects 0, negatives, fractions, NaN and numeric strings with junk.
 */
export function isValidQuantity(q) {
  const n = Number(q);
  return Number.isInteger(n) && n >= 1;
}

/**
 * Customer-facing message for a rejection. Deliberately discloses NO figure:
 * the data boundary forbids exposing exact stock, so the customer is told what
 * happened and which product, never how many are left.
 */
export function rejectionMessage(code, productName) {
  switch (code) {
    case RejectionCode.INSUFFICIENT_STOCK:
      return `Availability changed for ${productName}. The quantity you requested is no longer available — please reduce it.`;
    case RejectionCode.PRODUCT_UNAVAILABLE:
      return `${productName} is no longer available. Please remove it from your request.`;
    case RejectionCode.NOT_REQUESTABLE:
      return `${productName} cannot be requested right now.`;
    case RejectionCode.QUANTITY_INVALID:
      return `Please enter a whole number of cartons (at least 1) for ${productName}.`;
    default:
      return `${productName} cannot be requested right now.`;
  }
}

/** The one message shown when the stock copy is too old to accept requests. */
export const STALE_STOCK_MESSAGE =
  'Product availability needs to be refreshed before requests can be submitted. Please try again shortly.';

/**
 * Validate a whole request WITHOUT writing anything.
 *
 * @param {object} db
 * @param {Array<{barcode:string, quantityCtn:number}>} lines - keyed by PUBLIC id
 * @returns {{ok:boolean, stock:object, lines:Array, errors:Array}}
 */
export function validateRequest(db, lines = [], opts = {}) {
  const source = opts.stockSource || getStockSource();
  const now = opts.now || new Date();
  const stock = source.getStockStatus(db, now);

  // 1) Freshness gate FIRST. A stale copy may not be used to accept requests,
  //    whatever the individual lines say.
  if (!stock.hasData || !stock.fresh) {
    return {
      ok: false,
      stock,
      lines: [],
      errors: [{ code: RejectionCode.STOCK_STALE, message: STALE_STOCK_MESSAGE }],
    };
  }

  if (!Array.isArray(lines) || lines.length === 0) {
    return {
      ok: false,
      stock,
      lines: [],
      errors: [{ code: RejectionCode.EMPTY_REQUEST, message: 'Your request is empty.' }],
    };
  }

  // 2) Resolve public ids (barcodes) to products, active only.
  const barcodes = lines.map((l) => String(l.barcode ?? '').trim());
  const found = new Map();
  const displayNames = new Map();
  if (barcodes.length) {
    const placeholders = barcodes.map(() => '?').join(',');
    // Names are read for ACTIVE and INACTIVE alike, purely so a rejection can say
    // "X is no longer available" rather than quoting a barcode at the customer.
    // Only `found` (active only) can make a line requestable.
    for (const r of db.prepare(
      `SELECT id, barcode, name, is_active FROM products WHERE barcode IN (${placeholders})`
    ).all(...barcodes)) {
      displayNames.set(r.barcode, r.name);
      if (r.is_active === 1) found.set(r.barcode, r.id);
    }
  }
  const availability = source.getCtnAvailability(db, [...found.values()]);

  // 3) Judge every line. All lines are judged even after the first failure, so the
  //    customer can fix everything in one pass instead of one error at a time.
  const results = [];
  for (const line of lines) {
    const barcode = String(line.barcode ?? '').trim();
    const qty = line.quantityCtn;
    const productId = found.get(barcode);
    const info = productId ? availability.get(productId) : null;
    const name = info?.name || displayNames.get(barcode) || line.name || barcode || 'This product';

    let code = null;
    if (!productId || !info) code = RejectionCode.PRODUCT_UNAVAILABLE;
    else if (!isValidQuantity(qty)) code = RejectionCode.QUANTITY_INVALID;
    else if (info.availableCtn < 1) code = RejectionCode.NOT_REQUESTABLE;
    else if (Number(qty) > info.availableCtn) code = RejectionCode.INSUFFICIENT_STOCK;

    results.push({
      barcode,
      productId: productId ?? null,
      quantityCtn: isValidQuantity(qty) ? Number(qty) : null,
      name,
      boxUom: info?.boxUom ?? null,
      availableCtn: info?.availableCtn ?? 0,   // SERVER-SIDE ONLY — never serialized to a customer
      ok: code === null,
      code,
      message: code ? rejectionMessage(code, name) : null,
    });
  }

  const errors = results.filter((r) => !r.ok)
    .map((r) => ({ barcode: r.barcode, code: r.code, message: r.message }));
  return { ok: errors.length === 0, stock, lines: results, errors };
}

/** Next human-facing reference, e.g. REQ-2026-0001. */
export function nextReference(db, now = new Date()) {
  const year = now.getUTCFullYear();
  const prefix = `REQ-${year}-`;
  const row = db.prepare(
    'SELECT reference FROM requests WHERE reference LIKE ? ORDER BY reference DESC LIMIT 1'
  ).get(`${prefix}%`);
  const last = row ? Number(String(row.reference).slice(prefix.length)) : 0;
  return `${prefix}${String((Number.isFinite(last) ? last : 0) + 1).padStart(4, '0')}`;
}

/**
 * Validate THEN submit, in a single transaction.
 *
 * Atomic by construction: validation runs inside the transaction, and any failing
 * line aborts the whole submission. A partially-written request is never possible.
 *
 * @param {object} payload
 *   { lines, customerRef?, unlisted?: {company, contact, phone}, notes? }
 */
export function submitRequest(db, payload = {}, opts = {}) {
  const now = opts.now || new Date();
  const ts = nowIso();
  const { lines = [], customerRef = null, unlisted = null, notes = null } = payload;

  // A request must be attributable: either a customer master match, or the
  // controlled "not listed" capture. Never anonymous.
  let customerId = null;
  // A customer may be identified by our INTERNAL id (what the route resolves an
  // opaque handle to) or by an Odoo ref. The internal id is the general case:
  // customers imported in this phase have no Odoo id at all, so keying only on
  // odoo_customer_ref would make the Existing Customer path impossible to use.
  const selectedId = payload.customerId ?? null;
  if (selectedId != null || customerRef) {
    const c = selectedId != null
      ? db.prepare('SELECT id FROM customers WHERE id = ? AND is_active = 1').get(Number(selectedId))
      : db.prepare('SELECT id FROM customers WHERE odoo_customer_ref = ? AND is_active = 1').get(String(customerRef));
    if (!c) {
      throw new RequestValidationError('Customer not found.', {
        errors: [{ code: RejectionCode.CUSTOMER_REQUIRED, message: 'Please select your company again.' }],
      });
    }
    customerId = c.id;
  } else if (!unlisted || !String(unlisted.contact || '').trim() || !String(unlisted.phone || '').trim()) {
    // New Customer requires a NAME and a PHONE. Company is optional: an individual
    // customer may not have one, and a request must still be reachable by phone —
    // which is what the later Cash-on-Delivery workflow will depend on.
    throw new RequestValidationError('Customer details are required.', {
      errors: [{
        code: RejectionCode.CUSTOMER_REQUIRED,
        message: 'Please select your customer, or provide your name and phone number.',
      }],
    });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const verdict = validateRequest(db, lines, { ...opts, now });
    if (!verdict.ok) {
      db.exec('ROLLBACK');                       // nothing written
      throw new RequestValidationError('Request could not be submitted.', {
        errors: verdict.errors,
        stock: { fresh: verdict.stock.fresh, hasData: verdict.stock.hasData },
      });
    }

    const reference = nextReference(db, now);
    // Delivery address is captured on the New Customer path only; an existing
    // customer's address lives in the customer record, not on the request.
    // Where this order goes. The customer may edit it for a one-off delivery, in
    // which case the change belongs to THIS request — their stored address is not
    // rewritten, because a single redirected delivery is not a move.
    const typedAddress = String(payload.deliveryAddress ?? '').trim().slice(0, 500);
    const storedAddress = customerId
      ? (db.prepare('SELECT delivery_address FROM customers WHERE id = ?').get(customerId)?.delivery_address || null)
      : null;
    const deliveryAddress = typedAddress
      || storedAddress
      || (unlisted && String(unlisted.address || '').trim()) || null;
    const info = db.prepare(
      `INSERT INTO requests
         (reference, customer_id, unlisted_company, unlisted_contact, unlisted_phone,
          delivery_address, needs_customer_match, notes, status, submitted_at, stock_as_of, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      reference, customerId,
      unlisted ? (unlisted.company ?? null) : null,
      unlisted ? (unlisted.contact ?? null) : null,
      unlisted ? (unlisted.phone ?? null) : null,
      deliveryAddress,
      customerId ? 0 : 1,
      notes ?? null,
      'SUBMITTED', ts, verdict.stock.asOf, ts, ts
    );
    const requestId = Number(info.lastInsertRowid);

    const insertItem = db.prepare(
      `INSERT INTO request_items
         (request_id, product_id, quantity_ctn,
          product_name_at_request, barcode_at_request, box_uom_at_request,
          available_ctn_at_request, created_at)
       VALUES (?,?,?,?,?,?,?,?)`
    );
    for (const l of verdict.lines) {
      // snapshots: products change, a request must still read correctly later
      insertItem.run(requestId, l.productId, l.quantityCtn, l.name, l.barcode, l.boxUom, l.availableCtn, ts);
    }

    if (typeof opts.faultHook === 'function') opts.faultHook(); // test seam
    db.exec('COMMIT');
    return { requestId, reference, lineCount: verdict.lines.length, stockAsOf: verdict.stock.asOf };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

/** Customer-safe view of a submitted request: confirmation only, no internals. */
export function toCustomerReceipt(result) {
  return { reference: result.reference, items: result.lineCount, submitted: true };
}

/**
 * The two customer paths a request can come from. There are exactly two, and they
 * are decided by one fact: whether the request is linked to a row in the customer
 * master.
 *
 * This replaces the earlier `needs_customer_match` framing, which described a
 * request from an unlisted company as something awaiting an Odoo match. There is
 * no Odoo API in this phase and no Odoo id is required, so that wording described
 * work that does not exist. A New Customer is a complete, valid outcome — the
 * details are captured and will feed the Cash-on-Delivery workflow later.
 */
export const CustomerType = Object.freeze({
  EXISTING: 'EXISTING_CUSTOMER',
  NEW: 'NEW_CUSTOMER',
});

export const CUSTOMER_TYPE_LABEL = Object.freeze({
  EXISTING_CUSTOMER: 'EXISTING CUSTOMER',
  NEW_CUSTOMER: 'NEW CUSTOMER',
});

/** EXISTING when the request is linked to the customer master, else NEW. */
export function customerTypeOf(request) {
  return request && request.customer_id ? CustomerType.EXISTING : CustomerType.NEW;
}

/** The customer as staff should see them, whichever path they came from. */
export function customerSummary(request) {
  const type = customerTypeOf(request);
  if (type === CustomerType.EXISTING) {
    return {
      type,
      label: CUSTOMER_TYPE_LABEL[type],
      displayName: request.customer_name || '',
      company: request.customer_name || null,
      contact: null,
      phone: null,
      // The address this particular order goes to, which may differ from the one
      // on the customer record if the customer redirected this delivery. It used
      // to be null here, which hid the destination from the staff who pack it.
      deliveryAddress: request.delivery_address || null,
    };
  }
  const company = request.unlisted_company || null;
  const contact = request.unlisted_contact || null;
  return {
    type,
    label: CUSTOMER_TYPE_LABEL[type],
    displayName: [company, contact].filter(Boolean).join(' · ') || 'Unnamed customer',
    company,
    contact,
    phone: request.unlisted_phone || null,
    deliveryAddress: request.delivery_address || null,
  };
}

/** Staff view of requests. Internal by design — never served to customers. */
export function listRequests(db, { limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const total = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  const items = db.prepare(
    `SELECT r.*, c.name AS customer_name,
            (SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id) AS item_count
       FROM requests r
       LEFT JOIN customers c ON c.id = r.customer_id
      ORDER BY r.id DESC LIMIT ? OFFSET ?`
  ).all(lim, off);
  return {
    total,
    limit: lim,
    offset: off,
    items: items.map((r) => ({ ...r, customer: customerSummary(r) })),
  };
}

export function getRequest(db, id) {
  const request = db.prepare(
    `SELECT r.*, c.name AS customer_name, c.odoo_customer_ref
       FROM requests r LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.id = ?`
  ).get(Number(id));
  if (!request) return null;
  const items = db.prepare(
    'SELECT * FROM request_items WHERE request_id = ? ORDER BY id'
  ).all(Number(id));
  return { request, items, customer: customerSummary(request) };
}

/** Accept a submitted request without changing or reserving stock. */
export function acceptRequest(db, id, now = new Date()) {
  const requestId = Number(id);
  const existing = db.prepare('SELECT id, status FROM requests WHERE id = ?').get(requestId);
  if (!existing) return null;
  if (existing.status !== 'SUBMITTED' && existing.status !== 'ACCEPTED') {
    const error = new Error('Only submitted requests can be accepted.');
    error.code = 'REQUEST_STATUS_CONFLICT';
    throw error;
  }
  if (existing.status === 'SUBMITTED') {
    db.prepare("UPDATE requests SET status = 'ACCEPTED', updated_at = ? WHERE id = ? AND status = 'SUBMITTED'")
      .run(now.toISOString(), requestId);
  }
  return getRequest(db, requestId);
}

/** Delete a request and its item rows (the schema's FK cascade handles items). */
export function deleteRequest(db, id) {
  const result = db.prepare('DELETE FROM requests WHERE id = ?').run(Number(id));
  return Number(result.changes) > 0;
}

export default { validateRequest, submitRequest, listRequests, getRequest, acceptRequest, deleteRequest };
