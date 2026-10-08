import express from 'express';
import multer from 'multer';
import { searchProducts, getProductDetail, productStats, exportProductsRows } from '../../domain/products.js';
import { saveProductImage, readPrimaryImage } from '../../domain/images.js';
import config from '../../config.js';

const router = express.Router();

// Images are held in memory, validated, then written to disk by the domain layer.
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxImageBytes + 1024 * 1024 }, // a bit above the domain cap for a clean error
});

router.get('/', (req, res, next) => {
  try {
    const { search, filter, stock, sort, limit, offset } = req.query;
    res.json(searchProducts(req.db, { search, filter, stock, sort, limit, offset }));
  } catch (e) { next(e); }
});

// ---- CSV export of the current filtered list. Read only; staff only (behind requireStaff).
const CSV_COLUMNS = [
  ['barcode', 'Barcode'], ['name', 'Product name'], ['box_uom', 'Pack'], ['is_active', 'Active'],
  ['on_hand', 'On hand (CTN)'], ['free_to_use', 'Free to use (CTN)'], ['incoming', 'Incoming'],
  ['outgoing', 'Outgoing'], ['forecasted', 'Forecasted'], ['stock_status', 'Stock status'],
  ['source_odoo_id', 'Odoo ID'],
];

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = "'" + text;          // defuse spreadsheet formulas
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

router.get('/export.csv', (req, res, next) => {
  try {
    const { search, filter, stock, sort } = req.query;
    const rows = exportProductsRows(req.db, { search, filter, stock, sort });
    const lines = [CSV_COLUMNS.map(([, heading]) => heading).join(',')];
    for (const p of rows) {
      lines.push(CSV_COLUMNS.map(([key]) => {
        const value = key === 'is_active' ? (p.is_active ? 'Yes' : 'No') : p[key];
        return csvCell(value);
      }).join(','));
    }
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="products-${stamp}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send('﻿' + lines.join('\r\n') + '\r\n');   // BOM so Excel reads the accents correctly
  } catch (e) { next(e); }
});

router.get('/stats', (req, res, next) => {
  try { res.json(productStats(req.db)); } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const detail = getProductDetail(req.db, Number(req.params.id));
    if (!detail) return res.status(404).json({ error: 'Product not found' });
    res.json(detail);
  } catch (e) { next(e); }
});

// Serve the current primary image (used for display + reload-after-save + refresh).
router.get('/:id/image', (req, res, next) => {
  try {
    const img = readPrimaryImage(req.db, Number(req.params.id));
    if (!img) return res.status(404).json({ error: 'No image' });
    res.set('Content-Type', img.contentType);
    res.set('Cache-Control', 'no-cache');
    res.send(img.buffer);
  } catch (e) { next(e); }
});

// Persist an image against the stable product identity (products.id).
// Pass ?replace=true (or form field replace=true) to confirm overwriting an
// existing image; otherwise an existing image returns 409 REPLACE_CONFIRM_REQUIRED.
router.post('/:id/image', imageUpload.single('image'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded (field name: image)' });
    const confirmReplace = req.query.replace === 'true' || req.body?.replace === 'true';
    const result = saveProductImage(req.db, Number(req.params.id), req.file.buffer, req.file.mimetype, { confirmReplace });
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

export default router;
