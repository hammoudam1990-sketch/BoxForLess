// Sales Management slice 5: registration, the Sales Manager's decision (S01), and prices from the
// customer's own price class.
//
// What is at risk, in order:
//   1. A price reaching someone who is not a signed-in, approved customer, or another customer's price.
//   2. Approving a duplicate of an existing customer, or writing to Odoo for someone who must not be there.
//   3. A half-made approval (a customer with no code, a code with no customer).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import {
  createAccessRequest, approveAccessRequest, getAccessRequest, findDuplicates, toAccessRequestReceipt,
  listAccessRequests, AccessRequestError,
} from '../src/domain/access-requests.js';
import { enqueue, listPending, outboxSummary, OutboxKind } from '../src/domain/outbox.js';
import {
  cartonPriceFor, listPriceClasses, pricesForCustomer, DEFAULT_PRICE_CLASS, CASH_PRICE_CLASS, PRICE_SOURCE,
} from '../src/domain/prices.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';

beforeEach(() => resetAccessAttempts());

const REP_1 = 'rep-1';
const SPICE = '5283001117266';
const reg = (db, o = {}) => createAccessRequest(db, { company: 'Kofi Traders Ltd', contact: 'Kofi', phone: '0244 111 222', address: 'Accra', ...o });
const customer = (db, name, extra = {}) => {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
};
const strict = (extra = {}) => ({ strict: true, salespersonId: REP_1, ...extra });
const counts = (db) => ({
  customers: db.prepare('SELECT COUNT(*) n FROM customers').get().n,
  outbox: db.prepare('SELECT COUNT(*) n FROM odoo_outbox').get().n,
});

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
async function withApp(db, fn) {
  const { server, base } = await startApp(db);
  try { return await fn(base); } finally { server.close(); }
}
const send = (base, path, method = 'GET', body = null, cookie = null) => fetch(base + path, {
  method,
  headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];
async function signIn(base, db, id) {
  const res = await send(base, '/api/catalog/access', 'POST', { code: issueAccessCode(db, id) });
  assert.equal(res.status, 200);
  return cookieOf(res);
}

// ===========================================================================
// registration
// ===========================================================================
test('1. a registration gets a reference, and the acknowledgement carries no id or code', () => {
  const db = freshDb();
  const a = reg(db);
  const b = reg(db, { company: 'Another Co', phone: '0201 999 888' });
  assert.match(a.reference, /^REG-\d{4}-0001$/);
  assert.match(b.reference, /^REG-\d{4}-0002$/);
  assert.equal(getAccessRequest(db, a.id).reference, a.reference);
  const receipt = toAccessRequestReceipt(a.reference);
  assert.deepEqual(Object.keys(receipt).sort(), ['message', 'received', 'reference', 'status']);
  assert.equal(receipt.status, 'WAITING_FOR_APPROVAL');
  assert.equal(counts(db).customers, 0, 'registering creates no customer');
  assert.equal(counts(db).outbox, 0, 'and nothing for Odoo');
  assert.ok(!db.prepare('SELECT access_code FROM customers').all().length);
});

test('2. the public registration route says "waiting for approval" and gives no way in', async () => {
  const db = freshDb();
  await withApp(db, async (base) => {
    const res = await send(base, '/api/catalog/access-requests', 'POST', { company: 'Kofi Traders Ltd', contact: 'Kofi', phone: '0244111222', address: 'Accra' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.status, 'WAITING_FOR_APPROVAL');
    assert.match(body.reference, /^REG-/);
    assert.ok(!('code' in body) && !('id' in body) && !('customerId' in body));
    // having registered gives no session and no prices
    const prices = await send(base, `/api/catalog/prices?barcodes=${SPICE}`);
    assert.equal(prices.status, 401);
  });
});

test('3. a known company and a new one get the same acknowledgement shape', async () => {
  const db = freshDb();
  customer(db, 'Melcom Ltd');
  await withApp(db, async (base) => {
    const known = await (await send(base, '/api/catalog/access-requests', 'POST', { company: 'Melcom Ltd', contact: 'A', phone: '0244555666', address: 'Accra' })).json();
    const fresh = await (await send(base, '/api/catalog/access-requests', 'POST', { company: 'Totally New Co', contact: 'B', phone: '0277333444', address: 'Accra' })).json();
    assert.deepEqual(Object.keys(known).sort(), Object.keys(fresh).sort());
    assert.equal(known.message, fresh.message);
    assert.equal(known.status, fresh.status);
  });
});

// ===========================================================================
// the duplicate check
// ===========================================================================
test('4. the duplicate check finds a customer by name, phone (any format) or email', () => {
  const db = freshDb();
  const byName = customer(db, 'kofi  traders ltd.');
  const byPhone = customer(db, 'Someone Else', { phone: '+233 24 4111 222' });
  const byEmail = customer(db, 'Third One', { email: 'KOFI@EXAMPLE.COM' });
  customer(db, 'Unrelated Shop', { phone: '0200000000', email: 'x@y.com' });
  const r = getAccessRequest(db, reg(db, { email: 'kofi@example.com' }).id);
  const d = findDuplicates(db, r);
  assert.deepEqual(d.customers.map((c) => c.id).sort(), [byName, byPhone, byEmail].sort());
  assert.deepEqual(d.customers.find((c) => c.id === byName).reasons, ['Same name']);
  assert.deepEqual(d.customers.find((c) => c.id === byPhone).reasons, ['Same phone number']);
  assert.deepEqual(d.customers.find((c) => c.id === byEmail).reasons, ['Same email']);
});

test('5. a junk phone ("0", "Office") is never an identity, and an empty email matches nothing', () => {
  const db = freshDb();
  customer(db, 'Has Zero Phone', { phone: '0', email: '' });
  customer(db, 'Has Office Phone', { phone: 'Office' });
  const r = getAccessRequest(db, reg(db, { phone: '0', email: '' }).id);
  assert.equal(findDuplicates(db, r).customers.length, 0);
});

test('6. the duplicate check also lists other registrations that look alike', () => {
  const db = freshDb();
  const first = reg(db);
  const second = reg(db, { company: 'Kofi Traders', phone: '024 4111222' });
  const d = findDuplicates(db, getAccessRequest(db, second.id));
  assert.deepEqual(d.requests.map((x) => x.reference), [first.reference]);
  assert.ok(d.requests[0].reasons.includes('Same phone number'));
});

// ===========================================================================
// the decision
// ===========================================================================
test('7. a possible duplicate stops the approval until the Sales Manager decides, and nothing is created', () => {
  const db = freshDb();
  customer(db, 'Kofi Traders Ltd');
  const { id } = reg(db);
  const before = counts(db);
  assert.throws(() => approveAccessRequest(db, id, strict()), (e) => e instanceof AccessRequestError
    && e.code === 'DUPLICATE_CHECK_REQUIRED' && e.status === 409 && e.details.duplicates.customers.length === 1);
  assert.deepEqual(counts(db), before);
  assert.equal(getAccessRequest(db, id).status, 'PENDING');
});

test('8. "it is a new customer" creates a new one even though the name is taken', () => {
  const db = freshDb();
  const old = customer(db, 'Kofi Traders Ltd');
  const { id } = reg(db);
  const r = approveAccessRequest(db, id, strict({ createNew: true }));
  assert.notEqual(r.customerId, old);
  assert.equal(counts(db).customers, 2);
  assert.equal(r.odoo, 'QUEUED');
});

test('9. "it is this customer" links to them, fills blanks only, and sends nothing to Odoo', () => {
  const db = freshDb();
  const old = customer(db, 'Kofi Traders Ltd', { pricelist: 'CLASS B (GHS)', salesperson: 'Existing Rep' });
  const { id } = reg(db);
  const r = approveAccessRequest(db, id, strict({ linkCustomerId: old, priceClass: 'CLASS D (GHS)' }));
  assert.equal(r.customerId, old);
  assert.equal(r.odoo, 'EXISTING_CUSTOMER');
  const row = db.prepare('SELECT pricelist, salesperson, delivery_address, registration_ref FROM customers WHERE id = ?').get(old);
  assert.equal(row.pricelist, 'CLASS B (GHS)', 'Odoo wins: the price class they already had is kept');
  assert.equal(row.salesperson, 'Existing Rep');
  assert.equal(row.delivery_address, 'Accra', 'a blank address is filled in');
  assert.equal(counts(db).customers, 1);
  assert.equal(counts(db).outbox, 0, 'an existing customer is never written to Odoo');
});

test('10. a new credit customer needs a rep, gets a price class, and is queued for Odoo once', () => {
  const db = freshDb();
  const { id, reference } = reg(db);
  assert.throws(() => approveAccessRequest(db, id, { strict: true }), (e) => e.code === 'SALESPERSON_REQUIRED');
  assert.equal(counts(db).customers, 0);

  const r = approveAccessRequest(db, id, strict({ customerType: 'CREDIT', priceClass: 'CLASS C (GHS)' }));
  assert.equal(r.customerType, 'CREDIT');
  assert.equal(r.priceClass, 'CLASS C (GHS)');
  assert.equal(r.salesperson, 'Kwame Asante');
  assert.equal(r.odoo, 'QUEUED');
  const c = db.prepare('SELECT customer_type, pricelist, salesperson, registration_ref FROM customers WHERE id = ?').get(r.customerId);
  assert.deepEqual({ ...c }, { customer_type: 'CREDIT', pricelist: 'CLASS C (GHS)', salesperson: 'Kwame Asante', registration_ref: reference });

  const [queued] = listPending(db);
  assert.equal(queued.kind, OutboxKind.CREATE_PARTNER);
  assert.equal(queued.payload.model, 'res.partner');
  assert.equal(queued.payload.values.ref, reference, 'the registration reference travels in Odoo\'s ref');
  assert.equal(queued.payload.values.name, 'Kofi Traders Ltd');
  assert.ok(!JSON.stringify(queued.payload).match(/access_code|code/i), 'the access code never goes to Odoo');
  // a second approval is refused and queues nothing more
  assert.throws(() => approveAccessRequest(db, id, strict()), AccessRequestError);
  assert.equal(outboxSummary(db).PENDING, 1);
});

test('11. a cash customer is never created in Odoo and always uses the cash-account price class', () => {
  const db = freshDb();
  const { id } = reg(db, { company: '', contact: 'Ama Mensah', phone: '0201 777 888' });
  assert.equal(getAccessRequest(db, id).company, null);
  const r = approveAccessRequest(db, id, { strict: true, customerType: 'CASH', priceClass: 'CLASS D (GHS)' });
  assert.equal(r.customerType, 'CASH');
  assert.equal(r.priceClass, CASH_PRICE_CLASS, 'a class chosen for a cash customer is ignored');
  assert.equal(r.odoo, 'NOT_NEEDED');
  assert.equal(counts(db).outbox, 0);
  assert.equal(db.prepare('SELECT pricelist FROM customers WHERE id = ?').get(r.customerId).pricelist, CASH_PRICE_CLASS);
});

test('12. an unknown price class or rep is refused and leaves nothing behind', () => {
  const db = freshDb();
  const { id } = reg(db);
  assert.throws(() => approveAccessRequest(db, id, strict({ priceClass: 'CLASS Z (GHS)' })), /price classes/);
  assert.throws(() => approveAccessRequest(db, id, strict({ salespersonId: 'rep-99' })), /sales reps/);
  assert.throws(() => approveAccessRequest(db, id, strict({ customerType: 'VIP' })), /credit or cash/);
  assert.deepEqual(counts(db), { customers: 0, outbox: 0 });
  assert.equal(getAccessRequest(db, id).status, 'PENDING');
  assert.equal(listAccessRequests(db).items[0].customer_type, null);
});

test('13. the outbox never queues the same write twice', () => {
  const db = freshDb();
  enqueue(db, OutboxKind.CREATE_PARTNER, 'partner:REG-1', { a: 1 });
  enqueue(db, OutboxKind.CREATE_PARTNER, 'partner:REG-1', { a: 2 });
  assert.equal(listPending(db).length, 1);
  assert.deepEqual(listPending(db)[0].payload, { a: 1 });
  assert.throws(() => enqueue(db, 'DELETE_EVERYTHING', 'x', {}), /Unknown outbox kind/);
});

// ===========================================================================
// the staff routes
// ===========================================================================
test('14. the Approvals routes decide, refuse duplicates with their list, and report what is queued', async () => {
  const db = freshDb();
  customer(db, 'Kofi Traders Ltd', { pricelist: 'CLASS A (GHS)' });
  const { id } = reg(db);
  await withApp(db, async (base) => {
    const options = await (await send(base, '/api/requests/access-requests/options')).json();
    assert.equal(options.source, 'SAMPLE');
    assert.ok(options.priceClasses.some((c) => c.name === DEFAULT_PRICE_CLASS && c.isDefault));
    assert.ok(options.reps.length >= 2);
    assert.deepEqual(options.customerTypes.sort(), ['CASH', 'CREDIT']);

    const detail = await (await send(base, `/api/requests/access-requests/${id}`)).json();
    assert.equal(detail.suggestedType, 'CREDIT');
    assert.equal(detail.duplicates.customers.length, 1);

    const refused = await send(base, `/api/requests/access-requests/${id}/approve`, 'POST', { customerType: 'CREDIT', salespersonId: REP_1 });
    assert.equal(refused.status, 409);
    const refusedBody = await refused.json();
    assert.equal(refusedBody.code, 'DUPLICATE_CHECK_REQUIRED');
    assert.equal(refusedBody.duplicates.customers.length, 1);

    const noRep = await send(base, `/api/requests/access-requests/${id}/approve`, 'POST', { customerType: 'CREDIT', createNew: true });
    assert.equal(noRep.status, 400);

    const ok = await send(base, `/api/requests/access-requests/${id}/approve`, 'POST', { customerType: 'CREDIT', salespersonId: REP_1, priceClass: 'CLASS B (GHS)', createNew: true });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.odoo, 'QUEUED');
    assert.match(body.display, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const after = await (await send(base, '/api/requests/access-requests/options')).json();
    assert.equal(after.outbox.summary.PENDING, 1);
    assert.equal(after.outbox.pending[0].reference, body.reference);
  });
});

test('15. the client cannot switch off the duplicate check', async () => {
  const db = freshDb();
  customer(db, 'Kofi Traders Ltd');
  const { id } = reg(db);
  await withApp(db, async (base) => {
    const res = await send(base, `/api/requests/access-requests/${id}/approve`, 'POST', { strict: false, salespersonId: REP_1, customerType: 'CREDIT' });
    assert.equal(res.status, 409);
  });
});

test('16. the registration and options routes are staff-only', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const db = freshDb();
    customer(db, 'Kofi Traders Ltd');
    const { id } = reg(db);
    await withApp(db, async (base) => {
      for (const [method, url] of [['GET', '/api/requests/access-requests/options'], ['GET', `/api/requests/access-requests/${id}`], ['POST', `/api/requests/access-requests/${id}/approve`]]) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.ok([401, 403, 503].includes(res.status), `${method} ${url} -> ${res.status}`);
        const text = await res.text();
        assert.ok(!text.includes('Kofi') && !text.includes('CLASS'), 'a refusal reveals nothing');
      }
    });
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});

// ===========================================================================
// prices
// ===========================================================================
test('17. prices are per carton in GHS, stable, positive and ordered by class', () => {
  const a = cartonPriceFor(SPICE, 'CLASS A (GHS)');
  assert.equal(a, cartonPriceFor(SPICE, 'CLASS A (GHS)'), 'stable');
  assert.ok(a > 0 && Math.round(a * 100) === a * 100, 'two decimals');
  assert.ok(cartonPriceFor(SPICE, 'CLASS D (GHS)') < cartonPriceFor(SPICE, 'CLASS B (GHS)'));
  assert.ok(cartonPriceFor(SPICE, CASH_PRICE_CLASS) > a, 'cash pays the most');
  assert.equal(cartonPriceFor(SPICE, 'NO SUCH CLASS'), null, 'an unknown class is never guessed');
  assert.equal(cartonPriceFor(SPICE, null), null);
  assert.ok(listPriceClasses().filter((c) => c.isDefault).length === 1);
  assert.equal(PRICE_SOURCE, 'SAMPLE');
});

test('18. the price route needs a signed-in customer; a visitor gets a refusal that says nothing', async () => {
  const db = freshDb();
  await withApp(db, async (base) => {
    const res = await send(base, `/api/catalog/prices?barcodes=${SPICE}`);
    assert.equal(res.status, 401);
    const text = await res.text();
    assert.ok(!/\d+\.\d\d/.test(text) && !/CLASS/.test(text));
  });
});

test('19. a customer sees only their own class\'s prices, and the answer names no class', async () => {
  const db = freshDb();
  const a = customer(db, 'Class A Co', { pricelist: 'CLASS A (GHS)' });
  const d = customer(db, 'Class D Co', { pricelist: 'CLASS D (GHS)' });
  await withApp(db, async (base) => {
    const ca = await signIn(base, db, a);
    const cd = await signIn(base, db, d);
    const ra = await (await send(base, `/api/catalog/prices?barcodes=${SPICE},0000`, 'GET', null, ca)).json();
    const rd = await (await send(base, `/api/catalog/prices?barcodes=${SPICE}`, 'GET', null, cd)).json();
    assert.deepEqual(Object.keys(ra).sort(), ['available', 'currency', 'per', 'prices', 'source']);
    assert.equal(ra.currency, 'GHS');
    assert.equal(ra.per, 'carton');
    assert.equal(ra.source, 'SAMPLE');
    assert.equal(ra.prices[SPICE], cartonPriceFor(SPICE, 'CLASS A (GHS)'));
    assert.equal(rd.prices[SPICE], cartonPriceFor(SPICE, 'CLASS D (GHS)'));
    assert.notEqual(ra.prices[SPICE], rd.prices[SPICE]);
    assert.ok(!JSON.stringify(ra).includes('CLASS'));
  });
});

test('20. a customer with no price class gets no prices, not a guess', async () => {
  const db = freshDb();
  const id = customer(db, 'No Class Co');
  const odd = customer(db, 'Odd Class Co', { pricelist: 'SOMETHING ELSE (GHS)' });
  assert.deepEqual(pricesForCustomer(db, id, [SPICE]), { currency: 'GHS', per: 'carton', source: 'SAMPLE', available: false, prices: {} });
  assert.equal(pricesForCustomer(db, odd, [SPICE]).available, false);
  await withApp(db, async (base) => {
    const cookie = await signIn(base, db, id);
    const r = await (await send(base, `/api/catalog/prices?barcodes=${SPICE}`, 'GET', null, cookie)).json();
    assert.equal(r.available, false);
    assert.deepEqual(r.prices, {});
  });
});

test('21. identity comes from the session: a customer id in the query changes nothing', async () => {
  const db = freshDb();
  const a = customer(db, 'Class A Co', { pricelist: 'CLASS A (GHS)' });
  const d = customer(db, 'Class D Co', { pricelist: 'CLASS D (GHS)' });
  await withApp(db, async (base) => {
    const ca = await signIn(base, db, a);
    const r = await (await send(base, `/api/catalog/prices?barcodes=${SPICE}&customer=${d}&customerId=${d}&priceClass=CLASS%20D%20(GHS)`, 'GET', null, ca)).json();
    assert.equal(r.prices[SPICE], cartonPriceFor(SPICE, 'CLASS A (GHS)'));
  });
});

test('22. the catalogue lists and product pages carry no price, for anyone', async () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)').run(SPICE, 'ABIDO ALL SPICE', 'CTN14', 20, ts, ts);
  const a = customer(db, 'Class A Co', { pricelist: 'CLASS A (GHS)' });
  await withApp(db, async (base) => {
    const cookie = await signIn(base, db, a);
    for (const c of [null, cookie]) {
      for (const url of ['/api/catalog/products', `/api/catalog/products/${SPICE}`, '/api/catalog/facets']) {
        const res = await send(base, url, 'GET', null, c);
        assert.equal(res.status, 200, url);
        const text = await res.text();
        assert.ok(!/price|pricelist|"cost"|GHS/i.test(text), `${url} must carry no price`);
      }
    }
  });
});

test('23. the price code never touches cost, valuation or supplier data', () => {
  for (const f of ['src/domain/prices.js', 'src/domain/outbox.js', 'src/domain/access-requests.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/standard_price|cost_price|\bcost\b|valuation|purchase|supplier_price/i.test(src), `${f} must not read cost data`);
  }
});

test('24. the customer-facing catalogue script asks for prices only from the signed-in route', () => {
  const dir = new URL('../src/public/js/catalog/', import.meta.url);
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(new URL(f, dir), 'utf8');
    const hits = src.match(/\/api\/[a-z/-]*price[a-z/-]*/gi) || [];
    assert.ok(hits.every((h) => h === '/api/catalog/prices'), `${f} uses ${hits.join(', ')}`);
    assert.ok(!/\/api\/(requests|expiry|shelf|staff)/.test(src), `${f} must not call staff routes`);
  }
});
