// Steps 4-8: normalize, validate, match, diff, and build a deterministic import
// PLAN. This module performs NO database writes — it only reads existing
// products so the same function can power both preview and commit.
import { readWorkbook } from './reader.js';
import { mapHeaders, projectRow } from './headers.js';
import { normalizeRecord } from '../domain/normalize.js';
import { validateRecord } from './validate.js';
import { STOCK_FIELDS } from '../domain/constants.js';

/** Load existing products into lookup maps (by source_odoo_id and barcode). */
function loadExisting(db) {
  const rows = db.prepare('SELECT * FROM products').all();
  const byOdoo = new Map();
  const byBarcode = new Map();
  for (const r of rows) {
    if (r.source_odoo_id != null) byOdoo.set(String(r.source_odoo_id), r);
    if (r.barcode != null) byBarcode.set(String(r.barcode), r);
  }
  return { rows, byOdoo, byBarcode };
}

/** Match precedence: source_odoo_id (if present on both) > barcode. */
function matchExisting(record, existing) {
  if (record.source_odoo_id && existing.byOdoo.has(record.source_odoo_id)) {
    return { product: existing.byOdoo.get(record.source_odoo_id), matchedBy: 'source_odoo_id' };
  }
  if (record.barcode && existing.byBarcode.has(record.barcode)) {
    return { product: existing.byBarcode.get(record.barcode), matchedBy: 'barcode' };
  }
  return { product: null, matchedBy: null };
}

function emptySummary() {
  return {
    total_rows: 0, valid_rows: 0, invalid_rows: 0,
    created: 0, updated: 0, unchanged: 0,
    inactivated: 0, reactivated: 0,
    barcode_changes: 0, uom_changes: 0, category_changes: 0,
    warnings: 0, errors: 0, duplicate_barcodes: 0,
  };
}

/**
 * Build an import plan from a workbook file against the current DB state.
 * @returns a plan object (see README/IMPORT_RULES).
 */
export function buildPlan(db, filePath, filename) {
  const plan = {
    ok: true, fatal: null, filename: filename || filePath, fileHash: null,
    headerMapping: {}, unexpectedColumns: [], missingColumns: [], duplicateTargetColumns: [],
    summary: emptySummary(),
    operations: [], inactivations: [], categoryChanges: [],
    reviewItems: { barcodeChanges: [], uomChanges: [] },
    errorRows: [], warningRows: [],
  };

  let wb;
  try {
    wb = readWorkbook(filePath);
  } catch (e) {
    plan.ok = false;
    plan.fatal = e.message;
    return plan;
  }
  plan.fileHash = wb.fileHash;

  const { mapping, unexpected, missingRequired, duplicateTargets } = mapHeaders(wb.headers);
  plan.headerMapping = Object.fromEntries(Object.entries(mapping).map(([f, m]) => [f, m.header]));
  plan.unexpectedColumns = unexpected;      // reported, never fatal
  plan.missingColumns = missingRequired;
  plan.duplicateTargetColumns = duplicateTargets;

  if (missingRequired.length > 0) {
    plan.ok = false;
    plan.fatal = `Missing required column(s): ${missingRequired.join(', ')}`;
    return plan;
  }

  // Pre-scan barcodes and source ids for in-file duplicates.
  const barcodeRows = new Map(); // barcode -> [rowNumber,...]
  const odooIdRows = new Map();  // source_odoo_id -> [rowNumber,...]
  const normalizedRows = wb.rows.map((raw, i) => {
    const projected = projectRow(raw, mapping);
    const { record, stockErrors } = normalizeRecord(projected);
    const rowNumber = i + 1; // 1-based data row
    if (record.barcode) {
      if (!barcodeRows.has(record.barcode)) barcodeRows.set(record.barcode, []);
      barcodeRows.get(record.barcode).push(rowNumber);
    }
    if (record.source_odoo_id) {
      if (!odooIdRows.has(record.source_odoo_id)) odooIdRows.set(record.source_odoo_id, []);
      odooIdRows.get(record.source_odoo_id).push(rowNumber);
    }
    return { rowNumber, record, stockErrors };
  });
  const dupBarcodes = new Set(
    [...barcodeRows.entries()].filter(([, rr]) => rr.length > 1).map(([bc]) => bc)
  );
  const dupOdooIds = new Set(
    [...odooIdRows.entries()].filter(([, rr]) => rr.length > 1).map(([id]) => id)
  );
  plan.summary.duplicate_barcodes = dupBarcodes.size;

  const existing = loadExisting(db);
  const seenExistingIds = new Set(); // every existing product referenced by any row (for inactivation)
  const s = plan.summary;
  s.total_rows = normalizedRows.length;

  for (const { rowNumber, record, stockErrors } of normalizedRows) {
    const { errors, warnings } = validateRecord(record, stockErrors);
    if (record.barcode && dupBarcodes.has(record.barcode)) {
      errors.push(`Duplicate barcode in file (rows ${barcodeRows.get(record.barcode).join(', ')})`);
    }
    if (record.source_odoo_id && dupOdooIds.has(record.source_odoo_id)) {
      errors.push(`Duplicate source Odoo ID in file (rows ${odooIdRows.get(record.source_odoo_id).join(', ')})`);
    }

    const { product, matchedBy } = matchExisting(record, existing);
    if (product) seenExistingIds.add(product.id);

    if (errors.length > 0) {
      s.invalid_rows += 1;
      s.errors += 1;
      plan.errorRows.push({ rowNumber, barcode: record.barcode, errors });
      plan.operations.push({ rowNumber, barcode: record.barcode, record, action: 'ERROR', matchedBy, productId: product?.id ?? null, errors, warnings, changes: [], reviewChanges: [] });
      continue;
    }

    s.valid_rows += 1;
    if (warnings.length > 0) {
      s.warnings += 1;
      plan.warningRows.push({ rowNumber, barcode: record.barcode, warnings });
    }

    if (!product) {
      s.created += 1;
      plan.operations.push({ rowNumber, barcode: record.barcode, record, action: 'CREATE', matchedBy: null, productId: null, changes: [], reviewChanges: [], warnings });
      continue;
    }

    // existing match -> diff
    const changes = [];       // Odoo-controlled fields that will be updated
    const reviewChanges = []; // barcode / uom -> flagged, NOT applied
    let reactivate = false;

    if (product.name !== record.name) changes.push({ field: 'name', old: product.name, new: record.name });

    // Identity backfill: a product matched by BARCODE that has no stable Odoo id
    // yet adopts the one this export carries. This is additive — it only ever
    // fills a NULL, never rewrites an existing id — and it is what makes future
    // barcode-change detection possible (that check requires a stable-id match).
    if (matchedBy === 'barcode' && record.source_odoo_id && product.source_odoo_id == null) {
      changes.push({ field: 'source_odoo_id', old: null, new: record.source_odoo_id });
    }

    // Category: Odoo-controlled since Stage 2.1, so it is APPLIED rather than
    // review-gated — but logged as its own change type so history is never
    // silently overwritten. A row with no category value leaves the stored
    // category alone (absent column = no information, not "clear it").
    if (record.category_path != null && product.odoo_category_path !== record.category_path) {
      changes.push({
        field: 'odoo_category_path', old: product.odoo_category_path, new: record.category_path,
        isCategory: true,
      });
      s.category_changes += 1;
      plan.categoryChanges.push({
        productId: product.id, barcode: product.barcode, name: product.name,
        old: product.odoo_category_path, new: record.category_path, rowNumber,
      });
    }
    for (const f of STOCK_FIELDS) {
      if (Number(product[f]) !== Number(record[f])) {
        changes.push({ field: f, old: product[f], new: record[f] });
      }
    }

    // UoM change -> review (idempotent: skip if already pending for same value)
    if (record.box_uom != null && product.box_uom !== record.box_uom) {
      const alreadyPending = product.uom_change_pending === 1 && product.pending_uom === record.box_uom;
      if (!alreadyPending) {
        reviewChanges.push({ field: 'box_uom', old: product.box_uom, new: record.box_uom });
        s.uom_changes += 1;
        plan.reviewItems.uomChanges.push({ productId: product.id, barcode: product.barcode, name: product.name, old: product.box_uom, new: record.box_uom, rowNumber });
      }
    }

    // Barcode change -> only detectable when matched by a stable odoo id.
    if (matchedBy === 'source_odoo_id' && record.barcode != null && product.barcode !== record.barcode) {
      const alreadyPending = product.barcode_change_pending === 1 && product.pending_barcode === record.barcode;
      if (!alreadyPending) {
        reviewChanges.push({ field: 'barcode', old: product.barcode, new: record.barcode });
        s.barcode_changes += 1;
        plan.reviewItems.barcodeChanges.push({ productId: product.id, barcode: product.barcode, name: product.name, old: product.barcode, new: record.barcode, rowNumber });
      }
    }

    if (product.is_active === 0) { reactivate = true; s.reactivated += 1; }

    if (changes.length === 0 && reviewChanges.length === 0 && !reactivate) {
      s.unchanged += 1;
      plan.operations.push({ rowNumber, barcode: record.barcode, record, action: 'UNCHANGED', matchedBy, productId: product.id, changes: [], reviewChanges: [], warnings });
    } else {
      s.updated += 1;
      plan.operations.push({ rowNumber, barcode: record.barcode, record, action: 'UPDATE', matchedBy, productId: product.id, changes, reviewChanges, reactivate, warnings });
    }
  }

  // Inactivation: existing, active, import-sourced products not seen in this file.
  for (const p of existing.rows) {
    if (p.is_active === 1 && p.last_import_id != null && !seenExistingIds.has(p.id)) {
      plan.inactivations.push({ productId: p.id, barcode: p.barcode, name: p.name });
    }
  }
  s.inactivated = plan.inactivations.length;

  return plan;
}

export default buildPlan;
