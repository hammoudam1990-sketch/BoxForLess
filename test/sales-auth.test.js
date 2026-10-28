// The Sales Manager dashboard is a separate app from the admin panel: its own account,
// cookie, sign-in page and API. Neither session may open the other's pages or API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/server/index.js';
import { freshDb } from './helpers.js';

const KEYS = ['BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SALES_USERNAME', 'BFL_SALES_PASSWORD',
  'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE', 'NODE_ENV', 'NODE_TEST_CONTEXT'];
const previousEnv = {};
let server;
let db;
let baseUrl;
let admin;
let sales;

const post = (url, body, headers = {}) => fetch(`${baseUrl}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});
async function signIn(url, creds) {
  const res = await post(url, creds);
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';', 1)[0];
}

before(async () => {
  for (const key of KEYS) previousEnv[key] = process.env[key];
  const rnd = (n) => crypto.randomBytes(n).toString('base64url');
  admin = { username: `admin-${rnd(5)}`, password: rnd(24) };
  sales = { username: `sales-${rnd(5)}`, password: rnd(24) };
  process.env.BFL_STAFF_USERNAME = admin.username;
  process.env.BFL_STAFF_PASSWORD = admin.password;
  process.env.BFL_SALES_USERNAME = sales.username;
  process.env.BFL_SALES_PASSWORD = sales.password;
  process.env.BFL_SESSION_SECRET = rnd(48);
  process.env.BFL_COOKIE_SECURE = 'false';
  process.env.NODE_ENV = 'test';
  // The built-in runner sets this so API tests skip auth; these tests exercise auth itself.
  delete process.env.NODE_TEST_CONTEXT;
  db = freshDb();
  server = http.createServer(createApp(db));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test('the sales sign-in route redirects to the universal sign-in page', async () => {
  const res = await fetch(`${baseUrl}/sales/login`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/?next=%2Fsales');
  const html = await fetch(`${baseUrl}/login.html`).then((r) => r.text());
  assert.match(html, /WHOLESALE · B2B/);
});

test('/sales needs a sales session and is not reachable with the admin session', async () => {
  const anon = await fetch(`${baseUrl}/sales`, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/?next=%2Fsales');

  const shell = await fetch(`${baseUrl}/sales.html`, { redirect: 'manual' });
  assert.equal(shell.status, 302, 'the shell file is not served directly');

  const adminCookie = await signIn('/api/staff/login', admin);
  const asAdmin = await fetch(`${baseUrl}/sales`, { headers: { Cookie: adminCookie }, redirect: 'manual' });
  assert.equal(asAdmin.status, 302);
  assert.equal(asAdmin.headers.get('location'), '/?next=%2Fsales');

  const salesCookie = await signIn('/api/sales/login', sales);
  const asSales = await fetch(`${baseUrl}/sales`, { headers: { Cookie: salesCookie } });
  assert.equal(asSales.status, 200);
  assert.match(await asSales.text(), /Sales Manager/);
});

test('a sales session cannot open the admin app or admin API', async () => {
  const salesCookie = await signIn('/api/sales/login', sales);
  const page = await fetch(`${baseUrl}/index.html`, { headers: { Cookie: salesCookie }, redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/staff/login?next=%2Findex.html');
  const api = await fetch(`${baseUrl}/api/requests`, { headers: { Cookie: salesCookie } });
  assert.equal(api.status, 401);
  const products = await fetch(`${baseUrl}/api/products`, { headers: { Cookie: salesCookie } });
  assert.equal(products.status, 401);
});

test('the sales API needs a sales session; the admin session does not work on it', async () => {
  assert.equal((await fetch(`${baseUrl}/api/sales/overview`)).status, 401);
  const adminCookie = await signIn('/api/staff/login', admin);
  assert.equal((await fetch(`${baseUrl}/api/sales/overview`, { headers: { Cookie: adminCookie } })).status, 401);

  const salesCookie = await signIn('/api/sales/login', sales);
  const res = await fetch(`${baseUrl}/api/sales/overview?days=7`, { headers: { Cookie: salesCookie } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.days, 7);
  assert.ok(Array.isArray(body.recent));
  assert.doesNotMatch(JSON.stringify(body), /price|amount|pricelist|credit|phone/i);
});

test('the CEO approval walkthrough is private, local-only and uses clearly labeled proposal examples', async () => {
  const anon = await fetch(`${baseUrl}/approval-demo`, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/?next=%2Fapproval-demo');

  for (const credentials of [admin, sales]) {
    const cookie = await signIn(credentials === admin ? '/api/staff/login' : '/api/sales/login', credentials);
    const response = await fetch(`${baseUrl}/approval-demo`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
    const html = await response.text();
    assert.match(html, /CONCEPT ONLY · NOT LIVE/);
    assert.match(html, /not been checked against the current export/);
    assert.match(html, /No live records changed/);
    assert.match(html, /Sweet Jesus/);
    assert.match(html, /1,150/);
    assert.doesNotMatch(html, /GH₵|GH¢|\\bGH₵\\s*\\d/i);
  }
});

test('sales credentials only create a sales session, and sign-out ends the session', async () => {
  const wrong = await post('/api/staff/login', sales);
  assert.equal(wrong.status, 401, 'sales credentials are not admin credentials');
  const wrong2 = await post('/api/sales/login', admin);
  assert.equal(wrong2.status, 401, 'admin credentials are not sales credentials');

  const cookie = await signIn('/api/sales/login', sales);
  const out = await post('/api/sales/logout', {}, { Cookie: cookie });
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});
