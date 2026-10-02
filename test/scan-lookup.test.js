// Scanner -> Product Master lookup, exercised through the real domain query
// plus the shared exact-match picker used by the browser scanner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, row } from './helpers.js';
import { searchProducts } from '../src/domain/products.js';
import { normalizeBarcode, pickExactProduct } from '../src/public/js/scan-core.js';

function lookup(db, scannedRaw) {
  const barcode = normalizeBarcode(scannedRaw);
  const { items } = searchProducts(db, { search: barcode, limit: 10 });
  return pickExactProduct(items, barcode);
}

test('product lookup: a scanned EAN-13 resolves to the matching product', () => {
  const db = freshDb();
  runImport(db, [
    row({ barcode: '5283007112449', name: 'SMEDS CHEESE CREAM', uom: 'CTN12', free: 4 }),
    row({ barcode: '108361', name: 'ABIDO MOGRABIEE', uom: 'CTN144' }),
  ]);
  const p = lookup(db, ' 5283007112449 '); // includes stray whitespace the scanner may emit
  assert.ok(p, 'expected a product');
  assert.equal(p.name, 'SMEDS CHEESE CREAM');
  assert.equal(p.barcode, '5283007112449');
  db.close();
});

test('product lookup: unknown barcode returns null (Barcode not found)', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '108361', name: 'ABIDO MOGRABIEE', uom: 'CTN144' })]);
  assert.equal(lookup(db, '9999999999999'), null);
  db.close();
});

test('product lookup: a partial/substring match does NOT count as found', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '5283007112449', name: 'Cheese', uom: 'CTN12' })]);
  // '528300' is a substring of the real barcode; LIKE would match but it is not exact
  assert.equal(lookup(db, '528300'), null);
  db.close();
});
