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

test('public login page is shared by the old login entry and has no authentication wiring', async () => {
  const response = await fetch(`${baseUrl}/login.html`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Welcome back/);
  assert.match(html, /id="generalLoginForm"/);
  assert.match(html, /Email or Phone Number/);
  assert.match(html, /Remember me/);
  assert.match(html, /Forgot password\?/);
  assert.match(html, /name="password"/);
  assert.match(html, /id="togglePassword"/);
  assert.match(html, /id="contactSales"/);
  assert.match(html, /id="googleSignIn"/);
  assert.match(html, /\/css\/login\.css/);
  assert.match(html, /class="login-brand-mark"/);
  assert.doesNotMatch(html, /Staff portal|Staff access only|Admin Login/i);

  const script = await fetch(`${baseUrl}/js/login.js`).then((response) => response.text());
  assert.doesNotMatch(script, /fetch\s*\(|\/api\//);
  assert.match(script, /Your information has not been sent/);
  assert.match(script, /Google sign-in is not connected yet/);

  const css = await fetch(`${baseUrl}/css/login.css`).then((response) => response.text());
  assert.match(css, /login-warehouse-reference\.jpg/);
  assert.doesNotMatch(css, /login-warehouse-clean\.svg/);
  const image = await fetch(`${baseUrl}/img/login-warehouse-reference.jpg`);
  assert.equal(image.status, 200);
  assert.match(image.headers.get('content-type'), /image\/jpeg/);

  const staffAlias = await fetch(`${baseUrl}/staff/login`).then((response) => response.text());
  assert.match(staffAlias, /url=\/login\.html/);
});

test('staff sign-in validates credentials, issues a protected session and honors private-page gating', async () => {
  const protectedPage = await fetch(`${baseUrl}/index.html`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 302);
  assert.match(protectedPage.headers.get('location'), /^\/staff\/login\?next=/);

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
