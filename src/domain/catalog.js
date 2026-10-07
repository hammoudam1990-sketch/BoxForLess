// Customer-facing catalog: a SAFE PRESENTATION LAYER over the Product Master.
//
//   Product Master (products table)  =  source of truth, internal
//   Customer Catalog (this module)   =  customer-safe projection of it
//
// There is no second product database, no second image system and no second
// stock classification. This module only READS, and it never returns a Product
// Master row. Every customer payload is built field-by-field by toCatalogProduct
// below, so a column added to `products` later cannot leak by default.
import { computeStockStatus } from './stock.js';
import { StockStatus, STOCK_FIELDS } from './constants.js';
import { parseCategoryPath } from './categories.js';
import { wholeCartons } from './stock-source.js';
import config from '../config.js';

/**
 * The COMPLETE set of keys a customer payload may contain. The security test
 * asserts the serializer's output against exactly this set, so adding a field
 * here is a deliberate, reviewed act.
 */
export const CUSTOMER_SAFE_FIELDS = Object.freeze([
  'id',           // PUBLIC id = barcode. NEVER products.id.
  'name',
  'barcode',
  'pack',         // box_uom, renamed for customers
  'category',     // { top_level, parent, name, path } — NAMES only, never an id
  'availability', // { status, label } — never a quantity
  'image',        // { url } or null — never a filename or a storage path
  'requestable',  // boolean: at least one WHOLE carton exists — never how many
]);

/**
 * Fields that must NEVER appear in a customer payload. Kept explicit so the
 * security test reads as a specification rather than a list of guesses.
 */
export const FORBIDDEN_CUSTOMER_FIELDS = Object.freeze([
  'price', 'cost', 'margin',
  'on_hand', 'free_to_use', 'incoming', 'outgoing', 'forecasted',
  'product_id', 'primary_image_id', 'category_id', 'odoo_category_id', 'parent_id',
  'source_odoo_id',
  'last_import_id', 'last_seen_import_id', 'import_batch_id',
  'barcode_change_pending', 'uom_change_pending', 'pending_barcode', 'pending_uom',
  'data_quality_status', 'data_quality_notes',
  'is_active', 'created_at', 'updated_at',
  'filename', 'url_reference', 'stock_status',
]);

/** Customer-visible availability. Exactly three states, never a quantity. */
export const Availability = Object.freeze({
  IN_STOCK: { status: 'IN_STOCK', label: 'In Stock', tone: 'in' },
  LIMITED_STOCK: { status: 'LIMITED_STOCK', label: 'Limited Stock', tone: 'limited' },
  OUT_OF_STOCK: { status: 'OUT_OF_STOCK', label: 'Out of Stock', tone: 'out' },
});

/**
 * Map a Product Master row to customer availability.
 * REUSES computeStockStatus() — the Product Master's own classification — so the
 * admin pill and the customer pill can never disagree. The mapping is 1:1:
 *   IN_STOCK -> In Stock | LIMITED_STOCK -> Limited Stock | OUT_OF_STOCK -> Out of Stock
 * The underlying quantity is consumed here and never travels further.
 */
export function toAvailability(productRow, thresholds = config.stock) {
  const status = computeStockStatus(productRow, thresholds);
  return Availability[status] || Availability.OUT_OF_STOCK;
}

/** The public, customer-safe identifier for a product. */
export function publicId(productRow) {
  return String(productRow.barcode);
}

/** Customer-facing image URL, keyed by the PUBLIC id (never products.id). */
export function catalogImageUrl(id) {
  return `/api/catalog/products/${encodeURIComponent(id)}/image`;
}

/**
 * THE serializer. Builds a fresh object from an allow-list; it never spreads,
 * copies or deletes from the source row, so an unlisted column cannot escape.
 * @param {object} row - a products row carrying odoo_category_path
 * @returns {object} customer-safe product
 */
export function toCatalogProduct(row, thresholds = config.stock) {
  if (!row) return null;
  const id = publicId(row);
  // Category is derived from the Odoo PATH, never from the categories table, so
  // no database category id can reach a customer by any route.
  const c = parseCategoryPath(row.odoo_category_path);
  return {
    id,
    name: row.name ?? '',
    barcode: row.barcode ?? '',
    pack: row.box_uom || null,
    category: c ? { top_level: c.topLevel, parent: c.parent, name: c.name, path: c.path } : null,
    availability: { ...toAvailability(row, thresholds) },
    image: row.primary_image_id ? { url: catalogImageUrl(id) } : null,
    // Requests are whole cartons only, so a product holding less than one full
    // carton is not requestable even though it still shows as Limited Stock.
    // A BOOLEAN, never the count — the exact figure stays server-side.
    requestable: wholeCartons(row[thresholds.availabilityField]) >= 1,
  };
}

// ---------------------------------------------------------------------------
// Queries. Every one of them is hard-scoped to is_active = 1.
// ---------------------------------------------------------------------------

const SORTS = Object.freeze({
  name_asc: 'p.name COLLATE NOCASE ASC',
  name_desc: 'p.name COLLATE NOCASE DESC',
});
export const DEFAULT_SORT = 'name_asc';

/**
 * SQL predicate for an availability filter, derived from the SAME config
 * thresholds computeStockStatus() uses, so filter and badge stay in sync.
 * Filtering happens in SQL so pagination counts are correct.
 */
function availabilityWhere(availability, thresholds) {
  const field = thresholds.availabilityField;
  // the field name comes from config, never from the request — validate anyway
  if (!STOCK_FIELDS.includes(field)) throw new Error(`Unsafe availability field: ${field}`);
  const col = `p.${field}`;
  const { outOfStockAtOrBelow: out, limitedAtOrBelow: lim } = thresholds;
  switch (availability) {
    case StockStatus.OUT_OF_STOCK: return { sql: `${col} <= ?`, params: [out] };
    case StockStatus.LIMITED_STOCK: return { sql: `${col} > ? AND ${col} <= ?`, params: [out, lim] };
    case StockStatus.IN_STOCK: return { sql: `${col} > ?`, params: [lim] };
    default: return null;
  }
}

export const MAX_PAGE_SIZE = 60;
export const DEFAULT_PAGE_SIZE = 24;

/**
 * Customer catalog search.
 * @param {object} db
 * @param {object} q - { search, availability, withImage, sort, limit, offset }
 * @returns {{ total:number, limit:number, offset:number, items:object[] }}
 */
export function searchCatalog(db, q = {}, thresholds = config.stock) {
  const {
    search = '', availability = 'ALL', withImage = false,
    availableOnly = false,
    topLevel = null, categoryPath = null,
    sort = DEFAULT_SORT, limit, offset,
  } = q;

  // Inactive products are invisible to customers. This is not a filter the
  // caller can turn off — it is the first clause of every catalog query.
  const where = ['p.is_active = 1'];
  const params = [];

  // "Available Now" = active AND some stock on hand. Distinct from the In Stock
  // BAND (which means plenty): a product with 1 carton is Limited Stock but is
  // still available now. Note this is > 0, not >= 1 carton, so it can include a
  // part-carton product that is visible but not requestable — the customer still
  // deserves to see it exists.
  if (availableOnly) {
    where.push(`p.${thresholds.availabilityField} > ?`);
    params.push(thresholds.outOfStockAtOrBelow);
  }

  if (search && String(search).trim()) {
    // case-insensitive partial match on the two customer-safe identifiers
    const s = `%${String(search).trim()}%`;
    where.push('(UPPER(p.name) LIKE UPPER(?) OR p.barcode LIKE ?)');
    params.push(s, s);
  }

  const avail = availabilityWhere(availability, thresholds);
  if (avail) { where.push(`(${avail.sql})`); params.push(...avail.params); }

  if (withImage) where.push('p.primary_image_id IS NOT NULL');

  // Category filtering works on the Odoo PATH. A top-level filter matches that
  // segment and everything beneath it; an exact path matches that node and its
  // descendants. Both are parameterised.
  if (topLevel && String(topLevel).trim()) {
    const t = String(topLevel).trim();
    where.push('(p.odoo_category_path = ? OR p.odoo_category_path LIKE ?)');
    params.push(t, `${t} / %`);
  }
  if (categoryPath && String(categoryPath).trim()) {
    const c = String(categoryPath).trim();
    where.push('(p.odoo_category_path = ? OR p.odoo_category_path LIKE ?)');
    params.push(c, `${c} / %`);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const orderSql = SORTS[sort] || SORTS[DEFAULT_SORT];

  const lim = Math.min(Math.max(Number(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const off = Math.max(Number(offset) || 0, 0);

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products p ${whereSql}`).get(...params).n;

  // Only the columns the serializer needs are selected — the query itself is a
  // second, independent barrier in front of toCatalogProduct().
  const rows = db.prepare(
    `SELECT p.name, p.barcode, p.box_uom, p.primary_image_id, p.odoo_category_path,
            p.${thresholds.availabilityField}
     FROM products p
     ${whereSql}
     ORDER BY ${orderSql}
     LIMIT ? OFFSET ?`
  ).all(...params, lim, off);

  return { total, limit: lim, offset: off, items: rows.map((r) => toCatalogProduct(r, thresholds)) };
}

/**
 * One customer-safe product by its PUBLIC id (barcode).
 * Returns null for an unknown id AND for any inactive product, so an inactive
 * product is indistinguishable from a non-existent one.
 */
export function getCatalogProduct(db, id, thresholds = config.stock) {
  if (id === null || id === undefined || String(id).trim() === '') return null;
  const row = db.prepare(
    `SELECT p.name, p.barcode, p.box_uom, p.primary_image_id, p.odoo_category_path,
            p.${thresholds.availabilityField}
     FROM products p
     WHERE p.barcode = ? AND p.is_active = 1`
  ).get(String(id).trim());
  return row ? toCatalogProduct(row, thresholds) : null;
}

/**
 * Resolve a public id to the INTERNAL product id, for server-side use only
 * (the image route needs it to reach the existing image store). The internal id
 * is never put into a response. Inactive products never resolve.
 */
export function resolveInternalId(db, id) {
  if (id === null || id === undefined || String(id).trim() === '') return null;
  const row = db.prepare('SELECT id FROM products WHERE barcode = ? AND is_active = 1').get(String(id).trim());
  return row ? row.id : null;
}

/** Counts per availability state, for the filter chips. Active products only. */
export function catalogFacets(db, thresholds = config.stock) {
  const f = thresholds.availabilityField;
  if (!STOCK_FIELDS.includes(f)) throw new Error(`Unsafe availability field: ${f}`);
  const r = db.prepare(
    `SELECT COUNT(*) AS all_count,
            SUM(CASE WHEN ${f} > ? THEN 1 ELSE 0 END) AS in_stock,
            SUM(CASE WHEN ${f} > ? AND ${f} <= ? THEN 1 ELSE 0 END) AS limited,
            SUM(CASE WHEN ${f} <= ? THEN 1 ELSE 0 END) AS out_of_stock,
            SUM(CASE WHEN primary_image_id IS NOT NULL THEN 1 ELSE 0 END) AS with_image
     FROM products WHERE is_active = 1`
  ).get(thresholds.limitedAtOrBelow, thresholds.outOfStockAtOrBelow,
    thresholds.limitedAtOrBelow, thresholds.outOfStockAtOrBelow);
  return {
    all: r.all_count || 0,
    in_stock: r.in_stock || 0,
    limited: r.limited || 0,
    out_of_stock: r.out_of_stock || 0,
    with_image: r.with_image || 0,
  };
}

/**
 * Customer-safe category tree with product counts, built from the Odoo paths of
 * ACTIVE products only. Names and paths only — no database ids of any kind.
 * @returns {Array<{top_level:string, path:string, name:string, parent:string|null,
 *                  level:number, count:number}>}
 */
/**
 * Counts for the category chips.
 *
 * `view` MUST match the list the customer is looking at. On Available Now the
 * chips used to count the whole catalogue, so HOT DRINKS read "5" above a list of
 * 2 — the three without stock were counted but not shown. A count that disagrees
 * with the list beneath it makes the customer distrust both.
 */
export function categoryFacets(db, { view = 'full' } = {}) {
  const availableOnly = view === 'available';
  const rows = db.prepare(
    `SELECT odoo_category_path AS path, COUNT(*) AS n
     FROM products
     WHERE is_active = 1 AND odoo_category_path IS NOT NULL
       ${availableOnly ? 'AND free_to_use > 0' : ''}
     GROUP BY odoo_category_path`
  ).all();

  // Roll each leaf path up through its ancestors so a top-level count includes
  // everything beneath it.
  const totals = new Map();
  for (const r of rows) {
    const parsed = parseCategoryPath(r.path);
    if (!parsed) continue;
    parsed.segments.forEach((_, i) => {
      const p = parsed.segments.slice(0, i + 1).join(' / ');
      totals.set(p, (totals.get(p) || 0) + r.n);
    });
  }

  return [...totals.entries()]
    .map(([path, count]) => {
      const c = parseCategoryPath(path);
      return { top_level: c.topLevel, path: c.path, name: c.name, parent: c.parent, level: c.level, count };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export default { searchCatalog, getCatalogProduct, toCatalogProduct, catalogFacets, categoryFacets };
