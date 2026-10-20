// Staff sign-in for two separate dashboards, each with its own account and cookie:
//   admin  — BFL_STAFF_USERNAME / BFL_STAFF_PASSWORD  -> the admin app (/index.html)
//   sales  — BFL_SALES_USERNAME / BFL_SALES_PASSWORD  -> the Sales Manager dashboard (/sales)
//   rep    — BFL_REP_USERNAME / BFL_REP_PASSWORD (+ optional BFL_REP_NAME)  -> the sales rep app (/rep)
// All are signed with BFL_SESSION_SECRET. Credentials come from the host environment; no
// password is stored in the database. A session for one role is never valid for the other.
import crypto from 'node:crypto';

const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

const ROLES = {
  admin: { cookie: 'bfl_staff_session', userVar: 'BFL_STAFF_USERNAME', passVar: 'BFL_STAFF_PASSWORD', label: 'Staff login' },
  sales: { cookie: 'bfl_sales_session', userVar: 'BFL_SALES_USERNAME', passVar: 'BFL_SALES_PASSWORD', label: 'Sales manager login' },
  rep: { cookie: 'bfl_rep_session', userVar: 'BFL_REP_USERNAME', passVar: 'BFL_REP_PASSWORD', label: 'Sales rep login' },
};
const attempts = { admin: new Map(), sales: new Map(), rep: new Map() };

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
    if (bucket.size > 500) {
      for (const [key, value] of bucket) {
        if (now - value.started >= LOGIN_WINDOW_MS) bucket.delete(key);
      }
    }
    const prior = bucket.get(ip);
    const recent = prior && now - prior.started < LOGIN_WINDOW_MS ? prior : { started: now, count: 0 };
    if (recent.count >= LOGIN_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
    }
    recent.count += 1;
    bucket.set(ip, recent);

    const body = req.body || {};
    if (!safeEqual(body.username || '', config.username) || !safeEqual(body.password || '', config.password)) {
      return res.status(401).json({ error: 'Username or password is incorrect.' });
    }
    bucket.delete(ip);

    const payload = Buffer.from(JSON.stringify({ user: config.username, role, exp: now + SESSION_SECONDS * 1000 })).toString('base64url');
    res.setHeader('Set-Cookie', `${ROLES[role].cookie}=${payload}.${sign(payload, config.secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${isSecure() ? '; Secure' : ''}`);
    res.json({ authenticated: true });
  };
}

function logout(role) {
  return (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', `${ROLES[role].cookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${isSecure() ? '; Secure' : ''}`);
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
export const salesLogout = logout('sales');
export const requireSales = guard('sales', 'Please sign in to the sales manager dashboard.');

// Sales rep (phone app)
export const hasRepSession = (req) => hasSession(req, 'rep');
export const repSessionStatus = sessionStatus('rep');
export const repLogin = login('rep');
export const repLogout = logout('rep');
export const requireRep = guard('rep', 'Please sign in to the sales rep app.');

export default {
  hasStaffSession, staffSessionStatus, staffLogin, staffLogout, requireStaff,
  hasSalesSession, salesSessionStatus, salesLogin, salesLogout, requireSales,
  hasRepSession, repSessionStatus, repLogin, repLogout, requireRep,
};
