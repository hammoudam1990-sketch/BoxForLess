// Staff API for product visibility rules (S02). Mounted behind requireStaff + requireRole(ADMIN,
// SALES_MANAGER). Rules only hide; removing one switches it off and logs it.
import express from 'express';
import {
  addRule, removeRule, listRules, listLog, preview, categoryChoices, VisibilityError,
} from '../../domain/visibility.js';
import { listPriceClasses } from '../../domain/prices.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof VisibilityError ? res.status(e.status).json({ error: e.message, code: e.code }) : next(e));

router.get('/', (req, res, next) => {
  try {
    res.json({
      rules: listRules(req.db),
      log: listLog(req.db),
      priceClasses: listPriceClasses().map((c) => c.name),
      categories: categoryChoices(req.db),
    });
  } catch (e) { next(e); }
});

router.post('/rules', (req, res, next) => {
  try { res.status(201).json({ rule: addRule(req.db, req.body || {}, req.staff?.name) }); } catch (e) { fail(e, res, next); }
});

router.post('/rules/:id/remove', (req, res, next) => {
  try { res.json({ rule: removeRule(req.db, req.params.id, req.staff?.name) }); } catch (e) { fail(e, res, next); }
});

// What would this customer (or a visitor) see? Uses the same filter the catalogue applies.
router.get('/preview', (req, res, next) => {
  try {
    const id = Number(req.query.customer);
    res.json(preview(req.db, Number.isInteger(id) && id > 0 ? { customerId: id } : null));
  } catch (e) { next(e); }
});

export default router;
