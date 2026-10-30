// The pieces both manager dashboards are built from (warehouse.js, sales-manager.js): the same cards, badges, states,
// date-range control and chart helpers, so the two modules look and behave as one system. Styles: css/warehouse.css.
import { h, toggleHidden } from './lib/dom.js';
import { icon } from './lib/lucide.js';

// ------------------------------------------------------------------ formatting
export const qty = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
export const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${qty(Math.abs(n))}`;
/** GHS amounts (the platform's currency): "GH₵ 48,750.00". */
export const ghs = (n, digits = 2) => `GH₵ ${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
/** A short GHS amount for axes and tight places: "GH₵ 48.8K". */
export const ghsShort = (n) => `GH₵ ${Number(n || 0).toLocaleString('en-GB', { notation: Math.abs(n) >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 })}`;
export const dateText = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
export const plural = (n, w) => `${qty(n)} ${w}${n === 1 ? '' : 's'}`;
export const greeting = (now = new Date()) => (now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening');
/** "2 hours ago", "3 days ago" — from a timestamp or a date. */
export function ago(iso, now = new Date()) {
  if (!iso) return '—';
  const at = String(iso).length <= 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  const mins = Math.round((now - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days} day${days === 1 ? '' : 's'} ago`;
  return dateText(iso);
}

// ------------------------------------------------------------------ building blocks
export const badge = (label, tone) => h('span', { class: `wh-badge ${tone}` }, label);
export const card = (cls, ...children) => h('section', { class: `wh-card ${cls || ''}`.trim() }, ...children);
export const cardHead = (title, sub, right) => h('div', { class: 'wh-card-head' },
  h('div', null, h('h2', null, title), sub ? h('p', null, sub) : null), right || null);
export const viewAll = (href, label = 'View All') => h('a', { class: 'wh-link', href }, label, icon('arrowRight'));
export const loading = (lines = 3) => h('div', { class: 'wh-skeleton', role: 'status', 'aria-label': 'Loading' }, Array.from({ length: lines }, () => h('i')));
export const empty = (title, text) => h('div', { class: 'wh-empty' }, h('b', null, title), text ? h('p', null, text) : null);
export const errorBox = (e) => h('div', { class: 'wh-error', role: 'alert' }, icon('alert'), h('span', null, e?.message || 'Could not load this. Try again.'));
export const sampleTag = (text) => h('span', { class: 'wh-tag', title: text }, 'Sample');
export const pageHead = (title, sub, right = null, eyebrow = null) => h('div', { class: 'wh-head' },
  h('div', null, eyebrow ? h('p', { class: 'wh-eyebrow' }, eyebrow) : null, h('h1', null, title), sub ? h('p', { class: 'wh-sub' }, sub) : null), right);
/** The value of one ?name= in the hash route. */
export const hashParam = (name) => new URLSearchParams(location.hash.split('?')[1] || '').get(name) || '';

// ------------------------------------------------------------------ the date-range control (built once)
export const WAREHOUSE_PERIODS = [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['last_month', 'Last Month'], ['year', 'This Year'], ['custom', 'Custom Date Range']];
export const SALES_PERIODS = [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['last_month', 'Last Month'], ['quarter', 'This Quarter'], ['year', 'This Year'], ['custom', 'Custom Date Range']];

/** A period select (+ from/to dates for a custom range). Calls onChange with { period } or { period:'custom', from, to }. */
export function periodControl(onChange, initial = 'week', options = WAREHOUSE_PERIODS) {
  const today = new Date().toISOString().slice(0, 10);
  const select = h('select', { class: 'wh-select', 'aria-label': 'Date range' },
    options.map(([v, t]) => h('option', { value: v, selected: v === initial }, t)));
  const from = h('input', { type: 'date', class: 'wh-input', 'aria-label': 'From', max: today });
  const to = h('input', { type: 'date', class: 'wh-input', 'aria-label': 'To', max: today, value: today });
  const apply = h('button', { type: 'button', class: 'wh-btn', onClick: () => { if (from.value && to.value) onChange(value()); } }, 'Apply');
  const custom = h('span', { class: 'wh-custom hidden' }, from, h('span', { class: 'wh-muted' }, 'to'), to, apply);
  select.addEventListener('change', () => {
    toggleHidden(custom, select.value !== 'custom');
    if (select.value !== 'custom') onChange(value());
    else from.focus();
  });
  function value() {
    return select.value === 'custom' ? { period: 'custom', from: from.value, to: to.value } : { period: select.value };
  }
  return { el: h('div', { class: 'wh-period' }, icon('calendar'), select, custom), value, select };
}

// ------------------------------------------------------------------ chart helpers
export const niceStep = (max) => {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x >= raw) || mag * 10;
};
const NS = 'http://www.w3.org/2000/svg';
/** An SVG element. */
export const s = (tag, attrs = {}, text = null) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== null) el.textContent = text;
  return el;
};
/** A bar with 4px rounded top corners, square at the baseline. */
export const barPath = (x, top, w, base) => {
  const r = Math.min(4, w / 2, Math.max(0, base - top));
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
};
/** Redraw `draw` whenever `el` changes width (charts fit their card). */
export function onResize(el, draw) {
  if ('ResizeObserver' in window) {
    let last = 0;
    new ResizeObserver(() => { if (el.isConnected && Math.abs(el.clientWidth - last) > 4) { last = el.clientWidth; draw(); } }).observe(el);
  }
  requestAnimationFrame(draw);
}
