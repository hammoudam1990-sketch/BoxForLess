// Which drawing suits a product. Pure (no DOM, no React) so the Node tests can cover it.
//
// The drawing is chosen at display time from the category the API already sends; no data
// is changed. See doodles.js for the drawings themselves.

// First match wins. Each rule looks at the Odoo level-2 category ("parent"), then the name.
const BY_PARENT = [
  [/SPICES|PICKLES|OLIVES|CONDIMENTS|SAUCES|PASTES/, 'jar'],
  [/SNACKS|CONFECTIONERY/, 'candy'],
  [/PANTRY|DRY GOODS|BREAKFAST|CEREAL/, 'sack'],
  [/BAKING|DESSERT/, 'cake'],
  [/CANNED|PRESERVED/, 'can'],
  [/COOKING OILS|FATS/, 'oil'],
  [/DAIRY|CHILLED/, 'carton'],
  [/MEAT|POULTRY/, 'meat'],
  [/COFFEE|TEA\b|HOT DRINKS/, 'cup'],
  [/ALCOHOLIC/, 'glass'],
  [/JUICES|SOFT DRINKS|SYRUPS|CORDIALS|WATER/, 'bottle'],
  [/HOME CARE|CLEANING|LAUNDRY|HOUSEHOLD/, 'spray'],
  [/PERSONAL CARE|COSMETICS|FRAGRANCE|BABY|SKIN|HAIR|BODY/, 'pump'],
  [/PAPER|HYGIENE/, 'roll'],
  [/\bPETS?\b/, 'paw'],
  [/PACKAGING|DISPOSABLE|TOOLS/, 'box'],
];
// A product's own name can be more telling than its shelf: a bag of rice is a sack wherever it sits.
const BY_NAME = [[/\b(RICE|FLOUR|SUGAR|SEMOLINA|OATS?|LENTILS?|BEANS?|GRAINS?|COUSCOUS)\b/, 'sack']];
const BY_TOP = { FOOD: 'bowl', 'DRINKS & BEVERAGES': 'bottle', 'NON-FOOD': 'box', PETS: 'paw' };

/** Which drawing suits this product: its name, its shelf, then food / non-food. */
export function doodleFor({ name = '', category = null } = {}) {
  const n = String(name).toUpperCase();
  const parent = String(category?.parent || '').toUpperCase();
  const cname = String(category?.name || '').toUpperCase();
  const top = String(category?.top_level || '').toUpperCase();
  // The name only decides for plain food: "RICE CRACKERS" is a snack and "RICE MILK" a drink.
  if (top !== 'DRINKS & BEVERAGES' && !/SNACKS|CONFECTIONERY/.test(parent)) {
    for (const [re, d] of BY_NAME) if (re.test(n)) return d;
  }
  for (const [re, d] of BY_PARENT) if (re.test(parent) || re.test(cname)) return d;
  return BY_TOP[top] || 'box';
}

/** The drawing for a top-level category tile (FOOD, NON-FOOD, DRINKS & BEVERAGES, PETS). */
export const doodleForTop = (topName) => BY_TOP[String(topName || '').toUpperCase()] || 'box';
