// Customer list import — preview, explicit confirm, and safe re-import.
//
// Identity in this phase is the DISPLAY NAME (no Odoo API, no Odoo customer id).
// The risks worth testing: creating duplicate customers on re-import, importing
// rows that should have been refused, and leaking staff-only fields (email, phone,
// country, and especially pricelist) to the customer-facing API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import { freshDb, tmpUploads } from './helpers.js';
import {
  createCustomerPreview, confirmCustomerImport, readCustomerFile,
  listCustomerImports, CustomerImportServiceError,
} from '../src/import/customer-service.js';
import { searchCustomers, customerHandle, customerKey, resolveCustomerHandle, importCustomers } from '../src/domain/customers.js';
import { submitRequest, getRequest, listRequests, customerTypeOf, CustomerType } from '../src/domain/requests.js';
import { createApp } from '../src/server/index.js';
import { issueAccessCode } from '../src/domain/access-codes.js';

const REAL_FILE = 'C:/Users/lenovo/Downloads/Contact (res.partner) (1).xlsx';
const HEADERS = ['Avatar 128', 'Display Name', 'Email', 'Pricelist', 'Phone', 'Activities', 'Country', 'Stats'];

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

/**
 * Sign in as a customer with their access code and return the session cookie.
 *
 * Requests can no longer be submitted without one: the browser used to name the
 * customer (by opaque handle, or by typing an unlisted company), and now the
 * server derives it from this signed session instead.
 */
async function asCustomer(base, db, customerId) {
  const code = issueAccessCode(db, customerId);
  const res = await fetch(`${base}/api/catalog/access`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', origin: base },
    body: JSON.stringify({ code }),
  });
  assert.equal(res.status, 200, 'the access code should be accepted');
  return (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];
}

/** Build a contact workbook shaped exactly like the real Odoo export. */
function writeContacts(rows) {
  const ws = xlsx.utils.json_to_sheet(rows.map((r) => ({
    'Avatar 128': 'PD94bWxBLOB',
    'Display Name': r.name,
    Email: r.email ?? null,
    Pricelist: r.pricelist ?? 'CLASS A (GHS)',
    Phone: r.phone ?? null,
    Activities: null,
    Country: r.country ?? 'Ghana',
    Stats: '[{"label":"Opportunities"}]',
  })), { header: HEADERS });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-cust-')), 'contacts.xlsx');
  xlsx.writeFile(wb, f);
  return f;
}

const preview = (db, rows) => createCustomerPreview(db, writeContacts(rows), 'contacts.xlsx', { uploadsDir: tmpUploads() });
const custCount = (db) => db.prepare('SELECT COUNT(*) n FROM customers').get().n;

// ===========================================================================
// 1. Parsing
// ===========================================================================
test('1. the contact export parses, reading only the allowed columns', () => {
  const file = writeContacts([{ name: 'Melcom Ltd', email: 'a@b.com', phone: '0540', country: 'Ghana' }]);
  const { records, mapping, ignored } = readCustomerFile(file);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    odoo_customer_ref: null, name: 'Melcom Ltd', email: 'a@b.com',
    phone: '0540', country: 'Ghana', pricelist: 'CLASS A (GHS)',
  });
  assert.equal(mapping.name, 'Display Name');
  for (const bad of ['Avatar 128', 'Activities', 'Stats']) {
    assert.ok(ignored.includes(bad), `${bad} must be ignored`);
  }
});

test('values are normalised only where safe', () => {
  const file = writeContacts([{ name: '  Melcom Ltd  ', phone: '  0540 123  ', email: ' a@b.com ', country: '  Ghana ' }]);
  const r = readCustomerFile(file).records[0];
  assert.equal(r.name, 'Melcom Ltd', 'trimmed, not otherwise altered');
  assert.equal(r.phone, '0540 123', 'internal spacing preserved; stays a string');
  assert.equal(r.email, 'a@b.com');
  assert.equal(r.country, 'Ghana');
});

test('awkward real-world phone values survive as strings', () => {
  const file = writeContacts([
    { name: 'A Co', phone: '0' }, { name: 'B Co', phone: 'Office' },
    { name: 'C Co', phone: '0244852000 / 0244858532' }, { name: 'D Co', phone: null },
  ]);
  const r = readCustomerFile(file).records;
  assert.equal(r[0].phone, '0', 'not coerced to a number or dropped');
  assert.equal(r[1].phone, 'Office');
  assert.equal(r[2].phone, '0244852000 / 0244858532');
  assert.equal(r[3].phone, null, 'missing stays missing — nothing invented');
});

test('a file without a name column is refused', () => {
  const ws = xlsx.utils.json_to_sheet([{ Phone: '024', Country: 'Ghana' }]);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-bad-')), 'x.xlsx');
  xlsx.writeFile(wb, f);
  assert.throws(() => readCustomerFile(f), (e) => e instanceof CustomerImportServiceError && /Display Name/.test(e.message));
});

// ===========================================================================
// 2 & 3. Validation and duplicates
// ===========================================================================
test('2. a row with no customer name is invalid and is not imported', () => {
  const db = freshDb();
  const { batchId, preview: p } = preview(db, [{ name: 'Good Co' }, { name: '' }]);
  assert.equal(p.summary.total_rows, 2);
  assert.equal(p.summary.valid_rows, 1);
  assert.equal(p.summary.invalid_rows, 1);
  assert.match(p.errorRows[0].errors[0], /Missing customer name/);

  confirmCustomerImport(db, batchId);
  assert.equal(custCount(db), 1, 'only the valid row landed');
  db.close();
});

test('3. duplicate rows within the file are detected and only one customer is created', () => {
  const db = freshDb();
  const { batchId, preview: p } = preview(db, [
    { name: 'Melcom Ltd' }, { name: 'Melcom Ltd' }, { name: '  melcom   ltd ' }, { name: 'Other Co' },
  ]);
  assert.equal(p.summary.duplicate_rows, 2, 'case/spacing-insensitive duplicate detection');
  assert.equal(p.summary.new_count, 2);
  confirmCustomerImport(db, batchId);
  assert.equal(custCount(db), 2, 'one Melcom, one Other');
  db.close();
});

test('3b. the duplicate guard inside importCustomers holds ON ITS OWN', () => {
  // Two layers stop a duplicate: the preview marks it an error, and confirm filters
  // error rows out before applying. That masks the guard inside importCustomers
  // itself. Calling it directly — as any future caller might — leaves that guard
  // as the only thing standing.
  const db = freshDb();
  importCustomers(db, [
    { name: 'Melcom Ltd', phone: '0540' },
    { name: 'Melcom Ltd', phone: '0999' },   // same customer, second row
    { name: '  melcom   ltd ', phone: '0111' },
  ]);
  assert.equal(custCount(db), 1, 'one customer, not three');
  db.close();
});

// ===========================================================================
// 5 & 6. Preview, then explicit apply
// ===========================================================================
test('5. generating a preview writes NO customer rows', () => {
  const db = freshDb();
  const { batchId } = preview(db, [{ name: 'A Co' }, { name: 'B Co' }]);
  assert.equal(custCount(db), 0, 'preview must not import anything');
  const batch = db.prepare('SELECT status FROM customer_imports WHERE id=?').get(batchId);
  assert.equal(batch.status, 'PREVIEW');
  db.close();
});

test('6. confirming applies the import and records the audit', () => {
  const db = freshDb();
  const { batchId } = preview(db, [
    { name: 'Melcom Ltd', email: 'm@x.com', phone: '0540', country: 'Ghana', pricelist: 'CLASS A (GHS)' },
  ]);
  const r = confirmCustomerImport(db, batchId);
  assert.equal(r.counts.created, 1);

  const c = db.prepare('SELECT * FROM customers').get();
  assert.equal(c.name, 'Melcom Ltd');
  assert.equal(c.email, 'm@x.com');
  assert.equal(c.phone, '0540');
  assert.equal(c.country, 'Ghana');
  assert.equal(c.pricelist, 'CLASS A (GHS)');
  assert.equal(c.odoo_customer_ref, null, 'no Odoo id invented');

  const audit = db.prepare('SELECT * FROM customer_imports WHERE id=?').get(batchId);
  assert.equal(audit.status, 'COMPLETED');
  assert.ok(audit.confirmed_at);
  assert.equal(audit.new_count, 1);
  assert.equal(listCustomerImports(db).length, 1);
  db.close();
});

test('a batch cannot be applied twice', () => {
  const db = freshDb();
  const { batchId } = preview(db, [{ name: 'A Co' }]);
  confirmCustomerImport(db, batchId);
  assert.throws(() => confirmCustomerImport(db, batchId), (e) => /already been applied/.test(e.message));
  assert.equal(custCount(db), 1);
  db.close();
});

// ===========================================================================
// 7. Safe re-import
// ===========================================================================
test('7. re-importing the same file creates no duplicates', () => {
  const db = freshDb();
  const rows = [{ name: 'Melcom Ltd', phone: '0540' }, { name: 'Shoprite', phone: '0241' }];
  confirmCustomerImport(db, preview(db, rows).batchId);
  assert.equal(custCount(db), 2);

  const second = preview(db, rows);
  assert.equal(second.preview.summary.new_count, 0, 'preview says nothing is new');
  assert.equal(second.preview.summary.unchanged_count, 2);
  const r = confirmCustomerImport(db, second.batchId);
  assert.equal(r.counts.created, 0);
  assert.equal(r.counts.unchanged, 2);
  assert.equal(custCount(db), 2, 'still two customers');
  db.close();
});

test('7b. a changed field updates in place rather than creating a second record', () => {
  const db = freshDb();
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd', phone: '0540' }]).batchId);
  const p = preview(db, [{ name: 'Melcom Ltd', phone: '0999', country: 'Togo' }]);
  assert.equal(p.preview.summary.updated_count, 1);
  confirmCustomerImport(db, p.batchId);
  assert.equal(custCount(db), 1);
  const c = db.prepare('SELECT * FROM customers').get();
  assert.equal(c.phone, '0999');
  assert.equal(c.country, 'Togo');
  db.close();
});

test('7c. a customer missing from a later file is NOT deactivated by default', () => {
  const db = freshDb();
  confirmCustomerImport(db, preview(db, [{ name: 'A Co' }, { name: 'B Co' }]).batchId);
  confirmCustomerImport(db, preview(db, [{ name: 'A Co' }]).batchId);
  assert.equal(db.prepare("SELECT is_active FROM customers WHERE name='B Co'").get().is_active, 1,
    'a partial export must not silently hide customers');
  assert.equal(custCount(db), 2, 'nothing deleted');
  db.close();
});

// ===========================================================================
// 4. The real 355-row file
// ===========================================================================
test('4. the real 355-row contact file parses and previews', { skip: !fs.existsSync(REAL_FILE) && 'real file not present' }, () => {
  const db = freshDb();
  const { records, ignored } = readCustomerFile(REAL_FILE);
  assert.equal(records.length, 355);
  assert.ok(records.every((r) => r.name), 'every row has a display name');
  for (const bad of ['Avatar 128', 'Activities', 'Stats']) assert.ok(ignored.includes(bad));

  const { preview: p } = createCustomerPreview(db, REAL_FILE, 'Contact (res.partner) (1).xlsx', { uploadsDir: tmpUploads() });
  assert.equal(p.summary.total_rows, 355);
  assert.equal(p.summary.invalid_rows, 0, 'no invalid rows in the real file');
  assert.equal(p.summary.duplicate_rows, 0, 'display names are unique');
  assert.equal(p.summary.new_count, 355, 'all new against an empty customer list');
  assert.equal(custCount(db), 0, 'PREVIEW ONLY — nothing imported');
  db.close();
});

// ===========================================================================
// 8, 9, 10. Search, selection, and the new-customer path
// ===========================================================================
test('8. imported customers are searchable, name + opaque handle only', () => {
  const db = freshDb();
  confirmCustomerImport(db, preview(db, [
    { name: 'Melcom Ltd', email: 'm@x.com', phone: '0540000000', country: 'Ghana', pricelist: 'CLASS A (GHS)' },
    { name: 'Melcom Branch Two' }, { name: 'Shoprite Ghana' },
  ]).batchId);

  assert.deepEqual(searchCustomers(db, 'me').items, [], 'below the minimum length');
  const hits = searchCustomers(db, 'melcom').items;
  assert.equal(hits.length, 2);
  assert.deepEqual(Object.keys(hits[0]).sort(), ['handle', 'name']);
  const text = JSON.stringify(hits);
  for (const bad of ['0540000000', 'm@x.com', 'Ghana', 'CLASS A', 'GHS']) {
    assert.ok(!text.includes(bad), `search leaked ${bad}`);
  }
  db.close();
});

test('9. an existing customer can be selected and linked to a request', () => {
  const db = freshDb();
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  const { handle } = searchCustomers(db, 'Melcom').items[0];

  const match = resolveCustomerHandle(db, handle);
  assert.ok(match, 'handle resolves');
  assert.equal(match.name, 'Melcom Ltd');
  assert.equal(resolveCustomerHandle(db, 'forged-handle'), null);
  // the internal id is never a valid handle
  assert.equal(resolveCustomerHandle(db, String(match.id)), null);
  db.close();
});

test('9b. a customer with no Odoo id still gets a stable, opaque handle', () => {
  const db = freshDb();
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  const c = db.prepare('SELECT * FROM customers').get();
  assert.equal(c.odoo_customer_ref, null);

  const h = customerHandle(customerKey(c));
  assert.ok(h && h.length >= 16);
  assert.equal(searchCustomers(db, 'Melcom').items[0].handle, h, 'search issues the same handle');
  assert.equal(customerHandle(customerKey(c)), h, 'stable across calls — a reload keeps working');
  assert.ok(!h.includes(String(c.id)), 'the internal id is not readable from the handle');
  db.close();
});

test('10. the new-customer path still works when the customer is not in the list', () => {
  const db = freshDb();
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  assert.deepEqual(searchCustomers(db, 'Brand New Trading').items, [], 'not in the list');
  const before = custCount(db);
  // the unlisted path is exercised against products in requests.test.js; here we
  // assert the customer master is untouched by it
  assert.equal(custCount(db), before, 'searching for an absent customer creates nothing');
  db.close();
});

// ===========================================================================
// Security
// ===========================================================================
test('the customer API never exposes email, phone, country or pricelist', async () => {
  const db = freshDb();
  confirmCustomerImport(db, preview(db, [
    { name: 'Melcom Ltd', email: 'secret@x.com', phone: '0540000000', country: 'Ghana', pricelist: 'CLASS A (GHS)' },
  ]).batchId);
  const { server, base } = await startApp(db);
  try {
    const text = await (await fetch(`${base}/api/catalog/customers?q=melcom`)).text();
    for (const bad of ['secret@x.com', '0540000000', 'Ghana', 'CLASS A', 'GHS', 'pricelist', 'email', 'country', 'phone']) {
      assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), `customer search leaked "${bad}"`);
    }
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// Route wiring. These exist because the UI once 404'd on the history endpoint:
// the route and the client agreed, but the running server predated the router,
// so nothing in the suite noticed. Asserting the mount over real HTTP catches
// both a renamed route and a router that was never wired into the app.
// ===========================================================================
test('the customer import history endpoint EXISTS and does not 404', async () => {
  const db = freshDb();
  const { server, base } = await startApp(db);
  try {
    const res = await fetch(`${base}/api/customer-imports`);
    assert.notEqual(res.status, 404, 'the history route must be mounted');
    assert.equal(res.status, 200);
  } finally { server.close(); }
  db.close();
});

test('empty customer import history returns a valid empty result', async () => {
  const db = freshDb();
  const { server, base } = await startApp(db);
  try {
    const res = await fetch(`${base}/api/customer-imports`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.items), 'items is an array');
    assert.equal(body.items.length, 0, 'empty, not an error and not a mock');
  } finally { server.close(); }
  db.close();
});

test('after an import, history returns the real persisted record', async () => {
  const db = freshDb();
  const { batchId } = preview(db, [{ name: 'Melcom Ltd' }, { name: 'Shoprite' }]);
  confirmCustomerImport(db, batchId);

  const { server, base } = await startApp(db);
  try {
    const { items } = await (await fetch(`${base}/api/customer-imports`)).json();
    assert.equal(items.length, 1, 'the applied import appears in history');
    const b = items[0];
    assert.equal(b.id, batchId);
    assert.equal(b.filename, 'contacts.xlsx');
    assert.equal(b.status, 'COMPLETED');
    assert.equal(b.total_rows, 2);
    assert.equal(b.new_count, 2);
    assert.ok(b.confirmed_at, 'real timestamp from the database');

    // and it is genuinely persisted, not assembled in the route
    const stored = db.prepare('SELECT * FROM customer_imports WHERE id=?').get(batchId);
    assert.equal(stored.status, 'COMPLETED');
    assert.equal(stored.total_rows, 2);

    // detail route resolves too
    const detail = await (await fetch(`${base}/api/customer-imports/${batchId}`)).json();
    assert.equal(detail.batch.id, batchId);
    assert.equal(detail.preview.summary.total_rows, 2);
    assert.equal((await fetch(`${base}/api/customer-imports/9999`)).status, 404, 'unknown id still 404s');
  } finally { server.close(); }
  db.close();
});

test('a PREVIEW appears in history before it is applied', async () => {
  const db = freshDb();
  const { batchId } = preview(db, [{ name: 'A Co' }]);
  const { server, base } = await startApp(db);
  try {
    const { items } = await (await fetch(`${base}/api/customer-imports`)).json();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'PREVIEW', 'visible but not applied');
    assert.equal(items[0].confirmed_at, null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 0, 'still no customers');
  } finally { server.close(); }
  db.close();
});

test('the PRODUCT import history route is unaffected', async () => {
  const db = freshDb();
  const { server, base } = await startApp(db);
  try {
    const res = await fetch(`${base}/api/imports`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).items));
    // a customer import must never show up in the product audit
    confirmCustomerImport(db, preview(db, [{ name: 'A Co' }]).batchId);
    const after = await (await fetch(`${base}/api/imports`)).json();
    assert.equal(after.items.length, 0, 'product import history stays empty');
  } finally { server.close(); }
  db.close();
});

test('the customer-import endpoints are not reachable under /api/catalog', async () => {
  const db = freshDb();
  const { server, base } = await startApp(db);
  try {
    assert.equal((await fetch(`${base}/api/catalog/customer-imports`)).status, 404);
    assert.equal((await fetch(`${base}/api/customer-imports`)).status, 200, 'staff route exists');
  } finally { server.close(); }
  db.close();
});

// ===========================================================================
// Customer type on the staff request screen.
//
// There are exactly two paths, EXISTING and NEW, decided by whether the request
// links to the customer master. The earlier wording ("not in customer master",
// "match them to an Odoo customer") described work that does not exist in this
// phase — there is no Odoo API and no Odoo id is required — so a New Customer
// must read as a complete outcome, not a problem.
// ===========================================================================
function seedProductAndBatch(db) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO products (barcode,name,box_uom,free_to_use,is_active,created_at,updated_at)
     VALUES ('555','Test Product','CTN12',20,1,?,?)`
  ).run(now, now);
  db.prepare("INSERT INTO import_batches (filename, imported_at, status, completed_at) VALUES ('x',?,'COMPLETED',?)")
    .run(now, now);
}

test('CT1. an EXISTING customer request reports EXISTING CUSTOMER', () => {
  // Regression: the 355 imported customers have NO Odoo ref, so identifying a
  // selected customer by odoo_customer_ref alone made this path impossible — a
  // handle resolved to a real customer, then the request was rejected as having
  // no customer details. Selection keys on the internal id.
  const db = freshDb();
  seedProductAndBatch(db);
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd', phone: '0540' }]).batchId);
  const { handle } = searchCustomers(db, 'Melcom').items[0];
  const match = resolveCustomerHandle(db, handle);
  assert.equal(match.odoo_customer_ref, null, 'precondition: imported customers carry no Odoo id');

  const res = submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 1 }], customerId: match.id });
  const { request, customer } = getRequest(db, res.requestId);
  assert.equal(request.customer_id, match.id, 'linked to the customer master');
  assert.equal(customer.type, 'EXISTING_CUSTOMER');
  assert.equal(customer.label, 'EXISTING CUSTOMER');
  assert.equal(customer.displayName, 'Melcom Ltd');
  db.close();
});

test('CT1b. selecting an existing customer works END-TO-END over HTTP', async () => {
  const db = freshDb();
  seedProductAndBatch(db);
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  const { server, base } = await startApp(db);
  try {
    const customer = db.prepare('SELECT id FROM customers WHERE name = ?').get('Melcom Ltd');
    const cookie = await asCustomer(base, db, customer.id);
    const res = await fetch(`${base}/api/catalog/requests`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', origin: base, cookie },
      body: JSON.stringify({ lines: [{ barcode: '555', quantityCtn: 1 }] }),
    });
    assert.equal(res.status, 201, 'an existing customer can submit a request');
    const list = await (await fetch(`${base}/api/requests`)).json();
    assert.equal(list.items[0].customer.type, 'EXISTING_CUSTOMER');
    assert.equal(list.items[0].customer.displayName, 'Melcom Ltd');
  } finally { server.close(); }
  db.close();
});

test('CT2. a NEW customer request reports NEW CUSTOMER with the captured details', () => {
  const db = freshDb();
  seedProductAndBatch(db);
  const res = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 2 }],
    unlisted: { company: 'M.H company', contact: 'Mouslem Hammoud', phone: '+233504060009' },
  });

  const { request, customer } = getRequest(db, res.requestId);
  assert.equal(customer.type, 'NEW_CUSTOMER');
  assert.equal(customer.label, 'NEW CUSTOMER');
  assert.equal(customer.displayName, 'M.H company · Mouslem Hammoud');
  assert.equal(customer.company, 'M.H company');
  assert.equal(customer.contact, 'Mouslem Hammoud');
  assert.equal(customer.phone, '+233504060009', 'staff can see the captured phone');
  assert.equal(request.customer_id, null, 'not linked to the customer master — and that is fine');
  db.close();
});

test('CT3. the customer type is derived from the link, not from a stale flag', () => {
  const db = freshDb();
  seedProductAndBatch(db);
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  const c = db.prepare('SELECT * FROM customers').get();

  assert.equal(customerTypeOf({ customer_id: c.id }), CustomerType.EXISTING);
  assert.equal(customerTypeOf({ customer_id: null }), CustomerType.NEW);
  // the legacy needs_customer_match flag must not drive the label either way
  assert.equal(customerTypeOf({ customer_id: c.id, needs_customer_match: 1 }), CustomerType.EXISTING);
  assert.equal(customerTypeOf({ customer_id: null, needs_customer_match: 0 }), CustomerType.NEW);
  db.close();
});

test('CT4 & CT5. no Odoo matching is required and no "customer master" wording is produced', async () => {
  const db = freshDb();
  seedProductAndBatch(db);
  const res = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 1 }],
    unlisted: { company: 'M.H company', contact: 'Mouslem Hammoud', phone: '+233504060009' },
  });
  const { server, base } = await startApp(db);
  try {
    for (const url of ['/api/requests', `/api/requests/${res.requestId}`]) {
      const text = await (await fetch(base + url)).text();
      for (const gone of ['not in customer master', 'Match them to an Odoo', 'match to Odoo', 'Not in Odoo']) {
        assert.ok(!text.toLowerCase().includes(gone.toLowerCase()), `${url} still says "${gone}"`);
      }
      assert.ok(text.includes('NEW CUSTOMER'), `${url} reports the customer type`);
    }
    // a New Customer requires no Odoo id, and none is invented
    const detail = await (await fetch(`${base}/api/requests/${res.requestId}`)).json();
    assert.equal(detail.request.odoo_customer_ref ?? null, null);
    assert.equal(detail.customer.type, 'NEW_CUSTOMER');
  } finally { server.close(); }
  db.close();
});

test('CT6. the staff list reports a customer type for every request', async () => {
  const db = freshDb();
  seedProductAndBatch(db);
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  const { handle } = searchCustomers(db, 'Melcom').items[0];

  submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 1 }], unlisted: { company: 'New Co', contact: 'A', phone: '0240000000' } });
  submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 1 }], customerId: resolveCustomerHandle(db, handle).id });

  const { items } = listRequests(db);
  assert.equal(items.length, 2);
  for (const r of items) {
    assert.ok(['EXISTING_CUSTOMER', 'NEW_CUSTOMER'].includes(r.customer.type));
    assert.ok(r.customer.label);
    assert.ok(r.customer.displayName, 'every request names its customer');
  }
  db.close();
});

// ===========================================================================
// Delivery address — optional, New Customer path only.
// Captured now because New Customers will later support Cash on Delivery.
// ===========================================================================
test('DA1. a New Customer WITHOUT an address still submits', () => {
  const db = freshDb();
  seedProductAndBatch(db);
  const res = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 1 }],
    unlisted: { contact: 'Mouslem Hammoud', phone: '+233504060009' },
  });
  const { request, customer } = getRequest(db, res.requestId);
  assert.equal(request.delivery_address, null, 'optional — stays null');
  assert.equal(customer.type, 'NEW_CUSTOMER');
  assert.equal(customer.deliveryAddress, null);
  db.close();
});

test('DA1b. company is optional; name and phone are required', () => {
  const db = freshDb();
  seedProductAndBatch(db);
  // no company at all — an individual customer
  const res = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 1 }],
    unlisted: { contact: 'Mouslem Hammoud', phone: '+233504060009' },
  });
  assert.ok(res.reference);
  assert.equal(getRequest(db, res.requestId).customer.displayName, 'Mouslem Hammoud');

  assert.throws(() => submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 1 }], unlisted: { contact: 'X' } }),
    /Customer details are required/, 'phone required');
  assert.throws(() => submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 1 }], unlisted: { phone: '024' } }),
    /Customer details are required/, 'name required');
  db.close();
});

test('DA2. an address supplied by a New Customer is stored verbatim', () => {
  const db = freshDb();
  seedProductAndBatch(db);
  const address = 'Plot 14, Spintex Road\nAccra, Greater Accra\nnear the Shell station';
  const res = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 1 }],
    unlisted: { company: 'M.H company', contact: 'Mouslem Hammoud', phone: '+233504060009', address },
  });
  const { request } = getRequest(db, res.requestId);
  assert.equal(request.delivery_address, address, 'multi-line address preserved exactly');
  db.close();
});

test('DA3. the address reaches the staff request view', async () => {
  const db = freshDb();
  seedProductAndBatch(db);
  const address = '12 Independence Ave, Accra';
  const res = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 1 }],
    unlisted: { company: 'M.H company', contact: 'Mouslem Hammoud', phone: '+233504060009', address },
  });
  const { server, base } = await startApp(db);
  try {
    const detail = await (await fetch(`${base}/api/requests/${res.requestId}`)).json();
    assert.equal(detail.request.delivery_address, address);
    assert.equal(detail.customer.deliveryAddress, address);
    assert.equal(detail.customer.type, 'NEW_CUSTOMER');
  } finally { server.close(); }
  db.close();
});

test('DA4. the address is NOT exposed through any customer-facing endpoint', async () => {
  const db = freshDb();
  seedProductAndBatch(db);
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  const address = 'SECRET-ADDRESS-MARKER, Accra';
  const res = await (async () => {
    const { server, base } = await startApp(db);
    try {
      // A company with no code supplies its address when ASKING for access. That
      // is now the only customer-facing way an address is captured.
      const r = await fetch(`${base}/api/catalog/access-requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', origin: base },
        body: JSON.stringify({ contact: 'Mouslem', phone: '024', address }),
      });
      assert.equal(r.status, 201);
      const receipt = await r.text();
      assert.ok(!receipt.includes('SECRET-ADDRESS-MARKER'), 'the acknowledgement must not echo the address');

      // nor anywhere else a customer can reach, signed in or not
      const customer = db.prepare('SELECT id FROM customers WHERE name = ?').get('Melcom Ltd');
      const cookie = await asCustomer(base, db, customer.id);
      for (const url of ['/api/catalog/requests/stock-status', '/api/catalog/products?limit=5',
        '/api/catalog/access']) {
        for (const headers of [{}, { cookie }]) {
          const t = await (await fetch(base + url, { headers })).text();
          assert.ok(!t.includes('SECRET-ADDRESS-MARKER'), `${url} leaked the address`);
          assert.ok(!t.includes('delivery_address'), `${url} leaked the field name`);
        }
      }
      return true;
    } finally { server.close(); }
  })();
  assert.ok(res);
  db.close();
});

test('DA4b. the customer-search endpoint that enumerated the customer master is GONE', async () => {
  const db = freshDb();
  seedProductAndBatch(db);
  confirmCustomerImport(db, preview(db, [
    { name: 'Melcom Ltd' }, { name: 'Akil Company Limited' }, { name: 'Daddy Ash Limited' },
  ]).batchId);
  const { server, base } = await startApp(db);
  try {
    // This endpoint let anyone holding the public catalog link type letters and
    // read back real company names. It must not come back.
    for (const url of ['/api/catalog/customers?q=lim', '/api/catalog/customers?q=melcom',
      '/api/catalog/customers']) {
      const r = await fetch(base + url);
      assert.equal(r.status, 404, `${url} must not exist`);
      const body = await r.text();
      for (const name of ['Melcom', 'Akil', 'Daddy Ash']) {
        assert.ok(!body.includes(name), `${url} leaked "${name}"`);
      }
    }
    // and no other customer-facing route answers with a customer name either
    for (const url of ['/api/catalog/products?limit=50', '/api/catalog/requests/stock-status',
      '/api/catalog/access']) {
      const body = await (await fetch(base + url)).text();
      for (const name of ['Melcom', 'Akil', 'Daddy Ash']) {
        assert.ok(!body.includes(name), `${url} leaked "${name}"`);
      }
    }
  } finally { server.close(); }
  db.close();
});

test('DA5. an existing customer carries their stored address onto each request', () => {
  const db = freshDb();
  seedProductAndBatch(db);
  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);
  const match = db.prepare('SELECT id FROM customers WHERE name = ?').get('Melcom Ltd');

  // An imported customer has no address, and must NOT be blocked by that — the
  // address requirement applies to a company ASKING for access, not to the 504
  // already in the master.
  const none = submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 1 }], customerId: match.id });
  assert.equal(getRequest(db, none.requestId).request.delivery_address, null);

  db.prepare('UPDATE customers SET delivery_address = ? WHERE id = ?').run('5 Stored Street, Accra', match.id);

  const stored = submitRequest(db, { lines: [{ barcode: '555', quantityCtn: 1 }], customerId: match.id });
  const r1 = getRequest(db, stored.requestId);
  assert.equal(r1.customer.type, 'EXISTING_CUSTOMER');
  assert.equal(r1.request.delivery_address, '5 Stored Street, Accra', 'the stored address is attached');
  assert.equal(r1.customer.deliveryAddress, '5 Stored Street, Accra', 'and staff can see where it goes');

  // A one-off redirection belongs to THAT request; it must not rewrite the
  // address held on the customer record.
  const redirected = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 1 }],
    customerId: match.id,
    deliveryAddress: '9 Other Road, Tema',
  });
  assert.equal(getRequest(db, redirected.requestId).request.delivery_address, '9 Other Road, Tema');
  assert.equal(
    db.prepare('SELECT delivery_address FROM customers WHERE id = ?').get(match.id).delivery_address,
    '5 Stored Street, Accra',
    'the customer record is unchanged by a one-off delivery',
  );
  db.close();
});

// ===========================================================================
// 11 & 12. Regression
// ===========================================================================
test('11. an existing submitted request remains readable after a customer import', () => {
  const db = freshDb();
  // a request made before any customer existed (the unlisted path)
  db.prepare(
    `INSERT INTO products (barcode,name,box_uom,free_to_use,is_active,created_at,updated_at)
     VALUES ('111','P','CTN12',10,1,?,?)`
  ).run(new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO import_batches (filename, imported_at, status, completed_at) VALUES ('x',?, 'COMPLETED', ?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const res = submitRequest(db, { lines: [{ barcode: '111', quantityCtn: 2 }], unlisted: { company: 'Walk In', contact: 'Ama', phone: '0240000000' } });
  assert.match(res.reference, /^REQ-\d{4}-0001$/);

  confirmCustomerImport(db, preview(db, [{ name: 'Melcom Ltd' }]).batchId);

  const after = getRequest(db, res.requestId);
  assert.equal(after.request.reference, res.reference, 'still readable');
  assert.equal(after.request.unlisted_company, 'Walk In', 'unlinked request untouched by the import');
  assert.equal(after.items.length, 1);
  db.close();
});

test('12. the customer import does not touch products, images or categories', () => {
  const db = freshDb();
  db.prepare(
    `INSERT INTO products (barcode,name,box_uom,free_to_use,is_active,created_at,updated_at)
     VALUES ('222','Prod','CTN24',5,1,?,?)`
  ).run(new Date().toISOString(), new Date().toISOString());
  const before = JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all());

  confirmCustomerImport(db, preview(db, [{ name: 'A Co' }, { name: 'B Co' }]).batchId);

  assert.equal(JSON.stringify(db.prepare('SELECT * FROM products ORDER BY id').all()), before, 'products untouched');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_images').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM categories').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_batches').get().n, 0,
    'customer imports do NOT appear in the product import audit');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_imports').get().n, 1);
  db.close();
});
