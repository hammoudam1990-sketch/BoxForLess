// Steps 10-11: apply a plan to the database inside a single transaction and
// write all audit records. Either everything commits, or nothing does.
import { ChangeType, ReviewStatus, DataQuality } from '../domain/constants.js';
import { STOCK_FIELDS } from '../domain/constants.js';
import { ensureCategoryPath } from '../domain/categories.js';

function nowIso() { return new Date().toISOString(); }

function logChange(db, batchId, { productId = null, changeType, field = null, oldValue = null, newValue = null, rowNumber = null, barcode = null, reviewStatus = ReviewStatus.NA, message = null }) {
  db.prepare(`INSERT INTO import_changes
    (import_batch_id, product_id, change_type, field, old_value, new_value, row_number, barcode, review_status, message, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(batchId, productId, changeType, field,
      oldValue == null ? null : String(oldValue),
      newValue == null ? null : String(newValue),
      rowNumber, barcode, reviewStatus, message, nowIso());
}

function qualityOf(warnings) {
  return warnings && warnings.length ? DataQuality.WARNING : DataQuality.OK;
}

/**
 * Apply the plan. MUST be called inside an open transaction (see runCommit).
 * @returns {object} applied counts
 */
export function applyPlan(db, plan, batchId, opts = {}) {
  const ts = nowIso();
  const counts = { created: 0, updated: 0, unchanged: 0, inactivated: 0, reactivated: 0, barcode_changes: 0, uom_changes: 0, category_changes: 0, errors: 0 };

  for (const op of plan.operations) {
    if (op.action === 'ERROR') {
      counts.errors += 1;
      logChange(db, batchId, { productId: op.productId, changeType: ChangeType.VALIDATION_ERROR, rowNumber: op.rowNumber, barcode: op.barcode, message: op.errors.join('; ') });
      continue;
    }

    if (op.action === 'CREATE') {
      const r = op.record;
      const notes = op.warnings?.length ? op.warnings.join('; ') : null;
      // Odoo category: materialise the path into the hierarchy and link the leaf.
      const categoryId = ensureCategoryPath(db, r.category_path, { now: ts });
      const info = db.prepare(`INSERT INTO products
        (source_odoo_id, barcode, name, box_uom, on_hand, free_to_use, incoming, outgoing, forecasted,
         odoo_category_path, category_id,
         is_active, data_quality_status, data_quality_notes, created_at, updated_at, last_import_id, last_seen_import_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`)
        .run(r.source_odoo_id, r.barcode, r.name, r.box_uom,
          r.on_hand, r.free_to_use, r.incoming, r.outgoing, r.forecasted,
          r.category_path ?? null, categoryId,
          qualityOf(op.warnings), notes, ts, ts, batchId, batchId);
      const productId = Number(info.lastInsertRowid);
      counts.created += 1;
      logChange(db, batchId, { productId, changeType: ChangeType.PRODUCT_CREATED, rowNumber: op.rowNumber, barcode: r.barcode, message: notes });
      if (r.category_path) {
        counts.category_changes += 1;
        logChange(db, batchId, { productId, changeType: ChangeType.CATEGORY_CHANGE_DETECTED, field: 'odoo_category_path', oldValue: null, newValue: r.category_path, rowNumber: op.rowNumber, barcode: r.barcode, message: 'Category set from Odoo export' });
      }
      continue;
    }

    if (op.action === 'UNCHANGED') {
      counts.unchanged += 1;
      continue; // true no-op: no writes, keeps re-imports idempotent
    }

    // UPDATE
    const r = op.record;
    const setParts = [];
    const vals = [];

    // Odoo-controlled field updates (name + stock + category)
    for (const ch of op.changes) {
      setParts.push(`${ch.field} = ?`);
      vals.push(ch.new);
      if (ch.isCategory) {
        // Applied (Odoo owns it) but recorded under its own change type, so the
        // previous category stays visible in history rather than being lost.
        const categoryId = ensureCategoryPath(db, ch.new, { now: ts });
        setParts.push('category_id = ?');
        vals.push(categoryId);
        counts.category_changes += 1;
        logChange(db, batchId, { productId: op.productId, changeType: ChangeType.CATEGORY_CHANGE_DETECTED, field: 'odoo_category_path', oldValue: ch.old, newValue: ch.new, rowNumber: op.rowNumber, barcode: op.barcode, message: 'Category updated from Odoo export' });
      } else {
        logChange(db, batchId, { productId: op.productId, changeType: ChangeType.PRODUCT_UPDATED, field: ch.field, oldValue: ch.old, newValue: ch.new, rowNumber: op.rowNumber, barcode: op.barcode });
      }
    }

    // Review changes: set pending flags, DO NOT apply the new value
    for (const rc of op.reviewChanges) {
      if (rc.field === 'box_uom') {
        setParts.push('uom_change_pending = 1', 'pending_uom = ?');
        vals.push(rc.new);
        counts.uom_changes += 1;
        logChange(db, batchId, { productId: op.productId, changeType: ChangeType.UOM_CHANGE_DETECTED, field: 'box_uom', oldValue: rc.old, newValue: rc.new, rowNumber: op.rowNumber, barcode: op.barcode, reviewStatus: ReviewStatus.PENDING, message: 'UoM differs from stored value; awaiting review' });
      } else if (rc.field === 'barcode') {
        setParts.push('barcode_change_pending = 1', 'pending_barcode = ?');
        vals.push(rc.new);
        counts.barcode_changes += 1;
        logChange(db, batchId, { productId: op.productId, changeType: ChangeType.BARCODE_CHANGE_DETECTED, field: 'barcode', oldValue: rc.old, newValue: rc.new, rowNumber: op.rowNumber, barcode: op.barcode, reviewStatus: ReviewStatus.PENDING, message: 'Barcode differs from stored value; awaiting review' });
      }
    }

    if (op.reactivate) {
      setParts.push('is_active = 1');
      counts.reactivated += 1;
      logChange(db, batchId, { productId: op.productId, changeType: ChangeType.PRODUCT_REACTIVATED, rowNumber: op.rowNumber, barcode: op.barcode, message: 'Product reappeared in Odoo export' });
    }

    // data quality from warnings on this row
    setParts.push('data_quality_status = ?', 'data_quality_notes = ?');
    vals.push(qualityOf(op.warnings), op.warnings?.length ? op.warnings.join('; ') : null);

    setParts.push('updated_at = ?', 'last_import_id = ?', 'last_seen_import_id = ?');
    vals.push(ts, batchId, batchId);

    vals.push(op.productId);
    db.prepare(`UPDATE products SET ${setParts.join(', ')} WHERE id = ?`).run(...vals);
    counts.updated += 1;
  }

  // Test-only seam: inject a fault AFTER rows are written but BEFORE commit,
  // to prove the transaction rolls back a partial import (see test 14).
  if (typeof opts.faultHook === 'function') opts.faultHook();

  // Inactivations (never delete)
  for (const inact of plan.inactivations) {
    db.prepare('UPDATE products SET is_active = 0, updated_at = ?, last_import_id = ? WHERE id = ?')
      .run(ts, batchId, inact.productId);
    counts.inactivated += 1;
    logChange(db, batchId, { productId: inact.productId, changeType: ChangeType.PRODUCT_MARKED_INACTIVE, barcode: inact.barcode, message: 'Not present in latest Odoo export' });
  }

  return counts;
}

export default applyPlan;
