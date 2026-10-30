// Staff screen S04 — Returns to classify.
//
// Returns are handled in ODOO: the return delivery goes to a quarantine location (never back into sellable
// stock) and Finance issues the credit note. BFL reads them. Odoo has no field for WHY goods came back, so
// the warehouse records the reason here — damaged, expired or other — within three days; after that the
// return shows on the dashboard. A return for EXPIRY on a lot where the customer had agreed a discount is
// flagged to the Sales Manager as a broken agreement. A Sales Manager can read everything here but only the
// warehouse decides the reason.
//
// Built once; each row's reason controls are created a single time per refresh and only the rows change.
import { api, toast } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';

const day = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const money = (n) => `GHS ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const REASONS = [['', 'Choose a reason…'], ['DAMAGED', 'Damaged'], ['EXPIRED', 'Expired'], ['OTHER', 'Other']];

export async function renderReturns(view) {
  const me = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({}));
  const canClassify = ['ADMIN', 'WAREHOUSE'].includes(me.staff?.role);

  const tiles = h('div', { class: 'exp-tiles' });
  const waiting = h('div', { class: 'ret-list' });
  const noWaiting = h('p', { class: 'muted hidden' }, 'Nothing is waiting for a reason. Returns appear here as Odoo receives them.');
  const broken = h('tbody');
  const brokenCard = h('div', { class: 'card hidden' },
    h('h2', null, 'Agreements broken'),
    h('p', { class: 'muted' }, 'A return for expiry on a lot where the customer had agreed a discount on a shop visit, or any return of cartons bought on a clearance offer (not returnable). For the Sales Manager: the agreement record and the credit note already given.'),
    h('div', { class: 'exp-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Customer', 'Rep', 'Product', 'Lot', 'Agreed discount', 'Agreed by', 'On', 'Credit note given'].map((t) => h('th', null, t)))), broken)));
  const expected = h('tbody');
  const expectedCard = h('div', { class: 'card hidden' },
    h('h2', null, 'Returns expected'),
    h('p', { class: 'muted' }, 'Lots a customer refused to keep at a discount on a shop visit, with the reason the rep recorded. Not received yet — when Odoo receives the return it appears above.'),
    h('div', { class: 'exp-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Customer', 'Rep', 'Product', 'Lot', 'Cartons on shelf', 'Expires', 'Reason for the return'].map((t) => h('th', null, t)))), expected)));
  const done = h('div', { class: 'ret-list' });
  const noDone = h('p', { class: 'muted hidden' }, 'No return has been classified yet.');

  setChildren(view,
    h('h1', null, 'Sales Rep Returns'),
    h('div', { class: 'notice' },
      h('b', null, 'Returns are handled in Odoo. '),
      'BFL reads them and records the reason. Returned cartons come off the customer\'s shelf record and the matching shop alert closes as Returned. ',
      canClassify ? '' : 'You can read this screen; the warehouse records the reasons.'),
    tiles,
    h('div', { class: 'card' }, h('h2', null, 'Waiting for a reason'), waiting, noWaiting),
    brokenCard, expectedCard,
    h('div', { class: 'card' }, h('h2', null, 'Classified'), done, noDone));

  function tile(label, n, tone) {
    return h('div', { class: `exp-tile ${tone}`, style: { cursor: 'default' } }, h('span', { class: 'exp-tile-n' }, String(n)), h('span', { class: 'exp-tile-l' }, label));
  }

  function returnCard(r) {
    const reason = h('select', { 'aria-label': `Reason for ${r.number}`, onChange: sync }, REASONS.map(([v, t]) => h('option', { value: v, selected: v === (r.reason || '') }, t)));
    const note = h('input', { type: 'text', maxlength: '300', placeholder: 'What is the other reason?', 'aria-label': 'Note', value: r.note || '' });
    const save = h('button', { type: 'button', onClick: async () => {
      if (!reason.value) { toast('Choose a reason first.', 'err'); return; }
      save.disabled = true;
      try { await api.classifyReturn(r.id, { reason: reason.value, note: note.value }); await load(); } catch (e) { toast(e.message, 'err'); save.disabled = false; }
    } }, r.reason ? 'Change' : 'Save reason');
    function sync() { toggleHidden(note, reason.value !== 'OTHER'); }
    sync();
    return h('article', { class: `ret-card${r.overdue ? ' overdue' : ''}` },
      h('div', { class: 'ret-top' },
        h('div', null, h('b', null, r.number), ' · ', r.customer, r.rep ? h('span', { class: 'muted' }, ` · rep ${r.rep}`) : null),
        r.overdue ? h('span', { class: 'badge err' }, `${r.ageDays} days — overdue`) : h('span', { class: 'muted' }, r.ageDays === 0 ? 'Received today' : `Received ${day(r.receivedOn)} (${r.ageDays} day${r.ageDays === 1 ? '' : 's'} ago)`)),
      h('ul', { class: 'ret-lines' }, r.lines.map((l) => h('li', null, `${l.cartons} × ${l.product}`, l.barcode ? h('span', { class: 'muted' }, ` · Barcode ${l.barcode}`) : null, l.lot ? h('span', { class: 'muted' }, ` · lot ${l.lot}`) : null))),
      r.creditNotes.length ? h('p', { class: 'muted' }, 'Credit note: ', r.creditNotes.map((n) => `${n.number} (${money(n.amount)})`).join(', ')) : h('p', { class: 'muted' }, 'No credit note yet — Finance issues it in Odoo.'),
      r.brokenAgreement ? h('p', { class: 'ret-broken' }, (r.brokenAgreement.kind === 'CLEARANCE' ? `Agreement exception: these cartons were sold at ${r.brokenAgreement.discountPct}% off as not returnable.` : `Agreement exception: ${r.brokenAgreement.discountPct}% discount was agreed for this lot.`)) : null,
      r.reason && !canClassify ? h('p', null, h('b', null, 'Reason: '), r.reasonLabel, r.note ? ` — ${r.note}` : '', r.classifiedBy ? h('span', { class: 'muted' }, ` (by ${r.classifiedBy}, ${day(r.classifiedAt)})`) : null) : null,
      canClassify ? h('div', { class: 'controls' }, reason, note, save, r.classifiedBy ? h('span', { class: 'muted' }, `by ${r.classifiedBy}, ${day(r.classifiedAt)}`) : null) : null);
  }

  async function load() {
    let d;
    try { d = await api.returns(); } catch (e) { toast(e.message, 'err'); return; }
    setChildren(tiles,
      tile('Waiting for a reason', d.counts.unclassified, d.counts.unclassified ? 'warn' : 'ok'),
      tile('Overdue (over 3 days)', d.counts.overdue, d.counts.overdue ? 'err' : 'ok'),
      tile('Expected from shops', d.counts.expected, 'info'),
      tile('Agreements broken', d.brokenAgreements.length, d.brokenAgreements.length ? 'err' : 'ok'));
    setChildren(waiting, d.unclassified.map(returnCard));
    toggleHidden(noWaiting, d.unclassified.length > 0);
    setChildren(broken, d.brokenAgreements.map((r) => h('tr', null,
      h('td', null, h('b', null, r.customer)), h('td', null, r.rep || '—'), h('td', null, r.brokenAgreement.product), h('td', null, r.brokenAgreement.lot || '—'),
      h('td', { class: 'num' }, `${r.brokenAgreement.discountPct}%`), h('td', null, r.brokenAgreement.agreedBy), h('td', null, day(r.brokenAgreement.agreedOn)), h('td', null, r.brokenAgreement.creditNoteGiven || 'none yet'))));
    toggleHidden(brokenCard, d.brokenAgreements.length === 0);
    setChildren(expected, d.expected.map((r) => h('tr', null,
      h('td', null, h('b', null, r.customer)),
      h('td', null, r.rep || '—'),
      h('td', null, r.product),
      h('td', null, r.lot),
      h('td', { class: 'num' }, String(r.cartons)),
      h('td', null, day(r.expiryDate)),
      h('td', null, r.returnReason ? `${r.returnReason}${r.returnNote ? ` — ${r.returnNote}` : ''}` : '—'))));
    toggleHidden(expectedCard, d.expected.length === 0);
    setChildren(done, d.classified.slice(0, 40).map(returnCard));
    toggleHidden(noDone, d.classified.length > 0);
  }

  await load();
}
