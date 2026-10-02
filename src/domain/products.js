// Product Master read queries + stock-status enrichment.
import { computeStockStatus } from './stock.js';

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
export function searchProducts(db, q = {}) {
  const { search = '', filter = 'all', limit = 100, offset = 0 } = q;
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
    case 'warning': where.push("data_quality_status = 'WARNING'"); break;
    case 'barcode_review': where.push('barcode_change_pending = 1'); break;
    case 'uom_review': where.push('uom_change_pending = 1'); break;
    default: break;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM products ${whereSql}`).get(...params).n;
  const items = db.prepare(
    `SELECT * FROM products ${whereSql} ORDER BY name LIMIT ? OFFSET ?`
  ).all(...params, Math.min(Number(limit) || 100, 1000), Number(offset) || 0);

  return { total, items: items.map(enrich) };
}

/** Full product detail bundle for the detail page. */
export function getProductDetail(db, id) {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
  if (!product) return null;

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

  return { product: enrich(product), category, images, changeHistory, importHistory, pendingReviews };
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
