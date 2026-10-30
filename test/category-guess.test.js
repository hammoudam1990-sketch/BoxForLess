// Non-food products in the shop (domain/category-guess.js): perfumes, detergents, shampoos and cleaners that the
// Odoo export sent without a category are filed under NON-FOOD by their name, not under FOOD / SPICES. A category
// Odoo gave always wins, nothing is deleted, and every move is logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, row } from './helpers.js';
import {
  guessCategoryPath, nonFoodPathFor, fileUncategorised, refileGuessedNonFood, FALLBACK_PATH,
} from '../src/domain/category-guess.js';
import { categoryFacets, searchCatalog } from '../src/domain/catalog.js';

const NAMES = {
  'DER GENERAL PERFUME PINE 750ML*21 [BL02665]': 'NON-FOOD / HOUSEHOLD CLEANING',
  'ADIDAS PERFUME PURE GAME 100ML * 12 [DA05432]': 'NON-FOOD / PERFUMES & FRAGRANCES',
  'PERSIL LIQUID DETERGENT DEEP CLEAN LAVENDER  GEL 2.5LT * 6 [BL02942]': 'NON-FOOD / DETERGENTS & LAUNDRY',
  'COMFORT SOFTENER BLUE SKY 1LTR * 12 [BL02633]': 'NON-FOOD / DETERGENTS & LAUNDRY',
  'CARMEL ALL PURPOSE CLEANER LAVENDER FRAGRANCE 800ML * 12 [BL02616]': 'NON-FOOD / HOUSEHOLD CLEANING',
  'PRIL DISHWASHING LIQUID SECRET OF THE COOK LEMON 1.2L * 10 [BL02964]': 'NON-FOOD / HOUSEHOLD CLEANING',
  'SUNSILK SHAMPOO SHINE  STRENGTH  600ML  16 [BL03021]': 'NON-FOOD / PERSONAL CARE',
  'HEAD AND SHOULDERS DAILY CLEAN 350ML * 6 [BL02884]': 'NON-FOOD / PERSONAL CARE',
  'SW HandWash Lavender Tangerine 550ml * 12 [BL03036]': 'NON-FOOD / PERSONAL CARE',
  'HAPPY WET WIPES 100S 100SH 24 [BL02877]': 'NON-FOOD / PAPER & DISPOSABLES',
  'HAPPY TOWELS INTERFOLD PAPER 21X21CM 120S *24 [BL03568]': 'NON-FOOD / PAPER & DISPOSABLES',
};
const FOOD = {
  'ABIDO ALL SPICE GROUND 500G * 14': 'FOOD / SPICES & SEASONINGS / GROUND SPICES',
  'LAZIZA MALT DRINK 330ML * 24': 'DRINKS & BEVERAGES / MALT DRINKS',
  'AL AMIR FETA CHEESE WITH MINT 10KG * 1': 'FOOD / PICKLES & CONDIMENTS',
  'PLEIN SOLEIL CANNED COCONUT CREAM 400ML * 24': 'FOOD / CANNED & PRESERVED FOODS',
  'DOMO CHANTILLE VANILLA WHIPPED CREAM 72G *24': FALLBACK_PATH,
  'HAPPY  ITALIAN RICE 3.5KG 6': FALLBACK_PATH,
  'ROLLZ SOUR CREAM AND ONION 150G * 24': FALLBACK_PATH,
};

test('1. perfumes, detergents, cleaners, personal care and paper read as NON-FOOD, each in its own group', () => {
  for (const [name, path] of Object.entries(NAMES)) assert.equal(guessCategoryPath(name), path, name);
});

test('2. food and drink names are filed exactly as before (a cream, a rice or a snack is not non-food)', () => {
  for (const [name, path] of Object.entries(FOOD)) {
    assert.equal(nonFoodPathFor(name), null, name);
    assert.equal(guessCategoryPath(name), path, name);
  }
});

/** A database whose products were filed by the old guess: everything unknown under FOOD / SPICES & SEASONINGS. */
function oldStyle() {
  const db = freshDb();
  runImport(db, [
    row({ barcode: '4000000000011', name: 'ADIDAS PERFUME PURE GAME 100ML * 12', uom: 'CTN12', on_hand: 10, free: 10 }),
    row({ barcode: '4000000000028', name: 'PERSIL LIQUID DETERGENT DEEP CLEAN 2.5LT * 6', uom: 'CTN6', on_hand: 4, free: 4 }),
    row({ barcode: '4000000000035', name: 'ABIDO ALL SPICE GROUND 500G * 14', uom: 'CTN14', on_hand: 8, free: 8 }),
  ]);
  db.prepare('UPDATE products SET odoo_category_path = ?').run(FALLBACK_PATH);
  return db;
}

test('3. products filed by the old guess move to NON-FOOD; food stays; every move is logged; nothing is deleted', () => {
  const db = oldStyle();
  const before = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  const moves = refileGuessedNonFood(db, { now: '2026-10-30T10:00:00.000Z' });
  assert.deepEqual(moves.map((m) => [m.barcode, m.from, m.to]), [
    ['4000000000011', FALLBACK_PATH, 'NON-FOOD / PERFUMES & FRAGRANCES'],
    ['4000000000028', FALLBACK_PATH, 'NON-FOOD / DETERGENTS & LAUNDRY'],
  ]);
  const cat = (b) => db.prepare('SELECT p.odoo_category_path path, c.path cpath FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE barcode = ?').get(b);
  assert.deepEqual({ ...cat('4000000000011') }, { path: 'NON-FOOD / PERFUMES & FRAGRANCES', cpath: 'NON-FOOD / PERFUMES & FRAGRANCES' });
  assert.equal(cat('4000000000035').path, FALLBACK_PATH);
  const log = db.prepare('SELECT barcode, old_path, new_path, reason FROM category_guess_log ORDER BY id').all();
  assert.equal(log.length, 2);
  assert.match(log[0].reason, /no category from Odoo/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, before);
  assert.deepEqual(refileGuessedNonFood(db), [], 'running it again moves nothing');
});

test('4. a category Odoo gave is never overridden, and a product kept on purpose is left alone', () => {
  const db = freshDb();
  runImport(db, [
    { ...row({ barcode: '4000000000042', name: 'ADIDAS PERFUME DYNAMIC PULSE 100ML * 12', uom: 'CTN12', on_hand: 5, free: 5 }), 'Product Category': 'GIFTS / SEASONAL' },
    { ...row({ barcode: '4000000000059', name: 'SUNSILK SHAMPOO 600ML 16', uom: 'CTN16', on_hand: 5, free: 5 }), 'Product Category': 'GIFTS / SEASONAL' },
  ]);
  assert.equal(db.prepare("SELECT odoo_category_path p FROM products WHERE barcode = '4000000000042'").get().p, 'GIFTS / SEASONAL');
  db.prepare("UPDATE import_changes SET change_type = 'PRODUCT_UPDATED' WHERE barcode = '4000000000059' AND change_type = 'CATEGORY_CHANGE_DETECTED'").run();
  const moves = refileGuessedNonFood(db, { keep: ['4000000000059'] });
  assert.deepEqual(moves, [], 'Odoo categorised the perfume; the shampoo is on the keep list');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM category_guess_log').get().n, 0);
});

test('5. a new product with no category is filed by its name straight away', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '4000000000066', name: 'HAPPY ALL PURPOSE CLEANER PINE 3.5L 6', uom: 'CTN6', on_hand: 3, free: 3 })]);
  assert.equal(fileUncategorised(db), 1);
  assert.equal(db.prepare("SELECT odoo_category_path p FROM products WHERE barcode = '4000000000066'").get().p, 'NON-FOOD / HOUSEHOLD CLEANING');
});

test('6. the customer shop shows a NON-FOOD department with its groups, and lists its products', () => {
  const db = oldStyle();
  refileGuessedNonFood(db);
  const items = categoryFacets(db, { view: 'full' });
  const top = items.find((c) => c.level === 1 && c.path === 'NON-FOOD');
  assert.ok(top, 'a NON-FOOD tile');
  assert.equal(top.count, 2);
  assert.deepEqual(items.filter((c) => c.level === 2 && c.path.startsWith('NON-FOOD / ')).map((c) => c.name).sort(), ['DETERGENTS & LAUNDRY', 'PERFUMES & FRAGRANCES']);
  const list = searchCatalog(db, { topLevel: 'NON-FOOD' });
  assert.deepEqual(list.items.map((p) => p.name).sort(), ['ADIDAS PERFUME PURE GAME 100ML * 12', 'PERSIL LIQUID DETERGENT DEEP CLEAN 2.5LT * 6']);
});
