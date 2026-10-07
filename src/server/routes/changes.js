import express from 'express';
import { listPendingReviews, reviewCounts, resolveBarcodeChange, resolveUomChange } from '../../domain/review.js';

const router = express.Router();

router.get('/', (req, res, next) => {
  try {
    res.json({ counts: reviewCounts(req.db), items: listPendingReviews(req.db) });
  } catch (e) { next(e); }
});

router.post('/barcode/:productId', (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '').toLowerCase();
    if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: "decision must be 'accept' or 'reject'" });
    res.json(resolveBarcodeChange(req.db, Number(req.params.productId), decision));
  } catch (e) { next(e); }
});

router.post('/uom/:productId', (req, res, next) => {
  try {
    const decision = String(req.body?.decision || '').toLowerCase();
    if (!['accept', 'reject'].includes(decision)) return res.status(400).json({ error: "decision must be 'accept' or 'reject'" });
    res.json(resolveUomChange(req.db, Number(req.params.productId), decision));
  } catch (e) { next(e); }
});

export default router;
