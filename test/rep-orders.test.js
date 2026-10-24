// A sales rep placing an order for one of their own customers (sample data, real sign-in).
//
// The order is the customer's own: the same checks, the same draft quotation for Odoo, with a note saying which rep placed it.
// Who may order for whom is decided on the server: the rep comes from the session, and the customer must be on that rep's list.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { realAuth, startApp, Person, PW, ADMIN_USER, ADMIN_PASS, money } from './journey-helpers.js';

const restore = realAuth();
after(restore);

const { createApp } = await import('../src/server/index.js');
const { issueAccessCode } = await import('../src/domain/access-codes.js');
const customerAuth = await import('../src/domain/customer-auth.js');
const staffAccounts = await import('../src/domain/staff-accounts.js');
const { setCreditLimit } = await import('../src/domain/sample-odoo.js');
const { assignCustomer } = await import('../src/domain/reps.js');
const { cartonPriceFor } = await import('../src/domain/prices.js');

const SPICE = '5283001117266';           // sample lot SAMPLE-0018: the discounted one
const SPICE_LOT = `${SPICE}|SAMPLE-0018`;
const CLOVE = '5283001109209';           // an ordinary product
const CORIANDER = '5283001117303';      // one lot with ~85 days left: below a 90-day minimum
const HIDDEN = '5283001117433';          // hidden from the first customer
const CLASS = 'CLASS A (GHS)';

const db = freshDb();
const ts = new Date().toISOString();
const insProduct = db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, on_hand, is_active, odoo_category_path, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)');
insProduct.run(SPICE, 'ABIDO ALL SPICE GROUND 500G * 14', 'CTN14', 500, 500, 'FOOD / SPICES & SEASONINGS / GROUND SPICES', ts, ts);
insProduct.run(CLOVE, 'ABIDO CLOVE POWDER 50G * 10', 'CTN10', 500, 500, 'FOOD / SPICES & SEASONINGS / GROUND SPICES', ts, ts);
insProduct.run(CORIANDER, 'ABIDO CORIANDER POWDER 50G * 10', 'CTN10', 500, 500, 'FOOD / SPICES & SEASONINGS / GROUND SPICES', ts, ts);
insProduct.run(HIDDEN, 'ABIDO BAY LEAVES 500G * 5', 'CTN5', 500, 500, 'FOOD / SPICES & SEASONINGS / WHOLE SPICES', ts, ts);
db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
const addCustomer = (name, ref) => Number(db.prepare(`INSERT INTO customers (name, odoo_customer_ref, phone, customer_type, pricelist, is_active, created_at, updated_at)
  VALUES (?, ?, '0244000111', 'CREDIT', ?, 1, ?, ?)`).run(name, ref, CLASS, ts, ts).lastInsertRowid);
const mine = addCustomer('Kofi Mini Mart', '7001');
const theirs = addCustomer('Ama Provisions', '7002');   // another rep's customer
customerAuth.activateCustomer(db, '7001', issueAccessCode(db, mine), PW);
setCreditLimit(db, mine, 20000);
setCreditLimit(db, theirs, 20000);

// two reps, each with one customer; a Sales Manager
const makeStaff = (name, email, role) => {
  const made = staffAccounts.createStaffUser(db, { name, email, role }, 'ADMIN', 'Test');
  staffAccounts.changeStaffPassword(db, made.user.id, made.temporaryPassword, PW);
  return made.user;
};
const rita = makeStaff('Rita Rep', 'rita@bfl.test', 'SALES_REP');
const other = makeStaff('Otis Rep', 'otis@bfl.test', 'SALES_REP');
makeStaff('Hassan Manager', 'manager@bfl.test', 'SALES_MANAGER');
assignCustomer(db, { kind: 'BFL', id: mine, repId: rita.repId }, 'Test');
assignCustomer(db, { kind: 'BFL', id: theirs, repId: other.repId }, 'Test');
db.prepare("INSERT INTO visibility_rules (scope_type, scope_value, target_type, target_value, created_at) VALUES ('CUSTOMER', ?, 'PRODUCT', ?, ?)").run(String(mine), HIDDEN, ts);

const { server, base } = await startApp(createApp, db);
after(() => server.close());
const admin = new Person(base, 'Administrator');
const rep = new Person(base, 'Rita (rep)');
const otherRep = new Person(base, 'Otis (rep)');
const manager = new Person(base, 'Sales Manager');
const customer = new Person(base, 'Customer');
const story = {};

test('1. a rep sees only their own customers, and other roles cannot use the rep order screens', async () => {
  await rep.staffLogin('rita@bfl.test', PW);
  const list = await rep.ok('/api/rep-orders/customers');
  assert.deepEqual(list.customers.map((c) => c.name), ['Kofi Mini Mart']);
  assert.equal((await rep.ok('/api/rep-orders/customers?q=7001')).customers.length, 1);
  assert.equal((await rep.ok('/api/rep-orders/customers?q=Ama')).customers.length, 0, "another rep's customer is not found, even by name");
  await otherRep.staffLogin('otis@bfl.test', PW);
  assert.deepEqual((await otherRep.ok('/api/rep-orders/customers')).customers.map((c) => c.name), ['Ama Provisions']);
  await manager.staffLogin('manager@bfl.test', PW);
  assert.equal((await manager.call('/api/rep-orders/customers')).status, 403);
  await admin.staffLogin(ADMIN_USER, ADMIN_PASS);
  assert.equal((await admin.call('/api/rep-orders/customers')).status, 403);
  assert.equal((await new Person(base, 'Nobody').call('/api/rep-orders/customers')).status, 401);
});

test("2. the rep sees the customer's products as the customer sees them, with the customer's own prices", async () => {
  const page = await rep.ok(`/api/rep-orders/products?customer=${mine}&limit=50`);
  assert.equal(page.currency, 'GHS');
  const clove = page.items.find((p) => p.barcode === CLOVE);
  assert.equal(clove.price, cartonPriceFor(CLOVE, CLASS));
  assert.ok(!page.items.some((p) => p.barcode === HIDDEN), 'a product hidden from this customer is hidden from the rep ordering for them');
  const found = await rep.ok(`/api/rep-orders/products?customer=${mine}&search=clove`);
  assert.deepEqual(found.items.map((p) => p.barcode), [CLOVE]);
  assert.ok(!JSON.stringify(page).match(/cost|on_hand|free_to_use/i), 'no cost or stock figure');
  assert.equal((await rep.call(`/api/rep-orders/products?customer=${theirs}`)).status, 404, "another rep's customer cannot be browsed");
});

test('3. the Sales Manager puts a discount on a near-expiry lot; the rep sees the offer for that customer', async () => {
  await manager.ok(`/api/expiry/lots/${encodeURIComponent(SPICE_LOT)}/discount`, { method: 'PUT', body: { pct: 20 } });
  const spice = (await rep.ok(`/api/rep-orders/products?customer=${mine}&search=spice`)).items.find((p) => p.barcode === SPICE);
  assert.equal(spice.offer.discountPct, 20);
  assert.equal(spice.offer.discountedPrice, money(cartonPriceFor(SPICE, CLASS) * 0.8));
});

test('4. the review says what the order comes to and whether it would go over credit; it writes nothing', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM requests').get().n;
  const r = await rep.ok('/api/rep-orders/review', { method: 'POST', body: { customer: mine, lines: [{ barcode: CLOVE, quantityCtn: 2 }] } });
  assert.equal(r.estimate, money(cartonPriceFor(CLOVE, CLASS) * 2));
  assert.equal(r.credit.ok, true);
  assert.deepEqual(r.errors, []);
  const hidden = await rep.ok('/api/rep-orders/review', { method: 'POST', body: { customer: mine, lines: [{ barcode: HIDDEN, quantityCtn: 1 }] } });
  assert.ok(hidden.errors.length, 'a hidden product is refused like an unknown one');
  assert.equal((await rep.call('/api/rep-orders/review', { method: 'POST', body: { customer: theirs, lines: [{ barcode: CLOVE, quantityCtn: 1 }] } })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, before);
});

test('5. the rep places the order for the customer: same order, same quotation, with a note naming the rep', async () => {
  const lines = [{ barcode: SPICE, quantityCtn: 20 }, { barcode: CLOVE, quantityCtn: 2 }];
  const res = await rep.ok('/api/rep-orders', { method: 'POST', body: { customer: mine, lines } }, 201);
  assert.match(res.reference, /^REQ-\d{4}-\d{4}$/);
  story.ref = res.reference;
  const price = cartonPriceFor(SPICE, CLASS);

  const req = db.prepare('SELECT * FROM requests WHERE reference = ?').get(res.reference);
  assert.equal(req.customer_id, mine, 'the order is the CUSTOMER\'s');
  assert.equal(req.placed_by_rep, 'Rita Rep');
  assert.equal(req.placed_by_staff_id, rita.id);

  const o = db.prepare('SELECT * FROM odoo_orders WHERE request_id = ?').get(req.id);
  assert.equal(o.customer_id, mine);
  assert.equal(o.amount_open, money(price * 4 + price * 16 * 0.8 + cartonPriceFor(CLOVE, CLASS) * 2), 'valued with the clearance discount, like a customer order');
  const q = JSON.parse(db.prepare('SELECT payload FROM odoo_outbox WHERE dedupe_key = ?').get(`quotation:${res.reference}`).payload).values;
  assert.deepEqual(q.lines.map((l) => [l.barcode, l.cartons, l.discount ?? null]), [[SPICE, 4, null], [SPICE, 16, 20], [CLOVE, 2, null]]);
  assert.match(q.note, /Placed by sales rep Rita Rep\./);
  assert.ok(!/price_unit|"price"/.test(JSON.stringify(q)), 'no price goes to Odoo');
});

test('6. the customer sees the order in their own list; the rep sees what they placed; nobody else does', async () => {
  await customer.customerLogin('7001', PW);
  const orders = (await customer.ok('/api/catalog/orders')).orders;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].reference, story.ref);
  const placed = (await rep.ok('/api/rep-orders/mine')).orders;
  assert.deepEqual(placed.map((o) => [o.reference, o.customer, o.cartons, o.status]), [[story.ref, 'Kofi Mini Mart', 22, 'Received']]);
  assert.deepEqual((await otherRep.ok('/api/rep-orders/mine')).orders, [], "another rep does not see Rita's orders");
});

test("7. a rep cannot order for another rep's customer, or name a customer who does not exist", async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM requests').get().n;
  for (const customerId of [theirs, 99999, 'abc', null]) {
    const r = await rep.call('/api/rep-orders', { method: 'POST', body: { customer: customerId, lines: [{ barcode: CLOVE, quantityCtn: 1 }] } });
    assert.equal(r.status, 404, `customer ${customerId}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, before, 'nothing was written');
});

test('8. a customer taken off the rep can no longer be ordered for', async () => {
  assignCustomer(db, { kind: 'BFL', id: mine, repId: other.repId }, 'Test');
  assert.equal((await rep.call('/api/rep-orders', { method: 'POST', body: { customer: mine, lines: [{ barcode: CLOVE, quantityCtn: 1 }] } })).status, 404);
  assignCustomer(db, { kind: 'BFL', id: mine, repId: rita.repId }, 'Test');
});

test('9. an order over the credit limit is refused for the rep too, and the refusal is counted', async () => {
  setCreditLimit(db, mine, 500);
  const before = db.prepare('SELECT COUNT(*) n FROM requests').get().n;
  const big = await rep.call('/api/rep-orders', { method: 'POST', body: { customer: mine, lines: [{ barcode: CLOVE, quantityCtn: 100 }] } });
  assert.equal(big.status, 409);
  assert.match(JSON.stringify(big.json), /credit/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, before, 'no order');
  assert.ok(db.prepare('SELECT COUNT(*) n FROM order_check_log').get().n >= 1, 'logged for the report');
  const r = await rep.ok('/api/rep-orders/review', { method: 'POST', body: { customer: mine, lines: [{ barcode: CLOVE, quantityCtn: 100 }] } });
  assert.equal(r.credit.ok, false, 'the review warns before the rep tries');
});

test('10. a minimum shelf life the customer set applies to the rep\'s order: the rep must have the customer accept shorter-dated stock', async () => {
  setCreditLimit(db, mine, 20000);
  db.prepare('UPDATE customers SET min_shelf_life_days = 90 WHERE id = ?').run(mine);
  const lines = [{ barcode: CORIANDER, quantityCtn: 2 }];
  const review = await rep.ok('/api/rep-orders/review', { method: 'POST', body: { customer: mine, lines } });
  assert.equal(review.shelf.warnings.length, 1, 'the review names the line');
  const refused = await rep.call('/api/rep-orders', { method: 'POST', body: { customer: mine, lines } });
  assert.equal(refused.status, 409);
  const ok = await rep.ok('/api/rep-orders', { method: 'POST', body: { customer: mine, lines, acceptedShortDated: [CORIANDER] } }, 201);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM request_shelf_acceptances WHERE customer_id = ?').get(mine).n, 1, 'the acceptance is recorded for the customer');
  assert.ok(ok.reference);
});
