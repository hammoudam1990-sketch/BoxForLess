// Step 3: map source headers to canonical fields; report unexpected/missing.
import { COLUMN_ALIASES, REQUIRED_COLUMNS } from '../domain/constants.js';
import { headerKey } from '../domain/normalize.js';

// Precompute alias key -> canonical field.
const ALIAS_TO_FIELD = (() => {
  const m = new Map();
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    m.set(headerKey(field), field);
    for (const a of aliases) m.set(headerKey(a), field);
  }
  return m;
})();

/**
 * @param {string[]} headers - original header strings
 * @returns {{
 *   mapping: Object<canonicalField, {header:string, index:number}>,
 *   unexpected: string[],      // headers that mapped to nothing
 *   missingRequired: string[], // required canonical fields with no column
 *   duplicateTargets: string[] // two headers mapping to the same field
 * }}
 */
export function mapHeaders(headers) {
  const mapping = {};
  const unexpected = [];
  const duplicateTargets = [];

  headers.forEach((h, index) => {
    const key = headerKey(h);
    if (key === '') return; // blank column header
    const field = ALIAS_TO_FIELD.get(key);
    if (!field) {
      unexpected.push(h);
      return;
    }
    if (mapping[field]) {
      duplicateTargets.push(h); // second header hitting an already-mapped field
      return;
    }
    mapping[field] = { header: h, index };
  });

  const missingRequired = REQUIRED_COLUMNS.filter((f) => !mapping[f]);
  return { mapping, unexpected, missingRequired, duplicateTargets };
}

/** Project a raw row (keyed by original header) into a raw record keyed by canonical field. */
export function projectRow(rawRow, mapping) {
  const out = {};
  for (const [field, { header }] of Object.entries(mapping)) {
    out[field] = rawRow[header];
  }
  return out;
}

export default mapHeaders;
