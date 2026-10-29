// Staff API for Payments due (S07). Mounted behind requireStaff + requireRole(ADMIN, SALES_MANAGER):
// the Sales Manager sets each credit customer's payment schedule and sees what is due, overdue and
// which reminders went out. The platform reminds; it does not collect.
import express from 'express';
import { paymentsOverview, setSchedule, runReminders, runUnsettled20dFollowUps, markReminderSent, PaymentError } from '../../domain/payments.js';
import { todayString } from '../../domain/expiry-list.js';

const router = express.Router();
const fail = (e, res, next) => (e instanceof PaymentError ? res.status(e.status).json({ error: e.message }) : next(e));

router.get('/', (req, res, next) => {
  try {
    const data = paymentsOverview(req.db, todayString());
    if (req.query.unsettled20d === 'true') {
      data.invoices = data.invoices.filter((i) => i.unsettled20d);
    }
    res.json(data);
  } catch (e) { next(e); }
});

// Look for reminders that are due now (the server also does this every hour).
router.post('/run', (req, res, next) => {
  try { res.json({ created: runReminders(req.db, todayString()).length }); } catch (e) { next(e); }
});

// Generate follow-up reminders specifically for credit customers with open invoices unsettled for 20+ days.
router.post('/follow-up-20d', (req, res, next) => {
  try { res.json({ created: runUnsettled20dFollowUps(req.db, todayString()).length }); } catch (e) { next(e); }
});

router.put('/customers/:id/schedule', (req, res, next) => {
  try { res.json(setSchedule(req.db, req.params.id, req.body || {}, req.staff?.name)); } catch (e) { fail(e, res, next); }
});

router.post('/reminders/:id/sent', (req, res, next) => {
  try { markReminderSent(req.db, req.params.id, req.staff?.name); res.json({ ok: true }); } catch (e) { fail(e, res, next); }
});

export default router;
