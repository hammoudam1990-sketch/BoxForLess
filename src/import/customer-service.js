// Customer-list import: preview, then an explicitly confirmed apply.
//
// Deliberately SEPARATE from the product import service. The two share nothing but
// the workbook reader, so no change here can alter product import behaviour, and
// the audits live in different tables (customer_imports vs import_batches).
//
// Preview writes nothing. Nothing is applied until confirmCustomerImport() is
// called with the batch id — the 355 real customers are never imported by the act
// of looking at them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readWorkbook } from './reader.js';
import { mapCustomerHeaders, normalizeCustomer, previewCustomerImport, importCustomers } from '../domain/customers.js';
import config from '../config.js';

function nowIso() { return new Date().toISOString(); }

export class CustomerImportServiceError extends Error {
  constructor(msg) { super(msg); this.name = 'CustomerImportServiceError'; this.code = 'CUSTOMER_IMPORT_FAILED'; this.status = 400; }
}

/** Read a contact workbook into allow-listed records. */
export function readCustomerFile(filePath) {
  const wb = readWorkbook(filePath);
  const { mapping, ignored, hasStableId } = mapCustomerHeaders(wb.headers);
  if (!mapping.name) {
    throw new CustomerImportServiceError(
      'No customer name column found. The file needs a "Display Name" column.'
    );
  }
  const records = wb.rows.map((raw) => normalizeCustomer(raw, mapping));
  return { records, mapping, ignored, hasStableId, fileHash: wb.fileHash, headers: wb.headers };
}

/**
 * Build a preview and persist it as a PREVIEW batch. No customer row is written.
 * @returns {{batchId:number, preview:object}}
 */
export function createCustomerPreview(db, filePath, filename, opts = {}) {
  const { records, mapping, ignored, hasStableId, fileHash, headers } = readCustomerFile(filePath);
  const preview = previewCustomerImport(db, records);

  // Keep a copy of the source file alongside the product uploads, so an audited
  // import can always be traced back to the exact bytes it came from.
  const uploadsDir = opts.uploadsDir || config.uploadsDir;
  let storedPath = null;
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    storedPath = path.join(uploadsDir, `customers-${Date.now()}-${path.basename(filename).replace(/[^\w.-]/g, '_')}`);
    fs.copyFileSync(filePath, storedPath);
  } catch { storedPath = null; /* audit copy is best-effort, never fatal */ }

  const s = preview.summary;
  const payload = {
    ...preview,
    filename,
    headers,
    mappedColumns: Object.fromEntries(Object.entries(mapping)),
    ignoredColumns: ignored,
    hasStableId,
    records,                // kept so confirm applies EXACTLY what was previewed
    storedPath,
  };

  const info = db.prepare(
    `INSERT INTO customer_imports
       (filename, file_hash, status, total_rows, valid_rows, invalid_rows, duplicate_rows,
        new_count, updated_count, unchanged_count, warning_count, preview_json, created_at)
     VALUES (?,?,'PREVIEW',?,?,?,?,?,?,?,?,?,?)`
  ).run(filename, fileHash, s.total_rows, s.valid_rows, s.invalid_rows, s.duplicate_rows,
    s.new_count, s.updated_count, s.unchanged_count, s.warning_count,
    JSON.stringify(payload), nowIso());

  return { batchId: Number(info.lastInsertRowid), preview: toPreviewPayload(payload) };
}

/** The preview as the UI should see it — the full record list is not shipped. */
export function toPreviewPayload(payload) {
  return {
    filename: payload.filename,
    summary: payload.summary,
    mappedColumns: payload.mappedColumns,
    ignoredColumns: payload.ignoredColumns,
    hasStableId: payload.hasStableId,
    errorRows: payload.errorRows.slice(0, 100),
    warningRows: payload.warningRows.slice(0, 100),
    sample: payload.rows.slice(0, 20),
  };
}

/**
 * Apply a previewed batch. Transactional: either every customer lands or none do.
 * A batch can only be confirmed once.
 */
export function confirmCustomerImport(db, batchId, opts = {}) {
  const batch = db.prepare('SELECT * FROM customer_imports WHERE id = ?').get(Number(batchId));
  if (!batch) throw new CustomerImportServiceError(`Customer import ${batchId} not found`);
  if (batch.status === 'COMPLETED') throw new CustomerImportServiceError('This import has already been applied.');
  if (!batch.preview_json) throw new CustomerImportServiceError('This import has no stored preview.');

  const payload = JSON.parse(batch.preview_json);
  // Only rows the preview judged valid are applied — an invalid or duplicate row
  // is never quietly imported because it sat in the same file as good ones.
  const bad = new Set(payload.errorRows.map((r) => r.rowNumber));
  const records = payload.records.filter((_, i) => !bad.has(i + 1));

  try {
    const counts = importCustomers(db, records, { ...opts, deactivateMissing: opts.deactivateMissing === true });
    db.prepare(
      `UPDATE customer_imports SET status='COMPLETED', confirmed_at=?,
         new_count=?, updated_count=?, unchanged_count=? WHERE id=?`
    ).run(nowIso(), counts.created, counts.updated, counts.unchanged, batch.id);
    return { batchId: batch.id, status: 'COMPLETED', counts };
  } catch (e) {
    db.prepare('UPDATE customer_imports SET status=?, notes=? WHERE id=?')
      .run('FAILED', `Apply failed: ${e.message}`, batch.id);
    throw e;
  }
}

export function listCustomerImports(db, limit = 50) {
  return db.prepare(
    'SELECT id, filename, status, total_rows, valid_rows, invalid_rows, duplicate_rows, new_count, updated_count, unchanged_count, warning_count, created_at, confirmed_at, notes FROM customer_imports ORDER BY id DESC LIMIT ?'
  ).all(Math.min(Number(limit) || 50, 200));
}

export function getCustomerImport(db, id) {
  const batch = db.prepare('SELECT * FROM customer_imports WHERE id = ?').get(Number(id));
  if (!batch) return null;
  const preview = batch.preview_json ? toPreviewPayload(JSON.parse(batch.preview_json)) : null;
  const { preview_json: _omit, ...header } = batch;
  return { batch: header, preview };
}

export default { createCustomerPreview, confirmCustomerImport, listCustomerImports, getCustomerImport };
