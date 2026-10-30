// Date ranges for the dashboards: "today", "this week", "this month", … as calendar days (both ends included,
// 'YYYY-MM-DD'), the equivalent range before it (for "vs last month" style comparisons), and the days in a range.
// A week starts on Monday. A month or quarter in progress runs to today.
import { toDay, formatDay } from './expiry.js';

export const PERIOD_LABELS = Object.freeze({
  today: 'Today', week: 'This week', month: 'This month', last_month: 'Last month', quarter: 'This quarter', year: 'This year', custom: 'Custom range',
});
export const MAX_CUSTOM_DAYS = 400;

export class PeriodError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'PeriodError'; this.status = status; }
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (y, m, d) => toDay(`${y}-${pad(m)}-${pad(d)}`);
const ymd = (day) => formatDay(day).split('-').map(Number);
const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** The first day of the month `n` months from (y, m). */
const monthStart = (y, m, n = 0) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); return dayOf(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/**
 * The days a period covers. `allowed` limits the period names a screen offers; anything else falls back to `fallback`.
 * @returns {{period:string, label:string, start:string, end:string}}
 */
export function periodRange(period, { from = null, to = null } = {}, today, { allowed = Object.keys(PERIOD_LABELS), fallback = 'week' } = {}) {
  const key = allowed.includes(period) ? period : fallback;
  const t = toDay(today);
  const [y, m] = today.split('-').map(Number);
  let start = t;
  let end = t;
  if (key === 'week') start = t - ((((t + 3) % 7) + 7) % 7);          // 1970-01-01 was a Thursday
  else if (key === 'month') start = dayOf(y, m, 1);
  else if (key === 'last_month') { start = monthStart(y, m, -1); end = dayOf(y, m, 1) - 1; }
  else if (key === 'quarter') start = dayOf(y, m - ((m - 1) % 3), 1);
  else if (key === 'year') start = dayOf(y, 1, 1);
  else if (key === 'custom') {
    const f = toDay(from);
    const e = toDay(to);
    if (f === null || e === null) throw new PeriodError('Choose a start and an end date.');
    if (f > e) throw new PeriodError('The start date is after the end date.');
    if (e - f > MAX_CUSTOM_DAYS) throw new PeriodError(`Choose a range of at most ${MAX_CUSTOM_DAYS} days.`);
    start = f; end = e;
  }
  return { period: key, label: key === 'custom' ? `${formatDay(start)} to ${formatDay(end)}` : PERIOD_LABELS[key], start: formatDay(start), end: formatDay(end) };
}

/**
 * The equivalent range just before: yesterday; the same weekdays last week; the same days of last month (cut at its
 * end); the month before last month; the same days of last quarter; the same dates last year; for a custom range, as
 * many days immediately before it.
 */
export function previousRange(range) {
  const s = toDay(range.start);
  const e = toDay(range.end);
  const length = e - s;
  const [sy, sm] = ymd(s);
  // a month (or quarter) in progress starts on its first day, so the one before ends the day before `s`
  const sameDaysBefore = (months) => { const start = monthStart(sy, sm, -months); return { start, end: Math.min(start + length, s - 1) }; };
  let p;
  if (range.period === 'today') p = { start: s - 1, end: e - 1 };
  else if (range.period === 'week') p = { start: s - 7, end: e - 7 };
  else if (range.period === 'month') p = sameDaysBefore(1);
  else if (range.period === 'last_month') { const st = monthStart(sy, sm, -1); p = { start: st, end: s - 1 }; }
  else if (range.period === 'quarter') p = sameDaysBefore(3);
  else if (range.period === 'year') {
    const [ey, em, ed] = ymd(e);
    p = { start: dayOf(sy - 1, 1, 1), end: dayOf(ey - 1, em, Math.min(ed, lastDayOfMonth(ey - 1, em))) };
  } else p = { start: s - length - 1, end: s - 1 };
  return { period: range.period, label: 'previous period', start: formatDay(p.start), end: formatDay(p.end) };
}

/**
 * The whole calendar period a range belongs to: this week runs to Sunday, this month to its last day, this quarter to
 * the end of its third month, this year to 31 December. Today, last month and a custom range are already whole.
 * Targets cover the whole period; sales so far are counted up to today.
 */
export function fullRange(range) {
  const s = toDay(range.start);
  const [y, m] = ymd(s);
  const lastOf = (yy, mm) => formatDay(dayOf(yy, mm, lastDayOfMonth(yy, mm)));
  if (range.period === 'week') return { start: range.start, end: formatDay(s + 6) };
  if (range.period === 'month') return { start: range.start, end: lastOf(y, m) };
  if (range.period === 'quarter') { const [ey, em] = ymd(monthStart(y, m, 2)); return { start: range.start, end: lastOf(ey, em) }; }
  if (range.period === 'year') return { start: range.start, end: `${y}-12-31` };
  return { start: range.start, end: range.end };
}

/** Every day of a range as a day number. */
export function daysOf(range) {
  const out = [];
  for (let d = toDay(range.start); d <= toDay(range.end); d += 1) out.push(d);
  return out;
}

export const daysInMonthOf = (day) => { const [y, m] = ymd(day); return lastDayOfMonth(y, m); };
export const monthKeyOf = (day) => formatDay(day).slice(0, 7);
