// Customer minimum shelf life (W3) on the customer's request.
//
// A customer who refuses short-dated stock never receives it without agreeing first. Each
// customer may have a minimum number of days to expiry (for example 90). When their request
// holds a product whose available stock does not meet it, the line is warned — with the date the
// stock expires — and the customer must tick to accept it, or remove the line. The server
// enforces this: a request is refused unless every such line was accepted, and each acceptance
// is recorded (it is the evidence that the lot will not be returned for expiry).
//
// The minimum lives on `customers.min_shelf_life_days`. In the real system it is an Odoo field
// (set by Sales in Odoo, read by BFL); here staff set it, as a stand-in. Lots are SAMPLE data
// until the Odoo lot sync exists: a product with no lot data is simply not checked.
import { checkMinimumShelfLife, daysLeft, formatDay, toDay } from './expiry.js';
import { loadLots } from './expiry-sample.js';
import { RequestValidationError } from './requests.js';

export const SHORT_DATED_CODE = 'SHORT_DATED_NOT_ACCEPTED';
export const MAX_MIN_SHELF_LIFE_DAYS = 730;

export class ShelfLifeError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ShelfLifeError'; this.status = status; }
}

const utcToday = () => formatDay(Math.floor(Date.now() / 86_400_000));

/** The customer's minimum shelf life in days, or null when they have none. */
export function getMinShelfLifeDays(db, customerId) {
  const row = db.prepare('SELECT min_shelf_life_days AS d FROM customers WHERE id = ?').get(Number(customerId));
  return row && Number(row.d) > 0 ? Number(row.d) : null;
}

/** Set (or, with null / '', clear) a customer's minimum shelf life. Staff only. */
export function setMinShelfLifeDays(db, customerId, days) {
  const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) throw new ShelfLifeError('That customer does not exist.', 404);
  let value = null;
  if (days !== null && days !== undefined && days !== '') {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > MAX_MIN_SHELF_LIFE_DAYS) {
      throw new ShelfLifeError(`A minimum shelf life is a whole number of days from 1 to ${MAX_MIN_SHELF_LIFE_DAYS}.`);
    }
    value = n;
  }
  db.prepare('UPDATE customers SET min_shelf_life_days = ?, updated_at = ? WHERE id = ?').run(value, new Date().toISOString(), c.id);
  return { id: c.id, minShelfLifeDays: value };
}

/** Customers matching a name (or Odoo ref), with their minimum, for the staff stand-in. */
export function searchCustomersForShelfLife(db, q = '', limit = 15) {
  // % and _ are not wildcards here: a search made only of them finds nothing
  const term = String(q).replace(/[%_]/g, '').trim();
  if (String(q).trim() && !term) return [];
  const needle = `%${term}%`;
  const rows = term
    ? db.prepare(`SELECT id, name, odoo_customer_ref, min_shelf_life_days FROM customers
                   WHERE is_active = 1 AND (name LIKE ? OR odoo_customer_ref LIKE ?) ORDER BY name LIMIT ?`).all(needle, needle, limit)
    : db.prepare(`SELECT id, name, odoo_customer_ref, min_shelf_life_days FROM customers
                   WHERE is_active = 1 AND min_shelf_life_days IS NOT NULL ORDER BY name LIMIT ?`).all(limit);
  return rows.map((r) => ({ id: r.id, name: r.name, odooRef: r.odoo_customer_ref, minShelfLifeDays: r.min_shelf_life_days }));
}

/** Sellable lots of a product, from the main warehouse (clearance stock is sold separately). */
function lotsFor(barcode, today, loader) {
  return loader(today).lots
    .filter((l) => l.barcode === barcode && l.location === 'MAIN' && Number(l.cartons) > 0)
    .filter((l) => l.expiryDate === null || (daysLeft(l.expiryDate, today) ?? -1) >= 0)
    .map((l) => ({ lotId: l.lotName, expiryDate: l.expiryDate, cartons: l.cartons }));
}

/**
 * Which lines of this customer's request would be filled with stock below their minimum?
 * @param {{barcode:string, quantityCtn:number}[]} lines
 * @returns {{minDays:number|null, warnings:{barcode:string, message:string, expiryDate:string, shortCartons:number}[]}}
 */
export function checkRequestLines(db, customerId, lines, { today = utcToday(), loader = loadLots } = {}) {
  const minDays = getMinShelfLifeDays(db, customerId);
  if (!minDays) return { minDays: null, warnings: [] };
  const warnings = [];
  for (const line of Array.isArray(lines) ? lines : []) {
    const lots = lotsFor(String(line.barcode), today, loader);
    if (!lots.length) continue;                       // no lot data: nothing to check
    const r = checkMinimumShelfLife({ minDays, quantityCtn: line.quantityCtn, lots, today });
    if (r.needsAcceptance) {
      warnings.push({
        barcode: String(line.barcode), message: r.message, expiryDate: r.belowMinimumLot.expiryDate, shortCartons: r.shortCartons,
      });
    }
  }
  return { minDays, warnings };
}

/**
 * Refuse the request unless the customer accepted every warned line.
 * @param {{warnings:object[]}} check  from checkRequestLines
 * @param {string[]} accepted  barcodes the customer ticked
 * @returns the warnings that were accepted (to be recorded)
 */
export function requireAcceptance(check, accepted) {
  const ticked = new Set((Array.isArray(accepted) ? accepted : []).map(String));
  const missing = check.warnings.filter((w) => !ticked.has(w.barcode));
  if (missing.length) {
    throw new RequestValidationError('Some products have a shorter shelf life than you asked for.', {
      errors: missing.map((w) => ({ barcode: w.barcode, code: SHORT_DATED_CODE, message: `${w.message}. Tick the box to accept it, or remove this product.` })),
    });
  }
  return check.warnings;
}

/** Record what the customer accepted, against the request it came with. Run inside the request's transaction. */
export function saveAcceptances(db, requestId, customerId, minDays, warnings) {
  const ins = db.prepare(`INSERT INTO request_shelf_acceptances
    (request_id, customer_id, barcode, min_days, expiry_date, short_cartons, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const t = new Date().toISOString();
  for (const w of warnings) ins.run(requestId, customerId, w.barcode, minDays, w.expiryDate, w.shortCartons, t);
}

/** The acceptances recorded for a request (staff). */
export function acceptancesFor(db, requestId) {
  return db.prepare(`SELECT barcode, min_days AS minDays, expiry_date AS expiryDate, short_cartons AS shortCartons, accepted_at AS acceptedAt
                       FROM request_shelf_acceptances WHERE request_id = ? ORDER BY id`).all(Number(requestId));
}

export { toDay };
