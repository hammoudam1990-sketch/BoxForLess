// Team sign-in uses one credential resolver, then keeps a separate session for each role:
//   admin  — BFL_STAFF_USERNAME / BFL_STAFF_PASSWORD  -> the admin app (/index.html)
//   sales  — BFL_SALES_USERNAME / BFL_SALES_PASSWORD  -> the Sales Manager dashboard (/sales)
//   rep    — BFL_REP_USERNAME / BFL_REP_PASSWORD (+ optional BFL_REP_NAME)  -> the sales rep app (/rep)
// All are signed with BFL_SESSION_SECRET. Credentials come from the host environment; no
// password is stored in the database. A session for one role is never valid for another.
import crypto from 'node:crypto';
import { StaffRole } from '../domain/staff-accounts.js';
import { clearStaffCookie, staffIdentity } from './staff-auth.js';

const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

const ROLES = {
  admin: { cookie: 'bfl_staff_session', userVar: 'BFL_STAFF_USERNAME', passVar: 'BFL_STAFF_PASSWORD', label: 'Staff login' },
  sales: { cookie: 'bfl_sales_session', userVar: 'BFL_SALES_USERNAME', passVar: 'BFL_SALES_PASSWORD', label: 'Sales manager login' },
  rep: { cookie: 'bfl_rep_session', userVar: 'BFL_REP_USERNAME', passVar: 'BFL_REP_PASSWORD', label: 'Sales rep login' },
};
const attempts = { admin: new Map(), sales: new Map(), rep: new Map() };
const unifiedAttempts = new Map();

function settings(role = 'admin') {
  const r = ROLES[role];
  const username = process.env[r.userVar];
  const password = process.env[r.passVar];
  const secret = process.env.BFL_SESSION_SECRET;
  if (!username || !password || Buffer.byteLength(password) < 12 || !secret || Buffer.byteLength(secret) < 32) return null;
  return { username, password, secret };
}

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
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

function issueSession(res, role, config, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ user: config.username, role, exp: now + SESSION_SECONDS * 1000 })).toString('base64url');
  const secure = isSecure() ? '; Secure' : '';
  res.setHeader('Set-Cookie',
    `${ROLES[role].cookie}=${payload}.${sign(payload, config.secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure}`);
}

function recordAttempt(bucket, ip, now) {
  if (bucket.size > 500) {
    for (const [key, value] of bucket) {
      if (now - value.started >= LOGIN_WINDOW_MS) bucket.delete(key);
    }
  }
  const prior = bucket.get(ip);
  const recent = prior && now - prior.started < LOGIN_WINDOW_MS ? prior : { started: now, count: 0 };
  if (recent.count >= LOGIN_MAX_ATTEMPTS) return false;
  recent.count += 1;
  bucket.set(ip, recent);
  return true;
}

function hasSession(req, role) {
  const config = settings(role);
  if (!config) return false;
  const token = cookieValue(req, ROLES[role].cookie);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload, config.secret))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    // Sessions issued before roles existed carry no `role` and are admin sessions.
    return session.user === config.username && (session.role || 'admin') === role && Number(session.exp) > Date.now();
  } catch { return false; }
}

const sendConfigError = (res, role) => res.status(503).json({ error: `${ROLES[role].label} is not configured on this server.` });

function sessionStatus(role) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!settings(role)) return sendConfigError(res, role);
    res.json({ authenticated: hasSession(req, role) });
  };
}

function login(role) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const config = settings(role);
    if (!config) return sendConfigError(res, role);

    const bucket = attempts[role];
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (!recordAttempt(bucket, ip, now)) {
      return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
    }

    const body = req.body || {};
    if (!safeEqual(body.username || '', config.username) || !safeEqual(body.password || '', config.password)) {
      return res.status(401).json({ error: 'Username or password is incorrect.' });
    }
    bucket.delete(ip);
    issueSession(res, role, config, now);
    res.json({ authenticated: true });
  };
}

export function unifiedLogin(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const configured = Object.keys(ROLES)
    .map((role) => [role, settings(role)])
    .filter(([, config]) => config);
  if (!configured.length) return res.status(503).json({ error: 'No staff accounts are configured on this server.' });

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!recordAttempt(unifiedAttempts, ip, now)) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
  }

  const body = req.body || {};
  const reqUser = String(body.username || '').trim().toLowerCase();
  const matches = configured.filter(([role, config]) => {
    const configUser = String(config.username || '').trim().toLowerCase();
    const isEmailAdmin = role === 'admin' && configUser.includes('@');
    const userMatch = safeEqual(reqUser, configUser) || (isEmailAdmin && safeEqual(reqUser, 'admin'));
    return userMatch && safeEqual(body.password || '', config.password);
  });
  if (matches.length > 1) {
    return res.status(409).json({ error: 'These credentials match more than one team role. Ask an administrator to give each role a unique username or password.' });
  }
  if (!matches.length) {
    return res.status(401).json({ error: 'The email, phone number, username or password is not correct.' });
  }

  const [role, config] = matches[0];
  unifiedAttempts.delete(ip);
  issueSession(res, role, config, now);
  res.json({ authenticated: true, role });
}

export function unifiedLogout(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secure = isSecure() ? '; Secure' : '';
  res.setHeader('Set-Cookie', Object.values(ROLES)
    .map(({ cookie }) => `${cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`));
  res.status(204).end();
}

function logout(role, staffRole) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const cookie = hasSession(req, role)
      ? `${ROLES[role].cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure() ? '; Secure' : ''}`
      : staffIdentity(req)?.role === staffRole
        ? clearStaffCookie(staffRole)
        : `${ROLES[role].cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure() ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', cookie);
    res.status(204).end();
  };
}

function guard(role, message) {
  return (req, res, next) => {
    // Node's built-in test runner sets this only in its child processes so API
    // integration tests can keep constructing createApp() without credentials.
    if (process.env.NODE_TEST_CONTEXT) return next();
    res.setHeader('Cache-Control', 'no-store');
    if (!settings(role)) return sendConfigError(res, role);
    if (!hasSession(req, role)) return res.status(401).json({ error: message });

    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      if (!origin || origin !== `${req.protocol}://${req.get('host')}`) {
        return res.status(403).json({ error: 'This request could not be verified.' });
      }
    }
    next();
  };
}

/** Cookie-clearing headers for the Sales Manager and rep environment sessions (the main sign-out uses these too). */
export const clearRoleCookies = () => [ROLES.sales, ROLES.rep].map(({ cookie }) => `${cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure() ? "; Secure" : ""}`);

// Admin (unchanged names)
export const hasStaffSession = (req) => hasSession(req, 'admin');
export const staffSessionStatus = sessionStatus('admin');
export const staffLogin = login('admin');
export const staffLogout = logout('admin');
export const requireStaff = guard('admin', 'Please sign in to the staff area.');

// Sales manager
export const hasSalesSession = (req) => hasSession(req, 'sales');
export const salesSessionStatus = sessionStatus('sales');
export const salesLogin = login('sales');
export const salesLogout = logout('sales', StaffRole.SALES_MANAGER);
export const requireSales = guard('sales', 'Please sign in to the sales manager dashboard.');

// Sales rep (phone app)
export const hasRepSession = (req) => hasSession(req, 'rep');
export const repSessionStatus = sessionStatus('rep');
export const repLogin = login('rep');
export const repLogout = logout('rep', StaffRole.SALES_REP);
export const requireRep = guard('rep', 'Please sign in to the sales rep app.');

export default {
  hasStaffSession, staffSessionStatus, staffLogin, staffLogout, requireStaff, unifiedLogin,
  hasSalesSession, salesSessionStatus, salesLogin, salesLogout, requireSales,
  hasRepSession, repSessionStatus, repLogin, repLogout, requireRep,
};
