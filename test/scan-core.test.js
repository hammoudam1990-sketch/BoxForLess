import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseDecoder, normalizeBarcode, isValidEan13, pickExactProduct, createDebouncer,
} from '../src/public/js/scan-core.js';

test('decoder selection: native BarcodeDetector preferred when available', () => {
  assert.equal(chooseDecoder({ hasBarcodeDetector: true }), 'native');
});

test('decoder selection: falls back to ZXing when BarcodeDetector absent', () => {
  assert.equal(chooseDecoder({ hasBarcodeDetector: false }), 'zxing');
  assert.equal(chooseDecoder({}), 'zxing');
});

test('barcode normalization strips whitespace and control/zero-width chars', () => {
  assert.equal(normalizeBarcode(' 5283007112449 '), '5283007112449');
  assert.equal(normalizeBarcode('528 300 7112449'), '5283007112449');
  assert.equal(normalizeBarcode('​5283007112449\n'), '5283007112449');
  assert.equal(normalizeBarcode(5283007112449), '5283007112449');
  assert.equal(normalizeBarcode(null), '');
  assert.equal(normalizeBarcode(undefined), '');
});

test('EAN-13 detection handling: valid checksum accepted, invalid rejected', () => {
  assert.equal(isValidEan13('5283007112449'), true);   // real valid EAN-13
  assert.equal(isValidEan13('5283007112440'), false);  // wrong check digit
  assert.equal(isValidEan13('528300711244'), false);   // 12 digits
  assert.equal(isValidEan13('52830071124499'), false); // 14 digits
  assert.equal(isValidEan13('52830071124AB'), false);  // non-numeric
  assert.equal(isValidEan13(''), false);
});

test('exact product pick: returns exact barcode match, null otherwise', () => {
  const items = [
    { id: 1, barcode: '5283007112449', name: 'Cheese' },
    { id: 2, barcode: '108361', name: 'Spices' },
  ];
  assert.equal(pickExactProduct(items, '108361').id, 2);
  assert.equal(pickExactProduct(items, '5283007112449').id, 1);
  assert.equal(pickExactProduct(items, '528'), null);      // partial must NOT match
  assert.equal(pickExactProduct([], '108361'), null);
  assert.equal(pickExactProduct(null, '108361'), null);
});

test('debounce: suppresses repeated detections of the same barcode in-window', () => {
  const d = createDebouncer({ windowMs: 2500 });
  assert.equal(d.shouldAccept('AAA', 1000), true);   // first time
  assert.equal(d.shouldAccept('AAA', 1500), false);  // duplicate within window
  assert.equal(d.shouldAccept('AAA', 2000), false);  // still within window
  assert.equal(d.shouldAccept('AAA', 3600), true);   // window elapsed -> allowed again
});

test('debounce: a different barcode is accepted immediately', () => {
  const d = createDebouncer({ windowMs: 2500 });
  assert.equal(d.shouldAccept('AAA', 1000), true);
  assert.equal(d.shouldAccept('BBB', 1100), true);
});

test('debounce: lock suppresses everything until unlock (result on screen)', () => {
  const d = createDebouncer({ windowMs: 2500 });
  assert.equal(d.shouldAccept('AAA', 1000), true);
  d.lock();
  assert.equal(d.shouldAccept('BBB', 1200), false); // locked while showing product
  assert.equal(d.shouldAccept('CCC', 1300), false);
  d.unlock(5000);
  assert.equal(d.shouldAccept('AAA', 5100), true);  // same code allowed after unlock
});
