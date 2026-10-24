// Sales-rep phone screens: R01 My visits and R02 Visit form.
//
// A sales rep is whoever signed in: the server takes the rep from the session, so a rep sees only
// themselves here and only their own shops. The Sales Manager and the administrator get a picker, to
// look at any rep. Built so that nothing the rep types into is ever
// rebuilt: the search box, the rep picker and each lot's fields are created once; only the lists
// around them are replaced.
window.__bflBooted = true; // tells boot-guard.js the page started
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';
import { debounce, createLatest } from './lib/util.js';
import { createOrderView } from './rep-order.js';

const app = document.getElementById('app');
const latest = createLatest();
const REP_KEY = 'bfl.sampleRep';

const OUTCOMES = [
  ['SOLD_OUT', 'Sold out', 'Nothing left on the shelf'],
  ['DISCOUNT_AGREED', 'Discount agreed', 'The customer will keep it at a discount'],
  ['RETURN_EXPECTED', 'Return expected', 'The customer refuses the discount'],
  ['NOT_CHECKED', 'Not checked', 'Shop closed or no time — due again in 7 days'],
];

const dateText = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const daysText = (d) => (d < 0 ? `expired ${plural(-d, 'day')} ago` : d === 0 ? 'expires today' : `${plural(d, 'day')} left`);

let reps = [];
let repId = '';
const state = { q: '' };

// ---- the pieces built once ----------------------------------------------------------------
const repSelect = h('select', { id: 'repPick', 'aria-label': 'Which sales rep are you?', onChange: () => {
  repId = repSelect.value;
  try { localStorage.setItem(REP_KEY, repId); } catch { /* storage blocked */ }
  showList();
} });
const search = h('input', {
  type: 'search', class: 'rep-search', placeholder: 'Find a shop by name or Odoo ID', 'aria-label': 'Find a shop',
  inputmode: 'search', autocomplete: 'off',
  onInput: debounce(() => { state.q = search.value.trim(); loadList(); }, 250),
});
const totals = h('p', { class: 'rep-totals', role: 'status' });
const listBox = h('div');
// "My month": a sales rep's own customers and figures, nothing company-wide (shown to reps only)
const monthCard = h('div', { class: 'card rep-month hidden' });
const listView = h('section', { 'aria-label': 'My visits' },
  h('h1', null, 'My visits'),
  monthCard,
  h('div', { class: 'card rep-as', id: 'repAs' },
    h('label', { for: 'repPick' }, 'Visiting as'),
    repSelect,
    h('p', { class: 'rep-note' }, "You are looking at a rep's shops as a manager. A sales rep sees only their own.")),
  search, totals, listBox);
const sheetView = h('section', { 'aria-label': 'Visit form', class: 'hidden' });

// A sales rep can also place an order for one of their customers (the tabs show for a rep only; the server checks too).
const orders = createOrderView({ onBack: () => showTab('visits') });
const visitsTab = h('button', { type: 'button', role: 'tab', class: 'rep-tab active', 'aria-selected': 'true', onClick: () => showTab('visits') }, 'Visits');
const orderTab = h('button', { type: 'button', role: 'tab', class: 'rep-tab', 'aria-selected': 'false', onClick: () => showTab('order') }, 'New order');
const tabs = h('div', { class: 'rep-tabs hidden', role: 'tablist', 'aria-label': 'What do you want to do?' }, visitsTab, orderTab);
function showTab(which) {
  const order = which === 'order';
  visitsTab.classList.toggle('active', !order); visitsTab.setAttribute('aria-selected', String(!order));
  orderTab.classList.toggle('active', order); orderTab.setAttribute('aria-selected', String(order));
  if (order) { listView.classList.add('hidden'); sheetView.classList.add('hidden'); orders.open(); } else { orders.close(); showList(); }
}

setChildren(app, tabs, listView, sheetView, orders.el);

// ---- R01 ------------------------------------------------------------------------------------
function showList() {
  sheetView.classList.add('hidden');
  listView.classList.remove('hidden');
  window.scrollTo(0, 0);
  loadList();
}

async function loadList() {
  const mine = latest.next();
  let data;
  try { data = await api.shelfVisits(repId, state.q); } catch (e) { setChildren(listBox, h('div', { class: 'errbox' }, e.message)); return; }
  if (!latest.is(mine)) return;
  const t = data.totals;
  totals.textContent = t.lots
    ? `${plural(t.shops, 'shop')} with ${plural(t.lots, 'lot')} close to expiry${t.overdue ? ` · ${t.overdue} overdue` : ''}`
    : 'No shops have lots close to expiry right now.';
  if (!data.customers.length) { setChildren(listBox, h('p', { class: 'rep-empty' }, 'No shop on your list matches that.')); return; }
  setChildren(listBox, data.customers.map(shopCard));
}

function shopCard(c) {
  const meta = [h('span', null, `Odoo ID ${c.odooId}`)];
  if (c.openAlerts) {
    meta.push(h('span', { class: 'pill warn' }, plural(c.openAlerts, 'lot')));
    if (c.overdueAlerts) meta.push(h('span', { class: 'pill err' }, `${c.overdueAlerts} overdue`));
    meta.push(h('span', null, `nearest ${dateText(c.nearestExpiry)} (${daysText(c.nearestDaysLeft)})`));
  } else meta.push(h('span', null, 'nothing close to expiry'));
  return h('button', { type: 'button', class: `rep-shop${c.openAlerts ? '' : ' quiet'}`, onClick: () => showSheet(c.id) },
    h('span', { class: 'rep-shop-name' }, c.name), h('span', { class: 'rep-shop-meta' }, meta));
}

// ---- R02 ------------------------------------------------------------------------------------
async function showSheet(customerId) {
  let data;
  try { data = await api.shelfSheet(repId, customerId); } catch (e) { toast(e.message, 'err'); return; }
  listView.classList.add('hidden');
  sheetView.classList.remove('hidden');
  window.scrollTo(0, 0);
  buildSheet(data);
}

function buildSheet(data) {
  const lines = data.lots.map(lotCard);
  const error = h('div', { class: 'errbox rep-error hidden', role: 'alert' });
  const save = h('button', { type: 'button', class: 'rep-save', onClick: submit }, 'Save visit');

  async function submit() {
    error.classList.add('hidden');
    const chosen = lines.filter((l) => l.outcome());
    if (!chosen.length) { error.textContent = 'Choose what happened for at least one lot.'; error.classList.remove('hidden'); return; }
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const res = await api.saveShelfVisit({ rep: repId, customer: data.customer.id, lines: chosen.map((l) => l.payload()) });
      done(data.customer.name, res);
    } catch (e) {
      error.textContent = e.message;
      error.classList.remove('hidden');
      save.disabled = false;
      save.textContent = 'Save visit';
    }
  }

  setChildren(sheetView,
    h('button', { type: 'button', class: 'rep-back', onClick: showList }, '← My visits'),
    h('h1', null, data.customer.name),
    h('p', { class: 'rep-note' }, `Odoo ID ${data.customer.odooId} · ${plural(data.lots.length, 'lot')} to check`),
    data.lots.length
      ? lines.map((l) => l.el)
      : h('p', { class: 'rep-empty' }, 'Nothing is waiting for a visit at this shop.'),
    data.lots.length ? [error, save] : null);
  window.scrollTo(0, 0);
}

/** One lot on the visit form. Built once; the extra fields are only shown or hidden. */
function lotCard(lot, index) {
  const name = `outcome-${index}`;
  const cartons = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: String(lot.deliveredCartons), step: '1', id: `ct-${index}`, value: String(lot.cartonsOnShelf) });
  const pct = h('input', { type: 'number', inputmode: 'decimal', min: '1', max: '99', step: '0.5', id: `pc-${index}`, placeholder: 'e.g. 20', value: lot.managerDiscountPct ? String(lot.managerDiscountPct) : '' });
  const contact = h('input', { type: 'text', autocomplete: 'off', id: `cn-${index}`, placeholder: 'Name of the person who agreed' });
  const agreed = h('input', { type: 'checkbox', id: `ag-${index}` });

  const cartonsRow = h('label', { for: `ct-${index}`, class: 'hidden' }, `Cartons still on the shelf (delivered ${lot.deliveredCartons})`, cartons);
  const discountBox = h('div', { class: 'rep-extra hidden' },
    h('label', { for: `pc-${index}` }, 'Discount proposed (%)', pct),
    h('label', { for: `cn-${index}` }, 'Customer contact', contact),
    h('label', { class: 'rep-confirm', for: `ag-${index}` }, agreed, 'The customer confirms this lot will not be returned for expiry'),
    h('p', { class: 'rep-note' }, lot.managerDiscountPct
      ? `The Sales Manager has set ${lot.managerDiscountPct}% for this lot. If the customer agrees to ${lot.managerDiscountPct}% or less it is approved straight away; more needs the Sales Manager.`
      : 'This is only a proposal. The Sales Manager approves it before it counts.'));
  const extra = h('div', { class: 'rep-extra hidden' }, cartonsRow);

  const choose = () => {
    const o = value();
    cartonsRow.classList.toggle('hidden', !(o === 'DISCOUNT_AGREED' || o === 'RETURN_EXPECTED'));
    extra.classList.toggle('hidden', cartonsRow.classList.contains('hidden'));
    discountBox.classList.toggle('hidden', o !== 'DISCOUNT_AGREED');
  };
  const radios = OUTCOMES.map(([v, label, help]) => {
    const input = h('input', { type: 'radio', name, value: v, onChange: choose });
    return { v, el: h('label', { class: 'rep-choice' }, input, h('span', null, h('b', null, label), h('br'), h('span', { class: 'rep-note' }, help))) };
  });
  const value = () => (radios.map((r) => r.el.querySelector('input')).find((i) => i.checked) || {}).value || '';

  const dayClass = lot.expired ? 'expired' : lot.daysLeft <= 14 ? 'soon' : '';
  const el = h('article', { class: `card rep-lot${lot.overdue ? ' overdue' : ''}` },
    h('div', { class: 'rep-lot-name' }, lot.productName),
    h('div', { class: 'rep-lot-facts' },
      h('span', { class: `rep-days ${dayClass}` }, `${dateText(lot.expiryDate)} · ${daysText(lot.daysLeft)}`),
      h('span', null, `Lot ${lot.lotName}`),
      h('span', null, `Delivered ${lot.deliveredCartons} cartons · order ${lot.salesOrder}`),
      lot.overdue ? h('span', { class: 'pill err' }, 'Overdue') : null),
    lot.managerDiscountPct ? h('div', { class: 'rep-offer' }, h('b', null, `${lot.managerDiscountPct}% discount offered by the Sales Manager`), ' — you can offer it to this customer.') : null,
    lot.rejectedReason ? h('div', { class: 'rep-rejected' }, h('b', null, 'The Sales Manager turned the discount down: '), lot.rejectedReason) : null,
    h('fieldset', { class: 'rep-outcomes' }, h('legend', null, 'What did you find?'), radios.map((r) => r.el)),
    extra, discountBox);

  return {
    el,
    outcome: value,
    payload() {
      const o = value();
      const out = { key: lot.key, outcome: o };
      if (o === 'DISCOUNT_AGREED' || o === 'RETURN_EXPECTED') out.cartonsOnShelf = Number(cartons.value);
      if (o === 'DISCOUNT_AGREED') Object.assign(out, { discountPct: pct.value === '' ? null : Number(pct.value), contactName: contact.value, agreed: agreed.checked });
      return out;
    },
  };
}

function done(shop, res) {
  const approvedNow = res.autoApproved || 0;
  const proposals = (res.byOutcome.DISCOUNT_AGREED || 0) - approvedNow;
  setChildren(sheetView,
    h('div', { class: 'card rep-done' },
      h('h1', null, 'Visit saved'),
      h('p', null, `${plural(res.saved, 'lot')} recorded at ${shop}.`),
      approvedNow ? h('p', { class: 'rep-note' }, `${plural(approvedNow, 'discount')} approved at once (within the Sales Manager's discount). Finance will issue the credit note.`) : null,
      proposals ? h('p', { class: 'rep-note' }, `${plural(proposals, 'discount')} now waiting for the Sales Manager.`) : null,
      h('button', { type: 'button', class: 'rep-save', onClick: showList }, 'Back to my visits')));
  window.scrollTo(0, 0);
}

// ---- start ----------------------------------------------------------------------------------
(async function start() {
  try {
    reps = (await api.shelfReps()).reps;
  } catch (e) { setChildren(app, h('div', { class: 'errbox' }, e.message)); return; }
  let saved = '';
  try { saved = localStorage.getItem(REP_KEY) || ''; } catch { /* storage blocked */ }
  if (!reps.length) { setChildren(app, h('div', { class: 'errbox' }, 'No sales rep is linked to your account yet. Please ask your Sales Manager.')); return; }
  repId = reps.some((r) => r.id === saved) ? saved : reps[0].id;
  // a rep (one name in the list) has nothing to pick: show their name and a way to sign out
  const mine = reps.length === 1;
  try {
    const me = await (await fetch('/api/auth/me')).json();
    if (me.staff && me.staff.role === 'SALES_REP') {
      const nav = document.getElementById('repNav');
      if (nav) {
        nav.textContent = '';
        const out = h('button', { type: 'button', class: 'rep-signout', onClick: async () => { await fetch('/api/auth/logout', { method: 'POST' }); location.assign('/'); } }, 'Sign out');
        nav.append(out);
      }
      tabs.classList.remove('hidden');
      // my month
      api.myMonth().then((m) => {
        const money = (n) => `GHS ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        const monthName = new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        const fig = (label, value) => h('div', { class: 'rep-fig' }, h('div', { class: 'rep-fig-k' }, label), h('div', { class: 'rep-fig-v' }, value));
        setChildren(monthCard,
          h('h2', null, `My month — ${monthName}`),
          h('div', { class: 'rep-figs' },
            fig('Net sales', money(m.netSales)),
            fig('Target', m.target === null ? 'not set' : `${money(m.target)} (${m.vsTarget}%)`),
            fig('Active customers', `${m.activeCustomers} of ${m.customers}`),
            fig('Collections', money(m.collections))),
          m.dormant.length ? h('div', null,
            h('p', { class: 'rep-note' }, 'Call these customers: no invoice for 30 days or more.'),
            h('ul', { class: 'rep-dormant' }, m.dormant.slice(0, 6).map((d) => h('li', null, `${d.customer} — ${d.days} days`)))) : null,
          h('p', { class: 'rep-note' }, m.monthToDate ? 'Month so far. Sample figures until Odoo is connected.' : 'Sample figures until Odoo is connected.'));
        monthCard.classList.remove('hidden');
      }).catch(() => { /* no figures yet: the page works without them */ });
      const sub = document.querySelector('.brand-sub');
      if (sub) sub.textContent = `Shop visits · ${reps[0].name}`;
    }
  } catch { /* the page works without this */ }
  // a rep is looking at their own shops: there is nothing to pick, so the whole card goes
  if (mine) document.getElementById('repAs').classList.add('hidden');
  setChildren(repSelect, reps.map((r) => h('option', { value: r.id, selected: r.id === repId }, r.name)));
  loadList();
}());
