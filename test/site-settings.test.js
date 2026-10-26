import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { createApp } from '../src/server/index.js';
import { freshDb } from './helpers.js';
import { getSiteSettings, updateSiteSettings } from '../src/domain/site-settings.js';

const ENV_KEYS = [
  'BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE',
  'NODE_ENV', 'NODE_TEST_CONTEXT',
];
const priorEnv = {};
let db;
let server;
let base;
let cookie;

const get = (path, headers = {}) => fetch(`${base}${path}`, {
  headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
});

const put = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'PUT',
  headers: {
    'Content-Type': 'application/json',
    Origin: base,
    ...(cookie ? { Cookie: cookie } : {}),
    ...headers,
  },
  body: JSON.stringify(body),
});

before(async () => {
  for (const key of ENV_KEYS) priorEnv[key] = process.env[key];
  const token = crypto.randomBytes(24).toString('base64url');
  process.env.BFL_STAFF_USERNAME = `admin-${token}`;
  process.env.BFL_STAFF_PASSWORD = crypto.randomBytes(24).toString('base64url');
  process.env.BFL_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  process.env.BFL_COOKIE_SECURE = 'false';
  process.env.NODE_ENV = 'test';
  delete process.env.NODE_TEST_CONTEXT;

  db = freshDb();
  server = http.createServer(createApp(db));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  const res = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ identifier: process.env.BFL_STAFF_USERNAME, password: process.env.BFL_STAFF_PASSWORD }),
  });
  assert.equal(res.status, 200);
  cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie);
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const key of ENV_KEYS) {
    if (priorEnv[key] === undefined) delete process.env[key];
    else process.env[key] = priorEnv[key];
  }
});

test('domain: getSiteSettings returns default schema and values', () => {
  const settings = getSiteSettings(db);
  assert.equal(settings.storefront.storeName, 'Box for Less');
  assert.equal(settings.storefront.announcement.enabled, true);
  assert.equal(settings.salesRep.portalTitle, 'Sales Rep Field Hub');
  assert.deepEqual(settings.salesRep.discountPresets, [5, 10, 15, 20, 25]);
  assert.equal(settings.operations.lowStockThreshold, 20);
});

test('domain: updateSiteSettings persists changes safely', () => {
  const updated = updateSiteSettings(db, {
    storefront: {
      storeName: 'Box for Less Accra Wholesale',
      announcement: { enabled: true, text: 'Flash Discount On Confectionery!', tone: 'ok' },
    },
    salesRep: {
      portalTitle: 'BFL Rep Command',
      discountPresets: [10, 20, 30],
      features: { enableMaps: false },
    },
  }, 'superadmin');

  assert.equal(updated.storefront.storeName, 'Box for Less Accra Wholesale');
  assert.equal(updated.storefront.announcement.text, 'Flash Discount On Confectionery!');
  assert.equal(updated.storefront.announcement.tone, 'ok');
  assert.equal(updated.salesRep.portalTitle, 'BFL Rep Command');
  assert.deepEqual(updated.salesRep.discountPresets, [10, 20, 30]);
  assert.equal(updated.salesRep.features.enableMaps, false);
  assert.equal(updated.salesRep.features.enableWhatsApp, true); // preserved default
  assert.equal(updated._meta.updatedBy, 'superadmin');

  // Verify re-reading gets same
  const retrieved = getSiteSettings(db);
  assert.equal(retrieved.storefront.storeName, 'Box for Less Accra Wholesale');
});

test('api: public GET /api/site-settings is accessible without auth', async () => {
  const res = await fetch(`${base}/api/site-settings`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.storefront.storeName, 'Box for Less Accra Wholesale');
  assert.ok(data.salesRep);
});

test('api: admin GET /api/admin-workspace/site-settings requires staff', async () => {
  const unauthed = await fetch(`${base}/api/admin-workspace/site-settings`);
  assert.equal(unauthed.status, 401);

  const authed = await get('/api/admin-workspace/site-settings');
  assert.equal(authed.status, 200);
  const data = await authed.json();
  assert.equal(data.storefront.storeName, 'Box for Less Accra Wholesale');
});

test('api: admin PUT /api/admin-workspace/site-settings saves settings', async () => {
  const res = await put('/api/admin-workspace/site-settings', {
    storefront: {
      storeName: 'BFL Super Store',
      tagline: 'Ghana #1 Bulk Distributor',
      announcement: { enabled: false, text: '', tone: 'info' },
    },
    salesRep: {
      broadcastNotice: 'Important notice to team',
    },
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.storefront.storeName, 'BFL Super Store');
  assert.equal(data.storefront.tagline, 'Ghana #1 Bulk Distributor');
  assert.equal(data.storefront.announcement.enabled, false);
  assert.equal(data.salesRep.broadcastNotice, 'Important notice to team');

  // Public endpoint reflects updated settings immediately
  const pub = await (await fetch(`${base}/api/site-settings`)).json();
  assert.equal(pub.storefront.storeName, 'BFL Super Store');
  assert.equal(pub.salesRep.broadcastNotice, 'Important notice to team');
});
