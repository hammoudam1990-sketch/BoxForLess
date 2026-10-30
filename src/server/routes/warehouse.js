// Staff API for the Warehouse Manager's dashboard. Read-only. Mounted behind requireStaff and
// requireRole(ADMIN, WAREHOUSE, SALES_MANAGER read-only). See domain/warehouse.js for where every figure comes from.
import express from 'express';
import {
  dashboardSummary, inventoryPage, movementsPage, notifications, periodRange, WarehouseError,
} from '../../domain/warehouse.js';
import { todayString } from '../../domain/expiry-list.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof WarehouseError ? res.status(e.status).json({ error: e.message }) : next(e));

// KPIs, expiry groups, the latest movements and stock by category, for one period (?period=&from=&to=)
router.get('/summary', (req, res, next) => {
  try { res.json(dashboardSummary(req.db, { period: req.query.period, from: req.query.from, to: req.query.to }, todayString())); } catch (e) { fail(e, res, next); }
});

// ?search=&category=&location=&status=&sort=&dir=&limit=&offset=
router.get('/inventory', (req, res, next) => {
  try { res.json(inventoryPage(req.db, req.query, todayString())); } catch (e) { fail(e, res, next); }
});

// ?period=&from=&to=&type=&limit=&offset=
router.get('/movements', (req, res, next) => {
  try {
    const range = periodRange(req.query.period, { from: req.query.from, to: req.query.to }, todayString());
    res.json(movementsPage(req.db, range, { type: req.query.type, limit: req.query.limit, offset: req.query.offset }));
  } catch (e) { fail(e, res, next); }
});

router.get('/notifications', (req, res, next) => {
  try { res.json(notifications(req.db, todayString())); } catch (e) { next(e); }
});

export default router;
