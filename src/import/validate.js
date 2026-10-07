// Step 5: validate a normalized record. Pure, no DB.
import { STOCK_FIELDS } from '../domain/constants.js';

/**
 * Validate one normalized record.
 * @param {object} record - normalized record (from normalizeRecord)
 * @param {string[]} stockErrors - fields that were non-numeric (from normalizeRecord)
 * @returns {{ errors: string[], warnings: string[] }}
 *   errors  -> row is INVALID and will not be created/updated.
 *   warnings-> row is valid but flagged with data_quality_status = WARNING.
 */
export function validateRecord(record, stockErrors = []) {
  const errors = [];
  const warnings = [];

  // --- required identity / fields (hard errors) ---
  if (!record.barcode) errors.push('Missing barcode');
  if (!record.name) errors.push('Missing product name');
  if (!record.box_uom) errors.push('Missing Box UoM');

  // --- non-numeric stock (hard error: do not silently repair) ---
  for (const f of stockErrors) errors.push(`Non-numeric value in "${f}"`);

  // --- data-quality warnings (non-blocking) ---
  for (const f of STOCK_FIELDS) {
    const v = record[f];
    if (typeof v === 'number' && v < 0) warnings.push(`Negative ${f} (${v})`);
  }
  if (record.barcode) {
    if (/[^A-Za-z0-9]/.test(record.barcode)) {
      warnings.push('Barcode contains unusual characters');
    } else if (record.barcode.length < 4) {
      warnings.push('Barcode is unusually short');
    }
  }

  return { errors, warnings };
}

export default validateRecord;
