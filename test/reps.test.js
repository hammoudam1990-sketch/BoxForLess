// Sales reps and their customers: a new rep account becomes a rep with no customers, the Sales Manager
// gives customers to reps, and a rep sees only their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { createStaffUser } from '../src/domain/staff-accounts.js';
import { allReps, assignments, assignCustomer, RepError } from '../src/domain/reps.js';
import { myVisits, visitSheet, listReps } from '../src/domain/shelf.js';
import { repChoices } from '../src/domain/access-requests.js';
import { repMonth } from '../src/domain/reports.js';

const TODAY = new Date().toISOString().slice(0, 10);
const newRep = (db, name, email, extra = {}) => createStaffUser(db, { name, email, role: 'SALES_REP', ...extra }, 'ADMIN', 'Administrator').user;

test('1. a rep account with no sample rep chosen becomes a new rep with its own id', () => {
  const db = freshDb();
  const u = newRep(db, 'Radi Abdo', 'radi@bfl.test');
  assert.match(u.repId, /^rep-u\d+$/);
  assert.ok(allReps(db).some((r) => r.id === u.repId && r.name === 'Radi Abdo' && !r.sample));
  assert.deepEqual(myVisits(db, u.repId, { today: TODAY }).customers, []); // no customers yet
});

test('2. the sample reps are still there, and a sample rep can still be linked to an account', () => {
  const db = freshDb();
  assert.deepEqual(listReps(TODAY, db).filter((r) => r.sample).map((r) => r.id), ['rep-1', 'rep-2']);
  const u = newRep(db, 'Kwame', 'kwame@bfl.test', { repId: 'rep-1' });
  assert.equal(u.repId, 'rep-1');
  assert.throws(() => newRep(db, 'Other', 'o@bfl.test', { repId: 'rep-1' }), /already has an account/);
  assert.throws(() => newRep(db, 'Other', 'o@bfl.test', { repId: 'rep-99' }), /Choose which sales rep/);
});

test('3. giving a sample shop to a new rep moves it from the old rep, and each sees only their own', () => {
  const db = freshDb();
  const radi = newRep(db, 'Radi Abdo', 'radi@bfl.test');
  const before = myVisits(db, 'rep-1', { today: TODAY }).customers;
  assert.ok(before.length > 0);
  const shop = before[0];
  assignCustomer(db, { kind: 'SHOP', id: shop.id, repId: radi.repId }, 'Manager');
  assert.ok(!myVisits(db, 'rep-1', { today: TODAY }).customers.some((s) => s.id === (shop.id)));
  assert.equal(myVisits(db, radi.repId, { today: TODAY }).customers.length, 1);
  // the old rep cannot open the shop any more: it looks like it does not exist
  assert.throws(() => visitSheet(db, 'rep-1', shop.id, { today: TODAY }), /not on your list/);
  assert.ok(visitSheet(db, radi.repId, shop.id, { today: TODAY }).customer);
});

test('4. "no rep" takes a shop away from everyone, and it can be given back', () => {
  const db = freshDb();
  const shop = myVisits(db, 'rep-1', { today: TODAY }).customers[0];
  const id = shop.id;
  assignCustomer(db, { kind: 'SHOP', id, repId: null });
  assert.ok(!myVisits(db, 'rep-1', { today: TODAY }).customers.some((s) => s.id === id));
  assert.ok(!myVisits(db, 'rep-2', { today: TODAY }).customers.some((s) => s.id === id));
  assert.equal(assignments(db).shops.find((s) => s.id === id).repId, null);
  assignCustomer(db, { kind: 'SHOP', id, repId: 'rep-2' });
  assert.ok(myVisits(db, 'rep-2', { today: TODAY }).customers.some((s) => s.id === id));
});

test('5. a BFL customer given to a rep carries the rep name, and the rep\'s month counts them', () => {
  const db = freshDb();
  const radi = newRep(db, 'Radi Abdo', 'radi@bfl.test');
  const ts = new Date().toISOString();
  const cid = Number(db.prepare("INSERT INTO customers (name, is_active, created_at, updated_at) VALUES ('Kofi Traders', 1, ?, ?)").run(ts, ts).lastInsertRowid);
  assignCustomer(db, { kind: 'BFL', id: cid, repId: radi.repId });
  assert.equal(db.prepare('SELECT salesperson FROM customers WHERE id = ?').get(cid).salesperson, 'Radi Abdo');
  assert.equal(assignments(db).customers.find((c) => c.id === cid).repId, radi.repId);
  assert.equal(repMonth(db, 'Radi Abdo', TODAY.slice(0, 7), TODAY).customers, 1);
  assignCustomer(db, { kind: 'BFL', id: cid, repId: null });
  assert.equal(db.prepare('SELECT salesperson FROM customers WHERE id = ?').get(cid).salesperson, null);
});

test('6. unknown reps, shops and customers are refused', () => {
  const db = freshDb();
  assert.throws(() => assignCustomer(db, { kind: 'SHOP', id: 4101, repId: 'rep-404' }), RepError);
  assert.throws(() => assignCustomer(db, { kind: 'SHOP', id: 999999, repId: 'rep-1' }), /does not exist/);
  assert.throws(() => assignCustomer(db, { kind: 'BFL', id: 999999, repId: 'rep-1' }), /does not exist/);
  assert.throws(() => assignCustomer(db, { kind: 'OTHER', id: 1, repId: 'rep-1' }), /Unknown kind/);
});

test('7. a new rep can be chosen when a registration is approved; a switched-off rep cannot', () => {
  const db = freshDb();
  const radi = newRep(db, 'Radi Abdo', 'radi@bfl.test');
  assert.ok(repChoices(db).some((r) => r.id === radi.repId));
  db.prepare('UPDATE staff_users SET is_active = 0 WHERE id = ?').run(radi.id);
  assert.ok(!repChoices(db).some((r) => r.id === radi.repId));
});

test('8. nothing here deletes a customer, and the screen is for managers only', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/domain/reps.js', import.meta.url), 'utf8');
  assert.ok(!/DELETE FROM (customers|staff_users)/i.test(src));
  const idx = fs.readFileSync(new URL('../src/server/index.js', import.meta.url), 'utf8');
  assert.match(idx, /app\.use\('\/api\/reps', requireStaff, requireRole\('ADMIN', 'SALES_MANAGER'\)/);
});
