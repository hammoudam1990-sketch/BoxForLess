// Staff API for the customer-shelf expiry workflow: the rep's visit screens (R01, R02) and the
// Sales Manager's discount approvals. Mounted behind requireStaff.
//
// Who the rep is comes from the SESSION for a sales rep — the request cannot name another rep. The
// Sales Manager and the administrator may look at any rep (?rep=), for supervision and testing. The
// server still shows each rep only the customers assigned to them.
// Rep screens: sales rep, Sales Manager, administrator. Approvals: Sales Manager and administrator only.
import express from 'express';
import { requireRole } from '../staff-auth.js';
import { listReps, myVisits, visitSheet, recordVisit, approvals, decideDiscount, recordCreditNote, shelfLotDiscounts, saveShelfLotDiscount } from '../../domain/shelf.js';
import { LotDiscountError } from '../../domain/lot-discounts.js';
import { todayString } from '../../domain/expiry-list.js';

const router = express.Router();
const rep = (req) => (req.staff?.role === 'SALES_REP' ? String(req.staff.repId ?? '') : String((req.method === 'GET' ? req.query.rep : req.body?.rep) ?? ''));
const repScreens = requireRole('ADMIN', 'SALES_MANAGER', 'SALES_REP');
const managersOnly = requireRole('ADMIN', 'SALES_MANAGER');

router.get('/reps', repScreens, (req, res, next) => {
  try {
    // a rep sees only themselves in the list
    const all = listReps(todayString(), req.db);
    res.json({ source: 'SAMPLE', reps: req.staff?.role === 'SALES_REP' ? all.filter((r) => r.id === req.staff.repId) : all });
  } catch (e) { next(e); }
});

router.get('/my-visits', repScreens, (req, res, next) => {
  try { res.json(myVisits(req.db, rep(req), { today: todayString(), q: req.query.q })); } catch (e) { next(e); }
});

router.get('/visit-sheet', repScreens, (req, res, next) => {
  try { res.json(visitSheet(req.db, rep(req), req.query.customer, { today: todayString() })); } catch (e) { next(e); }
});

router.post('/visits', repScreens, (req, res, next) => {
  try { res.status(201).json(recordVisit(req.db, rep(req), req.body?.customer, req.body?.lines, { today: todayString() })); } catch (e) { next(e); }
});

// The Sales Manager's discount on lots that sit on customers' shelves; the rep sees it on the shop visit.
router.get('/lot-discounts', managersOnly, (req, res, next) => {
  try { res.json(shelfLotDiscounts(req.db, { today: todayString() })); } catch (e) { next(e); }
});
router.put('/lot-discounts/:key', managersOnly, (req, res, next) => {
  try { res.json({ lot: saveShelfLotDiscount(req.db, req.params.key, req.body?.pct ?? null, req.staff?.name, { today: todayString() }) }); } catch (e) {
    if (e instanceof LotDiscountError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.get('/approvals', managersOnly, (req, res, next) => {
  try { res.json(approvals(req.db, { today: todayString() })); } catch (e) { next(e); }
});

router.post('/approvals/:id/decide', managersOnly, (req, res, next) => {
  try { res.json(decideDiscount(req.db, req.params.id, req.body || {})); } catch (e) { next(e); }
});

router.post('/approvals/:id/credit-note', managersOnly, (req, res, next) => {
  try { res.json(recordCreditNote(req.db, req.params.id, req.body?.ref)); } catch (e) { next(e); }
});

export default router;
