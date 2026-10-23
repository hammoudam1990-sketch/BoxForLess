// Discounts the Sales Manager puts on lots close to expiry:
//   CLEARANCE: a lot in our warehouse -> customers see it in their catalogue and can order it at the discount;
//   SHELF:     a lot on a customer's shelf -> the rep offers it on the visit; within it, a discount is approved at once.
//
// What is at risk, in order:
//   1. A visitor, a pending customer or the wrong customer seeing a discount (it is a price, so it follows the price rules).
//   2. Anyone but the Sales Manager (or administrator) setting one.
//   3. A lot sold twice at the discount, or a quotation that carries a price, or the discount lost on the way to Odoo.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';
import { submitRequest } from '../src/domain/requests.js';
import { createOrderForRequest, estimateValue } from '../src/domain/orders.js';
import { applyClearance, clearanceOffersFor, DiscountKind, setLotDiscount, removeLotDiscount, discountLog, LotDiscountError } from '../src/domain/lot-discounts.js';
import { buildExpiryList, saveLotClearanceDiscount, expiryCsv } from '../src/domain/expiry-list.js';
import { ExpiryActionError } from '../src/domain/expiry-actions.js';
import { cartonPriceFor } from '../src/domain/prices.js';
import { setMinShelfLifeDays } from '../src/domain/shelf-life.js';
import { addRule } from '../src/domain/visibility.js';
import { myVisits, visitSheet, recordVisit, shelfLotDiscounts, saveShelfLotDiscount, approvals } from '../src/domain/shelf.js';
import { FakeOdoo } from '../src/odoo/fake-odoo.js';
import { createOdooClient } from '../src/odoo/client.js';
import { runOutbox } from '../src/odoo/outbox-worker.js';

beforeEach(() => resetAccessAttempts());

const TODAY = new Date().toISOString().slice(0, 10);
const SPICE = '5283001117266';          // SAMPLE-0018: ~25 days left, 16 cartons (main warehouse)
const SPICE_LOT = `${SPICE}|SAMPLE-0018`;
const CLOVE = '5283001109209';          // SAMPLE-0019: ~58 days left, 28 cartons
const CLOVE_LOT = `${CLOVE}|SAMPLE-0019`;
const EXPIRED_LOT = '8593803314051|SAMPLE-0001';   // already expired
const FINE_LOT = '5283001117433|SAMPLE-0021';      // 330 days left: not close to expiry

function stock(db) {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  for (const b of [SPICE, CLOVE, '5283001117433']) {
    db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, on_hand, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)').run(b, `PRODUCT ${b}`, 'CTN12', 500, 500, ts, ts);
  }
}
function customer(db, name, extra = {}) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries({ customer_type: 'CREDIT', pricelist: 'CLASS A (GHS)', ...extra })) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}
const offerOn = (db, key = SPICE_LOT, pct = 20) => setLotDiscount(db, DiscountKind.CLEARANCE, key, pct, 'Manager');

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
/** A request the way the route makes it: the order, with the clearance cartons marked, in one transaction. */
function order(db, customerId, lines) {
  return submitRequest(db, {
    lines, customerId,
    onInsert: (id) => { applyClearance(db, id, customerId); createOrderForRequest(db, id); },
  });
}
const quotationOf = (db, requestId) => JSON.parse(db.prepare(`SELECT payload FROM odoo_outbox WHERE dedupe_key = (SELECT 'quotation:' || reference FROM requests WHERE id = ?)`).get(requestId).payload).values;

// ===========================================================================
// the Sales Manager sets a discount on a warehouse lot
// ===========================================================================
test('1. a discount goes on a lot close to expiry, shows on the Expiry list, can be changed and switched off — and is logged', () => {
  const db = freshDb();
  const row = saveLotClearanceDiscount(db, SPICE_LOT, 20, 'Manager');
  assert.equal(row.discountPct, 20);
  assert.equal(saveLotClearanceDiscount(db, SPICE_LOT, '25', 'Manager').discountPct, 25);
  assert.equal(buildExpiryList(db).rows.find((r) => r.key === SPICE_LOT).discountPct, 25);
  assert.equal(saveLotClearanceDiscount(db, SPICE_LOT, null, 'Manager').discountPct, null);
  assert.deepEqual(discountLog(db, DiscountKind.CLEARANCE).map((l) => l.action), ['REMOVE', 'CHANGE', 'SET']);
  // switched off, never deleted
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lot_discounts').get().n, 1);
});

test('2. refused: a lot that is not on the list, one not close to expiry, one already expired, and silly percentages', () => {
  const db = freshDb();
  assert.throws(() => saveLotClearanceDiscount(db, 'nope|nope', 20), ExpiryActionError);
  assert.throws(() => saveLotClearanceDiscount(db, FINE_LOT, 20), /not close to expiry/);
  assert.throws(() => saveLotClearanceDiscount(db, EXPIRED_LOT, 20), /expired/);
  for (const bad of [0, -5, 100, 91, 'abc']) assert.throws(() => saveLotClearanceDiscount(db, SPICE_LOT, bad), (e) => e instanceof LotDiscountError, `pct ${bad}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM lot_discounts').get().n, 0);
});

test('3. the Expiry list says which lots customers cannot see (the product is not in the catalogue) and the CSV carries the discount', () => {
  const db = freshDb();
  stock(db);   // the spice is now a catalogue product; the fresh-milk lot is not
  const rows = buildExpiryList(db).rows;
  assert.equal(rows.find((r) => r.key === SPICE_LOT).inCatalogue, true);
  assert.equal(rows.find((r) => r.key === EXPIRED_LOT).inCatalogue, false);
  offerOn(db);
  const csv = expiryCsv(buildExpiryList(db).rows).split('\r\n');
  assert.match(csv[0], /Customer discount %$/);
  assert.ok(csv.some((l) => l.includes('SAMPLE-0018') && l.endsWith(',20')));
});

test('4. only the Sales Manager or the administrator can set one: the route is closed to the warehouse and reps', () => {
  const routes = fs.readFileSync(new URL('../src/server/routes/expiry.js', import.meta.url), 'utf8');
  assert.match(routes, /router\.put\('\/lots\/:key\/discount', requireRole\('ADMIN', 'SALES_MANAGER'\)/);
  const shelf = fs.readFileSync(new URL('../src/server/routes/shelf.js', import.meta.url), 'utf8');
  assert.match(shelf, /router\.put\('\/lot-discounts\/:key', managersOnly/);
  assert.match(shelf, /router\.get\('\/lot-discounts', managersOnly/);
});

// ===========================================================================
// what a customer sees
// ===========================================================================
test('5. a signed-in customer is offered the lot with their own price and the discounted price; a visitor gets nothing', async () => {
  const db = freshDb(); stock(db); offerOn(db);
  const id = customer(db, 'Kofi Traders');
  await withApp(db, async (base) => {
    assert.equal((await send(base, '/api/catalog/offers')).status, 401, 'a visitor never sees an offer');
    const cookie = await signIn(base, db, id);
    const body = await (await send(base, '/api/catalog/offers', 'GET', null, cookie)).json();
    assert.equal(body.offers.length, 1);
    const o = body.offers[0];
    const price = cartonPriceFor(SPICE, 'CLASS A (GHS)');
    assert.equal(o.barcode, SPICE);
    assert.equal(o.discountPct, 20);
    assert.equal(o.price, price);
    assert.equal(o.discountedPrice, Math.round(price * 0.8 * 100) / 100);
    assert.equal(o.maxCartons, 16);
    assert.match(o.bestBefore, /^\d{4}-\d{2}-\d{2}$/);
    // customer-safe: no internal ids, no lot name, no location, no cost, no stock figures beyond the cartons on offer
    assert.deepEqual(Object.keys(o).sort(), ['barcode', 'bestBefore', 'daysLeft', 'discountPct', 'discountedPrice', 'maxCartons', 'name', 'price']);
    assert.ok(!/SAMPLE-0018|valueAtRisk|cost|CLEARANCE|MAIN/i.test(JSON.stringify(body)));
  });
});

test('6. an offer is not shown to a customer whose minimum shelf life is longer, nor where the product is hidden from them', () => {
  const db = freshDb(); stock(db); offerOn(db);
  const plain = customer(db, 'Plain');
  const picky = customer(db, 'Picky');
  setMinShelfLifeDays(db, picky, 60);                       // the lot has ~25 days left
  const hidden = customer(db, 'Hidden');
  addRule(db, { scopeType: 'CUSTOMER', scopeValue: String(hidden), targetType: 'PRODUCT', targetValue: SPICE }, 'Manager');
  assert.equal(clearanceOffersFor(db, plain).size, 1);
  assert.equal(clearanceOffersFor(db, picky).size, 0, 'below their own minimum');
  assert.equal(clearanceOffersFor(db, hidden).size, 0, 'a hidden product has no offer either');
});

test('7. a customer with no price class sees the percentage but no price; an offer ends when the lot is switched off', () => {
  const db = freshDb(); stock(db); offerOn(db);
  const noClass = customer(db, 'No class', { pricelist: null });
  const o = clearanceOffersFor(db, noClass).get(SPICE);
  assert.equal(o.discountPct, 20);
  assert.equal(o.price, null);
  assert.equal(o.discountedPrice, null);
  removeLotDiscount(db, DiscountKind.CLEARANCE, SPICE_LOT, 'Manager');
  assert.equal(clearanceOffersFor(db, noClass).size, 0);
});

// ===========================================================================
// ordering
// ===========================================================================
test('8. the cartons from the offer carry the discount and name the lot; the rest are ordinary; the quotation has no price', () => {
  const db = freshDb(); stock(db); offerOn(db);
  const id = customer(db, 'Kofi Traders');
  const r = order(db, id, [{ barcode: SPICE, quantityCtn: 20 }, { barcode: CLOVE, quantityCtn: 3 }]);
  const items = db.prepare('SELECT barcode_at_request b, quantity_ctn q, clearance_cartons c, clearance_pct p, clearance_lot_name l FROM request_items WHERE request_id = ? ORDER BY id').all(r.requestId);
  assert.deepEqual(items.map((i) => ({ ...i })), [{ b: SPICE, q: 20, c: 16, p: 20, l: 'SAMPLE-0018' }, { b: CLOVE, q: 3, c: null, p: null, l: null }]);
  const q = quotationOf(db, r.requestId);
  assert.deepEqual(q.lines.map((l) => [l.barcode, l.cartons, l.discount ?? null]), [[SPICE, 4, null], [SPICE, 16, 20], [CLOVE, 3, null]]);
  assert.equal(q.lines[1].lot, 'SAMPLE-0018');
  assert.match(q.lines[1].note, /Clearance: 20% off, lot SAMPLE-0018/);
  assert.match(q.lines[1].note, /Not returnable\./, 'the quotation line says the discounted cartons are not returnable');
  assert.ok(!JSON.stringify(q).match(/price_unit|"price"|amount/i), 'no price goes to Odoo');
});

test('9. a lot is not sold twice at the discount: once the cartons are taken, the next customer is not offered it', () => {
  const db = freshDb(); stock(db); offerOn(db);
  const a = customer(db, 'First');
  const b = customer(db, 'Second');
  order(db, a, [{ barcode: SPICE, quantityCtn: 10 }]);
  assert.equal(clearanceOffersFor(db, b).get(SPICE).cartons, 6, '16 on the lot, 10 taken');
  const r = order(db, b, [{ barcode: SPICE, quantityCtn: 9 }]);
  assert.equal(db.prepare('SELECT clearance_cartons c FROM request_items WHERE request_id = ?').get(r.requestId).c, 6);
  assert.equal(clearanceOffersFor(db, customer(db, 'Third')).size, 0, 'nothing left on offer');
});

test('10. the credit check and the order value count the discounted cartons at the discounted price', () => {
  const db = freshDb(); stock(db); offerOn(db);
  const id = customer(db, 'Kofi Traders');
  const price = cartonPriceFor(SPICE, 'CLASS A (GHS)');
  const lines = [{ barcode: SPICE, quantityCtn: 20 }];
  const withOffer = estimateValue(db, id, lines);
  assert.equal(withOffer, Math.round((price * 4 + price * 16 * 0.8) * 100) / 100);
  removeLotDiscount(db, DiscountKind.CLEARANCE, SPICE_LOT, 'Manager');
  assert.equal(estimateValue(db, id, lines), Math.round(price * 20 * 100) / 100);
  // and the figure saved on the order uses what the request actually took
  offerOn(db);
  const r = order(db, id, lines);
  assert.equal(db.prepare('SELECT amount_open a FROM odoo_orders WHERE request_id = ?').get(r.requestId).a, withOffer);
});

test('11. the customer\'s own order list shows the discount on the cartons that carry it, and nothing else extra', async () => {
  const db = freshDb(); stock(db); offerOn(db);
  const id = customer(db, 'Kofi Traders');
  order(db, id, [{ barcode: SPICE, quantityCtn: 5 }, { barcode: CLOVE, quantityCtn: 1 }]);
  await withApp(db, async (base) => {
    const cookie = await signIn(base, db, id);
    const { orders } = await (await send(base, '/api/catalog/orders', 'GET', null, cookie)).json();
    const items = orders[0].items;
    assert.deepEqual(items[0], { name: `PRODUCT ${SPICE}`, cartons: 5, discountedCartons: 5, discountPct: 20, bestBefore: items[0].bestBefore });
    assert.deepEqual(items[1], { name: `PRODUCT ${CLOVE}`, cartons: 1 });
  });
});

test('12. the real route marks the clearance cartons and a visitor cannot order at a discount', async () => {
  const db = freshDb(); stock(db); offerOn(db);
  const id = customer(db, 'Kofi Traders');
  await withApp(db, async (base) => {
    assert.equal((await send(base, '/api/catalog/requests', 'POST', { lines: [{ barcode: SPICE, quantityCtn: 2 }] })).status, 401);
    const cookie = await signIn(base, db, id);
    const res = await send(base, '/api/catalog/requests', 'POST', { lines: [{ barcode: SPICE, quantityCtn: 2, clearanceCartons: 2, discountPct: 90 }] }, cookie);
    assert.equal(res.status, 201);
    const item = db.prepare('SELECT clearance_cartons c, clearance_pct p FROM request_items').get();
    assert.equal(item.c, 2);
    assert.equal(item.p, 20, 'the discount comes from the Sales Manager\'s record, never from the browser');
  });
});

// ===========================================================================
// the discount reaches Odoo on the right line
// ===========================================================================
test('13. the draft quotation in Odoo has the clearance cartons as their own line with the discount and the lot — still no price', async () => {
  const db = freshDb(); stock(db); offerOn(db);
  const odoo = new FakeOdoo(); await odoo.start();
  try {
    const partner = odoo.add('res.partner', { name: 'Kofi Traders' });
    odoo.add('product.product', { name: 'SPICE', barcode: SPICE });
    const id = customer(db, 'Kofi Traders', { odoo_customer_ref: String(partner.id) });
    const r = order(db, id, [{ barcode: SPICE, quantityCtn: 20 }]);
    const client = createOdooClient({ url: odoo.url, db: odoo.db, login: odoo.login, apiKey: odoo.apiKey, protocol: 'jsonrpc', timeoutMs: 500, maxPerSecond: 1000 });
    const out = await runOutbox(db, client, { now: new Date() });
    assert.equal(out.sent, 1);
    const so = odoo.created('sale.order')[0];
    assert.equal(so.state, 'draft');
    const lines = so.order_line.map((c) => c[2]);
    assert.deepEqual(lines.map((l) => [l.product_uom_qty, l.discount ?? null]), [[4, null], [16, 20]]);
    assert.match(lines[1].name, /lot SAMPLE-0018/);
    assert.ok(lines.every((l) => !('price_unit' in l)));
    assert.ok(r.reference);
  } finally { await odoo.stop(); }
});

// ===========================================================================
// the Sales Manager's discount for customers' shelves
// ===========================================================================
function firstShelfLot(db) {
  const lots = shelfLotDiscounts(db, { today: TODAY }).lots;
  assert.ok(lots.length > 0, 'the sample has lots on shelves waiting for a visit');
  return lots[0];
}
function repShopWith(db, lot) {
  // a rep and an open shelf alert holding this lot
  for (const rep of ['rep-1', 'rep-2']) {
    for (const c of myVisits(db, rep, { today: TODAY }).customers) {
      const sheet = visitSheet(db, rep, c.id, { today: TODAY });
      const hit = sheet.lots.find((l) => `${l.barcode}|${l.lotName}` === lot.key);
      if (hit) return { rep, customer: c.id, lot: hit };
    }
  }
  throw new Error('no shop holds that lot');
}

test('14. the Sales Manager lists the lots on customers\' shelves and puts a discount on one; the rep sees it on the visit', () => {
  const db = freshDb();
  const lot = firstShelfLot(db);
  assert.ok(lot.shops >= 1 && lot.cartons >= 1);
  // the manager sees WHICH shop holds the lot and which sales rep is responsible for it
  assert.equal(lot.holders.length, lot.shops);
  assert.ok(lot.holders.every((x) => x.customer && x.odooId && x.rep && x.cartons >= 1), 'each holder names its shop, its Odoo ID, its rep and its cartons');
  assert.equal(lot.holders.reduce((n, x) => n + x.cartons, 0), lot.cartons, 'and the cartons add up');
  assert.equal(saveShelfLotDiscount(db, lot.key, 15, 'Manager', { today: TODAY }).discountPct, 15);
  const at = repShopWith(db, lot);
  assert.equal(at.lot.managerDiscountPct, 15);
  assert.equal(saveShelfLotDiscount(db, lot.key, null, 'Manager', { today: TODAY }).discountPct, null);
  assert.equal(visitSheet(db, at.rep, at.customer, { today: TODAY }).lots.find((l) => l.key === at.lot.key).managerDiscountPct, null);
  assert.throws(() => saveShelfLotDiscount(db, 'nope|nope', 10, 'Manager', { today: TODAY }), /not on a customer shelf/);
  assert.throws(() => saveShelfLotDiscount(db, lot.key, 95, 'Manager', { today: TODAY }), LotDiscountError);
});

test('15. a rep who offers the Sales Manager\'s discount (or less) is approved at once; more than it waits for the Sales Manager', () => {
  const db = freshDb();
  const lot = firstShelfLot(db);
  saveShelfLotDiscount(db, lot.key, 20, 'Manager', { today: TODAY });
  const at = repShopWith(db, lot);
  const agree = (pct) => ({ key: at.lot.key, outcome: 'DISCOUNT_AGREED', cartonsOnShelf: 1, discountPct: pct, contactName: 'Ama Mensah', agreed: true });

  // nothing typed: the rep offers the manager's discount, approved now
  const a = recordVisit(db, at.rep, at.customer, [agree(null)], { today: TODAY });
  assert.equal(a.autoApproved, 1);
  let d = approvals(db, { today: TODAY });
  assert.equal(d.pending.length, 0);
  assert.equal(d.financeTasks.length, 1, 'Finance has the credit note to issue');
  assert.equal(d.financeTasks[0].discountPct, 20);
  assert.equal(d.financeTasks[0].preApproved, true);
});

test('16. above the Sales Manager\'s discount it is only a proposal; with no discount set it is only a proposal', () => {
  const db = freshDb();
  const lot = firstShelfLot(db);
  const at = repShopWith(db, lot);
  const agree = (pct) => ({ key: at.lot.key, outcome: 'DISCOUNT_AGREED', cartonsOnShelf: 1, discountPct: pct, contactName: 'Ama Mensah', agreed: true });
  // nothing typed and no discount from the manager: there is nothing to fall back on, and nothing is saved
  assert.throws(() => recordVisit(db, at.rep, at.customer, [agree(null)], { today: TODAY }), /percentage/);
  // a typed discount with none set by the manager: a proposal, as before
  assert.equal(recordVisit(db, at.rep, at.customer, [agree(30)], { today: TODAY }).autoApproved, 0);
  assert.equal(approvals(db, { today: TODAY }).pending.length, 1);
});

test('17. more than the Sales Manager\'s discount goes to the Sales Manager, and the screen says what was offered', () => {
  const db = freshDb();
  const lot = firstShelfLot(db);
  saveShelfLotDiscount(db, lot.key, 10, 'Manager', { today: TODAY });
  const at = repShopWith(db, lot);
  const r = recordVisit(db, at.rep, at.customer, [{ key: at.lot.key, outcome: 'DISCOUNT_AGREED', cartonsOnShelf: 1, discountPct: 25, contactName: 'Ama Mensah', agreed: true }], { today: TODAY });
  assert.equal(r.autoApproved, 0);
  const p = approvals(db, { today: TODAY }).pending[0];
  assert.equal(p.discountPct, 25);
  assert.equal(p.offeredPct, 10);
});

test('18. nothing here deletes a lot, a product or a customer; a discount is switched off, not removed', () => {
  const src = fs.readFileSync(new URL('../src/domain/lot-discounts.js', import.meta.url), 'utf8');
  assert.ok(!/DELETE FROM/i.test(src));
  const db = freshDb();
  offerOn(db);
  removeLotDiscount(db, DiscountKind.CLEARANCE, SPICE_LOT, 'Manager');
  const row = db.prepare('SELECT is_active a, ended_by e FROM lot_discounts WHERE kind = ? AND lot_key = ?').get('CLEARANCE', SPICE_LOT);
  assert.deepEqual({ ...row }, { a: 0, e: 'Manager' });
});

test('19. an offer never promises more cartons than the catalogue can supply right now', () => {
  const db = freshDb(); stock(db); offerOn(db);
  const id = customer(db, 'Kofi Traders');
  assert.equal(clearanceOffersFor(db, id).get(SPICE).cartons, 16);
  db.prepare('UPDATE products SET free_to_use = 3, on_hand = 3 WHERE barcode = ?').run(SPICE);
  assert.equal(clearanceOffersFor(db, id).get(SPICE).cartons, 3, 'the lot has 16, the catalogue can supply 3');
  db.prepare('UPDATE products SET free_to_use = 0, on_hand = 0 WHERE barcode = ?').run(SPICE);
  assert.equal(clearanceOffersFor(db, id).size, 0, 'nothing to supply, no offer');
});

test('20. everywhere a customer meets a discounted offer, it says the cartons are not returnable', () => {
  const read = (f) => fs.readFileSync(new URL(`../src/public/js/catalog/${f}`, import.meta.url), 'utf8');
  assert.match(read('offers.js'), /discounted cartons cannot be returned/, 'the offers section');
  assert.match(read('offers.js'), /Not returnable/, 'each offer card');
  assert.match(read('cards.js'), /Not returnable\./, 'the offer on the product card and page');
  assert.match(read('request.js'), /not returnable\)/, 'the request drawer line');
});
