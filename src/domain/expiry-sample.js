// SAMPLE lots, so the Expiry list can be built and tried before the Odoo sync exists.
//
// The fixture's dates are RELATIVE (days from today), so the list always shows a spread of
// bands whatever day it is opened. This is a stand-in: when the Odoo lot sync (stock.lot and
// stock.quant) lands, `loadLots` is the one function that changes, and nothing downstream
// does. Every response built from it says `source: 'SAMPLE'`, and the screen says so too.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { toDay, formatDay, ShelfLife, withSettings } from './expiry.js';

const FIXTURE = path.join(config.root, 'fixtures', 'expiry-sample.json');

/** Category rules for the sample (which categories are short-shelf-life is open decision W-1). */
export function sampleSettings() {
  return withSettings({
    categories: {
      'FOOD / DAIRY': { type: ShelfLife.SHORT, usualShelfLifeDays: 120 },
      'DRINKS & BEVERAGES / JUICE': { type: ShelfLife.SHORT, usualShelfLifeDays: 180 },
    },
  });
}

/**
 * The lots as the Expiry list wants them.
 * @param {string} today 'YYYY-MM-DD'
 * @param {object} [db]
 * @returns {{source:'SAMPLE', lots:object[]}}
 */
export function loadLots(today, db = null) {
  const t = toDay(today);
  if (t === null) throw new RangeError('today must be a date');
  const { lots } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const mapped = lots.map((l) => ({
    productName: l.productName,
    barcode: l.barcode,
    lotName: l.lotName,
    expiryDate: l.expiresInDays === null ? null : formatDay(t + l.expiresInDays),
    receivedDate: formatDay(t - l.receivedDaysAgo),
    cartons: l.cartons,
    location: l.location,
    stockHolder: 'WAREHOUSE',
    shopName: null,
    categoryPath: l.categoryPath,
    pricePerCarton: l.pricePerCarton,
  }));
  if (db) {
    try {
      const prodCount = db.prepare('SELECT COUNT(*) AS n FROM products WHERE is_active = 1').get()?.n || 0;
      if (prodCount > 20) {
        const seenKeys = new Set(mapped.map((l) => `${l.barcode}|${l.lotName}`));
        const existingBarcodes = new Set(mapped.map((l) => l.barcode));

        const delivLots = db.prepare(`
          SELECT l.lot_code, l.delivered_ctn, l.expiry_date, l.delivered_at,
                 cust.name AS shop_name,
                 p.barcode, p.name, COALESCE(p.odoo_category_path, c.path, 'FOOD / CANNED FOOD') AS category_path
            FROM delivery_lots l
            JOIN products p ON p.id = l.product_id
            LEFT JOIN customers cust ON cust.id = l.customer_id
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.is_active = 1
        `).all();
        for (const dl of delivLots) {
          const k = `${dl.barcode}|${dl.lot_code}`;
          if (seenKeys.has(k)) continue;
          seenKeys.add(k);
          existingBarcodes.add(dl.barcode);
          mapped.push({
            productName: dl.name,
            barcode: dl.barcode,
            lotName: dl.lot_code,
            expiryDate: dl.expiry_date,
            receivedDate: String(dl.delivered_at || '').slice(0, 10) || formatDay(t - 45),
            cartons: Math.max(Number(dl.delivered_ctn) || 10, 10),
            location: 'SHOP',
            stockHolder: 'SHOP',
            shopName: dl.shop_name || 'Customer Shop',
            categoryPath: dl.category_path,
            pricePerCarton: 120,
          });
        }

        const extraProds = db.prepare(`
          SELECT p.barcode, p.name, p.free_to_use, COALESCE(p.odoo_category_path, c.path, 'FOOD / CANNED FOOD') AS category_path
            FROM products p
            LEFT JOIN categories c ON c.id = p.category_id
           WHERE p.is_active = 1 AND p.free_to_use >= 1
           ORDER BY (p.primary_image_id IS NOT NULL) DESC, p.id DESC
        `).all();
        let idx = 101;
        for (const p of extraProds) {
          if (existingBarcodes.has(p.barcode)) continue;
          existingBarcodes.add(p.barcode);
          const daysOut = 18 + (idx % 60);
          mapped.push({
            productName: p.name,
            barcode: p.barcode,
            lotName: `LOT-${idx}`,
            expiryDate: formatDay(t + daysOut),
            receivedDate: formatDay(t - 90),
            cartons: Math.min(Math.max(10, Math.floor(Number(p.free_to_use) || 20)), 60),
            location: 'MAIN',
            stockHolder: 'WAREHOUSE',
            shopName: null,
            categoryPath: p.category_path,
            pricePerCarton: 120,
          });
          idx += 1;
        }
      }
    } catch { /* ignore in unit tests */ }
  }
  return {
    source: 'SAMPLE',
    lots: mapped,
  };
}
