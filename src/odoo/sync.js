// Reading Odoo into BFL: scheduled sync jobs, one per kind of data.
//
// The rules (section 7.1 of the specification), all enforced here and tested against the fake Odoo:
//   - CHANGES ONLY: a run asks for records whose write_date is later than the last good run minus a 2-minute
//     overlap. A full read runs once a night to catch anything missed and logs differences to sync_changes.
//   - ALL OR NOTHING: a run is fetched first, then applied in ONE database transaction. A run that fails —
//     in Odoo, on the network, or while applying — changes nothing, and is retried at the next interval.
//   - INACTIVE, NEVER DELETED: a record archived in Odoo becomes inactive in BFL. Nothing is removed.
//   - ODOO WINS, BFL KEEPS ITS OWN: Odoo's fields overwrite BFL's copy; BFL-only fields (access codes,
//     passwords, minimum shelf life, images) are never touched.
//   - ONE RUN AT A TIME per kind of data, so a slow Odoo never piles runs up.
// Every record keeps its Odoo id. Only `customers` and `stock` are loaded so far; products, categories,
// price classes, invoices, payments and orders follow once their fields are verified on staging (the
// specification asks for that check in week 1).
import { odooConfig } from './config.js';

export const OVERLAP_MS = 2 * 60 * 1000;
const running = new Set();
const iso = (d) => d.toISOString();
/** Odoo timestamps are "YYYY-MM-DD HH:MM:SS" in UTC. */
const odooTime = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
const odooToIso = (s) => (s ? `${String(s).replace(' ', 'T')}Z` : null);
const text = (v) => (v === false || v === null || v === undefined ? null : String(v).trim() || null);
const normName = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

function change(db, runAt, type, odooId, kind, detail = null) {
  db.prepare('INSERT INTO sync_changes (run_at, data_type, odoo_id, change, detail) VALUES (?,?,?,?,?)').run(runAt, type, odooId === null ? null : String(odooId), kind, detail);
}

// ---------------------------------------------------------------------------------------------
// customers  ←  res.partner
// ---------------------------------------------------------------------------------------------
const PARTNER_FIELDS = ['id', 'name', 'ref', 'phone', 'mobile', 'email', 'street', 'city', 'property_product_pricelist', 'user_id', 'credit_limit', 'credit', 'active', 'write_date'];

const customers = {
  label: 'Customers',
  intervalMs: 5 * 60 * 1000,
  incremental: true,
  async fetch(client, since) {
    const domain = [['active', 'in', [true, false]]];
    if (since) domain.push(['write_date', '>', since]);
    return client.searchReadAll('res.partner', domain, PARTNER_FIELDS, { order: 'write_date asc, id asc' });
  },
  apply(db, partners, { now, full, cashPartnerId }) {
    const runAt = iso(now);
    const byRef = db.prepare('SELECT id, name, is_active FROM customers WHERE odoo_customer_ref = ?');
    const unlinked = db.prepare("SELECT id, name FROM customers WHERE (odoo_customer_ref IS NULL OR odoo_customer_ref = '') AND is_active = 1").all();
    const nameCount = new Map();
    for (const c of unlinked) nameCount.set(normName(c.name), (nameCount.get(normName(c.name)) || 0) + 1);
    const odooNames = new Map();
    for (const p of partners) odooNames.set(normName(p.name), (odooNames.get(normName(p.name)) || 0) + 1);
    let created = 0; let updated = 0; let linked = 0;
    const seen = new Set();

    for (const p of partners) {
      if (cashPartnerId && p.id === cashPartnerId) continue;            // the shared cash account is not a customer
      const name = text(p.name);
      if (!name) continue;
      seen.add(String(p.id));
      const klass = Array.isArray(p.property_product_pricelist) ? text(p.property_product_pricelist[1]) : null;
      const rep = Array.isArray(p.user_id) ? text(p.user_id[1]) : null;
      const phone = text(p.phone) || text(p.mobile);
      const address = [text(p.street), text(p.city)].filter(Boolean).join(', ') || null;
      const active = p.active === false ? 0 : 1;
      let row = byRef.get(String(p.id));
      if (!row) {
        // the one-time link: an existing BFL customer with no Odoo id and the same name, when the name is unique on BOTH sides
        const key = normName(name);
        const mine = unlinked.filter((c) => normName(c.name) === key);
        if (mine.length === 1 && nameCount.get(key) === 1 && odooNames.get(key) === 1) {
          db.prepare('UPDATE customers SET odoo_customer_ref = ? WHERE id = ?').run(String(p.id), mine[0].id);
          change(db, runAt, 'customers', p.id, 'LINKED_BY_NAME', `${name} (BFL customer ${mine[0].id})`);
          row = { id: mine[0].id }; linked += 1;
        } else if (mine.length > 1 || (mine.length === 1 && (nameCount.get(key) > 1 || odooNames.get(key) > 1))) {
          change(db, runAt, 'customers', p.id, 'AMBIGUOUS_NAME', `${name}: more than one record has this name; link it by hand`);
        }
      }
      if (!row) {
        const id = Number(db.prepare(`INSERT INTO customers (name, odoo_customer_ref, phone, email, pricelist, salesperson, delivery_address, customer_type, is_active, created_at, updated_at)
                                      VALUES (?,?,?,?,?,?,?, 'CREDIT', ?, ?, ?)`).run(name, String(p.id), phone, text(p.email), klass, rep, address, active, iso(now), iso(now)).lastInsertRowid);
        row = { id }; created += 1;
      } else {
        // Odoo wins. Only what Odoo owns is written; access codes, passwords and minimum shelf life are never touched.
        db.prepare(`UPDATE customers SET name = ?, phone = COALESCE(?, phone), email = COALESCE(?, email), pricelist = COALESCE(?, pricelist), salesperson = COALESCE(?, salesperson),
                                         delivery_address = COALESCE(?, delivery_address), customer_type = COALESCE(customer_type, 'CREDIT'), is_active = ?, updated_at = ? WHERE id = ?`)
          .run(name, phone, text(p.email), klass, rep, address, active, iso(now), row.id);
        updated += 1;
      }
      if (typeof p.credit_limit === 'number' || typeof p.credit === 'number') {
        db.prepare(`INSERT INTO odoo_customer_finance (customer_id, credit_limit, amount_owed, overdue, updated_at) VALUES (?,?,?,0,?)
                    ON CONFLICT(customer_id) DO UPDATE SET credit_limit = excluded.credit_limit, amount_owed = excluded.amount_owed, updated_at = excluded.updated_at`)
          .run(row.id, p.credit_limit > 0 ? p.credit_limit : null, typeof p.credit === 'number' ? p.credit : 0, iso(now));
      }
    }

    // a FULL read sees everything: a customer BFL knows by Odoo id that is no longer there becomes inactive (never deleted)
    let deactivated = 0;
    if (full) {
      for (const c of db.prepare("SELECT id, name, odoo_customer_ref FROM customers WHERE odoo_customer_ref IS NOT NULL AND odoo_customer_ref <> '' AND is_active = 1").all()) {
        if (!seen.has(c.odoo_customer_ref)) {
          db.prepare('UPDATE customers SET is_active = 0, updated_at = ? WHERE id = ?').run(iso(now), c.id);
          change(db, runAt, 'customers', c.odoo_customer_ref, 'DEACTIVATED', `${c.name} is no longer in Odoo`); deactivated += 1;
        }
      }
    }
    return { created, updated, linked, deactivated, newest: partners.reduce((m, p) => (p.write_date > m ? p.write_date : m), '') || null };
  },
};

// ---------------------------------------------------------------------------------------------
// stock  ←  product.product with the warehouse context
// ---------------------------------------------------------------------------------------------
const stock = {
  label: 'Stock',
  intervalMs: 5 * 60 * 1000,
  incremental: false,                      // quantities do not move a product's write_date: read them all, every time
  async fetch(client) {
    return client.searchReadAll('product.product', [['active', '=', true]], ['id', 'barcode', 'qty_available', 'free_qty', 'incoming_qty', 'outgoing_qty', 'virtual_available'], { order: 'id asc' });
  },
  apply(db, products, { now }) {
    const runAt = iso(now);
    const up = db.prepare(`UPDATE products SET on_hand = ?, free_to_use = ?, incoming = ?, outgoing = ?, forecasted = ?, updated_at = ? WHERE barcode = ? AND is_active = 1`);
    let updated = 0; let unknown = 0;
    for (const p of products) {
      const barcode = text(p.barcode);
      if (!barcode) continue;
      const r = up.run(Number(p.qty_available) || 0, Number(p.free_qty) || 0, Number(p.incoming_qty) || 0, Number(p.outgoing_qty) || 0, Number(p.virtual_available) || 0, iso(now), barcode);
      if (r.changes) updated += 1;
      else if (!db.prepare('SELECT 1 FROM products WHERE barcode = ?').get(barcode)) { unknown += 1; if (unknown <= 50) change(db, runAt, 'stock', p.id, 'UNKNOWN_BARCODE', barcode); }
    }
    return { updated, unknown, newest: null };
  },
};

export const SYNC_TYPES = Object.freeze({ customers, stock });

// ---------------------------------------------------------------------------------------------
// running a sync
// ---------------------------------------------------------------------------------------------
/**
 * Run one sync. Resolves with a summary, or rejects after recording the failure — and in that case the
 * database holds exactly what it held before.
 * @param {{full?:boolean, now?:Date}} [opts]
 */
export async function runSync(db, client, type, { full = false, now = new Date(), cashPartnerId = odooConfig().cashPartnerId } = {}) {
  const loader = SYNC_TYPES[type];
  if (!loader) throw new Error(`Unknown sync type: ${type}`);
  if (running.has(type)) return { skipped: true, reason: 'already running' };
  running.add(type);
  const attempt = iso(now);
  db.prepare('INSERT OR IGNORE INTO sync_state (data_type) VALUES (?)').run(type);
  db.prepare('UPDATE sync_state SET last_attempt_at = ? WHERE data_type = ?').run(attempt, type);
  try {
    const state = db.prepare('SELECT cursor FROM sync_state WHERE data_type = ?').get(type);
    let since = null;
    if (loader.incremental && !full && state.cursor) since = odooTime(new Date(Date.parse(odooToIso(state.cursor)) - OVERLAP_MS));
    const records = await loader.fetch(client, since);        // 1. read everything first, outside any transaction

    db.exec('BEGIN IMMEDIATE');                              // 2. apply it all, or nothing
    let result;
    try {
      result = loader.apply(db, records, { now, full, cashPartnerId });
      db.prepare(`UPDATE sync_state SET last_success_at = ?, last_error = NULL, records_last = ?, runs_ok = runs_ok + 1,
                         cursor = COALESCE(?, cursor) WHERE data_type = ?`).run(iso(now), records.length, loader.incremental ? result.newest : null, type);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { type, full, fetched: records.length, ...result };
  } catch (e) {
    // the failed run changed nothing; say so and carry on at the next interval
    db.prepare('UPDATE sync_state SET last_error = ?, runs_failed = runs_failed + 1 WHERE data_type = ?').run(String(e.message || e).slice(0, 300), type);
    throw e;
  } finally { running.delete(type); }
}

/** Where each kind of sync stands, for the health screen. */
export function syncStatus(db, now = new Date()) {
  const rows = new Map(db.prepare('SELECT * FROM sync_state').all().map((r) => [r.data_type, r]));
  return Object.entries(SYNC_TYPES).map(([type, l]) => {
    const r = rows.get(type);
    const ageMin = r?.last_success_at ? Math.round((now - new Date(r.last_success_at)) / 60000) : null;
    return {
      type, label: l.label, intervalMinutes: Math.round(l.intervalMs / 60000), lastSuccessAt: r?.last_success_at || null, lastAttemptAt: r?.last_attempt_at || null,
      lastError: r?.last_error || null, recordsLast: r?.records_last || 0, runsOk: r?.runs_ok || 0, runsFailed: r?.runs_failed || 0, ageMinutes: ageMin,
      // alert when it has not worked for 20 minutes (the specification's threshold for stock and customers)
      stale: r?.last_success_at ? ageMin > 20 : Boolean(r?.last_attempt_at),
    };
  });
}
