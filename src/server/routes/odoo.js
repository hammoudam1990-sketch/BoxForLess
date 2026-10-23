// Staff API for the Sync health screen (S05). Mounted behind requireStaff and requireRole({ ADMIN, SALES_MANAGER: rw,
// WAREHOUSE: read }). Retry puts a FAILED outbox entry back in the queue (it keeps its reference, so it cannot
// create a duplicate). Nothing here ever returns the API key.
import express from 'express';
import { odooHealth } from '../../odoo/health.js';
import { retryOutbox } from '../../odoo/outbox-worker.js';
import { runSync, SYNC_TYPES } from '../../odoo/sync.js';
import { currentClient } from '../../odoo/jobs.js';
import { requireRole } from '../staff-auth.js';

const router = express.Router();

router.get('/health', (req, res, next) => { try { res.json(odooHealth(req.db)); } catch (e) { next(e); } });

router.post('/outbox/:id/retry', (req, res, next) => {
  try {
    const r = retryOutbox(req.db, req.params.id);
    if (!r) return res.status(404).json({ error: 'No such outbox entry.' });
    if (!r.ok) return res.status(409).json({ error: r.reason });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// run one sync now (administrator): only when the Odoo jobs are running
router.post('/sync/:type/run', requireRole('ADMIN'), async (req, res, next) => {
  try {
    if (!SYNC_TYPES[req.params.type]) return res.status(404).json({ error: 'Unknown sync.' });
    const client = currentClient();
    if (!client) return res.status(409).json({ error: 'Odoo is not connected: the sync jobs are not running.' });
    res.json(await runSync(req.db, client, req.params.type, { full: req.body?.full === true }));
  } catch (e) { res.status(502).json({ error: String(e.message || e).slice(0, 300) }); }
});

export default router;
