// Customer sign-in: the customer's Odoo ID and a password.
//
// The ID is the customer's Odoo customer ID (`customers.odoo_customer_ref`), which ties them to their
// price list, rep, credit limit and balance in Odoo. Until the Odoo sync fills that in — and for a
// customer who has no Odoo account (a cash buyer, or a company waiting to be created in Odoo) — the
// phone number or email they registered with works instead, but only where it points to exactly one
// customer, so a shared or junk number can never sign anyone in.
//
// A password is set once, by the customer, the first time, using the ID plus the access code staff
// sent them (the code is the proof it is really them). From then on the code no longer signs them
// in. Staff can reset a customer, which clears the password and issues a new code.
import { hashPassword, verifyPassword, passwordProblem } from './passwords.js';
import { issueAccessCode, normalizeAccessCode } from './access-codes.js';
import { phoneKey } from './staff-accounts.js';

export class CustomerAuthError extends Error {
  constructor(message, status = 400, code = 'CUSTOMER_AUTH_INVALID') { super(message); this.name = 'CustomerAuthError'; this.status = status; this.code = code; }
}

const ROW = 'id, name, odoo_customer_ref, phone, email, access_code, password_hash, password_set_at, is_active';

/**
 * The one active customer this ID, phone number or email points to, or null.
 * An Odoo ID matches first. A phone number or email is only used for customers WITHOUT an Odoo ID,
 * and only when it matches exactly one of them.
 */
export function findCustomerByLoginId(db, identifier) {
  const id = String(identifier ?? '').trim();
  if (!id || id.length > 120) return null;
  const byOdoo = db.prepare(`SELECT ${ROW} FROM customers WHERE is_active = 1 AND odoo_customer_ref = ? COLLATE NOCASE`).get(id);
  if (byOdoo) return byOdoo;
  const candidates = db.prepare(`SELECT ${ROW} FROM customers WHERE is_active = 1 AND (odoo_customer_ref IS NULL OR odoo_customer_ref = '')`).all();
  let matches;
  if (id.includes('@')) matches = candidates.filter((c) => String(c.email || '').trim().toLowerCase() === id.toLowerCase());
  else {
    const key = phoneKey(id);
    matches = key ? candidates.filter((c) => phoneKey(c.phone) === key) : [];
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Sign in with ID and password. Returns the customer row or null; an unknown ID, an account with no password yet, and a wrong password look the same. */
export function authenticateCustomer(db, identifier, password) {
  const c = findCustomerByLoginId(db, identifier);
  const ok = verifyPassword(password, c?.password_hash);
  return c && ok ? c : null;
}

/** Has this customer chosen a password? (Once they have, the access code alone no longer signs them in.) */
export const hasPassword = (db, customerId) => Boolean(db.prepare('SELECT password_hash FROM customers WHERE id = ?').get(Number(customerId))?.password_hash);

/**
 * First time: prove it is them with the ID and the access code staff sent, and choose a password.
 * @returns the customer row
 */
export function activateCustomer(db, identifier, code, newPassword, now = new Date()) {
  const c = findCustomerByLoginId(db, identifier);
  const given = normalizeAccessCode(code);
  // one message for "no such customer" and "wrong code", so this cannot be used to find out who exists
  if (!c || !c.access_code || normalizeAccessCode(c.access_code) !== given) {
    throw new CustomerAuthError('That ID and access code do not match. Check both, or ask Box for Less.', 401, 'ACTIVATION_REFUSED');
  }
  if (c.password_hash) {
    throw new CustomerAuthError('This account is already set up. Sign in with your ID and password, or ask Box for Less to reset it.', 409, 'ALREADY_ACTIVATED');
  }
  const problem = passwordProblem(newPassword, [c.odoo_customer_ref, c.phone, c.email, c.name, c.access_code]);
  if (problem) throw new CustomerAuthError(problem);
  db.prepare('UPDATE customers SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(newPassword), now.toISOString(), now.toISOString(), c.id);
  return c;
}

/** Change one's own password. */
export function changeCustomerPassword(db, customerId, current, next, now = new Date()) {
  const c = db.prepare(`SELECT ${ROW} FROM customers WHERE id = ? AND is_active = 1`).get(Number(customerId));
  if (!c || !verifyPassword(current, c.password_hash)) throw new CustomerAuthError('Your current password is not right.', 403, 'WRONG_PASSWORD');
  const problem = passwordProblem(next, [c.odoo_customer_ref, c.phone, c.email, c.name]);
  if (problem) throw new CustomerAuthError(problem);
  db.prepare('UPDATE customers SET password_hash = ?, password_set_at = ?, updated_at = ? WHERE id = ?')
    .run(hashPassword(next), now.toISOString(), now.toISOString(), c.id);
}

/**
 * Staff reset a customer: their password is cleared, every session they have ends, and a NEW access
 * code is issued so they can set a new password. Returns the new code (formatted by the caller).
 */
export function resetCustomerPassword(db, customerId, now = new Date()) {
  const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) return null;
  db.prepare('UPDATE customers SET password_hash = NULL, password_set_at = NULL, session_epoch = COALESCE(session_epoch, 0) + 1, updated_at = ? WHERE id = ?')
    .run(now.toISOString(), c.id);
  return issueAccessCode(db, c.id, now);
}

/**
 * Record a customer's Odoo ID. A stand-in for the Odoo sync, which will set it. Unique across customers.
 * Pass an empty value to clear it.
 */
export function setOdooCustomerId(db, customerId, ref) {
  const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) throw new CustomerAuthError('That customer does not exist.', 404);
  const value = String(ref ?? '').trim();
  if (value.length > 40) throw new CustomerAuthError('An Odoo ID is a short number or code.');
  if (value && /[\s@]/.test(value)) throw new CustomerAuthError('An Odoo ID has no spaces or @.');
  if (value && db.prepare('SELECT 1 FROM customers WHERE odoo_customer_ref = ? COLLATE NOCASE AND id <> ?').get(value, c.id)) {
    throw new CustomerAuthError('Another customer already has that Odoo ID.', 409, 'DUPLICATE_ODOO_ID');
  }
  db.prepare('UPDATE customers SET odoo_customer_ref = ?, updated_at = ? WHERE id = ?').run(value || null, new Date().toISOString(), c.id);
  return { id: c.id, odooId: value || null };
}
