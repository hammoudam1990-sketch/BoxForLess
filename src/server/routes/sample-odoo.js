// Staff API for the "Sample Odoo" screen — the stand-in for Odoo's side of an order until the real
// connection exists. Mounted behind requireStaff, and switched off entirely (404) once
// BFL_ODOO_CONNECTED=1, so it can never act beside the real thing. See domain/sample-odoo.js.
import express from 'express';
import {
  sampleOdooEnabled, overview, STEP_ACTIONS, ageInvoice, setCreditLimit, SampleOdooError, returnOptions, createReturn, issueReturnCreditNote,
} from '../../domain/sample-odoo.js';
import { seedHistory, historyLoaded } from '../../domain/sample-history.js';
import { todayString } from '../../domain/expiry-list.js';
import { listPending, outboxSummary } from '../../domain/outbox.js';

const router = express.Router();

router.use((_req, res, next) => (sampleOdooEnabled() ? next() : res.status(404).json({ error: 'Not found' })));

router.get('/', (req, res, next) => {
  try {
    res.json({
      source: 'SAMPLE',
      ...overview(req.db),
      outbox: { summary: outboxSummary(req.db), pending: listPending(req.db, 50).map((p) => ({ id: p.id, kind: p.kind, key: p.dedupeKey, createdAt: p.createdAt })) },
    });
  } catch (e) { next(e); }
});

// One Odoo step on one order: send | confirm | deliver | invoice | pay | cancel.
router.post('/orders/:id/:step', (req, res, next) => {
  try {
    const step = STEP_ACTIONS[req.params.step];
    if (!step) return res.status(404).json({ error: 'Unknown step' });
    res.json({ ok: true, result: step(req.db, req.params.id) ?? null });
  } catch (e) {
    if (e instanceof SampleOdooError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

// Returns: the warehouse receives goods back into quarantine; Finance issues the credit note.
router.get('/return-options', (req, res, next) => {
  try { res.json({ options: returnOptions(req.db, todayString()), historyLoaded: historyLoaded(req.db) }); } catch (e) { next(e); }
});
router.post('/returns', (req, res, next) => {
  try { res.status(201).json(createReturn(req.db, req.body || {}, todayString())); } catch (e) {
    if (e instanceof SampleOdooError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});
router.post('/returns/:id/credit-note', (req, res, next) => {
  try { res.json(issueReturnCreditNote(req.db, req.params.id)); } catch (e) {
    if (e instanceof SampleOdooError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});
// Fourteen months of made-up history, so the monthly reports have something to compare with.
router.post('/history', (req, res, next) => {
  try { res.status(201).json(seedHistory(req.db, todayString())); } catch (e) {
    if (e instanceof SampleOdooError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.post('/invoices/:id/age', (req, res, next) => {
  try { ageInvoice(req.db, req.params.id); res.json({ ok: true }); } catch (e) {
    if (e instanceof SampleOdooError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

router.put('/customers/:id/credit-limit', (req, res, next) => {
  try { setCreditLimit(req.db, req.params.id, req.body?.limit); res.json({ ok: true }); } catch (e) {
    if (e instanceof SampleOdooError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
});

export default router;
