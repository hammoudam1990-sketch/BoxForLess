// Where "current stock" comes from, behind ONE interface.
//
// Odoo is the operational source of truth; this catalog holds a COPY taken at the
// last import. That copy goes stale, so every consumer must know not just the
// numbers but how old they are. Hence `asOf` and `fresh` travel with the figures —
// a caller cannot read availability without also receiving its age.
//
// Stage 3 ships ManualImportStockSource only. LiveOdooStockSource is specified but
// deliberately unimplemented (no Odoo API exists in this project yet); swapping it
// in is a config change, not a rewrite, because nothing outside this file knows
// where the numbers came from.
import config from '../config.js';
import { STOCK_FIELDS } from './constants.js';

/**
 * Whole cartons that may be requested from a raw availability figure.
 *
 * Availability is a DECIMAL carton count (a partial carton is loose pieces
 * expressed as a fraction, e.g. 0.46). Requests are whole cartons only, so the
 * fraction is DISCARDED, never rounded: 8.46 -> 8, and 0.46 -> 0, which makes a
 * product with less than one full carton correctly non-requestable.
 * @param {number} availability
 * @returns {number} whole cartons, never negative
 */
export function wholeCartons(availability) {
  const n = Number(availability);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** Is a stock timestamp still fresh enough to accept requests against? */
export function isFresh(asOf, now = new Date(), freshnessHours = config.stock.freshnessHours) {
  if (!asOf) return false;
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return false;
  const ageHours = (now.getTime() - t) / 3_600_000;
  if (ageHours < 0) return true;        // clock skew: treat a future stamp as fresh
  return ageHours <= Number(freshnessHours);
}

/**
 * Stock from the last completed Odoo import — the only source in Stage 3.
 */
export class ManualImportStockSource {
  constructor(opts = {}) {
    this.field = opts.availabilityField || config.stock.availabilityField;
    this.freshnessHours = opts.freshnessHours ?? config.stock.freshnessHours;
    if (!STOCK_FIELDS.includes(this.field)) {
      throw new Error(`Unsafe availability field: ${this.field}`);
    }
  }

  /** `completed_at` of the most recent COMPLETED import, or null if none. */
  lastStockImportAt(db) {
    const row = db.prepare(
      "SELECT completed_at FROM import_batches WHERE status = 'COMPLETED' AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1"
    ).get();
    return row ? row.completed_at : null;
  }

  /**
   * Freshness verdict for the whole catalog. Browsing never consults this;
   * request submission always does.
   * @returns {{asOf:string|null, fresh:boolean, hasData:boolean, source:string, freshnessHours:number}}
   */
  getStockStatus(db, now = new Date()) {
    const asOf = this.lastStockImportAt(db);
    return {
      asOf,
      hasData: asOf !== null,
      fresh: isFresh(asOf, now, this.freshnessHours),
      source: 'manual-import',
      freshnessHours: Number(this.freshnessHours),
    };
  }

  /**
   * Whole-carton availability for specific products, by INTERNAL product id.
   * Inactive products are omitted — a caller cannot accidentally treat one as
   * available. Returns a Map so lookup is explicit at the call site.
   * @returns {Map<number, {availableCtn:number, raw:number, name:string, barcode:string, boxUom:string}>}
   */
  getCtnAvailability(db, productIds = []) {
    const ids = [...new Set(productIds.map(Number).filter(Number.isInteger))];
    const out = new Map();
    if (!ids.length) return out;
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, name, barcode, box_uom, ${this.field} AS availability
         FROM products
        WHERE id IN (${placeholders}) AND is_active = 1`
    ).all(...ids);
    for (const r of rows) {
      out.set(r.id, {
        availableCtn: wholeCartons(r.availability),
        raw: Number(r.availability),
        name: r.name,
        barcode: r.barcode,
        boxUom: r.box_uom,
      });
    }
    return out;
  }
}

/**
 * PLANNED — live Odoo lookup. Not implemented: this project has no Odoo API
 * connection, and the approved Stage 3 decision is manual import only.
 *
 * When it is built it must satisfy the same contract plus one rule: if Odoo is
 * unreachable, fall back to the last import and report its real `asOf`. It must
 * NEVER report stale figures as fresh, and never approve a quantity beyond the
 * last known stock. Failing safe means blocking submission, not guessing.
 */
export class LiveOdooStockSource {
  constructor() {
    throw new Error('LiveOdooStockSource is not implemented — Stage 3 uses manual import only.');
  }
}

/** The configured source. One place to change when live lookup arrives. */
export function getStockSource(opts = {}) {
  return new ManualImportStockSource(opts);
}

export default { getStockSource, ManualImportStockSource, wholeCartons, isFresh };
