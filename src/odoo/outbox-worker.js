// The outbox worker: the ONLY thing that writes to Odoo, and it writes exactly two kinds of record.
//
//   DRAFT_QUOTATION  a draft sale.order for a customer's request (no price: Odoo works it out)
//   CREATE_PARTNER   a new res.partner, only after the Sales Manager approved the registration
//
// How it stays safe when Odoo is slow, down, or answers late (section 7.2 of the specification):
//   - It first SEARCHES Odoo for a quotation whose client_order_ref is this BFL reference (or a customer whose
//     ref is this registration reference). Found: it links to it and does not create another. So a call that
//     timed out AFTER Odoo created the record — or a retry — can never make a second one.
//   - Odoo not answering: the entry stays PENDING and is retried after 1, 5, 15 and 60 minutes, then hourly.
//   - After 24 hours of failures, or any REJECTION by Odoo (an archived product, a missing right), the entry
//     becomes FAILED, and staff see it on the health screen with the reason and a Retry button.
//   - A quotation for a customer who is not in Odoo yet waits for that customer's own entry; it does not fail.
//   - It never confirms, sends or cancels an order, edits a customer, or sends a price: the client refuses
//     anything else (see client.js), and the Odoo user's rights make it impossible too.
import { OdooUnavailableError, OdooRejectedError } from './client.js';

export const BACKOFF_MINUTES = [1, 5, 15, 60];
export const GIVE_UP_AFTER_HOURS = 24;
const iso = (d) => d.toISOString();

/** When the entry may next be tried, after its Nth failed attempt (1-based). */
export function nextAttemptAfter(failures, now = new Date()) {
  const minutes = BACKOFF_MINUTES[Math.min(failures, BACKOFF_MINUTES.length) - 1] ?? 60;
  return new Date(now.getTime() + minutes * 60_000);
}

class Wait extends Error { constructor(why) { super(why); this.wait = true; } }

// ---------------------------------------------------------------------------------------------
// looking things up in Odoo (small caches per run, so one worker pass is a handful of calls)
// ---------------------------------------------------------------------------------------------
function lookups(client) {
  const products = new Map(); const users = new Map(); const pricelists = new Map();
  return {
    async product(barcode) {
      if (!products.has(barcode)) {
        const found = await client.searchRead('product.product', [['barcode', '=', barcode], ['active', 'in', [true, false]]], ['id', 'name', 'active'], { limit: 1 });
        products.set(barcode, found[0] || null);
      }
      const p = products.get(barcode);
      if (!p) throw new OdooRejectedError(`Product ${barcode} does not exist in Odoo.`, { code: 'NO_PRODUCT' });
      if (p.active === false) throw new OdooRejectedError(`The product "${p.name}" is archived in Odoo and cannot be ordered.`, { code: 'ARCHIVED_PRODUCT' });
      return p.id;
    },
    async user(name) {
      if (!name) return null;
      if (!users.has(name)) users.set(name, (await client.searchRead('res.users', [['name', '=', name]], ['id'], { limit: 1 }))[0]?.id ?? null);
      return users.get(name);
    },
    async pricelist(name) {
      if (!name) return null;
      if (!pricelists.has(name)) pricelists.set(name, (await client.searchRead('product.pricelist', [['name', '=', name]], ['id'], { limit: 1 }))[0]?.id ?? null);
      return pricelists.get(name);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// sending one entry
// ---------------------------------------------------------------------------------------------
async function sendQuotation(db, client, entry, cfg, look) {
  const v = entry.payload.values;
  const ref = v.client_order_ref;
  // already there from an earlier attempt? link, do not create
  const existing = (await client.searchRead('sale.order', [['client_order_ref', '=', ref]], ['id', 'name', 'state', 'amount_total'], { limit: 1 }))[0];
  let order = existing;
  if (!order) {
    // who is it for? a cash buyer goes on the shared cash account; anyone else needs their Odoo id
    let partnerId;
    let note = v.note || '';
    if (v.partner?.shared) {
      if (!cfg.cashPartnerId) throw new OdooRejectedError('The shared cash account\'s Odoo id is not configured (BFL_ODOO_CASH_PARTNER_ID).', { code: 'NO_CASH_ACCOUNT' });
      partnerId = cfg.cashPartnerId;
    } else {
      const req = db.prepare('SELECT c.id, c.odoo_customer_ref, c.salesperson FROM requests r JOIN customers c ON c.id = r.customer_id WHERE r.reference = ?').get(ref);
      if (!req) throw new OdooRejectedError(`No BFL request has the reference ${ref}.`, { code: 'NO_REQUEST' });
      if (!req.odoo_customer_ref) throw new Wait('The customer is not in Odoo yet; waiting for their own entry.');
      partnerId = Number(req.odoo_customer_ref);
      v.__salesperson = req.salesperson;
    }
    const lines = [];
    for (const l of v.lines) {
      // cartons, and NO price. A clearance line also carries its discount and names its lot; Odoo still works out the price
      const line = { product_id: await look.product(l.barcode), product_uom_qty: l.cartons };
      if (l.discount) { line.discount = l.discount; line.name = `${l.product} — ${l.note || `lot ${l.lot}`}`; }
      lines.push([0, 0, line]);
    }
    if (v.delivery_address) note = `${note ? `${note}\n` : ''}Deliver to: ${v.delivery_address}`;
    const values = { partner_id: partnerId, client_order_ref: ref, origin: 'BFL Platform', note, order_line: lines };
    const userId = await look.user(v.__salesperson);
    if (userId) values.user_id = userId;
    const id = await client.create('sale.order', values);
    order = (await client.searchRead('sale.order', [['id', '=', id]], ['id', 'name', 'state', 'amount_total'], { limit: 1 }))[0] || { id, name: null, amount_total: null };
  }
  // record what Odoo has (its number is what the customer is shown), then mark the entry sent
  const now = iso(new Date());
  const orderRow = db.prepare('SELECT id, state FROM odoo_orders WHERE request_id = (SELECT id FROM requests WHERE reference = ?)').get(ref);
  if (orderRow && orderRow.state === 'RECEIVED') {
    db.prepare(`UPDATE odoo_orders SET odoo_number = ?, state = 'WAITING_FOR_APPROVAL', sent_at = ?, amount_open = COALESCE(?, amount_open), updated_at = ? WHERE id = ?`)
      .run(order.name || null, now, typeof order.amount_total === 'number' ? order.amount_total : null, now, orderRow.id);
  }
  return { odooId: order.id, odooNumber: order.name || null, linked: Boolean(existing) };
}

async function sendPartner(db, client, entry, cfg, look) {
  const v = entry.payload.values;
  const existing = (await client.searchRead('res.partner', [['ref', '=', v.ref], ['active', 'in', [true, false]]], ['id', 'name'], { limit: 1 }))[0];
  let id = existing?.id;
  if (!id) {
    const values = { name: v.name, ref: v.ref, is_company: true, phone: v.phone || false, email: v.email || false, street: v.street || false };
    const userId = await look.user(v.salesperson);
    if (userId) values.user_id = userId;
    const plId = await look.pricelist(v.pricelist);
    if (plId) values.property_product_pricelist = plId;
    id = await client.create('res.partner', values);                    // no credit limit: the Sales Manager sets it in Odoo
  }
  // the customer now has an Odoo id: it is what they sign in with, and what their quotations are addressed to
  db.prepare("UPDATE customers SET odoo_customer_ref = ?, updated_at = ? WHERE registration_ref = ? AND (odoo_customer_ref IS NULL OR odoo_customer_ref = '')").run(String(id), iso(new Date()), v.ref);
  return { odooId: id, odooNumber: null, linked: Boolean(existing) };
}

/**
 * One pass over what is due. Resolves with counts; never throws for an entry's own failure.
 */
export async function runOutbox(db, client, { now = new Date(), cashPartnerId = null, limit = 25 } = {}) {
  const cfg = { cashPartnerId };
  const due = db.prepare(`SELECT id, kind, dedupe_key, payload, attempts, first_attempt_at FROM odoo_outbox
                           WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                           ORDER BY (kind = 'CREATE_PARTNER') DESC, id LIMIT ?`).all(iso(now), limit);
  const out = { sent: 0, linked: 0, retry: 0, failed: 0, waiting: 0 };
  const look = lookups(client);
  for (const row of due) {
    const entry = { ...row, payload: JSON.parse(row.payload) };
    try {
      const r = entry.kind === 'CREATE_PARTNER' ? await sendPartner(db, client, entry, cfg, look) : await sendQuotation(db, client, entry, cfg, look);
      db.prepare(`UPDATE odoo_outbox SET status = 'SENT', attempts = attempts + 1, sent_at = ?, last_error = NULL, odoo_id = ?, odoo_number = ?, next_attempt_at = NULL WHERE id = ?`)
        .run(iso(now), r.odooId, r.odooNumber, row.id);
      out.sent += 1; if (r.linked) out.linked += 1;
    } catch (e) {
      if (e?.wait) { out.waiting += 1; db.prepare('UPDATE odoo_outbox SET next_attempt_at = ?, last_error = ? WHERE id = ?').run(iso(new Date(now.getTime() + 60_000)), e.message, row.id); continue; }
      const message = String(e?.message || e).slice(0, 300);
      const failures = (row.attempts || 0) + 1;
      const first = row.first_attempt_at || iso(now);
      const gaveUp = (now - new Date(first)) / 3_600_000 >= GIVE_UP_AFTER_HOURS;
      if (e instanceof OdooUnavailableError && !gaveUp) {
        db.prepare("UPDATE odoo_outbox SET attempts = ?, first_attempt_at = ?, last_error = ?, next_attempt_at = ? WHERE id = ?")
          .run(failures, first, message, iso(nextAttemptAfter(failures, now)), row.id);
        out.retry += 1;
      } else {
        // a rejection (or 24 hours of trying) is final: staff are told, and Retry on the health screen puts it back
        db.prepare("UPDATE odoo_outbox SET status = 'FAILED', attempts = ?, first_attempt_at = ?, last_error = ?, next_attempt_at = NULL WHERE id = ?")
          .run(failures, first, e instanceof OdooRejectedError ? message : `${message} (gave up after ${GIVE_UP_AFTER_HOURS} hours)`, row.id);
        out.failed += 1;
      }
    }
  }
  return out;
}

/** Put a FAILED entry back in the queue (the Retry button). Nothing is lost: it keeps its reference, so it cannot duplicate. */
export function retryOutbox(db, id, now = new Date()) {
  const r = db.prepare('SELECT id, status FROM odoo_outbox WHERE id = ?').get(Number(id));
  if (!r) return null;
  if (r.status !== 'FAILED') return { ok: false, reason: 'Only a failed entry can be retried.' };
  db.prepare("UPDATE odoo_outbox SET status = 'PENDING', next_attempt_at = NULL, first_attempt_at = NULL, attempts = 0, last_error = NULL WHERE id = ?").run(r.id);
  return { ok: true };
}
