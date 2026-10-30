// The Warehouse Manager's dashboard: one read-only view over what BFL already holds.
//
//   products        stock per product, from Odoo (the stock import today, the stock sync later)
//   expiry list     lots with their expiry bands (expiry-list.js; SAMPLE lots until the Odoo lot sync exists)
//   movements       real records only, derived from what BFL already keeps:
//                     STOCK_IN / STOCK_OUT  a product's on-hand quantity rose or fell between two stock imports
//                                           (the import change log: Odoo's net movement between the exports)
//                     STOCK_OUT             an order's delivery was validated in Odoo (one line per product)
//                     RETURN                a return delivery was received into quarantine
//                   BFL records no transfers or adjustments, so none are ever shown. Nothing is invented.
//
// Nothing here writes anything, reads a cost, or returns customer details. Stock is Odoo's: BFL never records a
// stock move of its own (project rule), so this is a window on the data, not a stock ledger.
import config from '../config.js';
import { computeStockStatus } from './stock.js';
import { StockStatus } from './constants.js';
import { buildExpiryList, todayString } from './expiry-list.js';
import { parseCategoryPath } from './categories.js';
import { toDay, formatDay, ExpiryBand } from './expiry.js';
import { reviewCounts } from './review.js';
import { overdueUnclassified } from './returns.js';
import { getStockSource } from './stock-source.js';
import { sampleOdooEnabled } from './sample-odoo.js';

export class WarehouseError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'WarehouseError'; this.status = status; }
}

// ---------------------------------------------------------------------------------------------
// periods
// ---------------------------------------------------------------------------------------------
export const PERIODS = Object.freeze({
  today: 'Today', week: 'This week', month: 'This month', last_month: 'Last month', year: 'This year', custom: 'Custom range',
});
export const DEFAULT_PERIOD = 'week';
const MAX_CUSTOM_DAYS = 400;

/** The calendar days a period covers (both ends included), as 'YYYY-MM-DD'. A week starts on Monday. */
export function periodRange(period = DEFAULT_PERIOD, { from = null, to = null } = {}, today = todayString()) {
  const key = PERIODS[period] ? period : DEFAULT_PERIOD;
  const t = toDay(today);
  const [y, m] = today.split('-').map(Number);
  const day = (yy, mm, dd) => toDay(`${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`);
  let start = t;
  let end = t;
  if (key === 'week') start = t - ((((t + 3) % 7) + 7) % 7);          // 1970-01-01 was a Thursday
  else if (key === 'month') start = day(y, m, 1);
  else if (key === 'last_month') { start = day(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1, 1); end = day(y, m, 1) - 1; }
  else if (key === 'year') start = day(y, 1, 1);
  else if (key === 'custom') {
    const f = toDay(from);
    const e = toDay(to);
    if (f === null || e === null) throw new WarehouseError('Choose a start and an end date.');
    if (f > e) throw new WarehouseError('The start date is after the end date.');
    if (e - f > MAX_CUSTOM_DAYS) throw new WarehouseError(`Choose a range of at most ${MAX_CUSTOM_DAYS} days.`);
    start = f; end = e;
  }
  return { period: key, label: key === 'custom' ? `${formatDay(start)} to ${formatDay(end)}` : PERIODS[key], start: formatDay(start), end: formatDay(end) };
}

// ---------------------------------------------------------------------------------------------
// lots and expiry (lot level: a product may have several lots with different dates)
// ---------------------------------------------------------------------------------------------
/** How the dashboard groups the expiry bands. "Expiring soon" is the warning period (Critical + Warning). */
export const EXPIRY_GROUPS = Object.freeze({
  EXPIRED: [ExpiryBand.EXPIRED],
  SOON: [ExpiryBand.CRITICAL, ExpiryBand.WARNING],
  IN_DATE: [ExpiryBand.EARLY, ExpiryBand.OK],
  NO_DATE: [ExpiryBand.NO_DATE],
});
const groupOf = (band) => Object.keys(EXPIRY_GROUPS).find((g) => EXPIRY_GROUPS[g].includes(band));

function lots(db, today) {
  const list = buildExpiryList(db, { today });
  const byBarcode = new Map();
  for (const r of list.rows) {
    const x = byBarcode.get(r.barcode) || { locations: new Set(), nextExpiry: null, soon: false, expired: false };
    x.locations.add(r.location);
    const g = groupOf(r.band);
    if (g === 'SOON') x.soon = true;
    if (g === 'EXPIRED') x.expired = true;
    if (r.expiryDate && g !== 'EXPIRED' && (!x.nextExpiry || r.expiryDate < x.nextExpiry)) x.nextExpiry = r.expiryDate;
    byBarcode.set(r.barcode, x);
  }
  const counts = { EXPIRED: 0, SOON: 0, IN_DATE: 0, NO_DATE: 0 };
  for (const r of list.rows) counts[groupOf(r.band)] += 1;
  return { source: list.source, asOf: list.asOf, rows: list.rows, byBarcode, counts, summary: list.summary };
}

// ---------------------------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------------------------
export const LOCATION_LABEL = Object.freeze({ MAIN: 'Main warehouse', CLEARANCE: 'Clearance' });
const STATUS_KEY = { [StockStatus.IN_STOCK]: 'IN_STOCK', [StockStatus.LIMITED_STOCK]: 'LOW_STOCK', [StockStatus.OUT_OF_STOCK]: 'OUT_OF_STOCK' };
const SORTS = {
  name: (a, b) => a.name.localeCompare(b.name),
  sku: (a, b) => (a.sku || '￿').localeCompare(b.sku || '￿') || a.name.localeCompare(b.name),
  available: (a, b) => a.available - b.available || a.name.localeCompare(b.name),
  expiry: (a, b) => (a.nextExpiry || '9999').localeCompare(b.nextExpiry || '9999') || a.name.localeCompare(b.name),
  status: (a, b) => ['OUT_OF_STOCK', 'LOW_STOCK', 'IN_STOCK'].indexOf(a.status) - ['OUT_OF_STOCK', 'LOW_STOCK', 'IN_STOCK'].indexOf(b.status) || a.name.localeCompare(b.name),
};
const underPath = (path, key) => Boolean(path) && (path === key || path.startsWith(`${key} / `));
/** The SKU: Odoo's Internal Reference (default_code), or the same code as Odoo prints it at the end of the product name. */
const skuOf = (p) => p.source_odoo_id || (/\[([A-Za-z0-9._-]{2,40})\]\s*$/.exec(String(p.name || '')) || [])[1] || null;

/** The categories to filter by: every top-level category and every category one level under it, with counts. */
function categoryOptions(products) {
  const counts = new Map();
  for (const p of products) {
    const c = parseCategoryPath(p.odoo_category_path);
    if (!c) continue;
    for (const path of [c.segments[0], c.segments.slice(0, 2).join(' / ')]) counts.set(path, (counts.get(path) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([path, n]) => ({ path, label: path.split(' / ').pop(), level: path.split(' / ').length, products: n }));
}

const activeProducts = (db) => db.prepare(`SELECT id, barcode, source_odoo_id, name, box_uom, free_to_use, incoming, odoo_category_path, primary_image_id
                                              FROM products WHERE is_active = 1`).all();

/**
 * One page of the inventory: active products with their available cartons, stock status and — from their lots —
 * location and next expiry. Search, category, location and status filters work together.
 * @param {{search?:string, category?:string, location?:string, status?:string, sort?:string, dir?:string, limit?:number, offset?:number}} q
 */
export function inventoryPage(db, q = {}, today = todayString()) {
  const lot = lots(db, today);
  const all = activeProducts(db).map((p) => {
    const l = lot.byBarcode.get(p.barcode);
    const c = parseCategoryPath(p.odoo_category_path);
    return {
      id: p.id, name: p.name, barcode: p.barcode, sku: skuOf(p), pack: p.box_uom || null,
      available: Math.round(Number(p.free_to_use || 0) * 100) / 100,
      status: STATUS_KEY[computeStockStatus(p)],
      expiringSoon: Boolean(l && l.soon),
      hasExpiredLot: Boolean(l && l.expired),
      locations: l ? [...l.locations].sort() : [],
      nextExpiry: l ? l.nextExpiry : null,
      category: c ? c.name : null, categoryPath: c ? c.path : null,
      image: p.primary_image_id ? `/api/products/${p.id}/image` : null,
    };
  });

  const search = String(q.search || '').trim().toLowerCase().slice(0, 100);
  const category = String(q.category || '').trim();
  const location = ['MAIN', 'CLEARANCE'].includes(String(q.location || '').toUpperCase()) ? String(q.location).toUpperCase() : '';
  const status = ['IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'EXPIRING_SOON'].includes(String(q.status || '').toUpperCase()) ? String(q.status).toUpperCase() : '';
  const rows = all.filter((p) => {
    if (search) {
      const hay = [p.name, p.barcode, p.sku, ...p.locations.map((x) => LOCATION_LABEL[x] || x)].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (category && !underPath(p.categoryPath, category)) return false;
    if (location && !p.locations.includes(location)) return false;
    if (status === 'EXPIRING_SOON') { if (!p.expiringSoon) return false; } else if (status && p.status !== status) return false;
    return true;
  });

  const sortKey = SORTS[q.sort] ? q.sort : 'name';
  rows.sort(SORTS[sortKey]);
  if (String(q.dir).toLowerCase() === 'desc') rows.reverse();
  const limit = Math.min(Math.max(Math.floor(Number(q.limit) || 25), 1), 100);
  const offset = Math.max(Math.floor(Number(q.offset) || 0), 0);
  return {
    total: rows.length, limit, offset, sort: sortKey, dir: String(q.dir).toLowerCase() === 'desc' ? 'desc' : 'asc',
    items: rows.slice(offset, offset + limit),
    options: { categories: categoryOptions(all), locations: Object.entries(LOCATION_LABEL).map(([value, label]) => ({ value, label })) },
    lotSource: lot.source,
  };
}

// ---------------------------------------------------------------------------------------------
// stock movements (real records only — see the top of this file)
// ---------------------------------------------------------------------------------------------
export const MOVEMENT_TYPES = Object.freeze({ STOCK_IN: 'Stock In', STOCK_OUT: 'Stock Out', TRANSFER: 'Transfer', ADJUSTMENT: 'Adjustment', RETURN: 'Return' });
const round2 = (n) => Math.round(n * 100) / 100;

/** Every movement in the date range, newest first. */
export function movementsIn(db, { start, end }) {
  const out = [];
  // 1. on-hand changes between stock imports
  for (const r of db.prepare(`SELECT c.id, c.created_at AS at, c.import_batch_id AS batch, c.barcode, c.old_value, c.new_value, p.name
                                FROM import_changes c LEFT JOIN products p ON p.id = c.product_id
                               WHERE c.change_type = 'PRODUCT_UPDATED' AND c.field = 'on_hand' AND substr(c.created_at, 1, 10) BETWEEN ? AND ?`).all(start, end)) {
    const delta = round2(Number(r.new_value) - Number(r.old_value));
    if (!Number.isFinite(delta) || delta === 0) continue;
    out.push({
      id: `imp-${r.id}`, at: r.at, type: delta > 0 ? 'STOCK_IN' : 'STOCK_OUT', barcode: r.barcode, product: r.name || r.barcode,
      quantity: delta, reference: `Import #${r.batch}`, href: `#/imports/${r.batch}`, source: 'STOCK_IMPORT',
      note: 'Change in on-hand stock between two Odoo stock imports',
    });
  }
  // 2. deliveries validated in Odoo: the order's lines leave the warehouse
  const sample = sampleOdooEnabled();
  for (const r of db.prepare(`SELECT i.id, o.dispatched_at AS at, o.odoo_number, i.barcode_at_request AS barcode, i.product_name_at_request AS name, i.quantity_ctn AS qty
                                FROM odoo_orders o JOIN request_items i ON i.request_id = o.request_id
                               WHERE o.dispatched_at IS NOT NULL AND substr(o.dispatched_at, 1, 10) BETWEEN ? AND ?`).all(start, end)) {
    if (!(Number(r.qty) > 0)) continue;
    out.push({
      id: `dlv-${r.id}`, at: r.at, type: 'STOCK_OUT', barcode: r.barcode, product: r.name || r.barcode,
      quantity: -Number(r.qty), reference: r.odoo_number || 'Delivery', href: null, source: sample ? 'SAMPLE_ODOO' : 'ODOO',
      note: 'Delivery validated in Odoo',
    });
  }
  // 3. returns received into quarantine
  for (const r of db.prepare(`SELECT l.id, r.received_on AS at, r.number, l.barcode, l.product_name AS name, l.cartons
                                FROM odoo_returns r JOIN odoo_return_lines l ON l.return_id = r.id
                               WHERE r.received_on BETWEEN ? AND ?`).all(start, end)) {
    out.push({
      id: `ret-${r.id}`, at: r.at, type: 'RETURN', barcode: r.barcode, product: r.name || r.barcode,
      quantity: Number(r.cartons), reference: r.number, href: '#/returns', source: sample ? 'SAMPLE_ODOO' : 'ODOO',
      note: 'Returned goods received into quarantine (not sellable stock)',
    });
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)) || a.id.localeCompare(b.id));
}

/** One page of movements, optionally of one type. */
export function movementsPage(db, range, { type = '', limit = 25, offset = 0 } = {}) {
  const t = MOVEMENT_TYPES[String(type).toUpperCase()] ? String(type).toUpperCase() : '';
  const all = movementsIn(db, range);
  const rows = t ? all.filter((m) => m.type === t) : all;
  const lim = Math.min(Math.max(Math.floor(Number(limit) || 25), 1), 100);
  const off = Math.max(Math.floor(Number(offset) || 0), 0);
  const byType = Object.fromEntries(Object.keys(MOVEMENT_TYPES).map((k) => [k, all.filter((m) => m.type === k).length]));
  return { range, type: t || null, total: rows.length, limit: lim, offset: off, byType, items: rows.slice(off, off + lim), types: MOVEMENT_TYPES };
}

// ---------------------------------------------------------------------------------------------
// stock levels by category
// ---------------------------------------------------------------------------------------------
const titleCase = (s) => String(s).toLowerCase().replace(/(^|[\s/&-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
const MAX_GROUPS = 7;

/**
 * Available and incoming cartons per category (one level under the top). Available = free to use (a negative figure
 * counts as none); incoming = Odoo's incoming quantity — receipts not yet in. The biggest groups are shown and the rest
 * are folded into "Others".
 */
export function stockLevels(db) {
  const groups = new Map();
  for (const p of activeProducts(db)) {
    const c = parseCategoryPath(p.odoo_category_path);
    const path = c ? c.segments.slice(0, 2).join(' / ') : 'Uncategorised';
    const g = groups.get(path) || { path, label: c ? titleCase(c.segments[Math.min(1, c.segments.length - 1)]) : 'Uncategorised', available: 0, incoming: 0, products: 0 };
    g.available += Math.max(0, Number(p.free_to_use) || 0);
    g.incoming += Math.max(0, Number(p.incoming) || 0);
    g.products += 1;
    groups.set(path, g);
  }
  const sorted = [...groups.values()].sort((a, b) => (b.available + b.incoming) - (a.available + a.incoming) || a.label.localeCompare(b.label));
  const shown = sorted.slice(0, MAX_GROUPS);
  const rest = sorted.slice(MAX_GROUPS);
  if (rest.length) {
    shown.push(rest.reduce((o, g) => ({ ...o, available: o.available + g.available, incoming: o.incoming + g.incoming, products: o.products + g.products }),
      { path: null, label: 'Others', available: 0, incoming: 0, products: 0, folded: rest.length }));
  }
  return {
    unit: 'cartons',
    series: [{ key: 'available', label: 'Available' }, { key: 'incoming', label: 'Incoming (pending receipt)' }],
    groups: shown.map((g) => ({ ...g, available: Math.round(g.available), incoming: Math.round(g.incoming) })),
  };
}

// ---------------------------------------------------------------------------------------------
// notifications: what needs the warehouse's attention, each with where to deal with it
// ---------------------------------------------------------------------------------------------
export function notifications(db, today = todayString()) {
  const items = [];
  const lot = lots(db, today);
  const add = (key, level, count, title, detail, href) => { if (count > 0) items.push({ key, level, count, title, detail, href }); };
  const stock = getStockSource().getStockStatus(db);
  if (!stock.hasData || !stock.fresh) {
    items.push({ key: 'stock-stale', level: 'red', count: 1, title: stock.hasData ? 'Stock data is out of date' : 'No stock data yet', detail: 'Customers cannot send requests until a fresh stock import runs.', href: '#/imports' });
  }
  add('expired', 'red', lot.counts.EXPIRED, 'Expired lots', 'Past their expiry date: never sold on BFL. Decide what happens to them.', '#/expiry?band=EXPIRED');
  add('decide-overdue', 'red', lot.summary.overdue, 'Expiry decisions overdue', 'Lots whose decide-by date has passed.', '#/expiry');
  add('decide', 'amber', lot.summary.needsAction, 'Lots waiting for a decision', 'Lots close to expiry with no action recorded.', '#/expiry');
  add('returns', 'amber', overdueUnclassified(db, today), 'Returns waiting for a reason', 'Received more than 3 days ago and not classified yet.', '#/returns');
  add('reviews', 'amber', reviewCounts(db).total || 0, 'Barcode or pack changes to review', 'Changes detected in the Odoo export that are not applied until reviewed.', '#/changes');
  add('check', 'amber', lot.summary.checkEntries, 'Expiry dates to check', 'Dates that look like typing mistakes.', '#/expiry');
  return { asOf: today, items, count: items.length };
}

// ---------------------------------------------------------------------------------------------
// the dashboard
// ---------------------------------------------------------------------------------------------
export function dashboardSummary(db, { period, from, to } = {}, today = todayString()) {
  const range = periodRange(period, { from, to }, today);
  const products = activeProducts(db);
  const statusCount = (s) => products.filter((p) => computeStockStatus(p) === s).length;
  const lot = lots(db, today);
  const moves = movementsIn(db, range);
  return {
    range,
    kpis: {
      totalProducts: products.length,
      lowStock: statusCount(StockStatus.LIMITED_STOCK),
      outOfStock: statusCount(StockStatus.OUT_OF_STOCK),
      expiringSoon: lot.counts.SOON,
      recentMovements: moves.length,
    },
    thresholds: { lowStockAtOrBelow: config.stock.limitedAtOrBelow, outOfStockAtOrBelow: config.stock.outOfStockAtOrBelow },
    expiry: { ...lot.counts, total: lot.rows.length, source: lot.source, asOf: lot.asOf, bands: EXPIRY_GROUPS },
    movements: { latest: moves.slice(0, 5), total: moves.length, sampleOdoo: sampleOdooEnabled() },
    stockLevels: stockLevels(db),
    notifications: notifications(db, today).count,
  };
}
