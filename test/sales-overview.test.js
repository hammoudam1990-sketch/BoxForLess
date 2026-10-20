// The Sales Manager aggregates count requests, lines and cartons. They must never carry a
// price, and withdrawn requests must not be counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, row, tmpUploads } from './helpers.js';
import { submitRequest, deleteRequest, acceptRequest } from '../src/domain/requests.js';
import { salesOverview } from '../src/domain/sales-overview.js';

const A = { barcode: '5283013330912', name: 'PLEIN SOLEIL CHICKEN STOCK', uom: 'CTN24', free: 50 };
const B = { barcode: '5283013330929', name: 'THREE CHEFS FETA', uom: 'CTN12', free: 50 };
const line = (p, q) => ({ barcode: p.barcode, quantityCtn: q });
const unlisted = (company) => ({ company, contact: 'Ama', phone: '0240000000' });

function seed() {
  const db = freshDb();
  runImport(db, [A, B].map(row), { uploadsDir: tmpUploads() });
  return db;
}

test('sales overview counts requests, lines and cartons and ranks products', () => {
  const db = seed();
  submitRequest(db, { lines: [line(A, 5), line(B, 2)], unlisted: unlisted('Melcom') });
  submitRequest(db, { lines: [line(A, 3)], unlisted: unlisted('Melcom') });
  submitRequest(db, { lines: [line(B, 1)], unlisted: unlisted('Shoprite') });

  const o = salesOverview(db, { days: 7 });
  assert.equal(o.current.requests, 3);
  assert.equal(o.current.lines, 4);
  assert.equal(o.current.cartons, 11);
  assert.equal(o.current.customers, 2);
  assert.equal(o.series.length, 7);
  assert.equal(o.series.reduce((n, s) => n + s.requests, 0), 3);
  assert.deepEqual(o.topProducts.map((p) => [p.name, p.cartons]), [['PLEIN SOLEIL CHICKEN STOCK', 8], ['THREE CHEFS FETA', 3]]);
  assert.equal(o.topCustomers[0].name, 'Melcom');
  assert.equal(o.topCustomers[0].cartons, 10);
  assert.equal(o.attention.pendingApproval, 3);
  assert.equal(o.attention.unmatchedCustomers, 3);
});

test('withdrawn requests are excluded and accepted ones leave the pending count', () => {
  const db = seed();
  const a = submitRequest(db, { lines: [line(A, 4)], unlisted: unlisted('Melcom') });
  const b = submitRequest(db, { lines: [line(B, 9)], unlisted: unlisted('Shoprite') });
  deleteRequest(db, b.requestId);
  acceptRequest(db, a.requestId);

  const o = salesOverview(db, { days: 30 });
  assert.equal(o.current.requests, 1);
  assert.equal(o.current.cartons, 4);
  assert.equal(o.attention.pendingApproval, 0);
});

test('sales overview never exposes a price or amount', () => {
  const db = seed();
  submitRequest(db, { lines: [line(A, 1)], unlisted: unlisted('Melcom') });
  const json = JSON.stringify(salesOverview(db));
  assert.doesNotMatch(json, /price|amount|total_value|pricelist|credit/i);
});

test('an unsupported window falls back to 30 days', () => {
  assert.equal(salesOverview(freshDb(), { days: 5 }).days, 30);
});

test('the status chart excludes withdrawn requests', () => {
  const db = seed();
  submitRequest(db, { lines: [line(A, 1)], unlisted: unlisted('Melcom') });
  const b = submitRequest(db, { lines: [line(B, 1)], unlisted: unlisted('Shoprite') });
  deleteRequest(db, b.requestId);
  assert.equal(salesOverview(db, { days: 7 }).statusCounts.DELETED, undefined);
});
