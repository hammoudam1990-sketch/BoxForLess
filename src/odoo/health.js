// What the "Sync health" screen shows (S05): is Odoo reachable, when did each kind of data last sync, what is
// waiting in the outbox, and what needs a person. Alerts use the specification's thresholds:
//   Odoo does not answer ............ 10 minutes     Stock or customer sync not successful ... 20 minutes
//   An outbox entry is failed ........ at once         An outbox entry is still pending ........ 2 hours
// (There is no email service yet, so these show here and on the dashboard; sending them by email comes with D1.)
import { odooConfig, publicOdooConfig } from './config.js';
import { syncStatus } from './sync.js';
import { sampleOdooEnabled } from '../domain/sample-odoo.js';

const mins = (a, b) => Math.round((b - a) / 60000);

export function odooHealth(db, cfg = odooConfig(), now = new Date()) {
  const sync = syncStatus(db, now);
  const lastOk = db.prepare('SELECT at FROM odoo_call_log WHERE ok = 1 ORDER BY id DESC LIMIT 1').get();
  const lastBad = db.prepare('SELECT at, model, method, error FROM odoo_call_log WHERE ok = 0 ORDER BY id DESC LIMIT 1').get();
  const summary = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM odoo_outbox GROUP BY status').all()) summary[r.status] = r.n;
  const queue = db.prepare(`SELECT id, kind, dedupe_key AS ref, status, attempts, last_error AS error, created_at AS createdAt, next_attempt_at AS nextAttemptAt, odoo_number AS odooNumber
                              FROM odoo_outbox WHERE status IN ('PENDING','FAILED') ORDER BY (status = 'FAILED') DESC, id LIMIT 50`).all();
  const connected = cfg.configured && cfg.syncOn;
  const mode = connected ? 'CONNECTED' : cfg.configured ? 'CONFIGURED_SYNC_OFF' : 'STAND_IN';
  const alerts = [];
  if (connected) {
    const sinceAnswer = lastOk ? mins(new Date(lastOk.at), now) : null;
    if (sinceAnswer === null || sinceAnswer >= 10) alerts.push({ level: 'red', message: sinceAnswer === null ? 'Odoo has not answered yet.' : `Odoo has not answered for ${sinceAnswer} minutes.` });
    for (const s of sync) if (s.stale) alerts.push({ level: 'red', message: `${s.label} has not synced successfully for ${s.ageMinutes ?? 'a while'} minutes${s.lastError ? `: ${s.lastError}` : ''}.` });
  }
  for (const q of queue) {
    if (q.status === 'FAILED') alerts.push({ level: 'red', message: `A ${q.kind === 'CREATE_PARTNER' ? 'new customer' : 'quotation'} (${q.ref}) failed: ${q.error}` });
    else if (mins(new Date(q.createdAt), now) >= 120) alerts.push({ level: 'amber', message: `A ${q.kind === 'CREATE_PARTNER' ? 'new customer' : 'quotation'} (${q.ref}) has been waiting more than 2 hours${q.error ? `: ${q.error}` : ''}.` });
  }
  return {
    mode, standIn: sampleOdooEnabled(), config: publicOdooConfig(cfg), asOf: now.toISOString(),
    odoo: { lastAnswerAt: lastOk?.at || null, minutesSinceAnswer: lastOk ? mins(new Date(lastOk.at), now) : null, lastError: lastBad || null },
    sync, outbox: { summary, queue }, alerts,
    changes: db.prepare('SELECT run_at AS at, data_type AS type, odoo_id AS odooId, change, detail FROM sync_changes ORDER BY id DESC LIMIT 25').all(),
    calls: db.prepare('SELECT at, model, method, count, ms, ok, error FROM odoo_call_log ORDER BY id DESC LIMIT 15').all(),
  };
}
