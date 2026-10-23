// Product visibility rules (S02): hide by category, brand or product, for a customer, a price class or everyone.
//
// What is at risk, in order:
//   1. A hidden product still reaching the customer: in a list, a count, a page, an image, a price or an order.
//   2. A rule hiding more than it says (a brand matching a longer name, a product with no category vanishing).
//   3. A customer being able to tell that a rule exists.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';
import { searchCatalog, getCatalogProduct, catalogFacets, categoryFacets, resolveInternalId } from '../src/domain/catalog.js';
import { validateRequest } from '../src/domain/requests.js';
import { addRule, removeRule, listRules, listLog, preview, hiddenClause, visibleBarcodes, VisibilityError } from '../src/domain/visibility.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';

beforeEach(() => resetAccessAttempts());

const SPICE = '5283001117266';   // ABIDO ALL SPICE        FOOD / SPICES / GROUND
const CLOVE = '5283001109209';   // ABIDO CLOVE POWDER     FOOD / SPICES / GROUND
const COLA = '5281012013034';    // COLA 500ML             DRINKS / SOFT DRINKS
const NOCAT = '5290000000999';   // NOCAT THING            (no category)
const ABIDONIA = '5290000000888'; // ABIDONIA SNACK        FOOD / SNACKS

function seed(db) {
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  const ins = db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, odoo_category_path, is_active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)');
  ins.run(SPICE, 'ABIDO ALL SPICE', 'CTN12', 500, 'FOOD / SPICES / GROUND', ts, ts);
  ins.run(CLOVE, 'ABIDO CLOVE POWDER', 'CTN12', 500, 'FOOD / SPICES / GROUND', ts, ts);
  ins.run(COLA, 'COLA 500ML', 'CTN12', 500, 'DRINKS / SOFT DRINKS', ts, ts);
  ins.run(NOCAT, 'NOCAT THING', 'CTN12', 500, null, ts, ts);
  ins.run(ABIDONIA, 'ABIDONIA SNACK', 'CTN12', 500, 'FOOD / SNACKS', ts, ts);
  db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, odoo_category_path, is_active, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?)')
    .run('5290000000777', 'RETIRED ITEM', 'CTN12', 500, 'FOOD / SNACKS', ts, ts);
}
function customer(db, name, pricelist = 'CLASS A (GHS)') {
  const ts = new Date().toISOString();
  return Number(db.prepare('INSERT INTO customers (name, pricelist, customer_type, is_active, created_at, updated_at) VALUES (?,?,?,1,?,?)').run(name, pricelist, 'CREDIT', ts, ts).lastInsertRowid);
}
const names = (db, viewer, q = {}) => searchCatalog(db, { limit: 60, availableOnly: false, viewer, ...q }).items.map((i) => i.barcode).sort();
const ALL = [SPICE, CLOVE, COLA, NOCAT, ABIDONIA].sort();
const rule = (db, scopeType, scopeValue, targetType, targetValue) => addRule(db, { scopeType, scopeValue, targetType, targetValue }, 'Esi');

async function withApp(db, fn) {
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}
const call = (base, path, method = 'GET', body = null, cookie = null) => fetch(base + path, {
  method, headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined,
});
async function signIn(base, db, id) {
  const res = await call(base, '/api/catalog/access', 'POST', { code: issueAccessCode(db, id) });
  assert.equal(res.status, 200);
  return (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];
}

// ===========================================================================
// the rules themselves
// ===========================================================================
test('1. a rule is checked against what exists, so a typo cannot silently do nothing', () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co');
  const bad = (input, pattern) => assert.throws(() => addRule(db, input, 'Esi'), (e) => e instanceof VisibilityError && pattern.test(e.message), JSON.stringify(input));
  bad({}, /who this applies to/);
  bad({ scopeType: 'ALL' }, /what to hide/);
  bad({ scopeType: 'ALL', targetType: 'PRODUCT' }, /what to hide|Say what/);
  bad({ scopeType: 'PRICE_CLASS', scopeValue: 'CLASS Z', targetType: 'PRODUCT', targetValue: SPICE }, /price classes/);
  bad({ scopeType: 'CUSTOMER', scopeValue: 9999, targetType: 'PRODUCT', targetValue: SPICE }, /customer does not exist/);
  bad({ scopeType: 'ALL', targetType: 'PRODUCT', targetValue: '000' }, /product does not exist/);
  bad({ scopeType: 'ALL', targetType: 'CATEGORY', targetValue: 'NO / SUCH / PLACE' }, /No product is in that category/);
  bad({ scopeType: 'ALL', targetType: 'BRAND', targetValue: 'A' }, /two letters/);
  bad({ scopeType: 'ALL', targetType: 'BRAND', targetValue: 'ZZZZ' }, /No product name starts/);
  bad({ scopeType: 'ALL', targetType: 'BRAND', targetValue: '%' }, /two letters|No product name/);
  const first = rule(db, 'CUSTOMER', x, 'PRODUCT', SPICE);
  assert.equal(first.who, 'X Co');
  assert.equal(first.hides, 'ABIDO ALL SPICE');
  assert.throws(() => rule(db, 'CUSTOMER', x, 'PRODUCT', SPICE), (e) => e.status === 409 && e.code === 'DUPLICATE_RULE');
});

test('2. a category rule hides that category and what is under it; a product with no category stays', () => {
  const db = freshDb(); seed(db);
  rule(db, 'ALL', null, 'CATEGORY', 'FOOD / SPICES');
  assert.deepEqual(names(db, null), [COLA, NOCAT, ABIDONIA].sort(), 'both spices gone, the no-category product is still there');
  const db2 = freshDb(); seed(db2);
  rule(db2, 'ALL', null, 'CATEGORY', 'FOOD');
  assert.deepEqual(names(db2, null), [COLA, NOCAT].sort(), 'a top-level category hides everything under it');
  const db3 = freshDb(); seed(db3);
  assert.throws(() => rule(db3, 'ALL', null, 'CATEGORY', 'FOOD / SPICE'), /No product is in that category/, 'a partial name is not a category');
});

test('3. a brand rule matches whole words: ABIDO hides ABIDO products, not ABIDONIA', () => {
  const db = freshDb(); seed(db);
  rule(db, 'ALL', null, 'BRAND', 'abido');
  assert.deepEqual(names(db, null), [COLA, NOCAT, ABIDONIA].sort());
});

test('4. a product rule hides exactly that product', () => {
  const db = freshDb(); seed(db);
  rule(db, 'ALL', null, 'PRODUCT', COLA);
  assert.deepEqual(names(db, null), ALL.filter((b) => b !== COLA));
});

test('5. who a rule applies to: one customer, a price class, or everyone (visitors too)', () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co', 'CLASS A (GHS)');
  const y = customer(db, 'Y Co', 'CLASS B (GHS)');
  const z = customer(db, 'Z Co', 'CLASS A (GHS)');
  rule(db, 'CUSTOMER', x, 'PRODUCT', SPICE);
  assert.deepEqual(names(db, { customerId: x }), ALL.filter((b) => b !== SPICE));
  assert.deepEqual(names(db, { customerId: y }), ALL, 'another customer is unaffected');
  assert.deepEqual(names(db, null), ALL, 'a customer rule never touches a visitor');

  rule(db, 'PRICE_CLASS', 'CLASS A (GHS)', 'PRODUCT', COLA);
  assert.ok(!names(db, { customerId: x }).includes(COLA));
  assert.ok(!names(db, { customerId: z }).includes(COLA), 'the whole class');
  assert.ok(names(db, { customerId: y }).includes(COLA), 'not another class');
  assert.ok(names(db, null).includes(COLA));

  rule(db, 'ALL', null, 'PRODUCT', NOCAT);
  for (const v of [null, { customerId: x }, { customerId: y }, { customerId: z }]) assert.ok(!names(db, v).includes(NOCAT));
});

test('6. rules add up: a product hidden by any rule that applies is hidden', () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co');
  rule(db, 'CUSTOMER', x, 'PRODUCT', SPICE);
  rule(db, 'PRICE_CLASS', 'CLASS A (GHS)', 'CATEGORY', 'DRINKS');
  rule(db, 'ALL', null, 'BRAND', 'ABIDONIA');
  assert.deepEqual(names(db, { customerId: x }), [CLOVE, NOCAT].sort());
});

test('7. a retired (inactive) product stays out whatever the rules say; removing every rule changes nothing for it', () => {
  const db = freshDb(); seed(db);
  assert.ok(!names(db, null).includes('5290000000777'));
  assert.equal(hiddenClause(db, null), null, 'no rules, no clause');
});

test('8. removing a rule brings the product back, keeps the rule on record, and is logged', () => {
  const db = freshDb(); seed(db);
  const r = rule(db, 'ALL', null, 'PRODUCT', COLA);
  assert.ok(!names(db, null).includes(COLA));
  const gone = removeRule(db, r.id, 'Kwame');
  assert.equal(gone.active, false);
  assert.ok(names(db, null).includes(COLA));
  assert.equal(listRules(db).length, 1, 'kept, not deleted');
  assert.deepEqual(listLog(db).map((l) => [l.action, l.by]), [['REMOVED', 'Kwame'], ['ADDED', 'Esi']]);
  assert.match(listLog(db)[1].detail, /hide COLA 500ML/);
  assert.throws(() => removeRule(db, r.id), (e) => e.status === 409);
  assert.throws(() => removeRule(db, 9999), (e) => e.status === 404);
  // the same rule can be added again once it is off
  assert.doesNotThrow(() => rule(db, 'ALL', null, 'PRODUCT', COLA));
});

// ===========================================================================
// enforcement
// ===========================================================================
test('9. lists, product pages, images and counts all agree: hidden means gone everywhere', () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co');
  rule(db, 'CUSTOMER', x, 'CATEGORY', 'FOOD / SPICES');
  const v = { customerId: x };
  assert.equal(searchCatalog(db, { limit: 60, availableOnly: false, viewer: v }).total, 3);
  assert.equal(searchCatalog(db, { limit: 60, availableOnly: false, viewer: null }).total, 5);
  assert.equal(searchCatalog(db, { search: 'ABIDO', limit: 60, availableOnly: false, viewer: v }).items.map((i) => i.barcode).join(), ABIDONIA, 'search cannot find a hidden product');
  assert.equal(getCatalogProduct(db, SPICE, undefined, v), null);
  assert.ok(getCatalogProduct(db, SPICE, undefined, null));
  assert.equal(resolveInternalId(db, SPICE, v), null, 'its image too');
  assert.ok(resolveInternalId(db, SPICE, null));
  assert.equal(catalogFacets(db, undefined, v).all, 3);
  assert.equal(catalogFacets(db, undefined, null).all, 5);
  const tops = (viewer) => Object.fromEntries(categoryFacets(db, { view: 'full', viewer }).filter((c) => c.level === 1).map((c) => [c.name, c.count]));
  assert.deepEqual(tops(v), { FOOD: 1, 'DRINKS': 1 }, 'the chips count only what is shown: FOOD has just ABIDONIA left');
  assert.deepEqual(tops(null), { FOOD: 3, DRINKS: 1 });
  assert.equal(categoryFacets(db, { view: 'full', viewer: v }).some((c) => /SPICES/.test(c.path)), false, 'the category itself disappears');
});

test('10. over the web: the list, the page, the image, the chips and the price all hide it for that customer only', async () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co'); const y = customer(db, 'Y Co');
  rule(db, 'CUSTOMER', x, 'PRODUCT', SPICE);
  await withApp(db, async (base) => {
    const cx = await signIn(base, db, x);
    const cy = await signIn(base, db, y);
    const list = async (cookie) => (await (await call(base, '/api/catalog/products?view=full&limit=60', 'GET', null, cookie)).json());
    assert.ok(!(await list(cx)).items.some((i) => i.id === SPICE));
    assert.ok((await list(cy)).items.some((i) => i.id === SPICE));
    assert.ok((await list(null)).items.some((i) => i.id === SPICE));
    assert.equal((await call(base, `/api/catalog/products/${SPICE}`, 'GET', null, cx)).status, 404);
    assert.equal((await call(base, `/api/catalog/products/${SPICE}`, 'GET', null, cy)).status, 200);
    assert.equal((await call(base, `/api/catalog/products/${SPICE}/image`, 'GET', null, cx)).status, 404);
    const facets = await (await call(base, '/api/catalog/facets', 'GET', null, cx)).json();
    assert.equal(facets.all, 4);
    const p = await (await call(base, `/api/catalog/prices?barcodes=${SPICE},${CLOVE}`, 'GET', null, cx)).json();
    assert.ok(!(SPICE in p.prices) && CLOVE in p.prices, 'no price for what they cannot see');
    const py = await (await call(base, `/api/catalog/prices?barcodes=${SPICE}`, 'GET', null, cy)).json();
    assert.ok(SPICE in py.prices);
    const res = await call(base, '/api/catalog/products?view=full', 'GET', null, cx);
    assert.match(res.headers.get('vary') || '', /Cookie/i, 'the answer depends on who asks, so a cache must not share it');
  });
});

test('11. a hidden product cannot be ordered, even from an old cart; the same product is orderable by others', async () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co'); const y = customer(db, 'Y Co');
  rule(db, 'CUSTOMER', x, 'PRODUCT', SPICE);
  const verdict = (id) => validateRequest(db, [{ barcode: SPICE, quantityCtn: 1 }, { barcode: CLOVE, quantityCtn: 1 }], { viewer: { customerId: id } });
  const vx = verdict(x);
  assert.equal(vx.ok, false);
  assert.deepEqual(vx.errors.map((e) => [e.barcode, e.code]), [[SPICE, 'PRODUCT_UNAVAILABLE']]);
  assert.equal(verdict(y).ok, true);
  await withApp(db, async (base) => {
    const cx = await signIn(base, db, x);
    const res = await call(base, '/api/catalog/requests', 'POST', { lines: [{ barcode: SPICE, quantityCtn: 1 }] }, cx);
    assert.equal(res.status, 409);
    assert.equal((await res.json()).errors[0].code, 'PRODUCT_UNAVAILABLE');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0, 'nothing saved');
    // the dry-run route judges the signed-in customer the same way
    const dry = await (await call(base, '/api/catalog/requests/validate', 'POST', { lines: [{ barcode: SPICE, quantityCtn: 1 }] }, cx)).json();
    assert.equal(dry.ok, false);
    const ok = await call(base, '/api/catalog/requests', 'POST', { lines: [{ barcode: CLOVE, quantityCtn: 1 }] }, cx);
    assert.equal(ok.status, 201);
  });
});

test('12. a customer cannot tell a rule exists: hidden and non-existent look the same', async () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co');
  rule(db, 'CUSTOMER', x, 'PRODUCT', SPICE);
  await withApp(db, async (base) => {
    const cx = await signIn(base, db, x);
    const hidden = await call(base, `/api/catalog/products/${SPICE}`, 'GET', null, cx);
    const missing = await call(base, '/api/catalog/products/0000000000000', 'GET', null, cx);
    assert.equal(hidden.status, missing.status);
    assert.deepEqual(await hidden.json(), await missing.json());
    const text = JSON.stringify(await (await call(base, '/api/catalog/products?view=full&limit=60', 'GET', null, cx)).json());
    assert.ok(!/hidden|visibility|rule/i.test(text));
  });
});

// ===========================================================================
// the manager's preview and routes
// ===========================================================================
test('13. the preview is the enforcement: same counts, and it names what is hidden', () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co');
  rule(db, 'CUSTOMER', x, 'CATEGORY', 'FOOD / SPICES');
  rule(db, 'PRICE_CLASS', 'CLASS A (GHS)', 'PRODUCT', COLA);
  const p = preview(db, { customerId: x });
  assert.equal(p.total, 5);
  assert.equal(p.hidden, 3);
  assert.equal(p.visible, searchCatalog(db, { limit: 60, availableOnly: false, viewer: { customerId: x } }).total);
  assert.deepEqual(p.hiddenSample.map((h) => h.barcode).sort(), [SPICE, CLOVE, COLA].sort());
  assert.deepEqual(preview(db, null), { total: 5, visible: 5, hidden: 0, hiddenSample: [] }, 'a visitor sees all of it');
  assert.deepEqual([...visibleBarcodes(db, { customerId: x }, [SPICE, CLOVE, COLA, NOCAT, 'nope'])], [NOCAT], 'only what is visible, and nothing that does not exist');
});

test('14. the staff API adds, lists, previews and removes rules', async () => {
  const db = freshDb(); seed(db);
  const x = customer(db, 'X Co');
  await withApp(db, async (base) => {
    const bad = await call(base, '/api/visibility/rules', 'POST', { scopeType: 'ALL', targetType: 'BRAND', targetValue: 'ZZZZ' });
    assert.equal(bad.status, 404);
    const made = await call(base, '/api/visibility/rules', 'POST', { scopeType: 'CUSTOMER', scopeValue: x, targetType: 'CATEGORY', targetValue: 'FOOD / SPICES' });
    assert.equal(made.status, 201);
    const { rule: r } = await made.json();
    assert.equal(r.who, 'X Co');
    assert.equal((await call(base, '/api/visibility/rules', 'POST', { scopeType: 'CUSTOMER', scopeValue: x, targetType: 'CATEGORY', targetValue: 'FOOD / SPICES' })).status, 409);
    const view = await (await call(base, '/api/visibility')).json();
    assert.equal(view.rules.length, 1);
    assert.ok(view.priceClasses.includes('CLASS A (GHS)'));
    assert.ok(view.categories.some((c) => c.path === 'FOOD / SPICES / GROUND'));
    assert.equal(view.log[0].action, 'ADDED');
    const pv = await (await call(base, `/api/visibility/preview?customer=${x}`)).json();
    assert.equal(pv.hidden, 2);
    assert.equal((await (await call(base, '/api/visibility/preview')).json()).hidden, 0, 'no customer = a visitor');
    assert.equal((await call(base, `/api/visibility/rules/${r.id}/remove`, 'POST', {})).status, 200);
    assert.equal((await call(base, `/api/visibility/rules/${r.id}/remove`, 'POST', {})).status, 409);
    assert.equal((await (await call(base, `/api/visibility/preview?customer=${x}`)).json()).hidden, 0);
  });
});

test('15. the visibility API is staff-only', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const db = freshDb(); seed(db);
    await withApp(db, async (base) => {
      for (const [method, url] of [['GET', '/api/visibility'], ['POST', '/api/visibility/rules'], ['POST', '/api/visibility/rules/1/remove'], ['GET', '/api/visibility/preview']]) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
        assert.ok([401, 403, 503].includes(res.status), `${method} ${url} -> ${res.status}`);
      }
    });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM visibility_rules').get().n, 0);
  } finally { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; }
});

test('16. nothing here deletes a rule or a product, and nothing reads cost data', () => {
  for (const f of ['src/domain/visibility.js', 'src/server/routes/visibility.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/\bDELETE\s+FROM\b/i.test(src), `${f} must not delete rows`);
    assert.ok(!/standard_price|cost_price|\bcost\b|valuation|purchase|supplier_price/i.test(src), f);
  }
});
