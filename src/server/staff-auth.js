// Staff sign-in and what each role may reach.
//
// Two kinds of staff:
//   - the ADMINISTRATOR: one account whose username, password and signing key are supplied by the
//     host environment (never the database). It can do everything and creates the others.
//   - people with an account (staff_users): Sales Manager, Sales rep, Warehouse. They sign in with
//     an email address or a phone number and a password, and each role reaches only its own screens.
//
// The session cookie says WHO (account id) and is signed; the ROLE is always read from the database
// on every request, so switching an account off, or changing its role, takes effect immediately.
import crypto from 'node:crypto';
import { StaffRole, ROLE_HOME, ROLE_LABEL, authenticateStaff, getStaffUser } from '../domain/staff-accounts.js';
import { MAX_PASSWORD_LENGTH } from '../domain/passwords.js';

const COOKIE_NAME = 'bfl_staff_session';
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const LOGIN_MAX_PER_ID = 6;
const attempts = new Map();

function settings() {
  const { BFL_STAFF_USERNAME: username, BFL_STAFF_PASSWORD: password, BFL_SESSION_SECRET: secret } = process.env;
  if (!username || !password || Buffer.byteLength(password) < 12 || !secret || Buffer.byteLength(secret) < 32) return null;
  return { username, password, secret };
}

function cookieValue(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
  }
  return '';
}

function sign(payload, secret) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

const isSecure = () => process.env.NODE_ENV === 'production' || process.env.BFL_COOKIE_SECURE === 'true';

function setSession(res, config, session) {
  const payload = Buffer.from(JSON.stringify({ ...session, exp: Date.now() + SESSION_SECONDS * 1000 })).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${payload}.${sign(payload, config.secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${isSecure() ? '; Secure' : ''}`);
}

export const clearStaffCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure() ? '; Secure' : ''}`;

/**
 * Who is signed in: { id, name, role, repId, mustChangePassword } or null. Needs `req.db`.
 * The ADMIN has id 0. Anyone else is re-read from the database on every call.
 */
export function staffIdentity(req) {
  const config = settings();
  if (!config) return null;
  const token = cookieValue(req);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload, config.secret))) return null;
  let session;
  try { session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  if (!(Number(session.exp) > Date.now())) return null;
  // the administrator (a cookie from before roles existed has no `uid` and is the administrator too)
  if (session.uid === undefined || session.uid === 0) {
    return session.user === config.username ? { id: 0, name: 'Administrator', role: StaffRole.ADMIN, repId: null, mustChangePassword: false } : null;
  }
  const u = getStaffUser(req.db, session.uid);
  if (!u) return null;
  return { id: u.id, name: u.name, role: u.role, repId: u.rep_id, mustChangePassword: Boolean(u.must_change_password) };
}

export const hasStaffSession = (req) => Boolean(staffIdentity(req));

function sendConfigError(res) {
  return res.status(503).json({ error: 'Staff login is not configured on this server.' });
}

export function staffSessionStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!settings()) return sendConfigError(res);
  res.json({ authenticated: hasStaffSession(req) });
}

/** For tests only: the counters are per process. */
export const resetStaffAttempts = () => attempts.clear();

/** Too many tries from one address, or against one account, in the window? Counts this try. */
function throttled(ip, who) {
  const now = Date.now();
  if (attempts.size > 500) for (const [key, value] of attempts) if (now - value.started >= LOGIN_WINDOW_MS) attempts.delete(key);
  const hit = (key, max) => {
    const prior = attempts.get(key);
    const recent = prior && now - prior.started < LOGIN_WINDOW_MS ? prior : { started: now, count: 0 };
    if (recent.count >= max) return true;
    recent.count += 1;
    attempts.set(key, recent);
    return false;
  };
  return hit(`ip:${ip}`, LOGIN_MAX_ATTEMPTS) || hit(`id:${String(who).toLowerCase().slice(0, 80)}`, LOGIN_MAX_PER_ID);
}

/**
 * POST { identifier, password } — an email or phone number and a password. The administrator signs
 * in with the username from the environment. (`username` is accepted for `identifier`, so the old
 * request shape still works.)
 */
export function staffLogin(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const config = settings();
  if (!config) return sendConfigError(res);

  const body = req.body || {};
  const identifier = String(body.identifier ?? body.username ?? '').trim().slice(0, 120);
  const password = String(body.password ?? '').slice(0, MAX_PASSWORD_LENGTH);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (throttled(ip, identifier)) return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });

  const refuse = () => res.status(401).json({ error: 'That email, phone number or password is not right.' });

  // the administrator
  const isEmailAdmin = config.username.includes('@');
  const adminMatch = identifier && (
    safeEqual(identifier.toLowerCase(), config.username.toLowerCase()) ||
    (isEmailAdmin && safeEqual(identifier.toLowerCase(), 'admin'))
  );
  if (adminMatch && safeEqual(password, config.password)) {
    setSession(res, config, { user: config.username, uid: 0 });
    attempts.delete(`ip:${ip}`);
    return res.json({ authenticated: true, role: StaffRole.ADMIN, name: 'Administrator', home: ROLE_HOME.ADMIN, mustChangePassword: false });
  }

  const user = authenticateStaff(req.db, identifier, password);
  if (!user) return refuse();
  setSession(res, config, { user: user.name, uid: user.id });
  attempts.delete(`ip:${ip}`);
  res.json({
    authenticated: true, role: user.role, roleLabel: ROLE_LABEL[user.role], name: user.name, home: ROLE_HOME[user.role],
    mustChangePassword: Boolean(user.must_change_password),
  });
}

export function staffLogout(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Set-Cookie', clearStaffCookie());
  res.status(204).end();
}

/**
 * Gate for the staff API: a signed-in staff member, same-origin on writes, and — if their account
 * still has a temporary password — nothing but choosing a new one.
 * Sets `req.staff`.
 */
export function requireStaff(req, res, next) {
  // Node's built-in test runner sets this only in its child processes so API
  // integration tests can keep constructing createApp() without credentials.
  if (process.env.NODE_TEST_CONTEXT) { req.staff = { id: 0, name: 'Test', role: StaffRole.ADMIN, repId: null, mustChangePassword: false }; return next(); }
  res.setHeader('Cache-Control', 'no-store');
  if (!settings()) return sendConfigError(res);
  const who = staffIdentity(req);
  if (!who) return res.status(401).json({ error: 'Please sign in to the staff area.' });
  if (who.mustChangePassword) return res.status(403).json({ error: 'Choose a new password before you continue.', code: 'PASSWORD_CHANGE_REQUIRED' });

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (!origin || origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
  }
  req.staff = who;
  next();
}

/**
 * Only these roles. Pass a role name for full access, or an object { ROLE: 'rw' | 'r' } to give a role
 * read-only access (GET/HEAD) to the same screens, e.g. requireRole({ ADMIN: 'rw', SALES_MANAGER: 'r' }).
 */
export function requireRole(...allowed) {
  const rules = new Map();
  for (const a of allowed) {
    if (typeof a === 'string') rules.set(a, 'rw');
    else for (const [role, mode] of Object.entries(a)) rules.set(role, mode);
  }
  return (req, res, next) => {
    const mode = rules.get(req.staff?.role);
    const reading = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (!mode || (mode === 'r' && !reading)) return res.status(403).json({ error: 'Your role does not include this.', code: 'FORBIDDEN_ROLE' });
    next();
  };
}

/** Pages: a signed-in staff member in one of these roles, else back to the sign-in page (or to their own home). */
export function privatePageFor(...roles) {
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const who = staffIdentity(req);
    if (!who) return res.redirect(`/staff/login?next=${encodeURIComponent(req.path)}`);
    if (who.mustChangePassword) return res.redirect('/staff/login?change=1');
    if (!roles.includes(who.role)) return res.redirect(ROLE_HOME[who.role] || '/');
    next();
  };
}

export default { hasStaffSession, staffIdentity, staffSessionStatus, staffLogin, staffLogout, requireStaff, requireRole, privatePageFor };
