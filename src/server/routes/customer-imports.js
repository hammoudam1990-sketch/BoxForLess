// Customer-list import endpoints. STAFF-FACING ONLY — mounted under /api, never
// under /api/catalog, and it returns staff detail (email, phone, pricelist counts)
// that must never reach a customer.
//
// Separate from /api/imports so product import behaviour is provably unchanged.
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import {
  createCustomerPreview, confirmCustomerImport,
  listCustomerImports, getCustomerImport,
} from '../../import/customer-service.js';

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = express.Router();

// list previous customer imports (newest first)
router.get('/', (req, res, next) => {
  try { res.json({ items: listCustomerImports(req.db) }); } catch (e) { next(e); }
});

router.get('/:id', (req, res, next) => {
  try {
    const found = getCustomerImport(req.db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Customer import not found' });
    res.json(found);
  } catch (e) { next(e); }
});

// Upload + PREVIEW. Writes no customer row — it only records what an import would
// do, so uploading the file can never import the customers by itself.
router.post('/', upload.single('file'), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: file)' });
    res.json(createCustomerPreview(req.db, req.file.path, req.file.originalname));
  } catch (e) { next(e); }
});

// Apply a previewed batch — the explicit confirmation step.
router.post('/:id/confirm', (req, res, next) => {
  try {
    res.json(confirmCustomerImport(req.db, Number(req.params.id), {
      // absence does not mean deletion unless the operator says the file is the
      // complete customer book
      deactivateMissing: req.query.deactivate_missing === 'true',
    }));
  } catch (e) { next(e); }
});

export default router;
