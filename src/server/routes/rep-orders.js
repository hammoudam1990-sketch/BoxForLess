// A sales rep places orders for their own customers. Mounted behind requireStaff and requireRole('SALES_REP').
//
// The rep is the signed-in session's rep: the request cannot name another one. The customer named in a request is checked
// against that rep's own list on the server, every time (see domain/rep-orders.js).
import express from 'express';
import { repCustomers, productsFor, reviewOrder, placeRepOrder, repOrders, RepOrderError } from '../../domain/rep-orders.js';
import { RequestValidationError } from '../../domain/requests.js';

const router = express.Router();
const repOf = (req) => String(req.staff?.repId ?? '');
const fail = (e, res, next) => {
  if (e instanceof RepOrderError) return res.status(e.status).json({ error: e.message });
  if (e instanceof RequestValidationError) return res.status(e.status).json({ error: e.message, code: e.code, ...e.details });
  return next(e);
};

router.get('/customers', (req, res, next) => {
  try { res.json({ customers: repCustomers(req.db, repOf(req), req.query.q) }); } catch (e) { fail(e, res, next); }
});

router.get('/products', (req, res, next) => {
  try { res.json(productsFor(req.db, repOf(req), req.query.customer, { search: req.query.search, limit: req.query.limit, offset: req.query.offset })); } catch (e) { fail(e, res, next); }
});

router.post('/review', (req, res, next) => {
  try { res.json(reviewOrder(req.db, repOf(req), req.body || {})); } catch (e) { fail(e, res, next); }
});

router.post('/', (req, res, next) => {
  try { res.status(201).json(placeRepOrder(req.db, repOf(req), req.staff, req.body || {})); } catch (e) { fail(e, res, next); }
});

router.get('/mine', (req, res, next) => {
  try { res.json({ orders: repOrders(req.db, req.staff.id) }); } catch (e) { fail(e, res, next); }
});

export default router;
