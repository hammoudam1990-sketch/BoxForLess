// Customer-shelf expiry (W2): the lots delivered to each customer, the alerts they raise, the
// shop visits a sales rep records, and the Sales Manager's approval of a proposed discount.
//
// SAMPLE DATA stands in for Odoo (done deliveries and the customer-to-salesperson assignment):
// `loadShelf` is the one function that changes when the Odoo sync exists. Nothing here writes
// to Odoo. A discount agreed on a visit is only a PROPOSAL until the Sales Manager approves it;
// the credit note itself is issued by Finance in Odoo, and `recordCreditNote` is the manual
// stand-in for BFL finding that credit note in the next sync.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import {
  VisitOutcome, ShelfAlertKind, toDay, formatDay, daysLeft, shelfAlertStatus, nextCheckDate,
  validateDiscountPercent,
} from './expiry.js';
import { sampleSettings } from './expiry-sample.js';
import { cartonPriceFor } from './prices.js';
import { allReps, overlayShelf } from './reps.js';
import { activeDiscounts, setLotDiscount, removeLotDiscount, DiscountKind } from './lot-discounts.js';

export class ShelfError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'ShelfError'; this.status = status; }
}

/** An open alert is overdue once its visit was due more than this many days ago. (Proposed — Sales to confirm.) */
export const OVERDUE_AFTER_DAYS = 7;

/** What a shelf record is waiting for. */
export const ShelfState = Object.freeze({
  OPEN: 'OPEN',                                // needs a visit
  CLOSED_SOLD: 'CLOSED_SOLD',                  // "checked, sold"
  DISCOUNT_PENDING: 'DISCOUNT_PENDING',        // agreed on a visit, waiting for the Sales Manager
  DISCOUNT_APPROVED: 'DISCOUNT_APPROVED',      // approved; Finance issues the credit note in Odoo
  CLOSED_CREDIT_NOTE: 'CLOSED_CREDIT_NOTE',    // credit note found; alert closed with its number
  RETURN_EXPECTED: 'RETURN_EXPECTED',          // the customer refused; moves to W4 (returns)
  CLOSED_RETURNED: 'CLOSED_RETURNED',          // the lot came back (a return delivery in Odoo): the alert closes as Returned
});

export const ApprovalStatus = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED' });

const FIXTURE = path.join(config.root, 'fixtures', 'shelf-sample.json');
const todayDay = (today) => {
  const t = toDay(today);
  if (t === null) throw new RangeError('today must be a date');
  return t;
};
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// the data (sample for now)
// ---------------------------------------------------------------------------

/** How BFL names a delivered lot: "<customer>|<barcode>|<lot>|<sales order>". */
export const shelfKey = (r) => `${r.customerId}|${r.barcode}|${r.lotName}|${r.salesOrder}`;

/** @returns {{source:'DATABASE'|'SAMPLE', reps:object[], customers:object[], records:object[]}} */
export function loadShelf(today, db = null) {
  const t = todayDay(today);

  if (db) {
    try {
      const lotCount = db.prepare('SELECT COUNT(*) AS n FROM delivery_lots').get()?.n || 0;
      if (lotCount > 0) {
        const rows = db.prepare(`
          SELECT l.id, l.customer_id, l.lot_code, l.delivered_ctn, l.expiry_date,
                 l.delivered_at, l.created_at,
                 p.name AS product_name, p.barcode,
                 COALESCE(cat.path, 'FOOD / GENERAL') AS category_path,
                 'SO-' || l.customer_id || '-' || l.id AS sales_order
            FROM delivery_lots l
            JOIN products p ON p.id = l.product_id
            LEFT JOIN categories cat ON cat.id = p.category_id
           ORDER BY l.expiry_date
        `).all();

        const dbCusts = db.prepare(`
          SELECT c.id, c.name, COALESCE(c.odoo_customer_ref, CAST(c.id AS TEXT)) AS odooId,
                 c.phone, c.delivery_address,
                 COALESCE(sr.rep_id, 'rep-1') AS repId
            FROM customers c
            LEFT JOIN shop_reps sr ON sr.customer_id = c.id
           WHERE c.is_active = 1
        `).all();

        const reps = allReps(db);

        const records = rows.map((r) => {
          const rec = {
            customerId: r.customer_id,
            salesOrder: r.sales_order,
            productName: r.product_name,
            barcode: r.barcode,
            lotName: r.lot_code,
            categoryPath: r.category_path,
            deliveredCartons: r.delivered_ctn,
            deliveredOn: (r.delivered_at || r.created_at || '').slice(0, 10) || formatDay(t - 30),
            expiryDate: r.expiry_date,
          };
          return { ...rec, key: shelfKey(rec) };
        });

        return {
          source: 'DATABASE',
          reps,
          customers: dbCusts.map((c) => ({
            id: c.id,
            odooId: c.odooId,
            name: c.name,
            repId: c.repId,
            phone: c.phone || null,
            deliveryAddress: c.delivery_address || null,
          })),
          records,
        };
      }
    } catch { /* fallback to sample */ }
  }

  const raw = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const customers = raw.customers.map((c) => ({ id: c.id, odooId: c.id, name: c.name, repId: c.repId }));
  const records = raw.records.map((r) => {
    const rec = {
      customerId: r.customerId, salesOrder: r.salesOrder, productName: r.productName, barcode: r.barcode,
      lotName: r.lotName, categoryPath: r.categoryPath, deliveredCartons: r.deliveredCartons,
      deliveredOn: formatDay(t - r.deliveredDaysAgo), expiryDate: formatDay(t + r.expiresInDays),
    };
    return { ...rec, key: shelfKey(rec) };
  });
  return { source: 'SAMPLE', reps: raw.reps, customers, records };
}

// ---------------------------------------------------------------------------
// where each record stands
// ---------------------------------------------------------------------------

/** The latest visit line per shelf record. */
function latestLines(db) {
  const rows = db.prepare(`
    SELECT l.id, l.record_key, l.cartons_on_shelf, l.outcome, l.discount_pct, l.contact_name, l.agreement,
           l.approval_status, l.approval_reason, l.approved_at, l.credit_note_ref, l.return_reason, l.return_note,
           l.created_at, v.visited_on, v.rep_id
      FROM shelf_visit_lines l JOIN shelf_visits v ON v.id = l.visit_id
     WHERE l.id IN (SELECT MAX(id) FROM shelf_visit_lines GROUP BY record_key)`).all();
  return new Map(rows.map((r) => [r.record_key, r]));
}

/** Cartons that came back, per delivered lot ("<customer>|<barcode>|<lot>"), from the return deliveries BFL has read. */
function returnedCartons(db) {
  const rows = db.prepare(`SELECT r.customer_ref AS cust, l.barcode, l.lot_name AS lot, SUM(l.cartons) AS n
                             FROM odoo_return_lines l JOIN odoo_returns r ON r.id = l.return_id
                            WHERE r.customer_kind = 'SHELF' GROUP BY r.customer_ref, l.barcode, l.lot_name`).all();
  return new Map(rows.map((r) => [`${r.cust}|${r.barcode}|${r.lot}`, r.n]));
}

/** Work out a record's state, next visit date and so on from its alert and its latest visit line. */
function describe(record, line, today, settings, returned = 0) {
  const left = daysLeft(record.expiryDate, today);
  const alert = shelfAlertStatus({ expiryDate: record.expiryDate, categoryPath: record.categoryPath, today, settings });
  const alerting = alert.current !== null || alert.expired;
  const alertDate = alert.alerts.filter((a) => a.due).pop()?.date ?? alert.alerts[0]?.date ?? null;

  let state = ShelfState.OPEN;
  let dueOn = alertDate;
  let rejectedReason = null;
  let cartonsOnShelf = record.deliveredCartons;

  if (line) {
    if (line.cartons_on_shelf !== null && line.cartons_on_shelf !== undefined) cartonsOnShelf = line.cartons_on_shelf;
    if (line.outcome === VisitOutcome.SOLD_OUT) state = ShelfState.CLOSED_SOLD;
    else if (line.outcome === VisitOutcome.RETURN_EXPECTED) state = ShelfState.RETURN_EXPECTED;
    else if (line.outcome === VisitOutcome.NOT_CHECKED) dueOn = nextCheckDate(line.visited_on);
    else if (line.outcome === VisitOutcome.DISCOUNT_AGREED) {
      if (line.approval_status === ApprovalStatus.PENDING) state = ShelfState.DISCOUNT_PENDING;
      else if (line.approval_status === ApprovalStatus.APPROVED) state = line.credit_note_ref ? ShelfState.CLOSED_CREDIT_NOTE : ShelfState.DISCOUNT_APPROVED;
      else if (line.approval_status === ApprovalStatus.REJECTED) {
        rejectedReason = line.approval_reason;      // goes back to the rep with the reason: visit again
        dueOn = line.approved_at ? line.approved_at.slice(0, 10) : dueOn;
      }
    }
  }
  // Returned cartons are subtracted from the shelf record; a lot that came back (or was refused and now has)
  // closes its alert as Returned.
  if (returned > 0) {
    const net = Math.max(0, record.deliveredCartons - returned);
    cartonsOnShelf = Math.min(cartonsOnShelf, net);
    if (state === ShelfState.RETURN_EXPECTED || net <= 0) state = ShelfState.CLOSED_RETURNED;
  }
  const overdue = state === ShelfState.OPEN && dueOn !== null && toDay(dueOn) + OVERDUE_AFTER_DAYS < toDay(today);
  return {
    ...record, daysLeft: left, alerting, alertKind: alert.current, expired: alert.expired,
    state, dueOn, overdue, rejectedReason, cartonsOnShelf, returned, lastLineId: line?.id ?? null,
    returnReason: line?.return_reason ?? null, returnNote: line?.return_note ?? null,
  };
}

/** Every shelf record with its state. */
function describeAll(db, today, shelf, settings) {
  const lines = latestLines(db);
  const back = returnedCartons(db);
  return shelf.records.map((r) => describe(r, lines.get(r.key) || null, today, settings, back.get(`${r.customerId}|${r.barcode}|${r.lotName}`) || 0));
}

const isOpenAlert = (r) => r.alerting && r.state === ShelfState.OPEN;

/** How the Sales Manager's shelf discount names a lot: the same "<barcode>|<lot name>" as the Expiry list. */
const shelfLotKey = (r) => `${r.barcode}|${r.lotName}`;

function requireRep(shelf, repId) {
  const rep = shelf.reps.find((r) => r.id === repId);
  if (!rep) throw new ShelfError('Choose which sales rep you are.', 400);
  return rep;
}

// ---------------------------------------------------------------------------
// R01 — My visits
// ---------------------------------------------------------------------------

/** Every shelf record with its state (for returns and the reports). */
export function shelfRecords(db, today, { loader = loadShelf, settings = sampleSettings() } = {}) {
  const shelf = overlayShelf(db, loader(today));
  return { shelf, records: describeAll(db, today, shelf, settings) };
}

/** The sales reps: the sample reps plus every rep account (pass db), else just the sample ones. */
export function listReps(today, db = null) { return db ? allReps(db) : loadShelf(today).reps; }

/**
 * The shops with open expiry alerts for one rep, nearest expiry first.
 * Only the rep's own customers appear.
 */
export function myVisits(db, repId, { today, q = '', loader = loadShelf, settings = sampleSettings() } = {}) {
  const shelf = overlayShelf(db, loader(today, db));
  const rep = requireRep(shelf, repId);
  const mine = shelf.customers.filter((c) => c.repId === rep.id);
  const records = describeAll(db, today, shelf, settings).filter((r) => mine.some((c) => c.id === r.customerId));

  const needle = String(q).trim().toLowerCase();
  const matchesQ = (c) => !needle || String(c.odooId).includes(needle) || c.name.toLowerCase().includes(needle);

  const customers = mine.filter(matchesQ).map((c) => {
    const open = records.filter((r) => r.customerId === c.id && isOpenAlert(r));
    const nearest = open.reduce((a, r) => (a === null || r.daysLeft < a.daysLeft ? r : a), null);
    return {
      id: c.id, odooId: c.odooId, name: c.name,
      phone: c.phone || null,
      deliveryAddress: c.deliveryAddress || null,
      openAlerts: open.length,
      overdueAlerts: open.filter((r) => r.overdue).length,
      cartonsAtRisk: open.reduce((n, r) => n + r.cartonsOnShelf, 0),
      nearestExpiry: nearest?.expiryDate ?? null,
      nearestDaysLeft: nearest?.daysLeft ?? null,
    };
  });
  // shops with alerts first (nearest expiry first), then the rest by name
  customers.sort((a, b) => {
    if ((a.openAlerts > 0) !== (b.openAlerts > 0)) return a.openAlerts > 0 ? -1 : 1;
    if (a.openAlerts > 0) return a.nearestDaysLeft - b.nearestDaysLeft;
    return a.name.localeCompare(b.name);
  });
  return {
    source: shelf.source, asOf: today, rep, customers,
    totals: {
      shops: customers.filter((c) => c.openAlerts > 0).length,
      lots: customers.reduce((n, c) => n + c.openAlerts, 0),
      overdue: customers.reduce((n, c) => n + c.overdueAlerts, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// R02 — the visit form
// ---------------------------------------------------------------------------

function ownCustomer(shelf, repId, customerId) {
  const customer = shelf.customers.find((c) => c.id === Number(customerId));
  // a customer that is not this rep's looks exactly like one that does not exist
  if (!customer || customer.repId !== repId) throw new ShelfError('That customer is not on your list.', 403);
  return customer;
}

/** The open alerts for one of the rep's customers, ready for the visit form. */
export function visitSheet(db, repId, customerId, { today, loader = loadShelf, settings = sampleSettings() } = {}) {
  const shelf = overlayShelf(db, loader(today, db));
  const rep = requireRep(shelf, repId);
  const customer = ownCustomer(shelf, rep.id, customerId);
  const offers = activeDiscounts(db, DiscountKind.SHELF);
  const lots = describeAll(db, today, shelf, settings)
    .filter((r) => r.customerId === customer.id && isOpenAlert(r))
    .sort((a, b) => a.daysLeft - b.daysLeft)
    .map((r) => ({
      key: r.key, productName: r.productName, barcode: r.barcode, lotName: r.lotName,
      expiryDate: r.expiryDate, daysLeft: r.daysLeft, expired: r.expired, salesOrder: r.salesOrder,
      deliveredOn: r.deliveredOn, deliveredCartons: r.deliveredCartons, cartonsOnShelf: r.cartonsOnShelf,
      alertKind: r.alertKind, overdue: r.overdue, dueOn: r.dueOn, rejectedReason: r.rejectedReason,
      // the discount the Sales Manager has put on this lot for the shelves that hold it, or null
      managerDiscountPct: offers.get(shelfLotKey(r))?.pct ?? null,
    }));
  return { source: shelf.source, asOf: today, rep, customer: { id: customer.id, odooId: customer.odooId, name: customer.name }, lots };
}

const OUTCOMES = Object.values(VisitOutcome);

/**
 * Record a shop visit: one line per lot. Nothing is saved unless every line is valid.
 * @param {{key:string, cartonsOnShelf?:number, outcome:string, discountPct?:number, contactName?:string, agreed?:boolean}[]} lines
 */
export function recordVisit(db, repId, customerId, lines, { today, loader = loadShelf, settings = sampleSettings() } = {}) {
  const shelf = overlayShelf(db, loader(today, db));
  const rep = requireRep(shelf, repId);
  const customer = ownCustomer(shelf, rep.id, customerId);
  if (!Array.isArray(lines) || lines.length === 0) throw new ShelfError('Record at least one lot.');

  const open = new Map(describeAll(db, today, shelf, settings)
    .filter((r) => r.customerId === customer.id && isOpenAlert(r)).map((r) => [r.key, r]));
  const offers = activeDiscounts(db, DiscountKind.SHELF);
  const seen = new Set();
  const clean = lines.map((l, i) => {
    const where = `Lot ${i + 1}`;
    const record = open.get(l?.key);
    if (!record) throw new ShelfError(`${where}: that lot is not waiting for a visit at this customer.`);
    if (seen.has(l.key)) throw new ShelfError(`${where}: the same lot is listed twice.`);
    seen.add(l.key);
    if (!OUTCOMES.includes(l.outcome)) throw new ShelfError(`${where}: choose what happened.`);

    const out = { recordKey: l.key, outcome: l.outcome, cartons: null, discountPct: null, contactName: null, agreement: 0, approval: null, offeredPct: null, autoApproved: false, returnReason: null, returnNote: null };
    if (l.outcome === VisitOutcome.SOLD_OUT) out.cartons = 0;
    if (l.outcome === VisitOutcome.DISCOUNT_AGREED || l.outcome === VisitOutcome.RETURN_EXPECTED) {
      const n = Number(l.cartonsOnShelf);
      if (!Number.isInteger(n) || n < 1) throw new ShelfError(`${where}: enter how many cartons are still on the shelf (at least 1; if none, choose "sold out").`);
      if (n > record.deliveredCartons) throw new ShelfError(`${where}: only ${record.deliveredCartons} cartons were delivered.`);
      out.cartons = n;
    }
    if (l.outcome === VisitOutcome.RETURN_EXPECTED) {
      if (l.returnReason !== undefined) {
        const rr = String(l.returnReason || '').trim().toUpperCase();
        if (!['DAMAGED', 'EXPIRED', 'OTHER'].includes(rr)) {
          throw new ShelfError(`${where}: choose a reason for the return (damaged, expired, or other).`);
        }
        const rn = String(l.returnNote ?? '').trim().slice(0, 300) || null;
        if (rr === 'OTHER' && !rn) {
          throw new ShelfError(`${where}: enter a note explaining the other return reason.`);
        }
        out.returnReason = rr;
        out.returnNote = rn;
      } else {
        out.returnReason = 'EXPIRED';
      }
    }
    if (l.outcome === VisitOutcome.DISCOUNT_AGREED) {
      // the Sales Manager may already have put a discount on this lot: with none typed, the rep offers that one
      const offer = offers.get(shelfLotKey(record)) || null;
      const typed = l.discountPct === null || l.discountPct === undefined || l.discountPct === '';
      const d = validateDiscountPercent(typed && offer ? offer.pct : l.discountPct);
      if (!d.ok) throw new ShelfError(`${where}: ${d.error}`);
      const contact = String(l.contactName ?? '').trim();
      if (contact.length < 2 || contact.length > 80) throw new ShelfError(`${where}: enter the name of the customer's contact who agreed.`);
      if (l.agreed !== true) throw new ShelfError(`${where}: the customer's contact must confirm that this lot will not be returned for expiry.`);
      // within what the Sales Manager already offered: approved now (Finance issues the credit note). Above it: the Sales Manager decides.
      const within = Boolean(offer) && d.value <= offer.pct;
      Object.assign(out, {
        discountPct: d.value, contactName: contact, agreement: 1, offeredPct: offer ? offer.pct : null,
        approval: within ? ApprovalStatus.APPROVED : ApprovalStatus.PENDING, autoApproved: within,
      });
    }
    return out;
  });

  const t = nowIso();
  db.exec('BEGIN');
  try {
    const { lastInsertRowid: visitId } = db.prepare(
      'INSERT INTO shelf_visits (rep_id, customer_id, visited_on, created_at) VALUES (?, ?, ?, ?)',
    ).run(rep.id, customer.id, today, t);
    const ins = db.prepare(`INSERT INTO shelf_visit_lines
      (visit_id, record_key, cartons_on_shelf, outcome, discount_pct, contact_name, agreement, approval_status, offered_pct, return_reason, return_note, approved_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of clean) ins.run(visitId, c.recordKey, c.cartons, c.outcome, c.discountPct, c.contactName, c.agreement, c.approval, c.offeredPct, c.returnReason, c.returnNote, c.autoApproved ? t : null, t);
    db.exec('COMMIT');
    return {
      visitId: Number(visitId), customer: { id: customer.id, name: customer.name },
      saved: clean.length,
      autoApproved: clean.filter((c) => c.autoApproved).length,
      byOutcome: clean.reduce((m, c) => ({ ...m, [c.outcome]: (m[c.outcome] || 0) + 1 }), {}),
    };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// ---------------------------------------------------------------------------
// the Sales Manager: discounts to approve, Finance's follow-up, overdue visits
// ---------------------------------------------------------------------------

function discountRows(db, today, loader, settings) {
  const shelf = overlayShelf(db, loader(today, db));
  const byKey = new Map(shelf.records.map((r) => [r.key, r]));
  const cust = new Map(shelf.customers.map((c) => [c.id, c]));
  const rep = new Map(shelf.reps.map((r) => [r.id, r]));
  const lines = db.prepare(`
    SELECT l.id, l.record_key, l.cartons_on_shelf, l.discount_pct, l.contact_name, l.approval_status, l.approval_reason,
           l.approved_at, l.credit_note_ref, l.offered_pct, v.visited_on, v.rep_id, v.customer_id
      FROM shelf_visit_lines l JOIN shelf_visits v ON v.id = l.visit_id
     WHERE l.outcome = ? AND l.id IN (SELECT MAX(id) FROM shelf_visit_lines GROUP BY record_key)
     ORDER BY l.id`).all(VisitOutcome.DISCOUNT_AGREED);
  return lines.map((l) => {
    const r = byKey.get(l.record_key);
    return {
      id: l.id, customer: cust.get(l.customer_id)?.name ?? `Customer ${l.customer_id}`, customerId: l.customer_id,
      rep: rep.get(l.rep_id)?.name ?? l.rep_id, visitedOn: l.visited_on,
      productName: r?.productName ?? l.record_key, lotName: r?.lotName ?? '', expiryDate: r?.expiryDate ?? null,
      daysLeft: r ? daysLeft(r.expiryDate, today) : null, salesOrder: r?.salesOrder ?? '',
      cartonsOnShelf: l.cartons_on_shelf, discountPct: l.discount_pct, contactName: l.contact_name,
      approvalStatus: l.approval_status, reason: l.approval_reason, decidedAt: l.approved_at, creditNoteRef: l.credit_note_ref,
      offeredPct: l.offered_pct, preApproved: l.offered_pct !== null && l.approval_status === ApprovalStatus.APPROVED && l.discount_pct <= l.offered_pct,
    };
  });
}

/** Everything the Sales Manager screen shows. */
export function approvals(db, { today, loader = loadShelf, settings = sampleSettings() } = {}) {
  const rows = discountRows(db, today, loader, settings);
  const shelf = overlayShelf(db, loader(today, db));
  const all = describeAll(db, today, shelf, settings);
  const repName = new Map(shelf.reps.map((r) => [r.id, r.name]));
  const custRep = new Map(shelf.customers.map((c) => [c.id, c.repId]));

  const overdueByRep = shelf.reps.map((rep) => {
    const open = all.filter((r) => custRep.get(r.customerId) === rep.id && isOpenAlert(r));
    return { repId: rep.id, rep: rep.name, openAlerts: open.length, overdue: open.filter((r) => r.overdue).length };
  });

  const returns = all.filter((r) => r.state === ShelfState.RETURN_EXPECTED).map((r) => ({
    customer: shelf.customers.find((c) => c.id === r.customerId)?.name, productName: r.productName, lotName: r.lotName,
    expiryDate: r.expiryDate, cartonsOnShelf: r.cartonsOnShelf, rep: repName.get(custRep.get(r.customerId)),
    returnReason: r.returnReason || 'EXPIRED', returnNote: r.returnNote || null,
  }));

  return {
    source: shelf.source, asOf: today,
    pending: rows.filter((r) => r.approvalStatus === ApprovalStatus.PENDING),
    financeTasks: rows.filter((r) => r.approvalStatus === ApprovalStatus.APPROVED && !r.creditNoteRef),
    decided: rows.filter((r) => r.approvalStatus === ApprovalStatus.REJECTED || (r.approvalStatus === ApprovalStatus.APPROVED && r.creditNoteRef)),
    returnsExpected: returns,
    overdueByRep,
  };
}

/**
 * The lots that are on customers' shelves and still waiting for a visit, grouped by lot (the same lot may be
 * on many shelves), with the discount the Sales Manager has put on each. Nearest expiry first.
 */
export function shelfLotDiscounts(db, { today, loader = loadShelf, settings = sampleSettings() } = {}) {
  const shelf = overlayShelf(db, loader(today, db));
  const offers = activeDiscounts(db, DiscountKind.SHELF);
  const groups = new Map();
  const customerOf = new Map(shelf.customers.map((c) => [c.id, c]));
  const repName = new Map(shelf.reps.map((x) => [x.id, x.name]));
  for (const r of describeAll(db, today, shelf, settings).filter(isOpenAlert)) {
    const key = shelfLotKey(r);
    const g = groups.get(key) || {
      key, productName: r.productName, barcode: r.barcode, lotName: r.lotName, expiryDate: r.expiryDate, daysLeft: r.daysLeft,
      shops: 0, cartons: 0, discountPct: offers.get(key)?.pct ?? null, holders: [],
    };
    g.shops += 1;
    g.cartons += r.cartonsOnShelf;
    // which shop holds these cartons, and which sales rep is responsible for that shop
    const shop = customerOf.get(r.customerId);
    g.holders.push({ customer: shop?.name ?? `Customer ${r.customerId}`, odooId: shop?.odooId ?? r.customerId, rep: repName.get(shop?.repId) ?? null, cartons: r.cartonsOnShelf });
    groups.set(key, g);
  }
  return { source: shelf.source, asOf: today, lots: [...groups.values()].sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9)) };
}

/** Put (or, with pct null, switch off) the Sales Manager's discount on a shelf lot. Only a lot that is on a shelf and waiting. */
export function saveShelfLotDiscount(db, key, pct, by, opts = {}) {
  const { lots } = shelfLotDiscounts(db, opts);
  if (!lots.some((l) => l.key === key)) throw new ShelfError('That lot is not on a customer shelf waiting for a visit.', 404);
  if (pct === null || pct === undefined || pct === '') removeLotDiscount(db, DiscountKind.SHELF, key, by);
  else setLotDiscount(db, DiscountKind.SHELF, key, pct, by);
  return shelfLotDiscounts(db, opts).lots.find((l) => l.key === key);
}

/** The Sales Manager's decision on a proposed discount. A rejection goes back to the rep with its reason. */
export function decideDiscount(db, lineId, { decision, reason } = {}) {
  const line = db.prepare('SELECT id, approval_status FROM shelf_visit_lines WHERE id = ?').get(Number(lineId));
  if (!line || line.approval_status === null) throw new ShelfError('There is no proposed discount with that number.', 404);
  if (line.approval_status !== ApprovalStatus.PENDING) throw new ShelfError('That discount has already been decided.', 409);
  const t = nowIso();
  if (decision === 'APPROVE') {
    db.prepare('UPDATE shelf_visit_lines SET approval_status = ?, approved_at = ? WHERE id = ?').run(ApprovalStatus.APPROVED, t, line.id);
  } else if (decision === 'REJECT') {
    const why = String(reason ?? '').trim();
    if (why.length < 3) throw new ShelfError('Give the rep a reason for turning the discount down.');
    if (why.length > 300) throw new ShelfError('Keep the reason under 300 characters.');
    db.prepare('UPDATE shelf_visit_lines SET approval_status = ?, approval_reason = ?, approved_at = ? WHERE id = ?')
      .run(ApprovalStatus.REJECTED, why, t, line.id);
  } else throw new ShelfError('Choose approve or reject.');
  return { id: line.id, status: decision === 'APPROVE' ? ApprovalStatus.APPROVED : ApprovalStatus.REJECTED };
}

/**
 * Stand-in for the Odoo credit-note sync: Finance issued the credit note in Odoo and BFL "finds"
 * it. Records its number against the approved discount, which closes the alert.
 */
export function recordCreditNote(db, lineId, ref) {
  const line = db.prepare('SELECT id, approval_status, credit_note_ref FROM shelf_visit_lines WHERE id = ?').get(Number(lineId));
  if (!line || line.approval_status !== ApprovalStatus.APPROVED) throw new ShelfError('Only an approved discount can have a credit note.', 409);
  if (line.credit_note_ref) throw new ShelfError('That discount already has a credit note.', 409);
  const clean = String(ref ?? '').trim();
  if (clean.length < 2 || clean.length > 60) throw new ShelfError('Enter the credit note number from Odoo.');
  if (db.prepare('SELECT 1 FROM odoo_credit_notes WHERE number = ?').get(clean)) throw new ShelfError('That credit note number is already recorded.', 409);
  const full = db.prepare('SELECT l.cartons_on_shelf, l.discount_pct, l.record_key, v.customer_id, v.rep_id FROM shelf_visit_lines l JOIN shelf_visits v ON v.id = l.visit_id WHERE l.id = ?').get(line.id);
  const t = nowIso();
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE shelf_visit_lines SET credit_note_ref = ? WHERE id = ?').run(clean, line.id);
    // The credit note as Odoo has it: the discount given on the cartons still on the shelf, at the lot's selling price.
    const shelf = overlayShelf(db, loadShelf(t.slice(0, 10)));
    const rec = shelf.records.find((r) => r.key === full.record_key);
    const cust = shelf.customers.find((c) => c.id === full.customer_id);
    const rep = shelf.reps.find((r) => r.id === full.rep_id);
    const price = rec ? (cartonPriceFor(rec.barcode, 'CLASS A (GHS)') ?? 0) : 0;
    const amount = Math.round(full.cartons_on_shelf * price * (full.discount_pct / 100) * 100) / 100;
    db.prepare(`INSERT INTO odoo_credit_notes (number, customer_kind, customer_ref, customer_name, rep_name, return_id, kind, amount, issued_on)
                VALUES (?, 'SHELF', ?, ?, ?, NULL, 'DISCOUNT', ?, ?)`).run(clean, String(full.customer_id), cust?.name ?? `Customer ${full.customer_id}`, rep?.name ?? null, amount, t.slice(0, 10));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { id: line.id, creditNoteRef: clean };
}

export { ShelfAlertKind };
