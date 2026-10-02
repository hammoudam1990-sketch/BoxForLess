import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStockStatus } from '../src/domain/stock.js';
import { normBarcode, parseStock, normalizeRecord } from '../src/domain/normalize.js';
import { mapHeaders } from '../src/import/headers.js';
import { StockStatus } from '../src/domain/constants.js';

test('stock status is computed from free_to_use thresholds', () => {
  assert.equal(computeStockStatus({ free_to_use: 0 }), StockStatus.OUT_OF_STOCK);
  assert.equal(computeStockStatus({ free_to_use: 3 }), StockStatus.LIMITED_STOCK);
  assert.equal(computeStockStatus({ free_to_use: 50 }), StockStatus.IN_STOCK);
});

test('barcode normalization preserves integers and long codes as text', () => {
  assert.equal(normBarcode(108361), '108361');
  assert.equal(normBarcode('5283007112449'), '5283007112449');
  assert.equal(normBarcode('  ABC12 '), 'ABC12');
  assert.equal(normBarcode(''), null);
});

test('parseStock accepts numbers/blanks, rejects non-numeric', () => {
  assert.deepEqual(parseStock(5), { value: 5, ok: true });
  assert.deepEqual(parseStock(''), { value: 0, ok: true });
  assert.deepEqual(parseStock(null), { value: 0, ok: true });
  assert.deepEqual(parseStock('1,200'), { value: 1200, ok: true });
  assert.equal(parseStock('abc').ok, false);
});

test('header mapping recognises real Odoo headers and flags unexpected', () => {
  const { mapping, unexpected, missingRequired } = mapHeaders([
    'Barcode', 'Name', 'Box UoM', 'On Hand (CTN, decimal)', 'Free To Use (CTN)',
    'Incoming (CTN)', 'Outgoing (CTN)', 'Forecasted (CTN, decimal)', 'Mystery Column',
  ]);
  assert.equal(mapping.barcode.header, 'Barcode');
  assert.equal(mapping.on_hand.header, 'On Hand (CTN, decimal)');
  assert.equal(mapping.forecasted.header, 'Forecasted (CTN, decimal)');
  assert.deepEqual(unexpected, ['Mystery Column']);
  assert.deepEqual(missingRequired, []);
});

test('normalizeRecord separates good values from non-numeric stock errors', () => {
  const { record, stockErrors } = normalizeRecord({
    barcode: '1', name: 'X', box_uom: 'CTN1', on_hand: 'oops', free_to_use: 2,
  });
  assert.equal(record.free_to_use, 2);
  assert.deepEqual(stockErrors, ['on_hand']);
});
