// Product Master read queries + stock-status enrichment.
import { computeStockStatus } from './stock.js';
import config from '../config.js';

function enrich(p) {
  if (!p) return p;
  return { ...p, stock_status: computeStockStatus(p) };
}

/**
 * Search / filter products.
 * @param {object} db
 * @param {object} q - { search, filter, limit, offset }
 *   filter: 'all'|'active'|'inactive'|'warning'|'barcode_review'|'uom_review'
 * @returns {{ total:number, items:object[] }}
 */
// Whitelisted sort orders. Anything else falls back to the name, so no client text ever reaches SQL.
const SORTS = {
  name_asc: 'name COLLATE NOCASE ASC',
  name_desc: 'name COLLATE NOCASE DESC',
  image_first: '(primary_image_id IS NOT NULL) DESC, name COLLATE NOCASE ASC',
  stock_desc: 'free_to_use DESC, name COLLATE NOCASE ASC',
  stock_asc: 'free_to_use ASC, name COLLATE NOCASE ASC',
  barcode_asc: 'barcode ASC',
};

export function searchProducts(db, q = {}) {
  const { search = '', filter = 'all', stock = 'all', sort = 'name_asc', limit = 100, offset = 0 } = q;
  const where = [];
  const params = [];

  if (search && search.trim()) {
    const s = `%${search.trim()}%`;
    where.push('(barcode LIKE ? OR name LIKE ? OR source_odoo_id LIKE ?)');
    params.push(s, s, s);
  }
  switch (filter) {
    case 'active': where.push('is_active = 1'); break;
    case 'inactive': where.push('is_active = 0'); break;
    case 'with_image': where.push('primary_image_id IS NOT NULL'); break;
    case 'warning': where.push("data_quality_status = 'WARNING'"); break;
    case 'barcode_review': where.push('barcode_change_pending = 1'); break;
    case 'uom_review': where.push('uom_change_pending = 1'); break;
    default: break;
  }
  // stock band, using the same thresholds as the customer catalogue (config.stock)
  const { outOfStockAtOrBelow, limitedAtOrBelow } = config.stock;
  switch (stock) {
    case 'out': where.push('free_to_use <= ?'); params.push(outOfStockAtOrBelow); break;
    case 'limited': where.push('free_to_use > ? AND free_to_use <= ?'); params.push(outOfStockAtOrBelow, limitedAtOrBelow); break;
    case 'in': where.push('free_to_use > ?'); params.push(limitedAtOrBelow); break;
    default: break;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderSql = SORTS[sort] || SORTS.name_asc;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products ${whereSql}`).get(...params).n;
  const items = db.prepare(
    `SELECT * FROM products ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
  ).all(...params, Math.min(Number(limit) || 100, 1000), Number(offset) || 0);

  let limitsMap = new Map();
  try {
    limitsMap = new Map(
      db.prepare('SELECT barcode, max_order_ctn FROM product_order_limits WHERE max_order_ctn > 0').all()
        .map((r) => [String(r.barcode), Number(r.max_order_ctn)]),
    );
  } catch { /* table may not exist on legacy pre-migration test db */ }

  return {
    total,
    items: items.map((p) => ({
      ...enrich(p),
      max_order_ctn: limitsMap.get(String(p.barcode)) || null,
    })),
  };
}

/** Full product detail bundle for the detail page. */
export function getProductDetail(db, id) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return null;

  let maxOrderCtn = null;
  try {
    const lim = db.prepare('SELECT max_order_ctn FROM product_order_limits WHERE barcode = ?').get(String(product.barcode));
    if (lim && lim.max_order_ctn > 0) maxOrderCtn = Number(lim.max_order_ctn);
  } catch { /* ignore */ }

  const category = product.category_id
    ? db.prepare('SELECT * FROM categories WHERE id = ?').get(product.category_id) : null;
  const images = db.prepare('SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, sort_order').all(id);

  const changeHistory = db.prepare(
    'SELECT * FROM import_changes WHERE product_id = ? ORDER BY id DESC LIMIT 500'
  ).all(id);

  const importHistory = db.prepare(
    `SELECT DISTINCT b.* FROM import_batches b
     JOIN import_changes c ON c.import_batch_id = b.id
     WHERE c.product_id = ? ORDER BY b.id DESC`
  ).all(id);

  const pendingReviews = db.prepare(
    "SELECT * FROM import_changes WHERE product_id = ? AND review_status = 'PENDING' ORDER BY id DESC"
  ).all(id);

  return { product: { ...enrich(product), max_order_ctn: maxOrderCtn }, category, images, changeHistory, importHistory, pendingReviews };
}

/** Set or clear a per-product purchasing limitation (max cartons per order) in product_order_limits. */
export function setProductOrderLimit(db, id, maxOrderCtn) {
  const product = db.prepare('SELECT id, barcode, name FROM products WHERE id = ?').get(Number(id));
  if (!product) {
    const err = new Error('Product not found');
    err.status = 404;
    throw err;
  }
  const raw = maxOrderCtn === '' || maxOrderCtn === null || maxOrderCtn === undefined ? 0 : Number(maxOrderCtn);
  if (!Number.isInteger(raw) || raw < 0 || raw > 100000) {
    const err = new Error('Order limit must be a whole number of cartons (0 or empty to clear).');
    err.status = 400;
    throw err;
  }
  const ts = new Date().toISOString();
  db.prepare(`
    INSERT INTO product_order_limits (barcode, max_order_ctn, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(barcode) DO UPDATE SET max_order_ctn = excluded.max_order_ctn, updated_at = excluded.updated_at
  `).run(String(product.barcode), raw, ts);
  return { id: product.id, barcode: product.barcode, maxOrderCtn: raw > 0 ? raw : null };
}

/** Set or clear upcoming incoming stock (cartons arriving soon) for a product. */
export function setProductIncoming(db, id, incomingCtn) {
  const product = db.prepare('SELECT id, barcode, name FROM products WHERE id = ?').get(Number(id));
  if (!product) {
    const err = new Error('Product not found');
    err.status = 404;
    throw err;
  }
  const raw = incomingCtn === '' || incomingCtn === null || incomingCtn === undefined ? 0 : Number(incomingCtn);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1000000) {
    const err = new Error('Incoming cartons must be 0 or a positive number.');
    err.status = 400;
    throw err;
  }
  db.prepare('UPDATE products SET incoming = ?, updated_at = ? WHERE id = ?').run(Math.trunc(raw), new Date().toISOString(), product.id);
  return { id: product.id, barcode: product.barcode, incoming: Math.trunc(raw) };
}

/** Aggregate stats for dashboards / data-quality report. */
export function productStats(db) {
  const row = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN is_active=0 THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN data_quality_status='WARNING' THEN 1 ELSE 0 END) AS warnings,
      SUM(CASE WHEN data_quality_status='ERROR' THEN 1 ELSE 0 END) AS errors,
      SUM(CASE WHEN barcode_change_pending=1 THEN 1 ELSE 0 END) AS barcode_pending,
      SUM(CASE WHEN uom_change_pending=1 THEN 1 ELSE 0 END) AS uom_pending,
      SUM(CASE WHEN source_odoo_id IS NULL THEN 1 ELSE 0 END) AS missing_source_id
    FROM products`).get();
  return row;
}

export default { searchProducts, getProductDetail, productStats };

/**
 * Every product matching the same filters, for a read-only CSV export. Nothing is changed.
 * Capped at 20,000 rows as a sanity limit.
 */
export function exportProductsRows(db, q = {}) {
  const EXPORT_CAP = 20000;
  const PAGE = 1000;                       // searchProducts caps one page at 1,000
  const rows = [];
  for (let offset = 0; rows.length < EXPORT_CAP; offset += PAGE) {
    const { items, total } = searchProducts(db, { ...q, limit: PAGE, offset });
    rows.push(...items);
    if (offset + PAGE >= total || items.length === 0) break;
  }
  return rows.slice(0, EXPORT_CAP);
}
