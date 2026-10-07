// Step 1-2: read an XLSX workbook into raw rows. No normalization here.
import xlsx from 'xlsx';
import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Read the first worksheet of an xlsx file.
 * @returns {{ headers: string[], rows: object[], fileHash: string }}
 *   rows: array of objects keyed by the ORIGINAL header text.
 * @throws Error with a human-readable message on workbook-level problems.
 */
export function readWorkbook(filePath) {
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    throw new Error(`Cannot read file: ${e.message}`);
  }
  const fileHash = crypto.createHash('sha256').update(buf).digest('hex');

  let wb;
  try {
    wb = xlsx.read(buf, { type: 'buffer', cellDates: false });
  } catch (e) {
    throw new Error(`File is not a readable Excel workbook: ${e.message}`);
  }
  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new Error('Workbook contains no sheets.');
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error('First worksheet is empty.');

  // header row (array of arrays, first row)
  const matrix = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
  if (matrix.length === 0) throw new Error('Worksheet has no rows.');
  const headers = (matrix[0] || []).map((h) => (h === null || h === undefined ? '' : String(h)));

  const rows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: true });
  return { headers, rows, fileHash };
}

export default readWorkbook;
