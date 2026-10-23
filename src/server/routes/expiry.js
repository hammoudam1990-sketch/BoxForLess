// Staff API for the Expiry list (S03). Mounted behind requireStaff — a signed-in staff member only.
// Value at risk is a staff figure (selling price) and must never be sent to a customer-facing route.
import express from 'express';
import { buildExpiryList, parseFilters, saveLotDecision, saveLotClearanceDiscount, expiryCsv } from '../../domain/expiry-list.js';
import { LotDiscountError } from '../../domain/lot-discounts.js';
import { requireRole } from '../staff-auth.js';
import { searchCustomersForShelfLife, setMinShelfLifeDays } from '../../domain/shelf-life.js';

const router = express.Router();

router.get('/', (req, res, next) => {
  try { res.json(buildExpiryList(req.db, { filters: parseFilters(req.query) })); } catch (e) { next(e); }
});

router.get('/export.csv', (req, res, next) => {
  try {
    const { rows, asOf } = buildExpiryList(req.db, { filters: parseFilters(req.query) });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="expiry-list-${asOf}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(expiryCsv(rows));
  } catch (e) { next(e); }
});

// Record (part of) the decision for one lot: { action, owner, decideBy, status }.
router.patch('/lots/:key', (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const input = {};
    for (const field of ['action', 'owner', 'decideBy', 'status']) if (field in body) input[field] = body[field];
    res.json({ row: saveLotDecision(req.db, req.params.key, input) });
  } catch (e) { next(e); }
});

// The Sales Manager's discount on a lot, offered to customers in their catalogue: { pct } (null switches it off).
// Only the Sales Manager (or the administrator) sets it; the warehouse sees it but cannot change it.
router.put('/lots/:key/discount', requireRole('ADMIN', 'SALES_MANAGER'), (req, res, next) => {
  try {
    res.json({ row: saveLotClearanceDiscount(req.db, req.params.key, req.body?.pct ?? null, req.staff?.name) });
  } catch (e) {
    if (e instanceof LotDiscountError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Customer minimum shelf life (W3). A stand-in for the Odoo field, until the sync exists.
router.get('/customers', (req, res, next) => {
  try { res.json({ customers: searchCustomersForShelfLife(req.db, req.query.q) }); } catch (e) { next(e); }
});
router.put('/customers/:id/min-shelf-life', (req, res, next) => {
  try { res.json(setMinShelfLifeDays(req.db, req.params.id, req.body?.days)); } catch (e) { next(e); }
});

export default router;
