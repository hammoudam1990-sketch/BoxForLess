// Staff API for Returns to classify (S04). The warehouse records the REASON for every return Odoo
// received (damaged, expired or other); a Sales Manager can read the list and the flagged broken
// agreements. Returns themselves are handled in Odoo — nothing here writes to Odoo.
import express from 'express';
import { listReturns, classifyReturn, overdueUnclassified, ReturnError } from '../../domain/returns.js';
import { requireRole } from '../staff-auth.js';
import { todayString } from '../../domain/expiry-list.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof ReturnError ? res.status(e.status).json({ error: e.message }) : next(e));

router.get('/', (req, res, next) => {
  try { res.json(listReturns(req.db, todayString())); } catch (e) { next(e); }
});

// for the menu badge: how many returns have waited too long for a reason
router.get('/alert', (req, res, next) => {
  try { res.json({ overdue: overdueUnclassified(req.db, todayString()) }); } catch (e) { next(e); }
});

router.post('/:id/classify', requireRole('ADMIN', 'WAREHOUSE'), (req, res, next) => {
  try { res.json(classifyReturn(req.db, req.params.id, req.body || {}, req.staff?.name)); } catch (e) { fail(e, res, next); }
});

export default router;
