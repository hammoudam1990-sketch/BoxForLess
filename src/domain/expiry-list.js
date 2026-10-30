// The Expiry list (screen S03): every lot with its band, plus the decision recorded against it.
//
// Built from lots (today: sample data; later: the Odoo lot sync) and the decisions saved in
// BFL. Nothing here touches Odoo. Value at risk is at the SELLING price and is staff-only.
import {
  ExpiryBand, ExpiryStatus, EntryIssue, buildExpiryRow, sortExpiryRows, countByBand, valueByBand,
  isUnderCategory, toDay, formatDay,
} from './expiry.js';
import { listActions, lotKey, saveAction, ExpiryActionError } from './expiry-actions.js';
import { loadLots, sampleSettings } from './expiry-sample.js';
import { activeDiscounts, setLotDiscount, removeLotDiscount, DiscountKind } from './lot-discounts.js';

/** Bands whose lots need a decision recorded: everything on its way to, or past, expiry. */
const ACTIONABLE = new Set([ExpiryBand.EXPIRED, ExpiryBand.CRITICAL, ExpiryBand.WARNING, ExpiryBand.EARLY]);

export const ISSUE_TEXT = Object.freeze({
  [EntryIssue.PAST_AT_RECEIPT]: 'The expiry date was already past on the day the lot was received',
  [EntryIssue.TOO_FAR_AHEAD]: 'The expiry date is more than 5 years ahead',
  [EntryIssue.FAR_ABOVE_USUAL]: 'Much longer than this category usually lasts',
  [EntryIssue.FAR_BELOW_USUAL]: 'Much shorter than this category usually lasts',
});

/** Today as 'YYYY-MM-DD' (UTC). The only place the clock is read. */
export const todayString = () => formatDay(Math.floor(Date.now() / 86_400_000));

/** All lots as list rows — sorted, unfiltered, with their saved decisions. */
function buildRows(db, today, settings, lots) {
  const actions = listActions(db);
  const discounts = activeDiscounts(db, DiscountKind.CLEARANCE);
  const inCatalogue = new Set(db.prepare('SELECT barcode FROM products WHERE is_active = 1').all().map((p) => p.barcode));
  const t = toDay(today);
  const rows = lots.map((lot) => {
    const row = buildExpiryRow(lot, today, settings);
    const a = actions.get(lotKey(lot));
    const decideBy = a?.decideBy ?? null;
    const status = a?.status ?? ExpiryStatus.OPEN;
    const actionable = ACTIONABLE.has(row.band);
    return {
      key: lotKey(lot),
      ...row,
      stockHolder: lot.stockHolder || (lot.location === 'SHOP' ? 'SHOP' : 'WAREHOUSE'),
      shopName: lot.shopName || null,
      withinTwoMonths: row.daysLeft !== null && row.daysLeft >= 0 && row.daysLeft <= 60,
      actionable,
      // the discount customers are offered on this lot (set by the Sales Manager), and whether the product is in the
      // customer catalogue at all (a lot whose product is not there cannot be offered, whatever its discount)
      discountPct: discounts.get(lotKey(lot))?.pct ?? null,
      inCatalogue: inCatalogue.has(lot.barcode),
      action: a?.action ?? null,
      owner: a?.owner ?? null,
      decideBy,
      status,
      needsAction: actionable && !a?.action && status !== ExpiryStatus.DONE,
      overdue: Boolean(decideBy) && toDay(decideBy) < t && status !== ExpiryStatus.DONE,
    };
  });
  return sortExpiryRows(rows);
}

function matches(row, f) {
  if (f.bands?.length && !f.bands.includes(row.band)) return false;
  if (f.category && !isUnderCategory(row.categoryPath, f.category)) return false;
  if (f.location) {
    if (f.location === 'WAREHOUSE') {
      if (row.stockHolder !== 'WAREHOUSE' && row.location === 'SHOP') return false;
    } else if (row.location !== f.location) {
      return false;
    }
  }
  if (f.status && row.status !== f.status) return false;
  if (f.owner) {
    if (f.owner === '__none__') { if (row.owner || !row.actionable) return false; }
    else if ((row.owner || '').toLowerCase() !== f.owner.toLowerCase()) return false;
  }
  if (f.q) {
    const hay = `${row.productName} ${row.barcode} ${row.lotName} ${row.shopName || ''}`.toLowerCase();
    if (!hay.includes(f.q.toLowerCase())) return false;
  }
  return true;
}

/** Read the filters out of a query string, ignoring anything that is not recognised. */
export function parseFilters(query = {}) {
  const bands = String(query.band || '').split(',').map((s) => s.trim().toUpperCase())
    .filter((b) => Object.values(ExpiryBand).includes(b));
  const location = ['MAIN', 'CLEARANCE', 'WAREHOUSE', 'SHOP'].includes(String(query.location || '').toUpperCase())
    ? String(query.location).toUpperCase() : '';
  const status = Object.values(ExpiryStatus).includes(String(query.status || '').toUpperCase())
    ? String(query.status).toUpperCase() : '';
  return {
    bands,
    category: String(query.category || '').trim().slice(0, 200),
    location,
    status,
    owner: String(query.owner || '').trim().slice(0, 80),
    q: String(query.q || '').trim().slice(0, 80),
  };
}

/**
 * The whole screen's data.
 * @param {object} db
 * @param {{today?:string, filters?:object, loader?:Function, settings?:object}} [opts]
 */
export function buildExpiryList(db, { today = todayString(), filters = {}, loader = loadLots, settings = sampleSettings() } = {}) {
  const { source, lots } = loader(today, db);
  const all = buildRows(db, today, settings, lots);
  const rows = all.filter((r) => matches(r, filters));

  const owners = [...new Set(all.map((r) => r.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    source,
    asOf: today,
    summary: {
      lots: all.length,
      counts: countByBand(all),
      value: valueByBand(all),
      needsAction: all.filter((r) => r.needsAction).length,
      overdue: all.filter((r) => r.overdue).length,
      checkEntries: all.filter((r) => r.issues.length).length,
    },
    shown: rows.length,
    rows,
    // the warehouse's "Check these entries" list: lots whose expiry date looks like a typing mistake
    checkEntries: all.filter((r) => r.issues.length).map((r) => ({
      key: r.key, productName: r.productName, lotName: r.lotName, barcode: r.barcode,
      expiryDate: r.expiryDate, receivedDate: r.receivedDate, issues: r.issues.map((i) => ({ code: i, text: ISSUE_TEXT[i] })),
    })),
    options: {
      categories: [...new Set(all.map((r) => r.categoryPath).filter(Boolean))].sort(),
      owners,
      locations: ['MAIN', 'CLEARANCE'],
    },
    settings: {
      bands: settings.bands,
      shortShelfLifeCategories: Object.entries(settings.categories).filter(([, r]) => r.type === 'SHORT').map(([p]) => p),
    },
  };
}

/**
 * Record a decision for a lot, but only for a lot that is on the list and in a band that needs
 * one — a key made up by a caller is refused.
 */
export function saveLotDecision(db, key, input, opts = {}) {
  const { today = todayString(), loader = loadLots, settings = sampleSettings() } = opts;
  const row = buildRows(db, today, settings, loader(today, db).lots).find((r) => r.key === key);
  if (!row) throw new ExpiryActionError('That lot is not on the expiry list.');
  if (!row.actionable) throw new ExpiryActionError('That lot is not close to expiry, so it has no decision to record.');
  saveAction(db, key, input);
  return buildRows(db, today, settings, loader(today, db).lots).find((r) => r.key === key);
}

/**
 * The Sales Manager's discount on a lot in our warehouse: customers are offered it in their catalogue.
 * Only for a lot that is on the list and on its way to (or past) expiry; pct null switches it off.
 */
export function saveLotClearanceDiscount(db, key, pct, by, opts = {}) {
  const { today = todayString(), loader = loadLots, settings = sampleSettings() } = opts;
  const row = buildRows(db, today, settings, loader(today, db).lots).find((r) => r.key === key);
  if (!row) throw new ExpiryActionError('That lot is not on the expiry list.');
  if (pct === null || pct === undefined || pct === '') removeLotDiscount(db, DiscountKind.CLEARANCE, key, by);
  else {
    if (!row.actionable) throw new ExpiryActionError('That lot is not close to expiry, so it cannot be put on offer.');
    if (row.band === ExpiryBand.EXPIRED) throw new ExpiryActionError('That lot has expired and cannot be sold.');
    setLotDiscount(db, DiscountKind.CLEARANCE, key, pct, by);
  }
  return buildRows(db, today, settings, loader(today, db).lots).find((r) => r.key === key);
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** One CSV cell: quoted, and a leading = + - @ is defused so a spreadsheet never runs it as a formula. */
function cell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const COLUMNS = [
  ['Product', (r) => r.productName], ['Barcode', (r) => r.barcode], ['Lot', (r) => r.lotName],
  ['Expiry date', (r) => r.expiryDate], ['Days left', (r) => r.daysLeft], ['Band', (r) => r.band],
  ['Cartons', (r) => r.cartons], ['Location', (r) => r.location], ['Category', (r) => r.categoryPath],
  ['Value at risk (selling price)', (r) => r.valueAtRisk], ['Action', (r) => r.action],
  ['Owner', (r) => r.owner], ['Decide by', (r) => r.decideBy], ['Status', (r) => r.status],
  ['Customer discount %', (r) => r.discountPct],
];

/** The filtered rows as CSV text (CRLF line ends, header row first). */
export function expiryCsv(rows) {
  const lines = [COLUMNS.map(([name]) => cell(name)).join(',')];
  for (const r of rows) lines.push(COLUMNS.map(([, get]) => cell(get(r))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
