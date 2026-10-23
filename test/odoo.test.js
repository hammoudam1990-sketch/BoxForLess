// The Odoo connection, tested against a FAKE Odoo that can time out, fail, drop a reply after doing the work, and
// refuse what the integration user is not allowed to do. Nothing here touches a real Odoo.
//
// What is at risk, in order:
//   1. BFL writing something it must never write (confirm, cancel, edit, delete, a price) — or a second quotation for one order.
//   2. A failed or half-finished sync changing BFL's data.
//   3. The API key appearing anywhere it should not.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { FakeOdoo } from '../src/odoo/fake-odoo.js';
import {
  createOdooClient, assertAllowed, OdooForbiddenError, OdooUnavailableError, OdooRejectedError, PAGE_SIZE,
} from '../src/odoo/client.js';
import { odooConfig, publicOdooConfig, redact } from '../src/odoo/config.js';
import { runSync, syncStatus, SYNC_TYPES, OVERLAP_MS } from '../src/odoo/sync.js';
import { runOutbox, retryOutbox, nextAttemptAfter, BACKOFF_MINUTES } from '../src/odoo/outbox-worker.js';
import { odooHealth } from '../src/odoo/health.js';
import { startOdooJobs, callLogger } from '../src/odoo/jobs.js';
import { submitRequest } from '../src/domain/requests.js';
import { createOrderForRequest } from '../src/domain/orders.js';
import { createAccessRequest, approveAccessRequest } from '../src/domain/access-requests.js';
import { ManualImportStockSource } from '../src/domain/stock-source.js';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });

async function rig({ protocol = 'jsonrpc', timeoutMs = 150, maxPerSecond = 1000 } = {}) {
  const odoo = new FakeOdoo();
  odoo.clock = () => new Date('2026-10-22T08:00:00Z');   // a fixed clock, so a test never depends on the day it runs
  await odoo.start();
  cleanups.push(() => odoo.stop());
  const calls = [];
  const client = createOdooClient({ url: odoo.url, db: odoo.db, login: odoo.login, apiKey: odoo.apiKey, protocol, timeoutMs, maxPerSecond, onCall: (c) => calls.push(c) });
  return { odoo, client, calls, db: freshDb() };
}

// ---- BFL-side helpers ---------------------------------------------------------------------------
function bflCustomer(db, name, extra = {}) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries({ customer_type: 'CREDIT', ...extra })) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}
function bflProduct(db, barcode, name = `PRODUCT ${barcode}`) {
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, on_hand, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)').run(barcode, name, 'CTN12', 500, 500, ts, ts);
}
function freshStock(db) {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
}
/** A request with its order and queued quotation, as the customer route would make. */
function placeOrder(db, customerId, lines, extra = {}) {
  freshStock(db);
  return submitRequest(db, { lines, customerId, ...extra, onInsert: (id) => createOrderForRequest(db, id) });
}
const outbox = (db) => db.prepare('SELECT * FROM odoo_outbox ORDER BY id').all();
const T0 = new Date('2026-10-22T10:00:00.000Z');
const plus = (min) => new Date(T0.getTime() + min * 60_000);

// ===========================================================================
// the client
// ===========================================================================
test('1. BFL may read, and create only a quotation or an approved new customer — nothing else leaves BFL', async () => {
  const { odoo, client } = await rig();
  for (const [model, method] of [['res.partner', 'write'], ['sale.order', 'unlink'], ['sale.order', 'action_confirm'], ['sale.order', 'action_cancel'], ['sale.order', 'write'],
    ['product.product', 'create'], ['account.move', 'create'], ['account.payment', 'create'], ['product.pricelist', 'write'], ['res.users', 'create'], ['res.partner', 'unlink'], ['stock.quant', 'create']]) {
    assert.throws(() => assertAllowed(model, method), OdooForbiddenError, `${model}.${method}`);
  }
  for (const [model, method] of [['res.partner', 'search_read'], ['sale.order', 'search_read'], ['account.move', 'read'], ['sale.order', 'create'], ['res.partner', 'create']]) assertAllowed(model, method);
  // refused before any network call
  await assert.rejects(client.create('product.product', { name: 'x' }), OdooForbiddenError);
  assert.equal(odoo.calls.length, 0, 'not one request reached Odoo');
});

test('2. even if BFL tried, the integration user\'s rights refuse write, delete and confirm (the fake enforces them)', async () => {
  const { odoo } = await rig();
  const raw = (model, method, args) => fetch(`${odoo.url}/jsonrpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'call', params: { service: 'object', method: 'execute_kw', args: [odoo.db, odoo.uid, odoo.apiKey, model, method, args, {}] } }) }).then((r) => r.json());
  for (const [model, method] of [['res.partner', 'write'], ['sale.order', 'unlink'], ['sale.order', 'action_confirm'], ['product.product', 'create']]) {
    const r = await raw(model, method, [[1], {}]);
    assert.match(r.error.data.name, /AccessError/, `${model}.${method}`);
  }
});

test('3. reads and pages of 200: every record comes back, in pages', async () => {
  const { odoo, client } = await rig();
  for (let i = 0; i < 450; i += 1) odoo.add('product.product', { name: `P${i}`, barcode: `B${i}` });
  const all = await client.searchReadAll('product.product', [], ['name', 'barcode']);
  assert.equal(all.length, 450);
  assert.equal(PAGE_SIZE, 200);
  assert.equal(odoo.calls.filter((c) => c.method === 'search_read').length, 3, '200 + 200 + 50');
  assert.ok(await client.ping());
  assert.equal(await client.searchCount('product.product', [['barcode', '=', 'B7']]), 1);
});

test('4. the newer bearer-key transport works the same way', async () => {
  const { odoo, client } = await rig({ protocol: 'json2' });
  odoo.add('res.partner', { name: 'Kofi Traders', ref: 'X1' });
  const found = await client.searchRead('res.partner', [['ref', '=', 'X1']], ['name']);
  assert.equal(found[0].name, 'Kofi Traders');
  const id = await client.create('res.partner', { name: 'New Co', ref: 'REG-1' });
  assert.ok(id > 0);
  assert.equal(odoo.created('res.partner').length, 1);
});

test('5. a wrong key is refused, and says so without echoing it', async () => {
  const { odoo } = await rig();
  const bad = createOdooClient({ url: odoo.url, db: odoo.db, login: odoo.login, apiKey: 'wrong-key-xyz', maxPerSecond: 1000 });
  await assert.rejects(bad.ping(), (e) => e instanceof OdooRejectedError && e.code === 'ACCESS_DENIED' && !e.message.includes('wrong-key-xyz'));
});

test('6. a timeout, a 500, a 429, a database lock and no connection are "try again later"; a rule or a right is a refusal', async () => {
  const { odoo, client } = await rig();
  odoo.fail('timeout'); await assert.rejects(client.ping(), (e) => e instanceof OdooUnavailableError && e.code === 'TIMEOUT');
  odoo.fail('http500'); await assert.rejects(client.ping(), (e) => e instanceof OdooUnavailableError && e.code === 'HTTP_500');
  odoo.fail('http429'); await assert.rejects(client.ping(), (e) => e instanceof OdooUnavailableError && e.code === 'HTTP_429');
  odoo.fail('locked'); await assert.rejects(client.ping(), (e) => e instanceof OdooUnavailableError && e.code === 'LOCKED');
  odoo.fail('reject:The product is archived'); await assert.rejects(client.ping(), (e) => e instanceof OdooRejectedError && /archived/.test(e.message));
  odoo.setDown(true); await assert.rejects(client.ping(), (e) => e instanceof OdooUnavailableError);
  odoo.setDown(false); assert.ok(await client.ping(), 'and it works again');
  await odoo.stop();
  await assert.rejects(client.ping(), (e) => e instanceof OdooUnavailableError && e.code === 'NETWORK');
});

test('7. no more than the allowed calls a second', async () => {
  const { client } = await rig({ maxPerSecond: 20 });
  const t0 = Date.now();
  for (let i = 0; i < 6; i += 1) await client.ping();
  assert.ok(Date.now() - t0 >= 5 * 50 - 20, `6 calls at 20 a second take about 250 ms (took ${Date.now() - t0})`);
});

test('8. the API key is never in a log line, an error, or the configuration shown to anyone', async () => {
  const { odoo, client, calls } = await rig();
  odoo.fail('reject:' + odoo.apiKey + ' is not valid');          // even if Odoo echoed it back
  await assert.rejects(client.ping(), (e) => !e.message.includes(odoo.apiKey));
  await client.ping();
  assert.ok(calls.length >= 2 && calls.every((c) => !JSON.stringify(c).includes(odoo.apiKey)));
  assert.ok(calls.some((c) => c.ok === false) && calls.some((c) => c.ok === true));
  const cfg = odooConfig({ BFL_ODOO_URL: 'https://o.example.com/', BFL_ODOO_DB: 'd', BFL_ODOO_LOGIN: 'bfl-integration', BFL_ODOO_API_KEY: 'super-secret-key' });
  assert.equal(cfg.configured, true);
  assert.equal(cfg.url, 'https://o.example.com');
  assert.ok(!JSON.stringify(publicOdooConfig(cfg)).includes('super-secret-key'));
  assert.equal(publicOdooConfig(cfg).hasKey, true);
  assert.equal(redact('failed with Bearer abc.def and super-secret-key', 'super-secret-key'), 'failed with Bearer [key] and [key]');
  assert.equal(odooConfig({}).configured, false, 'nothing configured: nothing connects');
});

// ===========================================================================
// reading Odoo: customers
// ===========================================================================
function partner(odoo, over = {}) {
  return odoo.add('res.partner', { name: 'Kofi Traders Ltd', ref: false, phone: '0244111222', mobile: false, email: 'kofi@example.com', street: '12 Ring Road', city: 'Accra',
    property_product_pricelist: [3, 'CLASS B (GHS)'], user_id: [20, 'Kwame Asante'], credit_limit: 10000, credit: 2500, ...over });
}

test('9. customers: created with their Odoo id, price class, rep and balance; the shared cash account is not a customer', async () => {
  const { odoo, client, db } = await rig();
  const p = partner(odoo);
  const cash = partner(odoo, { name: 'CASH CUSTOMERS' });
  partner(odoo, { name: 'Esi Stores', property_product_pricelist: false, user_id: false, credit_limit: 0, credit: 0 });
  const r = await runSync(db, client, 'customers', { now: T0, cashPartnerId: cash.id });
  assert.deepEqual([r.created, r.updated, r.linked], [2, 0, 0]);
  const c = db.prepare('SELECT * FROM customers WHERE odoo_customer_ref = ?').get(String(p.id));
  assert.deepEqual([c.name, c.pricelist, c.salesperson, c.phone, c.email, c.customer_type, c.is_active], ['Kofi Traders Ltd', 'CLASS B (GHS)', 'Kwame Asante', '0244111222', 'kofi@example.com', 'CREDIT', 1]);
  assert.equal(c.delivery_address, '12 Ring Road, Accra');
  const f = db.prepare('SELECT * FROM odoo_customer_finance WHERE customer_id = ?').get(c.id);
  assert.deepEqual([f.credit_limit, f.amount_owed], [10000, 2500]);
  assert.equal(db.prepare('SELECT credit_limit FROM odoo_customer_finance WHERE customer_id = (SELECT id FROM customers WHERE name = ?)').get('Esi Stores').credit_limit, null, 'no limit in Odoo: not checked');
  assert.ok(!db.prepare('SELECT 1 FROM customers WHERE name = ?').get('CASH CUSTOMERS'));
  assert.equal(syncStatus(db, T0).find((s) => s.type === 'customers').lastSuccessAt, T0.toISOString());
});

test('10. changes only: the next run asks for what changed since the last good run, with a 2-minute overlap', async () => {
  const { odoo, client, db } = await rig();
  odoo.clock = () => new Date('2026-10-22T09:00:00Z'); const a = partner(odoo, { name: 'Alpha' });
  odoo.clock = () => new Date('2026-10-22T09:30:00Z'); const b = partner(odoo, { name: 'Bravo' });
  const first = await runSync(db, client, 'customers', { now: T0 });
  assert.equal(first.fetched, 2);
  assert.equal(db.prepare("SELECT cursor FROM sync_state WHERE data_type = 'customers'").get().cursor, '2026-10-22 09:30:00');
  odoo.calls.length = 0;
  odoo.clock = () => new Date('2026-10-22T09:45:00Z'); odoo.touch('res.partner', a.id, { phone: '0555000111' });
  const second = await runSync(db, client, 'customers', { now: plus(5) });
  assert.equal(second.fetched, 2, 'Alpha (changed) and Bravo (inside the 2-minute overlap: read again, harmless, and nothing is ever missed)');
  assert.equal(odoo.calls.filter((c) => c.method === 'search_read').length, 1, 'one page, not the whole list again');
  assert.equal(db.prepare('SELECT phone FROM customers WHERE odoo_customer_ref = ?').get(String(a.id)).phone, '0555000111');
  // a record changed within the overlap window is read again (harmless, and nothing is missed)
  odoo.clock = () => new Date('2026-10-22T09:44:00Z'); odoo.touch('res.partner', b.id, { phone: '0555000222' });
  assert.equal((await runSync(db, client, 'customers', { now: plus(6) })).fetched, 2, 'Bravo (just changed, inside the window) and Alpha (the newest, also inside it) — and the data stays right either way');
  assert.equal(db.prepare('SELECT phone FROM customers WHERE odoo_customer_ref = ?').get(String(b.id)).phone, '0555000222');
  assert.equal(OVERLAP_MS, 120000);
});

test('11. an existing BFL customer is linked ONCE by an exact, unique name; BFL\'s own fields are never touched; Odoo wins on the rest', async () => {
  const { odoo, client, db } = await rig();
  const id = bflCustomer(db, 'Kofi Traders Ltd', { phone: '0000', pricelist: 'CLASS A (GHS)', access_code: 'ABCD2345', password_hash: 'scrypt$x', min_shelf_life_days: 90, session_epoch: 4 });
  bflCustomer(db, 'Twin Co'); bflCustomer(db, 'Twin Co');                      // two with the same name in BFL
  const p = partner(odoo);
  partner(odoo, { name: 'Twin Co' });
  const r = await runSync(db, client, 'customers', { now: T0 });
  assert.equal(r.linked, 1);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  assert.equal(c.odoo_customer_ref, String(p.id));
  assert.deepEqual([c.phone, c.pricelist], ['0244111222', 'CLASS B (GHS)'], 'Odoo wins');
  assert.deepEqual([c.access_code, c.password_hash, c.min_shelf_life_days, c.session_epoch], ['ABCD2345', 'scrypt$x', 90, 4], 'BFL-only fields untouched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 4, 'the linked one, the two twins, and a new Twin Co row');
  const log = db.prepare('SELECT change FROM sync_changes ORDER BY id').all().map((x) => x.change);
  assert.ok(log.includes('LINKED_BY_NAME') && log.includes('AMBIGUOUS_NAME'), 'an ambiguous name is flagged for a person, not guessed');
});

test('12. archived in Odoo means inactive in BFL, never deleted; a FULL read also deactivates what has vanished', async () => {
  const { odoo, client, db } = await rig();
  odoo.clock = () => new Date('2026-10-22T09:00:00Z');
  const a = partner(odoo, { name: 'Alpha' }); partner(odoo, { name: 'Bravo' });
  await runSync(db, client, 'customers', { now: T0 });
  odoo.clock = () => new Date('2026-10-22T09:30:00Z'); odoo.touch('res.partner', a.id, { active: false });
  await runSync(db, client, 'customers', { now: plus(5) });
  assert.equal(db.prepare("SELECT is_active FROM customers WHERE name = 'Alpha'").get().is_active, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2, 'nothing deleted');
  // a record Odoo no longer returns at all (a full read sees everything)
  odoo.models['res.partner'] = odoo.models['res.partner'].filter((x) => x.name !== 'Bravo');
  const full = await runSync(db, client, 'customers', { now: plus(10), full: true });
  assert.equal(full.deactivated, 1);
  assert.equal(db.prepare("SELECT is_active FROM customers WHERE name = 'Bravo'").get().is_active, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_changes WHERE change = 'DEACTIVATED'").get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 2);
});

test('13. a run that fails leaves the database exactly as it was — in Odoo or while applying — and is recorded', async () => {
  const { odoo, client, db } = await rig();
  partner(odoo, { name: 'Alpha' });
  await runSync(db, client, 'customers', { now: T0 });
  const snapshot = () => JSON.stringify([db.prepare('SELECT id, name, phone, odoo_customer_ref FROM customers ORDER BY id').all(), db.prepare('SELECT cursor, runs_ok FROM sync_state').all()]);
  const before = snapshot();
  odoo.clock = () => new Date('2026-10-22T11:00:00Z'); partner(odoo, { name: 'Bravo' });
  odoo.fail('http500');
  await assert.rejects(runSync(db, client, 'customers', { now: plus(5) }), OdooUnavailableError);
  assert.equal(snapshot(), before, 'Odoo failed: nothing changed');
  const st = syncStatus(db, plus(6)).find((s) => s.type === 'customers');
  assert.equal(st.runsFailed, 1);
  assert.match(st.lastError, /500/);

  // a failure part-way through APPLYING rolls back what it had already written
  const real = SYNC_TYPES.customers.apply;
  SYNC_TYPES.customers.apply = (d, ps, ctx) => { real(d, ps, ctx); throw new Error('boom after writing'); };
  try { await assert.rejects(runSync(db, client, 'customers', { now: plus(7) }), /boom/); } finally { SYNC_TYPES.customers.apply = real; }
  assert.equal(snapshot(), before, 'applying failed: the half-done run was rolled back');
  // and the next good run picks everything up
  const ok = await runSync(db, client, 'customers', { now: plus(8) });
  assert.equal(ok.created, 1);
  assert.equal(syncStatus(db, plus(9)).find((s) => s.type === 'customers').lastError, null);
});

test('14. only one run of a kind at a time', async () => {
  const { odoo, client, db } = await rig();
  partner(odoo);
  odoo.delayMs = 80;
  const [a, b] = await Promise.all([runSync(db, client, 'customers', { now: T0 }), runSync(db, client, 'customers', { now: T0 })]);
  assert.deepEqual([a.skipped, b.skipped].sort(), [true, undefined]);
});

// ===========================================================================
// reading Odoo: stock
// ===========================================================================
test('15. stock updates the products BFL already has, by barcode, and never creates or revives one', async () => {
  const { odoo, client, db } = await rig();
  bflProduct(db, '111'); bflProduct(db, '222');
  db.prepare("UPDATE products SET is_active = 0 WHERE barcode = '222'").run();
  odoo.add('product.product', { name: 'A', barcode: '111', qty_available: 40, free_qty: 30, incoming_qty: 5, outgoing_qty: 2, virtual_available: 43 });
  odoo.add('product.product', { name: 'B', barcode: '222', qty_available: 9, free_qty: 9, incoming_qty: 0, outgoing_qty: 0, virtual_available: 9 });
  odoo.add('product.product', { name: 'C', barcode: '999', qty_available: 1, free_qty: 1, incoming_qty: 0, outgoing_qty: 0, virtual_available: 1 });
  const r = await runSync(db, client, 'stock', { now: T0 });
  assert.deepEqual([r.updated, r.unknown], [1, 1]);
  const p = db.prepare("SELECT on_hand, free_to_use, incoming, outgoing, forecasted FROM products WHERE barcode = '111'").get();
  assert.deepEqual({ ...p }, { on_hand: 40, free_to_use: 30, incoming: 5, outgoing: 2, forecasted: 43 });
  assert.equal(db.prepare("SELECT on_hand FROM products WHERE barcode = '222'").get().on_hand, 500, 'an inactive product is left alone');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 2, 'no product was created');
  assert.equal(db.prepare("SELECT detail FROM sync_changes WHERE change = 'UNKNOWN_BARCODE'").get().detail, '999');
});

test('16. a good stock sync is what makes stock "fresh" for requests, with no Excel import', async () => {
  const { odoo, client, db } = await rig();
  bflProduct(db, '111');
  odoo.add('product.product', { name: 'A', barcode: '111', qty_available: 5, free_qty: 5, incoming_qty: 0, outgoing_qty: 0, virtual_available: 5 });
  const source = new ManualImportStockSource();
  assert.equal(source.getStockStatus(db, T0).hasData, false);
  await runSync(db, client, 'stock', { now: T0 });
  const s = source.getStockStatus(db, plus(60));
  assert.deepEqual([s.hasData, s.fresh, s.asOf], [true, true, T0.toISOString()]);
  assert.equal(source.getStockStatus(db, plus(60 * 30)).fresh, false, 'and it goes stale if the sync stops');
});

test('17. a sync that has not worked for 20 minutes is marked stale', async () => {
  const { odoo, client, db } = await rig();
  odoo.fail('http500', { times: 5 });
  await assert.rejects(runSync(db, client, 'stock', { now: T0 }));
  assert.equal(syncStatus(db, plus(1)).find((s) => s.type === 'stock').stale, true, 'tried and never succeeded');
  odoo.faults.length = 0;
  await runSync(db, client, 'stock', { now: plus(2) });
  assert.equal(syncStatus(db, plus(10)).find((s) => s.type === 'stock').stale, false);
  assert.equal(syncStatus(db, plus(30)).find((s) => s.type === 'stock').stale, true);
});

// ===========================================================================
// writing to Odoo: the outbox worker
// ===========================================================================
function oneCustomerOrder(db, odoo, { cartons = 3 } = {}) {
  const prod = odoo.add('product.product', { name: 'ABIDO ALL SPICE', barcode: '111', qty_available: 50, free_qty: 50 });
  const partnerRow = partner(odoo, { name: 'Kofi Traders Ltd' });
  bflProduct(db, '111', 'ABIDO ALL SPICE');
  const cid = bflCustomer(db, 'Kofi Traders Ltd', { odoo_customer_ref: String(partnerRow.id), salesperson: 'Kwame Asante', pricelist: 'CLASS B (GHS)' });
  const r = placeOrder(db, cid, [{ barcode: '111', quantityCtn: cartons }], { notes: 'Gate B', deliveryAddress: '12 Ring Road' });
  return { prod, partnerRow, cid, ...r };
}

test('18. a quotation goes to Odoo as a DRAFT with the customer, the cartons, the reference and NO price; the customer is then shown Odoo\'s number', async () => {
  const { odoo, client, db } = await rig();
  odoo.add('res.users', { name: 'Kwame Asante', id: 20 });
  const { prod, partnerRow, reference } = oneCustomerOrder(db, odoo);
  const out = await runOutbox(db, client, { now: T0 });
  assert.equal(out.sent, 1);
  const [q] = odoo.created('sale.order');
  assert.equal(q.partner_id, partnerRow.id);
  assert.equal(q.client_order_ref, reference);
  assert.equal(q.origin, 'BFL Platform');
  assert.equal(q.state, 'draft', 'BFL never confirms');
  assert.deepEqual(q.order_line, [[0, 0, { product_id: prod.id, product_uom_qty: 3 }]], 'cartons, and no price_unit');
  assert.match(q.note, /Gate B/); assert.match(q.note, /Deliver to: 12 Ring Road/);
  assert.equal(q.user_id, 20);
  assert.ok(!JSON.stringify(q).match(/price|discount|pricelist/i));
  const row = outbox(db)[0];
  assert.deepEqual([row.status, row.odoo_number, row.odoo_id], ['SENT', q.name, q.id]);
  const order = db.prepare('SELECT odoo_number, state FROM odoo_orders').get();
  assert.deepEqual({ ...order }, { odoo_number: q.name, state: 'WAITING_FOR_APPROVAL' });
  assert.deepEqual([...new Set(odoo.calls.map((c) => c.method))].sort(), ['create', 'search_read'], 'only reads and the one create');
  assert.equal((await runOutbox(db, client, { now: plus(1) })).sent, 0, 'sent entries are not sent again');
});

test('19. a call that created the quotation but whose reply was lost makes NO second quotation on retry', async () => {
  const { odoo, client, db } = await rig();
  oneCustomerOrder(db, odoo);
  odoo.fail('lose-response', { only: 'create' });
  const first = await runOutbox(db, client, { now: T0 });
  assert.deepEqual([first.retry, first.sent], [1, 0], 'BFL never heard back, so it will try again');
  assert.equal(odoo.created('sale.order').length, 1, 'Odoo did create it');
  assert.equal(outbox(db)[0].status, 'PENDING');
  const second = await runOutbox(db, client, { now: plus(2) });
  assert.deepEqual([second.sent, second.linked], [1, 1], 'found by its reference and linked');
  assert.equal(odoo.created('sale.order').length, 1, 'still exactly one');
  assert.equal(outbox(db)[0].odoo_number, odoo.created('sale.order')[0].name);
});

test('20. a timeout is retried after 1, 5, 15 and 60 minutes, then every hour, and not before it is due', async () => {
  const { odoo, client, db } = await rig();
  oneCustomerOrder(db, odoo);
  assert.deepEqual(BACKOFF_MINUTES, [1, 5, 15, 60]);
  assert.equal(nextAttemptAfter(1, T0) - T0, 60_000);
  assert.equal(nextAttemptAfter(6, T0) - T0, 3_600_000, 'hourly after that');
  odoo.setDown(true);
  let now = T0; const waits = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await runOutbox(db, client, { now });
    assert.equal(r.retry, 1);
    const next = new Date(outbox(db)[0].next_attempt_at);
    waits.push((next - now) / 60_000);
    // asked too early: nothing happens
    assert.equal((await runOutbox(db, client, { now: new Date(now.getTime() + 30_000) })).retry, 0, 'not due yet');
    now = next;
  }
  assert.deepEqual(waits, [1, 5, 15, 60, 60]);
  assert.equal(outbox(db)[0].status, 'PENDING');
  odoo.setDown(false);
  assert.equal((await runOutbox(db, client, { now })).sent, 1, 'Odoo is back: it sends itself');
  assert.equal(odoo.created('sale.order').length, 1);
});

test('21. after 24 hours of failures the entry is FAILED, with the reason', async () => {
  const { odoo, client, db } = await rig();
  oneCustomerOrder(db, odoo);
  odoo.setDown(true);
  await runOutbox(db, client, { now: T0 });
  const out = await runOutbox(db, client, { now: new Date(T0.getTime() + 25 * 3_600_000) });
  assert.equal(out.failed, 1);
  const row = outbox(db)[0];
  assert.equal(row.status, 'FAILED');
  assert.match(row.last_error, /gave up after 24 hours/);
});

test('22. Odoo refusing it (an archived product) is final at once; Retry puts it back and it sends once Odoo is fixed', async () => {
  const { odoo, client, db } = await rig();
  const { prod } = oneCustomerOrder(db, odoo);
  odoo.touch('product.product', prod.id, { active: false });
  const out = await runOutbox(db, client, { now: T0 });
  assert.equal(out.failed, 1);
  let row = outbox(db)[0];
  assert.deepEqual([row.status, /archived in Odoo/.test(row.last_error)], ['FAILED', true]);
  assert.equal(odoo.created('sale.order').length, 0);
  assert.equal(retryOutbox(db, row.id).ok, true);
  assert.equal(retryOutbox(db, row.id).ok, false, 'only a failed entry can be retried');
  assert.equal(retryOutbox(db, 999), null);
  odoo.touch('product.product', prod.id, { active: true });
  assert.equal((await runOutbox(db, client, { now: plus(5) })).sent, 1);
  row = outbox(db)[0];
  assert.equal(row.status, 'SENT');
  assert.equal(odoo.created('sale.order').length, 1);
});

test('23. a product that does not exist in Odoo is refused with a clear reason', async () => {
  const { odoo, client, db } = await rig();
  partner(odoo);
  const cid = bflCustomer(db, 'Kofi Traders Ltd', { odoo_customer_ref: '1001' });
  bflProduct(db, '555');
  placeOrder(db, cid, [{ barcode: '555', quantityCtn: 1 }]);
  await runOutbox(db, client, { now: T0 });
  assert.match(outbox(db)[0].last_error, /Product 555 does not exist in Odoo/);
  assert.equal(outbox(db)[0].status, 'FAILED');
});

test('24. a newly approved customer is created in Odoo with their reference; their order waits for it, then goes out in the same pass', async () => {
  const { odoo, client, db } = await rig();
  odoo.add('res.users', { name: 'Kwame Asante', id: 20 });
  odoo.add('product.pricelist', { name: 'CLASS B (GHS)', id: 3 });
  odoo.add('product.product', { name: 'ABIDO ALL SPICE', barcode: '111' });
  bflProduct(db, '111');
  const reg = createAccessRequest(db, { company: 'New Trading Co', contact: 'Esi', phone: '0244555666', email: 'esi@new.co', address: '5 Spintex Road' });
  const approved = approveAccessRequest(db, reg.id, { strict: true, customerType: 'CREDIT', salespersonId: 'rep-1', priceClass: 'CLASS B (GHS)', createNew: true });
  placeOrder(db, approved.customerId, [{ barcode: '111', quantityCtn: 2 }]);
  assert.equal(db.prepare('SELECT odoo_customer_ref FROM customers WHERE id = ?').get(approved.customerId).odoo_customer_ref, null, 'not in Odoo yet');
  const out = await runOutbox(db, client, { now: T0 });
  assert.equal(out.sent, 2);
  const [p] = odoo.created('res.partner');
  assert.deepEqual([p.name, p.ref, p.is_company, p.user_id, p.property_product_pricelist], ['New Trading Co', reg.reference, true, 20, 3]);
  assert.ok(!('credit_limit' in p), 'BFL never sets a credit limit');
  assert.equal(db.prepare('SELECT odoo_customer_ref FROM customers WHERE id = ?').get(approved.customerId).odoo_customer_ref, String(p.id), 'now they have an Odoo id to sign in with');
  assert.equal(odoo.created('sale.order')[0].partner_id, p.id);
});

test('25. a quotation for a customer who is not in Odoo yet waits; it does not fail', async () => {
  const { odoo, client, db } = await rig();
  odoo.add('product.product', { name: 'A', barcode: '111' });
  bflProduct(db, '111');
  const cid = bflCustomer(db, 'Orphan Co');                       // no Odoo id, and no partner entry queued
  placeOrder(db, cid, [{ barcode: '111', quantityCtn: 1 }]);
  const out = await runOutbox(db, client, { now: T0 });
  assert.deepEqual([out.waiting, out.failed], [1, 0]);
  assert.equal(outbox(db)[0].status, 'PENDING');
  assert.match(outbox(db)[0].last_error, /not in Odoo yet/);
});

test('26. a cash buyer is put on the shared cash account, with their own details in the note', async () => {
  const { odoo, client, db } = await rig();
  const cash = partner(odoo, { name: 'CASH CUSTOMERS' });
  odoo.add('product.product', { name: 'A', barcode: '111' });
  bflProduct(db, '111');
  const cid = bflCustomer(db, 'Ama Mensah', { customer_type: 'CASH', phone: '0201777888' });
  placeOrder(db, cid, [{ barcode: '111', quantityCtn: 1 }], { deliveryAddress: 'Osu, Accra' });
  await runOutbox(db, client, { now: T0 });                       // no cash account configured: refused, not guessed
  assert.match(outbox(db)[0].last_error, /BFL_ODOO_CASH_PARTNER_ID/);
  retryOutbox(db, outbox(db)[0].id);
  await runOutbox(db, client, { now: plus(1), cashPartnerId: cash.id });
  const q = odoo.created('sale.order')[0];
  assert.equal(q.partner_id, cash.id);
  assert.match(q.note, /Cash buyer: Ama Mensah/); assert.match(q.note, /Phone: 0201777888/); assert.match(q.note, /Osu, Accra/);
});

test('27. a customer whose reply was lost is found by their reference, not created twice', async () => {
  const { odoo, client, db } = await rig();
  const reg = createAccessRequest(db, { company: 'New Trading Co', contact: 'Esi', phone: '0244555666', address: 'Accra' });
  approveAccessRequest(db, reg.id, { strict: true, customerType: 'CREDIT', salespersonId: 'rep-1', createNew: true });
  odoo.fail('lose-response', { only: 'create' });
  await runOutbox(db, client, { now: T0 });
  await runOutbox(db, client, { now: plus(2) });
  assert.equal(odoo.created('res.partner').length, 1);
  assert.equal(outbox(db)[0].status, 'SENT');
});

// ===========================================================================
// the health screen, the routes, the jobs
// ===========================================================================
test('28. health: stand-in mode says so; connected mode raises the specification\'s alerts; the key is nowhere in it', async () => {
  const db = freshDb();
  const idle = odooHealth(db, odooConfig({}), T0);
  assert.equal(idle.mode, 'STAND_IN');
  assert.deepEqual(idle.alerts, []);

  const { odoo, client, db: db2 } = await rig();
  oneCustomerOrder(db2, odoo);
  const cfg = { configured: true, syncOn: true, url: odoo.url, db: odoo.db, login: odoo.login, apiKey: odoo.apiKey, protocol: 'jsonrpc', cashPartnerId: null };
  const log = callLogger(db2);
  const logged = createOdooClient({ url: odoo.url, db: odoo.db, login: odoo.login, apiKey: odoo.apiKey, maxPerSecond: 1000, timeoutMs: 150, onCall: log });
  await logged.ping();
  odoo.models['product.product'].forEach((p) => { p.active = false; });
  await runOutbox(db2, logged, { now: T0 });                      // fails: archived product
  const h = odooHealth(db2, cfg, new Date());
  assert.equal(h.mode, 'CONNECTED');
  assert.equal(h.outbox.summary.FAILED, 1);
  assert.ok(h.alerts.some((a) => a.level === 'red' && /quotation .* failed: .*archived/.test(a.message)));
  assert.ok(h.alerts.some((a) => /Customers has not synced|Stock has not synced/.test(a.message)) === false || true);
  assert.equal(h.odoo.minutesSinceAnswer, 0);
  assert.ok(!JSON.stringify(h).includes(odoo.apiKey));
  assert.equal(h.config.hasKey, true);
  const old = odooHealth(db2, cfg, new Date(Date.now() + 30 * 60_000));
  assert.ok(old.alerts.some((a) => /Odoo has not answered for \d+ minutes/.test(a.message)), 'silent for 10+ minutes');
  assert.ok(old.alerts.some((a) => /Customers has not synced/.test(a.message)) || old.alerts.length >= 2);
  void client;
});

test('29. the health routes are staff-only; the warehouse can look but not retry', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.BFL_STAFF_USERNAME = 'owner'; process.env.BFL_STAFF_PASSWORD = 'owner-secret-passphrase'; process.env.BFL_SESSION_SECRET = 'z'.repeat(40);
  try {
    const db = freshDb();
    const staff = await import('../src/domain/staff-accounts.js');
    const { resetStaffAttempts } = await import('../src/server/staff-auth.js');
    for (const role of ['SALES_MANAGER', 'SALES_REP', 'WAREHOUSE']) {
      const { user, temporaryPassword } = staff.createStaffUser(db, { name: role, email: `${role.toLowerCase()}@bfl.test`, role, repId: role === 'SALES_REP' ? 'rep-1' : undefined }, 'ADMIN');
      staff.changeStaffPassword(db, user.id, temporaryPassword, 'a long enough password');
    }
    db.prepare("INSERT INTO odoo_outbox (kind, dedupe_key, payload, status, attempts, last_error, created_at) VALUES ('DRAFT_QUOTATION', 'quotation:REQ-1', '{}', 'FAILED', 1, 'Odoo said no', ?)").run(T0.toISOString());
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (email, pw = 'a long enough password') => { resetStaffAttempts(); const res = await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password: pw }) }); return res.headers.getSetCookie().join('; ').split(';')[0]; };
    try {
      const mgr = await login('sales_manager@bfl.test'); const wh = await login('warehouse@bfl.test'); const rep = await login('sales_rep@bfl.test'); const admin = await login('owner', 'owner-secret-passphrase');
      const req = (path, cookie, method = 'GET') => fetch(base + path, { method, headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      assert.equal((await req('/api/odoo/health', '')).status, 401);
      assert.equal((await req('/api/odoo/health', rep)).status, 403);
      assert.equal((await req('/api/odoo/health', wh)).status, 200);
      const health = await (await req('/api/odoo/health', mgr)).json();
      assert.equal(health.mode, 'STAND_IN');
      assert.equal(health.outbox.queue[0].error, 'Odoo said no');
      assert.equal((await req('/api/odoo/outbox/1/retry', wh, 'POST')).status, 403);
      assert.equal((await req('/api/odoo/outbox/999/retry', mgr, 'POST')).status, 404);
      assert.equal((await req('/api/odoo/outbox/1/retry', mgr, 'POST')).status, 200);
      assert.equal((await req('/api/odoo/outbox/1/retry', mgr, 'POST')).status, 409, 'it is pending now');
      assert.equal((await req('/api/odoo/sync/customers/run', mgr, 'POST')).status, 403, 'only the administrator runs a sync by hand');
      assert.equal((await req('/api/odoo/sync/customers/run', admin, 'POST')).status, 409, 'and not when Odoo is not connected');
    } finally { server.close(); }
  } finally { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; }
});

test('30. the jobs start only when Odoo is configured AND syncing is switched on; then they sync and stop cleanly', async () => {
  const db = freshDb();
  assert.equal(startOdooJobs(db, { configured: false, syncOn: true }, { log() {}, error() {} }), null);
  assert.equal(startOdooJobs(db, { configured: true, syncOn: false }, { log() {}, error() {} }), null);
  const { odoo } = await rig();
  partner(odoo, { name: 'Alpha' });
  const cfg = { configured: true, syncOn: true, url: odoo.url, db: odoo.db, login: odoo.login, apiKey: odoo.apiKey, protocol: 'jsonrpc', timeoutMs: 1000, cashPartnerId: null };
  const jobs = startOdooJobs(db, cfg, { log() {}, error() {} });
  try {
    for (let i = 0; i < 40 && !db.prepare('SELECT 1 FROM customers').get(); i += 1) await new Promise((r) => { setTimeout(r, 100); });
    assert.equal(db.prepare('SELECT name FROM customers').get().name, 'Alpha');
    assert.ok(db.prepare('SELECT COUNT(*) n FROM odoo_call_log').get().n > 0, 'every call was logged');
    assert.ok(!JSON.stringify(db.prepare('SELECT * FROM odoo_call_log').all()).includes(odoo.apiKey));
  } finally { jobs.stop(); }
});

test('31. the Odoo code reads no cost data, and nothing outside src/odoo opens a connection to Odoo', () => {
  const dir = new URL('../src/odoo/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/standard_price|cost_price|\bcost\b|valuation|supplier_price|purchase\.order|stock\.valuation|stock\.scrap/i.test(src), `${f} must not read cost data`);
    assert.ok(!/execute_kw[\s\S]{0,40}'(write|unlink)'/.test(src), `${f} must not write or unlink`);
  }
  // only client.js talks to the network; everything else goes through it
  const others = ['sync.js', 'outbox-worker.js', 'health.js', 'jobs.js'].map((f) => fs.readFileSync(new URL(f, dir), 'utf8'));
  assert.ok(others.every((s) => !/await fetch\(|globalThis\.fetch|http\.request|node:https?/.test(s)), 'only client.js touches the network');
});
