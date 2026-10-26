import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/server/index.js';
import { freshDb, row, runImport } from './helpers.js';
import { hashPassword } from '../src/domain/passwords.js';
import { resetIdempotencyStore } from '../src/server/routes/requests.js';

let server;
let db;
let baseUrl;

before(async () => {
  db = freshDb();
  resetIdempotencyStore();

  // Seed sample products and active customer with password
  runImport(db, [
    row({
      barcode: '5283013330912',
      name: 'Test Milk Carton',
      on_hand: 100,
      free: 100,
      uom: 'CTN',
    }),
  ]);

  const ts = new Date().toISOString();
  const passwordHash = hashPassword('TestSecret123!');
  db.prepare(`
    INSERT INTO customers (name, phone, access_code, password_hash, is_active, created_at, updated_at)
    VALUES ('Test Supermarket', '0241000000', 'IDEMP001', ?, 1, ?, ?)
  `).run(passwordHash, ts, ts);

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
  resetIdempotencyStore();
});

test('idempotent submission returns original receipt without duplicate orders', async () => {
  // 1. Establish customer session via password login
  const authRes = await fetch(`${baseUrl}/api/auth/customer/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ id: '0241000000', password: 'TestSecret123!' }),
  });
  assert.equal(authRes.status, 200);
  const cookie = authRes.headers.get('set-cookie').split(';')[0];

  const payload = {
    lines: [{ barcode: '5283013330912', quantityCtn: 5 }],
    notes: 'Please deliver early',
    idempotencyKey: 'idem-test-key-12345',
  };

  // First submission: should succeed and create REQ-XXXX
  const res1 = await fetch(`${baseUrl}/api/catalog/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: baseUrl },
    body: JSON.stringify(payload),
  });
  assert.equal(res1.status, 201);
  const data1 = await res1.json();
  assert.ok(data1.reference);
  assert.equal(data1.items, 1);

  // Second submission with the EXACT same idempotency key (simulating mobile double-tap / retry)
  const res2 = await fetch(`${baseUrl}/api/catalog/requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: baseUrl },
    body: JSON.stringify(payload),
  });
  assert.equal(res2.status, 200, 'Duplicate submission returns 200 OK with cached receipt');
  const data2 = await res2.json();
  assert.equal(data2.reference, data1.reference, 'Returns same request reference');
  assert.equal(data2.duplicate, true, 'Flags duplicate idempotent response');

  // Verify database has exactly ONE request and ONE quotation created, NOT two
  const requests = db.prepare('SELECT * FROM requests WHERE customer_id = (SELECT id FROM customers WHERE access_code = ?)').all('IDEMP001');
  assert.equal(requests.length, 1, 'Only one request row was created in SQLite');
  const quotations = db.prepare('SELECT * FROM odoo_orders WHERE request_id = ?').all(requests[0].id);
  assert.equal(quotations.length, 1, 'Only one draft quotation row was created in SQLite');
});
