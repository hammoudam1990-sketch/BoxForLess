// Staff screen — the shop-visit log.
//
// Every visit a sales rep saves on the phone app lands here, newest first: who visited, which
// shop, when, and what they found on each lot (sold out, a discount agreed, a return expected
// with its reason, or not checked). Read-only; the Sales Manager and the administrator use it to
// follow the team's visits. The rep's own screens stay on the phone app.
import { api } from './api.js';
import { h, setChildren } from './lib/dom.js';

const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const time = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

const OUTCOME_TONE = {
  'Sold out': 'success',
  'Discount agreed': '',
  'Return expected': 'warning',
  'Not checked': 'neutral',
};

function lineText(l) {
  const bits = [];
  if (l.cartonsOnShelf !== null && l.cartonsOnShelf !== undefined) bits.push(`${l.cartonsOnShelf} ctn on the shelf`);
  if (l.discountPct !== null && l.discountPct !== undefined) bits.push(`${l.discountPct}% proposed${l.contactName ? ` by ${l.contactName}` : ''}`);
  return bits.length ? ` — ${bits.join(' · ')}` : '';
}

export async function renderVisits(view) {
  setChildren(view,
    h('h1', null, 'Shop visits'),
    h('p', { class: 'muted' }, 'Every visit a sales rep has saved, newest first. Read-only — the rep records visits on the phone app.'),
    h('div', { class: 'card' }, h('div', { class: 'sk-lines', role: 'status', 'aria-label': 'Loading' }, h('i'), h('i'), h('i'))));

  let data;
  try { data = await api.shelfVisitLog(200); } catch (e) {
    setChildren(view,
      h('h1', null, 'Shop visits'),
      h('div', { class: 'card errbox', role: 'alert' }, e.message || 'Could not load the visits.'));
    return;
  }

  const visits = data.visits || [];
  setChildren(view,
    h('h1', null, 'Shop visits'),
    h('p', { class: 'muted' }, `${visits.length} visit${visits.length === 1 ? '' : 's'} recorded · newest first. Read-only — the rep records visits on the phone app.`),
    visits.length
      ? visits.map((v) => h('div', { class: 'card' },
        h('div', { class: 'exp-wrap', style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '6px' } },
          h('h2', { style: { margin: 0 } }, v.customer),
          h('span', { class: 'muted' }, `${v.rep} · ${time(v.createdAt)}`)),
        h('ul', { class: 'ret-lines' }, v.lines.map((l) => h('li', null,
          h('span', { class: `bfl-badge ${OUTCOME_TONE[l.outcome] ?? 'neutral'}`.trim() }, l.outcome),
          ' ',
          h('b', null, l.productName),
          l.lotName ? h('span', { class: 'muted' }, ` · lot ${l.lotName}`) : null,
          h('span', { class: 'muted' }, lineText(l)),
          l.returnReason ? h('div', { class: 'muted', style: { marginTop: '3px' } }, h('b', null, 'Reason for the return: '), l.returnReason) : null)))))
      : h('div', { class: 'card' }, h('p', { class: 'muted' }, 'No visit has been saved yet. When a rep taps "Save visit" on the phone app, the visit appears here.')));
}
