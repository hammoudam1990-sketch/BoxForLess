// Read-only API for the Sales Manager dashboard. Mounted behind requireSales, so it is
// reachable only with a sales-manager session. It returns counts of requests, lines and
// cartons — never a price or amount (Phase 1).
import express from 'express';
import { salesOverview } from '../../domain/sales-overview.js';

const router = express.Router();

router.get('/overview', (req, res, next) => {
  try { res.json(salesOverview(req.db, { days: Number(req.query.days) || 30 })); } catch (e) { next(e); }
});

export default router;
