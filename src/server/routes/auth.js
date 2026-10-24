// Sign-in routes. Public by necessity (signing in is how anyone proves who they are); every one is
// rate-limited per address AND per account, answers with one message whether the account exists or
// not, and never returns a password, a hash, an internal id or a code.
//
//   POST /api/auth/customer/login      { id, password }              customer ID + password
//   POST /api/auth/customer/activate   { id, code, password }        first time: ID + access code, choose a password
//   POST /api/auth/customer/password   { current, next }             change my password (signed in)
//   POST /api/auth/staff/password      { current, next }             change my password (staff, signed in)
//   GET  /api/auth/me                                                who am I?
//   POST /api/auth/logout                                            sign out (customer and staff)
//
// Staff sign in at POST /api/staff/login (see server/staff-auth.js).
import express from 'express';
import {
  authenticateCustomer, activateCustomer, changeCustomerPassword, CustomerAuthError,
} from '../../domain/customer-auth.js';
import { changeStaffPassword, StaffAccountError, ROLE_HOME, ROLE_LABEL } from '../../domain/staff-accounts.js';
import { MAX_PASSWORD_LENGTH } from '../../domain/passwords.js';
import { startCustomerSession, currentCustomer, customerCookieClear } from '../customer-access.js';
import { staffIdentity, clearStaffCookie } from '../staff-auth.js';
import { clearRoleCookies } from '../role-auth.js';

const router = express.Router();

const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();
/** Count one try against the address and the account; true when either has had too many. */
function throttled(req, who, perAddress = 15, perAccount = 6) {
  const now = Date.now();
  if (attempts.size > 1000) for (const [k, v] of attempts) if (now - v.started >= WINDOW_MS) attempts.delete(k);
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const hit = (key, max) => {
    const prior = attempts.get(key);
    const recent = prior && now - prior.started < WINDOW_MS ? prior : { started: now, count: 0 };
    if (recent.count >= max) return true;
    recent.count += 1; attempts.set(key, recent); return false;
  };
  return hit(`c-ip:${ip}`, perAddress) || hit(`c-id:${String(who).toLowerCase().slice(0, 80)}`, perAccount);
}
/** For tests only: the counters are per process. */
export const resetAuthAttempts = () => attempts.clear();

const text = (v, max = 200) => String(v ?? '').slice(0, max);
const sameOrigin = (req) => { const o = req.get('origin'); return Boolean(o) && o === `${req.protocol}://${req.get('host')}`; };
const TOO_MANY = { error: 'Too many attempts. Please wait 15 minutes and try again.' };

router.post('/customer/login', (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const id = text(req.body?.id, 120).trim();
    if (throttled(req, id)) return res.status(429).json(TOO_MANY);
    const c = authenticateCustomer(req.db, id, text(req.body?.password, MAX_PASSWORD_LENGTH));
    if (!c) {
      return res.status(401).json({ error: 'That ID or password is not right. First time here? Use "Activate your account".', code: 'SIGNIN_REFUSED' });
    }
    startCustomerSession(res, req.db, c.id, 'password');
    res.json({ ok: true, customer: { name: c.name }, home: '/catalog' });
  } catch (e) { next(e); }
});

router.post('/customer/activate', (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    const id = text(req.body?.id, 120).trim();
    if (throttled(req, id, 15, 6)) return res.status(429).json(TOO_MANY);
    const c = activateCustomer(req.db, id, text(req.body?.code, 40), text(req.body?.password, MAX_PASSWORD_LENGTH));
    startCustomerSession(res, req.db, c.id, 'password');
    res.json({ ok: true, customer: { name: c.name }, home: '/catalog' });
  } catch (e) {
    if (e instanceof CustomerAuthError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/customer/password', (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return res.status(403).json({ error: 'This request could not be verified.' });
    const c = currentCustomer(req);
    if (!c || c.method !== 'password') return res.status(401).json({ error: 'Please sign in with your ID and password.' });
    if (throttled(req, `pw-${c.id}`, 15, 6)) return res.status(429).json(TOO_MANY);
    changeCustomerPassword(req.db, c.id, text(req.body?.current, MAX_PASSWORD_LENGTH), text(req.body?.next, MAX_PASSWORD_LENGTH));
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof CustomerAuthError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.post('/staff/password', (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) return res.status(403).json({ error: 'This request could not be verified.' });
    const who = staffIdentity(req);
    if (!who || who.id === 0) return res.status(401).json({ error: 'Please sign in.' });
    if (throttled(req, `spw-${who.id}`, 15, 6)) return res.status(429).json(TOO_MANY);
    changeStaffPassword(req.db, who.id, text(req.body?.current, MAX_PASSWORD_LENGTH), text(req.body?.next, MAX_PASSWORD_LENGTH));
    res.json({ ok: true, home: ROLE_HOME[who.role] });
  } catch (e) {
    if (e instanceof StaffAccountError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

router.get('/me', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const c = currentCustomer(req);
  const s = staffIdentity(req);
  res.json({
    customer: c ? { name: c.name, viaPassword: c.method === 'password' } : null,
    staff: s ? { name: s.name, role: s.role, roleLabel: ROLE_LABEL[s.role] || 'Administrator', home: ROLE_HOME[s.role], mustChangePassword: s.mustChangePassword } : null,
  });
});

router.post('/logout', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const c = currentCustomer(req);
  // a code session also ends every other use of that code; a password session is just this device
  if (c && c.method !== 'password') req.db.prepare('UPDATE customers SET session_epoch = COALESCE(session_epoch, 0) + 1 WHERE id = ?').run(c.id);
  res.setHeader('Set-Cookie', [clearStaffCookie(), customerCookieClear(), ...clearRoleCookies()]);
  res.status(204).end();
});

export default router;
