// Shared test utilities: in-memory DB + programmatic xlsx builders.
import xlsx from 'xlsx';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import openDatabase from '../src/db/connection.js';
import { createPreview, confirmImport } from '../src/import/service.js';

export const HEADERS = [
  'Barcode', 'Name', 'Box UoM',
  'On Hand (CTN, decimal)', 'Free To Use (CTN)', 'Incoming (CTN)',
  'Outgoing (CTN)', 'Forecasted (CTN, decimal)',
];

/** Fresh isolated in-memory database with schema applied. */
export function freshDb() {
  return openDatabase(':memory:');
}

/** A unique temp uploads dir for a test (keeps batch file copies isolated). */
export function tmpUploads() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-uploads-'));
}

/**
 * Build a source row object keyed by the real Odoo headers.
 * @param {object} o - { barcode, name, uom, on_hand, free, incoming, outgoing, forecasted, odooId }
 */
export function row(o = {}) {
  const r = {
    Barcode: o.barcode ?? null,
    Name: o.name ?? null,
    'Box UoM': o.uom ?? null,
    'On Hand (CTN, decimal)': o.on_hand ?? 0,
    'Free To Use (CTN)': o.free ?? 0,
    'Incoming (CTN)': o.incoming ?? 0,
    'Outgoing (CTN)': o.outgoing ?? 0,
    'Forecasted (CTN, decimal)': o.forecasted ?? 0,
  };
  if (o.odooId !== undefined) r.ID = o.odooId; // optional stable id column
  return r;
}

/** Write rows to a temp .xlsx file and return its path. */
export function writeXlsx(rows, headerOrder = null) {
  const ws = headerOrder
    ? xlsx.utils.json_to_sheet(rows, { header: headerOrder })
    : xlsx.utils.json_to_sheet(rows);
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-xlsx-'));
  const file = path.join(dir, 'import.xlsx');
  xlsx.writeFile(wb, file);
  return file;
}

/** Full preview+confirm cycle; returns { preview, result }. */
export function runImport(db, rows, { uploadsDir, faultHook } = {}) {
  const up = uploadsDir || tmpUploads();
  const file = writeXlsx(rows);
  const { batchId, preview } = createPreview(db, file, 'import.xlsx', { uploadsDir: up });
  const result = confirmImport(db, batchId, { faultHook });
  return { batchId, preview, result };
}

/** Preview only (no confirm). */
export function runPreview(db, rows, { uploadsDir } = {}) {
  const up = uploadsDir || tmpUploads();
  const file = writeXlsx(rows);
  return createPreview(db, file, 'import.xlsx', { uploadsDir: up });
}

export function getProduct(db, barcode) {
  return db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode);
}
export function getProductById(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').get(id);
}
