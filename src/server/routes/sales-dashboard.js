// Staff API for the Sales Manager's dashboard. Mounted behind requireStaff + requireRole(ADMIN, SALES_MANAGER):
// company-wide sales figures are for managers only (CLAUDE.md). Reads, plus two writes: a sales target (with its
// history) and the team-performance thresholds. The name on every change comes from the session.
// Where each figure comes from: domain/sales-dashboard.js.
import express from 'express';
import {
  salesDashboard, repDetail, ordersList, customersList, customerDetail, targetsOverview, setSalesTarget,
  getThresholds, setThresholds, salesSearch, salesNotifications, SalesDashboardError,
} from '../../domain/sales-dashboard.js';
import { targetHistory, ReportError } from '../../domain/reports.js';
import { todayString } from '../../domain/expiry-list.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof SalesDashboardError || e instanceof ReportError ? res.status(e.status).json({ error: e.message }) : next(e));
const period = (q) => ({ period: q.period, from: q.from, to: q.to });

// KPIs, the performance chart, sales by rep, team status, the reps table and recent orders (?period=&from=&to=)
router.get('/summary', (req, res, next) => {
  try { res.json(salesDashboard(req.db, period(req.query), todayString())); } catch (e) { fail(e, res, next); }
});
router.get('/reps/:id', (req, res, next) => {
  try { res.json(repDetail(req.db, req.params.id, period(req.query), todayString())); } catch (e) { fail(e, res, next); }
});
// ?period=&state=&rep=&search=&limit=&offset=
router.get('/orders', (req, res, next) => {
  try { res.json(ordersList(req.db, req.query, todayString())); } catch (e) { fail(e, res, next); }
});
// ?period=&search=&rep=&activity=&owing=&sort=&limit=&offset=
router.get('/customers', (req, res, next) => {
  try { res.json(customersList(req.db, req.query, todayString())); } catch (e) { fail(e, res, next); }
});
router.get('/customers/:id', (req, res, next) => {
  try { res.json(customerDetail(req.db, req.params.id, period(req.query), todayString())); } catch (e) { fail(e, res, next); }
});
// the team's and each rep's net-sales target for a month, with the month's sales and the reconciliation
router.get('/targets', (req, res, next) => {
  try { res.json(targetsOverview(req.db, req.query.month, todayString())); } catch (e) { fail(e, res, next); }
});
router.get('/targets/history', (req, res, next) => {
  try { res.json({ items: targetHistory(req.db, { limit: req.query.limit }) }); } catch (e) { fail(e, res, next); }
});
router.put('/targets', (req, res, next) => {
  try { res.json(setSalesTarget(req.db, req.body || {}, req.staff?.name || null)); } catch (e) { fail(e, res, next); }
});
router.get('/settings', (req, res, next) => {
  try { res.json(getThresholds(req.db)); } catch (e) { fail(e, res, next); }
});
router.put('/settings', (req, res, next) => {
  try { res.json(setThresholds(req.db, req.body || {}, req.staff?.name || null)); } catch (e) { fail(e, res, next); }
});
router.get('/search', (req, res, next) => {
  try { res.json(salesSearch(req.db, req.query.q)); } catch (e) { fail(e, res, next); }
});
router.get('/notifications', (req, res, next) => {
  try { res.json(salesNotifications(req.db, todayString())); } catch (e) { fail(e, res, next); }
});

export default router;
