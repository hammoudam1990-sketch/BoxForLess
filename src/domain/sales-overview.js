// Read-only aggregates for the Sales Manager dashboard.
//
// Phase-1 rule: nothing here is a price or an amount. Everything is counted in requests,
// order lines and cartons, which is what the catalogue actually records. Withdrawn requests
// are excluded from every figure.
import { listRequests } from './requests.js';
import { listAccessRequests } from './access-requests.js';
import { reviewCounts } from './review.js';
import config from '../config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const WITHDRAWN = 'DELETED';
const WINDOWS = [7, 14, 30, 90];

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);

function windowTotals(db, fromIso, toIso) {
  const row = db.prepare(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM((SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id)), 0) AS lines,
            COALESCE(SUM((SELECT COALESCE(SUM(i.quantity_ctn), 0) FROM request_items i WHERE i.request_id = r.id)), 0) AS cartons,
            COUNT(DISTINCT CASE WHEN r.customer_id IS NOT NULL THEN 'c' || r.customer_id
                                ELSE 'u' || COALESCE(r.unlisted_company, r.unlisted_contact, r.id) END) AS customers
       FROM requests r
      WHERE COALESCE(r.status, '') != ? AND r.submitted_at >= ? AND r.submitted_at < ?`
  ).get(WITHDRAWN, fromIso, toIso);
  return {
    requests: row.requests,
    lines: row.lines,
    cartons: row.cartons,
    customers: row.customers,
    avgCartons: row.requests ? Math.round((row.cartons / row.requests) * 10) / 10 : 0,
  };
}

export function salesOverview(db, { days = 30, now = new Date() } = {}) {
  const span = WINDOWS.includes(Number(days)) ? Number(days) : 30;
  const nowMs = new Date(now).getTime();
  const end = nowMs - (((nowMs % DAY_MS) + DAY_MS) % DAY_MS) + DAY_MS; // UTC midnight after today
  const endIso = new Date(end).toISOString();
  const startIso = new Date(end - span * DAY_MS).toISOString();
  const prevStartIso = new Date(end - 2 * span * DAY_MS).toISOString();

  const current = windowTotals(db, startIso, endIso);
  const previous = windowTotals(db, prevStartIso, startIso);

  const byDay = new Map(db.prepare(
    `SELECT substr(r.submitted_at, 1, 10) AS day, COUNT(*) AS requests,
            SUM(CASE WHEN r.status = 'ACCEPTED' THEN 1 ELSE 0 END) AS accepted,
            COALESCE(SUM((SELECT COALESCE(SUM(i.quantity_ctn), 0) FROM request_items i WHERE i.request_id = r.id)), 0) AS cartons
       FROM requests r
      WHERE COALESCE(r.status, '') != ? AND r.submitted_at >= ? AND r.submitted_at < ?
      GROUP BY day`
  ).all(WITHDRAWN, startIso, endIso).map((r) => [r.day, r]));
  const series = Array.from({ length: span }, (_, i) => {
    const date = dayKey(end - (span - i) * DAY_MS);
    const hit = byDay.get(date);
    return { date, requests: hit?.requests || 0, accepted: hit?.accepted || 0, cartons: hit?.cartons || 0 };
  });

  const todayStart = new Date(end - DAY_MS).toISOString();
  const today = windowTotals(db, todayStart, endIso);
  const activeCustomers = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE is_active = 1').get().n;
  const inventory = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN free_to_use > ? THEN 1 ELSE 0 END) AS inStock,
            SUM(CASE WHEN free_to_use > ? AND free_to_use <= ? THEN 1 ELSE 0 END) AS limited,
            SUM(CASE WHEN free_to_use <= ? THEN 1 ELSE 0 END) AS outOfStock
       FROM products WHERE is_active = 1`
  ).get(
    config.stock.limitedAtOrBelow,
    config.stock.outOfStockAtOrBelow,
    config.stock.limitedAtOrBelow,
    config.stock.outOfStockAtOrBelow,
  );

  const topCustomers = db.prepare(
    `SELECT COALESCE(c.name, r.unlisted_company, r.unlisted_contact, 'Unnamed customer') AS name,
            COUNT(DISTINCT r.id) AS requests,
            COALESCE(SUM(i.quantity_ctn), 0) AS cartons
       FROM requests r
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN request_items i ON i.request_id = r.id
      WHERE COALESCE(r.status, '') != ? AND r.submitted_at >= ? AND r.submitted_at < ?
      GROUP BY CASE WHEN r.customer_id IS NOT NULL THEN 'c' || r.customer_id
                    ELSE 'u' || COALESCE(r.unlisted_company, r.unlisted_contact, CAST(r.id AS TEXT)) END
      ORDER BY cartons DESC, requests DESC LIMIT 5`
  ).all(WITHDRAWN, startIso, endIso);

  const topProducts = db.prepare(
    `SELECT i.product_id AS productId,
            COALESCE(p.name, i.product_name_at_request) AS name,
            COALESCE(i.box_uom_at_request, '') AS boxUom,
            SUM(i.quantity_ctn) AS cartons,
            COUNT(DISTINCT r.id) AS requests
       FROM request_items i
       JOIN requests r ON r.id = i.request_id
       LEFT JOIN products p ON p.id = i.product_id
      WHERE COALESCE(r.status, '') != ? AND r.submitted_at >= ? AND r.submitted_at < ?
      GROUP BY COALESCE(CAST(i.product_id AS TEXT), 'n:' || i.product_name_at_request)
      ORDER BY cartons DESC LIMIT 5`
  ).all(WITHDRAWN, startIso, endIso);

  const waiting = db.prepare(
    `SELECT COUNT(*) AS n, MIN(submitted_at) AS oldest FROM requests WHERE status = 'SUBMITTED'`
  ).get();
  const unmatched = db.prepare(
    `SELECT COUNT(*) AS n FROM requests
      WHERE customer_id IS NULL AND COALESCE(status, '') NOT IN (?, 'ACCEPTED')`
  ).get(WITHDRAWN).n;
  const statusCounts = Object.fromEntries(db.prepare(
    `SELECT COALESCE(status, 'UNKNOWN') AS status, COUNT(*) AS n
       FROM requests WHERE COALESCE(status, '') != ? AND submitted_at >= ? AND submitted_at < ? GROUP BY status`
  ).all(WITHDRAWN, startIso, endIso).map((r) => [r.status, r.n]));

  // Only what the sales manager needs to read: no phone numbers, addresses or notes.
  const recent = listRequests(db, { limit: 8 }).items.map((r) => ({
    id: r.id,
    reference: r.reference,
    customer: r.customer?.displayName || r.customer_name || 'Unnamed customer',
    lines: r.item_count,
    cartons: r.cartons,
    status: r.status,
    submittedAt: r.submitted_at,
  }));

  return {
    days: span,
    current,
    previous,
    today,
    activeCustomers,
    inventory: {
      total: inventory.total || 0,
      inStock: inventory.inStock || 0,
      limited: inventory.limited || 0,
      outOfStock: inventory.outOfStock || 0,
    },
    series,
    topCustomers,
    topProducts,
    recent,
    attention: {
      pendingApproval: waiting.n,
      oldestPending: waiting.oldest || null,
      unmatchedCustomers: unmatched,
      registrations: listAccessRequests(db, { status: 'PENDING', limit: 1 }).total || 0,
      importChanges: reviewCounts(db).total || 0,
    },
    statusCounts,
  };
}

export default salesOverview;
