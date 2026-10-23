// Prices per carton, from the customer's own price class.
//
// A price class is an Odoo pricelist. Each customer has exactly one (`customers.pricelist`);
// a cash customer uses the shared cash-account class. Odoo calculates the price on the order —
// BFL only SHOWS it, per carton in GHS, and only to a signed-in, approved customer (CEO
// approval, 2026-10). Never to visitors, never another customer's, never cost.
//
// SAMPLE until the Odoo pricelist sync exists: the carton price of a product is made up from
// its barcode and the class's multiplier, and every response says `source: 'SAMPLE'`. Only
// this module knows that; replacing `cartonPriceFor` with a read of the synced pricelist items
// changes nothing else.
import crypto from 'node:crypto';
import { visibleBarcodes } from './visibility.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'fixtures', 'price-classes-sample.json'), 'utf8'));

export const CURRENCY = SAMPLE.currency;
export const PRICE_SOURCE = 'SAMPLE';
export const DEFAULT_PRICE_CLASS = SAMPLE.default;
export const CASH_PRICE_CLASS = SAMPLE.cash;

export class PriceError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'PriceError'; this.status = status; }
}

/** The price classes a Sales Manager can give a customer. */
export function listPriceClasses() {
  return SAMPLE.classes.map((c) => ({
    name: c.name, isDefault: c.name === DEFAULT_PRICE_CLASS, isCashAccount: c.name === CASH_PRICE_CLASS,
  }));
}

const byName = (name) => SAMPLE.classes.find((c) => c.name === String(name ?? '').trim()) || null;
export const isPriceClass = (name) => Boolean(byName(name));

/** A made-up but stable base price per carton (GHS 40–400), the same for every class. */
function baseCartonPrice(barcode) {
  const n = crypto.createHash('sha256').update(String(barcode)).digest().readUInt32BE(0);
  return 40 + (n % 36001) / 100;
}

/** Carton price in GHS for one barcode in one class, or null when the class is unknown. */
export function cartonPriceFor(barcode, className) {
  const cls = byName(className);
  if (!cls) return null;
  return Math.round(baseCartonPrice(barcode) * cls.multiplier * 100) / 100;
}

/** The class a customer pays by. A customer without one gets no prices (never a guess). */
export function priceClassOf(db, customerId) {
  const row = db.prepare('SELECT pricelist FROM customers WHERE id = ?').get(Number(customerId));
  return row && byName(row.pricelist) ? byName(row.pricelist).name : null;
}

/**
 * Prices for one signed-in customer. Returns ONLY that customer's class name (a label they
 * already know from their invoices is not needed, so it is left out) and a barcode -> price map.
 * @param {string[]} barcodes
 */
export function pricesForCustomer(db, customerId, barcodes) {
  const cls = priceClassOf(db, customerId);
  const prices = {};
  // a product hidden from this customer has no price for them either
  const asked = [...new Set((Array.isArray(barcodes) ? barcodes : []).map(String).slice(0, 200))];
  const visible = cls ? visibleBarcodes(db, { customerId }, asked) : new Set();
  if (cls) for (const b of asked) if (visible.has(b) || !db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(b)) prices[b] = cartonPriceFor(b, cls);
  return { currency: CURRENCY, per: 'carton', source: PRICE_SOURCE, available: Boolean(cls), prices };
}
