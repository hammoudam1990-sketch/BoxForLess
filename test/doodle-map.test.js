// Which drawing a product gets. Covers the pure rules in src/public/js/catalog/doodle-map.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { doodleFor, doodleForTop } from '../src/public/js/catalog/doodle-map.js';

const cat = (top_level, parent, name = parent) => ({ top_level, parent, name, path: `${top_level} / ${parent} / ${name}` });

test('a bag of rice is a sack, whatever shelf it sits on', () => {
  assert.equal(doodleFor({ name: 'BASMATI RICE 5KG', category: cat('FOOD', 'PANTRY & DRY GOODS') }), 'sack');
  assert.equal(doodleFor({ name: 'ALMOND FLOUR 1KG', category: cat('FOOD', 'BAKING & DESSERT') }), 'sack');
  // but only for plain food: a rice cracker is a snack and rice milk is a drink
  assert.equal(doodleFor({ name: 'RICE CRACKERS', category: cat('FOOD', 'SNACKS & CONFECTIONERY') }), 'candy');
  assert.equal(doodleFor({ name: 'RICE MILK 1L', category: cat('DRINKS & BEVERAGES', 'DAIRY DRINKS') }), 'carton');
});

test('the name rule matches whole words only', () => {
  assert.notEqual(doodleFor({ name: 'PRICEY SAUCE', category: cat('FOOD', 'CONDIMENTS, SAUCES & PASTES') }), 'sack');
  assert.notEqual(doodleFor({ name: 'SUGARED ALMONDS', category: cat('FOOD', 'SNACKS & CONFECTIONERY') }), 'sack');
});

test('drinks get bottles, cups and glasses', () => {
  assert.equal(doodleFor({ name: 'ORANGE JUICE 1L', category: cat('DRINKS & BEVERAGES', 'JUICES & NECTARS') }), 'bottle');
  assert.equal(doodleFor({ name: 'COLA 330ML', category: cat('DRINKS & BEVERAGES', 'SOFT DRINKS') }), 'bottle');
  assert.equal(doodleFor({ name: 'GREEN TEA', category: cat('DRINKS & BEVERAGES', 'TEA') }), 'cup');
  assert.equal(doodleFor({ name: 'ARABICA', category: cat('DRINKS & BEVERAGES', 'COFFEE') }), 'cup');
  assert.equal(doodleFor({ name: 'RED WINE', category: cat('DRINKS & BEVERAGES', 'ALCOHOLIC BEVERAGES') }), 'glass');
});

test('food shelves each get their own drawing', () => {
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'SPICES & SEASONINGS', 'GROUND SPICES') }), 'jar');
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'CANNED & PRESERVED FOODS') }), 'can');
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'COOKING OILS & FATS') }), 'oil');
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'DAIRY & CHILLED') }), 'carton');
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'MEAT & POULTRY') }), 'meat');
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'SNACKS & CONFECTIONERY') }), 'candy');
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'BAKING & DESSERT') }), 'cake');
});

test('non-food shelves', () => {
  assert.equal(doodleFor({ name: 'X', category: cat('NON-FOOD', 'HOME CARE — CLEANING') }), 'spray');
  assert.equal(doodleFor({ name: 'X', category: cat('NON-FOOD', 'HOME CARE — LAUNDRY') }), 'spray');
  assert.equal(doodleFor({ name: 'X', category: cat('NON-FOOD', 'PERSONAL CARE — HAIR') }), 'pump');
  assert.equal(doodleFor({ name: 'X', category: cat('NON-FOOD', 'FRAGRANCE') }), 'pump');
  assert.equal(doodleFor({ name: 'X', category: cat('NON-FOOD', 'PAPER & HYGIENE') }), 'roll');
  assert.equal(doodleFor({ name: 'X', category: cat('NON-FOOD', 'FOOD SERVICE & PACKAGING') }), 'box');
  assert.equal(doodleFor({ name: 'X', category: cat('PETS', 'PET FOOD') }), 'paw');
});

test('an unknown or missing category falls back to food / non-food', () => {
  assert.equal(doodleFor({ name: 'X', category: cat('FOOD', 'SOMETHING NEW') }), 'bowl');
  assert.equal(doodleFor({ name: 'X', category: cat('NON-FOOD', 'SOMETHING NEW') }), 'box');
  assert.equal(doodleFor({ name: 'X', category: cat('DRINKS & BEVERAGES', 'SOMETHING NEW') }), 'bottle');
  assert.equal(doodleFor({ name: 'X', category: null }), 'box');
  assert.equal(doodleFor(), 'box');
});

test('top-level tiles', () => {
  assert.equal(doodleForTop('FOOD'), 'bowl');
  assert.equal(doodleForTop('DRINKS & BEVERAGES'), 'bottle');
  assert.equal(doodleForTop('NON-FOOD'), 'box');
  assert.equal(doodleForTop('PETS'), 'paw');
  assert.equal(doodleForTop('SOMETHING ELSE'), 'box');
});
