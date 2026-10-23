// Discounts the Sales Manager puts on lots that are close to expiry.
//
// Two kinds, both set by the Sales Manager (or the administrator), never by the warehouse or a rep:
//   CLEARANCE  a lot in OUR warehouse -> customers see it in their catalogue as a discounted offer and
//              can request it. The cartons ordered from the lot carry the discount on the draft quotation
//              (the line names the lot); Odoo works out the price and a person approves the order there.
//   SHELF      a lot that is already on a CUSTOMER'S shelf -> the rep sees the discount on the shop visit
//              and the customer's contact can agree to it (see shelf.js).
// A lot is named "<barcode>|<lot name>" (the same key the Expiry list uses). A discount is switched off,
// never deleted, and every change is logged. Discounts are visible, on the customer side, only to a
// signed-in, approved customer — the same rule as prices.
import { loadLots, sampleSettings } from './expiry-sample.js';
import { buildExpiryRow, validateDiscountPercent, formatDay } from './expiry.js';
import { cartonPriceFor, priceClassOf } from './prices.js';
import { visibleBarcodes } from './visibility.js';
import { getMinShelfLifeDays } from './shelf-life.js';
import { getStockSource } from './stock-source.js';

export const DiscountKind = Object.freeze({ CLEARANCE: 'CLEARANCE', SHELF: 'SHELF' });
/** The most a Sales Manager can take off a lot (a typed 99 is almost certainly a mistake). */
export const MAX_LOT_DISCOUNT_PCT = 90;

export class LotDiscountError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'LotDiscountError'; this.status = status; }
}

const todayUtc = () => formatDay(Math.floor(Date.now() / 86_400_000));
const round2 = (n) => Math.round(n * 100) / 100;
const MAX_KEY = 200;

function checkKind(kind) {
  if (!Object.values(DiscountKind).includes(kind)) throw new LotDiscountError('Unknown kind of discount.');
}

/** Active discounts of one kind: lot key -> { pct, setBy, setAt }. */
export function activeDiscounts(db, kind) {
  checkKind(kind);
  const out = new Map();
  for (const r of db.prepare('SELECT lot_key, pct, set_by, set_at FROM lot_discounts WHERE kind = ? AND is_active = 1').all(kind)) {
    out.set(r.lot_key, { pct: r.pct, setBy: r.set_by, setAt: r.set_at });
  }
  return out;
}

/** The active discount for one lot, or null. */
export function discountFor(db, kind, lotKey) {
  return activeDiscounts(db, kind).get(lotKey) || null;
}

/** Put (or change) a discount on a lot. The caller has already checked the lot is a real one. */
export function setLotDiscount(db, kind, lotKey, pct, by = null, now = new Date()) {
  checkKind(kind);
  if (typeof lotKey !== 'string' || !lotKey.trim() || lotKey.length > MAX_KEY) throw new LotDiscountError('A lot is needed.');
  const d = validateDiscountPercent(pct);
  if (!d.ok) throw new LotDiscountError(d.error);
  if (d.value > MAX_LOT_DISCOUNT_PCT) throw new LotDiscountError(`A discount above ${MAX_LOT_DISCOUNT_PCT}% is not allowed.`);
  const ts = now.toISOString();
  const before = db.prepare('SELECT pct, is_active FROM lot_discounts WHERE kind = ? AND lot_key = ?').get(kind, lotKey);
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO lot_discounts (kind, lot_key, pct, is_active, set_by, set_at, ended_by, ended_at)
                VALUES (?,?,?,1,?,?,NULL,NULL)
                ON CONFLICT(kind, lot_key) DO UPDATE SET pct = excluded.pct, is_active = 1, set_by = excluded.set_by, set_at = excluded.set_at, ended_by = NULL, ended_at = NULL`)
      .run(kind, lotKey, d.value, by, ts);
    db.prepare('INSERT INTO lot_discount_log (kind, lot_key, action, pct, by_name, at) VALUES (?,?,?,?,?,?)')
      .run(kind, lotKey, before && before.is_active ? 'CHANGE' : 'SET', d.value, by, ts);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { kind, lotKey, pct: d.value };
}

/** Switch a lot's discount off (kept in the log; the lot is untouched). */
export function removeLotDiscount(db, kind, lotKey, by = null, now = new Date()) {
  checkKind(kind);
  const row = db.prepare('SELECT pct FROM lot_discounts WHERE kind = ? AND lot_key = ? AND is_active = 1').get(kind, lotKey);
  if (!row) return { kind, lotKey, pct: null };
  const ts = now.toISOString();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE lot_discounts SET is_active = 0, ended_by = ?, ended_at = ? WHERE kind = ? AND lot_key = ?').run(by, ts, kind, lotKey);
    db.prepare('INSERT INTO lot_discount_log (kind, lot_key, action, pct, by_name, at) VALUES (?,?,?,?,?,?)').run(kind, lotKey, 'REMOVE', row.pct, by, ts);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { kind, lotKey, pct: null };
}

export function discountLog(db, kind, limit = 40) {
  return db.prepare('SELECT kind, lot_key AS lotKey, action, pct, by_name AS byName, at FROM lot_discount_log WHERE kind = ? ORDER BY id DESC LIMIT ?').all(kind, limit);
}

// ---------------------------------------------------------------------------------------------
// what a customer is offered
// ---------------------------------------------------------------------------------------------

/** Cartons of a lot already taken by customers' requests (so one lot is not sold twice at the discount). */
function cartonsTaken(db, lotKey) {
  return db.prepare(`SELECT COALESCE(SUM(i.clearance_cartons), 0) n FROM request_items i JOIN requests r ON r.id = i.request_id
                      WHERE i.clearance_lot_key = ? AND r.deleted_at IS NULL`).get(lotKey).n;
}

/**
 * The discounted offers THIS customer may see and use right now, by barcode (one offer per product: the
 * lot that expires first). A lot is offered only while it has cartons left, has not passed its expiry day
 * (the expiry day itself is still sellable), the product is in the catalogue, active and visible to the
 * customer, and the lot is not shorter-dated than the customer's own minimum shelf life.
 * Prices are the customer's own class; with no price class the offer carries the percentage only.
 * @returns {Map<string, object>}
 */
export function clearanceOffersFor(db, customerId, { today = todayUtc(), loader = loadLots, settings = sampleSettings() } = {}) {
  const live = activeDiscounts(db, DiscountKind.CLEARANCE);
  const out = new Map();
  if (!live.size || !customerId) return out;
  const minDays = getMinShelfLifeDays(db, customerId);
  const cls = priceClassOf(db, customerId);

  const lots = loader(today).lots
    .map((lot) => ({ lot, key: `${lot.barcode}|${lot.lotName}` }))
    .filter(({ key }) => live.has(key))
    .map(({ lot, key }) => ({ ...buildExpiryRow(lot, today, settings), key }))
    .filter((r) => r.daysLeft !== null && r.daysLeft >= 0 && (!minDays || r.daysLeft >= minDays))
    .sort((a, b) => a.daysLeft - b.daysLeft);
  if (!lots.length) return out;

  const barcodes = [...new Set(lots.map((r) => r.barcode))];
  const products = db.prepare(`SELECT id, barcode, name FROM products WHERE is_active = 1 AND barcode IN (${barcodes.map(() => '?').join(',')})`).all(...barcodes);
  const known = new Map(products.map((p) => [p.barcode, p.name]));
  const visible = visibleBarcodes(db, { customerId }, [...known.keys()]);
  // never offer more cartons than the catalogue says can be requested right now
  const available = getStockSource().getCtnAvailability(db, products.map((p) => p.id));
  const availableOf = new Map(products.map((p) => [p.barcode, available.get(p.id)?.availableCtn ?? 0]));

  for (const r of lots) {
    if (out.has(r.barcode) || !known.has(r.barcode) || !visible.has(r.barcode)) continue;
    const left = Math.min(Number(r.cartons) - cartonsTaken(db, r.key), availableOf.get(r.barcode) ?? 0);
    if (left < 1) continue;
    const pct = live.get(r.key).pct;
    const price = cls ? cartonPriceFor(r.barcode, cls) : null;
    out.set(r.barcode, {
      barcode: r.barcode, name: known.get(r.barcode), lotKey: r.key, lotName: r.lotName,
      expiryDate: r.expiryDate, daysLeft: r.daysLeft, discountPct: pct, cartons: left,
      price, discountedPrice: price === null ? null : round2(price * (1 - pct / 100)),
    });
  }
  return out;
}

/**
 * Split a line's cartons between the offer and the normal price: the first `cartons` of the offer are
 * clearance, the rest are ordinary.
 * @returns {{clearanceCartons:number, normalCartons:number}}
 */
export function splitLine(quantityCtn, offer) {
  const q = Math.max(0, Math.floor(Number(quantityCtn) || 0));
  const c = offer ? Math.min(q, offer.cartons) : 0;
  return { clearanceCartons: c, normalCartons: q - c };
}

/**
 * Record, on a saved request's items, which cartons are clearance and at what discount. Call INSIDE the
 * request's transaction, so two customers cannot both take the last cartons of a lot.
 */
export function applyClearance(db, requestId, customerId, opts = {}) {
  const offers = clearanceOffersFor(db, customerId, opts);
  if (!offers.size) return [];
  const taken = [];
  const upd = db.prepare(`UPDATE request_items SET clearance_lot_key = ?, clearance_lot_name = ?, clearance_expiry = ?, clearance_cartons = ?, clearance_pct = ? WHERE id = ?`);
  for (const item of db.prepare('SELECT id, barcode_at_request AS barcode, quantity_ctn AS qty FROM request_items WHERE request_id = ? ORDER BY id').all(requestId)) {
    const offer = offers.get(item.barcode);
    if (!offer) continue;
    const { clearanceCartons } = splitLine(item.qty, offer);
    if (clearanceCartons < 1) continue;
    // a second line of the same product must not take the same cartons again
    offer.cartons -= clearanceCartons;
    upd.run(offer.lotKey, offer.lotName, offer.expiryDate, clearanceCartons, offer.discountPct, item.id);
    taken.push({ barcode: item.barcode, lotName: offer.lotName, cartons: clearanceCartons, discountPct: offer.discountPct });
  }
  return taken;
}
