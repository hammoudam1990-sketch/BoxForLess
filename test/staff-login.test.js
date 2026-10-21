import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/server/index.js';
import { freshDb } from './helpers.js';

let server;
let db;
let baseUrl;
let credentials;
const previousEnv = {};

before(async () => {
  for (const key of ['BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE', 'NODE_ENV']) {
    previousEnv[key] = process.env[key];
  }
  credentials = {
    username: `test-${crypto.randomBytes(8).toString('hex')}`,
    password: crypto.randomBytes(24).toString('base64url'),
  };
  process.env.BFL_STAFF_USERNAME = credentials.username;
  process.env.BFL_STAFF_PASSWORD = credentials.password;
  process.env.BFL_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  process.env.BFL_COOKIE_SECURE = 'false';
  process.env.NODE_ENV = 'test';
  db = freshDb();
  server = http.createServer(createApp(db));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('the universal sign-in page detects customer and team accounts', async () => {
  const response = await fetch(`${baseUrl}/login.html`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /ONE SIGN-IN · ALL BOX FOR LESS ACCOUNTS/);
  assert.match(html, /id="generalLoginForm"/);
  assert.match(html, /Email, phone or username/);
  assert.match(html, /Remember me/);
  assert.match(html, /Forgot password\?/);
  assert.match(html, /name="password"/);
  assert.match(html, /id="togglePassword"/);
  assert.match(html, /id="registerLink"[^>]*href="\/register\.html"/);
  assert.match(html, /id="googleSignIn"/);
  assert.match(html, /\/css\/login\.css/);
  assert.match(html, /class="login-brand-mark"/);
  assert.doesNotMatch(html, /Staff portal|Staff access only|Admin Login/i);

  const script = await fetch(`${baseUrl}/js/login.js`).then((response) => response.text());
  assert.match(script, /\/api\/auth\/login/);
  assert.match(script, /store\.signIn/);
  assert.match(script, /nextPath\(result\.role\)/);
  assert.match(script, /lib\/local-accounts\.js/);
  assert.match(script, /Google sign-in is not connected yet/);

  const register = await fetch(`${baseUrl}/register.html`);
  assert.equal(register.status, 200);
  assert.match(await register.text(), /id="registerForm"/);
  const registerScript = await fetch(`${baseUrl}/js/register.js`).then((r) => r.text());
  assert.doesNotMatch(registerScript, /fetch\s*\(|\/api\//);

  const css = await fetch(`${baseUrl}/css/login.css`).then((response) => response.text());
  assert.match(css, /login-warehouse-reference\.jpg/);
  assert.doesNotMatch(css, /login-warehouse-clean\.svg/);
  const image = await fetch(`${baseUrl}/img/login-warehouse-reference.jpg`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/jpeg/);

});

test('all role-specific sign-in routes point to the same universal page', async () => {
  for (const [path, destination] of [
    ['/staff/login?next=%2Fscan.html', '/login.html?next=%2Fscan.html'],
    ['/sales/login', '/login.html?next=%2Fsales'],
    ['/rep/login', '/login.html?next=%2Frep'],
    ['/staff-login.html', '/login.html?next=%2Findex.html'],
    ['/sales-login.html', '/login.html?next=%2Fsales'],
    ['/rep-login.html', '/login.html?next=%2Frep'],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { redirect: 'manual' });
    assert.equal(response.status, 302, path);
    assert.equal(response.headers.get('location'), destination, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
  const html = await fetch(`${baseUrl}/login.html`).then((response) => response.text());
  assert.match(html, /id="generalLoginForm"/);
  assert.match(html, /Email, phone or username/);
});

test('staff sign-in validates credentials, issues a protected session and honors private-page gating', async () => {
  const protectedPage = await fetch(`${baseUrl}/index.html`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.match(protectedPage.headers.get('location'), /^\/login\.html\?next=/);

  const invalid = await fetch(`${baseUrl}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: 'incorrect-test-password' }),
  });

  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'Username or password is incorrect.' });

  const accepted = await fetch(`${baseUrl}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { authenticated: true });
  const setCookie = accepted.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';', 1)[0];

  const status = await fetch(`${baseUrl}/api/staff/session`, { headers: { Cookie: cookie } });
  assert.deepEqual(await status.json(), { authenticated: true });

  const authorizedPage = await fetch(`${baseUrl}/index.html`, { headers: { Cookie: cookie } });
  assert.equal(authorizedPage.status, 200);
  assert.match(await authorizedPage.text(), /Box for Less — Staff/);

  const logout = await fetch(`${baseUrl}/api/staff/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

  const endedSession = await fetch(`${baseUrl}/api/staff/session`);
  assert.deepEqual(await endedSession.json(), { authenticated: false });
  const pageAfterLogout = await fetch(`${baseUrl}/index.html`, { redirect: 'manual' });
  assert.equal(pageAfterLogout.status, 302);
});

test('unified login detects the configured team role and clears other role sessions', async () => {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: true, role: 'admin' });
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith('bfl_staff_session=')));
  assert.ok(cookies.some((cookie) => cookie.startsWith('bfl_sales_session=') && cookie.includes('Max-Age=0')));
  assert.ok(cookies.some((cookie) => cookie.startsWith('bfl_rep_session=') && cookie.includes('Max-Age=0')));
});

test('unified logout clears every team-role cookie', async () => {
  const response = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
  assert.equal(response.status, 204);
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, 3);
  assert.ok(cookies.every((cookie) => cookie.includes('Max-Age=0')));
});
