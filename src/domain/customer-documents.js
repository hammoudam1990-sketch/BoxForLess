// The documents a signed-in customer can download: a copy of one of their invoices, and their account statement
// (PDF, and CSV for a spreadsheet).
//
// Every figure is the customer's own and comes from what BFL holds of Odoo's records (invoices, invoice lines, payments,
// credit notes, the customer's credit position) plus the "pay by" date (the Sales Manager's due date for the order, else
// the schedule, else Odoo's due date). The customer is always the one in the session: a document is looked up by the
// customer id AND the invoice number, so another customer's invoice is simply "not found". A cash customer has no
// invoices or balance on BFL (the shared cash account is never shown), so there is nothing to download.
//
// The official invoice is Odoo's; these are copies, and they say so. Until Odoo is connected they also say the figures
// come from the stand-in for Odoo.
import { PdfDocument, wrap } from './pdf.js';
import { accountFor } from './orders.js';
import { openInvoices } from './payments.js';
import { toDay, formatDay } from './expiry.js';
import { sampleOdooEnabled } from './sample-odoo.js';

const NAVY = [16, 61, 115];
const BLUE = [23, 101, 181];
const INK = [24, 49, 83];
const MUTED = [100, 116, 139];
const LINE = [226, 232, 240];
const SOFT = [244, 247, 251];
const RED = [180, 35, 35];
const GREEN = [15, 122, 78];

const money = (n) => Math.round(Number(n || 0) * 100) / 100;
export const ghs = (n) => `GHS ${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const STATEMENT_MONTHS = 12;

export class DocumentError extends Error {
  constructor(message, status = 404) { super(message); this.name = 'DocumentError'; this.status = status; }
}

/** A safe file name piece: letters, digits, dot, dash and underscore only. */
export const fileSafe = (s) => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document';

function customerRow(db, customerId) {
  const c = db.prepare('SELECT id, name, odoo_customer_ref, delivery_address, customer_type, is_active FROM customers WHERE id = ?').get(Number(customerId));
  if (!c || !c.is_active) throw new DocumentError('Customer not found.');
  if (c.customer_type === 'CASH') throw new DocumentError('A cash account has no invoices or balance to download.', 409);
  return c;
}

// ---------------------------------------------------------------------------------------------
// the page layout
// ---------------------------------------------------------------------------------------------
const M = 40;            // page margin
const BOTTOM = 70;       // keep clear above the footer

class Layout {
  constructor(title, docTitle) {
    this.doc = new PdfDocument({ title: docTitle });
    this.title = title;
    this.width = this.doc.width - 2 * M;
    this.header(true);
  }

  header(first) {
    const d = this.doc;
    d.rect(0, 0, d.width, first ? 76 : 44, { fill: NAVY });
    d.text(M, first ? 34 : 27, 'BOX FOR LESS', { size: first ? 18 : 12, bold: true, color: [255, 255, 255] });
    if (first) d.text(M, 52, 'Wholesale Made Simple', { size: 9.5, color: [195, 211, 232] });
    d.text(d.width - M, first ? 34 : 27, this.title, { size: first ? 14 : 10, bold: true, color: [255, 255, 255], align: 'right' });
    this.y = first ? 104 : 70;
  }

  ensure(h) {
    if (this.y + h > this.doc.height - BOTTOM) { this.doc.addPage(); this.header(false); return true; }
    return false;
  }

  gap(h = 10) { this.y += h; }

  heading(text) {
    this.ensure(40);
    this.doc.text(M, this.y + 12, text, { size: 12, bold: true, color: INK });
    this.y += 22;
  }

  paragraph(text, { size = 9, color = MUTED, bold = false } = {}) {
    for (const line of wrap(text, this.width, size, bold)) {
      this.ensure(size + 4);
      this.doc.text(M, this.y + size, line, { size, color, bold });
      this.y += size + 4;
    }
  }

  /** Two blocks side by side, each a list of [label, value]. */
  facts(left, right) {
    const colW = this.width / 2 - 10;
    const rows = Math.max(left.length, right.length);
    this.ensure(rows * 15 + 6);
    const draw = (items, x) => items.forEach(([k, v, opts = {}], i) => {
      this.doc.text(x, this.y + 11 + i * 15, k, { size: 9, color: MUTED });
      this.doc.text(x + 110, this.y + 11 + i * 15, wrap(v, colW - 110, 9.5, opts.bold)[0], { size: 9.5, color: opts.color || INK, bold: Boolean(opts.bold) });
    });
    draw(left, M);
    draw(right, M + colW + 20);
    this.y += rows * 15 + 6;
  }

  /** A row of summary tiles: [label, value, color?]. */
  tiles(items) {
    const gap = 8;
    const w = (this.width - gap * (items.length - 1)) / items.length;
    this.ensure(52);
    items.forEach(([label, value, color], i) => {
      const x = M + i * (w + gap);
      this.doc.rect(x, this.y, w, 46, { fill: SOFT, stroke: LINE });
      this.doc.text(x + 9, this.y + 16, label, { size: 8.5, color: MUTED });
      this.doc.text(x + 9, this.y + 35, value, { size: 12, bold: true, color: color || INK });
    });
    this.y += 56;
  }

  /**
   * A table. columns: [{ label, width (share of the page width), align }]. rows: arrays of cell text. The first column
   * wraps; the header repeats on a new page.
   */
  table(columns, rows, { empty = 'Nothing to show.' } = {}) {
    const total = columns.reduce((s, c) => s + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.width);
    const xs = widths.map((_, i) => M + widths.slice(0, i).reduce((s, w) => s + w, 0));
    const head = () => {
      this.doc.rect(M, this.y, this.width, 20, { fill: SOFT });
      columns.forEach((c, i) => this.doc.text(c.align === 'right' ? xs[i] + widths[i] - 6 : xs[i] + 6, this.y + 13.5, c.label.toUpperCase(), { size: 7.5, bold: true, color: MUTED, align: c.align === 'right' ? 'right' : 'left' }));
      this.y += 20;
    };
    this.ensure(46);
    head();
    if (!rows.length) {
      this.doc.text(M + 6, this.y + 15, empty, { size: 9, color: MUTED });
      this.y += 24;
      return;
    }
    for (const row of rows) {
      const first = wrap(row[0], widths[0] - 12, 9);
      const h = Math.max(1, first.length) * 11 + 9;
      if (this.ensure(h)) head();
      first.forEach((line, k) => this.doc.text(xs[0] + 6, this.y + 13 + k * 11, line, { size: 9, color: INK }));
      row.slice(1).forEach((cell, j) => {
        const i = j + 1;
        const text = wrap(cell, widths[i] - 12, 9)[0];
        this.doc.text(columns[i].align === 'right' ? xs[i] + widths[i] - 6 : xs[i] + 6, this.y + 13, text, { size: 9, color: INK, align: columns[i].align === 'right' ? 'right' : 'left' });
      });
      this.y += h;
      this.doc.line(M, this.y, M + this.width, this.y);
    }
    this.y += 4;
  }

  /** Right-aligned totals: [label, value, { bold, color }]. */
  totals(items) {
    this.ensure(items.length * 16 + 8);
    for (const [label, value, opts = {}] of items) {
      this.doc.text(M + this.width - 130, this.y + 12, label, { size: 9.5, color: MUTED, align: 'right' });
      this.doc.text(M + this.width, this.y + 12, value, { size: opts.bold ? 11 : 9.5, bold: Boolean(opts.bold), color: opts.color || INK, align: 'right' });
      this.y += 16;
    }
    this.y += 4;
  }

  /** Footer on every page, then the file. */
  finish(note) {
    const d = this.doc;
    const n = d.pageCount;
    for (let i = 0; i < n; i += 1) {
      d.usePage(i);
      d.line(M, d.height - 48, d.width - M, d.height - 48);
      for (const [k, line] of wrap(note, d.width - 2 * M - 70, 7.5).slice(0, 2).entries()) d.text(M, d.height - 36 + k * 10, line, { size: 7.5, color: MUTED });
      d.text(d.width - M, d.height - 36, `Page ${i + 1} of ${n}`, { size: 7.5, color: MUTED, align: 'right' });
    }
    return d.toBuffer();
  }
}

const footerNote = (generatedAt) => `Generated by Box for Less on ${day(new Date(generatedAt).toISOString())}. A copy for your records: the official documents are the ones in Box for Less's accounts (Odoo).${sampleOdooEnabled() ? ' Sample figures: Odoo is not connected yet, so these come from a stand-in for Odoo.' : ''}`;

// ---------------------------------------------------------------------------------------------
// one invoice
// ---------------------------------------------------------------------------------------------
/** The data of one of this customer's invoices (null fields where Odoo has given nothing). */
export function invoiceData(db, customerId, number, todayStr) {
  const c = customerRow(db, customerId);
  const inv = db.prepare(`SELECT i.id, i.number, i.amount, i.amount_due, i.invoice_date, i.due_date, i.state, o.odoo_number, r.reference
                            FROM odoo_invoices i LEFT JOIN odoo_orders o ON o.id = i.order_id LEFT JOIN requests r ON r.id = o.request_id
                           WHERE i.customer_id = ? AND i.number = ?`).get(c.id, String(number || ''));
  if (!inv) throw new DocumentError('Invoice not found.');
  const open = openInvoices(db, c.id, toDay(todayStr)).find((x) => x.number === inv.number);
  const lines = db.prepare('SELECT product_name, barcode, lot_name, cartons, amount, discount FROM odoo_invoice_lines WHERE invoice_id = ? ORDER BY id').all(inv.id);
  const payments = db.prepare('SELECT amount, paid_on FROM odoo_payments WHERE invoice_id = ? AND customer_id = ? ORDER BY paid_on, id').all(inv.id, c.id);
  const credits = db.prepare("SELECT number, amount, issued_on, kind FROM odoo_credit_notes WHERE invoice_number = ? AND customer_kind = 'BFL' AND customer_ref = ? ORDER BY issued_on, id").all(inv.number, String(c.id));
  const payBy = open ? open.payBy : null;
  const status = inv.state === 'PAID' || inv.amount_due <= 0 ? 'Paid' : (payBy && payBy < todayStr ? 'Overdue' : 'Open');
  return {
    customer: { name: c.name, ref: c.odoo_customer_ref || null, address: c.delivery_address || null },
    number: inv.number, invoiceDate: inv.invoice_date, dueDate: inv.due_date, payBy, status,
    order: inv.odoo_number || null, bflReference: inv.reference || null,
    amount: money(inv.amount), amountDue: money(inv.amount_due),
    lines: lines.map((l) => ({ product: l.product_name || l.barcode, barcode: l.barcode, lot: l.lot_name || null, cartons: l.cartons, amount: money(l.amount), discount: money(l.discount) })),
    payments: payments.map((p) => ({ amount: money(p.amount), paidOn: p.paid_on })),
    credits: credits.map((x) => ({ number: x.number, amount: money(x.amount), issuedOn: x.issued_on })),
  };
}

export function invoicePdf(db, customerId, number, todayStr, now = new Date()) {
  const d = invoiceData(db, customerId, number, todayStr);
  const L = new Layout('INVOICE COPY', `Invoice ${d.number}`);
  L.facts(
    [['Invoice', d.number, { bold: true }], ['Invoice date', day(d.invoiceDate)], ['Order', [d.order, d.bflReference].filter(Boolean).join(' · ') || '—'], ['Status', d.status, { bold: true, color: d.status === 'Overdue' ? RED : d.status === 'Paid' ? GREEN : INK }]],
    [['Billed to', d.customer.name, { bold: true }], ['Customer ID', d.customer.ref || '—'], ['Address', d.customer.address || '—'], ['Pay by', d.payBy ? day(d.payBy) : (d.status === 'Paid' ? 'Paid' : day(d.dueDate)), { bold: true }]],
  );
  L.gap(8);
  L.heading('Items');
  L.table(
    [{ label: 'Product', width: 46 }, { label: 'Barcode', width: 18 }, { label: 'Cartons', width: 10, align: 'right' }, { label: 'Discount', width: 12, align: 'right' }, { label: 'Amount', width: 16, align: 'right' }],
    d.lines.map((l) => [`${l.product}${l.lot ? ` (lot ${l.lot})` : ''}`, l.barcode, String(l.cartons), l.discount ? ghs(l.discount) : '—', ghs(l.amount)]),
    { empty: 'The line detail of this invoice is not available yet.' },
  );
  const paid = money(d.payments.reduce((s, p) => s + p.amount, 0));
  const credited = money(d.credits.reduce((s, x) => s + x.amount, 0));
  L.totals([
    ['Invoice total (before tax)', ghs(d.amount)],
    ...(paid ? [['Paid', `− ${ghs(paid)}`]] : []),
    ...(credited ? [['Credit notes', `− ${ghs(credited)}`]] : []),
    ['Amount due', ghs(d.amountDue), { bold: true, color: d.amountDue > 0 ? INK : GREEN }],
  ]);
  if (d.payments.length) {
    L.heading('Payments received');
    L.table([{ label: 'Date', width: 50 }, { label: 'Amount', width: 50, align: 'right' }], d.payments.map((p) => [day(p.paidOn), ghs(p.amount)]));
  }
  if (d.credits.length) {
    L.heading('Credit notes');
    L.table([{ label: 'Credit note', width: 40 }, { label: 'Date', width: 30 }, { label: 'Amount', width: 30, align: 'right' }], d.credits.map((x) => [x.number, day(x.issuedOn), ghs(x.amount)]));
  }
  if (d.payBy && d.payBy !== d.dueDate) L.paragraph(`Please pay by ${day(d.payBy)}, the date agreed with Box for Less. Odoo's invoice due date is ${day(d.dueDate)}.`);
  return { filename: `Invoice-${fileSafe(d.number)}.pdf`, buffer: L.finish(footerNote(now)) };
}

// ---------------------------------------------------------------------------------------------
// the account statement
// ---------------------------------------------------------------------------------------------
// A running ledger: opening balance, then every invoice (charge), payment and credit note (both credits) by date, each with
// the balance after it. The invoices list keeps the open ones from before the period; they are folded into the opening balance.
function buildLedger(db, customerId, from, invoices, payments, credits) {
  const before = (sql, ...a) => db.prepare(sql).get(...a).t || 0;
  const opening = money(
    before('SELECT SUM(amount) AS t FROM odoo_invoices WHERE customer_id = ? AND invoice_date < ?', customerId, from)
    - before('SELECT SUM(amount) AS t FROM odoo_payments WHERE customer_id = ? AND paid_on < ?', customerId, from)
    - before(`SELECT SUM(amount) AS t FROM odoo_credit_notes WHERE customer_kind = 'BFL' AND customer_ref = ? AND issued_on < ?`, customerId, from));
  const events = [
    ...invoices.filter((i) => i.invoiceDate >= from).map((i) => ({ date: i.invoiceDate, order: 0, type: 'Invoice', details: `Invoice ${i.number}`, charge: i.amount, credit: 0 })),
    ...payments.map((p) => ({ date: p.paidOn, order: 1, type: 'Payment received', details: p.invoice ? `Payment ${p.invoice}` : 'Payment', charge: 0, credit: p.amount })),
    ...credits.map((x) => ({ date: x.issuedOn, order: 1, type: 'Credit note', details: `Credit note ${x.number}`, charge: 0, credit: x.amount })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
  let balance = opening;
  const rows = events.map((e) => { balance = money(balance + e.charge - e.credit); return { ...e, balance }; });
  const invoiced = money(events.reduce((t, e) => t + e.charge, 0));
  const paid = money(events.reduce((t, e) => t + e.credit, 0));
  return { opening, invoiced, paid, due: balance, rows };
}

export function statementData(db, customerId, todayStr) {
  const c = customerRow(db, customerId);
  const account = accountFor(db, c.id, todayStr);
  const from = formatDay(toDay(todayStr) - 365);
  const payBy = new Map(openInvoices(db, c.id, toDay(todayStr)).map((i) => [i.number, i.payBy]));
  const invoices = db.prepare(`SELECT i.number, i.amount, i.amount_due, i.invoice_date, i.due_date, i.state, o.odoo_number
                                 FROM odoo_invoices i LEFT JOIN odoo_orders o ON o.id = i.order_id
                                WHERE i.customer_id = ? AND (i.invoice_date >= ? OR (i.state = 'OPEN' AND i.amount_due > 0))
                                ORDER BY i.invoice_date DESC, i.id DESC`).all(c.id, from)
    .map((i) => {
      const pb = payBy.get(i.number) || null;
      const status = i.state === 'PAID' || i.amount_due <= 0 ? 'Paid' : (pb && pb < todayStr ? 'Overdue' : 'Open');
      return { number: i.number, order: i.odoo_number || null, invoiceDate: i.invoice_date, dueDate: i.due_date, payBy: pb, amount: money(i.amount), amountDue: money(i.amount_due), status };
    });
  const payments = db.prepare(`SELECT p.amount, p.paid_on, i.number AS invoice FROM odoo_payments p LEFT JOIN odoo_invoices i ON i.id = p.invoice_id
                                WHERE p.customer_id = ? AND p.paid_on >= ? ORDER BY p.paid_on DESC, p.id DESC`).all(c.id, from)
    .map((p) => ({ amount: money(p.amount), paidOn: p.paid_on, invoice: p.invoice || null }));
  const credits = db.prepare(`SELECT number, amount, issued_on, invoice_number FROM odoo_credit_notes
                               WHERE customer_kind = 'BFL' AND customer_ref = ? AND issued_on >= ? ORDER BY issued_on DESC, id DESC`).all(String(c.id), from)
    .map((x) => ({ number: x.number, amount: money(x.amount), issuedOn: x.issued_on, invoice: x.invoice_number || null }));
  const ledger = buildLedger(db, c.id, from, invoices, payments, credits);
  return {
    customer: { name: c.name, ref: c.odoo_customer_ref || null, address: c.delivery_address || null },
    asOf: todayStr, from, months: STATEMENT_MONTHS,
    ledger,
    summary: {
      creditLimit: account.creditLimit, amountOwed: money(account.amountOwed), overdue: money(account.overdue),
      openOrders: money(account.openOrders), availableCredit: account.availableCredit, paymentSchedule: account.paymentSchedule,
    },
    open: invoices.filter((i) => i.status !== 'Paid'),
    invoices, payments, credits,
  };
}

export function statementPdf(db, customerId, todayStr, now = new Date()) {
  const d = statementData(db, customerId, todayStr);
  const s = d.summary;
  const L = new Layout('ACCOUNT STATEMENT', `Account statement ${d.customer.name}`);
  L.facts(
    [['Customer', d.customer.name, { bold: true }], ['Customer ID', d.customer.ref || '—'], ['Address', d.customer.address || '—']],
    [['Statement date', day(d.asOf), { bold: true }], ['Period', `${day(d.from)} – ${day(d.asOf)}`], ['Payment terms', s.paymentSchedule || '—']],
  );
  L.gap(6);
  L.tiles([
    ['Amount owed', ghs(s.amountOwed)],
    ['Overdue', ghs(s.overdue), s.overdue > 0 ? RED : INK],
    ['Credit limit', s.creditLimit === null ? '—' : ghs(s.creditLimit)],
    ['Available credit', s.availableCredit === null ? '—' : ghs(s.availableCredit), GREEN],
  ]);
  L.paragraph(`Available credit = credit limit − amount owed − open orders (${ghs(s.openOrders)}).`);
  L.gap(6);
  L.heading('Open invoices');
  L.table(
    [{ label: 'Invoice', width: 24 }, { label: 'Date', width: 17 }, { label: 'Pay by', width: 17 }, { label: 'Amount', width: 21, align: 'right' }, { label: 'Still due', width: 21, align: 'right' }],
    d.open.map((i) => [`${i.number}${i.status === 'Overdue' ? ' (overdue)' : ''}`, day(i.invoiceDate), day(i.payBy || i.dueDate), ghs(i.amount), ghs(i.amountDue)]),
    { empty: 'No open invoices: nothing is owed.' },
  );
  L.totals([['Total still due', ghs(d.open.reduce((t, i) => t + i.amountDue, 0)), { bold: true }]]);
  L.heading('Account activity');
  const lg = d.ledger;
  L.totals([
    ['Opening balance', ghs(lg.opening)], ['Invoiced amount', ghs(lg.invoiced)], ['Amount paid', ghs(lg.paid)], ['Amount due', ghs(lg.due), { bold: true }],
  ]);
  L.table(
    [{ label: 'Date', width: 15 }, { label: 'Transactions', width: 20 }, { label: 'Details', width: 25 }, { label: 'Amount', width: 14, align: 'right' }, { label: 'Payments', width: 14, align: 'right' }, { label: 'Balance', width: 12, align: 'right' }],
    [[day(d.from), '*** Opening balance ***', '', '', '', ghs(lg.opening)],
      ...lg.rows.map((r) => [day(r.date), r.type, r.details, r.charge ? ghs(r.charge) : '', r.credit ? ghs(r.credit) : '', ghs(r.balance)])],
  );
  return { filename: `Statement-${fileSafe(d.customer.ref || d.customer.name)}-${d.asOf}.pdf`, buffer: L.finish(footerNote(now)) };
}

/** A cell for a spreadsheet: a leading = + - @ is defused so it never runs as a formula. */
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(',');

export function statementCsv(db, customerId, todayStr) {
  const d = statementData(db, customerId, todayStr);
  const s = d.summary;
  const out = [
    csvRow(['Box for Less — account statement']),
    csvRow(['Customer', d.customer.name]), csvRow(['Customer ID', d.customer.ref || '']), csvRow(['Statement date', d.asOf]), csvRow(['Period from', d.from]),
    '',
    csvRow(['Summary (GHS)', 'Value']),
    csvRow(['Amount owed', s.amountOwed]), csvRow(['Overdue', s.overdue]), csvRow(['Credit limit', s.creditLimit ?? '']),
    csvRow(['Open orders', s.openOrders]), csvRow(['Available credit', s.availableCredit ?? '']), csvRow(['Payment terms', s.paymentSchedule || '']),
    '',
    csvRow(['Date', 'Transactions', 'Details', 'Amount (GHS)', 'Payments (GHS)', 'Balance (GHS)']),
    csvRow([d.from, '*** Opening balance ***', '', '', '', d.ledger.opening]),
    ...d.ledger.rows.map((r) => csvRow([r.date, r.type, r.details, r.charge || '', r.credit || '', r.balance])),
    csvRow(['', 'Totals', '', d.ledger.invoiced, d.ledger.paid, d.ledger.due]),
    '',
    csvRow(['Invoices', 'Order', 'Invoice date', 'Odoo due date', 'Pay by', 'Amount (GHS)', 'Still due (GHS)', 'Status']),
    ...d.invoices.map((i) => csvRow([i.number, i.order || '', i.invoiceDate, i.dueDate, i.payBy || '', i.amount, i.amountDue, i.status])),
  ];
  return { filename: `Statement-${fileSafe(d.customer.ref || d.customer.name)}-${d.asOf}.csv`, text: `﻿${out.join('\r\n')}\r\n` };
}

