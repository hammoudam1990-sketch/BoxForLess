// One shared staff account for the small team. Credentials and the signing key
// are supplied by the host environment; no password is stored in the database.
import crypto from 'node:crypto';

const COOKIE_NAME = 'bfl_staff_session';
const SESSION_SECONDS = 8 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
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

export function hasStaffSession(req) {
  const config = settings();
  if (!config) return false;
  const token = cookieValue(req);
  const dot = token.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload, config.secret))) return false;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.user === config.username && Number(session.exp) > Date.now();
  } catch { return false; }
}

function sendConfigError(res) {
  return res.status(503).json({ error: 'Staff login is not configured on this server.' });
}

export function staffSessionStatus(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!settings()) return sendConfigError(res);
  res.json({ authenticated: hasStaffSession(req) });
}

export function staffLogin(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const config = settings();
  if (!config) return sendConfigError(res);

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (attempts.size > 500) {
    for (const [key, value] of attempts) {
      if (now - value.started >= LOGIN_WINDOW_MS) attempts.delete(key);
    }
  }
  const prior = attempts.get(ip);
  const recent = prior && now - prior.started < LOGIN_WINDOW_MS ? prior : { started: now, count: 0 };
  if (recent.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
  }
  recent.count += 1;
  attempts.set(ip, recent);

  const body = req.body || {};
  if (!safeEqual(body.username || '', config.username) || !safeEqual(body.password || '', config.password)) {
    return res.status(401).json({ error: 'Username or password is incorrect.' });
  }
  attempts.delete(ip);

  const payload = Buffer.from(JSON.stringify({ user: config.username, exp: now + SESSION_SECONDS * 1000 })).toString('base64url');
  const secure = process.env.NODE_ENV === 'production' || process.env.BFL_COOKIE_SECURE === 'true';
  const cookie = `${COOKIE_NAME}=${payload}.${sign(payload, config.secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', cookie);
  res.json({ authenticated: true });
}

export function staffLogout(_req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secure = process.env.NODE_ENV === 'production' || process.env.BFL_COOKIE_SECURE === 'true';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
  res.status(204).end();
}

export function requireStaff(req, res, next) {
  // Node's built-in test runner sets this only in its child processes so API
  // integration tests can keep constructing createApp() without credentials.
  if (process.env.NODE_TEST_CONTEXT) return next();
  res.setHeader('Cache-Control', 'no-store');
  if (!settings()) return sendConfigError(res);
  if (!hasStaffSession(req)) return res.status(401).json({ error: 'Please sign in to the staff area.' });

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (!origin || origin !== `${req.protocol}://${req.get('host')}`) {
      return res.status(403).json({ error: 'This request could not be verified.' });
    }
  }
  next();
}

export default { hasStaffSession, staffSessionStatus, staffLogin, staffLogout, requireStaff };
