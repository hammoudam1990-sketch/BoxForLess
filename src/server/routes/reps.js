// Which customers belong to which sales rep. Mounted behind requireStaff and requireRole(ADMIN,
// SALES_MANAGER). Until Odoo is connected this is where it is set; afterwards the salesperson comes from Odoo.
import express from 'express';
import { assignments, assignCustomer, RepError } from '../../domain/reps.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof RepError ? res.status(e.status).json({ error: e.message }) : next(e));

router.get('/', (req, res, next) => {
  try { res.json({ ...assignments(req.db), odooConnected: process.env.BFL_ODOO_CONNECTED === '1' }); } catch (e) { next(e); }
});

router.post('/assign', (req, res, next) => {
  try { res.json(assignCustomer(req.db, { kind: req.body?.kind, id: req.body?.id, repId: req.body?.repId || null }, req.staff?.name)); } catch (e) { fail(e, res, next); }
});

export default router;
