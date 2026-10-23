// Staff screen S02 — Product visibility.
//
// Hide products from one customer, from a whole price class, or from everyone, by category, by brand or
// one product at a time. A hidden product is gone for that customer everywhere — lists, search, counts,
// its page and image, its price, and any order — and the server enforces it. Rules only hide; removing
// one switches it off and is logged. The preview uses the very filter the catalogue uses.
//
// Built once: the pickers and search fields are created a single time; only the lists around them change.
import { api, toast } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';
import { debounce } from './lib/util.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function renderVisibility(view) {
  let data = await fetch('/api/visibility').then((r) => (r.ok ? r.json() : Promise.reject(new Error('Could not load the rules.'))));

  // ---- add a rule (all fields built once) ------------------------------------------------------
  const who = h('select', { 'aria-label': 'Who it applies to', onChange: syncForm },
    [['ALL', 'Everyone (including visitors)'], ['PRICE_CLASS', 'A price class'], ['CUSTOMER', 'One customer']].map(([v, t]) => h('option', { value: v }, t)));
  const classSel = h('select', { 'aria-label': 'Price class' }, data.priceClasses.map((c) => h('option', { value: c }, c)));
  const custSearch = h('input', { type: 'search', placeholder: 'Find a customer by name…', 'aria-label': 'Find a customer', onInput: debounce(findCustomers, 250) });
  const custPick = h('select', { 'aria-label': 'Customer' }, h('option', { value: '' }, 'Search above, then choose…'));
  const what = h('select', { 'aria-label': 'What to hide', onChange: syncForm },
    [['CATEGORY', 'A category'], ['PRODUCT', 'One product'], ['BRAND', 'A brand']].map(([v, t]) => h('option', { value: v }, t)));
  const catSel = h('select', { 'aria-label': 'Category' }, categoryOptions());
  const prodSearch = h('input', { type: 'search', placeholder: 'Find a product by name or barcode…', 'aria-label': 'Find a product', onInput: debounce(findProducts, 250) });
  const prodPick = h('select', { 'aria-label': 'Product' }, h('option', { value: '' }, 'Search above, then choose…'));
  const brand = h('input', { type: 'text', maxlength: '60', placeholder: 'e.g. ABIDO', 'aria-label': 'Brand' });
  const problem = h('p', { class: 'reg-problem', role: 'status' });
  const addBtn = h('button', { type: 'button', onClick: add }, 'Hide it');

  const field = (label, ...nodes) => h('label', { class: 'team-field' }, h('span', { class: 'muted' }, label), ...nodes);
  const classField = field('Price class', classSel);
  const custField = field('Customer', custSearch, custPick);
  const catField = field('Category (and everything under it)', catSel);
  const prodField = field('Product', prodSearch, prodPick);
  const brandField = field('Brand', brand, h('span', { class: 'muted team-hint' }, 'Matches products whose name is, or starts with, this word.'));

  const rulesBody = h('tbody');
  const noRules = h('p', { class: 'muted hidden' }, 'No rules yet: every customer sees every active product.');
  const logBody = h('tbody');

  // preview
  const prevSearch = h('input', { type: 'search', placeholder: 'Find a customer to preview…', 'aria-label': 'Customer to preview', onInput: debounce(findPreviewCustomers, 250) });
  const prevPick = h('select', { 'aria-label': 'Customer to preview', onChange: () => runPreview() }, h('option', { value: '' }, 'Choose…'));
  const visitorBtn = h('button', { type: 'button', class: 'secondary', onClick: () => runPreview('visitor') }, 'See what a visitor sees');
  const prevOut = h('div', { class: 'muted' }, 'Choose a customer to see how many products they can see, and which are hidden from them.');

  setChildren(view,
    h('h1', null, 'Product visibility'),
    h('div', { class: 'notice' },
      h('b', null, 'Hide, never delete. '),
      'A hidden product is gone for that customer everywhere — lists, search, counts, its page and picture, its price, and any order — and the server enforces it. ',
      'Brand rules match the start of the product name until the Brand field is filled in Odoo.'),
    h('div', { class: 'card' },
      h('h2', null, 'Add a rule'),
      h('div', { class: 'team-grid' }, field('Who it applies to', who), classField, custField, field('What to hide', what), catField, prodField, brandField),
      problem, h('div', { class: 'controls' }, addBtn)),
    h('div', { class: 'card' },
      h('h2', null, 'Rules in force'),
      h('div', { class: 'exp-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Who', 'Hides', 'Added', ''].map((t) => h('th', null, t)))), rulesBody)),
      noRules),
    h('div', { class: 'card' },
      h('h2', null, 'Preview: what does this customer see?'),
      h('div', { class: 'controls' }, prevSearch, prevPick, visitorBtn), prevOut),
    h('div', { class: 'card' },
      h('h2', null, 'Change log'),
      h('div', { class: 'exp-wrap' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Who', 'Change'].map((t) => h('th', null, t)))), logBody))));

  function categoryOptions() {
    // every path and every path above it, so a manager can hide "FOOD" or "FOOD / SPICES" as well as a leaf
    const counts = new Map();
    for (const c of data.categories) {
      const parts = c.path.split(' / ');
      parts.forEach((_, i) => { const p = parts.slice(0, i + 1).join(' / '); counts.set(p, (counts.get(p) || 0) + c.n); });
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([p, n]) => h('option', { value: p }, `${'— '.repeat(p.split(' / ').length - 1)}${p.split(' / ').pop()} (${n})`));
  }

  function syncForm() {
    toggleHidden(classField, who.value !== 'PRICE_CLASS');
    toggleHidden(custField, who.value !== 'CUSTOMER');
    toggleHidden(catField, what.value !== 'CATEGORY');
    toggleHidden(prodField, what.value !== 'PRODUCT');
    toggleHidden(brandField, what.value !== 'BRAND');
  }

  async function findCustomers() {
    const q = custSearch.value.trim();
    if (q.length < 2) return;
    const r = await api.shelfLifeCustomers(q).catch(() => ({ customers: [] }));
    setChildren(custPick, r.customers.length ? r.customers.map((c) => h('option', { value: String(c.id) }, c.name)) : [h('option', { value: '' }, 'No customer matches')]);
  }
  async function findProducts() {
    const q = prodSearch.value.trim();
    if (q.length < 2) return;
    const r = await api.products({ search: q, limit: 20 }).catch(() => ({ items: [] }));
    setChildren(prodPick, r.items.length ? r.items.map((p) => h('option', { value: p.barcode }, `${p.name} (${p.barcode})`)) : [h('option', { value: '' }, 'No product matches')]);
  }
  async function findPreviewCustomers() {
    const q = prevSearch.value.trim();
    if (q.length < 2) return;
    const r = await api.shelfLifeCustomers(q).catch(() => ({ customers: [] }));
    setChildren(prevPick, [h('option', { value: '' }, 'Choose…'), ...r.customers.map((c) => h('option', { value: String(c.id) }, c.name))]);
  }

  async function runPreview(mode) {
    const id = mode === 'visitor' ? '' : prevPick.value;
    if (mode !== 'visitor' && !id) return;
    let p;
    try { p = await fetch(`/api/visibility/preview${id ? `?customer=${encodeURIComponent(id)}` : ''}`).then((r) => r.json()); } catch (e) { toast(e.message, 'err'); return; }
    const label = id ? prevPick.selectedOptions[0].textContent : 'A visitor';
    setChildren(prevOut,
      h('p', null, h('b', null, label), ` sees ${p.visible.toLocaleString()} of ${p.total.toLocaleString()} products. `, p.hidden ? `${p.hidden.toLocaleString()} are hidden.` : 'Nothing is hidden from them.'),
      p.hiddenSample.length ? h('ul', null, p.hiddenSample.map((x) => h('li', null, `${x.name} (${x.barcode})`))) : null,
      p.hidden > p.hiddenSample.length ? h('p', { class: 'muted' }, `…and ${(p.hidden - p.hiddenSample.length).toLocaleString()} more.`) : null);
  }

  function paint() {
    setChildren(rulesBody, data.rules.map((r) => h('tr', { class: r.active ? '' : 'muted' },
      h('td', null, r.who), h('td', null, r.hides),
      h('td', { class: 'muted' }, `${r.createdBy || ''} ${when(r.createdAt)}`, r.active ? '' : ` · switched off ${when(r.removedAt)}`),
      h('td', null, r.active ? h('button', { type: 'button', class: 'secondary', onClick: () => remove(r) }, 'Show again') : h('span', { class: 'badge' }, 'Off')))));
    toggleHidden(noRules, data.rules.length > 0);
    setChildren(logBody, data.log.map((l) => h('tr', null, h('td', { class: 'muted' }, when(l.at)), h('td', null, l.by || ''), h('td', null, `${l.action === 'ADDED' ? 'Hid' : 'Showed again'}: ${l.detail}`))));
  }

  async function reload() { data = await fetch('/api/visibility').then((r) => r.json()); paint(); }

  async function add() {
    problem.textContent = '';
    const body = { scopeType: who.value, targetType: what.value };
    if (who.value === 'PRICE_CLASS') body.scopeValue = classSel.value;
    if (who.value === 'CUSTOMER') { if (!custPick.value) { problem.textContent = 'Search for the customer, then choose them.'; return; } body.scopeValue = custPick.value; }
    body.targetValue = what.value === 'CATEGORY' ? catSel.value : what.value === 'PRODUCT' ? prodPick.value : brand.value.trim();
    if (!body.targetValue) { problem.textContent = 'Say what to hide.'; return; }
    addBtn.disabled = true;
    try {
      const r = await post('/api/visibility/rules', body);
      toast(`Hidden: ${r.rule.hides} from ${r.rule.who}.`, 'ok');
      brand.value = '';
      await reload();
    } catch (e) { problem.textContent = e.message; } finally { addBtn.disabled = false; }
  }

  async function remove(r) {
    if (!window.confirm(`Show again?\n\n${r.who}: ${r.hides}`)) return;
    try { await post(`/api/visibility/rules/${r.id}/remove`, {}); await reload(); } catch (e) { toast(e.message, 'err'); }
  }

  syncForm();
  paint();
}
