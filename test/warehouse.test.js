// The Warehouse Manager's dashboard (domain/warehouse.js, /api/warehouse): every figure comes from records BFL holds,
// nothing is invented, and only the warehouse, the administrator and (read-only) the Sales Manager may see it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshDb, runImport, row } from './helpers.js';
import { realAuth, startApp, Person, PW } from './journey-helpers.js';

const restore = realAuth();
after(restore);

const { createApp } = await import('../src/server/index.js');
const staffAccounts = await import('../src/domain/staff-accounts.js');
const wh = await import('../src/domain/warehouse.js');
const { todayString } = await import('../src/domain/expiry-list.js');

const TODAY = '2026-10-21';            // a Wednesday
const CHEESE = '8593803314051';        // sample lot SAMPLE-0001: expired, MAIN
const FETA = 'ALMRFCHMNT112';          // sample lot SAMPLE-0003: 9 days left (critical)

/** Three products: one in stock with lots, one low, one out; two categories. */
function stocked() {
  const db = freshDb();
  runImport(db, [
    row({ barcode: CHEESE, name: 'AL NAKA AKAWI CHEESE TIN 17KG * 1', uom: 'CTN1', on_hand: 40, free: 40, incoming: 10 }),
    row({ barcode: FETA, name: 'AL AMIR FETA CHEESE WITH MINT 10KG * 1 [FETA-M]', uom: 'CTN1', on_hand: 3, free: 3 }),
    row({ barcode: '6001000000017', name: 'OMO HAND WASH POWDER 500G * 24', uom: 'CTN24', on_hand: 0, free: 0, incoming: 5 }),
  ]);
  const setCat = db.prepare('UPDATE products SET odoo_category_path = ? WHERE barcode = ?');
  setCat.run('FOOD / DAIRY / CHEESE', CHEESE);
  setCat.run('FOOD / DAIRY / CHEESE', FETA);
  setCat.run('NON FOOD / DETERGENTS', '6001000000017');
  return db;
}

// The app with real sign-in starts before any test is declared, so the test-runner bypass stays off for all of them.
const appDb = stocked();
const makeStaff = (name, email, role) => {
  const made = staffAccounts.createStaffUser(appDb, { name, email, role }, 'ADMIN', 'Test');
  staffAccounts.changeStaffPassword(appDb, made.user.id, made.temporaryPassword, PW);
};
makeStaff('Wendy Warehouse', 'wh@bfl.test', 'WAREHOUSE');
makeStaff('Sam Manager', 'sm@bfl.test', 'SALES_MANAGER');
makeStaff('Rita Rep', 'rep@bfl.test', 'SALES_REP');
const { server, base } = await startApp(createApp, appDb);
after(() => server.close());

// ===========================================================================
// periods
// ===========================================================================
test('1. each period covers the right calendar days; a week starts on Monday', () => {
  const r = (p, x) => wh.periodRange(p, x, TODAY);
  assert.deepEqual([r('today').start, r('today').end], ['2026-10-21', '2026-10-21']);
  assert.deepEqual([r('week').start, r('week').end], ['2026-10-19', '2026-10-21']);
  assert.deepEqual([r('month').start, r('month').end], ['2026-10-01', '2026-10-21']);
  assert.deepEqual([r('last_month').start, r('last_month').end], ['2026-09-01', '2026-09-30']);
  assert.deepEqual([r('year').start, r('year').end], ['2026-01-01', '2026-10-21']);
  assert.deepEqual([wh.periodRange('last_month', {}, '2026-01-15').start, wh.periodRange('last_month', {}, '2026-01-15').end], ['2025-12-01', '2025-12-31']);
  assert.equal(r('nonsense').period, 'week', 'an unknown period falls back to this week');
  assert.deepEqual([r('custom', { from: '2026-09-02', to: '2026-09-05' }).start, r('custom', { from: '2026-09-02', to: '2026-09-05' }).end], ['2026-09-02', '2026-09-05']);
});

test('2. a custom range must be complete, in order and at most 400 days', () => {
  const bad = (x) => assert.throws(() => wh.periodRange('custom', x, TODAY), wh.WarehouseError);
  bad({ from: '2026-09-05' });
  bad({ from: '2026-09-05', to: '2026-09-01' });
  bad({ from: '2024-01-01', to: '2026-01-01' });
});

// ===========================================================================
// KPIs and expiry (lot level)
// ===========================================================================
test('3. the KPI counts come straight from the products table and the lots', () => {
  const s = wh.dashboardSummary(stocked(), { period: 'week' }, TODAY);
  assert.equal(s.kpis.totalProducts, 3);
  assert.equal(s.kpis.lowStock, 1, 'FETA: 3 cartons is at or below the low-stock line of 5');
  assert.equal(s.kpis.outOfStock, 1);
  // the 31 sample lots: 3 expired, 7 critical + 5 warning, 5 early + 10 ok, 1 with no date
  assert.deepEqual([s.expiry.EXPIRED, s.expiry.SOON, s.expiry.IN_DATE, s.expiry.NO_DATE, s.expiry.total], [3, 12, 15, 1, 31]);
  assert.equal(s.kpis.expiringSoon, 12, 'expiring soon = lots in the warning period, counted per lot');
  assert.equal(s.expiry.source, 'SAMPLE', 'sample lots are labelled as sample');
});

test('4. an empty warehouse shows zeros, never made-up numbers', () => {
  const s = wh.dashboardSummary(freshDb(), { period: 'month' }, TODAY);
  assert.deepEqual([s.kpis.totalProducts, s.kpis.lowStock, s.kpis.outOfStock, s.kpis.recentMovements], [0, 0, 0, 0]);
  assert.deepEqual(s.movements.latest, []);
  assert.deepEqual(s.stockLevels.groups, []);
});

// ===========================================================================
// inventory
// ===========================================================================
test('5. inventory rows carry stock status, SKU, lot locations and the next (unexpired) expiry date', () => {
  const page = wh.inventoryPage(stocked(), {}, TODAY);
  assert.equal(page.total, 3);
  const feta = page.items.find((p) => p.barcode === FETA);
  assert.equal(feta.status, 'LOW_STOCK');
  assert.equal(feta.sku, 'FETA-M', 'the code Odoo prints at the end of the name');
  assert.equal(feta.expiringSoon, true);
  assert.deepEqual(feta.locations, ['MAIN']);
  assert.equal(feta.nextExpiry, '2026-10-30');
  const cheese = page.items.find((p) => p.barcode === CHEESE);
  assert.equal(cheese.hasExpiredLot, true);
  assert.equal(cheese.nextExpiry, null, 'an expired lot is not "the next expiry"');
  const omo = page.items.find((p) => p.barcode === '6001000000017');
  assert.deepEqual([omo.status, omo.locations, omo.nextExpiry], ['OUT_OF_STOCK', [], null]);
  assert.ok(!('free_to_use' in feta) && !('cost' in feta), 'only the fields the screen needs');
});

test('6. search, category, location and status filters work together', () => {
  const db = stocked();
  const names = (q) => wh.inventoryPage(db, q, TODAY).items.map((p) => p.barcode).sort();
  assert.deepEqual(names({ search: 'feta-m' }), [FETA], 'search finds the SKU');
  assert.deepEqual(names({ search: 'main warehouse' }), [CHEESE, FETA].sort(), 'search finds the location');
  assert.deepEqual(names({ category: 'FOOD' }), [CHEESE, FETA].sort());
  assert.deepEqual(names({ category: 'FOOD / DAIRY' }), [CHEESE, FETA].sort());
  assert.deepEqual(names({ category: 'FOO' }), [], 'a category matches whole path segments only');
  assert.deepEqual(names({ location: 'clearance' }), []);
  assert.deepEqual(names({ status: 'OUT_OF_STOCK' }), ['6001000000017']);
  assert.deepEqual(names({ status: 'EXPIRING_SOON' }), [FETA]);
  assert.deepEqual(names({ category: 'FOOD', status: 'LOW_STOCK' }), [FETA]);
  const opts = wh.inventoryPage(db, {}, TODAY).options.categories.map((c) => `${c.path}:${c.products}`);
  assert.deepEqual(opts, ['FOOD:2', 'FOOD / DAIRY:2', 'NON FOOD:1', 'NON FOOD / DETERGENTS:1']);
});

test('7. sorting and paging', () => {
  const db = stocked();
  const page = (q) => wh.inventoryPage(db, q, TODAY);
  assert.deepEqual(page({ sort: 'available', dir: 'desc' }).items.map((p) => p.available), [40, 3, 0]);
  assert.deepEqual(page({ sort: 'status' }).items.map((p) => p.status), ['OUT_OF_STOCK', 'LOW_STOCK', 'IN_STOCK']);
  const p2 = page({ sort: 'name', limit: 2, offset: 2 });
  assert.deepEqual([p2.total, p2.items.length, p2.items[0].barcode], [3, 1, '6001000000017']);
  assert.equal(page({ limit: 5000 }).limit, 100, 'a page holds at most 100 rows');
  assert.equal(page({ sort: 'cost' }).sort, 'name', 'an unknown sort falls back to name');
});

// ===========================================================================
// stock movements: only from real records
// ===========================================================================
test('8. a stock import that changes on-hand stock shows as Stock In / Stock Out, with its import as the reference', () => {
  const db = stocked();
  const { batchId } = runImport(db, [
    row({ barcode: CHEESE, name: 'AL NAKA AKAWI CHEESE TIN 17KG * 1', uom: 'CTN1', on_hand: 30, free: 30, incoming: 10 }),
    row({ barcode: FETA, name: 'AL AMIR FETA CHEESE WITH MINT 10KG * 1 [FETA-M]', uom: 'CTN1', on_hand: 9, free: 9 }),
    row({ barcode: '6001000000017', name: 'OMO HAND WASH POWDER 500G * 24', uom: 'CTN24', on_hand: 0, free: 0, incoming: 5 }),
  ]);
  const range = wh.periodRange('today', {}, todayString());
  const moves = wh.movementsIn(db, range);
  const cheese = moves.find((m) => m.barcode === CHEESE);
  const feta = moves.find((m) => m.barcode === FETA);
  assert.deepEqual([cheese.type, cheese.quantity, cheese.reference, cheese.href], ['STOCK_OUT', -10, `Import #${batchId}`, `#/imports/${batchId}`]);
  assert.deepEqual([feta.type, feta.quantity], ['STOCK_IN', 6]);
  assert.equal(moves.filter((m) => m.barcode === '6001000000017').length, 0, 'no change, no movement');
  assert.equal(moves.length, 2, 'the first import (products created) is not a movement');
  const page = wh.movementsPage(db, range, { type: 'stock_in' });
  assert.deepEqual([page.total, page.byType.STOCK_IN, page.byType.STOCK_OUT, page.byType.TRANSFER, page.byType.ADJUSTMENT], [1, 1, 1, 0, 0]);
});

test('9. a received return shows as a Return movement; movements outside the range are left out', () => {
  const db = stocked();
  const ts = new Date().toISOString();
  const ret = Number(db.prepare(`INSERT INTO odoo_returns (number, customer_kind, customer_ref, customer_name, received_on, created_at)
    VALUES ('RET/2026/0007', 'SHELF', '4101', 'A shop', ?, ?)`).run(TODAY, ts).lastInsertRowid);
  db.prepare('INSERT INTO odoo_return_lines (return_id, barcode, product_name, cartons) VALUES (?, ?, ?, 2)').run(ret, FETA, 'AL AMIR FETA');
  const inRange = wh.movementsIn(db, wh.periodRange('week', {}, TODAY));
  assert.deepEqual(inRange.map((m) => [m.type, m.quantity, m.reference]), [['RETURN', 2, 'RET/2026/0007']]);
  assert.deepEqual(wh.movementsIn(db, wh.periodRange('last_month', {}, TODAY)), []);
  assert.equal(wh.dashboardSummary(db, { period: 'week' }, TODAY).kpis.recentMovements, 1);
});

// ===========================================================================
// stock levels by category
// ===========================================================================
test('10. stock levels: available and incoming cartons per category, negative stock counted as none', () => {
  const db = stocked();
  db.prepare('UPDATE products SET free_to_use = -4 WHERE barcode = ?').run('6001000000017');
  const { groups, series } = wh.stockLevels(db);
  assert.deepEqual(series.map((s) => s.key), ['available', 'incoming']);
  assert.deepEqual(groups.map((g) => [g.label, g.available, g.incoming, g.products]), [['Dairy', 43, 10, 2], ['Detergents', 0, 5, 1]]);
});

test('11. more than seven categories: the smallest are folded into "Others" and nothing is lost', () => {
  const db = freshDb();
  runImport(db, Array.from({ length: 9 }, (_, i) => row({ barcode: `600100000${String(i).padStart(4, '0')}`, name: `PRODUCT ${i}`, uom: 'CTN1', on_hand: i + 1, free: i + 1 })));
  db.prepare("UPDATE products SET odoo_category_path = 'FOOD / GROUP ' || id").run();
  const { groups } = wh.stockLevels(db);
  assert.equal(groups.length, 8);
  assert.equal(groups[7].label, 'Others');
  assert.equal(groups[7].folded, 2);
  assert.equal(groups.reduce((n, g) => n + g.available, 0), 45);
});

test('12. the dashboard reads nothing about cost and writes nothing', () => {
  const src = fs.readFileSync(new URL('../src/domain/warehouse.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /standard_price|cost_price|valuation|purchase_order/i);
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE)\b/);
});

// ===========================================================================
// the API and who may use it (real sign-in)
// ===========================================================================
test('13. the warehouse manager sees the dashboard, inventory, movements and notifications', async () => {
  const w = new Person(base, 'Warehouse');
  await w.staffLogin('wh@bfl.test', PW);
  const s = await w.ok('/api/warehouse/summary?period=month');
  assert.equal(s.kpis.totalProducts, 3);
  assert.equal(s.range.period, 'month');
  const inv = await w.ok('/api/warehouse/inventory?status=LOW_STOCK');
  assert.deepEqual(inv.items.map((p) => p.barcode), [FETA]);
  assert.equal((await w.ok('/api/warehouse/movements?period=year')).range.period, 'year');
  assert.ok(Array.isArray((await w.ok('/api/warehouse/notifications')).items));
  const bad = await w.call('/api/warehouse/summary?period=custom&from=2026-10-05&to=2026-10-01');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /start date is after/);
});

test('14. the Sales Manager may read it; a sales rep and a visitor may not', async () => {
  const sm = new Person(base, 'Sales Manager');
  await sm.staffLogin('sm@bfl.test', PW);
  await sm.ok('/api/warehouse/summary');
  const rep = new Person(base, 'Rep');
  await rep.staffLogin('rep@bfl.test', PW);
  assert.equal((await rep.call('/api/warehouse/summary')).status, 403);
  assert.equal((await rep.call('/api/warehouse/inventory')).status, 403);
  assert.equal((await new Person(base, 'Visitor').call('/api/warehouse/summary')).status, 401);
});
