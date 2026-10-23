// The decision recorded against a lot on the Expiry list: what will be done with it, who owns
// it, by when, and where it stands. These live in BFL (the specification: "BFL tracks the
// decision"). The physical move, return or write-off is done in Odoo by the warehouse.
import { ExpiryAction, ExpiryStatus, toDay, formatDay } from './expiry.js';

export class ExpiryActionError extends Error {
  constructor(message) { super(message); this.name = 'ExpiryActionError'; this.status = 400; }
}

/** How BFL names a lot until Odoo ids are in play: "<barcode>|<lot name>". */
export const lotKey = (lot) => `${lot.barcode}|${lot.lotName}`;

const MAX_OWNER = 60;
const MAX_KEY = 200;
const nowIso = () => new Date().toISOString();

/** Every saved decision, keyed by lot key. */
export function listActions(db) {
  const out = new Map();
  for (const r of db.prepare('SELECT lot_key, action, owner, decide_by, status, updated_at FROM expiry_actions').all()) {
    out.set(r.lot_key, {
      action: r.action || null, owner: r.owner || null, decideBy: r.decide_by || null,
      status: r.status, updatedAt: r.updated_at,
    });
  }
  return out;
}

/**
 * Save (part of) a lot's decision. Only the fields present in `input` change, so changing
 * the owner never wipes the action. Empty string / null clears a field; status cannot be cleared.
 * @returns {{action, owner, decideBy, status, updatedAt}}
 */
export function saveAction(db, key, input = {}) {
  if (typeof key !== 'string' || !key.trim() || key.length > MAX_KEY) throw new ExpiryActionError('A lot is needed.');
  const current = listActions(db).get(key) || { action: null, owner: null, decideBy: null, status: ExpiryStatus.OPEN };
  const next = { ...current };

  if ('action' in input) {
    const a = input.action === '' ? null : input.action;
    if (a !== null && !Object.values(ExpiryAction).includes(a)) throw new ExpiryActionError('That is not one of the actions.');
    next.action = a;
  }
  if ('owner' in input) {
    const o = input.owner === null || input.owner === undefined ? '' : String(input.owner).trim();
    if (o.length > MAX_OWNER) throw new ExpiryActionError(`An owner's name can be at most ${MAX_OWNER} characters.`);
    next.owner = o || null;
  }
  if ('decideBy' in input) {
    if (input.decideBy === '' || input.decideBy === null) next.decideBy = null;
    else {
      const day = toDay(input.decideBy);
      if (day === null) throw new ExpiryActionError('The decide-by date is not a real date.');
      next.decideBy = formatDay(day);
    }
  }
  if ('status' in input) {
    if (!Object.values(ExpiryStatus).includes(input.status)) throw new ExpiryActionError('That is not one of the statuses.');
    next.status = input.status;
  }

  next.updatedAt = nowIso();
  db.prepare(`INSERT INTO expiry_actions (lot_key, action, owner, decide_by, status, updated_at)
              VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(lot_key) DO UPDATE SET action = excluded.action, owner = excluded.owner,
                decide_by = excluded.decide_by, status = excluded.status, updated_at = excluded.updated_at`)
    .run(key, next.action, next.owner, next.decideBy, next.status, next.updatedAt);
  return next;
}
