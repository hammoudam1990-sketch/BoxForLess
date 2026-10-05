// "I don't have a code" — a company asking to be let in.
//
// This REPLACES the old unlisted-customer path, where a stranger typed a company
// name and submitted a request directly. That path created an unlisted request
// nobody had approved. Here, asking for access and placing an order are separated:
// a stranger can only ask. Staff approve, which creates the customer master record
// and issues the code; only then can anything be ordered.
//
// Nothing here is customer-facing beyond the acknowledgement. The list, the
// details and the decision are all staff-only.
import { issueAccessCode } from './access-codes.js';

export const AccessRequestStatus = Object.freeze({
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
});

export class AccessRequestError extends Error {
  constructor(msg) { super(msg); this.name = 'AccessRequestError'; this.code = 'ACCESS_REQUEST_INVALID'; this.status = 400; }
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
  if (!contact) throw new AccessRequestError('Please give a contact name.');
  if (!phone) throw new AccessRequestError('Please give a phone number.');

  const ts = now.toISOString();
  const info = db.prepare(
    `INSERT INTO access_requests (company, contact, phone, email, delivery_address, note, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    text(payload.company, 200), contact, phone,
    text(payload.email, 200), text(payload.address, 500), text(payload.note, 1000),
    AccessRequestStatus.PENDING, ts, ts,
  );
  return { id: Number(info.lastInsertRowid), status: AccessRequestStatus.PENDING };
}

/** What the asker is told back. Deliberately carries no id and no code. */
export function toAccessRequestReceipt() {
  return {
    received: true,
    message: 'Thank you. Box for Less will review your details and send you an access code.',
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

/**
 * Approve: create (or reuse) the customer, issue a code, and link it back.
 *
 * Transactional — an approval that fails halfway must not leave a customer with
 * no code, or a code attached to nothing.
 *
 * Reuses an existing ACTIVE customer whose name matches exactly, so approving a
 * company that is already in the master does not create a duplicate; that
 * customer is simply issued a code.
 */
export function approveAccessRequest(db, id, now = new Date()) {
  const request = getAccessRequest(db, id);
  if (!request) return null;
  if (request.status === AccessRequestStatus.APPROVED) {
    throw new AccessRequestError('This request has already been approved.');
  }

  const ts = now.toISOString();
  const name = request.company || request.contact;

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare(
      'SELECT id FROM customers WHERE is_active = 1 AND UPPER(TRIM(name)) = UPPER(TRIM(?))'
    ).get(name);

    let customerId;
    if (existing) {
      customerId = existing.id;
    } else {
      const info = db.prepare(
        `INSERT INTO customers (name, phone, email, is_active, created_at, updated_at)
         VALUES (?,?,?,1,?,?)`
      ).run(name, request.phone, request.email, ts, ts);
      customerId = Number(info.lastInsertRowid);
    }

    const code = issueAccessCode(db, customerId, now);
    db.prepare(
      `UPDATE access_requests SET status = ?, customer_id = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`
    ).run(AccessRequestStatus.APPROVED, customerId, ts, ts, request.id);

    db.exec('COMMIT');
    return { id: request.id, status: AccessRequestStatus.APPROVED, customerId, code, name };
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
  getAccessRequest, approveAccessRequest, rejectAccessRequest,
};
