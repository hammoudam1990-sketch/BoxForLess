// Deterministic value normalization. No I/O, pure functions — easy to test.
import { STOCK_FIELDS } from './constants.js';
import { normalizeCategoryPath } from './categories.js';

/** Normalize a header string to a comparison key: lowercase, alphanumerics only. */
export function headerKey(h) {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Trim a text value; empty/whitespace-only becomes null. */
export function normText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Barcode is stored as text (preserves leading zeros, long EANs, letters). */
export function normBarcode(v) {
  const s = normText(v);
  if (s === null) return null;
  // Excel sometimes yields a float for a pure-numeric barcode (e.g. 108361 -> 108361).
  // If it is an integer-valued number, render without exponent/decimal noise.
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return s;
}

/**
 * Parse a stock cell.
 * @returns {{ value: number|null, ok: boolean }}
 *   ok=false means the cell had a non-empty, non-numeric value (a hard error).
 *   An empty cell is treated as 0 with ok=true.
 */
export function parseStock(v) {
  if (v === null || v === undefined || String(v).trim() === '') {
    return { value: 0, ok: true };
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) ? { value: v, ok: true } : { value: null, ok: false };
  }
  // strings: allow thousands separators and surrounding spaces
  const cleaned = String(v).trim().replace(/,/g, '');
  const n = Number(cleaned);
  if (cleaned !== '' && Number.isFinite(n)) return { value: n, ok: true };
  return { value: null, ok: false };
}

/**
 * Normalize one raw source row (object keyed by canonical field) into a typed record.
 * Returns { record, stockErrors } — stockErrors lists fields that were non-numeric.
 */
export function normalizeRecord(raw) {
  const record = {
    source_odoo_id: normText(raw.source_odoo_id),
    barcode: normBarcode(raw.barcode),
    name: normText(raw.name),
    box_uom: normText(raw.box_uom),
    // null when the export carries no category column at all — which must mean
    // "no information", never "clear the category".
    category_path: normalizeCategoryPath(raw.category_path),
  };
  const stockErrors = [];
  for (const f of STOCK_FIELDS) {
    const { value, ok } = parseStock(raw[f]);
    record[f] = ok ? value : null;
    if (!ok) stockErrors.push(f);
  }
  return { record, stockErrors };
}
