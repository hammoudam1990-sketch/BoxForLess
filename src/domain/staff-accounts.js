// Staff accounts: one per person, each with a role.
//
// Staff sign in with an email address OR a phone number, plus a password. The roles:
//   SALES_MANAGER  approves registrations and discounts, sets customers up, creates sales reps
//   SALES_REP      the phone screens for their own customers
//   WAREHOUSE      products, imports, change review, the expiry list, the scanner
// The owner's account (set in the server's environment, never in the database) is the ADMIN: it
// can do everything and creates the first accounts. See server/staff-auth.js for how a role
// becomes access.
import { hashPassword, verifyPassword, passwordProblem, temporaryPassword } from './passwords.js';
import { listReps } from './shelf.js';
import { repIdForAccount } from './reps.js';

export const StaffRole = Object.freeze({
  ADMIN: 'ADMIN',
  SALES_MANAGER: 'SALES_MANAGER',
  SALES_REP: 'SALES_REP',
  WAREHOUSE: 'WAREHOUSE',
});
/** The roles that live in the database (ADMIN does not). */
export const ACCOUNT_ROLES = Object.freeze([StaffRole.SALES_MANAGER, StaffRole.SALES_REP, StaffRole.WAREHOUSE]);
export const ROLE_LABEL = Object.freeze({
  ADMIN: 'Administrator', SALES_MANAGER: 'Sales Manager', SALES_REP: 'Sales rep', WAREHOUSE: 'Warehouse',
});
/** Where each role lands after signing in. */
export const ROLE_HOME = Object.freeze({
  ADMIN: '/index.html', SALES_MANAGER: '/index.html', WAREHOUSE: '/index.html', SALES_REP: '/rep.html',
});

export class StaffAccountError extends Error {
  constructor(message, status = 400, code = 'STAFF_ACCOUNT_INVALID') { super(message); this.name = 'StaffAccountError'; this.status = status; this.code = code; }
}

export const phoneKey = (v) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length >= 7 ? d.slice(-9) : null; };
const emailOf = (v) => { const e = String(v ?? '').trim().toLowerCase(); return e || null; };
const clean = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

/** Which roles a given actor may create or manage. A manager looks after sales reps only. */
export function rolesManagedBy(actorRole) {
  if (actorRole === StaffRole.ADMIN) return [...ACCOUNT_ROLES];
  if (actorRole === StaffRole.SALES_MANAGER) return [StaffRole.SALES_REP];
  return [];
}

const shape = (u) => ({
  id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role, roleLabel: ROLE_LABEL[u.role],
  repId: u.rep_id, active: Boolean(u.is_active), mustChangePassword: Boolean(u.must_change_password),
  lastLoginAt: u.last_login_at, createdAt: u.created_at,
});

export function listStaffUsers(db, actorRole) {
  const managed = rolesManagedBy(actorRole);
  return db.prepare('SELECT * FROM staff_users ORDER BY is_active DESC, name').all().filter((u) => managed.includes(u.role)).map(shape);
}

/**
 * Create an account. Returns the account AND its one-time password — shown once, then only the hash
 * exists. The person must choose their own password the first time they sign in.
 */
export function createStaffUser(db, input, actorRole, actorName = null, now = new Date()) {
  const role = String(input.role || '');
  if (!rolesManagedBy(actorRole).includes(role)) throw new StaffAccountError('You cannot create that kind of account.', 403, 'FORBIDDEN_ROLE');
  const name = clean(input.name, 120);
  const email = emailOf(input.email);
  const phone = clean(input.phone, 40);
  if (!name) throw new StaffAccountError('Please give their name.');
  if (!email && !phone) throw new StaffAccountError('Give an email address or a phone number — it is how they sign in.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new StaffAccountError('That email address does not look right.');
  const key = phone ? phoneKey(phone) : null;
  if (phone && !key) throw new StaffAccountError('That phone number does not look right.');

  let repId = null;
  if (role === StaffRole.SALES_REP) {
    // "NEW" (or nothing) makes a new rep with no customers yet; otherwise it is one of the sample reps
    repId = String(input.repId || 'NEW');
    if (repId !== 'NEW' && !listReps(now.toISOString().slice(0, 10)).some((r) => r.id === repId)) throw new StaffAccountError('Choose which sales rep this is.');
  }
  if ((email && db.prepare('SELECT 1 FROM staff_users WHERE email = ?').get(email)) || (key && db.prepare('SELECT 1 FROM staff_users WHERE phone_key = ?').get(key))) {
    throw new StaffAccountError('Someone already has that email address or phone number.', 409, 'DUPLICATE_STAFF');
  }
  if (repId && repId !== 'NEW' && db.prepare("SELECT 1 FROM staff_users WHERE rep_id = ? AND is_active = 1").get(repId)) {
    throw new StaffAccountError('That sales rep already has an account.', 409, 'DUPLICATE_STAFF');
  }

  const temp = temporaryPassword();
  const ts = now.toISOString();
  const id = Number(db.prepare(
    `INSERT INTO staff_users (name, email, phone, phone_key, role, rep_id, password_hash, must_change_password, is_active, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,1,1,?,?,?)`
  ).run(name, email, phone, key, role, repId === 'NEW' ? null : repId, hashPassword(temp), actorName, ts, ts).lastInsertRowid);
  if (repId === 'NEW') db.prepare('UPDATE staff_users SET rep_id = ? WHERE id = ?').run(repIdForAccount(id), id);
  return { user: shape(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(id)), temporaryPassword: temp };
}

function managed(db, id, actorRole) {
  const u = db.prepare('SELECT * FROM staff_users WHERE id = ?').get(Number(id));
  if (!u) throw new StaffAccountError('That account does not exist.', 404);
  if (!rolesManagedBy(actorRole).includes(u.role)) throw new StaffAccountError('You cannot change that account.', 403, 'FORBIDDEN_ROLE');
  return u;
}

/** A new one-time password; they must choose their own at next sign-in. */
export function resetStaffPassword(db, id, actorRole, now = new Date()) {
  const u = managed(db, id, actorRole);
  const temp = temporaryPassword();
  db.prepare('UPDATE staff_users SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(hashPassword(temp), now.toISOString(), u.id);
  return { user: shape(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(u.id)), temporaryPassword: temp };
}

/** Switch an account off (or on). Their access ends at once; the record and everything they did is kept. */
export function setStaffActive(db, id, active, actorRole, now = new Date()) {
  const u = managed(db, id, actorRole);
  db.prepare('UPDATE staff_users SET is_active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now.toISOString(), u.id);
  return shape(db.prepare('SELECT * FROM staff_users WHERE id = ?').get(u.id));
}

/**
 * Check a sign-in. `identifier` is an email address or a phone number. Returns the user row, or null.
 * An unknown identifier and a wrong password are indistinguishable, in the answer and in the time taken.
 */
export function authenticateStaff(db, identifier, password, now = new Date()) {
  const id = String(identifier ?? '').trim();
  const row = id.includes('@')
    ? db.prepare('SELECT * FROM staff_users WHERE email = ? AND is_active = 1').get(id.toLowerCase())
    : (phoneKey(id) ? db.prepare('SELECT * FROM staff_users WHERE phone_key = ? AND is_active = 1').get(phoneKey(id)) : null);
  const ok = verifyPassword(password, row?.password_hash);
  if (!row || !ok) return null;
  db.prepare('UPDATE staff_users SET last_login_at = ? WHERE id = ?').run(now.toISOString(), row.id);
  return row;
}

export function getStaffUser(db, id) {
  return db.prepare('SELECT * FROM staff_users WHERE id = ? AND is_active = 1').get(Number(id)) || null;
}

/** Change one's own password. Needs the current one (the temporary one counts). */
export function changeStaffPassword(db, id, current, next, now = new Date()) {
  const u = getStaffUser(db, id);
  if (!u || !verifyPassword(current, u.password_hash)) throw new StaffAccountError('Your current password is not right.', 403, 'WRONG_PASSWORD');
  const problem = passwordProblem(next, [u.email, u.phone, u.phone_key, u.name]);
  if (problem) throw new StaffAccountError(problem);
  if (verifyPassword(next, u.password_hash)) throw new StaffAccountError('Choose a password different from the one you have.');
  db.prepare('UPDATE staff_users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hashPassword(next), now.toISOString(), u.id);
}
