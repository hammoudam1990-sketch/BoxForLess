import express from 'express';
import multer from 'multer';
import os from 'node:os';
import { createPreview, confirmImport } from '../../import/service.js';

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });
const router = express.Router();

// list batches (newest first)
router.get('/', (req, res, next) => {
  try {
    const rows = req.db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT 200').all();
    res.json({ items: rows });
  } catch (e) { next(e); }
});

// batch detail (+ cached preview payload)
router.get('/:id', (req, res, next) => {
  try {
    const b = req.db.prepare('SELECT * FROM import_batches WHERE id = ?').get(Number(req.params.id));
    if (!b) return res.status(404).json({ error: 'Batch not found' });
    const changes = req.db.prepare('SELECT * FROM import_changes WHERE import_batch_id = ? ORDER BY id DESC LIMIT 1000').all(b.id);
    res.json({ batch: b, preview: b.preview_json ? JSON.parse(b.preview_json) : null, changes });
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

export default router;
