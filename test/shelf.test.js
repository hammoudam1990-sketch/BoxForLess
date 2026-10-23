// Customer-shelf expiry (W2): rep visits (R01, R02) and the Sales Manager's discount approvals.
// Sample data only — no Odoo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { VisitOutcome } from '../src/domain/expiry.js';
import {
  loadShelf, myVisits, visitSheet, recordVisit, approvals, decideDiscount, recordCreditNote,
  ShelfError, ShelfState, ApprovalStatus, shelfKey, OVERDUE_AFTER_DAYS,
} from '../src/domain/shelf.js';

const TODAY = '2026-10-21';
const R1 = 'rep-1';
const R2 = 'rep-2';
const visits = (db, rep = R1, extra = {}) => myVisits(db, rep, { today: TODAY, ...extra });
const sheet = (db, customer, rep = R1) => visitSheet(db, rep, customer, { today: TODAY });
const record = (db, customer, lines, rep = R1) => recordVisit(db, rep, customer, lines, { today: TODAY });
const shop = (db, id, rep = R1) => visits(db, rep).customers.find((c) => c.id === id);
const lot = (db, customer, lotName) => sheet(db, customer).lots.find((l) => l.lotName === lotName);

/** A loader with fixed, absolute dates so time can be moved without everything moving with it. */
const fixed = (records, customers = [{ id: 1, odooId: 1, name: 'Test Shop', repId: R1 }]) => () => ({
  source: 'TEST', reps: [{ id: R1, name: 'Rep One' }, { id: R2, name: 'Rep Two' }], customers, records,
});
const rec = (o) => ({ customerId: 1, salesOrder: 'S1', productName: 'P', barcode: '111', lotName: 'L1', categoryPath: 'FOOD / DRY',
  deliveredCartons: 10, deliveredOn: '2026-07-01', expiryDate: '2026-11-10', ...o, key: shelfKey({ customerId: 1, salesOrder: 'S1', barcode: '111', lotName: 'L1', ...o }) });

// ===========================================================================
// the data and R01
// ===========================================================================
test('1. the sample has two reps, ten customers, and every customer belongs to exactly one rep', () => {
  const s = loadShelf(TODAY);
  assert.equal(s.source, 'SAMPLE');
  assert.equal(s.reps.length, 2);
  assert.equal(s.customers.length, 10);
  assert.ok(s.customers.every((c) => s.reps.some((r) => r.id === c.repId)));
  assert.ok(s.records.every((r) => s.customers.some((c) => c.id === r.customerId)));
});

test('2. My visits lists the rep\'s shops with open alerts, nearest expiry first, then the rest by name', () => {
  const v = visits(freshDb());
  assert.deepEqual(v.customers.map((c) => c.id), [4103, 4102, 4101, 4104, 4106, 4105]);
  assert.deepEqual(v.customers.map((c) => c.openAlerts), [2, 2, 3, 2, 1, 0]);
  assert.deepEqual(v.customers.map((c) => c.nearestDaysLeft), [-3, 8, 9, 28, 33, null]);
  assert.deepEqual(v.totals, { shops: 5, lots: 10, overdue: 6 });
  assert.equal(shop(freshDb(), 4101).cartonsAtRisk, 8 + 4 + 10);
});

test('3. a rep sees only their own customers, never another rep\'s', () => {
  const db = freshDb();
  const r2 = visits(db, R2).customers.map((c) => c.id).sort();
  assert.deepEqual(r2, [4107, 4108, 4109, 4110]);
  assert.ok(!visits(db, R1).customers.some((c) => c.id >= 4107));
  assert.deepEqual(visits(db, R2).totals, { shops: 3, lots: 5, overdue: 3 });
});

test('4. find a shop by Odoo ID or by name, within the rep\'s own list only', () => {
  const db = freshDb();
  assert.deepEqual(visits(db, R1, { q: '4102' }).customers.map((c) => c.id), [4102]);
  assert.deepEqual(visits(db, R1, { q: 'baah' }).customers.map((c) => c.id), [4103]);
  assert.deepEqual(visits(db, R1, { q: 'MART' }).customers.map((c) => c.id), [4102], 'Akwaaba Mini Mart (Golden Gate Mart is rep 2\'s)');
  assert.equal(visits(db, R1, { q: '4107' }).customers.length, 0, 'another rep\'s Odoo ID finds nothing');
  assert.equal(visits(db, R1, { q: 'fiifi' }).customers.length, 0);
});

test('5. an unknown rep is refused', () => {
  assert.throws(() => visits(freshDb(), 'rep-99'), ShelfError);
  assert.throws(() => visits(freshDb(), ''), /Choose which sales rep/);
});

// ===========================================================================
// R02 — the visit form
// ===========================================================================
test('6. the visit sheet lists a shop\'s open lots, nearest expiry first, and nothing else', () => {
  const s = sheet(freshDb(), 4101);
  assert.equal(s.customer.name, 'Adom Supermarket');
  assert.deepEqual(s.lots.map((l) => l.lotName), ['SAMPLE-0003', 'SAMPLE-0004', 'SAMPLE-0008']);
  assert.ok(!s.lots.some((l) => l.lotName === 'SAMPLE-0011'), 'the sweet corn has 150 days left: no alert yet');
  assert.equal(s.lots[0].deliveredCartons, 4);
  assert.equal(s.lots[0].cartonsOnShelf, 4);
});

test('7. another rep\'s customer, and one that does not exist, look exactly alike: not on your list', () => {
  const db = freshDb();
  for (const id of [4107, 9999, 'abc']) {
    assert.throws(() => sheet(db, id), (e) => e instanceof ShelfError && e.status === 403 && /not on your list/.test(e.message), String(id));
  }
});

test('8. sold out closes the alert: the lot leaves the shop\'s list', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  const r = record(db, 4101, [{ key: l.key, outcome: VisitOutcome.SOLD_OUT }]);
  assert.equal(r.saved, 1);
  assert.equal(lot(db, 4101, 'SAMPLE-0004'), undefined);
  assert.equal(shop(db, 4101).openAlerts, 2);
});

test('9. not checked keeps the alert open and due again in 7 days', () => {
  const db = freshDb();
  const l = lot(db, 4102, 'SAMPLE-0014');
  assert.equal(l.overdue, true, 'it was overdue before the visit');
  record(db, 4102, [{ key: l.key, outcome: VisitOutcome.NOT_CHECKED }]);
  const after = lot(db, 4102, 'SAMPLE-0014');
  assert.ok(after, 'still open');
  assert.equal(after.dueOn, '2026-10-28');
  assert.equal(after.overdue, false, 'due again next week, so no longer overdue');
});

test('10. a revisit that is not made goes overdue again once the grace period passes', () => {
  const db = freshDb();
  const records = [rec({})];
  const at = (today) => visitSheet(db, R1, 1, { today, loader: fixed(records) }).lots[0];
  recordVisit(db, R1, 1, [{ key: records[0].key, outcome: VisitOutcome.NOT_CHECKED }], { today: '2026-10-21', loader: fixed(records) });
  assert.equal(at('2026-10-28').overdue, false, 'due that day');
  assert.equal(at(`2026-11-0${1}`).overdue, false, 'a few days late is inside the grace period');
  assert.equal(at('2026-11-05').overdue, true);
  assert.equal(OVERDUE_AFTER_DAYS, 7);
});

test('11. a discount needs cartons, a valid percentage, the contact\'s name and their confirmation', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  const good = { key: l.key, outcome: VisitOutcome.DISCOUNT_AGREED, cartonsOnShelf: 5, discountPct: 20, contactName: 'Mr Boateng', agreed: true };
  const bad = [
    [{ ...good, cartonsOnShelf: 0 }, /at least 1/],
    [{ ...good, cartonsOnShelf: 99 }, /only 8 cartons were delivered/],
    [{ ...good, cartonsOnShelf: 2.5 }, /how many cartons/],
    [{ ...good, discountPct: 0 }, /percentage above 0/],
    [{ ...good, discountPct: 100 }, /percentage above 0/],
    [{ ...good, discountPct: '' }, /percentage above 0/],
    [{ ...good, contactName: '' }, /name of the customer's contact/],
    [{ ...good, contactName: 'x' }, /name of the customer's contact/],
    [{ ...good, agreed: false }, /must confirm/],
    [{ ...good, agreed: 'yes' }, /must confirm/],
  ];
  for (const [line, message] of bad) assert.throws(() => record(db, 4101, [line]), message);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shelf_visits').get().n, 0, 'nothing was saved');
  assert.equal(record(db, 4101, [good]).saved, 1);
});

test('12. a discount agreed on a visit is only a proposal: the lot leaves the rep\'s list and waits for the manager', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  record(db, 4101, [{ key: l.key, outcome: VisitOutcome.DISCOUNT_AGREED, cartonsOnShelf: 5, discountPct: 20, contactName: ' Mr Boateng ', agreed: true }]);
  assert.equal(lot(db, 4101, 'SAMPLE-0004'), undefined);
  const a = approvals(db, { today: TODAY });
  assert.equal(a.pending.length, 1);
  assert.deepEqual(
    [a.pending[0].customer, a.pending[0].rep, a.pending[0].cartonsOnShelf, a.pending[0].discountPct, a.pending[0].contactName],
    ['Adom Supermarket', 'Kwame Asante', 5, 20, 'Mr Boateng'],
  );
  assert.equal(a.financeTasks.length, 0, 'no Finance task until the manager approves');
});

test('13. approving a discount creates a Finance task; the credit note number closes the alert', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  record(db, 4101, [{ key: l.key, outcome: VisitOutcome.DISCOUNT_AGREED, cartonsOnShelf: 5, discountPct: 15, contactName: 'Mr Boateng', agreed: true }]);
  const id = approvals(db, { today: TODAY }).pending[0].id;

  assert.throws(() => recordCreditNote(db, id, 'CN/0001'), /Only an approved discount/, 'cannot skip the approval');
  assert.deepEqual(decideDiscount(db, id, { decision: 'APPROVE' }), { id, status: ApprovalStatus.APPROVED });
  const mid = approvals(db, { today: TODAY });
  assert.equal(mid.pending.length, 0);
  assert.equal(mid.financeTasks.length, 1);
  assert.equal(lot(db, 4101, 'SAMPLE-0004'), undefined, 'still not back on the rep\'s list');

  assert.throws(() => recordCreditNote(db, id, ''), /credit note number/);
  assert.deepEqual(recordCreditNote(db, id, ' CN/2026/0042 '), { id, creditNoteRef: 'CN/2026/0042' });
  const end = approvals(db, { today: TODAY });
  assert.equal(end.financeTasks.length, 0);
  assert.equal(end.decided[0].creditNoteRef, 'CN/2026/0042');
  assert.throws(() => recordCreditNote(db, id, 'CN/2'), /already has a credit note/);
});

test('14. a rejected discount goes back to the rep with the reason, and its carton count is kept', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  record(db, 4101, [{ key: l.key, outcome: VisitOutcome.DISCOUNT_AGREED, cartonsOnShelf: 5, discountPct: 60, contactName: 'Mr Boateng', agreed: true }]);
  const id = approvals(db, { today: TODAY }).pending[0].id;
  assert.throws(() => decideDiscount(db, id, { decision: 'REJECT' }), /reason/);
  assert.throws(() => decideDiscount(db, id, { decision: 'REJECT', reason: 'no' }), /reason/);
  assert.throws(() => decideDiscount(db, id, { decision: 'MAYBE' }), /approve or reject/);
  decideDiscount(db, id, { decision: 'REJECT', reason: 'Too deep: 25% at most on dairy' });
  const back = lot(db, 4101, 'SAMPLE-0004');
  assert.ok(back, 'the lot is back on the rep\'s list');
  assert.equal(back.rejectedReason, 'Too deep: 25% at most on dairy');
  assert.equal(back.cartonsOnShelf, 5, 'the count from the visit is remembered');
  assert.equal(approvals(db, { today: TODAY }).pending.length, 0);
  assert.throws(() => decideDiscount(db, id, { decision: 'APPROVE' }), (e) => e.status === 409);
});

test('15. a decision on something that is not a proposed discount is refused', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  record(db, 4101, [{ key: l.key, outcome: VisitOutcome.SOLD_OUT }]);
  const lineId = db.prepare('SELECT id FROM shelf_visit_lines').get().id;
  assert.throws(() => decideDiscount(db, lineId, { decision: 'APPROVE' }), (e) => e.status === 404);
  assert.throws(() => decideDiscount(db, 9999, { decision: 'APPROVE' }), (e) => e.status === 404);
});

test('16. return expected: the lot leaves the rep\'s list and is passed on to returns', () => {
  const db = freshDb();
  const l = lot(db, 4102, 'SAMPLE-0015');
  record(db, 4102, [{ key: l.key, outcome: VisitOutcome.RETURN_EXPECTED, cartonsOnShelf: 3 }]);
  assert.equal(lot(db, 4102, 'SAMPLE-0015'), undefined);
  const r = approvals(db, { today: TODAY }).returnsExpected;
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].customer, r[0].productName, r[0].cartonsOnShelf, r[0].rep], ['Akwaaba Mini Mart', 'CANDIA JUICE 180ML *24/MANGO', 3, 'Kwame Asante']);
  assert.throws(() => record(db, 4102, [{ key: l.key, outcome: VisitOutcome.RETURN_EXPECTED, cartonsOnShelf: 0 }]), ShelfError);
});

// ===========================================================================
// the rules a rep cannot get round
// ===========================================================================
test('17. a rep cannot record a visit for another rep\'s customer', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  assert.throws(() => record(db, 4101, [{ key: l.key, outcome: VisitOutcome.SOLD_OUT }], R2), (e) => e.status === 403);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shelf_visits').get().n, 0);
});

test('18. a lot that is not waiting for a visit at that customer is refused, however it is named', () => {
  const db = freshDb();
  const others = loadShelf(TODAY).records;
  const notYet = others.find((r) => r.lotName === 'SAMPLE-0011');              // 150 days left: no alert yet
  const elsewhere = others.find((r) => r.customerId === 4102);                  // another shop's lot
  for (const key of [notYet.key, elsewhere.key, 'made|up|key|S0', undefined, null]) {
    assert.throws(() => record(db, 4101, [{ key, outcome: VisitOutcome.SOLD_OUT }]), /not waiting for a visit/, String(key));
  }
});

test('19. an empty visit, a repeated lot and an unknown outcome are refused', () => {
  const db = freshDb();
  const l = lot(db, 4101, 'SAMPLE-0004');
  assert.throws(() => record(db, 4101, []), /at least one lot/);
  assert.throws(() => record(db, 4101, undefined), /at least one lot/);
  assert.throws(() => record(db, 4101, [{ key: l.key, outcome: 'SOLD_OUT' }, { key: l.key, outcome: 'SOLD_OUT' }]), /twice/);
  assert.throws(() => record(db, 4101, [{ key: l.key, outcome: 'DESTROYED' }]), /choose what happened/);
  assert.throws(() => record(db, 4101, [{ key: l.key }]), /choose what happened/);
});

test('20. a visit is all or nothing: one bad line saves none of the good ones', () => {
  const db = freshDb();
  const [a, b] = sheet(db, 4101).lots;
  assert.throws(() => record(db, 4101, [
    { key: a.key, outcome: VisitOutcome.SOLD_OUT },
    { key: b.key, outcome: VisitOutcome.DISCOUNT_AGREED, cartonsOnShelf: 1, discountPct: 10, contactName: '', agreed: true },
  ]), ShelfError);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shelf_visits').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shelf_visit_lines').get().n, 0);
  assert.equal(shop(db, 4101).openAlerts, 3);
});

test('21. several lots in one visit are saved together, one outcome each', () => {
  const db = freshDb();
  const [a, b, c] = sheet(db, 4101).lots;
  const r = record(db, 4101, [
    { key: a.key, outcome: VisitOutcome.SOLD_OUT },
    { key: b.key, outcome: VisitOutcome.NOT_CHECKED },
    { key: c.key, outcome: VisitOutcome.DISCOUNT_AGREED, cartonsOnShelf: 2, discountPct: 10, contactName: 'Ama', agreed: true },
  ]);
  assert.equal(r.saved, 3);
  assert.deepEqual(r.byOutcome, { SOLD_OUT: 1, NOT_CHECKED: 1, DISCOUNT_AGREED: 1 });
  assert.equal(shop(db, 4101).openAlerts, 1, 'only the not-checked lot is still open');
});

test('22. the manager sees how many visits each rep has open and overdue', () => {
  const db = freshDb();
  const byRep = Object.fromEntries(approvals(db, { today: TODAY }).overdueByRep.map((r) => [r.repId, r]));
  assert.deepEqual([byRep[R1].openAlerts, byRep[R1].overdue], [10, 6]);
  assert.deepEqual([byRep[R2].openAlerts, byRep[R2].overdue], [5, 3]);
  record(db, 4103, sheet(db, 4103).lots.map((l) => ({ key: l.key, outcome: VisitOutcome.SOLD_OUT })));
  const after = approvals(db, { today: TODAY }).overdueByRep.find((r) => r.repId === R1);
  assert.deepEqual([after.openAlerts, after.overdue], [8, 4]);
});

test('23. nothing priced or costed reaches a rep or the shelf screens', () => {
  const db = freshDb();
  const body = JSON.stringify([visits(db), sheet(db, 4101), approvals(db, { today: TODAY })]);
  assert.ok(!/price|cost|valueAtRisk|valuation/i.test(body));
});

// ===========================================================================
// the staff-only routes
// ===========================================================================
async function withApp(db, fn) {
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const j = (base, url, method = 'GET', body) => fetch(base + url, {
  method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('24. the whole workflow over HTTP: visit, propose, approve, credit note', async () => {
  await withApp(freshDb(), async (base) => {
    const reps = await j(base, '/api/shelf/reps');
    assert.deepEqual(reps.body.reps.map((r) => r.id), [R1, R2]);

    const list = await j(base, `/api/shelf/my-visits?rep=${R1}`);
    assert.equal(list.body.totals.lots, 10);

    const s = await j(base, `/api/shelf/visit-sheet?rep=${R1}&customer=4101`);
    assert.equal(s.status, 200);
    const target = s.body.lots.find((l) => l.lotName === 'SAMPLE-0004');

    const saved = await j(base, '/api/shelf/visits', 'POST', {
      rep: R1, customer: 4101,
      lines: [{ key: target.key, outcome: 'DISCOUNT_AGREED', cartonsOnShelf: 4, discountPct: 20, contactName: 'Mr Boateng', agreed: true }],
    });
    assert.equal(saved.status, 201);

    const a = await j(base, '/api/shelf/approvals');
    assert.equal(a.body.pending.length, 1);
    const id = a.body.pending[0].id;
    assert.equal((await j(base, `/api/shelf/approvals/${id}/decide`, 'POST', { decision: 'APPROVE' })).status, 200);
    assert.equal((await j(base, '/api/shelf/approvals')).body.financeTasks.length, 1);
    assert.equal((await j(base, `/api/shelf/approvals/${id}/credit-note`, 'POST', { ref: 'CN/1' })).status, 200);
    assert.equal((await j(base, '/api/shelf/approvals')).body.financeTasks.length, 0);
  });
});

test('25. over HTTP a rep is still kept to their own customers, and bad input is a 4xx with a message', async () => {
  await withApp(freshDb(), async (base) => {
    assert.equal((await j(base, `/api/shelf/visit-sheet?rep=${R2}&customer=4101`)).status, 403);
    assert.equal((await j(base, '/api/shelf/my-visits?rep=nobody')).status, 400);
    const bad = await j(base, '/api/shelf/visits', 'POST', { rep: R1, customer: 4101, lines: [] });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /at least one lot/);
    assert.equal((await j(base, '/api/shelf/approvals/999/decide', 'POST', { decision: 'APPROVE' })).status, 404);
  });
});

test('26. the shelf API and the rep page are staff-only', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await withApp(freshDb(), async (base) => {
      for (const [method, url] of [['GET', '/api/shelf/reps'], ['GET', `/api/shelf/my-visits?rep=${R1}`], ['POST', '/api/shelf/visits'], ['GET', '/api/shelf/approvals']]) {
        const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
        assert.ok([401, 403, 503].includes(res.status), `${method} ${url} -> ${res.status}`);
        assert.ok(!(await res.text()).includes('Adom'), 'no customer data in a refusal');
      }
      const page = await fetch(`${base}/rep.html`, { redirect: 'manual' });
      assert.equal(page.status, 302);
      assert.match(page.headers.get('location'), /^\/staff\/login/);
    });
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
});

test('27. the shelf states are the ones the specification names', () => {
  assert.deepEqual(Object.keys(ShelfState).sort(), ['CLOSED_CREDIT_NOTE', 'CLOSED_RETURNED', 'CLOSED_SOLD', 'DISCOUNT_APPROVED', 'DISCOUNT_PENDING', 'OPEN', 'RETURN_EXPECTED']);
  assert.deepEqual(Object.keys(ApprovalStatus), ['PENDING', 'APPROVED', 'REJECTED']);
});
