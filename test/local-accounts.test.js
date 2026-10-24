import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccountStore, sha256, phoneKey, DEMO_LOGINS } from '../src/public/js/lib/local-accounts.js';

function fakeStorage() {
  const data = new Map();
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

const valid = {
  company: 'Sunrise Provisions Ltd', contact: 'Yaw Darko', phone: '024 123 4567',
  email: 'Yaw@Sunrise.example', address: 'Shop 2, Market Road, Accra', password: 'longenough', confirm: 'longenough',
};

test('sha256 matches node:crypto', () => {
  for (const text of ['', 'abc', 'salt:password', 'é—unicode ✓', 'x'.repeat(200)]) {
    assert.equal(sha256(text), crypto.createHash('sha256').update(text).digest('hex'));
  }
});

test('phone numbers compare by digits, +233 and 0 forms alike', () => {
  assert.equal(phoneKey('+233 24 123 4567'), '0241234567');
  assert.equal(phoneKey('024-123-4567'), '0241234567');
});

test('demo accounts are seeded once and can sign in; pending cannot', () => {
  const storage = fakeStorage();
  const store = createAccountStore(storage);
  store.seedDemo();
  store.seedDemo();
  const saved = JSON.parse(storage.getItem('bfl.local.accounts.v1'));
  assert.equal(saved.length, DEMO_LOGINS.length);

  const credit = DEMO_LOGINS.find((d) => d.type === 'credit');
  assert.equal(store.signIn(credit.email, credit.password).ok, true);
  assert.equal(store.currentAccount().email, credit.email);

  const pending = DEMO_LOGINS.find((d) => d.status === 'pending');
  const result = store.signIn(pending.email, pending.password);
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
});

test('registration validates, rejects duplicates, and is pending until approved', () => {
  const store = createAccountStore(fakeStorage());
  assert.equal(store.register({ ...valid, email: 'not-an-email' }).field, 'email');
  assert.equal(store.register({ ...valid, confirm: 'different!' }).field, 'confirm');
  assert.equal(store.register({ ...valid, password: 'short', confirm: 'short' }).field, 'password');

  const ok = store.register(valid);
  assert.equal(ok.ok, true);
  assert.equal(ok.account.status, 'pending');
  assert.equal(ok.account.email, 'yaw@sunrise.example');
  assert.equal('passwordHash' in ok.account, false);
  assert.equal('salt' in ok.account, false);

  assert.equal(store.register({ ...valid, phone: '0999999999' }).field, 'email');
  assert.equal(store.register({ ...valid, email: 'other@sunrise.example', phone: '+233241234567' }).field, 'phone');
  assert.equal(store.signIn('yaw@sunrise.example', 'longenough').pending, true);
});

test('sign-in by email or phone, wrong password refused, session expires and signs out', () => {
  const storage = fakeStorage();
  let clock = Date.parse('2026-10-17T08:00:00Z');
  const store = createAccountStore(storage, () => clock);
  store.register(valid);
  // approve it as the Sales Manager would (no approval screen yet)
  const list = JSON.parse(storage.getItem('bfl.local.accounts.v1'));
  list[0].status = 'approved';
  storage.setItem('bfl.local.accounts.v1', JSON.stringify(list));

  assert.equal(store.signIn('yaw@sunrise.example', 'wrong-password').ok, false);
  assert.equal(store.signIn('+233 24 123 4567', 'longenough', false).ok, true);
  assert.equal(store.currentAccount().company, 'Sunrise Provisions Ltd');
  assert.equal('passwordHash' in store.currentAccount(), false);

  clock += 13 * 60 * 60 * 1000;    // past the 12-hour session without "Remember me"
  assert.equal(store.currentAccount(), null);

  assert.equal(store.signIn('YAW@sunrise.example', 'longenough', true).ok, true);
  store.signOut();
  assert.equal(store.currentAccount(), null);
});

test('storage that throws behaves as empty, never crashes', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const store = createAccountStore(broken);
  assert.equal(store.currentAccount(), null);
  assert.equal(store.signIn('a@b.co', 'whatever').ok, false);
  assert.equal(store.register(valid).ok, false);
  store.signOut();
});
