// Sales-rep screens (R01 My visits, R02 Visit form): SAMPLE shops and expiring lots, and the
// visits a rep records, kept in this browser's localStorage.
//
// None of this exists yet: rep accounts arrive in Phase 2 and the customer-shelf expiry alerts
// (W2) in Phase 7, read from Odoo deliveries and lots. Until then the screens are built against
// these samples, which are fictional and marked "Sample" on screen. Replace this module with
// server calls when the real data exists; the screens only use the exported functions.

const VISITS_KEY = 'bfl.rep.visits.v1';
const ORDERING_KEY = 'bfl.rep.orderingFor.v1';
const DAY = 24 * 60 * 60 * 1000;
export const REVISIT_DAYS = 7;   // "Not checked": the alert is due again in a week (W2)

export const REP = { name: 'Kwame Mensah', role: 'Sales Rep' };

/** Which line drawing a sample product gets (see catalog/doodles.js). */
const DRAWINGS = [
  [/oil/i, 'oil'], [/juice|drink/i, 'bottle'], [/milk/i, 'can'], [/paste|sardines|ketchup/i, 'can'],
  [/rice|spaghetti|noodles/i, 'sack'], [/cereal|flakes/i, 'bowl'], [/biscuit/i, 'candy'], [/powder/i, 'box'],
];
export const drawingFor = (product) => (DRAWINGS.find(([re]) => re.test(product)) || [null, 'box'])[1];

// Days to expiry are relative to today, so the sample never goes stale.
const SHOPS = [
  { id: '10321', name: 'Nana Yaa Provisions', area: 'Osu, Accra', overdueDays: 3, lots: [
    { lot: 'L-24-0702', product: 'Cooking Oil 5L', pack: 4, days: 6, delivered: 60 },
    { lot: 'L-24-0688', product: 'Evaporated Milk 160g', pack: 48, days: 9, delivered: 40 },
    { lot: 'L-24-0731', product: 'Spaghetti 500g', pack: 20, days: 15, delivered: 30 },
    { lot: 'L-24-0745', product: 'Sardines in Oil 125g', pack: 50, days: 21, delivered: 25 },
    { lot: 'L-24-0759', product: 'Corn Flakes 500g', pack: 12, days: 26, delivered: 18 },
  ] },
  { id: '10482', name: 'Adom Supermarket', area: 'Osu, Accra', lots: [
    { lot: 'L-24-0817', product: 'Cooking Oil 5L', pack: 4, days: 12, delivered: 120 },
    { lot: 'L-24-0623', product: 'Tomato Paste 70g', pack: 50, days: 4, delivered: 120 },
    { lot: 'L-24-0911', product: 'Orange Juice 1L', pack: 12, days: 18, delivered: 120 },
  ] },
  { id: '10657', name: 'Osu Mini Mart', area: 'Osu, Accra', lots: [
    { lot: 'L-24-0590', product: 'Tomato Paste 70g', pack: 50, days: 4, delivered: 40 },
    { lot: 'L-24-0604', product: 'Malt Drink 330ml', pack: 24, days: 13, delivered: 36 },
  ] },
  { id: '10876', name: 'Kantamanto Wholesale', area: 'Kantamanto, Accra', lots: [
    { lot: 'L-24-0866', product: 'Rice 5kg', pack: 4, days: 10, delivered: 80 },
    { lot: 'L-24-0872', product: 'Washing Powder 1kg', pack: 6, days: 22, delivered: 50 },
    { lot: 'L-24-0879', product: 'Biscuits 100g', pack: 48, days: 16, delivered: 70 },
    { lot: 'L-24-0880', product: 'Mango Juice 1L', pack: 12, days: 27, delivered: 44 },
  ] },
  { id: '10915', name: 'Mother Care Stores', area: 'Madina, Accra', lots: [
    { lot: 'L-24-0933', product: 'Baby Cereal 400g', pack: 12, days: 20, delivered: 24 },
  ] },
  { id: '11002', name: 'Tema Station Grocers', area: 'Tema, Accra', lots: [
    { lot: 'L-24-0951', product: 'Instant Noodles 70g', pack: 40, days: 25, delivered: 90 },
    { lot: 'L-24-0958', product: 'Tomato Ketchup 400g', pack: 12, days: 29, delivered: 30 },
  ] },
];

// ------------------------------------------------------------------ storage
function read(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** Every saved visit, newest first. */
export const savedVisits = () => read(VISITS_KEY, []);

/** The last recorded outcome per lot, so the list shows what is still open. */
function lastOutcomes() {
  const map = new Map();
  for (const visit of [...savedVisits()].reverse()) {
    for (const line of visit.lines) map.set(line.lot, { ...line, at: visit.at });
  }
  return map;
}

/** Is this lot still an open alert? Sold out and return-expected close it; a proposed discount
 *  waits for approval; "not checked" comes back after REVISIT_DAYS. */
function lotState(lot, outcomes, now) {
  const last = outcomes.get(lot.lot);
  if (!last) return { open: true };
  if (last.outcome === 'not_checked') return { open: now - Date.parse(last.at) >= REVISIT_DAYS * DAY, last };
  return { open: false, last };
}

/** The rep's shops with their open alerts, sorted by nearest expiry (overdue first). */
export function shopsToVisit(now = Date.now()) {
  const outcomes = lastOutcomes();
  return SHOPS.map((shop) => {
    const lots = shop.lots.map((l) => ({ ...l, expiresAt: now + l.days * DAY, ...lotState(l, outcomes, now) }));
    const open = lots.filter((l) => l.open).sort((a, b) => a.days - b.days);
    return { ...shop, open, nearest: open[0]?.days ?? Infinity, overdue: Boolean(shop.overdueDays) && open.length > 0 };
  })
    .filter((s) => s.open.length)
    .sort((a, b) => (b.overdue - a.overdue) || (a.nearest - b.nearest));
}

export const allShops = () => SHOPS.map(({ id, name, area }) => ({ id, name, area }));
export const findShop = (id) => shopsToVisit().find((s) => s.id === id) || null;

/** Save one visit: { shopId, contact, agreed, lines: [{ lot, product, shelf, outcome, discount, photo }] }. */
export function saveVisit(visit) {
  const visits = savedVisits();
  visits.unshift({ ...visit, id: `V-${Date.now().toString(36).toUpperCase()}`, at: new Date().toISOString() });
  // keep the newest 100; photos make each one large
  return write(VISITS_KEY, visits.slice(0, 100));
}

export const orderingFor = () => read(ORDERING_KEY, null);
export const setOrderingFor = (shop) => write(ORDERING_KEY, shop);

/** Start the sample over: forget saved visits and the "Ordering for" choice. */
export function resetSample() {
  try { localStorage.removeItem(VISITS_KEY); localStorage.removeItem(ORDERING_KEY); } catch { /* nothing stored */ }
}

/** The expiry chip: red within a week, amber within two weeks, green after that. */
export function expiryTone(days) {
  if (days <= 7) return 'red';
  if (days <= 14) return 'amber';
  return 'green';
}
