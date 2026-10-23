// The Expiry list (S03): rows, filters, saved decisions, CSV and the staff-only route.
// Sample data only — no Odoo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { ExpiryBand, ExpiryAction, ExpiryStatus, EntryIssue, toDay, formatDay } from '../src/domain/expiry.js';
import { loadLots, sampleSettings } from '../src/domain/expiry-sample.js';
import { saveAction, listActions, lotKey, ExpiryActionError } from '../src/domain/expiry-actions.js';
import { buildExpiryList, saveLotDecision, parseFilters, expiryCsv } from '../src/domain/expiry-list.js';

const TODAY = '2026-10-21';
const build = (db, filters = {}) => buildExpiryList(db, { today: TODAY, filters });
const byLot = (list, lotName) => list.rows.find((r) => r.lotName === lotName);

// ===========================================================================
// the sample data
// ===========================================================================
test('1. sample lots are dated relative to today, and labelled as sample', () => {
  const a = loadLots('2026-10-21');
  const b = loadLots('2027-03-01');
  assert.equal(a.source, 'SAMPLE');
  assert.equal(a.lots.length, 31);
  const first = (x) => x.lots.find((l) => l.lotName === 'SAMPLE-0003');
  assert.equal(formatDay(toDay(first(a).expiryDate) - toDay('2026-10-21')), formatDay(toDay(first(b).expiryDate) - toDay('2027-03-01')),
    'the same number of days from whatever "today" is');
  assert.equal(a.lots.find((l) => l.lotName === 'SAMPLE-0026').expiryDate, null, 'a lot with no expiry date stays without one');
});

test('2. the sample is not mistaken for real stock: every lot is named SAMPLE-', () => {
  assert.ok(loadLots(TODAY).lots.every((l) => l.lotName.startsWith('SAMPLE-')));
});

// ===========================================================================
// the list
// ===========================================================================
test('3. every lot lands in the expected band and the counts add up', () => {
  const list = build(freshDb());
  const c = list.summary.counts;
  assert.deepEqual(
    [c.EXPIRED, c.CRITICAL, c.WARNING, c.EARLY, c.OK, c.NO_DATE],
    [3, 7, 5, 5, 10, 1],
  );
  assert.equal(list.summary.lots, 31);
  assert.equal(list.rows.length, 31);
  assert.equal(byLot(list, 'SAMPLE-0003').band, ExpiryBand.CRITICAL);    // dairy is short-life: 9 days is critical
  assert.equal(byLot(list, 'SAMPLE-0010').band, ExpiryBand.WARNING);     // canned: long-life, 44 days
  assert.equal(byLot(list, 'SAMPLE-0015').band, ExpiryBand.EARLY);       // juice is short-life: 33 days
});

test('4. expired lots are at the top, then the fewest days left, and the lot with no date is last', () => {
  const rows = build(freshDb()).rows;
  assert.deepEqual(rows.slice(0, 3).map((r) => r.band), [ExpiryBand.EXPIRED, ExpiryBand.EXPIRED, ExpiryBand.EXPIRED]);
  assert.equal(rows[0].lotName, 'SAMPLE-0028');                          // -30 days
  assert.equal(rows[rows.length - 1].band, ExpiryBand.NO_DATE);
  const days = rows.filter((r) => r.daysLeft !== null).map((r) => r.daysLeft);
  assert.deepEqual(days, [...days].sort((a, b) => a - b));
});

test('5. only lots on their way to, or past, expiry are actionable; the rest have nothing to decide', () => {
  const list = build(freshDb());
  assert.equal(list.rows.filter((r) => r.actionable).length, 20);
  assert.equal(byLot(list, 'SAMPLE-0012').actionable, false);
  assert.equal(byLot(list, 'SAMPLE-0026').actionable, false);
  assert.equal(list.summary.needsAction, 20, 'none of the 20 has a decision yet');
});

test('6. the "Check these entries" list catches the three deliberate mistakes in the sample', () => {
  const list = build(freshDb());
  const issues = Object.fromEntries(list.checkEntries.map((e) => [e.lotName, e.issues.map((i) => i.code)]));
  assert.deepEqual(issues, {
    'SAMPLE-0027': [EntryIssue.FAR_ABOVE_USUAL],     // a dairy lot received with over 2 years to expiry
    'SAMPLE-0028': [EntryIssue.PAST_AT_RECEIPT],     // already past on the day it was received
    'SAMPLE-0029': [EntryIssue.TOO_FAR_AHEAD],       // 4000 days ahead
  });
  assert.ok(list.checkEntries.every((e) => e.issues.every((i) => i.text.length > 10)));
  assert.equal(list.summary.checkEntries, 3);
});

test('7. value at risk is at the selling price, summed over the bands that need attention', () => {
  const v = build(freshDb()).summary.value;
  assert.ok(v.total > 0);
  assert.equal(v.unpriced, 0, 'every lot that is at risk in the sample has a price');
  assert.equal(Math.round((v.byBand.EXPIRED + v.byBand.CRITICAL + v.byBand.WARNING + v.byBand.EARLY) * 100) / 100, v.total);
  // SAMPLE-0001 14 cartons x 96, SAMPLE-0002 6 x 78.5, SAMPLE-0028 30 x 92
  assert.equal(v.byBand.EXPIRED, 14 * 96 + 6 * 78.5 + 30 * 92);
  assert.equal(byLot(build(freshDb()), 'SAMPLE-0001').valueAtRisk, 1344);
});

// ===========================================================================
// filters
// ===========================================================================
test('8. filters: band, category, location, search, unassigned', () => {
  const db = freshDb();
  assert.equal(build(db, { bands: ['CRITICAL'] }).rows.length, 7);
  assert.equal(build(db, { bands: ['CRITICAL', 'EXPIRED'] }).rows.length, 10);
  assert.equal(build(db, { category: 'FOOD / DAIRY' }).rows.length, 8);
  assert.equal(build(db, { category: 'FOOD / DAIRYFREE' }).rows.length, 0, 'whole path segments only');
  assert.equal(build(db, { location: 'CLEARANCE' }).rows.length, 2);
  assert.equal(build(db, { q: 'abido' }).rows.length, 6);
  assert.equal(build(db, { q: 'sample-0027' }).rows.length, 1);
  assert.equal(build(db, { q: 'ALMRFCHWTHPPR' }).rows.length, 2, 'two lots of the same product');
  assert.equal(build(db, { owner: '__none__' }).rows.length, 20);
  const filtered = build(db, { bands: ['EARLY'] });
  assert.equal(filtered.shown, 5);
  assert.equal(filtered.summary.lots, 31, 'the summary tiles always describe the whole list');
});

test('9. query strings are read safely: unknown values are ignored, not trusted', () => {
  assert.deepEqual(parseFilters({ band: 'critical, expired ,nonsense', location: 'main', status: 'done', q: '  yoghurt ' }),
    { bands: ['CRITICAL', 'EXPIRED'], category: '', location: 'MAIN', status: 'DONE', owner: '', q: 'yoghurt' });
  assert.deepEqual(parseFilters({ band: "'; DROP TABLE x", location: 'moon', status: 'nope' }),
    { bands: [], category: '', location: '', status: '', owner: '', q: '' });
  assert.equal(parseFilters({ q: 'x'.repeat(500) }).q.length, 80);
  assert.deepEqual(parseFilters(), { bands: [], category: '', location: '', status: '', owner: '', q: '' });
});

// ===========================================================================
// decisions
// ===========================================================================
test('10. a decision is saved against a lot and comes back on the list', () => {
  const db = freshDb();
  saveLotDecision(db, lotKey(byLot(build(db), 'SAMPLE-0004')), {
    action: ExpiryAction.MOVE_TO_CLEARANCE, owner: ' Akosua Mensah ', decideBy: '2026-10-25', status: ExpiryStatus.IN_PROGRESS,
  }, { today: TODAY });
  const row = byLot(build(db), 'SAMPLE-0004');
  assert.equal(row.action, ExpiryAction.MOVE_TO_CLEARANCE);
  assert.equal(row.owner, 'Akosua Mensah', 'trimmed');
  assert.equal(row.decideBy, '2026-10-25');
  assert.equal(row.status, ExpiryStatus.IN_PROGRESS);
  assert.equal(row.needsAction, false);
  assert.equal(build(db).summary.needsAction, 19);
  assert.deepEqual(build(db).options.owners, ['Akosua Mensah']);
});

test('11. changing one field never wipes the others', () => {
  const db = freshDb();
  const key = lotKey(byLot(build(db), 'SAMPLE-0004'));
  saveLotDecision(db, key, { action: ExpiryAction.PUSH_THROUGH_REPS, owner: 'Kofi' }, { today: TODAY });
  saveLotDecision(db, key, { status: ExpiryStatus.DONE }, { today: TODAY });
  const row = byLot(build(db), 'SAMPLE-0004');
  assert.equal(row.action, ExpiryAction.PUSH_THROUGH_REPS);
  assert.equal(row.owner, 'Kofi');
  assert.equal(row.status, ExpiryStatus.DONE);
  saveLotDecision(db, key, { owner: '' }, { today: TODAY });
  assert.equal(byLot(build(db), 'SAMPLE-0004').owner, null, 'an empty owner clears it');
  assert.equal(byLot(build(db), 'SAMPLE-0004').action, ExpiryAction.PUSH_THROUGH_REPS);
});

test('12. a lot with a decide-by date in the past, not done, is overdue; done is not', () => {
  const db = freshDb();
  const key = lotKey(byLot(build(db), 'SAMPLE-0008'));
  saveLotDecision(db, key, { action: ExpiryAction.RETURN_TO_SUPPLIER, decideBy: '2026-10-15' }, { today: TODAY });
  assert.equal(byLot(build(db), 'SAMPLE-0008').overdue, true);
  assert.equal(build(db).summary.overdue, 1);
  saveLotDecision(db, key, { decideBy: '2026-10-21' }, { today: TODAY });
  assert.equal(byLot(build(db), 'SAMPLE-0008').overdue, false, 'due today is not yet overdue');
  saveLotDecision(db, key, { decideBy: '2026-10-15', status: ExpiryStatus.DONE }, { today: TODAY });
  assert.equal(byLot(build(db), 'SAMPLE-0008').overdue, false);
  assert.equal(byLot(build(db), 'SAMPLE-0008').needsAction, false);
});

test('13. a decision is refused for a lot that is not on the list, or one nowhere near expiry', () => {
  const db = freshDb();
  assert.throws(() => saveLotDecision(db, '0000|MADE-UP', { action: ExpiryAction.MOVE_TO_CLEARANCE }, { today: TODAY }), /not on the expiry list/);
  const fine = lotKey(byLot(build(db), 'SAMPLE-0012'));       // 140 days: OK band
  assert.throws(() => saveLotDecision(db, fine, { action: ExpiryAction.MOVE_TO_CLEARANCE }, { today: TODAY }), /not close to expiry/);
  const noDate = lotKey(byLot(build(db), 'SAMPLE-0026'));
  assert.throws(() => saveLotDecision(db, noDate, { owner: 'X' }, { today: TODAY }), ExpiryActionError);
  assert.equal(listActions(db).size, 0, 'nothing was written');
});

test('14. bad input is refused with a plain message and writes nothing', () => {
  const db = freshDb();
  const key = lotKey(byLot(build(db), 'SAMPLE-0004'));
  const bad = [
    [{ action: 'DESTROY' }, /not one of the actions/],
    [{ status: 'MAYBE' }, /not one of the statuses/],
    [{ decideBy: '2026-02-30' }, /not a real date/],
    [{ decideBy: 'tomorrow' }, /not a real date/],
    [{ owner: 'x'.repeat(61) }, /at most 60/],
  ];
  for (const [input, message] of bad) assert.throws(() => saveLotDecision(db, key, input, { today: TODAY }), message);
  assert.equal(listActions(db).size, 0);
  assert.throws(() => saveAction(db, '', { owner: 'x' }), /A lot is needed/);
  assert.throws(() => saveAction(db, 'k'.repeat(201), { owner: 'x' }), /A lot is needed/);
});

test('15. an owner containing markup is stored as plain text; the CSV stays safe', () => {
  const db = freshDb();
  const key = lotKey(byLot(build(db), 'SAMPLE-0004'));
  saveLotDecision(db, key, { owner: '=HYPERLINK("http://evil","x")' }, { today: TODAY });
  const csv = expiryCsv(build(db).rows);
  assert.ok(csv.includes('\'=HYPERLINK'), 'a leading = is defused so a spreadsheet will not run it');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv));
});

// ===========================================================================
// CSV
// ===========================================================================
test('16. the CSV has a header, one line per row, CRLF line ends, and quotes what needs quoting', () => {
  const rows = [
    { productName: 'TOMATO "PASTE", 70G', barcode: '1', lotName: 'L', expiryDate: '2026-12-01', daysLeft: 41, band: 'WARNING', cartons: 5, location: 'MAIN', categoryPath: 'FOOD', valueAtRisk: 12.5, action: null, owner: null, decideBy: null, status: 'OPEN' },
  ];
  const csv = expiryCsv(rows);
  const lines = csv.split('\r\n');
  assert.equal(lines.length, 3, 'header, one row, trailing newline');
  assert.match(lines[0], /^Product,Barcode,Lot,Expiry date,Days left,Band,Cartons,Location,Category,Value at risk \(selling price\),Action,Owner,Decide by,Status,Customer discount %$/);
  assert.ok(lines[1].startsWith('"TOMATO ""PASTE"", 70G",1,L,2026-12-01,41,WARNING,5,MAIN,FOOD,12.5,'));
});

test('17. a negative number in the CSV is a number, not a formula', () => {
  const csv = expiryCsv([{ productName: 'X', barcode: '1', lotName: 'L', daysLeft: -6, band: 'EXPIRED', cartons: 1, location: 'MAIN', status: 'OPEN' }]);
  assert.ok(csv.split('\r\n')[1].includes(',-6,'), 'days left of -6 is left alone');
});

// ===========================================================================
// the staff route
// ===========================================================================
async function withApp(db, fn) {
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { server.close(); }
}

test('18. the route lists, filters, saves a decision and exports CSV', async () => {
  const db = freshDb();
  await withApp(db, async (base) => {
    const list = await (await fetch(`${base}/api/expiry?band=CRITICAL`)).json();
    assert.equal(list.source, 'SAMPLE');
    assert.equal(list.rows.length, 7);
    assert.ok(list.summary.value.total > 0);

    const key = encodeURIComponent(list.rows[0].key);
    const patch = await fetch(`${base}/api/expiry/lots/${key}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'MOVE_TO_CLEARANCE', owner: 'Ama' }),
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).row.owner, 'Ama');

    const csv = await fetch(`${base}/api/expiry/export.csv?band=CRITICAL`);
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment; filename="expiry-list-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.equal((await csv.text()).trim().split('\r\n').length, 8, 'header + 7 critical lots');

    const bad = await fetch(`${base}/api/expiry/lots/${encodeURIComponent('0|NOPE')}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ owner: 'x' }),
    });
    assert.equal(bad.status, 400);
    const badAction = await fetch(`${base}/api/expiry/lots/${key}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'DESTROY' }),
    });
    assert.equal(badAction.status, 400);
  });
});

test('19. the expiry API is staff-only: without a staff session it is refused, never served', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;            // the test runner's bypass is off for this test
  try {
    await withApp(freshDb(), async (base) => {
      for (const [method, url] of [['GET', '/api/expiry'], ['GET', '/api/expiry/export.csv'], ['PATCH', '/api/expiry/lots/x']]) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'PATCH' ? '{}' : undefined });
        assert.ok([401, 403, 503].includes(res.status), `${method} ${url} -> ${res.status}`);
        const text = await res.text();
        assert.ok(!text.includes('SAMPLE-'), 'no lot data in a refusal');
      }
    });
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('20. value at risk never appears in any customer-facing payload', async () => {
  const { catalogFacets, searchCatalog } = await import('../src/domain/catalog.js');
  const db = freshDb();
  const body = JSON.stringify({ search: searchCatalog(db, {}), facets: catalogFacets(db) });
  assert.ok(!/valueAtRisk|pricePerCarton|expiry_actions|SAMPLE-/i.test(body));
});

test('21. the sample settings: dairy and juice are short-shelf-life, everything else long', () => {
  const s = sampleSettings();
  assert.equal(s.categories['FOOD / DAIRY'].type, 'SHORT');
  assert.equal(s.categories['DRINKS & BEVERAGES / JUICE'].type, 'SHORT');
  assert.equal(Object.keys(s.categories).length, 2);
});
