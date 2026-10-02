// Orchestration: file storage, batch lifecycle, preview & confirm.
import fs from 'node:fs';
import path from 'node:path';
import { buildPlan } from './planner.js';
import { applyPlan } from './commit.js';
import { ImportStatus } from '../domain/constants.js';
import config from '../config.js';

function nowIso() { return new Date().toISOString(); }
function safeName(name) { return String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(-120); }

/** Build the capped payload the UI/API consumes (full review lists, sampled rows). */
export function toPreviewPayload(plan, batchId) {
  const CAP = 200;
  return {
    batchId,
    ok: plan.ok,
    fatal: plan.fatal,
    filename: plan.filename,
    headerMapping: plan.headerMapping,
    unexpectedColumns: plan.unexpectedColumns,
    missingColumns: plan.missingColumns,
    duplicateTargetColumns: plan.duplicateTargetColumns,
    summary: plan.summary,
    // full review-critical lists (capped generously)
    errors: plan.errorRows.slice(0, CAP),
    warnings: plan.warningRows.slice(0, CAP),
    barcodeChanges: plan.reviewItems.barcodeChanges.slice(0, CAP),
    uomChanges: plan.reviewItems.uomChanges.slice(0, CAP),
    inactivations: plan.inactivations.slice(0, CAP),
    // samples of the bulk actions
    sampleCreated: plan.operations.filter((o) => o.action === 'CREATE').slice(0, 25)
      .map((o) => ({ rowNumber: o.rowNumber, barcode: o.barcode, name: o.record.name })),
    sampleUpdated: plan.operations.filter((o) => o.action === 'UPDATE').slice(0, 25)
      .map((o) => ({ rowNumber: o.rowNumber, barcode: o.barcode, name: o.record.name, changes: o.changes })),
    caps: { applied: CAP },
  };
}

function insertBatch(db, plan, status) {
  const s = plan.summary;
  const info = db.prepare(`INSERT INTO import_batches
    (filename, file_hash, imported_at, total_rows, valid_rows, invalid_rows,
     created_count, updated_count, unchanged_count, inactive_count, reactivated_count,
     barcode_change_count, uom_change_count, warning_count, error_count, status, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(plan.filename, plan.fileHash, nowIso(),
      s.total_rows, s.valid_rows, s.invalid_rows,
      s.created, s.updated, s.unchanged, s.inactivated, s.reactivated,
      s.barcode_changes, s.uom_changes, s.warnings, s.errors, status,
      plan.fatal || null);
  return Number(info.lastInsertRowid);
}

/**
 * Create a PREVIEW batch from a file. No product writes occur.
 * The uploaded file is copied into the uploads dir so confirm can re-read it.
 * @returns { batchId, status, preview }
 */
export function createPreview(db, filePath, originalFilename, opts = {}) {
  const uploadsDir = opts.uploadsDir || config.uploadsDir;
  const plan = buildPlan(db, filePath, originalFilename);

  if (!plan.ok) {
    const batchId = insertBatch(db, plan, ImportStatus.FAILED);
    const preview = toPreviewPayload(plan, batchId);
    db.prepare('UPDATE import_batches SET preview_json = ? WHERE id = ?').run(JSON.stringify(preview), batchId);
    return { batchId, status: ImportStatus.FAILED, preview };
  }

  const batchId = insertBatch(db, plan, ImportStatus.PREVIEW);

  // persist a copy of the source file for a faithful confirm
  fs.mkdirSync(uploadsDir, { recursive: true });
  const stored = path.join(uploadsDir, `${batchId}-${safeName(originalFilename || 'import.xlsx')}`);
  fs.copyFileSync(filePath, stored);

  const preview = toPreviewPayload(plan, batchId);
  db.prepare('UPDATE import_batches SET stored_path = ?, preview_json = ? WHERE id = ?')
    .run(stored, JSON.stringify(preview), batchId);

  return { batchId, status: ImportStatus.PREVIEW, preview };
}

/**
 * Confirm a PREVIEW batch: re-read the stored file, rebuild the plan against the
 * CURRENT database, and apply everything in one transaction.
 * @returns { batchId, status, counts }
 */
export function confirmImport(db, batchId, opts = {}) {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) throw new Error(`Import batch ${batchId} not found`);
  if (batch.status !== ImportStatus.PREVIEW) {
    throw new Error(`Import batch ${batchId} is '${batch.status}', only PREVIEW can be confirmed`);
  }
  if (!batch.stored_path || !fs.existsSync(batch.stored_path)) {
    throw new Error(`Stored file for batch ${batchId} is missing`);
  }

  // Rebuild against current state (safe if DB changed since preview).
  const plan = buildPlan(db, batch.stored_path, batch.filename);
  if (!plan.ok) {
    db.prepare('UPDATE import_batches SET status = ?, notes = ? WHERE id = ?')
      .run(ImportStatus.FAILED, plan.fatal, batchId);
    throw new Error(`Cannot confirm: ${plan.fatal}`);
  }

  db.prepare('UPDATE import_batches SET status = ?, confirmed_at = ? WHERE id = ?')
    .run(ImportStatus.CONFIRMED, nowIso(), batchId);

  db.exec('BEGIN IMMEDIATE');
  try {
    const counts = applyPlan(db, plan, batchId, opts);
    const s = plan.summary;
    db.prepare(`UPDATE import_batches SET
        status = ?, completed_at = ?,
        total_rows = ?, valid_rows = ?, invalid_rows = ?,
        created_count = ?, updated_count = ?, unchanged_count = ?,
        inactive_count = ?, reactivated_count = ?,
        barcode_change_count = ?, uom_change_count = ?, warning_count = ?, error_count = ?
       WHERE id = ?`)
      .run(ImportStatus.COMPLETED, nowIso(),
        s.total_rows, s.valid_rows, s.invalid_rows,
        counts.created, counts.updated, counts.unchanged,
        counts.inactivated, counts.reactivated,
        counts.barcode_changes, counts.uom_changes, s.warnings, counts.errors,
        batchId);
    db.exec('COMMIT');
    return { batchId, status: ImportStatus.COMPLETED, counts };
  } catch (e) {
    db.exec('ROLLBACK');
    db.prepare('UPDATE import_batches SET status = ?, notes = ? WHERE id = ?')
      .run(ImportStatus.FAILED, `Apply failed: ${e.message}`, batchId);
    throw e;
  }
}

export default { createPreview, confirmImport, toPreviewPayload };
