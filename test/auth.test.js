// Sign-in: customers (Odoo ID + password), staff (email or phone + password), and what each role reaches.
//
// What is at risk, in order:
//   1. Someone getting in as someone else: guessing an ID, reusing a leaked access code, forging a cookie.
//   2. A role reaching what is not theirs: a rep in the approvals, the warehouse in the customer list.
//   3. A password, a hash or an internal id appearing in anything a browser can read.
// These tests run with REAL staff authentication (the test-runner bypass is switched off for this file).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { freshDb } from './helpers.js';

const ADMIN_USER = 'owner';
const ADMIN_PASS = 'owner-secret-passphrase';
const SAVED_CONTEXT = process.env.NODE_TEST_CONTEXT;
delete process.env.NODE_TEST_CONTEXT;
process.env.BFL_STAFF_USERNAME = ADMIN_USER;
process.env.BFL_STAFF_PASSWORD = ADMIN_PASS;
process.env.BFL_SESSION_SECRET = crypto.randomBytes(24).toString('hex');
after(() => { if (SAVED_CONTEXT !== undefined) process.env.NODE_TEST_CONTEXT = SAVED_CONTEXT; });

const { createApp } = await import('../src/server/index.js');
const { hashPassword, verifyPassword, passwordProblem, temporaryPassword } = await import('../src/domain/passwords.js');
const staff = await import('../src/domain/staff-accounts.js');
const cust = await import('../src/domain/customer-auth.js');
const { issueAccessCode } = await import('../src/domain/access-codes.js');
const { resetAuthAttempts } = await import('../src/server/routes/auth.js');
const { resetAccessAttempts } = await import('../src/server/customer-access.js');
const { resetStaffAttempts } = await import('../src/server/staff-auth.js');

beforeEach(() => { resetAuthAttempts(); resetAccessAttempts(); resetStaffAttempts(); });

const PW = 'correct horse battery';
function customer(db, name, extra = {}) {
  const ts = new Date().toISOString();
  const id = Number(db.prepare('INSERT INTO customers (name, is_active, created_at, updated_at) VALUES (?,1,?,?)').run(name, ts, ts).lastInsertRowid);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE customers SET ${k} = ? WHERE id = ?`).run(v, id);
  return id;
}
/** An activated customer: has an Odoo ID, a code, and a password. */
function activated(db, name = 'Kofi Traders Ltd', odooId = '4321', password = PW) {
  const id = customer(db, name, { odoo_customer_ref: odooId, phone: '0244111222' });
  const code = issueAccessCode(db, id);
  cust.activateCustomer(db, odooId, code, password);
  return { id, code };
}
function newStaff(db, role, extra = {}) {
  return staff.createStaffUser(db, { name: `Test ${role}`, email: `${role.toLowerCase()}@bfl.test`, role, repId: role === 'SALES_REP' ? 'rep-1' : undefined, ...extra }, 'ADMIN', 'owner');
}
/** A staff member who has already chosen their own password. */
function readyStaff(db, role, extra = {}) {
  const { user, temporaryPassword: temp } = newStaff(db, role, extra);
  staff.changeStaffPassword(db, user.id, temp, PW);
  return user;
}

async function startApp(db) {
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
async function withApp(db, fn) {
  const { server, base } = await startApp(db);
  try { return await fn(base); } finally { server.close(); }
}
const call = (base, path, { method = 'GET', body, cookie } = {}) => fetch(base + path, {
  method, redirect: 'manual',
  headers: { 'Content-Type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const cookiesOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
async function staffCookie(base, identifier, password = PW) {
  const res = await call(base, '/api/staff/login', { method: 'POST', body: { identifier, password } });
  assert.equal(res.status, 200, `staff login ${identifier}`);
  return { cookie: cookiesOf(res), body: await res.json() };
}
async function customerCookie(base, id, password = PW) {
  const res = await call(base, '/api/auth/customer/login', { method: 'POST', body: { id, password } });
  assert.equal(res.status, 200);
  return cookiesOf(res);
}

// ===========================================================================
// passwords
// ===========================================================================
test('1. a password is stored as a salted scrypt hash and checks only against itself', () => {
  const a = hashPassword(PW);
  const b = hashPassword(PW);
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.notEqual(a, b, 'a fresh salt each time');
  assert.ok(!a.includes(PW));
  assert.equal(verifyPassword(PW, a), true);
  assert.equal(verifyPassword('correct horse batterx', a), false);
  assert.equal(verifyPassword('', a), false);
  assert.equal(verifyPassword(PW, null), false, 'no account: false, never an error');
  assert.equal(verifyPassword(PW, 'garbage'), false);
});

test('2. the password rules: length, common passwords, repeats, and not your own details', () => {
  assert.match(passwordProblem('short'), /at least 8/);
  assert.match(passwordProblem('password'), /too easy/);
  assert.match(passwordProblem('12345678'), /too easy/);
  assert.match(passwordProblem('aaaaaaaaaa'), /repeat/i);
  assert.match(passwordProblem('my4321secret', ['4321']), /must not contain/);
  assert.equal(passwordProblem(PW, ['4321', 'Kofi']), null);
  assert.match(passwordProblem('x'.repeat(201)), /too long/);
  assert.match(temporaryPassword(), /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
});

// ===========================================================================
// staff accounts
// ===========================================================================
test('3. an account needs a name and an email or a phone, and gives a one-time password', () => {
  const db = freshDb();
  assert.throws(() => staff.createStaffUser(db, { role: 'WAREHOUSE', email: 'a@b.co' }, 'ADMIN'), /name/);
  assert.throws(() => staff.createStaffUser(db, { name: 'A', role: 'WAREHOUSE' }, 'ADMIN'), /email address or a phone/);
  assert.throws(() => staff.createStaffUser(db, { name: 'A', role: 'WAREHOUSE', email: 'nope' }, 'ADMIN'), /email/);
  assert.throws(() => staff.createStaffUser(db, { name: 'A', role: 'WAREHOUSE', phone: '12' }, 'ADMIN'), /phone/);
  const { user, temporaryPassword: temp } = staff.createStaffUser(db, { name: 'Esi', role: 'WAREHOUSE', phone: '+233 24 411 1222' }, 'ADMIN');
  assert.equal(user.mustChangePassword, true);
  assert.ok(temp.length >= 12);
  assert.ok(!JSON.stringify(user).includes(temp));
  assert.ok(!db.prepare('SELECT password_hash FROM staff_users').get().password_hash.includes(temp));
});

test('4. the same email or phone (in any format) cannot have two accounts; a rep is one account only', () => {
  const db = freshDb();
  staff.createStaffUser(db, { name: 'Esi', role: 'WAREHOUSE', email: 'Esi@BFL.test', phone: '0244 111 222' }, 'ADMIN');
  assert.throws(() => staff.createStaffUser(db, { name: 'Other', role: 'WAREHOUSE', email: 'esi@bfl.test' }, 'ADMIN'), /already/);
  assert.throws(() => staff.createStaffUser(db, { name: 'Other', role: 'WAREHOUSE', phone: '+233244111222' }, 'ADMIN'), /already/);
  newStaff(db, 'SALES_REP');
  assert.throws(() => staff.createStaffUser(db, { name: 'Dup', role: 'SALES_REP', repId: 'rep-1', email: 'dup@bfl.test' }, 'ADMIN'), /already has an account/);
  assert.throws(() => staff.createStaffUser(db, { name: 'Bad', role: 'SALES_REP', repId: 'rep-99', email: 'bad@bfl.test' }, 'ADMIN'), /which sales rep/);
});

test('5. a Sales Manager can create and manage sales reps, nothing else', () => {
  const db = freshDb();
  assert.throws(() => staff.createStaffUser(db, { name: 'W', role: 'WAREHOUSE', email: 'w@bfl.test' }, 'SALES_MANAGER'), /cannot create/);
  assert.throws(() => staff.createStaffUser(db, { name: 'M', role: 'SALES_MANAGER', email: 'm@bfl.test' }, 'SALES_MANAGER'), /cannot create/);
  const { user } = staff.createStaffUser(db, { name: 'R', role: 'SALES_REP', repId: 'rep-1', email: 'r@bfl.test' }, 'SALES_MANAGER');
  const w = newStaff(db, 'WAREHOUSE').user;
  assert.deepEqual(staff.listStaffUsers(db, 'SALES_MANAGER').map((u) => u.id), [user.id]);
  assert.equal(staff.listStaffUsers(db, 'ADMIN').length, 2);
  assert.throws(() => staff.resetStaffPassword(db, w.id, 'SALES_MANAGER'), /cannot change/);
  assert.throws(() => staff.setStaffActive(db, w.id, false, 'SALES_MANAGER'), /cannot change/);
  assert.equal(staff.setStaffActive(db, user.id, false, 'SALES_MANAGER').active, false);
  assert.deepEqual(staff.listStaffUsers(db, 'WAREHOUSE'), [], 'nobody else manages accounts');
});

test('6. sign-in works by email (any case) or by phone (any format), and a wrong answer looks the same either way', () => {
  const db = freshDb();
  const u = readyStaff(db, 'SALES_MANAGER', { phone: '024 411 1222' });
  assert.equal(staff.authenticateStaff(db, 'SALES_MANAGER@BFL.test', PW)?.id, u.id);
  assert.equal(staff.authenticateStaff(db, '+233 24 411 1222', PW)?.id, u.id);
  assert.equal(staff.authenticateStaff(db, '0244111222', PW)?.id, u.id);
  assert.equal(staff.authenticateStaff(db, 'sales_manager@bfl.test', 'wrong password'), null);
  assert.equal(staff.authenticateStaff(db, 'nobody@bfl.test', PW), null);
  assert.equal(staff.authenticateStaff(db, '', PW), null);
  assert.equal(staff.authenticateStaff(db, '0', PW), null, 'a junk number is not an identity');
  staff.setStaffActive(db, u.id, false, 'ADMIN');
  assert.equal(staff.authenticateStaff(db, 'sales_manager@bfl.test', PW), null, 'switched off');
});

test('7. a new account must choose its own password, and cannot reuse the temporary one', () => {
  const db = freshDb();
  const { user, temporaryPassword: temp } = newStaff(db, 'WAREHOUSE');
  assert.throws(() => staff.changeStaffPassword(db, user.id, 'not it', PW), /current password/);
  assert.throws(() => staff.changeStaffPassword(db, user.id, temp, 'short'), /at least 8/);
  assert.throws(() => staff.changeStaffPassword(db, user.id, temp, temp), /different/);
  assert.throws(() => staff.changeStaffPassword(db, user.id, temp, 'warehouse@bfl.test'), /must not contain/);
  staff.changeStaffPassword(db, user.id, temp, PW);
  assert.equal(staff.authenticateStaff(db, 'warehouse@bfl.test', temp), null, 'the temporary one is dead');
  assert.equal(staff.authenticateStaff(db, 'warehouse@bfl.test', PW).must_change_password, 0);
  const reset = staff.resetStaffPassword(db, user.id, 'ADMIN');
  assert.equal(staff.authenticateStaff(db, 'warehouse@bfl.test', PW), null, 'a reset ends the old password');
  assert.equal(staff.authenticateStaff(db, 'warehouse@bfl.test', reset.temporaryPassword).must_change_password, 1);
});

// ===========================================================================
// customers: ID + password
// ===========================================================================
test('8. a customer is found by Odoo ID; a phone or email works only for a customer with no Odoo ID and only if unique', () => {
  const db = freshDb();
  const a = customer(db, 'Has Odoo', { odoo_customer_ref: 'C-4321', phone: '0244111222' });
  const b = customer(db, 'Cash Buyer', { phone: '0201777888', email: 'ama@x.com' });
  customer(db, 'Twin One', { phone: '0277000111' });
  customer(db, 'Twin Two', { phone: '0277000111' });
  customer(db, 'Junk', { phone: '0' });
  assert.equal(cust.findCustomerByLoginId(db, 'c-4321').id, a, 'Odoo ID, any case');
  assert.equal(cust.findCustomerByLoginId(db, '0244111222'), null, 'a customer WITH an Odoo ID is not found by phone');
  assert.equal(cust.findCustomerByLoginId(db, '+233 20 177 7888').id, b);
  assert.equal(cust.findCustomerByLoginId(db, 'AMA@x.com').id, b);
  assert.equal(cust.findCustomerByLoginId(db, '0277000111'), null, 'a shared number signs nobody in');
  assert.equal(cust.findCustomerByLoginId(db, '0'), null);
  assert.equal(cust.findCustomerByLoginId(db, ''), null);
  assert.equal(cust.findCustomerByLoginId(db, 'x'.repeat(500)), null);
});

test('9. the first time: ID + the access code sets a password; the code cannot be used twice or by guesswork', () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders Ltd', { odoo_customer_ref: '4321' });
  const code = issueAccessCode(db, id);
  const refused = /do not match/;
  assert.throws(() => cust.activateCustomer(db, '4321', 'AAAAAAAA', PW), refused);
  assert.throws(() => cust.activateCustomer(db, '9999', code, PW), refused, 'a wrong ID looks the same as a wrong code');
  assert.throws(() => cust.activateCustomer(db, '4321', code, 'short'), /at least 8/);
  assert.throws(() => cust.activateCustomer(db, '4321', code, 'my4321pass'), /must not contain/);
  assert.equal(cust.authenticateCustomer(db, '4321', PW), null, 'nothing was set by the failures');
  cust.activateCustomer(db, '4321', code, PW);
  assert.equal(cust.authenticateCustomer(db, '4321', PW).id, id);
  assert.equal(cust.authenticateCustomer(db, '4321', 'wrong password!'), null);
  assert.throws(() => cust.activateCustomer(db, '4321', code, 'another one here'), /already set up/);
  assert.ok(db.prepare('SELECT password_hash FROM customers WHERE id = ?').get(id).password_hash.startsWith('scrypt$'));
});

test('10. staff reset a customer: password cleared, sessions ended, a new code issued', () => {
  const db = freshDb();
  const { id, code } = activated(db);
  const epoch = db.prepare('SELECT session_epoch e FROM customers WHERE id = ?').get(id).e;
  const fresh = cust.resetCustomerPassword(db, id);
  assert.notEqual(fresh, code);
  assert.equal(cust.authenticateCustomer(db, '4321', PW), null);
  assert.equal(db.prepare('SELECT session_epoch e FROM customers WHERE id = ?').get(id).e, epoch + 1);
  cust.activateCustomer(db, '4321', fresh, 'a brand new password');
  assert.ok(cust.authenticateCustomer(db, '4321', 'a brand new password'));
  assert.equal(cust.resetCustomerPassword(db, 99999), null);
});

test('11. an Odoo ID is unique, short, and can be cleared', () => {
  const db = freshDb();
  const a = customer(db, 'A'); const b = customer(db, 'B');
  assert.deepEqual(cust.setOdooCustomerId(db, a, ' 4321 '), { id: a, odooId: '4321' });
  assert.throws(() => cust.setOdooCustomerId(db, b, '4321'), /already has that/);
  assert.throws(() => cust.setOdooCustomerId(db, b, 'has space'), /no spaces/);
  assert.throws(() => cust.setOdooCustomerId(db, b, 'a@b'), /no spaces or @/);
  assert.equal(cust.setOdooCustomerId(db, a, '').odooId, null);
});

// ===========================================================================
// customer routes
// ===========================================================================
test('12. a customer signs in with ID and password; a bad try says nothing about whether the ID exists', async () => {
  const db = freshDb();
  activated(db);
  await withApp(db, async (base) => {
    const bad1 = await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '4321', password: 'wrong password!' } });
    const bad2 = await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '7777', password: 'wrong password!' } });
    assert.equal(bad1.status, 401);
    assert.equal(bad2.status, 401);
    assert.deepEqual(await bad1.json(), await bad2.json(), 'identical answers');

    const ok = await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '4321', password: PW } });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.deepEqual(Object.keys(body).sort(), ['customer', 'home', 'ok']);
    assert.deepEqual(body.customer, { name: 'Kofi Traders Ltd' });
    const cookie = cookiesOf(ok);
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    const me = await (await call(base, '/api/auth/me', { cookie })).json();
    assert.deepEqual(me.customer, { name: 'Kofi Traders Ltd', viaPassword: true });
    assert.equal(me.staff, null);
    assert.ok(!/password|hash|scrypt|"id"/.test(JSON.stringify(me)));
  });
});

test('13. guessing is throttled per account and per address', async () => {
  const db = freshDb();
  activated(db);
  await withApp(db, async (base) => {
    let last;
    for (let i = 0; i < 8; i += 1) last = await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '4321', password: `wrong password ${i}` } });
    assert.equal(last.status, 429);
    // even the right password is refused while locked, so a guess cannot be confirmed
    const right = await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '4321', password: PW } });
    assert.equal(right.status, 429);
  });
});

test('14. activation over the web: ID + code, then the code stops working on its own', async () => {
  const db = freshDb();
  const id = customer(db, 'Kofi Traders Ltd', { odoo_customer_ref: '4321' });
  const code = issueAccessCode(db, id);
  await withApp(db, async (base) => {
    const wrong = await call(base, '/api/auth/customer/activate', { method: 'POST', body: { id: '4321', code: 'ZZZZZZZZ', password: PW } });
    assert.equal(wrong.status, 401);
    const ok = await call(base, '/api/auth/customer/activate', { method: 'POST', body: { id: '4321', code, password: PW } });
    assert.equal(ok.status, 200);
    assert.ok(cookiesOf(ok).includes('bfl_customer='));
    // the old code-only door is now shut for this customer
    const viaCode = await call(base, '/api/catalog/access', { method: 'POST', body: { code } });
    assert.equal(viaCode.status, 403);
    assert.equal((await viaCode.json()).code, 'USE_PASSWORD');
    assert.equal((await call(base, '/api/auth/customer/activate', { method: 'POST', body: { id: '4321', code, password: PW } })).status, 409);
  });
});

test('15. a customer who has not set a password can still use the code until they do', async () => {
  const db = freshDb();
  const id = customer(db, 'Old Way Co');
  const code = issueAccessCode(db, id);
  await withApp(db, async (base) => {
    const res = await call(base, '/api/catalog/access', { method: 'POST', body: { code } });
    assert.equal(res.status, 200);
  });
});

test('15b. with BFL_ALLOW_CODE_SIGNIN=0 the code alone never signs anyone in', async () => {
  const db = freshDb();
  const id = customer(db, 'Old Way Co');
  const code = issueAccessCode(db, id);
  process.env.BFL_ALLOW_CODE_SIGNIN = '0';
  try {
    await withApp(db, async (base) => {
      const res = await call(base, '/api/catalog/access', { method: 'POST', body: { code } });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).code, 'USE_PASSWORD');
      // activation (ID + code + a new password) is still the way in
      cust.setOdooCustomerId(db, id, '777');
      assert.equal((await call(base, '/api/auth/customer/activate', { method: 'POST', body: { id: '777', code, password: PW } })).status, 200);
    });
  } finally { delete process.env.BFL_ALLOW_CODE_SIGNIN; }
});

test('16. a customer can change their password; the old one stops working', async () => {
  const db = freshDb();
  activated(db);
  await withApp(db, async (base) => {
    const cookie = await customerCookie(base, '4321');
    assert.equal((await call(base, '/api/auth/customer/password', { method: 'POST', cookie, body: { current: 'nope nope nope', next: 'a different one 9' } })).status, 403);
    assert.equal((await call(base, '/api/auth/customer/password', { method: 'POST', cookie, body: { current: PW, next: 'short' } })).status, 400);
    assert.equal((await call(base, '/api/auth/customer/password', { method: 'POST', cookie, body: { current: PW, next: 'a different one 9' } })).status, 200);
    assert.equal((await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '4321', password: PW } })).status, 401);
    assert.equal((await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '4321', password: 'a different one 9' } })).status, 200);
    assert.equal((await call(base, '/api/auth/customer/password', { method: 'POST', body: { current: PW, next: 'xxxxxxxxxxx1' } })).status, 401, 'signed out');
  });
});

test('17. signing out removes both cookies, and a forged cookie is nothing', async () => {
  const db = freshDb();
  activated(db);
  await withApp(db, async (base) => {
    const cookie = await customerCookie(base, '4321');
    const out = await call(base, '/api/auth/logout', { method: 'POST', cookie });
    assert.equal(out.status, 204);
    const cleared = (out.headers.getSetCookie?.() || []).join(' ');
    assert.match(cleared, /bfl_customer=;/);
    assert.match(cleared, /bfl_staff_session=;/);
    const forged = cookie.replace(/\.[^.;]+$/, '.AAAA');
    const me = await (await call(base, '/api/auth/me', { cookie: forged })).json();
    assert.equal(me.customer, null);
    const guessed = `bfl_customer=${Buffer.from(JSON.stringify({ cid: 1, ep: 0, m: 'pw', exp: Date.now() + 1e9 })).toString('base64url')}.AAAA`;
    assert.equal((await (await call(base, '/api/auth/me', { cookie: guessed })).json()).customer, null);
  });
});

// ===========================================================================
// staff routes and roles
// ===========================================================================
test('18. the administrator signs in with the environment account; a wrong password is refused', async () => {
  const db = freshDb();
  await withApp(db, async (base) => {
    assert.equal((await call(base, '/api/staff/login', { method: 'POST', body: { identifier: ADMIN_USER, password: 'wrong wrong wrong' } })).status, 401);
    const { body, cookie } = await staffCookie(base, ADMIN_USER, ADMIN_PASS);
    assert.equal(body.role, 'ADMIN');
    assert.equal((await call(base, '/api/team', { cookie })).status, 200);
    // the old request shape still works
    const old = await call(base, '/api/staff/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASS } });
    assert.equal(old.status, 200);
  });
});

test('19. a new staff account can do nothing but choose a password, then everything its role allows', async () => {
  const db = freshDb();
  const { temporaryPassword: temp } = newStaff(db, 'WAREHOUSE');
  await withApp(db, async (base) => {
    const { cookie, body } = await staffCookie(base, 'warehouse@bfl.test', temp);
    assert.equal(body.mustChangePassword, true);
    const blocked = await call(base, '/api/products', { cookie });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, 'PASSWORD_CHANGE_REQUIRED');
    const page = await call(base, '/index.html', { cookie });
    assert.equal(page.status, 302);
    assert.match(page.headers.get('location'), /change=1/);
    assert.equal((await call(base, '/api/auth/staff/password', { method: 'POST', cookie, body: { current: temp, next: 'short' } })).status, 400);
    const changed = await call(base, '/api/auth/staff/password', { method: 'POST', cookie, body: { current: temp, next: PW } });
    assert.equal(changed.status, 200);
    assert.equal((await call(base, '/api/products', { cookie })).status, 200, 'same cookie, now allowed');
  });
});

test('20. each role reaches its own areas and no others', async () => {
  const db = freshDb();
  const roles = ['SALES_MANAGER', 'SALES_REP', 'WAREHOUSE'];
  const ids = {};
  for (const r of roles) { readyStaff(db, r); ids[r] = `${r.toLowerCase()}@bfl.test`; }
  // [method, url, expected status per role (manager, rep, warehouse, admin)]; 403 = the role is refused
  const matrix = [
    ['GET', '/api/products', [200, 403, 200, 200]],
    ['POST', '/api/products/x', [403, 403, null, null]],           // a manager reads the Product Master; they do not change it
    ['GET', '/api/imports', [403, 403, 200, 200]],
    ['GET', '/api/reviews', [403, 403, 200, 200]],
    ['GET', '/api/expiry', [200, 403, 200, 200]],
    ['GET', '/api/requests/access-requests', [200, 403, 403, 200]],
    ['GET', '/api/requests/customers/codes', [200, 403, 403, 200]],
    ['GET', '/api/customer-imports', [200, 403, 403, 200]],
    ['GET', '/api/sample-odoo', [200, 403, 403, 200]],
    ['GET', '/api/team', [200, 403, 403, 200]],
    ['GET', '/api/shelf/approvals', [200, 403, 403, 200]],
    ['GET', '/api/shelf/reps', [200, 200, 403, 200]],
    ['GET', '/api/shelf/my-visits?rep=rep-1', [200, 200, 403, 200]],
  ];
  await withApp(db, async (base) => {
    const cookies = [
      (await staffCookie(base, ids.SALES_MANAGER)).cookie,
      (await staffCookie(base, ids.SALES_REP)).cookie,
      (await staffCookie(base, ids.WAREHOUSE)).cookie,
      (await staffCookie(base, ADMIN_USER, ADMIN_PASS)).cookie,
    ];
    const names = ['manager', 'rep', 'warehouse', 'admin'];
    for (const [method, url, expected] of matrix) {
      for (let i = 0; i < 4; i += 1) {
        if (expected[i] === null) continue;
        const res = await call(base, url, { method, cookie: cookies[i], body: method === 'POST' ? {} : undefined });
        if (expected[i] === 403) assert.equal(res.status, 403, `${names[i]} ${method} ${url}`);
        else assert.ok(res.status < 400, `${names[i]} ${method} ${url} -> ${res.status}`);
      }
    }
    // no sign-in at all
    for (const [, url] of matrix) assert.equal((await call(base, url)).status, 401, `anonymous ${url}`);
  });
});

test('21. a sales rep is always themselves: the request cannot name another rep', async () => {
  const db = freshDb();
  readyStaff(db, 'SALES_REP');
  await withApp(db, async (base) => {
    const { cookie } = await staffCookie(base, 'sales_rep@bfl.test');
    const mine = await (await call(base, '/api/shelf/my-visits?rep=rep-1', { cookie })).json();
    const spoof = await (await call(base, '/api/shelf/my-visits?rep=rep-2', { cookie })).json();
    assert.deepEqual(spoof, mine, 'asking for rep-2 still returns rep-1');
    const reps = await (await call(base, '/api/shelf/reps', { cookie })).json();
    assert.deepEqual(reps.reps.map((r) => r.id), ['rep-1']);
    // a Sales Manager may look at any rep
    readyStaff(db, 'SALES_MANAGER');
    const mgr = (await staffCookie(base, 'sales_manager@bfl.test')).cookie;
    const other = await (await call(base, '/api/shelf/my-visits?rep=rep-2', { cookie: mgr })).json();
    assert.notDeepEqual(other, mine);
  });
});

test('22. pages: each role lands on its own screens, and a wrong page sends them home', async () => {
  const db = freshDb();
  for (const r of ['SALES_MANAGER', 'SALES_REP', 'WAREHOUSE']) readyStaff(db, r);
  await withApp(db, async (base) => {
    const where = async (identifier, page, pw = PW) => {
      const { cookie } = await staffCookie(base, identifier, pw);
      const res = await call(base, page, { cookie });
      return res.status === 302 ? res.headers.get('location') : res.status;
    };
    assert.equal(await where('sales_rep@bfl.test', '/index.html'), '/rep.html?role=SALES_REP');
    assert.equal(await where('sales_rep@bfl.test', '/rep.html'), 200);
    assert.equal(await where('sales_rep@bfl.test', '/scan.html'), '/rep.html?role=SALES_REP');
    assert.equal(await where('warehouse@bfl.test', '/rep.html'), '/index.html?role=WAREHOUSE');
    assert.equal(await where('warehouse@bfl.test', '/scan.html'), 200);
    assert.equal(await where('sales_manager@bfl.test', '/index.html'), 200);
    assert.equal(await where('sales_manager@bfl.test', '/scan.html'), '/index.html?role=SALES_MANAGER');
    assert.equal(await where(ADMIN_USER, '/scan.html', ADMIN_PASS), 200);
    const anon = await call(base, '/index.html');
    assert.equal(anon.status, 302);
    assert.match(anon.headers.get('location'), /^\/staff\/login/);
    // the front door is the sign-in page
    const front = await fetch(`${base}/`);
    assert.equal(front.status, 200);
    assert.match(await front.text(), /id="generalLoginForm"/);
  });
});

test('23. switching an account off ends its access at once, even with a valid cookie', async () => {
  const db = freshDb();
  const u = readyStaff(db, 'WAREHOUSE');
  await withApp(db, async (base) => {
    const { cookie } = await staffCookie(base, 'warehouse@bfl.test');
    assert.equal((await call(base, '/api/products', { cookie })).status, 200);
    staff.setStaffActive(db, u.id, false, 'ADMIN');
    assert.equal((await call(base, '/api/products', { cookie })).status, 401);
    assert.equal((await call(base, '/index.html', { cookie })).status, 302);
  });
});

test('24. a tampered staff cookie, or one claiming to be the administrator, is refused', async () => {
  const db = freshDb();
  readyStaff(db, 'SALES_REP');
  await withApp(db, async (base) => {
    const { cookie } = await staffCookie(base, 'sales_rep@bfl.test');
    const [name, token] = cookie.split('=');
    const [payload, sig] = token.split('.');
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const forged = Buffer.from(JSON.stringify({ ...body, uid: 0, user: ADMIN_USER })).toString('base64url');
    assert.equal((await call(base, '/api/team', { cookie: `${name}=${forged}.${sig}` })).status, 401);
    assert.equal((await call(base, '/api/team', { cookie: `${name}=${payload}.${sig.slice(0, -2)}xx` })).status, 401);
  });
});

test('25. the team API: a manager makes a rep (one-time password shown once), the list never shows a password or hash', async () => {
  const db = freshDb();
  readyStaff(db, 'SALES_MANAGER');
  await withApp(db, async (base) => {
    const { cookie } = await staffCookie(base, 'sales_manager@bfl.test');
    const denied = await call(base, '/api/team', { method: 'POST', cookie, body: { name: 'W', role: 'WAREHOUSE', email: 'w@bfl.test' } });
    assert.equal(denied.status, 403);
    const made = await call(base, '/api/team', { method: 'POST', cookie, body: { name: 'Akua', role: 'SALES_REP', repId: 'rep-2', phone: '0501234567' } });
    assert.equal(made.status, 201);
    const { user, temporaryPassword: temp } = await made.json();
    assert.equal(user.role, 'SALES_REP');
    assert.match(temp, /^[a-z2-9]{4}-/);
    const list = await (await call(base, '/api/team', { cookie })).json();
    const text = JSON.stringify(list);
    assert.ok(!text.includes(temp) && !/hash|scrypt|password/i.test(text.replace('mustChangePassword', '')));
    assert.deepEqual(list.roles.map((r) => r.role), ['SALES_REP']);
    // and the new rep can sign in with that phone number
    const rep = await call(base, '/api/staff/login', { method: 'POST', body: { identifier: '+233 50 123 4567', password: temp } });
    assert.equal(rep.status, 200);
    assert.equal((await rep.json()).home, '/rep.html');
  });
});

test('26. staff sign-in is throttled, and the throttle does not tell you whether the account exists', async () => {
  const db = freshDb();
  readyStaff(db, 'WAREHOUSE');
  await withApp(db, async (base) => {
    const first = await call(base, '/api/staff/login', { method: 'POST', body: { identifier: 'warehouse@bfl.test', password: 'wrong password' } });
    const ghost = await call(base, '/api/staff/login', { method: 'POST', body: { identifier: 'ghost@bfl.test', password: 'wrong password' } });
    assert.deepEqual(await first.json(), await ghost.json());
    let last;
    for (let i = 0; i < 8; i += 1) last = await call(base, '/api/staff/login', { method: 'POST', body: { identifier: 'warehouse@bfl.test', password: `bad ${i}` } });
    assert.equal(last.status, 429);
    assert.equal((await call(base, '/api/staff/login', { method: 'POST', body: { identifier: 'warehouse@bfl.test', password: PW } })).status, 429);
  });
});

test('27. staff reset a customer over the web: the customer must activate again with a new code', async () => {
  const db = freshDb();
  const { id, code } = activated(db);
  await withApp(db, async (base) => {
    readyStaff(db, 'SALES_MANAGER');
    const { cookie } = await staffCookie(base, 'sales_manager@bfl.test');
    const custCookie = await customerCookie(base, '4321');
    const res = await call(base, `/api/requests/customers/${id}/reset-password`, { method: 'POST', cookie, body: {} });
    assert.equal(res.status, 200);
    const { code: fresh } = await res.json();
    assert.notEqual(fresh, code);
    assert.equal((await call(base, '/api/auth/customer/login', { method: 'POST', body: { id: '4321', password: PW } })).status, 401);
    assert.equal((await (await call(base, '/api/auth/me', { cookie: custCookie })).json()).customer, null, 'their open session ended');
    const set = await call(base, `/api/requests/customers/${id}/odoo-id`, { method: 'PUT', cookie, body: { odooId: '5555' } });
    assert.equal(set.status, 200);
    const codes = await (await call(base, '/api/requests/customers/codes', { cookie })).json();
    const row = codes.items.find((c) => c.id === id);
    assert.equal(row.odoo_customer_ref, '5555');
    assert.equal(row.password_set, 0);
    assert.ok(!JSON.stringify(codes).includes('scrypt'), 'no hash in the staff list');
  });
});
