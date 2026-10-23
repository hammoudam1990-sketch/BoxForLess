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
 * @returns {{source:'SAMPLE', lots:object[]}}
 */
export function loadLots(today) {
  const t = toDay(today);
  if (t === null) throw new RangeError('today must be a date');
  const { lots } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  return {
    source: 'SAMPLE',
    lots: lots.map((l) => ({
      productName: l.productName,
      barcode: l.barcode,
      lotName: l.lotName,
      expiryDate: l.expiresInDays === null ? null : formatDay(t + l.expiresInDays),
      receivedDate: formatDay(t - l.receivedDaysAgo),
      cartons: l.cartons,
      location: l.location,
      categoryPath: l.categoryPath,
      pricePerCarton: l.pricePerCarton,
    })),
  };
}
