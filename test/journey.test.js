// THE DEMO JOURNEY, end to end, on sample data (no Odoo): one customer's order travels through every part of
// the platform and ends up in the reports, and every figure along the way has to agree with the next.
//
//   people     Administrator -> Sales Manager -> Sales rep, Warehouse; a customer who signs in with ID + password
//   set up     the rep's customers, the credit limit, a hidden product, a payment schedule
//   warehouse  the Expiry list, the Sales Manager's discount on a near-expiry lot
//   customer   sees the offer, orders (a discounted line and an ordinary one), is blocked by the credit check once
//   "Odoo"     quotation sent -> approved -> delivered -> invoiced -> paid   (the Sample Odoo screen plays Odoo)
//   shelf      a rep visit on a customer's shelf with the Sales Manager's discount -> approved at once -> credit note
//   returns    goods come back, the warehouse gives the reason, Finance issues the credit note
//   reports    the CEO summary, the Sales Manager report, the Warehouse report and the rep's own month
//
// Each step checks what the NEXT screen shows, so a break between two parts shows up here, not in the demo.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { realAuth, startApp, Person, PW, ADMIN_USER, ADMIN_PASS, money, sum, sectionOf, find } from './journey-helpers.js';

const restore = realAuth();
after(restore);

const { createApp } = await import('../src/server/index.js');
const { issueAccessCode } = await import('../src/domain/access-codes.js');
const customerAuth = await import('../src/domain/customer-auth.js');
const staffAccounts = await import('../src/domain/staff-accounts.js');
const { cartonPriceFor } = await import('../src/domain/prices.js');
const { todayString } = await import('../src/domain/expiry-list.js');

const TODAY = todayString();
const MONTH = TODAY.slice(0, 7);
const SPICE = '5283001117266';           // sample lot SAMPLE-0018, ~25 days left: the discounted one
const SPICE_LOT = `${SPICE}|SAMPLE-0018`;
const CLOVE = '5283001109209';           // an ordinary product
const HIDDEN = '5283001117433';          // a product hidden from this customer
const CLASS = 'CLASS A (GHS)';

// ---- the one shared story: the tests below run in order and build on each other ----
const db = freshDb();
const ts = new Date().toISOString();
const insProduct = db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, on_hand, is_active, odoo_category_path, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?,?)');
insProduct.run(SPICE, 'ABIDO ALL SPICE GROUND 500G * 14', 'CTN14', 500, 500, 'FOOD / SPICES & SEASONINGS / GROUND SPICES', ts, ts);
insProduct.run(CLOVE, 'ABIDO CLOVE POWDER 50G * 10', 'CTN10', 500, 500, 'FOOD / SPICES & SEASONINGS / GROUND SPICES', ts, ts);
insProduct.run(HIDDEN, 'ABIDO BAY LEAVES 500G * 5', 'CTN5', 500, 500, 'FOOD / SPICES & SEASONINGS / WHOLE SPICES', ts, ts);
db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
const customerId = Number(db.prepare(`INSERT INTO customers (name, odoo_customer_ref, phone, customer_type, pricelist, is_active, created_at, updated_at)
  VALUES ('Kofi Mini Mart', '7001', '0244000111', 'CREDIT', ?, 1, ?, ?)`).run(CLASS, ts, ts).lastInsertRowid);
customerAuth.activateCustomer(db, '7001', issueAccessCode(db, customerId), PW);

const { server, base } = await startApp(createApp, db);
after(() => server.close());

const admin = new Person(base, 'Administrator');
const manager = new Person(base, 'Sales Manager');
const rep = new Person(base, 'Sales rep');
const warehouse = new Person(base, 'Warehouse');
const customer = new Person(base, 'Customer');
const visitor = new Person(base, 'Visitor');
const story = {};   // what one step hands to the next

test('1. the administrator signs in and creates the Sales Manager and the warehouse person; the manager creates the rep', async () => {
  await admin.staffLogin(ADMIN_USER, ADMIN_PASS);
  const m = await admin.ok('/api/team', { method: 'POST', body: { name: 'Hassan Manager', email: 'manager@bfl.test', role: 'SALES_MANAGER' } }, 201);
  const w = await admin.ok('/api/team', { method: 'POST', body: { name: 'Wanda Warehouse', email: 'warehouse@bfl.test', role: 'WAREHOUSE' } }, 201);
  // each chooses their own password the first time
  for (const [who, made, email] of [[manager, m, 'manager@bfl.test'], [warehouse, w, 'warehouse@bfl.test']]) {
    const first = await who.staffLogin(email, made.temporaryPassword);
    assert.equal(first.mustChangePassword, true);
    await who.ok('/api/auth/staff/password', { method: 'POST', body: { current: made.temporaryPassword, next: PW } });
    await who.staffLogin(email, PW);
  }
  // a Sales Manager may add reps (and only reps)
  const r = await manager.ok('/api/team', { method: 'POST', body: { name: 'Rita Rep', email: 'rep@bfl.test', role: 'SALES_REP' } }, 201);
  assert.match(r.user.repId, /^rep-u\d+$/, 'a new rep, with no customers yet');
  assert.equal((await manager.call('/api/team', { method: 'POST', body: { name: 'X', email: 'x@bfl.test', role: 'SALES_MANAGER' } })).status, 403, 'a manager cannot create another manager');
  await rep.staffLogin('rep@bfl.test', r.temporaryPassword);
  await rep.ok('/api/auth/staff/password', { method: 'POST', body: { current: r.temporaryPassword, next: PW } });
  const home = await rep.staffLogin('rep@bfl.test', PW);
  assert.equal(home.home, '/rep.html', 'a rep lands on the phone page');
  story.repId = r.user.repId;
});

test('2. the Sales Manager gives the customer to the rep; the rep sees that customer and nobody else\'s', async () => {
  await manager.ok('/api/reps/assign', { method: 'POST', body: { kind: 'BFL', id: customerId, repId: story.repId } });
  const mine = await rep.ok('/api/reports/my');
  assert.equal(mine.rep, 'Rita Rep');
  assert.equal(mine.customers, 1);
  // a rep cannot reach the manager's screens
  for (const p of ['/api/reps', '/api/team', '/api/sample-odoo', '/api/payments', '/api/visibility', '/api/shelf/approvals']) {
    assert.equal((await rep.call(p)).status, 403, `rep is refused ${p}`);
  }
});

test('3. the Sales Manager sets a credit limit and a payment schedule, and hides one product from this customer', async () => {
  await manager.ok(`/api/sample-odoo/customers/${customerId}/credit-limit`, { method: 'PUT', body: { limit: 20000 } });
  await manager.ok(`/api/payments/customers/${customerId}/schedule`, { method: 'PUT', body: { kind: 'DUE_DATE' } });
  await manager.ok('/api/visibility/rules', { method: 'POST', body: { scopeType: 'CUSTOMER', scopeValue: String(customerId), targetType: 'PRODUCT', targetValue: HIDDEN } }, 201);
});

test('4. the warehouse sees the near-expiry lots; only the Sales Manager can put a discount on one', async () => {
  const list = await warehouse.ok('/api/expiry');
  const row = list.rows.find((r) => r.key === SPICE_LOT);
  assert.ok(row && row.actionable, 'the all-spice lot is near expiry');
  const denied = await warehouse.call(`/api/expiry/lots/${encodeURIComponent(SPICE_LOT)}/discount`, { method: 'PUT', body: { pct: 20 } });
  assert.equal(denied.status, 403, 'the warehouse cannot set a customer discount');
  const set = await manager.ok(`/api/expiry/lots/${encodeURIComponent(SPICE_LOT)}/discount`, { method: 'PUT', body: { pct: 20 } });
  assert.equal(set.row.discountPct, 20);
  assert.equal((await warehouse.ok('/api/expiry')).rows.find((r) => r.key === SPICE_LOT).discountPct, 20, 'the warehouse can see it');
});

test('5. a visitor sees no price and no offer; the signed-in customer sees both, and not the hidden product', async () => {
  assert.equal((await visitor.call('/api/catalog/prices?barcodes=' + SPICE)).status, 401);
  assert.equal((await visitor.call('/api/catalog/offers')).status, 401);
  const publicList = await visitor.ok('/api/catalog/products?limit=50');
  assert.ok(publicList.items.some((p) => p.id === HIDDEN), 'a visitor is not under this customer\'s hide rule');
  assert.ok(!JSON.stringify(publicList).includes('price'), 'no price in the public list');

  await customer.customerLogin('7001', PW);
  const price = cartonPriceFor(SPICE, CLASS);
  const offers = await customer.ok('/api/catalog/offers');
  assert.equal(offers.offers.length, 1);
  assert.equal(offers.offers[0].discountedPrice, money(price * 0.8));
  const prices = await customer.ok(`/api/catalog/prices?barcodes=${SPICE},${CLOVE},${HIDDEN}`);
  assert.equal(prices.prices[SPICE], price);
  assert.equal(prices.prices[CLOVE], cartonPriceFor(CLOVE, CLASS));
  assert.equal(prices.prices[HIDDEN], undefined, 'a hidden product has no price for them either');
  const list = await customer.ok('/api/catalog/products?limit=50');
  assert.ok(!list.items.some((p) => p.id === HIDDEN), 'the hidden product is not in their catalogue');
  assert.equal((await customer.call('/api/catalog/requests', { method: 'POST', body: { lines: [{ barcode: HIDDEN, quantityCtn: 1 }] } })).status, 409, 'and cannot be ordered');
  story.price = price;
});

test('6. the customer orders 20 cartons of the discounted lot (16 on offer) and 2 of another; the order and quotation follow', async () => {
  const lines = [{ barcode: SPICE, quantityCtn: 20 }, { barcode: CLOVE, quantityCtn: 2 }];
  const res = await customer.ok('/api/catalog/requests', { method: 'POST', body: { lines } }, 201);
  assert.match(res.reference, /^REQ-\d{4}-\d{4}$/);
  story.ref = res.reference;
  story.expected = money(story.price * 4 + story.price * 16 * 0.8 + cartonPriceFor(CLOVE, CLASS) * 2);

  const orders = await customer.ok('/api/catalog/orders');
  assert.equal(orders.orders.length, 1);
  assert.equal(orders.orders[0].status, 'RECEIVED');
  const o = db.prepare('SELECT * FROM odoo_orders').get();
  assert.equal(o.amount_open, story.expected, 'the order is valued with the discount');
  story.orderId = o.id;
  const q = JSON.parse(db.prepare("SELECT payload FROM odoo_outbox WHERE dedupe_key = ?").get(`quotation:${story.ref}`).payload).values;
  assert.deepEqual(q.lines.map((l) => [l.barcode, l.cartons, l.discount ?? null]), [[SPICE, 4, null], [SPICE, 16, 20], [CLOVE, 2, null]]);
  assert.ok(!/price_unit|"price"/.test(JSON.stringify(q)), 'no price goes to Odoo');
  assert.equal(q.client_order_ref, story.ref);
  // the offer is used up by what was taken
  assert.equal((await customer.ok('/api/catalog/offers')).offers.length, 0, 'the 16 cartons are gone from the offer');
});

test('7. an order over the credit limit is refused, and the refusal is counted for the report', async () => {
  await manager.ok(`/api/sample-odoo/customers/${customerId}/credit-limit`, { method: 'PUT', body: { limit: story.expected + 50 } });
  const big = await customer.call('/api/catalog/requests', { method: 'POST', body: { lines: [{ barcode: CLOVE, quantityCtn: 100 }] } });
  assert.equal(big.status, 409);
  assert.match(JSON.stringify(big.json), /credit/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_check_log').get().n >= 1, true, 'logged');
  await manager.ok(`/api/sample-odoo/customers/${customerId}/credit-limit`, { method: 'PUT', body: { limit: 20000 } });
});

test('8. "Odoo": the quotation is sent, the Sales Manager approves it, the warehouse delivers it; the customer follows every step', async () => {
  const stepOf = async () => (await customer.ok('/api/catalog/orders')).orders[0];
  await manager.ok(`/api/sample-odoo/orders/${story.orderId}/send`, { method: 'POST', body: {} });
  let o = await stepOf();
  assert.equal(o.status, 'WAITING_FOR_APPROVAL');
  assert.match(o.odooNumber, /^S\d{5}$/, 'the customer is shown Odoo\'s number');
  await manager.ok(`/api/sample-odoo/orders/${story.orderId}/confirm`, { method: 'POST', body: {} });
  assert.equal((await stepOf()).status, 'APPROVED');
  await manager.ok(`/api/sample-odoo/orders/${story.orderId}/deliver`, { method: 'POST', body: {} });
  assert.equal((await stepOf()).status, 'DISPATCHED');
  story.odooNumber = o.odooNumber;
});

test('9. Finance invoices it: the invoice carries the clearance discount, and the customer\'s balance is the invoice', async () => {
  await manager.ok(`/api/sample-odoo/orders/${story.orderId}/invoice`, { method: 'POST', body: {} });
  const inv = db.prepare('SELECT * FROM odoo_invoices').get();
  assert.ok(Math.abs(inv.amount - story.expected) < 0.05, `the invoice (${inv.amount}) is the order value (${story.expected}), discount included`);
  const lines = db.prepare('SELECT barcode, cartons, amount, discount, lot_name FROM odoo_invoice_lines WHERE invoice_id = ? ORDER BY id').all(inv.id);
  assert.equal(money(sum(lines.map((l) => l.amount))), inv.amount, 'the lines add up to the invoice');
  const spice = lines.filter((l) => l.barcode === SPICE);
  assert.equal(sum(spice.map((l) => l.cartons)), 20);
  const disc = spice.find((l) => l.discount > 0);
  assert.equal(disc.cartons, 16);
  assert.equal(disc.discount, money(story.price * 16 * 0.2), 'the discount given, in GHS');
  assert.equal(disc.lot_name, 'SAMPLE-0018');
  story.invoice = inv;

  const account = await customer.ok('/api/catalog/account');
  assert.equal(account.amountOwed, inv.amount, 'My balance shows what they owe');
  assert.equal((await customer.ok('/api/catalog/orders')).orders[0].status, 'INVOICED');
});

test('10. payment reminders: on the day before the due date the customer\'s own open invoice is listed, and nobody else\'s', async () => {
  const due = story.invoice.due_date;
  const dayBefore = new Date(Date.parse(`${due}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const { runReminders } = await import('../src/domain/payments.js');
  runReminders(db, dayBefore, new Date(`${dayBefore}T08:00:00Z`));
  const rows = db.prepare('SELECT customer_id, kind, body, invoice_count, total_due FROM payment_reminders').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].customer_id, customerId);
  assert.equal(rows[0].kind, 'BEFORE');
  assert.equal(rows[0].invoice_count, 1);
  assert.equal(rows[0].total_due, story.invoice.amount);
  assert.ok(rows[0].body.includes(story.invoice.number), 'it names the invoice');
});

test('11. the customer pays: the balance clears and the order shows paid', async () => {
  await manager.ok(`/api/sample-odoo/orders/${story.orderId}/pay`, { method: 'POST', body: {} });
  assert.equal((await customer.ok('/api/catalog/orders')).orders[0].status, 'PAID');
  const acc = await customer.ok('/api/catalog/account');
  assert.equal(acc.amountOwed, 0);
  assert.equal(db.prepare('SELECT amount FROM odoo_payments').get().amount, story.invoice.amount);
});

test('12. stock too low: the customer is told, and the unmet demand is counted for the purchasing report', async () => {
  await manager.ok(`/api/sample-odoo/customers/${customerId}/credit-limit`, { method: 'PUT', body: { limit: 5_000_000 } });
  const r = await customer.call('/api/catalog/requests', { method: 'POST', body: { lines: [{ barcode: CLOVE, quantityCtn: 600 }] } });
  assert.equal(r.status, 409);
  assert.match(JSON.stringify(r.json), /no longer available|reduce/i);
  const logged = db.prepare("SELECT SUM(cartons_wanted) n FROM order_check_log WHERE kind = 'LOW_STOCK'").get();
  assert.ok(logged.n >= 600, 'the cartons the customer wanted are logged');
  await manager.ok(`/api/sample-odoo/customers/${customerId}/credit-limit`, { method: 'PUT', body: { limit: 20000 } });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 1, 'a refused request saves nothing');
});

test('13. on a customer\'s shelf: the Sales Manager gives a shop to the rep and puts a discount on a lot; the rep offers it; it is approved at once', async () => {
  await manager.ok('/api/reps/assign', { method: 'POST', body: { kind: 'SHOP', id: 4101, repId: story.repId } });
  // the manager lists the lots on shelves and discounts one of the shop's lots
  const { lots } = await manager.ok('/api/shelf/lot-discounts');
  const lot = lots.find((l) => l.key.endsWith('|SAMPLE-0004'));
  assert.ok(lot, 'the sample yoghurt lot is on a shelf waiting for a visit');
  await manager.ok(`/api/shelf/lot-discounts/${encodeURIComponent(lot.key)}`, { method: 'PUT', body: { pct: 25 } });
  assert.equal((await rep.call(`/api/shelf/lot-discounts`)).status, 403, 'the rep cannot set it');

  // the rep sees only their own shop, with the manager's discount on the form
  const visits = await rep.ok('/api/shelf/my-visits');
  assert.deepEqual(visits.customers.map((c) => c.id), [4101], 'the rep sees only the shop they were given');
  const sheet = await rep.ok('/api/shelf/visit-sheet?customer=4101');
  const form = sheet.lots.find((l) => l.key === `4101|${lot.key}|S00231` || l.lotName === 'SAMPLE-0004');
  assert.equal(form.managerDiscountPct, 25);
  assert.equal((await rep.call('/api/shelf/visit-sheet?customer=4102')).status, 403, 'another rep\'s shop is out of reach');

  // the customer's contact agrees to the manager's discount: nothing typed, approved straight away
  const saved = await rep.ok('/api/shelf/visits', { method: 'POST', body: { customer: 4101, lines: [{ key: form.key, outcome: 'DISCOUNT_AGREED', cartonsOnShelf: 3, contactName: 'Ama Mensah', agreed: true }] } }, 201);
  assert.equal(saved.autoApproved, 1);
  const appr = await manager.ok('/api/shelf/approvals');
  assert.equal(appr.pending.length, 0, 'nothing waits for the Sales Manager');
  assert.equal(appr.financeTasks.length, 1);
  assert.equal(appr.financeTasks[0].discountPct, 25);
  story.shelfLine = appr.financeTasks[0];

  // Finance issues the credit note in Odoo: the alert closes and the credit note is on record
  await manager.ok(`/api/shelf/approvals/${story.shelfLine.id}/credit-note`, { method: 'POST', body: { ref: 'CN/2026/9001' } });
  const cn = db.prepare("SELECT * FROM odoo_credit_notes WHERE number = 'CN/2026/9001'").get();
  assert.equal(cn.kind, 'DISCOUNT');
  assert.equal(cn.rep_name, 'Rita Rep', 'the credit note is on the rep who owns the shop');
  assert.ok(cn.amount > 0);
  story.shelfCredit = cn.amount;
  assert.equal((await manager.ok('/api/shelf/approvals')).financeTasks.length, 0);
});

test('14. goods come back: the warehouse receives the return, gives the reason, Finance issues the credit note', async () => {
  const opts = await manager.ok('/api/sample-odoo/return-options');
  const opt = opts.options.find((o) => o.id === `ORDER:${story.orderId}:${CLOVE}`);
  assert.ok(opt, 'the customer\'s delivered order can be returned');
  const ret = await manager.ok('/api/sample-odoo/returns', { method: 'POST', body: { optionId: opt.id, cartons: 1 } }, 201);
  // it waits for a reason; the warehouse (not the manager) gives it
  let list = await warehouse.ok('/api/returns');
  assert.equal((await manager.call(`/api/returns/${ret.id}/classify`, { method: 'POST', body: { reason: 'DAMAGED' } })).status, 403, 'the Sales Manager cannot classify');
  await warehouse.ok(`/api/returns/${ret.id}/classify`, { method: 'POST', body: { reason: 'DAMAGED', note: 'crushed in transit' } });
  await manager.ok(`/api/sample-odoo/returns/${ret.id}/credit-note`, { method: 'POST', body: {} });
  const cn = db.prepare('SELECT * FROM odoo_credit_notes WHERE return_id = ?').get(ret.id);
  assert.equal(cn.amount, cartonPriceFor(CLOVE, CLASS), 'one carton at the customer\'s price');
  story.returnCredit = cn.amount;
  list = await warehouse.ok('/api/returns');
  assert.ok(JSON.stringify(list).includes('DAMAGED') || JSON.stringify(list).includes('Damaged'));
});

// ---------------------------------------------------------------------------------------------
// the reports: every figure has to agree with the ledger the steps above built
// ---------------------------------------------------------------------------------------------
const report = (who, which) => who.ok(`/api/reports/report?report=${which}&month=${MONTH}`);
const measure = (r, key) => r.measures.find((m) => m.key === key).thisMonth;

test('15. the CEO summary agrees with the invoices, payments and credit notes', async () => {
  const ceo = await report(manager, 'CEO');
  const invoiced = db.prepare('SELECT SUM(amount) s FROM odoo_invoices').get().s;
  const credits = money(db.prepare('SELECT SUM(amount) s FROM odoo_credit_notes').get().s);
  assert.equal(credits, money(story.shelfCredit + story.returnCredit));
  assert.equal(measure(ceo, 'net_sales'), money(invoiced - credits), 'net sales = invoices minus credit notes');
  assert.equal(measure(ceo, 'collections'), story.invoice.amount, 'collections = the customer\'s payment');
  assert.equal(measure(ceo, 'active_customers'), 1);
  assert.equal(measure(ceo, 'money_owed'), 0, 'paid in full, so nothing owed');
  assert.equal(measure(ceo, 'fill_rate'), 100);
  const clearanceDiscount = money(story.price * 16 * 0.2);
  assert.equal(measure(ceo, 'expiry_loss'), money(clearanceDiscount + story.shelfCredit), 'expiry loss = the clearance discount + the shelf discount credit note (a damaged return is not an expiry loss)');
  assert.equal(measure(ceo, 'avg_order_value'), story.invoice.amount, 'one confirmed order');
});

test('16. the Sales Manager report: the rep, the customer, the products, the price class, the quotation, the credit block', async () => {
  const sales = await report(manager, 'SALES');
  const net = money(story.invoice.amount - story.shelfCredit - story.returnCredit);

  const byRep = find(sectionOf(sales, 'sales_by_rep'), (x) => x.rep === 'Rita Rep');
  assert.equal(byRep.netSales, net, 'her net sales: her customer\'s invoices less the credit notes on her customer and on her shop');
  assert.equal(byRep.active, 1);
  assert.equal(byRep.collections, story.invoice.amount);
  assert.equal(byRep.visits, 1, 'her shop visit is counted');

  const top = sectionOf(sales, 'top_customers').rows[0];
  assert.equal(top.customer, 'Kofi Mini Mart');
  assert.equal(top.rep, 'Rita Rep');

  const products = sectionOf(sales, 'products_top').rows;
  const spice = products.find((p) => p.barcode === SPICE);
  const clove = products.find((p) => p.barcode === CLOVE);
  assert.equal(spice.cartons, 20);
  assert.equal(clove.cartons, 2);
  assert.equal(money(spice.netSales + clove.netSales), story.invoice.amount, 'the products add up to the invoice');
  assert.equal(spice.netSales, money(story.price * 4 + story.price * 16 * 0.8), 'the spice at its discounted price');

  const pc = find(sectionOf(sales, 'price_classes'), (x) => x.class === CLASS);
  assert.equal(pc.customers, 1);
  assert.equal(pc.discounts, money(story.price * 16 * 0.2), 'discounts given on invoices');

  const quotes = Object.fromEntries(sectionOf(sales, 'quotations').rows.map((x) => [x.measure, x.value]));
  assert.equal(quotes.Created, 1);
  assert.equal(quotes.Approved, 1);

  const blocked = sectionOf(sales, 'credit_blocked').rows;
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].customer, 'Kofi Mini Mart');
  assert.equal(blocked[0].times, 1);

  const lost = sectionOf(sales, 'lost_demand').rows;
  assert.ok(lost.some((x) => x.product.includes('CLOVE')), 'the cloves we could not supply show as lost demand');

  const ret = sectionOf(sales, 'returns_reason').rows;
  assert.ok(ret.some((x) => /damaged/i.test(x.reason)), 'the damaged return is listed by its reason');
  assert.equal(net, money(measure(await report(manager, 'CEO'), 'net_sales')), 'and the headline figure is the same number');
});

test('17. the Warehouse report: stock, the discounted lot with what sold from it, the shelf visit, the return, fulfilment', async () => {
  const wh = await report(warehouse, 'WAREHOUSE');
  const lot = find(sectionOf(wh, 'clearance'), (x) => x.lot === 'SAMPLE-0018');
  assert.ok(lot, 'the lot the Sales Manager discounted is in the clearance results');
  assert.equal(lot.offer, 20, 'the Sales Manager\'s discount is still the one on record');
  assert.equal(lot.sold, 16, '16 cartons were invoiced at the discount');
  assert.equal(lot.discount, money(story.price * 16 * 0.2));

  const shelf = find(sectionOf(wh, 'customer_shelf'), (x) => x.rep === 'Rita Rep');
  assert.equal(shelf.visited, 1);
  assert.equal(shelf.discount, 1, 'the visit found a discount agreed');

  const received = sectionOf(wh, 'returns_received').rows;
  assert.ok(received.length >= 1 && JSON.stringify(received).includes('1'), 'the returned carton is counted by reason');

  const f = Object.fromEntries(sectionOf(wh, 'fulfilment').rows.map((x) => [x.measure, x.value]));
  assert.equal(f['Cartons ordered'], 22);
  assert.equal(f['Cartons delivered'], 22);
});

test('18. the rep sees her own month and nothing company-wide; the warehouse cannot read the sales report', async () => {
  const mine = await rep.ok('/api/reports/my');
  assert.equal(mine.customers, 1);
  assert.equal(mine.netSales, money(story.invoice.amount - story.shelfCredit - story.returnCredit), 'her own figure matches the Sales Manager report');
  assert.equal(mine.collections, story.invoice.amount);
  for (const which of ['CEO', 'SALES', 'WAREHOUSE']) assert.equal((await rep.call(`/api/reports/report?report=${which}&month=${MONTH}`)).status, 403, `a rep cannot read ${which}`);
  assert.equal((await warehouse.call(`/api/reports/report?report=SALES&month=${MONTH}`)).status, 403);
  assert.equal((await warehouse.call(`/api/reports/report?report=CEO&month=${MONTH}`)).status, 403);
  const csv = await manager.call(`/api/reports/csv?report=SALES&month=${MONTH}&section=top_customers`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /Kofi Mini Mart/);
});

test('19. the customer sees only their own story, and nothing that is the company\'s', async () => {
  const everything = JSON.stringify([
    await customer.ok('/api/catalog/orders'), await customer.ok('/api/catalog/account'), await customer.ok('/api/catalog/offers'),
    await customer.ok(`/api/catalog/prices?barcodes=${SPICE},${CLOVE}`),
  ]);
  for (const secret of ['Rita Rep', 'credit_limit', 'valueAtRisk', 'SAMPLE-0018', 'CN/2026/9001', 'rep-u', 'cost', 'Hassan Manager', 'warehouse@bfl.test']) {
    assert.ok(!everything.includes(secret), `the customer's payloads never contain "${secret}"`);
  }
  assert.equal((await customer.call('/api/reports/report?report=SALES')).status, 401, 'a customer has no way into the reports');
  assert.equal((await customer.call('/api/expiry')).status, 401);
});

test('20. a return of cartons bought on the clearance offer is flagged to the Sales Manager as a broken agreement', async () => {
  // 20 spice were ordered, 16 of them on the discount: the 4 ordinary cartons may come back without a flag
  const opt = (await manager.ok('/api/sample-odoo/return-options')).options.find((o) => o.id === `ORDER:${story.orderId}:${SPICE}`);
  assert.ok(opt, 'the delivered spice can be received back');
  const first = await manager.ok('/api/sample-odoo/returns', { method: 'POST', body: { optionId: opt.id, cartons: 4 } }, 201);
  let d = await warehouse.ok('/api/returns');
  assert.equal(d.brokenAgreements.length, 0, 'four cartons: the ordinary ones, nothing flagged');
  // one more carton can only be from the clearance cartons
  const second = await manager.ok('/api/sample-odoo/returns', { method: 'POST', body: { optionId: opt.id, cartons: 1 } }, 201);
  d = await manager.ok('/api/returns');
  assert.equal(d.brokenAgreements.length, 1, 'the fifth carton breaks "not returnable"');
  const b = d.brokenAgreements[0];
  assert.equal(b.id, second.id);
  assert.equal(b.brokenAgreement.kind, 'CLEARANCE');
  assert.equal(b.brokenAgreement.discountPct, 20);
  assert.equal(b.brokenAgreement.lot, 'SAMPLE-0018');
  assert.equal(b.customer, 'Kofi Mini Mart');
  assert.ok(!d.brokenAgreements.some((x) => x.id === first.id));
  // flagged as soon as it arrives, before the warehouse has given its reason
  assert.equal(b.reason, null);
  // and the earlier ordinary-product return is still not flagged
  assert.equal(d.classified.concat(d.unclassified).filter((r) => r.brokenAgreement).length, 1);
});
