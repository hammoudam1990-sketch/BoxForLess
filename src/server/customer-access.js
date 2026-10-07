// Customer access sessions, established by an access code.
//
// Mirrors staff-auth.js in shape, but the two are deliberately SEPARATE: they use
// different cookies and different secrets, so a customer session can never be
// mistaken for a staff session, and leaking one cannot forge the other.
//
// The session cookie carries the customer's INTERNAL id. That is safe where the
// opaque handle was needed before, because the value is signed and HttpOnly: the
// browser cannot read it or alter it, and the server verifies the signature on
// every request. The id never appears in a response body.
import crypto from 'node:crypto';
import config from '../config.js';
import { resolveAccessCode, normalizeAccessCode, CODE_LENGTH } from '../domain/access-codes.js';

const COOKIE_NAME = 'bfl_customer';
const WINDOW_MS = 15 * 60 * 1000;

// Rate limiting is the ONLY thing standing between an 8-character code and a
// patient attacker, so it is not optional and not configurable to zero.
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function sessionSeconds() { return Math.max(1, Number(config.customerAccess.sessionDays)) * 24 * 60 * 60; }
function secret() { return String(config.customerAccess.sessionSecret); }
function isSecureCookie() { return process.env.NODE_ENV === 'production' || process.env.BFL_COOKIE_SECURE === 'true'; }

function sign(payload) {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url');
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function cookieValue(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE_NAME) return value.join('=');
  }
  return '';
}

function setCookie(res, payload) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; `
    + `Max-Age=${sessionSeconds()}${isSecureCookie() ? '; Secure' : ''}`);
}

/**
 * The customer this request belongs to, or null.
 *
 * Re-reads the customer from the database on every call rather than trusting the
 * name in the cookie, so deactivating a customer ends their access immediately
 * instead of when their cookie happens to expire.
 */
export function currentCustomer(req) {
  const token = cookieValue(req);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  if (!safeEqual(token.slice(dot + 1), sign(payload))) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!(Number(session.exp) > Date.now())) return null;
    const row = req.db.prepare(
      'SELECT id, name, delivery_address, session_epoch FROM customers WHERE id = ? AND is_active = 1'
    ).get(Number(session.cid));
    if (!row) return null;
    // A token issued before the customer's sessions were ended is refused, even
    // if the browser still has the cookie. This is what makes "the session ends
    // with the order" a guarantee rather than a request to the browser.
    if (Number(session.ep ?? 0) !== Number(row.session_epoch ?? 0)) return null;
    return row;
  } catch { return null; }
}

/** POST — exchange a code for a session. */
export function enterAccessCode(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (attempts.size > 500) {
    for (const [key, value] of attempts) {
      if (now - value.started >= WINDOW_MS) attempts.delete(key);
    }
  }
  const prior = attempts.get(ip);
  const recent = prior && now - prior.started < WINDOW_MS ? prior : { started: now, count: 0 };
  if (recent.count >= MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
  }
  recent.count += 1;
  attempts.set(ip, recent);

  const code = normalizeAccessCode(req.body?.code);
  if (code.length !== CODE_LENGTH) {
    return res.status(400).json({ error: `An access code is ${CODE_LENGTH} characters.` });
  }

  const customer = resolveAccessCode(req.db, code);
  // One message for "no such code" and for "that customer is inactive", so the
  // response cannot be used to test which codes exist.
  if (!customer) return res.status(401).json({ error: 'That access code was not recognised.' });

  attempts.delete(ip);
  const epoch = Number(
    req.db.prepare('SELECT session_epoch FROM customers WHERE id = ?').get(customer.id)?.session_epoch ?? 0
  );
  setCookie(res, Buffer.from(JSON.stringify({
    cid: customer.id, ep: epoch, exp: now + sessionSeconds() * 1000,
  })).toString('base64url'));
  res.json({ ok: true, customer: publicCustomer(customer) });
}

/**
 * What a customer may see about themselves. Their own name and their own delivery
 * address — never the internal id, the Odoo ref, the code, or anything belonging
 * to another customer. Built field by field so a column added later cannot leak.
 */
function publicCustomer(row) {
  return { name: row.name, deliveryAddress: row.delivery_address || null };
}

/** GET — who am I? The name only; never the id or the code. */
export function accessStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const customer = currentCustomer(req);
  res.json(customer ? { authenticated: true, customer: publicCustomer(customer) } : { authenticated: false });
}

/**
 * End the customer session.
 *
 * Called when someone taps "Not you?", and ALSO after every successful
 * submission: a salesman visits several customers in a day carrying one phone, so
 * a session that outlived the order would file the next customer's request under
 * the previous one. Re-entering the code per order is the cost of that being
 * impossible rather than merely unlikely.
 */
export function clearCustomerSession(res, db = null, customerId = null) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecureCookie() ? '; Secure' : ''}`);
  // Bumping the epoch is what actually ends it: the cookie header is only a
  // request to the browser, and a browser that ignores it would otherwise keep a
  // working session.
  if (db && customerId != null) {
    db.prepare('UPDATE customers SET session_epoch = COALESCE(session_epoch, 0) + 1 WHERE id = ?').run(Number(customerId));
  }
}

export function exitAccess(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const customer = currentCustomer(req);
  clearCustomerSession(res, req.db, customer?.id ?? null);
  res.status(204).end();
}

/** Gate for the request endpoints. Browsing the catalog never passes through this. */
export function requireCustomer(req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  const customer = currentCustomer(req);
  if (!customer) {
    return res.status(401).json({
      code: 'ACCESS_CODE_REQUIRED',
      error: 'Please enter your access code to send a request.',
    });
  }
  // Same-origin check on writes, matching requireStaff.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (!origin || origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
  }
  req.customer = customer;
  next();
}

/**
 * Clear the rate-limit counters. For tests only: the counters are per-process and
 * keyed by IP, so every test in a file shares one budget and a test that
 * deliberately exhausts it would lock out the ones after it.
 */
export function resetAccessAttempts() { attempts.clear(); }

export default {
  currentCustomer, enterAccessCode, accessStatus, exitAccess,
  requireCustomer, clearCustomerSession,
};
