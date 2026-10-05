// The request cart's line ORDER.
//
// Reported from a real customer session: pressing − on a line sent that product to
// the bottom of the cart, so the row moved out from under the customer's finger and
// the next press landed on whatever had shifted up into its place. The cause was
// setQuantity() filtering the line out and pushing it back on.
//
// cart.js is a browser module and reads localStorage at call time, so a minimal
// stub stands in for it here.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

const { setQuantity, readCart, addToCart, removeFromCart, clearCart } = await import('../src/public/js/cart.js');

const PENNE = { barcode: '5283035600031', name: 'PASTA NONNA PENNE REGATE 20 * 400 G', pack: 'CTN20' };
const LINGUINE = { barcode: '5283035600024', name: 'PASTA NONNA LINGUINE 24 * 400 G', pack: 'CTN24' };
const BUGLES = { barcode: '5281013003997', name: 'FANTASIA BUGLES CHEESE CHIPS 21G 30', pack: 'CTN30' };

const names = () => readCart().map((l) => l.name);

beforeEach(() => {
  clearCart();
  setQuantity(PENNE, 6);
  setQuantity(LINGUINE, 6);
  setQuantity(BUGLES, 1);
});

test('decreasing a quantity does NOT move the line', () => {
  const before = names();
  setQuantity({ barcode: PENNE.barcode }, 5);
  assert.deepEqual(names(), before, 'the first line must stay first');
  setQuantity({ barcode: PENNE.barcode }, 4);
  assert.deepEqual(names(), before, 'and stay put however many times it is pressed');
  assert.equal(readCart()[0].quantityCtn, 4);
});

test('increasing a quantity does NOT move the line', () => {
  const before = names();
  setQuantity({ barcode: LINGUINE.barcode }, 7);
  assert.deepEqual(names(), before, 'a middle line must stay in the middle');
  assert.equal(readCart()[1].quantityCtn, 7);
});

test('repeatedly pressing the same control keeps every other line still', () => {
  const before = names();
  for (let q = 5; q >= 1; q -= 1) {
    setQuantity({ barcode: PENNE.barcode }, q);
    assert.deepEqual(names(), before, `order changed at quantity ${q}`);
  }
});

test('a quantity change made WITHOUT a label keeps the label already stored', () => {
  // The drawer's steppers pass only a barcode when the line is already in the cart.
  setQuantity({ barcode: LINGUINE.barcode }, 3);
  const line = readCart().find((l) => l.barcode === LINGUINE.barcode);
  assert.equal(line.name, LINGUINE.name, 'the product name must survive');
  assert.equal(line.pack, LINGUINE.pack, 'and so must the pack');
});

test('dropping to zero removes the line and leaves the others in order', () => {
  setQuantity({ barcode: PENNE.barcode }, 0);
  assert.deepEqual(names(), [LINGUINE.name, BUGLES.name]);
  removeFromCart(LINGUINE.barcode);
  assert.deepEqual(names(), [BUGLES.name]);
});

test('a genuinely new product is appended, not inserted', () => {
  const extra = { barcode: '9999999999999', name: 'NEW PRODUCT', pack: 'CTN6' };
  setQuantity(extra, 2);
  assert.deepEqual(names(), [PENNE.name, LINGUINE.name, BUGLES.name, extra.name]);
});

test('addToCart increments in place rather than re-ordering', () => {
  const before = names();
  addToCart(PENNE, 2);
  assert.deepEqual(names(), before);
  assert.equal(readCart()[0].quantityCtn, 8);
});
