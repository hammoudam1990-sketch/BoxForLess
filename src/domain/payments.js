// Payment reminders (journey 4, screen S07).
//
// The platform REMINDS; it does not collect. Customers pay as they do today and Finance records the
// payment in Odoo; when Odoo shows the invoice paid, the reminders stop. The Sales Manager sets each
// credit customer's payment schedule:
//
//   DUE_DATE (default)   the payment day is each invoice's own due date
//   WEEKLY               a weekday, every week            e.g. every Wednesday
//   MONTHLY              a date, every month              e.g. the 25th
//
// For every open invoice the reminders fall on: the day BEFORE the payment day, the payment day, and then every
// 7 days while it stays unpaid. Only a credit customer is reminded (a cash customer has no invoices),
// and a reminder lists only that customer's own open invoices. Reminders never block an order — only
// the credit limit does. Every reminder is logged; "sent" means a person marked it sent, because no
// email, SMS or WhatsApp provider is connected yet (the message is ready to copy).
import { toDay, formatDay } from './expiry.js';

export const ScheduleKind = Object.freeze({ DUE_DATE: 'DUE_DATE', WEEKLY: 'WEEKLY', MONTHLY: 'MONTHLY' });
export const ReminderKind = Object.freeze({ BEFORE: 'BEFORE', DUE: 'DUE', OVERDUE: 'OVERDUE' });
export const ReminderStatus = Object.freeze({ PENDING: 'PENDING', SENT: 'SENT', NO_CONTACT: 'NO_CONTACT' });
export const OVERDUE_REPEAT_DAYS = 7;
/** A reminder missed because the server was off is still sent when it comes back, but only within this many days. */
export const CATCH_UP_DAYS = 6;

export class PaymentError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'PaymentError'; this.status = status; }
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ordinal = (n) => `${n}${[11, 12, 13].includes(n % 100) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
/** 0 = Sunday … 6 = Saturday, for a day number (1970-01-01 was a Thursday). */
const weekdayOf = (day) => (((day + 4) % 7) + 7) % 7;
const dayOfMonthOf = (day) => Number(formatDay(day).slice(8, 10));
const lastDayOfMonth = (day) => {
  const [y, m] = formatDay(day).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const money = (n) => Math.round(Number(n) * 100) / 100;
const gh = (n) => `GHS ${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const prettyDay = (day) => new Date(day * 86_400_000).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** Check and normalise a schedule from the screen. */
export function validateSchedule(input = {}) {
  const kind = String(input.kind || ScheduleKind.DUE_DATE);
  if (!Object.values(ScheduleKind).includes(kind)) throw new PaymentError('Choose due date, weekly or monthly.');
  if (kind === ScheduleKind.WEEKLY) {
    const w = Number(input.weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) throw new PaymentError('Choose a day of the week.');
    return { kind, weekday: w, dayOfMonth: null };
  }
  if (kind === ScheduleKind.MONTHLY) {
    const d = Number(input.dayOfMonth);
    if (!Number.isInteger(d) || d < 1 || d > 31) throw new PaymentError('Choose a date from 1 to 31.');
    return { kind, weekday: null, dayOfMonth: d };
  }
  return { kind, weekday: null, dayOfMonth: null };
}

export function describeSchedule(s) {
  if (!s || s.kind === ScheduleKind.DUE_DATE) return "Each invoice's due date";
  if (s.kind === ScheduleKind.WEEKLY) return `Every ${WEEKDAYS[s.weekday]}`;
  return `The ${ordinal(s.dayOfMonth)} of each month`;
}

/**
 * The day this invoice is expected to be paid, as a day number. Weekly and monthly schedules use the
 * first scheduled day on or after the invoice date (a month shorter than the chosen date uses its last day).
 */
export function paymentDayFor(invoiceDate, dueDate, schedule) {
  if (!schedule || schedule.kind === ScheduleKind.DUE_DATE) return toDay(dueDate);
  const start = toDay(invoiceDate);
  if (schedule.kind === ScheduleKind.WEEKLY) return start + ((schedule.weekday - weekdayOf(start) + 7) % 7);
  for (let d = start; d < start + 62; d += 1) {
    if (dayOfMonthOf(d) === Math.min(schedule.dayOfMonth, lastDayOfMonth(d))) return d;
  }
  return start;
}

/** The reminder days for a payment day, up to and including `today`: before, the day itself, then every 7 days. */
export function reminderDays(paymentDay, today) {
  const out = [];
  if (paymentDay - 1 <= today) out.push({ day: paymentDay - 1, kind: ReminderKind.BEFORE });
  if (paymentDay <= today) out.push({ day: paymentDay, kind: ReminderKind.DUE });
  for (let d = paymentDay + OVERDUE_REPEAT_DAYS; d <= today; d += OVERDUE_REPEAT_DAYS) out.push({ day: d, kind: ReminderKind.OVERDUE });
  return out;
}

export function getSchedule(db, customerId) {
  const r = db.prepare('SELECT kind, weekday, day_of_month FROM payment_schedules WHERE customer_id = ?').get(Number(customerId));
  return r ? { kind: r.kind, weekday: r.weekday, dayOfMonth: r.day_of_month } : { kind: ScheduleKind.DUE_DATE, weekday: null, dayOfMonth: null };
}

/** Set a credit customer's schedule. Sales Manager only (the route enforces it). */
export function setSchedule(db, customerId, input, by = null, now = new Date()) {
  const c = db.prepare('SELECT id, customer_type FROM customers WHERE id = ?').get(Number(customerId));
  if (!c) throw new PaymentError('That customer does not exist.', 404);
  if (c.customer_type === 'CASH') throw new PaymentError('A cash customer pays in cash and gets no reminders.');
  const s = validateSchedule(input);
  db.prepare(`INSERT INTO payment_schedules (customer_id, kind, weekday, day_of_month, updated_by, updated_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(customer_id) DO UPDATE SET kind = excluded.kind, weekday = excluded.weekday, day_of_month = excluded.day_of_month,
                                                    updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(c.id, s.kind, s.weekday, s.dayOfMonth, by, now.toISOString());
  return { customerId: c.id, ...s, description: describeSchedule(s) };
}

/** A customer's open invoices with the day each is expected to be paid. */
export function openInvoices(db, customerId, today) {
  const schedule = getSchedule(db, customerId);
  return db.prepare("SELECT id, number, amount_due, invoice_date, due_date FROM odoo_invoices WHERE customer_id = ? AND state = 'OPEN' AND amount_due > 0 ORDER BY due_date, id")
    .all(Number(customerId))
    .map((i) => {
      const pay = paymentDayFor(i.invoice_date, i.due_date, schedule);
      const ageDays = today - toDay(i.invoice_date);
      return {
        id: i.id, number: i.number, amountDue: i.amount_due, invoiceDate: i.invoice_date,
        payDay: pay, payBy: formatDay(pay), daysToPay: pay - today,
        daysSinceInvoice: ageDays, unsettled20d: ageDays >= 20,
      };
    });
}

function compose(customer, invoices, kind, schedule, today) {
  const lines = invoices.map((i) => {
    const when = i.daysToPay < 0 ? `was due ${prettyDay(i.payDay)} (${-i.daysToPay} day${i.daysToPay === -1 ? '' : 's'} overdue)`
      : i.daysToPay === 0 ? 'due today' : `pay by ${prettyDay(i.payDay)}`;
    return `  ${i.number} — ${gh(i.amountDue)} — ${when}`;
  });
  const total = money(invoices.reduce((s, i) => s + i.amountDue, 0));
  // The wording follows how things stand NOW (a reminder sent late, after a restart, must not say "due
  // tomorrow" about an invoice that is already overdue); the logged kind stays the day it was for.
  const tone = invoices.some((i) => i.daysToPay < 0) ? ReminderKind.OVERDUE : invoices.some((i) => i.daysToPay === 0) ? ReminderKind.DUE : kind;
  const opening = { BEFORE: 'A payment is due tomorrow.', DUE: 'A payment is due today.', OVERDUE: 'Some payments are now overdue.' }[tone];
  const subject = tone === ReminderKind.OVERDUE ? 'Overdue payment reminder — Box for Less' : 'Payment reminder — Box for Less';
  const body = [
    `Hello ${customer.name},`, '',
    `${opening} This is a friendly reminder of your open invoices:`, '',
    ...lines, '',
    `Total outstanding: ${gh(total)}.`,
    schedule.kind === ScheduleKind.DUE_DATE ? null : `Your payment day is: ${describeSchedule(schedule).toLowerCase()}.`,
    '',
    'If you have already paid, please ignore this message — thank you. If something looks wrong, please contact Box for Less.',
  ].filter((l) => l !== null).join('\n');
  return { subject, body, total };
}

/**
 * Work out which customers are due a reminder today and log one for each (once per customer per day).
 * Safe to run as often as you like. Returns the reminders it created.
 */
export function runReminders(db, todayStr, now = new Date()) {
  const today = toDay(todayStr);
  const created = [];
  const customers = db.prepare(`SELECT DISTINCT c.id, c.name, c.email, c.phone FROM customers c
                                  JOIN odoo_invoices i ON i.customer_id = c.id
                                 WHERE c.customer_type = 'CREDIT' AND c.is_active = 1 AND i.state = 'OPEN' AND i.amount_due > 0`).all();
  for (const c of customers) {
    const schedule = getSchedule(db, c.id);
    const invoices = openInvoices(db, c.id, today);
    // the latest reminder day reached by any open invoice
    let latest = null;
    for (const inv of invoices) {
      for (const r of reminderDays(inv.payDay, today)) if (!latest || r.day > latest.day) latest = r;
    }
    if (!latest || latest.day < today - CATCH_UP_DAYS) continue;
    if (db.prepare('SELECT 1 FROM payment_reminders WHERE customer_id = ? AND remind_on >= ?').get(c.id, formatDay(latest.day))) continue;

    const { subject, body, total } = compose(c, invoices, latest.kind, schedule, today);
    const to = String(c.email || '').includes('@') ? c.email : (c.phone || null);
    const status = to ? ReminderStatus.PENDING : ReminderStatus.NO_CONTACT;
    const id = Number(db.prepare(`INSERT INTO payment_reminders (customer_id, remind_on, kind, to_address, subject, body, invoice_count, total_due, status, created_at)
                                  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(c.id, formatDay(latest.day), latest.kind, to, subject, body, invoices.length, total, status, now.toISOString()).lastInsertRowid);
    created.push({ id, customerId: c.id, kind: latest.kind, status });
  }
  return created;
}

/**
 * Generate follow-up reminders specifically for credit customers who have not settled
 * their open invoices within 20+ days of the invoice/order date.
 */
export function runUnsettled20dFollowUps(db, todayStr, now = new Date()) {
  const today = toDay(todayStr);
  const created = [];
  const customers = db.prepare(`SELECT DISTINCT c.id, c.name, c.email, c.phone FROM customers c
                                  JOIN odoo_invoices i ON i.customer_id = c.id
                                 WHERE c.customer_type = 'CREDIT' AND c.is_active = 1 AND i.state = 'OPEN' AND i.amount_due > 0`).all();
  for (const c of customers) {
    const schedule = getSchedule(db, c.id);
    const unsettled = openInvoices(db, c.id, today).filter((i) => i.unsettled20d);
    if (!unsettled.length) continue;
    if (db.prepare("SELECT 1 FROM payment_reminders WHERE customer_id = ? AND remind_on = ? AND subject LIKE '%20%'").get(c.id, todayStr)) continue;

    const lines = unsettled.map((i) => `  ${i.number} — ${gh(i.amountDue)} — invoiced ${i.daysSinceInvoice} days ago (pay by ${prettyDay(i.payDay)})`);
    const total = money(unsettled.reduce((s, i) => s + i.amountDue, 0));
    const subject = '20-day unsettled payment follow-up — Box for Less';
    const body = [
      `Hello ${c.name},`, '',
      'Our records show the following invoice(s) have remained unsettled for 20 days or more since order/invoice date:', '',
      ...lines, '',
      `Total 20+ day outstanding balance: ${gh(total)}.`,
      schedule.kind === ScheduleKind.DUE_DATE ? null : `Your scheduled payment day is: ${describeSchedule(schedule).toLowerCase()}.`,
      '',
      'Kindly arrange settlement or contact Box for Less if payment has already been made.',
    ].filter((l) => l !== null).join('\n');

    const to = String(c.email || '').includes('@') ? c.email : (c.phone || null);
    const status = to ? ReminderStatus.PENDING : ReminderStatus.NO_CONTACT;
    const id = Number(db.prepare(`INSERT INTO payment_reminders (customer_id, remind_on, kind, to_address, subject, body, invoice_count, total_due, status, created_at)
                                  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(c.id, todayStr, ReminderKind.OVERDUE, to, subject, body, unsettled.length, total, status, now.toISOString()).lastInsertRowid);
    created.push({ id, customerId: c.id, kind: ReminderKind.OVERDUE, status, unsettledCount: unsettled.length });
  }
  return created;
}

/** A person marks a reminder as sent (by email, SMS or WhatsApp). */
export function markReminderSent(db, id, by = null, now = new Date()) {
  const r = db.prepare('SELECT id, status FROM payment_reminders WHERE id = ?').get(Number(id));
  if (!r) throw new PaymentError('That reminder does not exist.', 404);
  if (r.status !== ReminderStatus.PENDING) throw new PaymentError('This reminder is not waiting to be sent.', 409);
  db.prepare("UPDATE payment_reminders SET status = 'SENT', sent_at = ?, sent_by = ? WHERE id = ?").run(now.toISOString(), by, r.id);
}

/** Everything the Payments due screen shows. */
export function paymentsOverview(db, todayStr) {
  const today = toDay(todayStr);
  const rows = db.prepare(`SELECT i.customer_id, c.name AS customer FROM odoo_invoices i JOIN customers c ON c.id = i.customer_id
                            WHERE i.state = 'OPEN' AND i.amount_due > 0 GROUP BY i.customer_id ORDER BY c.name`).all();
  const invoices = [];
  for (const r of rows) {
    const schedule = getSchedule(db, r.customer_id);
    const last = db.prepare('SELECT remind_on, status FROM payment_reminders WHERE customer_id = ? ORDER BY remind_on DESC, id DESC LIMIT 1').get(r.customer_id);
    for (const i of openInvoices(db, r.customer_id, today)) {
      invoices.push({
        customerId: r.customer_id, customer: r.customer, number: i.number, amountDue: i.amountDue,
        invoiceDate: i.invoiceDate, daysSinceInvoice: i.daysSinceInvoice, unsettled20d: i.unsettled20d,
        payBy: i.payBy, daysToPay: i.daysToPay,
        bucket: i.daysToPay < 0 ? 'OVERDUE' : i.daysToPay <= 6 ? 'THIS_WEEK' : 'LATER',
        schedule: describeSchedule(schedule), lastReminder: last ? last.remind_on : null,
      });
    }
  }
  invoices.sort((a, b) => a.daysToPay - b.daysToPay || a.customer.localeCompare(b.customer));
  const sum = (bucket) => ({ count: invoices.filter((i) => i.bucket === bucket).length, amount: money(invoices.filter((i) => i.bucket === bucket).reduce((s, i) => s + i.amountDue, 0)) });
  const unsettled20 = invoices.filter((i) => i.unsettled20d);

  const credit = db.prepare(`SELECT c.id, c.name FROM customers c WHERE c.customer_type = 'CREDIT' AND c.is_active = 1
                               AND (EXISTS (SELECT 1 FROM odoo_invoices i WHERE i.customer_id = c.id) OR EXISTS (SELECT 1 FROM payment_schedules s WHERE s.customer_id = c.id))
                             ORDER BY c.name`).all();
  const reminders = db.prepare(`SELECT r.id, r.customer_id, c.name AS customer, r.remind_on, r.kind, r.to_address, r.subject, r.body, r.invoice_count, r.total_due, r.status, r.created_at, r.sent_at, r.sent_by
                                  FROM payment_reminders r JOIN customers c ON c.id = r.customer_id ORDER BY r.id DESC LIMIT 60`).all();
  return {
    today: todayStr,
    summary: {
      overdue: sum('OVERDUE'), thisWeek: sum('THIS_WEEK'), later: sum('LATER'),
      unsettled20d: { count: unsettled20.length, amount: money(unsettled20.reduce((s, i) => s + i.amountDue, 0)) },
      remindersWaiting: reminders.filter((r) => r.status === 'PENDING').length,
      remindersSent: reminders.filter((r) => r.status === 'SENT').length,
    },
    invoices,
    schedules: credit.map((c) => ({ customerId: c.id, customer: c.name, ...getSchedule(db, c.id), description: describeSchedule(getSchedule(db, c.id)) })),
    reminders: reminders.map((r) => ({
      id: r.id, customerId: r.customer_id, customer: r.customer, remindOn: r.remind_on, kind: r.kind, to: r.to_address, subject: r.subject, body: r.body,
      invoiceCount: r.invoice_count, totalDue: r.total_due, status: r.status, createdAt: r.created_at, sentAt: r.sent_at, sentBy: r.sent_by,
    })),
  };
}
