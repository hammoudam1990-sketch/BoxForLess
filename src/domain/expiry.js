// Expiry rules — "Warehouse Management: Expiry" (W1 warehouse bands and clearance,
// W2 customer-shelf alerts, W3 customer minimum shelf life).
//
// PURE. Nothing here touches the database, Odoo or the clock: every function takes the
// lot data and "today" as arguments, so the rules can be tested on sample data and later
// fed from the Odoo sync without change. Dates are whole calendar days (UTC); the expiry
// date itself is the LAST day a lot may be sold (daysLeft 0 is still sellable, -1 is not).
//
// VALUE AT RISK is measured at the SELLING price per carton (owner's decision on W-5,
// 2026-10-21), never at cost: this file reads no cost, valuation or purchase figure, and a
// test enforces it. The price arrives as an input (`pricePerCarton`) from whatever supplies
// it; these functions only multiply. It is a STAFF figure — it must never reach a
// customer-facing page.
import { CATEGORY_SEPARATOR } from './constants.js';

// ---------------------------------------------------------------------------
// vocabulary
// ---------------------------------------------------------------------------

export const ExpiryBand = Object.freeze({
  EXPIRED: 'EXPIRED',     // past the expiry date: never shown or sold on BFL
  CRITICAL: 'CRITICAL',
  WARNING: 'WARNING',
  EARLY: 'EARLY',
  OK: 'OK',
  NO_DATE: 'NO_DATE',     // the lot has no expiry date (not a perishable)
});

export const ShelfLife = Object.freeze({ LONG: 'LONG', SHORT: 'SHORT' });

export const EntryIssue = Object.freeze({
  PAST_AT_RECEIPT: 'PAST_AT_RECEIPT',     // expiry date already past on the day of receipt
  TOO_FAR_AHEAD: 'TOO_FAR_AHEAD',         // more than 5 years ahead
  FAR_ABOVE_USUAL: 'FAR_ABOVE_USUAL',     // much longer than the category's usual shelf life
  FAR_BELOW_USUAL: 'FAR_BELOW_USUAL',     // much shorter than the category's usual shelf life
});

/** What the warehouse decides to do with a lot in a warning band (W1). */
export const ExpiryAction = Object.freeze({
  MOVE_TO_CLEARANCE: 'MOVE_TO_CLEARANCE',
  PUSH_THROUGH_REPS: 'PUSH_THROUGH_REPS',
  RETURN_TO_SUPPLIER: 'RETURN_TO_SUPPLIER',
  DONATE_OR_WRITE_OFF: 'DONATE_OR_WRITE_OFF',
});

export const ExpiryStatus = Object.freeze({ OPEN: 'OPEN', IN_PROGRESS: 'IN_PROGRESS', DONE: 'DONE' });

export const ShelfAlertKind = Object.freeze({ FIRST: 'FIRST', FINAL: 'FINAL' });

/** What a rep records for a lot on a shop visit (W2). */
export const VisitOutcome = Object.freeze({
  SOLD_OUT: 'SOLD_OUT',                 // alert closes as "checked, sold"
  DISCOUNT_AGREED: 'DISCOUNT_AGREED',   // waits for the Sales Manager's approval
  RETURN_EXPECTED: 'RETURN_EXPECTED',   // the customer refuses; moves to W4
  NOT_CHECKED: 'NOT_CHECKED',           // shop closed / no time: due again in 7 days
});

// ---------------------------------------------------------------------------
// settings (proposed defaults from the specification; Operations can change them)
// ---------------------------------------------------------------------------

export const DEFAULT_EXPIRY_SETTINGS = Object.freeze({
  // days left at which a lot enters each band, by shelf-life type
  bands: Object.freeze({
    [ShelfLife.LONG]: Object.freeze({ early: 90, warning: 60, critical: 30 }),   // over 6 months
    [ShelfLife.SHORT]: Object.freeze({ early: 60, warning: 30, critical: 14 }),  // 3 to 6 months
  }),
  // customer-shelf alerts: days before expiry; `final: null` means a single alert
  alerts: Object.freeze({
    [ShelfLife.LONG]: Object.freeze({ first: 60, final: 30 }),
    [ShelfLife.SHORT]: Object.freeze({ first: 30, final: null }),
  }),
  // Per Odoo category path, longest matching prefix wins, field by field. Each entry may set
  // { type, bands, alerts, usualShelfLifeDays }. Which categories are SHORT is open decision W-1.
  categories: Object.freeze({}),
  maxYearsAhead: 5,
  usualRatio: Object.freeze({ high: 2, low: 0.2 }),   // flagged beyond 2x or under 0.2x the usual life
  notCheckedRepeatDays: 7,
});

function assertBands(b, where) {
  const ok = b && [b.early, b.warning, b.critical].every((n) => Number.isInteger(n))
    && b.early > b.warning && b.warning > b.critical && b.critical > 0;
  if (!ok) throw new RangeError(`${where}: bands must be whole days with early > warning > critical > 0`);
}

function assertAlerts(a, where) {
  const ok = a && Number.isInteger(a.first) && a.first > 0
    && (a.final === null || a.final === undefined || (Number.isInteger(a.final) && a.final > 0 && a.final < a.first));
  if (!ok) throw new RangeError(`${where}: alerts need a first alert (days before) and a final one that is later, or none`);
}

/** Merge a partial settings object over the defaults and validate it. Throws RangeError. */
export function withSettings(partial = {}) {
  const s = {
    ...DEFAULT_EXPIRY_SETTINGS,
    ...partial,
    bands: { ...DEFAULT_EXPIRY_SETTINGS.bands, ...(partial.bands || {}) },
    alerts: { ...DEFAULT_EXPIRY_SETTINGS.alerts, ...(partial.alerts || {}) },
    usualRatio: { ...DEFAULT_EXPIRY_SETTINGS.usualRatio, ...(partial.usualRatio || {}) },
    categories: { ...(partial.categories || {}) },
  };
  for (const type of Object.values(ShelfLife)) {
    assertBands(s.bands[type], `bands.${type}`);
    assertAlerts(s.alerts[type], `alerts.${type}`);
  }
  for (const [path, rule] of Object.entries(s.categories)) {
    if (rule.type !== undefined && !Object.values(ShelfLife).includes(rule.type)) {
      throw new RangeError(`categories["${path}"].type must be LONG or SHORT`);
    }
    if (rule.bands) assertBands(rule.bands, `categories["${path}"].bands`);
    if (rule.alerts) assertAlerts(rule.alerts, `categories["${path}"].alerts`);
  }
  return s;
}

const DEFAULTS = withSettings();

// ---------------------------------------------------------------------------
// dates — whole calendar days
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * A calendar day as a number of days since 1970-01-01 (UTC), or null if it is not a real
 * date. Accepts 'YYYY-MM-DD', an Odoo 'YYYY-MM-DD HH:MM:SS' / ISO string (the time is
 * ignored) or a Date.
 */
export function toDay(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / DAY_MS);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(String(value).trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  // reject 2026-02-30 and friends: the date must survive the round trip
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

/** The inverse of toDay: 'YYYY-MM-DD'. */
export function formatDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `today` to the expiry date: negative once it has passed, null if unreadable. */
export function daysLeft(expiryDate, today) {
  const e = toDay(expiryDate);
  const t = toDay(today);
  return e === null || t === null ? null : e - t;
}

// ---------------------------------------------------------------------------
// categories
// ---------------------------------------------------------------------------

const norm = (s) => String(s ?? '').trim().toUpperCase();

/** True when `path` is `key` or lies underneath it (matched on whole path segments). */
export function isUnderCategory(path, key) {
  const p = norm(path);
  const k = norm(key);
  return k !== '' && (p === k || p.startsWith(k + CATEGORY_SEPARATOR));
}

/**
 * The rules for a category: its shelf-life type, bands, alerts and usual shelf life.
 * Matching entries are applied from the least to the most specific, so a sub-category can
 * override one field and inherit the rest. Anything unset falls back to the type defaults.
 */
export function categoryRules(categoryPath, settings = DEFAULTS) {
  const matched = Object.keys(settings.categories)
    .filter((key) => isUnderCategory(categoryPath, key))
    .sort((a, b) => norm(a).length - norm(b).length);
  const merged = Object.assign({}, ...matched.map((k) => settings.categories[k]));
  const type = merged.type ?? ShelfLife.LONG;
  return {
    type,
    bands: merged.bands ?? settings.bands[type],
    alerts: merged.alerts ?? settings.alerts[type],
    usualShelfLifeDays: merged.usualShelfLifeDays ?? null,
  };
}

// ---------------------------------------------------------------------------
// W1 — warehouse bands
// ---------------------------------------------------------------------------

/**
 * Where a lot stands: its days left and its band for its category.
 * @returns {{daysLeft:number|null, band:string, type:string}}
 */
export function classifyLot({ expiryDate, today, categoryPath = '', settings = DEFAULTS }) {
  const rules = categoryRules(categoryPath, settings);
  const left = daysLeft(expiryDate, today);
  if (left === null) return { daysLeft: null, band: ExpiryBand.NO_DATE, type: rules.type };
  const { early, warning, critical } = rules.bands;
  let band = ExpiryBand.OK;
  if (left < 0) band = ExpiryBand.EXPIRED;
  else if (left <= critical) band = ExpiryBand.CRITICAL;
  else if (left <= warning) band = ExpiryBand.WARNING;
  else if (left <= early) band = ExpiryBand.EARLY;
  return { daysLeft: left, band, type: rules.type };
}

/** Expired lots are never shown or sold on BFL. A lot with no date has no expiry to pass. */
export function isSellable(expiryDate, today) {
  const left = daysLeft(expiryDate, today);
  if (left !== null) return left >= 0;
  // No readable date. A lot with no date at all is not perishable; a date that is present
  // but unreadable is not trusted, so it is not sold until someone fixes it.
  return expiryDate === null || expiryDate === undefined || expiryDate === '';
}

/** Bands that need an owner and a decision on the expiry list. */
export const needsDecision = (band) => band === ExpiryBand.CRITICAL || band === ExpiryBand.WARNING || band === ExpiryBand.EARLY;

/**
 * Checks on a hand-entered expiry date. An empty list means nothing looks wrong; otherwise
 * each issue is a reason to put the lot on the "Check these entries" list.
 * @param {{expiryDate:string, receivedDate:string, categoryPath?:string, settings?:object}} lot
 * @returns {string[]} EntryIssue codes
 */
export function checkEntry({ expiryDate, receivedDate, categoryPath = '', settings = DEFAULTS }) {
  const e = toDay(expiryDate);
  const r = toDay(receivedDate);
  if (e === null || r === null) return [];
  const issues = [];
  const remaining = e - r;
  if (remaining < 0) issues.push(EntryIssue.PAST_AT_RECEIPT);

  // "more than 5 years ahead" — whole calendar years, so 5 years to the day is still fine
  const limit = toDay(formatDay(r).replace(/^\d{4}/, (y) => String(Number(y) + settings.maxYearsAhead)));
  if (limit !== null && e > limit) issues.push(EntryIssue.TOO_FAR_AHEAD);

  const usual = categoryRules(categoryPath, settings).usualShelfLifeDays;
  if (usual && remaining >= 0) {
    if (remaining > usual * settings.usualRatio.high) issues.push(EntryIssue.FAR_ABOVE_USUAL);
    else if (remaining < usual * settings.usualRatio.low) issues.push(EntryIssue.FAR_BELOW_USUAL);
  }
  return issues;
}

/**
 * One row of the warehouse expiry list.
 * @param {object} lot { productName, barcode, lotName, expiryDate, receivedDate, cartons,
 *                       location ('MAIN'|'CLEARANCE'), categoryPath }
 */
export function buildExpiryRow(lot, today, settings = DEFAULTS) {
  const { daysLeft: left, band } = classifyLot({ expiryDate: lot.expiryDate, today, categoryPath: lot.categoryPath, settings });
  return {
    ...lot,
    daysLeft: left,
    band,
    sellable: band !== ExpiryBand.EXPIRED,
    valueAtRisk: valueAtRisk(lot.cartons, lot.pricePerCarton),
    issues: checkEntry({ expiryDate: lot.expiryDate, receivedDate: lot.receivedDate, categoryPath: lot.categoryPath, settings }),
  };
}

/**
 * Cartons x selling price per carton, rounded to 2 decimals. null when there is no usable
 * price: an unknown value is shown as unknown, never as 0.
 */
export function valueAtRisk(cartons, pricePerCarton) {
  const c = Number(cartons);
  const p = Number(pricePerCarton);
  if (pricePerCarton === null || pricePerCarton === undefined || pricePerCarton === '') return null;
  if (!Number.isFinite(c) || !Number.isFinite(p) || c < 0 || p < 0) return null;
  return Math.round(c * p * 100) / 100;
}

/**
 * Value at risk per band (and in total), counting only lots that have a price. `unpriced` is
 * how many lots could not be valued, so a total is never mistaken for the whole picture.
 * Only the bands that need attention are summed: OK and NO_DATE lots are not at risk.
 */
export function valueByBand(rows) {
  const atRisk = [ExpiryBand.EXPIRED, ExpiryBand.CRITICAL, ExpiryBand.WARNING, ExpiryBand.EARLY];
  const out = { byBand: Object.fromEntries(atRisk.map((b) => [b, 0])), total: 0, unpriced: 0 };
  for (const r of rows) {
    if (!atRisk.includes(r.band)) continue;
    if (r.valueAtRisk === null || r.valueAtRisk === undefined) { out.unpriced += 1; continue; }
    out.byBand[r.band] = Math.round((out.byBand[r.band] + r.valueAtRisk) * 100) / 100;
    out.total = Math.round((out.total + r.valueAtRisk) * 100) / 100;
  }
  return out;
}

/** Expired lots first, then the fewest days left; lots with no date go last. */
export function sortExpiryRows(rows) {
  const key = (r) => (r.daysLeft === null ? Number.POSITIVE_INFINITY : r.daysLeft);
  return [...rows].sort((a, b) => key(a) - key(b));
}

/** How many lots sit in each band — the header of the expiry list. */
export function countByBand(rows) {
  const counts = Object.fromEntries(Object.values(ExpiryBand).map((b) => [b, 0]));
  for (const r of rows) counts[r.band] += 1;
  return counts;
}

/** A clearance discount is a percentage strictly between 0 and 100. */
export function validateDiscountPercent(value) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n <= 0 || n >= 100) {
    return { ok: false, value: null, error: 'A discount is a percentage above 0 and below 100.' };
  }
  return { ok: true, value: Math.round(n * 100) / 100, error: null };
}

// ---------------------------------------------------------------------------
// W2 — customer-shelf alerts
// ---------------------------------------------------------------------------

/** The dates on which a delivered lot raises its alerts. */
export function shelfAlertDates(expiryDate, categoryPath = '', settings = DEFAULTS) {
  const e = toDay(expiryDate);
  if (e === null) return [];
  const { first, final } = categoryRules(categoryPath, settings).alerts;
  const out = [{ kind: ShelfAlertKind.FIRST, daysBefore: first, date: formatDay(e - first) }];
  if (final) out.push({ kind: ShelfAlertKind.FINAL, daysBefore: final, date: formatDay(e - final) });
  return out;
}

/**
 * Which of a delivered lot's alerts are due today.
 * `current` is the most urgent one due now (FINAL beats FIRST), or null.
 */
export function shelfAlertStatus({ expiryDate, categoryPath = '', today, settings = DEFAULTS }) {
  const t = toDay(today);
  const alerts = shelfAlertDates(expiryDate, categoryPath, settings).map((a) => ({ ...a, due: t !== null && toDay(a.date) <= t }));
  const due = alerts.filter((a) => a.due);
  return {
    alerts,
    expired: daysLeft(expiryDate, today) !== null && daysLeft(expiryDate, today) < 0,
    current: due.length ? due[due.length - 1].kind : null,
  };
}

/** When a shop that was not checked is due a visit again. */
export function nextCheckDate(visitDate, settings = DEFAULTS) {
  const d = toDay(visitDate);
  return d === null ? null : formatDay(d + settings.notCheckedRepeatDays);
}

// ---------------------------------------------------------------------------
// W3 — customer minimum shelf life
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-12-01' -> '1 Dec 2026' (no locale data needed). */
export function friendlyDate(value) {
  const day = toDay(value);
  if (day === null) return '';
  const d = new Date(day * DAY_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Can an order line be filled from lots that meet the customer's minimum shelf life?
 *
 * Customers without a minimum accept any lot that is not expired. Otherwise stock is taken
 * from the lots that meet the minimum; only if those fall short does the line need the
 * customer's acceptance, and it is shown with the date of the best shorter-dated stock.
 *
 * @param {{minDays:number|null, quantityCtn:number, lots:{lotId:*, expiryDate:string|null, cartons:number}[], today:string}} a
 * @returns {{needsAcceptance:boolean, qualifyingCartons:number, shortCartons:number,
 *            unavailableCartons:number, belowMinimumLot:object|null, message:string|null}}
 */
export function checkMinimumShelfLife({ minDays, quantityCtn, lots, today }) {
  const wanted = Math.max(0, Math.floor(Number(quantityCtn) || 0));
  const min = Number.isFinite(Number(minDays)) && Number(minDays) > 0 ? Math.floor(Number(minDays)) : 0;

  const usable = (lots || [])
    .map((l) => ({ ...l, cartons: Math.max(0, Number(l.cartons) || 0), left: daysLeft(l.expiryDate, today) }))
    .filter((l) => l.cartons > 0 && (l.left === null || l.left >= 0));   // expired lots never count

  // a lot with no date has no expiry to be short of, so it meets any minimum
  const meets = (l) => l.left === null || l.left >= min;
  const qualifying = usable.filter(meets).reduce((n, l) => n + l.cartons, 0);

  const result = {
    needsAcceptance: false, qualifyingCartons: Math.min(qualifying, wanted), shortCartons: 0,
    unavailableCartons: 0, belowMinimumLot: null, message: null,
  };
  if (qualifying >= wanted) return result;

  const shortfall = wanted - qualifying;
  const shorter = usable.filter((l) => !meets(l)).sort((a, b) => b.left - a.left);   // best of the short-dated first
  const shorterCartons = shorter.reduce((n, l) => n + l.cartons, 0);
  result.shortCartons = Math.min(shortfall, shorterCartons);
  result.unavailableCartons = shortfall - result.shortCartons;
  if (result.shortCartons > 0) {
    const best = shorter[0];
    result.needsAcceptance = true;
    result.belowMinimumLot = { lotId: best.lotId, expiryDate: best.expiryDate, daysLeft: best.left };
    result.message = `Available stock expires on ${friendlyDate(best.expiryDate)}, below your ${min}-day minimum`;
  }
  return result;
}

/**
 * The daily exceptions check: a lot delivered to a customer with less shelf life than their
 * minimum, and no recorded acceptance. Sales handles it before it becomes a return.
 */
export function deliveryBelowMinimum({ expiryDate, deliveredOn, minDays, accepted = false }) {
  const left = daysLeft(expiryDate, deliveredOn);
  const min = Number(minDays) > 0 ? Number(minDays) : 0;
  const below = left !== null && min > 0 && left < min;
  return { daysLeftAtDelivery: left, below, exception: below && !accepted };
}

/** Every delivery that broke a customer's minimum without their acceptance. */
export function findShelfLifeExceptions(deliveries) {
  return deliveries
    .map((d) => ({ ...d, ...deliveryBelowMinimum(d) }))
    .filter((d) => d.exception);
}
