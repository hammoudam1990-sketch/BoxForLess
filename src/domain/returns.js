// Returns for damage or expiry (W4, screen S04 "Returns to classify").
//
// Returns are handled in ODOO: a return delivery goes to a quarantine location — never back into sellable
// stock — and Finance issues the credit note. BFL only READS them, so the reports and the shop-shelf alerts
// stay right. What BFL adds is the REASON (Damaged, Expired or Other): Odoo has no such field, so a person
// records it here against every return, within 3 days. In BFL:
//   - returned cartons are subtracted from the customer's shelf records and the matching alert closes as
//     Returned (see shelf.js);
//   - a return for EXPIRY on a lot where the customer had AGREED a discount is flagged to the Sales Manager,
//     with the agreement record and the credit note already given (the agreement was broken).
// Nothing here writes to Odoo, and nothing is deleted.
import { toDay } from './expiry.js';
import { shelfRecords, ShelfState } from './shelf.js';

export const ReturnReason = Object.freeze({ DAMAGED: 'DAMAGED', EXPIRED: 'EXPIRED', OTHER: 'OTHER' });
export const REASON_LABEL = Object.freeze({ DAMAGED: 'Damaged', EXPIRED: 'Expired', OTHER: 'Other' });
/** A return should have its reason within this many days of arriving; after that it shows on the dashboard. */
export const CLASSIFY_WITHIN_DAYS = 3;

export class ReturnError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ReturnError'; this.status = status; }
}

const money = (n) => Math.round(Number(n) * 100) / 100;

function linesOf(db, returnId) {
  return db.prepare('SELECT product_name AS product, barcode, lot_name AS lot, cartons FROM odoo_return_lines WHERE return_id = ? ORDER BY id').all(returnId);
}

/** The approved discount agreements, keyed by "<customer>|<barcode>|<lot>", newest first. */
function agreements(db) {
  const rows = db.prepare(`
    SELECT l.id, l.record_key, l.cartons_on_shelf, l.discount_pct, l.contact_name, l.approved_at, l.credit_note_ref, v.visited_on
      FROM shelf_visit_lines l JOIN shelf_visits v ON v.id = l.visit_id
     WHERE l.outcome = 'DISCOUNT_AGREED' AND l.approval_status = 'APPROVED' ORDER BY l.id DESC`).all();
  const out = new Map();
  for (const r of rows) {
    const [cust, barcode, lot] = r.record_key.split('|');
    const k = `${cust}|${barcode}|${lot}`;
    if (!out.has(k)) out.set(k, r);
  }
  return out;
}

/**
 * A return of cartons that were sold at a clearance discount. Those cartons are not returnable (the customer is told so
 * before ordering and on the quotation). A return line only counts when the cartons sent back on that order for that
 * product, this return included, are more than the cartons that were NOT on the discount: Odoo does not say which
 * cartons came back, so the ordinary ones are assumed to go first.
 * @returns {null | {kind:'CLEARANCE', product:string, lot:string, discountPct:number, agreedBy:string, agreedOn:string, approvedAt:null, creditNoteGiven:string|null}}
 */
function clearanceBreak(db, r, lines, creditNotes) {
  if (r.customer_kind !== 'BFL' || !r.sales_order) return null;
  const order = db.prepare('SELECT request_id, received_at FROM odoo_orders WHERE odoo_number = ?').get(r.sales_order);
  if (!order) return null;
  for (const l of lines) {
    const it = db.prepare(`SELECT COALESCE(SUM(quantity_ctn), 0) q, COALESCE(SUM(clearance_cartons), 0) c, MAX(clearance_pct) pct, MAX(clearance_lot_name) lot
                            FROM request_items WHERE request_id = ? AND barcode_at_request = ?`).get(order.request_id, l.barcode);
    if (!it || !it.c) continue;
    const back = db.prepare(`SELECT COALESCE(SUM(x.cartons), 0) n FROM odoo_return_lines x JOIN odoo_returns y ON y.id = x.return_id
                              WHERE y.customer_kind = 'BFL' AND y.sales_order = ? AND x.barcode = ? AND y.id <= ?`).get(r.sales_order, l.barcode, r.id).n;
    if (back > it.q - it.c) {
      return {
        kind: 'CLEARANCE', product: l.product, lot: it.lot, discountPct: it.pct, agreedBy: `order ${r.sales_order} (clearance offer, not returnable)`,
        agreedOn: String(order.received_at).slice(0, 10), approvedAt: null, creditNoteGiven: creditNotes[0]?.number || null,
      };
    }
  }
  return null;
}

/** Everything the Returns screen shows. */
export function listReturns(db, todayStr) {
  const today = toDay(todayStr);
  const rows = db.prepare(`
    SELECT r.id, r.number, r.customer_kind, r.customer_ref, r.customer_name, r.rep_name, r.sales_order, r.received_on,
           c.reason, c.note, c.classified_by, c.classified_at
      FROM odoo_returns r LEFT JOIN return_classifications c ON c.return_id = r.id ORDER BY r.received_on DESC, r.id DESC LIMIT 200`).all();
  const agree = agreements(db);
  const notes = db.prepare('SELECT return_id, number, amount, kind, issued_on FROM odoo_credit_notes WHERE return_id IS NOT NULL').all();

  const all = rows.map((r) => {
    const lines = linesOf(db, r.id);
    const age = today - toDay(r.received_on);
    const cn = notes.filter((n) => n.return_id === r.id);
    // an expiry return on a lot where the customer had agreed a discount: the agreement was broken
    let broken = null;
    if (r.reason === ReturnReason.EXPIRED && r.customer_kind === 'SHELF') {
      for (const l of lines) {
        const a = agree.get(`${r.customer_ref}|${l.barcode}|${l.lot}`);
        if (a) {
          broken = {
            kind: 'SHELF', product: l.product, lot: l.lot, discountPct: a.discount_pct, agreedBy: a.contact_name, agreedOn: a.visited_on,
            approvedAt: a.approved_at, creditNoteGiven: a.credit_note_ref || null,
          };
          break;
        }
      }
    }
    // clearance cartons were sold as not returnable: any return of them breaks that, whatever the reason given
    if (!broken) broken = clearanceBreak(db, r, lines, cn);
    return {
      id: r.id, number: r.number, customer: r.customer_name, rep: r.rep_name, salesOrder: r.sales_order, receivedOn: r.received_on,
      ageDays: age, lines, cartons: lines.reduce((n, l) => n + l.cartons, 0),
      reason: r.reason, reasonLabel: r.reason ? REASON_LABEL[r.reason] : null, note: r.note, classifiedBy: r.classified_by, classifiedAt: r.classified_at,
      overdue: !r.reason && age >= CLASSIFY_WITHIN_DAYS,
      creditNotes: cn.map((n) => ({ number: n.number, amount: n.amount, issuedOn: n.issued_on })),
      brokenAgreement: broken,
    };
  });

  const { shelf, records } = shelfRecords(db, todayStr);
  const repOf = new Map(shelf.customers.map((c) => [c.id, shelf.reps.find((x) => x.id === c.repId)?.name]));
  const expected = records.filter((r) => r.state === ShelfState.RETURN_EXPECTED).map((r) => ({
    customer: shelf.customers.find((c) => c.id === r.customerId)?.name, rep: repOf.get(r.customerId) || null,
    product: r.productName, lot: r.lotName, cartons: r.cartonsOnShelf, expiryDate: r.expiryDate,
  }));

  const unclassified = all.filter((r) => !r.reason).sort((a, b) => b.ageDays - a.ageDays);
  return {
    source: 'SAMPLE', asOf: todayStr,
    unclassified,
    classified: all.filter((r) => r.reason),
    expected,
    brokenAgreements: all.filter((r) => r.brokenAgreement),
    counts: { unclassified: unclassified.length, overdue: unclassified.filter((r) => r.overdue).length, expected: expected.length },
  };
}

/** How many returns have waited more than the allowed days without a reason (the dashboard alert). */
export function overdueUnclassified(db, todayStr) {
  const today = toDay(todayStr);
  return db.prepare(`SELECT r.received_on FROM odoo_returns r LEFT JOIN return_classifications c ON c.return_id = r.id WHERE c.return_id IS NULL`)
    .all().filter((r) => today - toDay(r.received_on) >= CLASSIFY_WITHIN_DAYS).length;
}

/** Record (or change) the reason for a return. Anyone in the warehouse team may; the person and time are kept. */
export function classifyReturn(db, id, { reason, note } = {}, by = null, now = new Date()) {
  const r = db.prepare('SELECT id FROM odoo_returns WHERE id = ?').get(Number(id));
  if (!r) throw new ReturnError('That return does not exist.', 404);
  if (!Object.values(ReturnReason).includes(reason)) throw new ReturnError('Choose damaged, expired or other.');
  const text = String(note ?? '').trim().slice(0, 300) || null;
  if (reason === ReturnReason.OTHER && !text) throw new ReturnError('Say what the other reason is.');
  db.prepare(`INSERT INTO return_classifications (return_id, reason, note, classified_by, classified_at) VALUES (?,?,?,?,?)
              ON CONFLICT(return_id) DO UPDATE SET reason = excluded.reason, note = excluded.note, classified_by = excluded.classified_by, classified_at = excluded.classified_at`)
    .run(r.id, reason, text, by, now.toISOString());
  return { id: r.id, reason, note: text };
}

export { money };
