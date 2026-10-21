import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/server/index.js';
import { freshDb } from './helpers.js';

const keys = [
  'BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SALES_USERNAME', 'BFL_SALES_PASSWORD',
  'BFL_REP_USERNAME', 'BFL_REP_PASSWORD', 'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE',
  'NODE_ENV', 'NODE_TEST_CONTEXT',
];
const previous = {};
const credentials = {};
let server;
let db;
let baseUrl;

const post = (path, body) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

before(async () => {
  for (const key of keys) previous[key] = process.env[key];
  const random = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
  credentials.admin = { username: `admin-${random(5)}`, password: random() };
  credentials.sales = { username: `sales-${random(5)}`, password: random() };
  credentials.rep = { username: `rep-${random(5)}`, password: random() };
  process.env.BFL_STAFF_USERNAME = credentials.admin.username;
  process.env.BFL_STAFF_PASSWORD = credentials.admin.password;
  process.env.BFL_SALES_USERNAME = credentials.sales.username;
  process.env.BFL_SALES_PASSWORD = credentials.sales.password;
  process.env.BFL_REP_USERNAME = credentials.rep.username;
  process.env.BFL_REP_PASSWORD = credentials.rep.password;
  process.env.BFL_SESSION_SECRET = random(48);
  process.env.BFL_COOKIE_SECURE = 'false';
  process.env.NODE_ENV = 'test';
  delete process.env.NODE_TEST_CONTEXT;

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
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('one login endpoint identifies each configured staff role and issues only its session', async () => {
  for (const role of ['admin', 'sales', 'rep']) {
    const response = await post('/api/auth/login', credentials[role]);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { authenticated: true, role });

    const cookieName = { admin: 'bfl_staff_session', sales: 'bfl_sales_session', rep: 'bfl_rep_session' }[role];
    const cookies = response.headers.getSetCookie();
    assert.ok(cookies.some((cookie) => cookie.startsWith(`${cookieName}=`) && !cookie.includes('Max-Age=0')));
    for (const other of ['bfl_staff_session', 'bfl_sales_session', 'bfl_rep_session'].filter((name) => name !== cookieName)) {
      assert.ok(cookies.some((cookie) => cookie.startsWith(`${other}=`) && cookie.includes('Max-Age=0')));
    }
  }
});

test('unified login does not reveal which role username was configured', async () => {
  const response = await post('/api/auth/login', { username: credentials.sales.username, password: 'wrong password' });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'The email, phone number, username or password is not correct.' });
});

test('unified login refuses credentials shared by multiple roles', async () => {
  process.env.BFL_SALES_USERNAME = credentials.admin.username;
  process.env.BFL_SALES_PASSWORD = credentials.admin.password;
  const response = await post('/api/auth/login', credentials.admin);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /more than one team role/);
  process.env.BFL_SALES_USERNAME = credentials.sales.username;
  process.env.BFL_SALES_PASSWORD = credentials.sales.password;
});
