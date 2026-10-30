// A product's category when Odoo has not given one.
//
// Odoo is the source of truth for categories: an Odoo export with a "Product Category" column sets every product's
// category (import/commit.js), and that always wins. The exports loaded so far have no such column, so at start-up
// bootstrap.js files each uncategorised product by its name — a stand-in until Odoo sends the category.
//
// The first version of that guess knew only food and drinks and filed everything else under FOOD / SPICES &
// SEASONINGS, so perfumes, detergents and shampoos were sold as spices. The NON-FOOD rules below come first; the food
// and drink rules after them are the original ones, unchanged and in the same order.
//
// `refileGuessedNonFood` moves a product that was filed by name, and whose name now reads as non-food, into its
// NON-FOOD category. A product whose category came from Odoo (an import logged CATEGORY_CHANGE_DETECTED for it) is
// never touched, nothing is deleted, and every move is written to category_guess_log.
import { ensureCategoryPath } from './categories.js';
import { ChangeType } from './constants.js';

export const NON_FOOD = 'NON-FOOD';
export const FALLBACK_PATH = 'FOOD / SPICES & SEASONINGS';

const word = (...words) => new RegExp(`\\b(?:${words.join('|')})\\b`);

/** Most specific first: a cleaner "with lavender fragrance" is a cleaner, a shampoo is not a perfume. */
const NON_FOOD_RULES = Object.freeze([
  { path: `${NON_FOOD} / HOUSEHOLD CLEANING`, test: word('DER GENERAL', 'ALL PURPOSE CLEANER', 'FLOOR CLEANER', 'GLASS CLEANER', 'TOILET CLEANER', 'CLEANER', 'DISHWASHING', 'DISH WASHING', 'DISHWASH', 'PRIL', 'AJAX', 'JIF CREAM', 'JIF MULTI PURPOSE', 'JIF ULTRA FAST', 'AIR FRESHENER', 'DISINFECTANT', 'INSECTICIDE', 'SCOURER', 'SCOURING') },
  { path: `${NON_FOOD} / DETERGENTS & LAUNDRY`, test: word('DETERGENT', 'WASHING POWDER', 'LAUNDRY', 'ARIEL', 'PERSIL', 'OMO', 'BLEACH', 'FABRIC SOFTENER', 'SOFTENER', 'COMFORT', 'DOWNY', 'STAIN REMOVER') },
  { path: `${NON_FOOD} / PERSONAL CARE`, test: word('SHAMPOO', 'SHAMPOOBLACKBLACK', 'CONDITIONER', 'HAIR SPRAY', 'HAIR GEL', 'HAIR CREAM', 'HEAD AND SHOULDERS', 'HEAD & SHOULDERS', 'HANDWASH', 'HAND WASH', 'BODY WASH', 'SHOWER GEL', 'SOAP', 'BODY LOTION', 'LOTION', 'TOOTHPASTE', 'TOOTHBRUSH', 'MOUTHWASH', 'DEODORANT', 'ANTIPERSPIRANT', 'ROLL ON', 'SHAVING', 'RAZOR', 'SANITARY PAD', 'SANITARY PADS', 'LOUFA', 'LOOFA', 'LOOFAH', 'SW HANDW', 'SW KIDS SHP') },
  { path: `${NON_FOOD} / PERFUMES & FRAGRANCES`, test: word('PERFUME', 'PERFUMES', 'EAU DE PARFUM', 'EAU DE TOILETTE', 'COLOGNE', 'BODY SPRAY', 'BODY MIST') },
  { path: `${NON_FOOD} / PAPER & DISPOSABLES`, test: word('TISSUE', 'TISSUES', 'TOILET ROLL', 'TOILET PAPER', 'KITCHEN ROLL', 'KITCHEN TOWEL', 'PAPER TOWEL', 'PAPER TOWELS', 'TOWELS INTERFOLD', 'INTERFOLD', 'NAPKIN', 'NAPKINS', 'SERVIETTE', 'SERVIETTES', 'DIAPER', 'DIAPERS', 'WET WIPES', 'BABY WIPES', 'ALUMINIUM FOIL', 'ALUMINUM FOIL', 'CLING FILM', 'GARBAGE BAG', 'GARBAGE BAGS', 'BIN BAG', 'BIN BAGS') },
]);

/** The non-food category this name reads as, or null. */
export function nonFoodPathFor(name) {
  const upper = String(name || '').toUpperCase().replace(/\s+/g, ' ');
  const rule = NON_FOOD_RULES.find((r) => r.test.test(upper));
  return rule ? rule.path : null;
}

/** The category to file a product under when Odoo has not given one. */
export function guessCategoryPath(name) {
  const nonFood = nonFoodPathFor(name);
  if (nonFood) return nonFood;
  const upper = String(name || '').toUpperCase();
  if (upper.includes('LAZIZA') || upper.includes('MALT')) return 'DRINKS & BEVERAGES / MALT DRINKS';
  if (upper.includes('LUNA') || upper.includes('COFFEE')) return 'DRINKS & BEVERAGES / READY TO DRINK COFFEE';
  if (upper.includes('PICKLE') || upper.includes('TURNIP') || upper.includes('AL AMIR')) return 'FOOD / PICKLES & CONDIMENTS';
  if (upper.includes('BEANS') || upper.includes('CHTOURA') || upper.includes('CANNED')) return 'FOOD / CANNED & PRESERVED FOODS';
  if (upper.includes('SEED') || upper.includes('WHOLE')) return 'FOOD / SPICES & SEASONINGS / WHOLE SPICES';
  if (upper.includes('POWDER') || upper.includes('GROUND')) return 'FOOD / SPICES & SEASONINGS / GROUND SPICES';
  return FALLBACK_PATH;
}

/** File every product that has no category, by its name. Returns how many were filed. */
export function fileUncategorised(db, now = new Date().toISOString()) {
  const rows = db.prepare('SELECT id, name FROM products WHERE odoo_category_path IS NULL OR category_id IS NULL').all();
  const upd = db.prepare('UPDATE products SET odoo_category_path = ?, category_id = ? WHERE id = ?');
  for (const p of rows) {
    const path = guessCategoryPath(p.name);
    upd.run(path, ensureCategoryPath(db, path, { now }), p.id);
  }
  return rows.length;
}

/**
 * Move products that were filed by name (never by Odoo) and read as non-food into their NON-FOOD category.
 * `keep` lists barcodes whose category is set elsewhere on purpose (the photographed fixture products).
 * Runs in one transaction; returns the moves.
 */
export function refileGuessedNonFood(db, { keep = [], now = new Date().toISOString() } = {}) {
  const fromOdoo = db.prepare(`SELECT 1 FROM import_changes WHERE product_id = ? AND change_type = ? AND new_value IS NOT NULL LIMIT 1`);
  const upd = db.prepare('UPDATE products SET odoo_category_path = ?, category_id = ?, updated_at = ? WHERE id = ?');
  const log = db.prepare(`INSERT INTO category_guess_log (product_id, barcode, old_path, new_path, reason, created_at) VALUES (?,?,?,?,?,?)`);
  const keepSet = new Set(keep);
  const moves = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of db.prepare('SELECT id, barcode, name, odoo_category_path FROM products').all()) {
      const path = nonFoodPathFor(p.name);
      if (!path || p.odoo_category_path === path || keepSet.has(p.barcode)) continue;
      if (String(p.odoo_category_path || '').startsWith(`${NON_FOOD} /`)) continue;   // already non-food: leave the finer choice alone
      if (fromOdoo.get(p.id, ChangeType.CATEGORY_CHANGE_DETECTED)) continue;          // Odoo gave this category: Odoo wins
      upd.run(path, ensureCategoryPath(db, path, { now }), now, p.id);
      log.run(p.id, p.barcode, p.odoo_category_path, path, 'Filed by name: reads as non-food (no category from Odoo yet)', now);
      moves.push({ productId: p.id, barcode: p.barcode, from: p.odoo_category_path, to: path });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return moves;
}
