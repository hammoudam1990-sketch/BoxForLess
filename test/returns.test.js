// Returns for damage or expiry (W4, screen S04): the reason recorded in BFL, shelf records net of returns,
// and a broken discount agreement flagged to the Sales Manager.
//
// What is at risk, in order:
//   1. A return counted twice, or a returned lot still alerting a rep to visit a shelf that is empty.
//   2. A broken agreement (expiry return on a lot where a discount was agreed) going unnoticed.
//   3. Anyone but the warehouse deciding the reason.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import { listReturns, classifyReturn, overdueUnclassified, ReturnError, CLASSIFY_WITHIN_DAYS } from '../src/domain/returns.js';
import { returnOptions, createReturn, issueReturnCreditNote, SampleOdooError, sendQuotation, confirmOrder, validateDelivery, postInvoice } from '../src/domain/sample-odoo.js';
import { createOrderForRequest } from '../src/domain/orders.js';
import { submitRequest } from '../src/domain/requests.js';
import { shelfRecords, visitSheet, recordVisit, decideDiscount, recordCreditNote, ShelfState } from '../src/domain/shelf.js';
import { todayString } from '../src/domain/expiry-list.js';
import { cartonPriceFor } from '../src/domain/prices.js';

const TODAY = todayString();
const CUST = 4101;           // Adom Supermarket, rep-1 (fixtures/shelf-sample.json)
const YOGHURT = 'ALMRFCHWTHPPR';
const day = (offset) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);

const rec = (db, barcode = YOGHURT, cust = CUST) => shelfRecords(db, TODAY).records.find((r) => r.customerId === cust && r.barcode === barcode);
/** Receive the whole delivered lot back (or `n` cartons) as the warehouse would, on a given day. */
function returnLot(db, { barcode = YOGHURT, cust = CUST, cartons, daysAgo = 0 } = {}) {
  const r = rec(db, barcode, cust);
  const opt = returnOptions(db, TODAY).find((o) => o.id.startsWith(`SHELF:${cust}|${barcode}|${r.lotName}|`));
  const made = createReturn(db, { optionId: opt.id, cartons: cartons ?? opt.left }, TODAY, new Date(`${day(-daysAgo)}T10:00:00Z`));
  return { ...made, record: r };
}
const classify = (db, id, reason, note) => classifyReturn(db, id, { reason, note }, 'Esi');

// ===========================================================================
// receiving and classifying
// ===========================================================================
test('1. a return can only be received for what was delivered and not already returned; numbers run on', () => {
  const db = freshDb();
  const opts = returnOptions(db, TODAY);
  const yoghurt = opts.find((o) => o.id.includes(`${CUST}|${YOGHURT}`));
  assert.equal(yoghurt.left, 8);
  assert.throws(() => createReturn(db, { optionId: yoghurt.id, cartons: 9 }, TODAY), (e) => e instanceof SampleOdooError && /between 1 and 8/.test(e.message));
  assert.throws(() => createReturn(db, { optionId: yoghurt.id, cartons: 0 }, TODAY), SampleOdooError);
  assert.throws(() => createReturn(db, { optionId: 'SHELF:nonsense', cartons: 1 }, TODAY), /Choose what is being returned/);
  const first = createReturn(db, { optionId: yoghurt.id, cartons: 3 }, TODAY);
  assert.match(first.number, /^RET\/\d{4}\/0001$/);
  assert.equal(returnOptions(db, TODAY).find((o) => o.id === yoghurt.id).left, 5, 'net of what came back');
  assert.throws(() => createReturn(db, { optionId: yoghurt.id, cartons: 6 }, TODAY), /between 1 and 5/);
  assert.match(createReturn(db, { optionId: yoghurt.id, cartons: 5 }, TODAY).number, /0002$/);
  assert.ok(!returnOptions(db, TODAY).some((o) => o.id === yoghurt.id), 'fully returned: nothing left to return');
});

test('2. every return waits for its reason; after three days it is overdue and counted for the dashboard', () => {
  const db = freshDb();
  returnLot(db, { cartons: 1, daysAgo: 0 });
  returnLot(db, { barcode: 'ALMRFCHMNT112', cartons: 1, daysAgo: CLASSIFY_WITHIN_DAYS });
  returnLot(db, { barcode: '5283033901482', cartons: 1, daysAgo: 10 });
  const list = listReturns(db, TODAY);
  assert.deepEqual(list.unclassified.map((r) => r.ageDays), [10, 3, 0], 'oldest first');
  assert.deepEqual(list.unclassified.map((r) => r.overdue), [true, true, false]);
  assert.deepEqual(list.counts, { unclassified: 3, overdue: 2, expected: list.counts.expected });
  assert.equal(overdueUnclassified(db, TODAY), 2);
  classify(db, list.unclassified[0].id, 'DAMAGED');
  assert.equal(overdueUnclassified(db, TODAY), 1, 'a classified return stops counting');
  assert.equal(listReturns(db, TODAY).classified[0].reasonLabel, 'Damaged');
});

test('3. the reason is damaged, expired or other (other needs a note); it can be changed and keeps who and when', () => {
  const db = freshDb();
  const { id } = returnLot(db, { cartons: 2 });
  assert.throws(() => classify(db, id, 'LOST'), ReturnError);
  assert.throws(() => classify(db, id, 'OTHER', ''), /Say what the other reason is/);
  assert.throws(() => classify(db, 9999, 'DAMAGED'), (e) => e.status === 404);
  classify(db, id, 'OTHER', 'Wrong product sent');
  classify(db, id, 'EXPIRED');
  const row = listReturns(db, TODAY).classified.find((r) => r.id === id);
  assert.deepEqual([row.reason, row.classifiedBy, row.note], ['EXPIRED', 'Esi', null]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM return_classifications').get().n, 1, 'one record per return');
});

// ===========================================================================
// the shelf records
// ===========================================================================
test('4. a returned lot is subtracted from the shelf record and its alert closes as Returned', () => {
  const db = freshDb();
  const before = rec(db);
  assert.equal(before.state, ShelfState.OPEN);
  assert.equal(before.cartonsOnShelf, 8);
  returnLot(db, { cartons: 3 });
  const part = rec(db);
  assert.equal(part.cartonsOnShelf, 5, 'net of the return');
  assert.equal(part.returned, 3);
  assert.equal(part.state, ShelfState.OPEN, 'part of the lot is still on the shelf, so the alert stays');
  returnLot(db, { cartons: 5 });
  const gone = rec(db);
  assert.deepEqual([gone.cartonsOnShelf, gone.state], [0, ShelfState.CLOSED_RETURNED]);
  // another customer's identical product is untouched
  assert.ok(shelfRecords(db, TODAY).records.filter((r) => r.barcode === YOGHURT && r.customerId !== CUST).every((r) => r.returned === 0));
});

test('5. a refused discount ("return expected") closes as Returned once the lot arrives', () => {
  const db = freshDb();
  const sheet = visitSheet(db, 'rep-1', CUST, { today: TODAY });
  const lot = sheet.lots.find((l) => l.barcode === YOGHURT);
  recordVisit(db, 'rep-1', CUST, [{ key: lot.key, cartonsOnShelf: 5, outcome: 'RETURN_EXPECTED' }], { today: TODAY });
  assert.equal(rec(db).state, ShelfState.RETURN_EXPECTED);
  assert.equal(listReturns(db, TODAY).expected.length, 1, 'the warehouse can see it coming');
  assert.equal(listReturns(db, TODAY).expected[0].cartons, 5);
  returnLot(db, { cartons: 5 });
  assert.equal(rec(db).state, ShelfState.CLOSED_RETURNED);
  assert.equal(listReturns(db, TODAY).expected.length, 0, 'it has arrived');
});

// ===========================================================================
// agreements broken
// ===========================================================================
function agreeDiscount(db) {
  const lot = visitSheet(db, 'rep-1', CUST, { today: TODAY }).lots.find((l) => l.barcode === YOGHURT);
  recordVisit(db, 'rep-1', CUST, [{ key: lot.key, cartonsOnShelf: 6, outcome: 'DISCOUNT_AGREED', discountPct: 25, contactName: 'Ama Boateng', agreed: true }], { today: TODAY });
  const line = db.prepare('SELECT id FROM shelf_visit_lines ORDER BY id DESC LIMIT 1').get().id;
  decideDiscount(db, line, { decision: 'APPROVE' });
  recordCreditNote(db, line, 'CN-ODOO-77');
  return line;
}

test('6. an expiry return on a lot where a discount was agreed is flagged, with the agreement and the credit note already given', () => {
  const db = freshDb();
  agreeDiscount(db);
  const { id } = returnLot(db, { cartons: 6 });
  assert.equal(listReturns(db, TODAY).brokenAgreements.length, 0, 'not yet classified: nothing to flag');
  classify(db, id, 'EXPIRED');
  const flagged = listReturns(db, TODAY).brokenAgreements;
  assert.equal(flagged.length, 1);
  const b = flagged[0].brokenAgreement;
  assert.deepEqual([b.discountPct, b.agreedBy, b.creditNoteGiven], [25, 'Ama Boateng', 'CN-ODOO-77']);
  assert.ok(b.agreedOn && b.approvedAt);
  assert.equal(flagged[0].customer, 'Adom Supermarket');
  classify(db, id, 'DAMAGED');
  assert.equal(listReturns(db, TODAY).brokenAgreements.length, 0, 'a damaged return does not break the agreement');
});

test('7. an expiry return with no agreement behind it is not flagged', () => {
  const db = freshDb();
  const { id } = returnLot(db, { cartons: 2 });
  classify(db, id, 'EXPIRED');
  assert.equal(listReturns(db, TODAY).brokenAgreements.length, 0);
});

// ===========================================================================
// credit notes
// ===========================================================================
test('8. a shelf discount credit note becomes an Odoo credit note the reports can read, and a number is not reused', () => {
  const db = freshDb();
  agreeDiscount(db);
  const cn = db.prepare("SELECT * FROM odoo_credit_notes WHERE kind = 'DISCOUNT'").get();
  assert.equal(cn.number, 'CN-ODOO-77');
  assert.equal(cn.customer_name, 'Adom Supermarket');
  assert.equal(cn.amount, Math.round(6 * cartonPriceFor(YOGHURT, 'CLASS A (GHS)') * 0.25 * 100) / 100, '6 cartons at 25% of the selling price');
  assert.equal(cn.rep_name, 'Kwame Asante');
  const lot2 = visitSheet(db, 'rep-1', CUST, { today: TODAY }).lots.find((l) => l.barcode === 'ALMRFCHMNT112');
  recordVisit(db, 'rep-1', CUST, [{ key: lot2.key, cartonsOnShelf: 2, outcome: 'DISCOUNT_AGREED', discountPct: 10, contactName: 'Ama', agreed: true }], { today: TODAY });
  const id2 = db.prepare('SELECT id FROM shelf_visit_lines ORDER BY id DESC LIMIT 1').get().id;
  decideDiscount(db, id2, { decision: 'APPROVE' });
  assert.throws(() => recordCreditNote(db, id2, 'CN-ODOO-77'), (e) => e.status === 409 && /already recorded/.test(e.message));
  assert.equal(db.prepare('SELECT credit_note_ref FROM shelf_visit_lines WHERE id = ?').get(id2).credit_note_ref, null, 'nothing half-saved');
});

test('9. Finance\'s credit note for a return: the goods at the customer\'s price, once per return', () => {
  const db = freshDb();
  const { id } = returnLot(db, { cartons: 4 });
  const cn = issueReturnCreditNote(db, id);
  assert.match(cn.number, /^CN\/\d{4}\/0001$/);
  assert.equal(cn.amount, Math.round(4 * cartonPriceFor(YOGHURT, 'CLASS A (GHS)') * 100) / 100);
  assert.throws(() => issueReturnCreditNote(db, id), /already issued/);
  assert.throws(() => issueReturnCreditNote(db, 9999), (e) => e.status === 404);
  assert.equal(listReturns(db, TODAY).unclassified[0].creditNotes[0].number, cn.number);
});

test('10. a return of a BFL order lowers what the customer owes', () => {
  const db = freshDb();
  const ts = new Date().toISOString();
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('t.xlsx','COMPLETED',?,?,?)").run(ts, ts, ts);
  db.prepare('INSERT INTO products (barcode, name, box_uom, free_to_use, on_hand, odoo_category_path, is_active, created_at, updated_at) VALUES (?,?,?,?,?,?,1,?,?)').run('555', 'TEST TINS', 'CTN12', 500, 500, 'FOOD / TINS', ts, ts);
  const cid = Number(db.prepare("INSERT INTO customers (name, pricelist, customer_type, salesperson, is_active, created_at, updated_at) VALUES ('Kofi Traders', 'CLASS A (GHS)', 'CREDIT', 'Kwame Asante', 1, ?, ?)").run(ts, ts).lastInsertRowid);
  const r = submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 10 }], customerId: cid, onInsert: (rid) => createOrderForRequest(db, rid) });
  const oid = db.prepare('SELECT id FROM odoo_orders WHERE request_id = ?').get(r.requestId).id;
  sendQuotation(db, oid); confirmOrder(db, oid); validateDelivery(db, oid); const inv = postInvoice(db, oid);
  const opt = returnOptions(db, TODAY).find((o) => o.id === `ORDER:${oid}:555`);
  assert.equal(opt.left, 10);
  const made = createReturn(db, { optionId: opt.id, cartons: 4 }, TODAY);
  const cn = issueReturnCreditNote(db, made.id);
  assert.equal(cn.amount, Math.round(4 * cartonPriceFor('555', 'CLASS A (GHS)') * 100) / 100);
  const due = db.prepare('SELECT amount_due FROM odoo_invoices WHERE number = ?').get('INV/' + new Date().getUTCFullYear() + '/0001').amount_due;
  assert.equal(due, Math.round((inv.amount - cn.amount) * 100) / 100);
  assert.equal(db.prepare('SELECT amount_owed FROM odoo_customer_finance WHERE customer_id = ?').get(cid).amount_owed, due, 'the balance follows');
  assert.equal(db.prepare('SELECT rep_name FROM odoo_returns WHERE id = ?').get(made.id).rep_name, 'Kwame Asante');
});

// ===========================================================================
// over the web
// ===========================================================================
test('11. the warehouse decides the reason; a Sales Manager reads; a rep cannot open Returns', async () => {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.BFL_STAFF_USERNAME = 'owner'; process.env.BFL_STAFF_PASSWORD = 'owner-secret-passphrase'; process.env.BFL_SESSION_SECRET = 'y'.repeat(40);
  try {
    const db = freshDb();
    const { id } = returnLot(db, { cartons: 2, daysAgo: 5 });
    const staff = await import('../src/domain/staff-accounts.js');
    const { resetStaffAttempts } = await import('../src/server/staff-auth.js');
    for (const role of ['SALES_MANAGER', 'SALES_REP', 'WAREHOUSE']) {
      const { user, temporaryPassword } = staff.createStaffUser(db, { name: role, email: `${role.toLowerCase()}@bfl.test`, role, repId: role === 'SALES_REP' ? 'rep-1' : undefined }, 'ADMIN');
      staff.changeStaffPassword(db, user.id, temporaryPassword, 'a long enough password');
    }
    const server = http.createServer(createApp(db));
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const login = async (email) => {
      resetStaffAttempts();
      const res = await fetch(`${base}/api/staff/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'a long enough password' }) });
      return res.headers.getSetCookie().join('; ').split(';')[0];
    };
    try {
      const wh = await login('warehouse@bfl.test'); const mgr = await login('sales_manager@bfl.test'); const rep = await login('sales_rep@bfl.test');
      const req = (path, cookie, method = 'GET', body) => fetch(base + path, { method, headers: { cookie, origin: base, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      assert.equal((await req('/api/returns', rep)).status, 403);
      assert.equal((await req('/api/returns', mgr)).status, 200, 'a Sales Manager can read');
      assert.equal((await req(`/api/returns/${id}/classify`, mgr, 'POST', { reason: 'EXPIRED' })).status, 403, 'but cannot decide the reason');
      assert.equal((await req(`/api/returns/${id}/classify`, rep, 'POST', { reason: 'EXPIRED' })).status, 403);
      assert.equal((await (await req('/api/returns/alert', wh)).json()).overdue, 1);
      assert.equal((await req(`/api/returns/${id}/classify`, wh, 'POST', { reason: 'NOPE' })).status, 400);
      assert.equal((await req(`/api/returns/${id}/classify`, wh, 'POST', { reason: 'EXPIRED' })).status, 200);
      assert.equal((await (await req('/api/returns/alert', wh)).json()).overdue, 0);
      assert.equal((await (await req('/api/returns', wh)).json()).classified[0].classifiedBy, 'WAREHOUSE');
      // the stand-in for Odoo's side is not the warehouse's to use
      assert.equal((await req('/api/sample-odoo/return-options', wh)).status, 403);
      assert.equal((await req('/api/sample-odoo/return-options', mgr)).status, 200);
    } finally { server.close(); }
  } finally { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; }
});

test('12. the Sample Odoo return routes create, credit and stop when Odoo is connected', async () => {
  const db = freshDb();
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', origin: base }, body: JSON.stringify(body || {}) });
  try {
    const { options } = await (await fetch(`${base}/api/sample-odoo/return-options`)).json();
    const opt = options.find((o) => o.id.includes(YOGHURT));
    const made = await post('/api/sample-odoo/returns', { optionId: opt.id, cartons: 2 });
    assert.equal(made.status, 201);
    const { id } = await made.json();
    assert.equal((await post('/api/sample-odoo/returns', { optionId: opt.id, cartons: 99 })).status, 400);
    assert.equal((await post(`/api/sample-odoo/returns/${id}/credit-note`)).status, 200);
    assert.equal((await post(`/api/sample-odoo/returns/${id}/credit-note`)).status, 409);
    const overview = await (await fetch(`${base}/api/sample-odoo`)).json();
    assert.equal(overview.returns[0].creditNote.startsWith('CN/'), true);
    assert.equal((await post('/api/sample-odoo/history')).status, 400, 'no customers to build history for');
    process.env.BFL_ODOO_CONNECTED = '1';
    try { assert.equal((await post('/api/sample-odoo/returns', { optionId: opt.id, cartons: 1 })).status, 404); } finally { delete process.env.BFL_ODOO_CONNECTED; }
  } finally { server.close(); }
});

test('13. the returns code reads no cost data and deletes nothing', () => {
  for (const f of ['src/domain/returns.js', 'src/server/routes/returns.js']) {
    const src = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.ok(!/standard_price|cost_price|\bcost\b|valuation|supplier_price/i.test(src), f);
    assert.ok(!/\bDELETE\s+FROM\b/i.test(src), `${f} must not delete rows`);
  }
});
