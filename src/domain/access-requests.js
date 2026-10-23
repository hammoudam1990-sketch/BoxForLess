// Registration: a company or a buyer asking to be let in, and the Sales Manager's decision.
//
// This REPLACES the old unlisted-customer path, where a stranger typed a company
// name and submitted a request directly. That path created an unlisted request
// nobody had approved. Here, asking for access and placing an order are separated:
// a stranger can only ask. Staff approve, which creates the customer master record
// and issues the code; only then can anything be ordered.
//
// The approval decides four things (screen S01): credit or cash customer, the sales rep, the
// price class, and — if the registration looks like someone we already have — which customer it
// really is. A NEW credit customer is queued for Odoo through the outbox; a cash customer never
// is. Nothing here is customer-facing beyond the acknowledgement. The list, the details and the
// decision are all staff-only.
import { issueAccessCode } from './access-codes.js';
import { enqueue, OutboxKind } from './outbox.js';
import { CASH_PRICE_CLASS, DEFAULT_PRICE_CLASS, isPriceClass } from './prices.js';
import { listReps } from './shelf.js';

export const AccessRequestStatus = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

/** CREDIT = a company with its own Odoo account. CASH = a buyer on the shared cash account. */
export const CustomerType = Object.freeze({ CREDIT: 'CREDIT', CASH: 'CASH' });

export class AccessRequestError extends Error {
  constructor(msg, { code = 'ACCESS_REQUEST_INVALID', status = 400, details = null } = {}) {
    super(msg); this.name = 'AccessRequestError'; this.code = code; this.status = status; this.details = details;
  }
}

const text = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Record a request for access. Writes ONLY to `access_requests` — it never
 * creates a customer, never issues a code, and never touches products or stock.
 *
 * Contact name and phone are required: without a way to reach them, staff cannot
 * act on the request. Company is optional, matching the New Customer rule already
 * used for requests — an individual buyer may not have one.
 */
export function createAccessRequest(db, payload = {}, now = new Date()) {
  const contact = text(payload.contact, 200);
  const phone = text(payload.phone, 60);
  const address = text(payload.address, 500);
  if (!contact) throw new AccessRequestError('Please give a contact name.');
  if (!phone) throw new AccessRequestError('Please give a phone number.');
  // Required since 2026-10-05: a company that cannot be delivered to cannot be
  // supplied, so the address is collected before access is granted rather than
  // chased later. Company stays optional — an individual buyer may not have one.
  if (!address) throw new AccessRequestError('Please give a delivery address.');

  const ts = now.toISOString();
  const info = db.prepare(
    `INSERT INTO access_requests (company, contact, phone, email, delivery_address, note, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    text(payload.company, 200), contact, phone,
    text(payload.email, 200), address, text(payload.note, 1000),
    AccessRequestStatus.PENDING, ts, ts,
  );
  const id = Number(info.lastInsertRowid);
  // The registration reference: what the customer quotes, and what is written to Odoo's `ref`.
  const reference = `REG-${now.getUTCFullYear()}-${String(id).padStart(4, '0')}`;
  db.prepare('UPDATE access_requests SET reference = ? WHERE id = ?').run(reference, id);
  return { id, status: AccessRequestStatus.PENDING, reference };
}

/** What the asker is told back. Carries no database id and no code. */
export function toAccessRequestReceipt(reference = null) {
  return {
    received: true,
    status: 'WAITING_FOR_APPROVAL',
    // Same shape whether or not the company is already a customer; the reference is just the
    // next number, so it tells the sender nothing about who else has registered.
    reference,
    message: 'Thank you. Your registration is waiting for approval. Box for Less will contact you with an access code.',
  };
}

/** Staff list. `status` filters; omit for everything, newest first. */
export function listAccessRequests(db, { status = null, limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const where = status ? 'WHERE status = ?' : '';
  const args = status ? [status] : [];
  const total = db.prepare(`SELECT COUNT(*) n FROM access_requests ${where}`).get(...args).n;
  const items = db.prepare(
    `SELECT * FROM access_requests ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
  ).all(...args, lim, off);
  return { total, limit: lim, offset: off, items };
}

export function getAccessRequest(db, id) {
  return db.prepare('SELECT * FROM access_requests WHERE id = ?').get(Number(id)) || null;
}

const normName = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
// Ghana numbers are written +233 24…, 024… or 24…; compare the last nine digits. A "phone" with fewer
// than seven digits ("0", "Office" in the Odoo export) is not an identity and never matches.
const phoneKey = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-9) : null; };
const emailKey = (v) => { const e = String(v ?? '').trim().toLowerCase(); return e.includes('@') ? e : null; };

/**
 * Who might this registration already be? Existing customers sharing the name, the phone number
 * or the email, and other registrations from the same phone, email or name. Staff-only: a
 * customer is never told any of this. The Sales Manager must settle it before approving.
 */
export function findDuplicates(db, request) {
  const name = normName(request.company || request.contact);
  const phone = phoneKey(request.phone);
  const email = emailKey(request.email);
  const customers = [];
  for (const c of db.prepare('SELECT id, name, phone, email, odoo_customer_ref, pricelist, salesperson FROM customers WHERE is_active = 1').all()) {
    const reasons = [];
    if (name && normName(c.name) === name) reasons.push('Same name');
    if (phone && phoneKey(c.phone) === phone) reasons.push('Same phone number');
    if (email && emailKey(c.email) === email) reasons.push('Same email');
    if (reasons.length) {
      customers.push({
        id: c.id, name: c.name, odooRef: c.odoo_customer_ref, phone: c.phone, email: c.email,
        priceClass: c.pricelist, salesperson: c.salesperson, reasons,
      });
    }
  }
  const requests = [];
  for (const r of db.prepare('SELECT id, reference, company, contact, phone, email, status FROM access_requests WHERE id <> ?').all(request.id)) {
    const reasons = [];
    if (phone && phoneKey(r.phone) === phone) reasons.push('Same phone number');
    if (email && emailKey(r.email) === email) reasons.push('Same email');
    if (name && normName(r.company || r.contact) === name) reasons.push('Same name');
    if (reasons.length) requests.push({ id: r.id, reference: r.reference, name: r.company || r.contact, status: r.status, reasons });
  }
  return { customers: customers.slice(0, 8), requests: requests.slice(0, 8) };
}

/** The reps a customer can be assigned to (a sample list until the Odoo salespeople are synced). */
export const repChoices = (db) => listReps(new Date().toISOString().slice(0, 10), db).map((r) => ({ id: r.id, name: r.name }));

/**
 * Approve: create (or reuse) the customer, give them a type, a rep and a price class, issue a code.
 *
 * Transactional — an approval that fails halfway must not leave a customer with no code, or a code
 * attached to nothing.
 *
 * Without `options` this is the original behaviour (reuse an exact-name match, issue a code).
 * With `options.strict` (the Approvals screen) it also:
 *   - stops at a possible duplicate until the Sales Manager says "this is customer X"
 *     (`linkCustomerId`) or "this is a new customer" (`createNew: true`);
 *   - needs a rep for a credit customer;
 *   - checks the price class is a real one. A cash customer is always on the cash-account class.
 *
 * Writes to Odoo go ONLY through the outbox, and only for a NEW CREDIT customer (res.partner, the
 * registration reference in `ref`). A cash customer is never created in Odoo, and an existing
 * customer is never edited there.
 */
export function approveAccessRequest(db, id, options = {}, now = new Date()) {
  const request = getAccessRequest(db, id);
  if (!request) return null;
  if (request.status === AccessRequestStatus.APPROVED) {
    throw new AccessRequestError('This request has already been approved.', { status: 409 });
  }
  const strict = options.strict === true;

  const customerType = options.customerType || (request.company ? CustomerType.CREDIT : CustomerType.CASH);
  if (!Object.values(CustomerType).includes(customerType)) throw new AccessRequestError('Customer type must be credit or cash.');

  const priceClass = customerType === CustomerType.CASH ? CASH_PRICE_CLASS : (options.priceClass || DEFAULT_PRICE_CLASS);
  if (strict && !isPriceClass(priceClass)) throw new AccessRequestError('Choose one of the price classes from the list.');

  let salesperson = null;
  if (options.salespersonId) {
    const rep = repChoices(db).find((r) => r.id === String(options.salespersonId));
    if (!rep) throw new AccessRequestError('Choose one of the sales reps from the list.');
    salesperson = rep.name;
  }
  if (strict && customerType === CustomerType.CREDIT && !salesperson) {
    throw new AccessRequestError('Choose the sales rep for this customer.', { code: 'SALESPERSON_REQUIRED' });
  }

  const link = options.linkCustomerId ? Number(options.linkCustomerId) : null;
  if (strict) {
    const duplicates = findDuplicates(db, request);
    if (duplicates.customers.length && !link && options.createNew !== true) {
      throw new AccessRequestError('This looks like a customer we already have. Link it to that customer, or confirm it is a new one.', {
        code: 'DUPLICATE_CHECK_REQUIRED', status: 409, details: { duplicates },
      });
    }
  }
  if (link && !db.prepare('SELECT 1 FROM customers WHERE id = ? AND is_active = 1').get(link)) {
    throw new AccessRequestError('That customer does not exist.', { status: 404 });
  }

  const ts = now.toISOString();
  const name = request.company || request.contact;

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = link
      ? { id: link }
      : (options.createNew === true ? null : db.prepare(
        'SELECT id FROM customers WHERE is_active = 1 AND UPPER(TRIM(name)) = UPPER(TRIM(?))'
      ).get(name));

    let customerId;
    let odoo;
    let appliedClass = priceClass;
    let appliedRep = salesperson;
    let appliedType = customerType;
    if (existing) {
      customerId = existing.id;
      // Odoo is the master of existing customers: only blanks are filled, nothing is overwritten,
      // and nothing is written back to Odoo.
      db.prepare(
        `UPDATE customers SET
           delivery_address = CASE WHEN delivery_address IS NULL OR delivery_address = '' THEN ? ELSE delivery_address END,
           pricelist        = COALESCE(NULLIF(pricelist, ''), ?),
           salesperson      = COALESCE(NULLIF(salesperson, ''), ?),
           customer_type    = COALESCE(customer_type, ?),
           registration_ref = COALESCE(registration_ref, ?),
           updated_at = ? WHERE id = ?`
      ).run(request.delivery_address, priceClass, salesperson, customerType, request.reference, ts, customerId);
      odoo = 'EXISTING_CUSTOMER';
      // report what the customer actually has now, which is NOT what was chosen where Odoo already had a value
      ({ pricelist: appliedClass, salesperson: appliedRep, customer_type: appliedType } = db.prepare('SELECT pricelist, salesperson, customer_type FROM customers WHERE id = ?').get(customerId));
    } else {
      const info = db.prepare(
        `INSERT INTO customers (name, phone, email, delivery_address, pricelist, salesperson, customer_type, registration_ref, is_active, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?)`
      ).run(name, request.phone, request.email, request.delivery_address, priceClass, salesperson, customerType, request.reference, ts, ts);
      customerId = Number(info.lastInsertRowid);
      if (customerType === CustomerType.CREDIT) {
        enqueue(db, OutboxKind.CREATE_PARTNER, `partner:${request.reference}`, {
          model: 'res.partner',
          values: {
            name, phone: request.phone, email: request.email, street: request.delivery_address,
            ref: request.reference, salesperson, pricelist: priceClass,
          },
        }, now);
        odoo = 'QUEUED';
      } else {
        odoo = 'NOT_NEEDED';
      }
    }

    const code = issueAccessCode(db, customerId, now);
    db.prepare(
      'UPDATE access_requests SET status = ?, customer_id = ?, customer_type = ?, reviewed_at = ?, updated_at = ? WHERE id = ?'
    ).run(AccessRequestStatus.APPROVED, customerId, customerType, ts, ts, request.id);

    db.exec('COMMIT');
    return {
      id: request.id, status: AccessRequestStatus.APPROVED, customerId, code, name,
      reference: request.reference, customerType: appliedType, priceClass: appliedClass, salesperson: appliedRep, odoo,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Reject. Keeps the row — the record of having asked is not erased. */
export function rejectAccessRequest(db, id, reason = null, now = new Date()) {
  const request = getAccessRequest(db, id);
  if (!request) return null;
  const ts = now.toISOString();
  db.prepare(
    'UPDATE access_requests SET status = ?, note = COALESCE(?, note), reviewed_at = ?, updated_at = ? WHERE id = ?'
  ).run(AccessRequestStatus.REJECTED, text(reason, 1000), ts, ts, request.id);
  return { id: request.id, status: AccessRequestStatus.REJECTED };
}

export default {
  createAccessRequest, toAccessRequestReceipt, listAccessRequests,
  getAccessRequest, approveAccessRequest, rejectAccessRequest, findDuplicates,
};
