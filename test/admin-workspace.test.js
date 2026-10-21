import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createApp } from '../src/server/index.js';
import { freshDb, runImport, row } from './helpers.js';

const ENV_KEYS = [
  'BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SALES_USERNAME', 'BFL_SALES_PASSWORD',
  'BFL_REP_USERNAME', 'BFL_REP_PASSWORD', 'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE',
  'NODE_ENV', 'NODE_TEST_CONTEXT',
];
const priorEnv = {};
let db;
let server;
let base;
let cookie;
let customerId;
let productId;

const get = (path, headers = {}) => fetch(`${base}${path}`, {
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
});

before(async () => {
  for (const key of ENV_KEYS) priorEnv[key] = process.env[key];
  const token = crypto.randomBytes(24).toString('base64url');
  process.env.BFL_STAFF_USERNAME = `workspace-${token}`;
  process.env.BFL_STAFF_PASSWORD = crypto.randomBytes(24).toString('base64url');
  process.env.BFL_SALES_USERNAME = `manager-${token}`;
  process.env.BFL_SALES_PASSWORD = crypto.randomBytes(24).toString('base64url');
  delete process.env.BFL_REP_USERNAME;
  delete process.env.BFL_REP_PASSWORD;
  process.env.BFL_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  process.env.BFL_COOKIE_SECURE = 'false';
  process.env.NODE_ENV = 'test';
  delete process.env.NODE_TEST_CONTEXT;

  db = freshDb();
  runImport(db, [row({ barcode: '9988776655443', name: 'Expiry Test Product', uom: 'CTN12', free: 5 })]);
  productId = db.prepare('SELECT id FROM products WHERE barcode = ?').get('9988776655443').id;
  customerId = Number(db.prepare(
    `INSERT INTO customers (name, is_active, created_at, updated_at)
     VALUES (?, 1, ?, ?)`
  ).run('Workspace Test Shop', new Date().toISOString(), new Date().toISOString()).lastInsertRowid);
  const expiry = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO delivery_lots
      (customer_id, product_id, lot_code, delivered_ctn, expiry_date, delivered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(customerId, productId, 'LOT-TEST-05', 3, expiry, new Date().toISOString(), new Date().toISOString());
  db.prepare(
    `INSERT INTO quotations (request_id, odoo_reference, status, created_at)
     VALUES (NULL, ?, ?, ?)`
  ).run('Q-TEST-01', 'DRAFT', new Date().toISOString());

  server = http.createServer(createApp(db));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.BFL_STAFF_USERNAME,
      password: process.env.BFL_STAFF_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('workspace APIs require an admin session', async () => {
  const previous = cookie;
  cookie = '';
  for (const path of [
    '/api/admin-workspace/status',
    '/api/admin-workspace/quotations',
    '/api/admin-workspace/visibility',
    '/api/admin-workspace/stock-expiry',
  ]) {
    assert.equal((await get(path)).status, 401, path);
  }
  cookie = previous;
});

test('workspace status exposes operational counts and role readiness, never credentials', async () => {
  const response = await get('/api/admin-workspace/status');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.data.products, 1);
  assert.equal(data.data.customers, 1);
  assert.equal(data.roles.admin, true);
  assert.equal(data.roles.salesManager, true);
  assert.equal(data.roles.salesRep, false);
  assert.equal(data.integrations.odoo, 'NOT_CONNECTED');
  assert.doesNotMatch(JSON.stringify(data), /workspace-|manager-|password|secret/i);
});

test('workspace pages use saved quotation records and enforce the current visibility policy', async () => {
  const quotations = await get('/api/admin-workspace/quotations');
  const quoteData = await quotations.json();
  assert.equal(quoteData.items[0].odooReference, 'Q-TEST-01');
  assert.equal(quoteData.integration, 'NOT_CONNECTED');

  const visibility = await get('/api/admin-workspace/visibility');
  const visibilityData = await visibility.json();
  assert.equal(visibilityData.visible, 1);
  assert.equal(visibilityData.hidden, 0);
  assert.equal(visibilityData.customerSpecificRules, false);
  assert.equal(visibilityData.policy, 'ACTIVE_PRODUCTS_VISIBLE_TO_AUTHENTICATED_CUSTOMERS');
});

test('stock expiry bands reflect local lots and reject unsupported filters', async () => {
  const response = await get('/api/admin-workspace/stock-expiry?band=critical');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.source, 'LOCAL_DELIVERY_LOTS');
  assert.equal(data.odooConnected, false);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].product, 'Expiry Test Product');
  assert.equal(data.items[0].customer, 'Workspace Test Shop');
  assert.equal(data.items[0].lotCode, 'LOT-TEST-05');
  assert.equal(data.items[0].band, 'critical');
  assert.equal((await get('/api/admin-workspace/stock-expiry?band=invalid')).status, 400);
});

test('staff menu no longer marks features Coming Soon and routes them to workspace pages', () => {
  const html = fs.readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const script = fs.readFileSync(new URL('../src/public/js/workspace.js', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/public/css/admin.css', import.meta.url), 'utf8');
  for (const feature of ['quotations', 'visibility', 'stock', 'invoices', 'payments', 'credit', 'users', 'settings', 'sync']) {
    assert.match(html, new RegExp(`href=\"#/workspace/${feature}\"`), `${feature} workspace link`);
  }
  assert.doesNotMatch(html, /class="soon"/);
  assert.doesNotMatch(script, /Coming Soon|Coming in|renderComingSoon/);
  assert.doesNotMatch(css, /\.ad-soon|\.soon\s/);
});
