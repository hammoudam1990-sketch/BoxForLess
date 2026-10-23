// Staff screen — Rep customers.
//
// Give each customer to a sales rep. A rep sees only their own customers (My visits, My month). Two kinds
// are listed: the SAMPLE shops on the expiry list, and the customers BFL knows. Pick a rep for a customer
// and it is saved at once. Once Odoo is connected the salesperson comes from Odoo and is set there.
//
// Built once: the search box and the table rows are created a single time; searching and filtering only
// show or hide rows, and saving only changes the one row's own select.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';
import { debounce } from './lib/util.js';

export async function renderRepCustomers(view) {
  let data;
  try { data = await api.repCustomers(); } catch (e) { setChildren(view, h('h1', null, 'Rep customers'), h('div', { class: 'card errbox' }, e.message)); return; }

  const rows = [...data.shops, ...data.customers].map((c) => ({ c, tr: null, sel: null, saved: c.repId }));
  const repName = (id) => (data.reps.find((r) => r.id === id) || {}).name || '';

  const search = h('input', { type: 'search', placeholder: 'Find a customer by name or Odoo ID…', 'aria-label': 'Find a customer', onInput: debounce(apply, 150) });
  const repFilter = h('select', { 'aria-label': 'Show customers of', onChange: apply },
    [h('option', { value: '' }, 'Every rep'), h('option', { value: 'NONE' }, 'No rep yet'), ...data.reps.map((r) => h('option', { value: r.id }, r.name))]);
  const kindFilter = h('select', { 'aria-label': 'Kind of customer', onChange: apply },
    [['', 'All customers'], ['SHOP', 'Sample shops (expiry list)'], ['BFL', 'Customers in BFL']].map(([v, t]) => h('option', { value: v }, t)));
  const count = h('p', { class: 'muted', role: 'status' });
  const tbody = h('tbody');

  for (const row of rows) {
    const c = row.c;
    row.sel = h('select', { 'aria-label': `Sales rep for ${c.name}`, onChange: () => save(row) },
      [h('option', { value: '' }, '— no rep —'), ...data.reps.map((r) => h('option', { value: r.id }, r.name))]);
    row.sel.value = c.repId || '';
    row.tr = h('tr', null,
      h('td', null, h('b', null, c.name), c.kind === 'SHOP' ? h('span', { class: 'badge' }, ' SAMPLE') : null),
      h('td', null, c.odooId || '—'),
      h('td', { class: 'muted' }, c.kind === 'SHOP' ? 'Sample shop' : c.customerType === 'CASH' ? 'Cash customer' : 'Customer'),
      h('td', null, row.sel));
    tbody.appendChild(row.tr);
  }

  function apply() {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const c = row.c;
      const ok = (!q || c.name.toLowerCase().includes(q) || String(c.odooId).toLowerCase().includes(q))
        && (!kindFilter.value || c.kind === kindFilter.value)
        && (!repFilter.value || (repFilter.value === 'NONE' ? !row.saved : row.saved === repFilter.value));
      // only the first 200 matches are shown, so the page stays light
      const show = ok && shown < 200;
      if (ok) shown += 1;
      row.tr.classList.toggle('hidden', !show);
    }
    count.textContent = shown > 200 ? `${shown} customers match — showing the first 200. Search to narrow it down.` : `${shown} customer${shown === 1 ? '' : 's'}`;
  }

  async function save(row) {
    const want = row.sel.value;
    row.sel.disabled = true;
    try {
      await api.assignRepCustomer(row.c.kind, row.c.id, want || null);
      row.saved = want || null;
      toast(want ? `${row.c.name} now belongs to ${repName(want)}.` : `${row.c.name} has no rep now.`, 'ok');
    } catch (e) {
      row.sel.value = row.saved || '';
      toast(e.message, 'err');
    } finally { row.sel.disabled = false; }
  }

  setChildren(view,
    h('h1', null, 'Rep customers'),
    h('div', { class: data.odooConnected ? 'notice' : 'card' },
      h('p', null, 'Choose which sales rep each customer belongs to. A rep sees only their own customers.'),
      h('p', { class: 'muted' }, data.odooConnected
        ? 'Odoo is connected: the salesperson comes from Odoo. Change it there; a change made here is overwritten by the next sync.'
        : 'Until Odoo is connected you set this here. After that, the salesperson on the customer in Odoo is used. A new rep is added on the Team screen.')),
    h('div', { class: 'card' },
      h('div', { class: 'controls' }, search, kindFilter, repFilter),
      count,
      h('div', { class: 'exp-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Customer', 'Odoo ID', 'Kind', 'Sales rep'].map((t) => h('th', null, t)))),
        tbody))));
  apply();
}
