// Customer master — a mirror of Odoo's res.partner, and the search behind customer
// selection.
//
// IDENTITY: `odoo_customer_ref` (the stable res.partner id) is the ONLY permanent
// identity. Display name may be used to MATCH an incoming row to an existing record
// — names are currently unique in the export — but is never the stored identity,
// because a rename in Odoo would otherwise orphan every request. Phone is unusable
// as identity (the real export contains "0" five times, and "Office") and is kept
// for staff reference only.
//
// NEVER IMPORTED from the contact export:
//   Pricelist  — pricing, excluded from this project entirely
//   Avatar 128 — 355 base64 SVG blobs, pure bloat
//   Stats      — Odoo UI JSON
// The importer reads an explicit allow-list of columns, so a new column added to a
// future export cannot leak in by default.
import crypto from 'node:crypto';
import { normText } from './normalize.js';
import config from '../config.js';

function nowIso() { return new Date().toISOString(); }

/** The ONLY contact columns this project will read. Anything else is ignored. */
export const CUSTOMER_SOURCE_COLUMNS = Object.freeze({
  odoo_customer_ref: ['customerid', 'id', 'externalid', 'partnerid', 'respartnerid', 'reference'],
  name: ['displayname', 'name', 'customer', 'company', 'companyname'],
  phone: ['phone', 'mobile', 'telephone'],
  country: ['country'],
});

/** Columns that must never be read, asserted by tests. */
export const CUSTOMER_FORBIDDEN_COLUMNS = Object.freeze([
  'pricelist', 'avatar128', 'avatar', 'stats', 'salesprice', 'price', 'credit', 'balance',
]);

const headerKey = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map raw contact-export headers onto the allow-listed fields. */
export function mapCustomerHeaders(headers = []) {
  const lookup = new Map();
  for (const [field, aliases] of Object.entries(CUSTOMER_SOURCE_COLUMNS)) {
    lookup.set(headerKey(field), field);
    for (const a of aliases) lookup.set(headerKey(a), field);
  }
  const mapping = {};
  const ignored = [];
  for (const h of headers) {
    const field = lookup.get(headerKey(h));
    if (field && !mapping[field]) mapping[field] = h;
    else ignored.push(h);
  }
  return { mapping, ignored, hasStableId: Boolean(mapping.odoo_customer_ref) };
}

/** Normalize one contact row into the allow-listed shape. Builds a fresh object. */
export function normalizeCustomer(raw, mapping) {
  return {
    odoo_customer_ref: mapping.odoo_customer_ref ? normText(raw[mapping.odoo_customer_ref]) : null,
    name: mapping.name ? normText(raw[mapping.name]) : null,
    phone: mapping.phone ? normText(raw[mapping.phone]) : null,
    country: mapping.country ? normText(raw[mapping.country]) : null,
  };
}

export class CustomerImportError extends Error {
  constructor(msg) { super(msg); this.name = 'CustomerImportError'; this.code = 'CUSTOMER_IMPORT_INVALID'; this.status = 400; }
}

/**
 * Import customer records. Transactional and non-destructive:
 *   - matched on odoo_customer_ref when present, else on name
 *   - odoo_customer_ref is BACKFILLED onto a name-matched record (fills a NULL,
 *     never overwrites) — the same pattern proven for products.source_odoo_id
 *   - a customer absent from the file is marked INACTIVE, never deleted
 *
 * @param {object[]} records - normalized rows (see normalizeCustomer)
 * @param {{requireStableId?:boolean}} opts
 *   requireStableId (default TRUE) refuses an import with no stable-id column.
 *   This is the guard behind the Stage 3 rule that the production customer master
 *   must not be loaded until Odoo supplies res.partner ids; tests pass false to
 *   exercise the fallback path with synthetic data.
 */
export function importCustomers(db, records = [], opts = {}) {
  const requireStableId = opts.requireStableId !== false;
  const ts = nowIso();

  const withId = records.filter((r) => r.odoo_customer_ref);
  if (requireStableId && withId.length !== records.length) {
    throw new CustomerImportError(
      'Contact export has no stable Customer ID (res.partner id) for every row. '
      + 'Refusing to import: name and phone are not permanent identities. '
      + 'Export the Customer ID column from Odoo and re-run.'
    );
  }
  for (const r of records) {
    if (!r.name) throw new CustomerImportError('Every contact row needs a display name.');
  }
  const refs = withId.map((r) => r.odoo_customer_ref);
  if (new Set(refs).size !== refs.length) {
    throw new CustomerImportError('Duplicate Customer ID in the contact export.');
  }

  const counts = { created: 0, updated: 0, unchanged: 0, deactivated: 0, backfilled: 0 };
  const byRef = db.prepare('SELECT * FROM customers WHERE odoo_customer_ref = ?');
  const byName = db.prepare('SELECT * FROM customers WHERE odoo_customer_ref IS NULL AND name = ?');

  db.exec('BEGIN IMMEDIATE');
  try {
    const seen = new Set();
    for (const r of records) {
      const existing = (r.odoo_customer_ref && byRef.get(r.odoo_customer_ref)) || byName.get(r.name) || null;

      if (!existing) {
        const info = db.prepare(
          `INSERT INTO customers (odoo_customer_ref, name, phone, country, is_active, created_at, updated_at)
           VALUES (?,?,?,?,1,?,?)`
        ).run(r.odoo_customer_ref, r.name, r.phone, r.country, ts, ts);
        seen.add(Number(info.lastInsertRowid));
        counts.created += 1;
        continue;
      }

      seen.add(existing.id);
      const sets = [];
      const vals = [];
      // backfill only — never overwrite an existing stable id
      if (r.odoo_customer_ref && existing.odoo_customer_ref == null) {
        sets.push('odoo_customer_ref = ?'); vals.push(r.odoo_customer_ref); counts.backfilled += 1;
      }
      for (const [col, val] of [['name', r.name], ['phone', r.phone], ['country', r.country]]) {
        if (val != null && existing[col] !== val) { sets.push(`${col} = ?`); vals.push(val); }
      }
      if (existing.is_active !== 1) sets.push('is_active = 1');

      if (!sets.length) { counts.unchanged += 1; continue; }
      sets.push('updated_at = ?'); vals.push(ts, existing.id);
      db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      counts.updated += 1;
    }

    // absent from the file -> inactive, NEVER deleted (history is protected)
    for (const row of db.prepare('SELECT id FROM customers WHERE is_active = 1').all()) {
      if (!seen.has(row.id)) {
        db.prepare('UPDATE customers SET is_active = 0, updated_at = ? WHERE id = ?').run(ts, row.id);
        counts.deactivated += 1;
      }
    }

    if (typeof opts.faultHook === 'function') opts.faultHook();
    db.exec('COMMIT');
    return counts;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}

/**
 * An OPAQUE handle standing in for a customer in customer-facing traffic.
 *
 * The browser needs some token to say "this is who I am" at submission, but the
 * Odoo customer id must never leave the server. The handle is a keyed digest of
 * that id: stable across restarts, meaningless to the client, and not reversible
 * into an Odoo reference.
 *
 * It is a transport token, NOT a secret: it only names a company the customer
 * already found by typing its name. The key keeps it from being forged or decoded,
 * not from being seen.
 */
export function customerHandle(ref, secret = config.customerSearch.handleSecret) {
  if (!ref) return null;
  return crypto.createHmac('sha256', String(secret)).update(String(ref)).digest('base64url').slice(0, 22);
}

/**
 * Resolve a handle back to a customer. Compares handles rather than storing them,
 * so no schema change and nothing extra to keep in sync. Active customers only.
 */
export function resolveCustomerHandle(db, handle, opts = {}) {
  const h = String(handle ?? '').trim();
  if (!h) return null;
  const rows = db.prepare(
    'SELECT id, odoo_customer_ref, name FROM customers WHERE is_active = 1 AND odoo_customer_ref IS NOT NULL'
  ).all();
  return rows.find((r) => customerHandle(r.odoo_customer_ref, opts.secret) === h) || null;
}

/**
 * Customer-facing search. Search-only by design: there is no browse-all endpoint,
 * a minimum query length stops bulk enumeration from a single blank query, and
 * results are capped.
 *
 * Returns the display NAME and an OPAQUE handle — never the Odoo customer id, the
 * internal row id, phone, email, country or pricelist.
 */
export function searchCustomers(db, query, opts = {}) {
  const min = opts.minQueryLength ?? config.customerSearch.minQueryLength;
  const max = opts.maxResults ?? config.customerSearch.maxResults;
  const q = String(query ?? '').trim();
  if (q.length < min) return { items: [], minQueryLength: min };

  const rows = db.prepare(
    `SELECT odoo_customer_ref, name FROM customers
      WHERE is_active = 1 AND UPPER(name) LIKE UPPER(?)
      ORDER BY name COLLATE NOCASE LIMIT ?`
  ).all(`%${q}%`, max);

  // Built field-by-field: a column added to `customers` later cannot leak.
  return {
    items: rows.map((r) => ({ handle: customerHandle(r.odoo_customer_ref, opts.secret), name: r.name })),
    minQueryLength: min,
  };
}

export default { importCustomers, searchCustomers, mapCustomerHeaders, normalizeCustomer };
