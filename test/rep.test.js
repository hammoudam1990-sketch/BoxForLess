// Sales rep app: the shop list (nearest expiry first), the visit form data, saving a visit,
// and the separate rep login. Quantities and dates only — no price, amount or discount.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/index.js';
import config from '../src/config.js';
import { freshDb } from './helpers.js';
import { repShops, shopLots, saveVisit, VisitError } from '../src/domain/rep-visits.js';

const NOW = new Date('2026-10-20T10:00:00Z');
const day = (offset) => new Date(NOW.getTime() + offset * 86400000).toISOString().slice(0, 10);

function seed(db) {
  const prod = db.prepare("INSERT INTO products (barcode, name, box_uom, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'))");
  const p1 = Number(prod.run('111', 'Cooking Oil 5L', 'Carton of 4').lastInsertRowid);
  const p2 = Number(prod.run('222', 'Tomato Paste 70g', 'Carton of 50').lastInsertRowid);
  const cust = db.prepare('INSERT INTO customers (name, odoo_customer_ref, is_active) VALUES (?, ?, 1)');
  const a = Number(cust.run('Adom Supermarket', '10482').lastInsertRowid);
  const b = Number(cust.run('Nana Yaa Provisions', '10321').lastInsertRowid);
  const c = Number(cust.run('Far Away Mart', '10999').lastInsertRowid);
  const lot = db.prepare('INSERT INTO delivery_lots (customer_id, product_id, lot_code, delivered_ctn, expiry_date) VALUES (?, ?, ?, ?, ?)');
  const ids = {
    a1: Number(lot.run(a, p1, 'L-A1', 120, day(12)).lastInsertRowid),
    a2: Number(lot.run(a, p2, 'L-A2', 120, day(4)).lastInsertRowid),
    b1: Number(lot.run(b, p1, 'L-B1', 50, day(-3)).lastInsertRowid),
    c1: Number(lot.run(c, p2, 'L-C1', 10, day(200)).lastInsertRowid),
  };
  return { a, b, c, ids };
}

test('shops are sorted by nearest expiry; overdue and tiles are counted; far-off lots are left out', () => {
  const db = freshDb();
  const { a, b } = seed(db);
  const { summary, shops } = repShops(db, { now: NOW });
  assert.deepEqual(shops.map((s) => s.name), ['Nana Yaa Provisions', 'Adom Supermarket']);
  assert.equal(shops[0].nearestDays, -3);
  assert.equal(shops[1].nearestDays, 4);
  assert.equal(shops[0].overdue, true);
  assert.deepEqual(summary, { shopsToVisit: 2, overdue: 2, lotsExpiring: 3 });

  db.prepare('INSERT INTO rep_visits (customer_id, rep_name, contact_name, visited_at) VALUES (?, ?, ?, ?)')
    .run(a, 'Kwame', 'Ama', new Date(NOW.getTime() - 2 * 86400000).toISOString());
  const after = repShops(db, { now: NOW });
  assert.equal(after.shops.find((s) => s.id === a).overdue, false, 'a recent visit clears overdue');
  assert.equal(after.shops.find((s) => s.id === b).overdue, true);

  assert.deepEqual(repShops(db, { q: 'adom', now: NOW }).shops.map((s) => s.ref), ['10482']);
  assert.deepEqual(repShops(db, { q: '10321', now: NOW }).shops.map((s) => s.name), ['Nana Yaa Provisions']);
});

test('a visit records shelf counts, resolves sold-out and returned lots, and is all-or-nothing', () => {
  const db = freshDb();
  const { a, ids } = seed(db);
  const before = shopLots(db, a, { now: NOW });
  assert.deepEqual(before.lots.map((l) => l.lotCode), ['L-A2', 'L-A1']);
  assert.equal(before.lots[0].daysLeft, 4);
  assert.equal(before.lots[1].packSize, 'Carton of 4');

  assert.throws(() => saveVisit(db, { customerId: a, repName: 'Kwame', contactName: 'Ama', lines: [
    { lotId: ids.a1, shelfCtn: 5, outcome: 'OK' }, { lotId: ids.a2, shelfCtn: 999, outcome: 'OK' }] }, { now: NOW }), VisitError);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_visits').get().n, 0, 'nothing saved on a bad line');

  assert.throws(() => saveVisit(db, { customerId: a, repName: 'Kwame', contactName: '  ', lines: [{ lotId: ids.a1, shelfCtn: 5 }] }), /contact/i);
  assert.throws(() => saveVisit(db, { customerId: a, repName: 'Kwame', contactName: 'Ama', lines: [{ lotId: ids.b1, shelfCtn: 1 }] }), /does not belong/);

  saveVisit(db, { customerId: a, repName: 'Kwame', contactName: 'Ama', noReturnAgreed: true, lines: [
    { lotId: ids.a1, shelfCtn: 40, outcome: 'OK' }, { lotId: ids.a2, shelfCtn: 77, outcome: 'SOLD_OUT' }] }, { now: NOW });
  const line = db.prepare('SELECT shelf_ctn FROM rep_visit_lines WHERE lot_id = ?').get(ids.a2);
  assert.equal(line.shelf_ctn, 0, 'sold out means zero on the shelf');
  const after = shopLots(db, a, { now: NOW });
  assert.deepEqual(after.lots.map((l) => l.lotCode), ['L-A1'], 'a sold-out lot is no longer open');
  assert.equal(after.lots[0].shelfCtn, 40, 'the form starts from the last counted shelf');
});

test('a visit photo is validated and stored; a bad photo rolls the whole visit back', () => {
  const db = freshDb();
  const { a, ids } = seed(db);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-rep-'));
  const saved = config.uploadsDir;
  config.uploadsDir = dir;
  try {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64), Buffer.from([0xff, 0xd9])]);
    const lines = [{ lotId: ids.a1, shelfCtn: 3, outcome: 'OK' }];
    assert.throws(() => saveVisit(db, { customerId: a, repName: 'K', contactName: 'Ama', lines,
      photos: new Map([[ids.a1, { buffer: Buffer.from('not an image'), mimetype: 'image/jpeg' }]]) }));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rep_visits').get().n, 0);
    saveVisit(db, { customerId: a, repName: 'K', contactName: 'Ama', lines,
      photos: new Map([[ids.a1, { buffer: jpeg, mimetype: 'image/jpeg' }]]) });
    const file = db.prepare('SELECT photo_file FROM rep_visit_lines').get().photo_file;
    assert.ok(fs.existsSync(path.join(dir, 'visit-photos', file)));
  } finally { config.uploadsDir = saved; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rep payloads never carry a price, amount, discount or phone number', () => {
  const db = freshDb();
  const { a } = seed(db);
  const json = JSON.stringify([repShops(db, { now: NOW }), shopLots(db, a, { now: NOW })]);
  assert.doesNotMatch(json, /price|amount|discount|pricelist|credit|phone/i);
});

// ---- HTTP: the rep role has its own login and cannot reach the other apps ----
const KEYS = ['BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SALES_USERNAME', 'BFL_SALES_PASSWORD', 'BFL_REP_USERNAME',
  'BFL_REP_PASSWORD', 'BFL_REP_NAME', 'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE', 'NODE_ENV', 'NODE_TEST_CONTEXT'];
const previousEnv = {};
let server; let db; let baseUrl; let rep; let sales; let admin; let seeded;
const post = (url, body, headers = {}) => fetch(`${baseUrl}${url}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function signIn(url, creds) {
  const res = await post(url, creds);
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';', 1)[0];
}

before(async () => {
  for (const k of KEYS) previousEnv[k] = process.env[k];
  const rnd = (n) => crypto.randomBytes(n).toString('base64url');
  admin = { username: `admin-${rnd(4)}`, password: rnd(24) };
  sales = { username: `sales-${rnd(4)}`, password: rnd(24) };
  rep = { username: `rep-${rnd(4)}`, password: rnd(24) };
  Object.assign(process.env, {
    BFL_STAFF_USERNAME: admin.username, BFL_STAFF_PASSWORD: admin.password,
    BFL_SALES_USERNAME: sales.username, BFL_SALES_PASSWORD: sales.password,
    BFL_REP_USERNAME: rep.username, BFL_REP_PASSWORD: rep.password, BFL_REP_NAME: 'Kwame Mensah',
    BFL_SESSION_SECRET: rnd(48), BFL_COOKIE_SECURE: 'false', NODE_ENV: 'test',
  });
  delete process.env.NODE_TEST_CONTEXT;
  db = freshDb();
  seeded = seed(db);
  server = http.createServer(createApp(db));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  for (const [k, v] of Object.entries(previousEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test('/rep and /api/rep need a rep session; admin and sales sessions do not open them', async () => {
  const anon = await fetch(`${baseUrl}/rep`, { redirect: 'manual' });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get('location'), '/rep/login');
  assert.equal((await fetch(`${baseUrl}/rep.html`, { redirect: 'manual' })).status, 302);
  assert.equal((await fetch(`${baseUrl}/api/rep/shops`)).status, 401);
  assert.match(await fetch(`${baseUrl}/rep/login`).then((r) => r.text()), /data-login="\/api\/rep\/login"/);

  for (const [url, creds] of [['/api/staff/login', admin], ['/api/sales/login', sales]]) {
    const cookie = await signIn(url, creds);
    assert.equal((await fetch(`${baseUrl}/api/rep/shops`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/rep`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
  }
  assert.equal((await post('/api/rep/login', admin)).status, 401);

  const cookie = await signIn('/api/rep/login', rep);
  assert.equal((await fetch(`${baseUrl}/rep`, { headers: { Cookie: cookie } })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/requests`, { headers: { Cookie: cookie } })).status, 401, 'rep cannot use the admin API');
  assert.equal((await fetch(`${baseUrl}/api/sales/overview`, { headers: { Cookie: cookie } })).status, 401, 'rep cannot use the sales API');
  assert.equal((await fetch(`${baseUrl}/index.html`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 302);
  const me = await fetch(`${baseUrl}/api/rep/me`, { headers: { Cookie: cookie } }).then((r) => r.json());
  assert.equal(me.name, 'Kwame Mensah');
});

test('a visit is saved over HTTP as multipart and then drops out of the open lots', async () => {
  const cookie = await signIn('/api/rep/login', rep);
  const headers = { Cookie: cookie, Origin: baseUrl };
  const shops = await fetch(`${baseUrl}/api/rep/shops`, { headers }).then((r) => r.json());
  assert.equal(shops.shops.length >= 1, true);

  const form = new FormData();
  form.append('visit', JSON.stringify({ customerId: seeded.a, contactName: 'Ama Boateng', noReturnAgreed: true,
    lines: [{ lotId: seeded.ids.a2, shelfCtn: 0, outcome: 'RETURN' }, { lotId: seeded.ids.a1, shelfCtn: 10, outcome: 'OK' }] }));
  const noOrigin = await fetch(`${baseUrl}/api/rep/visits`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  assert.equal(noOrigin.status, 403, 'cross-site posts are refused');
  const res = await fetch(`${baseUrl}/api/rep/visits`, { method: 'POST', headers, body: form });
  assert.equal(res.status, 201);
  const lots = await fetch(`${baseUrl}/api/rep/shops/${seeded.a}/lots`, { headers }).then((r) => r.json());
  assert.deepEqual(lots.lots.map((l) => l.lotCode), ['L-A1']);
  const bad = new FormData();
  bad.append('visit', 'not json');
  assert.equal((await fetch(`${baseUrl}/api/rep/visits`, { method: 'POST', headers, body: bad })).status, 400);
});
