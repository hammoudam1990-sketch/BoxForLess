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
  odoo_customer_ref: ['customerid', 'externalid', 'partnerid', 'respartnerid'],
  name: ['displayname', 'name', 'customer', 'company', 'companyname'],
  email: ['email', 'emailaddress'],
  phone: ['phone', 'mobile', 'telephone'],
  country: ['country'],
  // A price-TIER name (e.g. "CLASS A (GHS)"), not a price. Stored for staff use
  // and never exposed to a customer; see the leak tests.
  pricelist: ['pricelist', 'pricetier'],
});

/** Columns that must never be read, asserted by tests. */
export const CUSTOMER_FORBIDDEN_COLUMNS = Object.freeze([
  'avatar128', 'avatar', 'stats', 'activities', 'salesprice', 'price', 'credit', 'balance',
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
  // normText trims and turns blank into null. Nothing is invented, reformatted or
  // coerced: phone stays a STRING (so "0", "Office" and leading zeros survive
  // exactly as typed in Odoo), and names are preserved verbatim.
  return {
    odoo_customer_ref: mapping.odoo_customer_ref ? normText(raw[mapping.odoo_customer_ref]) : null,
    name: mapping.name ? normText(raw[mapping.name]) : null,
    email: mapping.email ? normText(raw[mapping.email]) : null,
    phone: mapping.phone ? normText(raw[mapping.phone]) : null,
    country: mapping.country ? normText(raw[mapping.country]) : null,
    pricelist: mapping.pricelist ? normText(raw[mapping.pricelist]) : null,
  };
}

/** Case/space-insensitive key used to MATCH a row to an existing customer. */
export function customerMatchKey(name) {
  return String(name ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

export class CustomerImportError extends Error {
  constructor(msg) { super(msg); this.name = 'CustomerImportError'; this.code = 'CUSTOMER_IMPORT_INVALID'; this.status = 400; }
}

/**
 * Decide what an import WOULD do, without writing anything.
 *
 * IDENTITY (2026-10-03): this phase has no Odoo API and does not require an Odoo
 * customer id. Rows are matched on the DISPLAY NAME, case- and spacing-insensitive
 * — it is unique across all 355 rows of the real export, and it is the only field
 * that is always present. Phone is explicitly NOT an identity: the real file holds
 * "0" five times and the literal word "Office".
 *
 * `odoo_customer_ref` stays nullable and is matched FIRST when a row happens to
 * carry one, so adding real Odoo ids later needs no migration and no rework.
 *
 * @returns a preview object; writes nothing.
 */
export function previewCustomerImport(db, records = []) {
  const existing = db.prepare('SELECT * FROM customers').all();
  const byRef = new Map(existing.filter((c) => c.odoo_customer_ref).map((c) => [c.odoo_customer_ref, c]));
  const byKey = new Map(existing.map((c) => [customerMatchKey(c.name), c]));

  const seenInFile = new Map();   // match key -> first row number
  const rows = [];
  const summary = {
    total_rows: records.length, valid_rows: 0, invalid_rows: 0, duplicate_rows: 0,
    new_count: 0, updated_count: 0, unchanged_count: 0, warning_count: 0,
  };

  records.forEach((r, i) => {
    const rowNumber = i + 1;
    const errors = [];
    const warnings = [];

    if (!r.name) errors.push('Missing customer name');
    const key = customerMatchKey(r.name);

    // duplicate WITHIN the file — the second and later rows are refused, so one
    // source row can never create two customers
    let duplicateOf = null;
    if (key && seenInFile.has(key)) {
      duplicateOf = seenInFile.get(key);
      errors.push(`Duplicate of row ${duplicateOf} in this file`);
    } else if (key) {
      seenInFile.set(key, rowNumber);
    }

    if (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email)) warnings.push(`Unusual email "${r.email}"`);
    if (r.phone && !/\d/.test(r.phone)) warnings.push(`Phone contains no digits ("${r.phone}")`);
    if (!r.phone && !r.email) warnings.push('No phone or email');

    if (errors.length) {
      summary.invalid_rows += 1;
      if (duplicateOf) summary.duplicate_rows += 1;
      rows.push({ rowNumber, name: r.name, action: 'ERROR', errors, warnings });
      return;
    }

    summary.valid_rows += 1;
    if (warnings.length) summary.warning_count += 1;

    const match = (r.odoo_customer_ref && byRef.get(r.odoo_customer_ref)) || byKey.get(key) || null;
    if (!match) {
      summary.new_count += 1;
      rows.push({ rowNumber, name: r.name, action: 'CREATE', errors: [], warnings });
      return;
    }

    const changed = ['name', 'email', 'phone', 'country', 'pricelist']
      .filter((f) => r[f] != null && match[f] !== r[f]);
    if (r.odoo_customer_ref && match.odoo_customer_ref == null) changed.push('odoo_customer_ref');
    if (match.is_active !== 1) changed.push('is_active');

    if (changed.length) {
      summary.updated_count += 1;
      rows.push({ rowNumber, name: r.name, action: 'UPDATE', changed, errors: [], warnings });
    } else {
      summary.unchanged_count += 1;
      rows.push({ rowNumber, name: r.name, action: 'UNCHANGED', errors: [], warnings });
    }
  });

  return {
    summary,
    rows,
    errorRows: rows.filter((r) => r.action === 'ERROR'),
    warningRows: rows.filter((r) => r.warnings.length && r.action !== 'ERROR'),
  };
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
export function importCustomers(db, inputRecords = [], opts = {}) {
  const ts = nowIso();
  const deactivateMissing = opts.deactivateMissing === true; // OFF by default (see below)

  // Records normally arrive from normalizeCustomer(), which sets every field. A
  // caller passing a partial object would otherwise bind `undefined` and fail deep
  // inside SQLite with an opaque message, so fill the gaps with explicit nulls.
  const fields = ['odoo_customer_ref', 'name', 'email', 'phone', 'country', 'pricelist'];
  const records = inputRecords.map((r) => Object.fromEntries(fields.map((f) => [f, r?.[f] ?? null])));

  for (const r of records) {
    if (!r.name) throw new CustomerImportError('Every contact row needs a display name.');
  }
  const refs = records.map((r) => r.odoo_customer_ref).filter(Boolean);
  if (new Set(refs).size !== refs.length) {
    throw new CustomerImportError('Duplicate Customer ID in the contact export.');
  }

  const counts = { created: 0, updated: 0, unchanged: 0, deactivated: 0, backfilled: 0, skippedDuplicate: 0 };
  const byRef = db.prepare('SELECT * FROM customers WHERE odoo_customer_ref = ?');
  const all = () => db.prepare('SELECT * FROM customers').all();

  db.exec('BEGIN IMMEDIATE');
  try {
    // name key -> row, rebuilt once and kept current as we insert
    const byKey = new Map(all().map((c) => [customerMatchKey(c.name), c]));
    const seen = new Set();
    const seenKeys = new Set();

    for (const r of records) {
      const key = customerMatchKey(r.name);
      // a repeated name inside one file updates the first record rather than
      // creating a second — re-import can never fan out into duplicates
      if (seenKeys.has(key)) { counts.skippedDuplicate += 1; continue; }
      seenKeys.add(key);

      const existing = (r.odoo_customer_ref && byRef.get(r.odoo_customer_ref)) || byKey.get(key) || null;

      if (!existing) {
        const info = db.prepare(
          `INSERT INTO customers (odoo_customer_ref, name, email, phone, country, pricelist, is_active, created_at, updated_at)
           VALUES (?,?,?,?,?,?,1,?,?)`
        ).run(r.odoo_customer_ref, r.name, r.email, r.phone, r.country, r.pricelist, ts, ts);
        const id = Number(info.lastInsertRowid);
        seen.add(id);
        byKey.set(key, { id, name: r.name });
        counts.created += 1;
        continue;
      }

      seen.add(existing.id);
      const sets = [];
      const vals = [];
      // backfill only — an existing Odoo id is never overwritten
      if (r.odoo_customer_ref && existing.odoo_customer_ref == null) {
        sets.push('odoo_customer_ref = ?'); vals.push(r.odoo_customer_ref); counts.backfilled += 1;
      }
      for (const col of ['name', 'email', 'phone', 'country', 'pricelist']) {
        if (r[col] != null && existing[col] !== r[col]) { sets.push(`${col} = ?`); vals.push(r[col]); }
      }
      if (existing.is_active !== 1) sets.push('is_active = 1');

      if (!sets.length) { counts.unchanged += 1; continue; }
      sets.push('updated_at = ?'); vals.push(ts, existing.id);
      db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      counts.updated += 1;
    }

    // Customers absent from the file are LEFT ALONE by default. A contact export
    // is often a filtered view rather than the whole book, so deactivating on
    // absence would silently hide customers who still exist — and a deactivated
    // customer cannot be selected on a request. Opt in explicitly when the file
    // really is the complete list. Nothing is ever deleted either way.
    if (deactivateMissing) {
      for (const row of db.prepare('SELECT id FROM customers WHERE is_active = 1').all()) {
        if (!seen.has(row.id)) {
          db.prepare('UPDATE customers SET is_active = 0, updated_at = ? WHERE id = ?').run(ts, row.id);
          counts.deactivated += 1;
        }
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
export function customerHandle(key, secret = config.customerSearch.handleSecret) {
  if (!key) return null;
  return crypto.createHmac('sha256', String(secret)).update(String(key)).digest('base64url').slice(0, 22);
}

/**
 * The stable key a handle is derived from.
 *
 * Prefers the Odoo id when the record has one, so handles issued before and after
 * Odoo integration stay identical for those customers. Otherwise it falls back to
 * the internal row id, namespaced — which is why the internal id still never
 * reaches a browser: it goes in, the HMAC comes out.
 */
export function customerKey(row) {
  if (!row) return null;
  return row.odoo_customer_ref || (row.id != null ? `BFL-${row.id}` : null);
}

/**
 * Resolve a handle back to a customer. Compares handles rather than storing them,
 * so no schema change and nothing extra to keep in sync. Active customers only.
 */
export function resolveCustomerHandle(db, handle, opts = {}) {
  const h = String(handle ?? '').trim();
  if (!h) return null;
  const rows = db.prepare('SELECT id, odoo_customer_ref, name FROM customers WHERE is_active = 1').all();
  return rows.find((r) => customerHandle(customerKey(r), opts.secret) === h) || null;
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
    `SELECT id, odoo_customer_ref, name FROM customers
      WHERE is_active = 1 AND UPPER(name) LIKE UPPER(?)
      ORDER BY name COLLATE NOCASE LIMIT ?`
  ).all(`%${q}%`, max);

  // Built field-by-field: a column added to `customers` later cannot leak. Note
  // what is NOT here — id, odoo id, email, phone, country and pricelist all stay
  // server-side.
  return {
    items: rows.map((r) => ({ handle: customerHandle(customerKey(r), opts.secret), name: r.name })),
    minQueryLength: min,
  };
}

export default {
  importCustomers, previewCustomerImport, searchCustomers,
  mapCustomerHeaders, normalizeCustomer, customerHandle, customerKey,
};
