import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import { backupDatabase } from '../../db/backup.js';
import { odooHealth } from '../../odoo/health.js';
import { retryOutbox } from '../../odoo/outbox-worker.js';
import { runDailyReconciliation } from '../../domain/reconciliation.js';
import { runSync, SYNC_TYPES } from '../../odoo/sync.js';
import { currentClient } from '../../odoo/jobs.js';
import { requireRole } from '../staff-auth.js';

const router = express.Router();

router.get('/health', (req, res, next) => { try { res.json(odooHealth(req.db)); } catch (e) { next(e); } });

router.get('/reconciliation', (req, res, next) => {
  try {
    res.json(runDailyReconciliation(req.db));
  } catch (e) { next(e); }
});

router.get('/system-stats', (req, res, next) => {
  try {
    let dbSize = 0;
    try { dbSize = fs.statSync(config.dbPath).size; } catch { /* ignore */ }
    const productCount = req.db.prepare('SELECT COUNT(*) as count FROM products WHERE is_active = 1').get().count;
    const customerCount = req.db.prepare('SELECT COUNT(*) as count FROM customers WHERE is_active = 1').get().count;
    const requestCount = req.db.prepare('SELECT COUNT(*) as count FROM requests').get().count;
    const outboxPending = req.db.prepare("SELECT COUNT(*) as count FROM odoo_outbox WHERE status = 'PENDING'").get().count;
    const outboxFailed = req.db.prepare("SELECT COUNT(*) as count FROM odoo_outbox WHERE status = 'FAILED'").get().count;
    const mem = process.memoryUsage();
    res.json({
      uptimeSeconds: Math.floor(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      dbPath: config.dbPath,
      dbSizeBytes: dbSize,
      productCount,
      customerCount,
      requestCount,
      outboxPending,
      outboxFailed,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
    });
  } catch (e) { next(e); }
});

router.get('/backups', (req, res, next) => {
  try {
    const backupDir = process.env.BACKUP_DIR || path.join(path.dirname(config.dbPath), 'backups');
    if (!fs.existsSync(backupDir)) return res.json({ backups: [] });
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith('bfl-backup-') && f.endsWith('.db'))
      .map((f) => {
        const stat = fs.statSync(path.join(backupDir, f));
        return {
          filename: f,
          sizeBytes: stat.size,
          createdAt: stat.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json({ backups: files });
  } catch (e) { next(e); }
});

router.post('/backups/create', requireRole('ADMIN'), (req, res, next) => {
  try {
    if (config.dbPath === ':memory:') return res.status(400).json({ error: 'Cannot backup in-memory database.' });
    const backupDir = process.env.BACKUP_DIR || path.join(path.dirname(config.dbPath), 'backups');
    const result = backupDatabase(req.db, backupDir, { maxKeep: 7 });
    res.status(201).json({ ok: true, ...result });
  } catch (e) { next(e); }
});

router.post('/outbox/:id/retry', (req, res, next) => {
  try {
    const r = retryOutbox(req.db, req.params.id);
    if (!r) return res.status(404).json({ error: 'No such outbox entry.' });
    if (!r.ok) return res.status(409).json({ error: r.reason });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/outbox/retry-all', (req, res, next) => {
  try {
    const info = req.db.prepare("UPDATE odoo_outbox SET status = 'PENDING', next_attempt_at = NULL, first_attempt_at = NULL, attempts = 0, last_error = NULL WHERE status = 'FAILED'").run();
    res.json({ ok: true, retriedCount: info.changes });
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
