// Full data-quality report over the current database.
//   node scripts/data-quality-report.js
import fs from 'node:fs';
import path from 'node:path';
import openDatabase from '../src/db/connection.js';
import { productStats } from '../src/domain/products.js';
import { computeStockStatus } from '../src/domain/stock.js';
import config from '../src/config.js';

function main() {
  const db = openDatabase(config.dbPath);
  const stats = productStats(db);

  const stockBuckets = { IN_STOCK: 0, LIMITED_STOCK: 0, OUT_OF_STOCK: 0 };
  for (const p of db.prepare('SELECT free_to_use, is_active FROM products WHERE is_active=1').all()) {
    stockBuckets[computeStockStatus(p)] += 1;
  }

  const barcodeLen = db.prepare(
    'SELECT LENGTH(barcode) AS len, COUNT(*) AS n FROM products GROUP BY LENGTH(barcode) ORDER BY len'
  ).all();
  const uomCount = db.prepare('SELECT COUNT(DISTINCT box_uom) AS n FROM products').get().n;
  const batches = db.prepare('SELECT COUNT(*) AS n, SUM(CASE WHEN status=\'COMPLETED\' THEN 1 ELSE 0 END) AS completed FROM import_batches').get();
  const changeTypes = db.prepare('SELECT change_type, COUNT(*) AS n FROM import_changes GROUP BY change_type ORDER BY n DESC').all();
  const pendingBarcode = db.prepare("SELECT id, barcode, name, pending_barcode FROM products WHERE barcode_change_pending=1").all();
  const pendingUom = db.prepare("SELECT id, barcode, name, box_uom, pending_uom FROM products WHERE uom_change_pending=1").all();

  const report = {
    generated_at: new Date().toISOString(),
    database: config.dbPath,
    products: stats,
    stock_status_active: stockBuckets,
    distinct_uom: uomCount,
    barcode_length_distribution: barcodeLen,
    import_batches: batches,
    change_log_by_type: changeTypes,
    pending_barcode_reviews: pendingBarcode,
    pending_uom_reviews: pendingUom,
  };

  console.log('\n================ DATA QUALITY REPORT ================');
  console.log(`Generated: ${report.generated_at}`);
  console.log(`Database:  ${report.database}\n`);
  console.log('Products:'); console.table(stats);
  console.log('Active stock status:'); console.table(stockBuckets);
  console.log(`Distinct UoM values: ${uomCount}`);
  console.log('Import batches:'); console.table(batches);
  console.log('Change log by type:'); console.table(changeTypes);
  console.log(`Pending barcode reviews: ${pendingBarcode.length}`);
  console.log(`Pending UoM reviews: ${pendingUom.length}`);

  const outDir = path.join(config.root, '..', 'data');
  const outPath = path.join(config.root, 'data', 'data-quality-report.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nSaved: ${outPath}`);
  db.close();
}

main();
