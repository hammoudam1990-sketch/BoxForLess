import express from 'express';
import multer from 'multer';
import os from 'node:os';
import { createPreview, confirmImport, deleteImportSourceFile } from '../../import/service.js';
import fs from 'node:fs';

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = express.Router();

// list batches (newest first)
router.get('/', (req, res, next) => {
  try {
    const rows = req.db.prepare(`SELECT id, filename, imported_at, completed_at, status,
        total_rows, created_count, updated_count, inactive_count, error_count,
        source_file_deleted_at, stored_path
      FROM import_batches ORDER BY id DESC LIMIT 200`).all();
    res.json({ items: rows.map(({ stored_path, ...row }) => ({
      ...row,
      has_source_file: !!stored_path && fs.existsSync(stored_path),
    })) });
  } catch (e) { next(e); }
});

// batch detail (+ cached preview payload)
router.get('/:id', (req, res, next) => {
  try {
    const b = req.db.prepare(`SELECT id, filename, file_hash, imported_at, confirmed_at, completed_at,
        total_rows, valid_rows, invalid_rows, created_count, updated_count, unchanged_count,
        inactive_count, reactivated_count, barcode_change_count, uom_change_count,
        warning_count, error_count, status, preview_json, notes, source_file_deleted_at, stored_path
      FROM import_batches WHERE id = ?`).get(Number(req.params.id));
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    const changes = req.db.prepare('SELECT * FROM import_changes WHERE import_batch_id = ? ORDER BY id DESC LIMIT 1000').all(b.id);
    const { stored_path, ...batch } = b;
    res.json({
      batch: { ...batch, has_source_file: !!stored_path && fs.existsSync(stored_path) },
      preview: b.preview_json ? JSON.parse(b.preview_json) : null,
      changes,
    });
  } catch (e) { next(e); }
});

// upload + preview (no DB product writes)
router.post('/', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
    const result = createPreview(req.db, req.file.path, req.file.originalname);
    res.json(result);
  } catch (e) { next(e); }
});

// confirm an existing preview
router.post('/:id/confirm', (req, res, next) => {
  try {
    const result = confirmImport(req.db, Number(req.params.id));
    res.json(result);
  } catch (e) { next(e); }
});

router.delete('/:id/source-file', (req, res, next) => {
  try {
    res.json(deleteImportSourceFile(req.db, req.params.id));
  } catch (e) { next(e); }
});

export default router;
