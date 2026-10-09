// Per-customer access codes.
//
// What is actually at risk here, in order:
//   1. One customer submitting a request in ANOTHER customer's name.
//   2. The customer master becoming enumerable again.
//   3. A code being guessable, or surviving after it was revoked.
//   4. A code leaking into something a customer can read.
// Every test below exists for one of those four.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { freshDb } from './helpers.js';
import { createApp } from '../src/server/index.js';
import {
  generateAccessCode, normalizeAccessCode, formatAccessCode, issueAccessCode,
  resolveAccessCode, backfillAccessCodes, listCustomerCodes, CODE_ALPHABET, CODE_LENGTH,
} from '../src/domain/access-codes.js';
import {
  createAccessRequest, approveAccessRequest, rejectAccessRequest,
  listAccessRequests, AccessRequestError,
} from '../src/domain/access-requests.js';
import { resetAccessAttempts } from '../src/server/customer-access.js';

// The limiter counts per IP across the whole process, so the rate-limit test
// would otherwise lock out every test that runs after it.
beforeEach(() => resetAccessAttempts());

function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((r) => server.listen(0, () => r({ server, base: `http://127.0.0.1:${server.address().port}` })));
}
const post = (base, path, body, cookie = null) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).join('; ').split(';')[0];

function customer(db, name) {
  const ts = new Date().toISOString();
  return Number(db.prepare(
    'INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)'
  ).run(name, ts, ts).lastInsertRowid);
}

function product(db, barcode = '555', free = 50) {
  const ts = new Date().toISOString();
  // completed_at is what the stock-freshness gate reads; without it every
  // submission would be blocked as stale and these tests would pass for the
  // wrong reason.
  db.prepare(
    `INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at)
     VALUES (?,?,?,?,?)`
  ).run('t.xlsx', 'COMPLETED', ts, ts, ts);
  db.prepare(
    `INSERT INTO products (barcode, name, box_uom, free_to_use, is_active, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?)`
  ).run(barcode, 'TEST PRODUCT', 'CTN12', free, ts, ts);
}

// ---------------------------------------------------------------------------
// 3. the code itself
// ---------------------------------------------------------------------------

test('a generated code avoids characters people confuse when copying it', () => {
  for (let i = 0; i < 300; i += 1) {
    const code = generateAccessCode();
    assert.equal(code.length, CODE_LENGTH);
    for (const ch of code) assert.ok(CODE_ALPHABET.includes(ch), `unexpected character ${ch}`);
    assert.ok(!/[01ILO]/.test(code), `ambiguous character in ${code}`);
  }
});

test('codes do not repeat across a large batch', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i += 1) seen.add(generateAccessCode());
  assert.equal(seen.size, 2000, 'generation should not collide at this volume');
});

test('every symbol in the alphabet is reachable (no modulo bias blind spot)', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i += 1) for (const ch of generateAccessCode()) seen.add(ch);
  assert.equal(seen.size, CODE_ALPHABET.length, 'some symbols are never produced');
});

test('typing is forgiving about case, spaces and dashes — but nothing is substituted', () => {
  assert.equal(normalizeAccessCode('7k2m-9xqr'), '7K2M9XQR');
  assert.equal(normalizeAccessCode('  7K2M 9XQR '), '7K2M9XQR');
  assert.equal(normalizeAccessCode('7K2M–9XQR'), '7K2M9XQR');
  // characters outside the alphabet are DROPPED, never mapped onto another
  // symbol — a mistyped O must not silently become a different valid code
  assert.equal(normalizeAccessCode('7K2MO9XQ'), '7K2M9XQ');
  assert.equal(formatAccessCode('7K2M9XQR'), '7K2M-9XQR');
});

// ---------------------------------------------------------------------------
// 1 & 3. identity, revocation
// ---------------------------------------------------------------------------

test('a code resolves to its own customer and nobody else', () => {
  const db = freshDb();
  const melcom = customer(db, 'Melcom Ltd');
  const akil = customer(db, 'Akil Company Limited');
  const melcomCode = issueAccessCode(db, melcom);
  const akilCode = issueAccessCode(db, akil);

  assert.equal(resolveAccessCode(db, melcomCode).id, melcom);
  assert.equal(resolveAccessCode(db, akilCode).id, akil);
  assert.equal(resolveAccessCode(db, formatAccessCode(melcomCode).toLowerCase()).id, melcom);
  assert.equal(resolveAccessCode(db, 'ZZZZZZZZ'), null);
  assert.equal(resolveAccessCode(db, ''), null);
  assert.equal(resolveAccessCode(db, melcomCode.slice(0, 7)), null, 'a partial code must not resolve');
  db.close();
});

test('reissuing revokes the previous code immediately', () => {
  const db = freshDb();
  const id = customer(db, 'Melcom Ltd');
  const first = issueAccessCode(db, id);
  const second = issueAccessCode(db, id);
  assert.notEqual(first, second);
  assert.equal(resolveAccessCode(db, first), null, 'the old code must stop working');
  assert.equal(resolveAccessCode(db, second).id, id);
  db.close();
});

test('deactivating a customer revokes their access', () => {
  const db = freshDb();
  const id = customer(db, 'Melcom Ltd');
  const code = issueAccessCode(db, id);
  assert.ok(resolveAccessCode(db, code));
  db.prepare('UPDATE customers SET is_active = 0 WHERE id = ?').run(id);
  assert.equal(resolveAccessCode(db, code), null);
  db.close();
});

test('backfill gives every active customer a code and never changes an existing one', () => {
  const db = freshDb();
  const a = customer(db, 'Has One');
  customer(db, 'Needs One');
  customer(db, 'Also Needs One');
  const existing = issueAccessCode(db, a);

  assert.equal(backfillAccessCodes(db), 2, 'only the two without a code');
  assert.equal(resolveAccessCode(db, existing).id, a, 'the existing code must be untouched');
  const all = db.prepare('SELECT access_code FROM customers').all();
  assert.ok(all.every((r) => r.access_code), 'everyone has a code');
  assert.equal(new Set(all.map((r) => r.access_code)).size, 3, 'codes are distinct');

  assert.equal(backfillAccessCodes(db), 0, 'running it again changes nothing');
  db.close();
});

// ---------------------------------------------------------------------------
// 1. the real risk: submitting as someone else
// ---------------------------------------------------------------------------

test('a request cannot be submitted without a code', async () => {
  const db = freshDb();
  product(db);
  customer(db, 'Melcom Ltd');
  const { server, base } = await startApp(db);
  try {
    const res = await post(base, '/api/catalog/requests', { lines: [{ barcode: '555', quantityCtn: 1 }] });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, 'ACCESS_CODE_REQUIRED');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0, 'nothing written');
  } finally { server.close(); }
  db.close();
});

test('a signed-in customer CANNOT submit in another customer\'s name', async () => {
  const db = freshDb();
  product(db);
  const melcom = customer(db, 'Melcom Ltd');
  const akil = customer(db, 'Akil Company Limited');
  const { server, base } = await startApp(db);
  try {
    const entered = await post(base, '/api/catalog/access', { code: issueAccessCode(db, melcom) });
    const cookie = cookieOf(entered);

    // every way the old API let a browser name a customer, attempted at once
    const res = await post(base, '/api/catalog/requests', {
      lines: [{ barcode: '555', quantityCtn: 1 }],
      customerId: akil,
      customerHandle: 'anything',
      customerRef: 'RP-AKIL',
      unlisted: { company: 'Akil Company Limited', contact: 'X', phone: '024' },
    }, cookie);
    assert.equal(res.status, 201);

    const row = db.prepare('SELECT customer_id, unlisted_company FROM requests').get();
    assert.equal(row.customer_id, melcom, 'the request belongs to the code holder, not the body');
    assert.notEqual(row.customer_id, akil);
    assert.equal(row.unlisted_company, null, 'the body cannot smuggle in an unlisted company');
  } finally { server.close(); }
  db.close();
});

test('the session ends with the order, so the next customer must enter their own code', async () => {
  // A salesman carries ONE phone between several customers in a day. If the
  // session outlived the order, the next customer's request would be filed under
  // whoever ordered last.
  const db = freshDb();
  product(db);
  const melcom = customer(db, 'Melcom Ltd');
  const akil = customer(db, 'Akil Company Limited');
  const { server, base } = await startApp(db);
  try {
    const entered = await post(base, '/api/catalog/access', { code: issueAccessCode(db, melcom) });
    const cookie = cookieOf(entered);

    const first = await post(base, '/api/catalog/requests', { lines: [{ barcode: '555', quantityCtn: 1 }] }, cookie);
    assert.equal(first.status, 201, 'the first order goes through');

    // the response itself clears the cookie
    const cleared = (first.headers.getSetCookie?.() || []).join('; ');
    assert.match(cleared, /bfl_customer=;/, 'the submission must clear the session cookie');
    assert.match(cleared, /Max-Age=0/);

    // and the server refuses the old cookie even if the browser keeps sending it
    const second = await post(base, '/api/catalog/requests', { lines: [{ barcode: '555', quantityCtn: 1 }] }, cookie);
    assert.equal(second.status, 401, 'a second order on the same session is refused');
    assert.equal((await second.json()).code, 'ACCESS_CODE_REQUIRED');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 1, 'only the first order exists');

    // the next customer signs in normally and their order is filed under THEM
    const next = await post(base, '/api/catalog/access', { code: issueAccessCode(db, akil) });
    const third = await post(base, '/api/catalog/requests', { lines: [{ barcode: '555', quantityCtn: 1 }] }, cookieOf(next));
    assert.equal(third.status, 201);
    assert.equal(db.prepare('SELECT customer_id FROM requests ORDER BY id DESC LIMIT 1').get().customer_id, akil);
  } finally { server.close(); }
  db.close();
});

test('an expired or forged session cookie does not let a request through', async () => {
  const db = freshDb();
  product(db);
  const id = customer(db, 'Melcom Ltd');
  const { server, base } = await startApp(db);
  try {
    const real = cookieOf(await post(base, '/api/catalog/access', { code: issueAccessCode(db, id) }));
    const value = real.split('=').slice(1).join('=');
    const [payload, signature] = [value.slice(0, value.lastIndexOf('.')), value.slice(value.lastIndexOf('.') + 1)];

    const forged = [
      `bfl_customer=${payload}.${'A'.repeat(signature.length)}`,              // wrong signature
      `bfl_customer=${Buffer.from(JSON.stringify({ cid: id, exp: Date.now() + 1e6 })).toString('base64url')}.x`,
      `bfl_customer=${payload}`,                                              // no signature at all
      'bfl_customer=garbage',
    ];
    for (const cookie of forged) {
      const res = await post(base, '/api/catalog/requests', { lines: [{ barcode: '555', quantityCtn: 1 }] }, cookie);
      assert.equal(res.status, 401, `forged cookie accepted: ${cookie.slice(0, 40)}`);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0, 'nothing written');
  } finally { server.close(); }
  db.close();
});

test('repeated wrong codes are rate limited', async () => {
  const db = freshDb();
  customer(db, 'Melcom Ltd');
  const { server, base } = await startApp(db);
  try {
    let sawLimit = false;
    for (let i = 0; i < 15; i += 1) {
      const res = await post(base, '/api/catalog/access', { code: 'ZZZZZZZZ' });
      if (res.status === 429) { sawLimit = true; break; }
    }
    assert.ok(sawLimit, 'guessing must be rate limited, not unlimited');
  } finally { server.close(); }
  db.close();
});

// ---------------------------------------------------------------------------
// 4. codes must not leak
// ---------------------------------------------------------------------------

test('no customer-facing endpoint ever discloses a code', async () => {
  const db = freshDb();
  product(db);
  const id = customer(db, 'Melcom Ltd');
  const code = issueAccessCode(db, id);
  const { server, base } = await startApp(db);
  try {
    const cookie = cookieOf(await post(base, '/api/catalog/access', { code }));
    const urls = ['/api/catalog/products?limit=10', '/api/catalog/requests/stock-status', '/api/catalog/access'];
    for (const url of urls) {
      for (const headers of [{}, { cookie }]) {
        const body = await (await fetch(base + url, { headers })).text();
        assert.ok(!body.includes(code), `${url} leaked the access code`);
        assert.ok(!body.includes('access_code'), `${url} leaked the field name`);
      }
    }
    const receipt = await (await post(base, '/api/catalog/requests', { lines: [{ barcode: '555', quantityCtn: 1 }] }, cookie)).text();
    assert.ok(!receipt.includes(code), 'the submission receipt leaked the code');
  } finally { server.close(); }
  db.close();
});

test('the access session reveals the name only — never the internal id', async () => {
  const db = freshDb();
  const id = customer(db, 'Melcom Ltd');
  const { server, base } = await startApp(db);
  try {
    const entered = await post(base, '/api/catalog/access', { code: issueAccessCode(db, id) });
    const body = await entered.json();
    // name and their OWN delivery address — nothing else. No internal id, no Odoo
    // ref, no code, nothing belonging to another customer.
    assert.deepEqual(body, { ok: true, customer: { name: 'Melcom Ltd', deliveryAddress: null } });

    const status = await (await fetch(`${base}/api/catalog/access`, { headers: { cookie: cookieOf(entered) } })).json();
    assert.deepEqual(status, { authenticated: true, customer: { name: 'Melcom Ltd', deliveryAddress: null } });
  } finally { server.close(); }
  db.close();
});

test('a wrong code and an inactive customer are indistinguishable in the response', async () => {
  const db = freshDb();
  const id = customer(db, 'Melcom Ltd');
  const code = issueAccessCode(db, id);
  db.prepare('UPDATE customers SET is_active = 0 WHERE id = ?').run(id);
  const { server, base } = await startApp(db);
  try {
    const inactive = await post(base, '/api/catalog/access', { code });
    const nonsense = await post(base, '/api/catalog/access', { code: 'ZZZZZZZZ' });
    assert.equal(inactive.status, nonsense.status);
    assert.deepEqual(await inactive.json(), await nonsense.json(), 'the reply must not reveal which codes exist');
  } finally { server.close(); }
  db.close();
});

// ---------------------------------------------------------------------------
// asking for access
// ---------------------------------------------------------------------------

test('asking for access records a PENDING row and creates nothing else', () => {
  const db = freshDb();
  createAccessRequest(db, { company: 'New Co', contact: 'Sam', phone: '0244', address: 'Accra' });
  const { items, total } = listAccessRequests(db);
  assert.equal(total, 1);
  assert.equal(items[0].status, 'PENDING');
  assert.equal(items[0].company, 'New Co');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 0, 'no customer is created by asking');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM requests').get().n, 0, 'and no request');
  db.close();
});

test('a contact name and phone are required to ask', () => {
  const db = freshDb();
  assert.throws(() => createAccessRequest(db, { company: 'No Contact' }), AccessRequestError);
  assert.throws(() => createAccessRequest(db, { contact: 'Sam' }), AccessRequestError);
  assert.equal(listAccessRequests(db).total, 0, 'nothing was written');
  db.close();
});

test('a delivery address is required to ask for access', () => {
  const db = freshDb();
  // A company that cannot be delivered to cannot be supplied, so the address is
  // collected before access is granted rather than chased afterwards.
  assert.throws(
    () => createAccessRequest(db, { company: 'No Address Co', contact: 'Sam', phone: '0244' }),
    AccessRequestError,
  );
  assert.throws(
    () => createAccessRequest(db, { company: 'Blank Address Co', contact: 'Sam', phone: '0244', address: '   ' }),
    AccessRequestError,
  );
  assert.equal(listAccessRequests(db).total, 0, 'nothing was written');

  // and it lands on the customer record when the request is approved
  const { id } = createAccessRequest(db, {
    company: 'Addressed Co', contact: 'Sam', phone: '0244', address: '12 Test Road, Accra',
  });
  const approved = approveAccessRequest(db, id);
  assert.equal(
    db.prepare('SELECT delivery_address FROM customers WHERE id = ?').get(approved.customerId).delivery_address,
    '12 Test Road, Accra',
  );
  db.close();
});

test('approving creates the customer, issues a code, and links the two', () => {
  const db = freshDb();
  const { id } = createAccessRequest(db, { company: 'New Co', contact: 'Sam', phone: '0244', address: 'Accra' });
  const result = approveAccessRequest(db, id);

  assert.equal(result.status, 'APPROVED');
  assert.ok(result.code, 'a code is issued');
  assert.equal(resolveAccessCode(db, result.code).id, result.customerId, 'the code works immediately');

  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(result.customerId);
  assert.equal(row.name, 'New Co');
  assert.equal(row.phone, '0244');
  assert.equal(listAccessRequests(db).items[0].customer_id, result.customerId);
  db.close();
});

test('approving a company already in the master reuses it instead of duplicating', () => {
  const db = freshDb();
  const existing = customer(db, 'Melcom Ltd');
  const { id } = createAccessRequest(db, { company: 'melcom ltd', contact: 'Ama', phone: '0244', address: 'Accra' });
  const result = approveAccessRequest(db, id);

  assert.equal(result.customerId, existing, 'matched the existing customer');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1, 'no duplicate created');
  db.close();
});

test('an approval cannot be applied twice', () => {
  const db = freshDb();
  const { id } = createAccessRequest(db, { company: 'New Co', contact: 'Sam', phone: '0244', address: 'Accra' });
  const first = approveAccessRequest(db, id);
  assert.throws(() => approveAccessRequest(db, id), AccessRequestError);
  // the code issued the first time must still be the live one
  assert.equal(resolveAccessCode(db, first.code).id, first.customerId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
  db.close();
});

test('rejecting keeps the record and creates no customer', () => {
  const db = freshDb();
  const { id } = createAccessRequest(db, { company: 'Not For Us', contact: 'Sam', phone: '0244', address: 'Accra' });
  assert.equal(rejectAccessRequest(db, id, 'duplicate account').status, 'REJECTED');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n, 0);
  assert.equal(listAccessRequests(db).total, 1, 'the record of having asked is kept');
  db.close();
});

test('the acknowledgement reveals nothing about who is already a customer', async () => {
  const db = freshDb();
  customer(db, 'Melcom Ltd');
  const { server, base } = await startApp(db);
  try {
    const known = await post(base, '/api/catalog/access-requests', { company: 'Melcom Ltd', contact: 'A', phone: '024' });
    const unknown = await post(base, '/api/catalog/access-requests', { company: 'Totally New Co', contact: 'B', phone: '024' });
    assert.equal(known.status, unknown.status);
    assert.deepEqual(await known.json(), await unknown.json());
  } finally { server.close(); }
  db.close();
});

test('access-code page links to the standalone signup page', async () => {
  const db = freshDb();
  const { server, base } = await startApp(db);
  try {
    const accessResponse = await fetch(`${base}/customer-shop`);
    const accessPage = await accessResponse.text();
    assert.equal(accessResponse.status, 200);
    assert.match(accessPage, /new URL\("\/signup",location\.href\)/);

    const response = await fetch(`${base}/signup`);
    const page = await response.text();
    assert.equal(response.status, 200);
    assert.match(page, /id="signup-form"/);
    assert.match(page, /name="contact"/);
    assert.match(page, /name="phone"/);
    assert.match(page, /name="address"/);
    assert.doesNotMatch(page, /name="company"|name="note"/);
    assert.match(page, /href="\/customer-shop"/);
  } finally { server.close(); }
  db.close();
});

test('signup submission creates a pending request visible to access-request staff', async () => {
  const db = freshDb();
  const { server, base } = await startApp(db);
  try {
    const response = await post(base, '/api/catalog/access-requests', {
      contact: 'Ama Mensah',
      phone: '0244000111',
      address: '12 Market Road, Accra',
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).received, true);
    const requests = listAccessRequests(db, { status: 'PENDING' });
    assert.equal(requests.total, 1);
    assert.equal(requests.items[0].contact, 'Ama Mensah');
    assert.equal(requests.items[0].phone, '0244000111');
    assert.equal(requests.items[0].delivery_address, '12 Market Road, Accra');
  } finally { server.close(); }
  db.close();
});

// ---------------------------------------------------------------------------
// staff side
// ---------------------------------------------------------------------------

test('importing a customer list issues codes to the NEW customers automatically', async () => {
  const db = freshDb();
  const { createCustomerPreview, confirmCustomerImport } = await import('../src/import/customer-service.js');
  const xlsx = (await import('xlsx')).default;
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const write = (names) => {
    const ws = xlsx.utils.json_to_sheet(names.map((n) => ({ 'Display Name': n, Phone: '0244' })));
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = path.join(os.tmpdir(), `contacts-${Date.now()}-${Math.random().toString(36).slice(2)}.xlsx`);
    xlsx.writeFile(wb, file);
    return file;
  };
  const uploads = path.join(os.tmpdir(), `bfl-uploads-${Date.now()}`);

  // first list
  const a = createCustomerPreview(db, write(['Alpha Ltd', 'Beta Ltd']), 'a.xlsx', { uploadsDir: uploads });
  const firstRun = confirmCustomerImport(db, a.batchId);
  assert.equal(firstRun.counts.codesIssued, 2, 'both new customers get a code');
  const alphaCode = db.prepare('SELECT access_code FROM customers WHERE name = ?').get('Alpha Ltd').access_code;
  assert.ok(alphaCode);

  // a later export that ADDS a company
  const b = createCustomerPreview(db, write(['Alpha Ltd', 'Beta Ltd', 'Gamma Ltd']), 'b.xlsx', { uploadsDir: uploads });
  const secondRun = confirmCustomerImport(db, b.batchId);
  assert.equal(secondRun.counts.codesIssued, 1, 'only the newly added company needs one');

  assert.ok(db.prepare('SELECT access_code FROM customers WHERE name = ?').get('Gamma Ltd').access_code,
    'the new company can be sent a code immediately');
  assert.equal(
    db.prepare('SELECT access_code FROM customers WHERE name = ?').get('Alpha Ltd').access_code,
    alphaCode,
    're-importing must NOT change a code already sent to a customer',
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE access_code IS NULL').get().n, 0);
  fs.rmSync(uploads, { recursive: true, force: true });
  db.close();
});

test('withdrawing a request keeps it in full and it can be restored', async () => {
  const db = freshDb();
  product(db);
  const id = customer(db, 'Melcom Ltd');
  const { submitRequest, getRequest, listRequests, deleteRequest, restoreRequest } =
    await import('../src/domain/requests.js');

  const res = submitRequest(db, {
    lines: [{ barcode: '555', quantityCtn: 3 }], customerId: id, notes: 'keep me',
  });
  const reference = getRequest(db, res.requestId).request.reference;

  assert.equal(deleteRequest(db, res.requestId), true);

  // the row, the snapshots and the link to the customer all survive
  const after = getRequest(db, res.requestId);
  assert.ok(after, 'a withdrawn request is still readable');
  assert.equal(after.request.status, 'DELETED');
  assert.ok(after.request.deleted_at, 'when it was withdrawn is recorded');
  assert.equal(after.request.reference, reference, 'it keeps its reference');
  assert.equal(after.request.notes, 'keep me');
  assert.equal(after.customer.displayName, 'Melcom Ltd', 'the customer is still named');
  assert.equal(after.items.length, 1, 'the lines are kept');
  assert.equal(after.items[0].quantity_ctn, 3, 'and so are the quantities');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM request_items WHERE request_id = ?').get(res.requestId).n, 1);

  // it leaves the working list but appears in the withdrawn one
  assert.equal(listRequests(db).items.length, 0, 'hidden from the active list');
  const binned = listRequests(db, { deleted: true });
  assert.equal(binned.total, 1);
  assert.equal(binned.items[0].reference, reference);
  assert.equal(binned.items[0].customer.displayName, 'Melcom Ltd');

  // and it comes back
  const restored = restoreRequest(db, res.requestId);
  assert.equal(restored.request.status, 'SUBMITTED');
  assert.equal(restored.request.deleted_at, null);
  assert.equal(listRequests(db).total, 1, 'back in the active list');
  assert.equal(listRequests(db, { deleted: true }).total, 0);

  assert.equal(restoreRequest(db, res.requestId), null, 'restoring a live request does nothing');
  assert.equal(deleteRequest(db, 999999), false, 'withdrawing an unknown request reports it');
  db.close();
});

test('staff can read every customer code back in order to send it', () => {
  const db = freshDb();
  const id = customer(db, 'Melcom Ltd');
  const code = issueAccessCode(db, id);
  const { items } = listCustomerCodes(db);
  assert.equal(items[0].access_code, code);
  assert.equal(items[0].access_code_display, formatAccessCode(code));
  assert.ok(items[0].access_code_issued_at, 'when it was issued is recorded');
  db.close();
});

test('the customer code list is a STAFF route, not reachable under /api/catalog', async () => {
  const db = freshDb();
  const code = issueAccessCode(db, customer(db, 'Melcom Ltd'));
  const { server, base } = await startApp(db);
  try {
    for (const url of ['/api/catalog/customers/codes', '/api/catalog/requests/customers/codes',
      '/api/catalog/access-requests']) {
      const res = await fetch(base + url);
      const body = await res.text();
      assert.ok(!body.includes(code), `${url} leaked a code`);
      assert.ok(!body.includes('Melcom'), `${url} leaked a customer name`);
    }
  } finally { server.close(); }
  db.close();
});
