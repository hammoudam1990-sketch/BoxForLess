// Starting the Odoo jobs, and the call log. Nothing here runs unless Odoo is configured AND BFL_ODOO_SYNC=on,
// so a laptop with no Odoo settings never makes a network call.
//
//   every 30 s         the outbox worker (quotations and approved new customers)
//   every 5 minutes    customers and stock (changes only; stock is read whole)
//   nightly ~02:30 UTC a FULL read of customers, logging differences
import { odooConfig, publicOdooConfig } from './config.js';
import { createOdooClient } from './client.js';
import { runSync, SYNC_TYPES } from './sync.js';
import { runOutbox } from './outbox-worker.js';

/** The logger the client calls after every request: one row per call, never the key. Kept 90 days. */
export function callLogger(db) {
  let n = 0;
  return ({ model, method, count, ms, ok, error }) => {
    db.prepare('INSERT INTO odoo_call_log (at, model, method, count, ms, ok, error) VALUES (?,?,?,?,?,?,?)').run(new Date().toISOString(), model, method, count ?? null, ms ?? null, ok ? 1 : 0, error || null);
    n += 1;
    if (n % 200 === 0) db.prepare("DELETE FROM odoo_call_log WHERE at < date('now', '-90 days')").run();
  };
}

let current = null;
/** The running client, if the jobs are started (the health screen uses it for "run now"). */
export const currentClient = () => current;

/**
 * @returns {{stop():void, client:object}|null}  null when Odoo is not configured or syncing is off
 */
export function startOdooJobs(db, cfg = odooConfig(), log = console) {
  if (!cfg.configured || !cfg.syncOn) return null;
  const client = createOdooClient({ ...cfg, onCall: callLogger(db) });
  current = client;
  const timers = [];
  const guard = (name, fn) => async () => { try { await fn(); } catch (e) { log.error?.(`Odoo ${name} failed: ${e.message}`); } };

  timers.push(setInterval(guard('outbox', () => runOutbox(db, client, { cashPartnerId: cfg.cashPartnerId })), 30_000));
  for (const [type, l] of Object.entries(SYNC_TYPES)) {
    const tick = guard(`${type} sync`, () => runSync(db, client, type));
    tick();
    timers.push(setInterval(tick, l.intervalMs));
  }
  let lastFull = '';
  timers.push(setInterval(guard('nightly full read', async () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === 2 && now.getUTCMinutes() >= 30 && lastFull !== day) { lastFull = day; await runSync(db, client, 'customers', { full: true }); }
  }), 60_000));
  for (const t of timers) t.unref?.();
  log.log?.(`Odoo jobs started (${JSON.stringify(publicOdooConfig(cfg))})`);
  return { client, stop: () => { timers.forEach(clearInterval); current = null; } };
}
