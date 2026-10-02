// Change Review: list and resolve pending barcode / UoM changes.
// Resolving is an application action (never done by an import).
import { ReviewStatus, ChangeType } from './constants.js';

function nowIso() { return new Date().toISOString(); }

/** All pending review items, newest first, with product context. */
export function listPendingReviews(db) {
  return db.prepare(
    `SELECT c.*, p.name AS product_name, p.barcode AS current_barcode, p.box_uom AS current_uom,
            p.is_active AS product_active
       FROM import_changes c
       JOIN products p ON p.id = c.product_id
      WHERE c.review_status = 'PENDING'
      ORDER BY c.id DESC`
  ).all();
}

export function reviewCounts(db) {
  return db.prepare(
    `SELECT
        SUM(CASE WHEN change_type='BARCODE_CHANGE_DETECTED' THEN 1 ELSE 0 END) AS barcode,
        SUM(CASE WHEN change_type='UOM_CHANGE_DETECTED' THEN 1 ELSE 0 END) AS uom,
        COUNT(*) AS total
       FROM import_changes WHERE review_status='PENDING'`
  ).get();
}

/**
 * Resolve a pending barcode change.
 * @param {string} decision 'accept' | 'reject'
 */
export function resolveBarcodeChange(db, productId, decision) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) throw new Error(`Product ${productId} not found`);
  if (p.barcode_change_pending !== 1) throw new Error('No pending barcode change for this product');

  db.exec('BEGIN IMMEDIATE');
  try {
    if (decision === 'accept') {
      db.prepare('UPDATE products SET barcode = ?, barcode_change_pending = 0, pending_barcode = NULL, updated_at = ? WHERE id = ?')
        .run(p.pending_barcode, nowIso(), productId);
    } else {
      db.prepare('UPDATE products SET barcode_change_pending = 0, pending_barcode = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso(), productId);
    }
    const status = decision === 'accept' ? ReviewStatus.ACCEPTED : ReviewStatus.REJECTED;
    db.prepare("UPDATE import_changes SET review_status = ? WHERE product_id = ? AND change_type = ? AND review_status = 'PENDING'")
      .run(status, productId, ChangeType.BARCODE_CHANGE_DETECTED);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { productId, decision, field: 'barcode' };
}

/** Resolve a pending UoM change. */
export function resolveUomChange(db, productId, decision) {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
  if (!p) throw new Error(`Product ${productId} not found`);
  if (p.uom_change_pending !== 1) throw new Error('No pending UoM change for this product');

  db.exec('BEGIN IMMEDIATE');
  try {
    if (decision === 'accept') {
      db.prepare('UPDATE products SET box_uom = ?, uom_change_pending = 0, pending_uom = NULL, updated_at = ? WHERE id = ?')
        .run(p.pending_uom, nowIso(), productId);
    } else {
      db.prepare('UPDATE products SET uom_change_pending = 0, pending_uom = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso(), productId);
    }
    const status = decision === 'accept' ? ReviewStatus.ACCEPTED : ReviewStatus.REJECTED;
    db.prepare("UPDATE import_changes SET review_status = ? WHERE product_id = ? AND change_type = ? AND review_status = 'PENDING'")
      .run(status, productId, ChangeType.UOM_CHANGE_DETECTED);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { productId, decision, field: 'box_uom' };
}

export default { listPendingReviews, reviewCounts, resolveBarcodeChange, resolveUomChange };
