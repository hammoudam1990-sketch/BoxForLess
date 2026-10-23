// Staff API for the monthly reports (S06). The company-wide reports go to MANAGERS only:
//   CEO summary and Sales Manager report ... administrator, Sales Manager
//   Warehouse report ........................ administrator, Sales Manager, warehouse
// A sales rep gets only their own customers and figures (GET /my), taken from their login — never from the
// request. Nothing here is customer-facing, and no report holds a phone number, an address or a cost.
import express from 'express';
import {
  buildReport, sectionCsv, measuresCsv, setTarget, listTargets, getNotes, saveNotes, repMonth, isMonth, monthOf, shiftMonth,
  TARGET_MEASURES, REPORTS, ReportError,
} from '../../domain/reports.js';
import { todayString } from '../../domain/expiry-list.js';
import { listReps } from '../../domain/shelf.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof ReportError ? res.status(e.status).json({ error: e.message }) : next(e));

const WHO = { CEO: ['ADMIN', 'SALES_MANAGER'], SALES: ['ADMIN', 'SALES_MANAGER'], WAREHOUSE: ['ADMIN', 'SALES_MANAGER', 'WAREHOUSE'] };
const OWNERS = { CEO: ['ADMIN', 'SALES_MANAGER'], SALES: ['ADMIN', 'SALES_MANAGER'], WAREHOUSE: ['ADMIN', 'WAREHOUSE'] };
const allowed = (req, report, table = WHO) => (table[report] || []).includes(req.staff?.role);
const deny = (res) => res.status(403).json({ error: 'Your role does not include this report.', code: 'FORBIDDEN_ROLE' });
const monthParam = (q) => (isMonth(q) ? q : monthOf(todayString()));

// what the screen needs to start: which reports this person may open, and the months to choose from
router.get('/', (req, res, next) => {
  try {
    const today = todayString();
    const current = monthOf(today);
    const first = req.db.prepare('SELECT MIN(invoice_date) d FROM odoo_invoices').get().d;
    const months = [];
    for (let m = current; months.length < 26; m = shiftMonth(m, -1)) { months.push(m); if (first && m <= first.slice(0, 7) && months.length > 14) break; }
    res.json({
      today, current, months,
      reports: Object.entries(REPORTS).filter(([k]) => allowed(req, k)).map(([key, r]) => ({ key, ...r, canWriteNotes: allowed(req, key, OWNERS) })),
      canSetTargets: ['ADMIN', 'SALES_MANAGER'].includes(req.staff?.role),
    });
  } catch (e) { next(e); }
});

router.get('/report', (req, res, next) => {
  try {
    const which = String(req.query.report || '').toUpperCase();
    if (!REPORTS[which]) return res.status(404).json({ error: 'Unknown report.' });
    if (!allowed(req, which)) return deny(res);
    res.json(buildReport(req.db, which, monthParam(req.query.month), todayString()));
  } catch (e) { fail(e, res, next); }
});

router.get('/csv', (req, res, next) => {
  try {
    const which = String(req.query.report || '').toUpperCase();
    if (!REPORTS[which]) return res.status(404).json({ error: 'Unknown report.' });
    if (!allowed(req, which)) return deny(res);
    const month = monthParam(req.query.month);
    const report = buildReport(req.db, which, month, todayString());
    const id = String(req.query.section || '');
    let csv; let name;
    if (id === 'measures' && report.measures) { csv = measuresCsv(report.measures); name = 'measures'; } else {
      const sec = report.sections.find((s) => s.id === id);
      if (!sec) return res.status(404).json({ error: 'No such section.' });
      csv = sectionCsv(sec); name = sec.id;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${which.toLowerCase()}-${month}-${name}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(csv);
  } catch (e) { fail(e, res, next); }
});

// the owner writes the three lines (what happened, why, what we will do) before the report is sent
router.put('/notes', (req, res, next) => {
  try {
    const which = String(req.body?.report || '').toUpperCase();
    if (!REPORTS[which]) return res.status(404).json({ error: 'Unknown report.' });
    if (!allowed(req, which, OWNERS)) return deny(res);
    res.json(saveNotes(req.db, which, req.body?.month, req.body || {}, req.staff?.name));
  } catch (e) { fail(e, res, next); }
});
router.get('/notes', (req, res) => {
  const which = String(req.query.report || '').toUpperCase();
  if (!REPORTS[which]) return res.status(404).json({ error: 'Unknown report.' });
  if (!allowed(req, which)) return deny(res);
  res.json(getNotes(req.db, which, monthParam(req.query.month)));
});

// targets: entered by the Sales Manager. Without one, "vs target" is left blank.
router.get('/targets', (req, res, next) => {
  try {
    if (!['ADMIN', 'SALES_MANAGER'].includes(req.staff?.role)) return deny(res);
    res.json({ targets: listTargets(req.db), measures: TARGET_MEASURES, reps: listReps(todayString(), req.db).map((r) => r.name) });
  } catch (e) { next(e); }
});
router.put('/targets', (req, res, next) => {
  try {
    if (!['ADMIN', 'SALES_MANAGER'].includes(req.staff?.role)) return deny(res);
    res.json(setTarget(req.db, req.body || {}, req.staff?.name));
  } catch (e) { fail(e, res, next); }
});

// a sales rep's own month: their customers and their figures, nothing company-wide
router.get('/my', (req, res, next) => {
  try {
    if (req.staff?.role !== 'SALES_REP') return deny(res);
    const rep = listReps(todayString(), req.db).find((r) => r.id === req.staff.repId);
    if (!rep) return res.status(404).json({ error: 'No sales rep is linked to your account yet.' });
    res.json(repMonth(req.db, rep.name, monthParam(req.query.month), todayString()));
  } catch (e) { next(e); }
});

export default router;
