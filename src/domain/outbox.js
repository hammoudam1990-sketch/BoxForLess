// The outbox: the ONLY way BFL will write to Odoo (draft quotations and approved new customers).
//
// A write is recorded here first, in the same transaction as the decision that caused it, and
// sent later by a worker that retries and never sends the same write twice (`dedupe_key` is
// unique). Until the Odoo connection exists nothing is sent: rows stay PENDING and the staff
// screens say so. Nothing in this module talks to Odoo.
export const OutboxKind = Object.freeze({ CREATE_PARTNER: 'CREATE_PARTNER', DRAFT_QUOTATION: 'DRAFT_QUOTATION' });
export const OutboxStatus = Object.freeze({ PENDING: 'PENDING', SENT: 'SENT', FAILED: 'FAILED' });

/**
 * Queue one write. Safe to call twice for the same thing: the second call does nothing and
 * returns the row already queued. Call inside the caller's transaction.
 */
export function enqueue(db, kind, dedupeKey, payload, now = new Date()) {
  if (!Object.values(OutboxKind).includes(kind)) throw new Error(`Unknown outbox kind: ${kind}`);
  const ts = now.toISOString();
  db.prepare(`INSERT OR IGNORE INTO odoo_outbox (kind, dedupe_key, payload, status, attempts, created_at)
              VALUES (?,?,?,?,0,?)`).run(kind, String(dedupeKey), JSON.stringify(payload), OutboxStatus.PENDING, ts);
  return db.prepare('SELECT id, kind, dedupe_key AS dedupeKey, status FROM odoo_outbox WHERE dedupe_key = ?').get(String(dedupeKey));
}

/** Counts by status, for the sync-health screen later. */
export function outboxSummary(db) {
  const out = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const r of db.prepare('SELECT status, COUNT(*) n FROM odoo_outbox GROUP BY status').all()) out[r.status] = r.n;
  return out;
}

/** What is waiting to go to Odoo, oldest first. Staff only. */
export function listPending(db, limit = 100) {
  return db.prepare(`SELECT id, kind, dedupe_key AS dedupeKey, payload, status, attempts, created_at AS createdAt
                       FROM odoo_outbox WHERE status = 'PENDING' ORDER BY id LIMIT ?`).all(Number(limit) || 100)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}
