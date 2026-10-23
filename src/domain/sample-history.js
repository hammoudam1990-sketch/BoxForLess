// SAMPLE HISTORY for trying the monthly reports before Odoo is connected.
//
// Fills fourteen months of made-up (but deterministic and internally consistent) orders, invoices with
// lines, payments, a few credit notes, a little lost demand and month-end stock, for a handful of
// existing credit customers, so every report has "last month" and "same month last year" to compare
// with. Everything it writes is marked as sample: invoice numbers INV/H/…, order numbers SH…, request
// references HIST-…. In the real system none of this exists: the Odoo sync reads the real history.
// Part of the Sample Odoo stand-in, off once the real Odoo is connected.
import { toDay, formatDay } from './expiry.js';
import { cartonPriceFor } from './prices.js';
import { loadShelf } from './shelf.js';
import { SampleOdooError, recomputeFinance, PAYMENT_TERMS_DAYS } from './sample-odoo.js';
import { takeStockSnapshot } from './reports.js';

const MONTHS = 14;
const money = (n) => Math.round(n * 100) / 100;

/** A small seeded random number generator, so the same history comes out every time. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function historyLoaded(db) {
  return Boolean(db.prepare("SELECT 1 FROM odoo_invoices WHERE number LIKE 'INV/H/%' LIMIT 1").get());
}

export function seedHistory(db, todayStr, now = new Date()) {
  if (historyLoaded(db)) throw new SampleOdooError('Sample history is already loaded.', 409);
  const customers = db.prepare(`SELECT id, name, pricelist, salesperson FROM customers WHERE is_active = 1 AND pricelist IS NOT NULL
                                 AND (customer_type IS NULL OR customer_type = 'CREDIT') ORDER BY id LIMIT 10`).all();
  if (customers.length < 3) throw new SampleOdooError('Add at least three credit customers with a price class first.', 400);
  const all = db.prepare("SELECT id, barcode, name, box_uom, odoo_category_path p FROM products WHERE is_active = 1 AND odoo_category_path IS NOT NULL ORDER BY id").all();
  if (all.length < 10) throw new SampleOdooError('Import the products first.', 400);
  const stride = Math.max(1, Math.floor(all.length / 40));
  const products = all.filter((_, i) => i % stride === 0).slice(0, 40);
  const repNames = loadShelf(todayStr).reps.map((r) => r.name);
  const today = toDay(todayStr);
  const [ty, tm] = todayStr.split('-').map(Number);

  db.exec('BEGIN IMMEDIATE');
  try {
    customers.forEach((c, i) => {
      if (!c.salesperson) db.prepare('UPDATE customers SET salesperson = ? WHERE id = ?').run(repNames[i % repNames.length], c.id);
    });
    const rep = new Map(db.prepare('SELECT id, salesperson FROM customers WHERE id IN (' + customers.map(() => '?').join(',') + ')').all(...customers.map((c) => c.id)).map((c) => [c.id, c.salesperson]));

    const insReq = db.prepare(`INSERT INTO requests (reference, customer_id, status, submitted_at, stock_as_of, created_at, updated_at) VALUES (?,?,'ACCEPTED',?,?,?,?)`);
    const insItem = db.prepare(`INSERT INTO request_items (request_id, product_id, quantity_ctn, product_name_at_request, barcode_at_request, box_uom_at_request, available_ctn_at_request, created_at) VALUES (?,?,?,?,?,?,?,?)`);
    const insOrder = db.prepare(`INSERT INTO odoo_orders (request_id, customer_id, odoo_number, state, amount_total, cartons_ordered, cartons_delivered, received_at, sent_at, approved_at, dispatched_at, invoiced_at, paid_at, updated_at)
                                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insInv = db.prepare(`INSERT INTO odoo_invoices (number, customer_id, order_id, amount, amount_due, invoice_date, due_date, state) VALUES (?,?,?,?,?,?,?,?)`);
    const insLine = db.prepare('INSERT INTO odoo_invoice_lines (invoice_id, barcode, product_name, category, cartons, amount, discount) VALUES (?,?,?,?,?,?,0)');
    const insPay = db.prepare('INSERT INTO odoo_payments (customer_id, invoice_id, amount, paid_on) VALUES (?,?,?,?)');
    const insCn = db.prepare(`INSERT INTO odoo_credit_notes (number, customer_kind, customer_ref, customer_name, rep_name, invoice_number, kind, amount, issued_on) VALUES (?, 'BFL', ?, ?, ?, ?, 'DISCOUNT', ?, ?)`);
    let orderSeq = 0; let invSeq = 0; let cnSeq = 0;

    for (let back = MONTHS; back >= 0; back -= 1) {
      const d = new Date(Date.UTC(ty, tm - 1 - back, 1));
      const y = d.getUTCFullYear(); const m = d.getUTCMonth() + 1;
      const key = `${y}${String(m).padStart(2, '0')}`;
      const lastDom = new Date(Date.UTC(y, m, 0)).getUTCDate();
      customers.forEach((c, ci) => {
        const rand = rng(c.id * 1000 + y * 12 + m);
        // a couple of customers go quiet in the last two months; one only starts three months ago
        if (ci % 5 === 4 && back <= 2) return;
        if (ci % 7 === 6 && back > 3) return;
        if (rand() < 0.12) return;
        const n = 1 + Math.floor(rand() * 3);
        for (let o = 0; o < n; o += 1) {
          const dom = 1 + Math.floor(rand() * Math.min(lastDom, 26));
          const placed = toDay(`${y}-${String(m).padStart(2, '0')}-${String(dom).padStart(2, '0')}`);
          if (placed + 4 > today) continue;                        // nothing in the future, and delivered before today
          const approved = placed + 1; const dispatched = approved + 1 + Math.floor(rand() * 3);
          const itemCount = 2 + Math.floor(rand() * 3);
          const items = [];
          for (let k = 0; k < itemCount; k += 1) { const p = products[Math.floor(rand() * products.length)]; if (!items.some((x) => x.p.id === p.id)) items.push({ p, qty: 1 + Math.floor(rand() * 10) }); }
          const ordered = items.reduce((s, x) => s + x.qty, 0);
          const short = ordered > 3 && rand() < 0.1 ? 1 : 0;
          const delivered = ordered - short;
          const lines = items.map((x) => ({ ...x, amount: money((cartonPriceFor(x.p.barcode, c.pricelist) ?? 0) * x.qty) }));
          const amount = money(lines.reduce((s, l) => s + l.amount, 0));
          const iso = (day, hour = 9) => `${formatDay(day)}T${String(hour).padStart(2, '0')}:00:00.000Z`;

          orderSeq += 1;
          const reqId = Number(insReq.run(`HIST-${key}-${c.id}-${orderSeq}`, c.id, iso(placed), iso(placed), iso(placed), iso(placed)).lastInsertRowid);
          for (const x of items) insItem.run(reqId, x.p.id, x.qty, x.p.name, x.p.barcode, x.p.box_uom, 999, iso(placed));
          const invDate = dispatched;
          const payDay = invDate + 18 + Math.floor(rand() * 35);
          const paid = payDay <= today && rand() < 0.88;
          const orderId = Number(insOrder.run(reqId, c.id, `SH${String(orderSeq).padStart(5, '0')}`, paid ? 'PAID' : 'INVOICED', amount, ordered, delivered, iso(placed), iso(placed), iso(approved), iso(dispatched), iso(invDate), paid ? iso(payDay) : null, iso(paid ? payDay : invDate)).lastInsertRowid);
          invSeq += 1;
          const invId = Number(insInv.run(`INV/H/${key}/${String(invSeq).padStart(4, '0')}`, c.id, orderId, amount, paid ? 0 : amount, formatDay(invDate), formatDay(invDate + PAYMENT_TERMS_DAYS), paid ? 'PAID' : 'OPEN').lastInsertRowid);
          for (const l of lines) insLine.run(invId, l.p.barcode, l.p.name, l.p.p, l.qty, l.amount);
          if (paid) insPay.run(c.id, invId, amount, formatDay(payDay));
          if (invSeq % 11 === 0 && invDate + 6 <= today) {
            cnSeq += 1;
            insCn.run(`CNH/${String(cnSeq).padStart(4, '0')}`, String(c.id), c.name, rep.get(c.id), `INV/H/${key}/${String(invSeq).padStart(4, '0')}`, money(amount * 0.05), formatDay(invDate + 6));
          }
        }
      });
    }

    // a little lost demand and a couple of credit blocks in the last two months
    const insLog = db.prepare('INSERT INTO order_check_log (customer_id, kind, barcode, product_name, cartons_wanted, cartons_short, order_value, available_credit, at) VALUES (?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 8; i += 1) {
      const p = products[(i * 7) % products.length];
      insLog.run(customers[i % customers.length].id, 'LOW_STOCK', p.barcode, p.name, 10 + i, 3 + i, null, null, `${formatDay(today - 3 - i * 6)}T10:00:00.000Z`);
    }
    insLog.run(customers[1].id, 'CREDIT', null, null, null, null, 4200, 1500, `${formatDay(today - 9)}T11:00:00.000Z`);
    insLog.run(customers[2].id, 'CREDIT', null, null, null, null, 800, 120, `${formatDay(today - 30)}T11:00:00.000Z`);

    for (const c of customers) {
      db.prepare('INSERT INTO odoo_customer_finance (customer_id, credit_limit, amount_owed, overdue, updated_at) VALUES (?,?,0,0,?) ON CONFLICT(customer_id) DO UPDATE SET credit_limit = COALESCE(credit_limit, excluded.credit_limit)')
        .run(c.id, 60000, now.toISOString());
      recomputeFinance(db, c.id, now);
    }

    // month-end stock for the last fourteen months, around today's levels
    takeStockSnapshot(db, todayStr);
    const cats = db.prepare('SELECT category, on_hand, free FROM stock_snapshots WHERE snap_on = ?').all(todayStr);
    const insSnap = db.prepare('INSERT OR IGNORE INTO stock_snapshots (snap_on, category, on_hand, free) VALUES (?,?,?,?)');
    for (let back = 1; back <= MONTHS; back += 1) {
      const end = formatDay(toDay(new Date(Date.UTC(ty, tm - 1 - back + 1, 1)).toISOString().slice(0, 10)) - 1);
      cats.forEach((c, i) => { const f = 0.8 + rng(back * 31 + i)() * 0.4; insSnap.run(end, c.category, Math.round(c.on_hand * f), Math.round(c.free * f)); });
    }
    db.exec('COMMIT');
    return { customers: customers.length, orders: orderSeq, invoices: invSeq, creditNotes: cnSeq };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
