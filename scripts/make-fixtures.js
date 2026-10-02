// Build a test fixture from the supplied Odoo export WITHOUT modifying the
// original file. Reads the source (read-only) and writes a NEW subset workbook
// into fixtures/. Run: node scripts/make-fixtures.js "<source.xlsx>"
import xlsx from 'xlsx';
import path from 'node:path';
import fs from 'node:fs';
import config from '../src/config.js';

const SOURCE = process.argv[2]
  || 'C:/Users/lenovo/Downloads/Product Variant (product.product) (1).xlsx';
const OUT = path.join(config.root, 'fixtures', 'sample-products.xlsx');
const N = Number(process.argv[3] || 50);

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`Source not found: ${SOURCE}`);
    process.exit(1);
  }
  const wb = xlsx.readFile(SOURCE);          // read-only
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null, raw: true });
  const subset = rows.slice(0, N);

  const outWs = xlsx.utils.json_to_sheet(subset);
  const outWb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(outWb, outWs, 'Sheet1');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  xlsx.writeFile(outWb, OUT);
  console.log(`Wrote fixture: ${OUT} (${subset.length} rows from ${rows.length})`);
}

main();
