import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import { createApp } from '../src/server/index.js';
import { freshDb, runImport, row, tmpUploads } from './helpers.js';
import { submitRequest, acceptRequest } from '../src/domain/requests.js';

const ENV_KEYS = ['BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SALES_USERNAME', 'BFL_SALES_PASSWORD',
  'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE', 'NODE_ENV', 'NODE_TEST_CONTEXT'];
const priorEnv = {};
let db;
let server;
let base;
let cookie;
let customerId;
let listedRequestId;
let unlistedRequestId;
let uploadsDir;

async function get(path, headers = {}) {
  return fetch(`${base}${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
}

before(async () => {
  for (const key of ENV_KEYS) priorEnv[key] = process.env[key];
  const token = crypto.randomBytes(24).toString('base64url');
  process.env.BFL_STAFF_USERNAME = `admin-${token}`;
  process.env.BFL_STAFF_PASSWORD = crypto.randomBytes(24).toString('base64url');
  process.env.BFL_SALES_USERNAME = `sales-${token}`;
  process.env.BFL_SALES_PASSWORD = crypto.randomBytes(24).toString('base64url');
  process.env.BFL_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  process.env.BFL_COOKIE_SECURE = 'false';
  process.env.NODE_ENV = 'test';
  delete process.env.NODE_TEST_CONTEXT;

  db = freshDb();
  uploadsDir = tmpUploads();
  runImport(db, [row({
    barcode: '5283013330912',
    name: 'Demo Product',
    uom: 'CTN24',
    on_hand: 12,
    free: 8,
  })], { uploadsDir });
  const customer = db.prepare(
    `INSERT INTO customers (name, phone, is_active, created_at, updated_at)
     VALUES (?, ?, 1, ?, ?)`
  ).run('Demo Customer', 'PRIVATE-PHONE-123', new Date().toISOString(), new Date().toISOString());
  customerId = Number(customer.lastInsertRowid);

  listedRequestId = submitRequest(db, {
    customerId,
    lines: [{ barcode: '5283013330912', quantityCtn: 3 }],
    notes: 'PRIVATE-NOTE-123',
  }).requestId;
  acceptRequest(db, listedRequestId);
  unlistedRequestId = submitRequest(db, {
    lines: [{ barcode: '5283013330912', quantityCtn: 2 }],
    unlisted: {
      company: 'Walk-in Demo Shop',
      contact: 'PRIVATE-CONTACT-123',
      phone: 'PRIVATE-PHONE-456',
    },
    notes: 'PRIVATE-DELIVERY-123',
  }).requestId;
  db.prepare('UPDATE requests SET delivery_address = ? WHERE id = ?').run('PRIVATE-ADDRESS-123', unlistedRequestId);

  server = http.createServer(createApp(db));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${base}/api/sales/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: process.env.BFL_SALES_USERNAME,
      password: process.env.BFL_SALES_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  if (uploadsDir) fs.rmSync(uploadsDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('sales workspace routes require a manager session', async () => {
  const previous = cookie;
  cookie = '';
  for (const path of [
    '/api/sales/overview',
    '/api/sales/requests',
    `/api/sales/requests/${listedRequestId}`,
    '/api/sales/products',
    '/api/sales/customers',
    `/api/sales/customers/${customerId}`,
    '/api/sales/imports',
  ]) {
    assert.equal((await get(path)).status, 401, `${path} must be protected`);
  }
  cookie = previous;
});

test('dashboard supports 14 days and returns truthful request and stock counts', async () => {
  const response = await get('/api/sales/overview?days=14');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.days, 14);
  assert.equal(data.series.length, 14);
  assert.equal(data.activeCustomers, 1);
  assert.equal(data.inventory.total, 1);
  assert.equal(data.inventory.inStock, 1);
  assert.equal(data.inventory.limited, 0);
  assert.equal(data.inventory.outOfStock, 0);
  assert.equal(data.attention.pendingApproval, 1);
  assert.ok(data.recent.every((request) => Number.isFinite(request.cartons)));
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE-PHONE|PRIVATE-NOTE|PRIVATE-ADDRESS|price|amount|pricelist/i);
});

test('request search, filtering, detail and customer history expose only safe fields', async () => {
  const pending = await get('/api/sales/requests?status=pending&search=Walk-in');
  assert.equal(pending.status, 200);
  const pendingData = await pending.json();
  assert.equal(pendingData.total, 1);
  assert.equal(pendingData.items[0].customer, 'Walk-in Demo Shop');
  assert.equal(pendingData.items[0].cartons, 2);

  const accepted = await get('/api/sales/requests?status=accepted');
  assert.equal((await accepted.json()).items[0].id, listedRequestId);

  const detail = await get(`/api/sales/requests/${unlistedRequestId}`);
  assert.equal(detail.status, 200);
  const detailJson = await detail.json();
  assert.equal(detailJson.request.customer, 'Walk-in Demo Shop');
  assert.equal(detailJson.items[0].cartons, 2);
  assert.doesNotMatch(JSON.stringify(detailJson), /PRIVATE-CONTACT|PRIVATE-PHONE|PRIVATE-ADDRESS|PRIVATE-DELIVERY|PRIVATE-NOTE/i);

  const customer = await get(`/api/sales/customers/${customerId}`);
  assert.equal(customer.status, 200);
  const customerJson = await customer.json();
  assert.equal(customerJson.customer.name, 'Demo Customer');
  assert.equal(customerJson.requests[0].id, listedRequestId);
  assert.doesNotMatch(JSON.stringify(customerJson), /PRIVATE-PHONE|PRIVATE-NOTE/i);

  assert.equal((await get('/api/sales/requests?status=unknown')).status, 400);
  assert.equal((await get('/api/sales/requests/999999')).status, 404);
  assert.equal((await get('/api/sales/customers/999999')).status, 404);
});

test('product and import views return only read-only operational fields', async () => {
  const products = await get('/api/sales/products?search=Demo');
  assert.equal(products.status, 200);
  const productData = await products.json();
  assert.equal(productData.total, 1);
  assert.equal(productData.items[0].name, 'Demo Product');
  assert.equal(productData.items[0].stockStatus, 'IN_STOCK');
  assert.equal(Object.hasOwn(productData.items[0], 'price'), false);

  const customers = await get('/api/sales/customers?search=Demo');
  const customerData = await customers.json();
  assert.equal(customerData.total, 1);
  assert.equal(customerData.items[0].name, 'Demo Customer');
  assert.equal(Object.hasOwn(customerData.items[0], 'phone'), false);

  const imports = await get('/api/sales/imports');
  assert.equal(imports.status, 200);
  const importData = await imports.json();
  assert.equal(importData.items[0].status, 'COMPLETED');
  assert.equal(Object.hasOwn(importData.items[0], 'stored_path'), false);
});
