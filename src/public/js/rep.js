// Sales-rep phone screens: R01 My visits and R02 Visit form.
//
// A sales rep is whoever signed in: the server takes the rep from the session, so a rep sees only
// themselves here and only their own shops. The Sales Manager and the administrator get a picker, to
// look at any rep. Built so that nothing the rep types into is ever
// rebuilt: the search box, the rep picker and each lot's fields are created once; only the lists
// around them are replaced.
window.__bflBooted = true; // tells boot-guard.js the page started
import { api, toast } from './api.js';
import { h, setChildren, svg } from './lib/dom.js';
import { debounce, createLatest } from './lib/util.js';
import { createOrderView } from './rep-order.js';
import { targetBadge } from './target-progress.js';
import {
  formatGhs, monthLabel, hasTarget, achievementPct, remainingTarget, overTargetBy, targetStatus,
} from './lib/targets.js';

const ICONS = {
  store: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  package: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>',
  map: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  chart: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 20V10M12 20V4M19 20v-7"/></svg>',
};

const app = document.getElementById('app');
const latest = createLatest();
const REP_KEY = 'bfl.sampleRep';
const VISITED_KEY = `bfl.visited.${new Date().toISOString().slice(0, 10)}`;

const OUTCOMES = [
  ['SOLD_OUT', 'Sold out', 'Nothing left on the shelf'],
  ['DISCOUNT_AGREED', 'Discount agreed', 'The customer will keep it at a discount'],
  ['RETURN_EXPECTED', 'Return expected', 'The customer refuses the discount'],
  ['NOT_CHECKED', 'Not checked', 'Shop closed or no time — due again in 7 days'],
];

const SAMPLE_CONTACTS = {
  4101: { phone: '+233 24 410 1001', area: 'Spintex Road, Accra' },
  4102: { phone: '+233 20 410 2002', area: 'Oxford St, Osu, Accra' },
  4103: { phone: '+233 27 410 3003', area: 'Kaneshie Market, Accra' },
  4104: { phone: '+233 55 410 4004', area: 'Cantonments, Accra' },
  4105: { phone: '+233 24 410 5005', area: 'Dzorwulu, Accra' },
  4106: { phone: '+233 50 410 6006', area: 'East Legon, Accra' },
  4107: { phone: '+233 24 410 7007', area: 'Tema Community 1' },
  4108: { phone: '+233 20 410 8008', area: 'Madina Zongo Junction' },
  4109: { phone: '+233 27 410 9009', area: 'Haatso Supermarket St' },
  4110: { phone: '+233 55 411 0010', area: 'Lapaz New Market' },
};

function getVisitedSet() {
  try {
    const raw = sessionStorage.getItem(VISITED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function markVisited(id) {
  try {
    const set = getVisitedSet();
    set.add(Number(id));
    sessionStorage.setItem(VISITED_KEY, JSON.stringify([...set]));
  } catch { /* blocked */ }
}

const dateText = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const daysText = (d) => (d < 0 ? `expired ${plural(-d, 'day')} ago` : d === 0 ? 'expires today' : `${plural(d, 'day')} left`);

let reps = [];
let repId = '';
let siteConfig = null;
const state = {
  q: '',
  filter: 'all', // 'all' | 'overdue' | 'soon' | 'clean'
  sort: 'expiry', // 'expiry' | 'overdue' | 'cartons' | 'name'
};

let rawCustomers = [];
let rawTotals = { shops: 0, lots: 0, overdue: 0 };

// ---- the pieces built once ----------------------------------------------------------------
const repSelect = h('select', {
  id: 'repPick', 'aria-label': 'Which sales rep are you?',
  onChange: () => {
    repId = repSelect.value;
    try { localStorage.setItem(REP_KEY, repId); } catch { /* storage blocked */ }
    loadRepMonthSummary();
    showList();
  },
});

const search = h('input', {
  type: 'search', class: 'rep-search', placeholder: 'Find a shop by name or Odoo ID…', 'aria-label': 'Find a shop',
  inputmode: 'search', autocomplete: 'off',
  onInput: debounce(() => {
    state.q = search.value.trim();
    clearBtn.classList.toggle('hidden', !state.q);
    loadList();
  }, 200),
});

const clearBtn = h('button', {
  type: 'button', class: 'rep-search-clear hidden', 'aria-label': 'Clear search',
  onClick: () => {
    search.value = '';
    state.q = '';
    clearBtn.classList.add('hidden');
    search.focus();
    loadList();
  },
}, '✕');

const searchBar = h('div', { class: 'rep-search-bar' },
  h('span', { class: 'rep-search-icon', 'aria-hidden': 'true' }, svg(ICONS.search)),
  search,
  clearBtn);

// KPI dashboard bar
const kpiGrid = h('div', { class: 'rep-kpi-grid', role: 'region', 'aria-label': 'Expiry command stats' });

// Route progress tracker
const progressBox = h('div', { class: 'rep-progress-box' });

// Filter chips & sort toolbar
const filterChipsBox = h('div', { class: 'rep-chips', role: 'tablist', 'aria-label': 'Filter shops' });
const sortSelect = h('select', {
  class: 'rep-sort-select', 'aria-label': 'Sort shops by',
  onChange: () => {
    state.sort = sortSelect.value;
    renderList();
  },
},
  h('option', { value: 'expiry' }, 'Nearest expiry'),
  h('option', { value: 'overdue' }, 'Most overdue'),
  h('option', { value: 'cartons' }, 'Cartons at risk'),
  h('option', { value: 'name' }, 'Shop name (A–Z)'));

const toolbar = h('div', { class: 'rep-toolbar' },
  filterChipsBox,
  h('div', { class: 'rep-sort-wrap' }, h('span', null, 'Sort:'), sortSelect));

const totals = h('p', { class: 'rep-totals', role: 'status' });
const listBox = h('div');

// "My month": a sales rep's own customers and figures, nothing company-wide (shown to reps only)
const monthHero = h('div', { class: 'bfl-hero-grid rep-hero hidden', 'aria-label': 'My target and sales this month' });
const monthCard = h('div', { class: 'card rep-month hidden' });
const recentOrdersCard = h('div', { class: 'card rep-month hidden' });
const repBroadcastBox = h('div', { class: 'rep-broadcast-banner hidden' });

/** "Good morning" / "Good afternoon" / "Good evening" for the local hour. */
const greeting = (now = new Date()) => {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
};
const repGreeting = h('h1', null, 'My visits');

/** Scroll to a section of the page (no jump for reduced-motion users, nothing when hidden). */
const scrollToEl = (el) => {
  if (el.classList.contains('hidden')) return;
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
};

// quick actions into the rep's day: a new order, the orders already placed, the route, the figures
const quickActions = h('div', { class: 'rep-quick hidden', role: 'group', 'aria-label': 'Quick actions' },
  h('button', { type: 'button', class: 'rep-quick-btn', onClick: () => showTab('order') },
    h('span', { class: 'rep-quick-ic' }, svg(ICONS.package)), h('b', null, 'New order'), h('span', { class: 'rep-quick-sub' }, 'for a customer')),
  h('button', { type: 'button', class: 'rep-quick-btn', onClick: () => { showTab('order'); orders.showMine(); } },
    h('span', { class: 'rep-quick-ic' }, svg(ICONS.check)), h('b', null, 'My orders'), h('span', { class: 'rep-quick-sub' }, 'already placed')),
  h('button', { type: 'button', class: 'rep-quick-btn', onClick: () => scrollToEl(searchBar) },
    h('span', { class: 'rep-quick-ic' }, svg(ICONS.map)), h('b', null, 'My visits'), h('span', { class: 'rep-quick-sub' }, 'today\'s route')),
  h('button', { type: 'button', class: 'rep-quick-btn', onClick: () => scrollToEl(monthCard) },
    h('span', { class: 'rep-quick-ic' }, svg(ICONS.chart)), h('b', null, 'My month'), h('span', { class: 'rep-quick-sub' }, 'target & sales')));

const listView = h('section', { 'aria-label': 'My visits' },
  repGreeting,
  h('p', { class: 'rep-header-sub' }, 'Here\'s your sales performance — live figures from Odoo'),
  repBroadcastBox,
  monthHero,
  monthCard,
  quickActions,
  recentOrdersCard,
  h('div', { class: 'card rep-as', id: 'repAs' },
    h('div', { class: 'rep-as-head' }, 'Visiting as'),
    h('div', { class: 'rep-as-select-wrap' }, repSelect),
    h('p', { class: 'rep-note' }, "You are looking at a rep's shops as a manager. A sales rep sees only their own.")),
  kpiGrid,
  progressBox,
  searchBar,
  toolbar,
  totals,
  listBox);

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
  if (order) { listView.classList.add('hidden'); sheetView.classList.add('hidden'); orders.open(); } else {
    orders.close(); showList();
    // back from the order screens: the month figures and recent orders may have moved on the server
    if (!tabs.classList.contains('hidden')) { loadMyMonth(); loadRecentOrders(); }
  }
}

setChildren(app, tabs, listView, sheetView, orders.el);

// ---- R01 List Management --------------------------------------------------------------------
function showList() {
  sheetView.classList.add('hidden');
  listView.classList.remove('hidden');
  window.scrollTo(0, 0);
  loadList();
}

async function loadList() {
  const mine = latest.next();
  let data;
  try {
    data = await api.shelfVisits(repId, state.q);
  } catch (e) {
    setChildren(listBox, h('div', { class: 'errbox' }, e.message));
    return;
  }
  if (!latest.is(mine)) return;
  rawCustomers = data.customers || [];
  rawTotals = data.totals || { shops: 0, lots: 0, overdue: 0 };
  renderList();
}

function renderKPIs(customers, t) {
  const totalShops = customers.length;
  const overdueLots = t.overdue || 0;
  const soonLots = customers.reduce((n, c) => n + Math.max(0, c.openAlerts - c.overdueAlerts), 0);
  const totalCartons = customers.reduce((n, c) => n + (c.cartonsAtRisk || 0), 0);

  const kpiCard = (icon, val, label, kind, targetFilter, pulse = false) => {
    const isActive = state.filter === targetFilter;
    return h('button', {
      type: 'button',
      class: `rep-kpi-card ${kind} ${isActive ? 'active' : ''}`,
      onClick: () => {
        state.filter = state.filter === targetFilter ? 'all' : targetFilter;
        renderList();
      },
    },
      h('div', { class: 'rep-kpi-top' },
        h('span', { class: 'rep-kpi-icon' }, icon),
        pulse && overdueLots > 0 ? h('span', { class: 'rep-pulse-dot', title: 'Action required' }) : null),
      h('span', { class: 'rep-kpi-val' }, String(val)),
      h('span', { class: 'rep-kpi-label' }, label));
  };

  setChildren(kpiGrid,
    kpiCard(svg(ICONS.store), totalShops, 'Route shops', '', 'all'),
    kpiCard(svg(ICONS.alert), overdueLots, 'Overdue lots', 'kpi-err', 'overdue', true),
    kpiCard(svg(ICONS.clock), soonLots, 'Expiring soon', 'kpi-warn', 'soon'),
    kpiCard(svg(ICONS.package), `${totalCartons}`, 'Cartons at risk', 'kpi-ok', 'all'));
}

function renderProgress(customers) {
  const visitedSet = getVisitedSet();
  const visitedCount = customers.filter((c) => visitedSet.has(c.id)).length;
  const total = customers.length;
  const pct = total > 0 ? Math.round((visitedCount / total) * 100) : 0;

  setChildren(progressBox,
    h('div', { class: 'rep-progress-info' },
      h('div', { class: 'rep-progress-title' }, `Today's Route Progress`),
      h('div', { class: 'rep-progress-bar-bg' },
        h('div', { class: 'rep-progress-bar-fill', style: { width: `${pct}%` } }))),
    h('div', { class: 'rep-progress-stat' }, `${visitedCount} of ${total} (${pct}%)`));
}

function renderFilters(customers) {
  const total = customers.length;
  const overdueCount = customers.filter((c) => c.overdueAlerts > 0).length;
  const soonCount = customers.filter((c) => c.openAlerts > 0 && !c.overdueAlerts).length;
  const cleanCount = customers.filter((c) => c.openAlerts === 0).length;

  const chip = (label, filterVal, count) => {
    const active = state.filter === filterVal;
    return h('button', {
      type: 'button',
      class: `rep-chip ${active ? 'active' : ''}`,
      role: 'tab',
      'aria-selected': String(active),
      onClick: () => {
        state.filter = filterVal;
        renderList();
      },
    }, `${label} (${count})`);
  };

  setChildren(filterChipsBox,
    chip('All', 'all', total),
    chip('Overdue', 'overdue', overdueCount),
    chip('Expiring soon', 'soon', soonCount),
    chip('All clear', 'clean', cleanCount));
}

function renderList() {
  renderKPIs(rawCustomers, rawTotals);
  renderProgress(rawCustomers);
  renderFilters(rawCustomers);

  // Apply quick filter
  let filtered = [...rawCustomers];
  if (state.filter === 'overdue') {
    filtered = filtered.filter((c) => c.overdueAlerts > 0);
  } else if (state.filter === 'soon') {
    filtered = filtered.filter((c) => c.openAlerts > 0 && !c.overdueAlerts);
  } else if (state.filter === 'clean') {
    filtered = filtered.filter((c) => c.openAlerts === 0);
  }

  // Apply quick sort
  if (state.sort === 'overdue') {
    filtered.sort((a, b) => b.overdueAlerts - a.overdueAlerts || (a.nearestDaysLeft ?? 999) - (b.nearestDaysLeft ?? 999));
  } else if (state.sort === 'cartons') {
    filtered.sort((a, b) => (b.cartonsAtRisk || 0) - (a.cartonsAtRisk || 0));
  } else if (state.sort === 'name') {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    // default: nearest expiry first
    filtered.sort((a, b) => {
      if ((a.openAlerts > 0) !== (b.openAlerts > 0)) return a.openAlerts > 0 ? -1 : 1;
      if (a.openAlerts > 0) return (a.nearestDaysLeft ?? 999) - (b.nearestDaysLeft ?? 999);
      return a.name.localeCompare(b.name);
    });
  }

  const t = rawTotals;
  totals.textContent = t.lots
    ? `${plural(t.shops, 'shop')} with ${plural(t.lots, 'lot')} close to expiry${t.overdue ? ` · ${t.overdue} overdue` : ''}`
    : 'No shops have lots close to expiry right now.';

  if (!filtered.length) {
    setChildren(listBox, h('div', { class: 'rep-empty' },
      state.q
        ? `No shops matching "${state.q}" in this view.`
        : 'No shops match the selected filter.'));
    return;
  }

  setChildren(listBox, filtered.map(shopCard));
}

function shopCard(c) {
  const phone = c.phone || (SAMPLE_CONTACTS[c.odooId]?.phone) || '+233 24 410 1001';
  const area = c.deliveryAddress || (SAMPLE_CONTACTS[c.odooId]?.area) || 'Greater Accra';
  const visitedSet = getVisitedSet();
  const isVisited = visitedSet.has(c.id);

  let statusClass = 'is-clean';
  let badgeEl = h('span', { class: 'rep-pill ok' }, 'All Good');

  if (c.overdueAlerts > 0) {
    statusClass = 'has-overdue';
    badgeEl = h('span', { class: 'rep-pill err' }, plural(c.overdueAlerts, 'overdue lot'));
  } else if (c.openAlerts > 0) {
    statusClass = 'has-soon';
    badgeEl = h('span', { class: 'rep-pill warn' }, c.nearestDaysLeft !== null ? daysText(c.nearestDaysLeft) : plural(c.openAlerts, 'lot'));
  }

  const expirySpanClass = c.nearestDaysLeft !== null && c.nearestDaysLeft < 0 ? 'expired' : c.nearestDaysLeft !== null && c.nearestDaysLeft <= 14 ? 'soon' : '';

  // Quick Action Buttons
  const mapBtn = h('a', {
    class: 'rep-action-btn',
    href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.name} ${area} Ghana`)}`,
    target: '_blank', rel: 'noopener noreferrer',
    title: 'Open in Google Maps',
    onClick: (e) => e.stopPropagation(),
  }, svg(ICONS.map), ' Map');

  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const waBtn = h('a', {
    class: 'rep-action-btn',
    href: `https://wa.me/${cleanPhone}?text=${encodeURIComponent(`Hello ${c.name}, Box for Less sales rep visiting your store today regarding shelf inventory.`)}`,
    target: '_blank', rel: 'noopener noreferrer',
    title: 'Chat on WhatsApp',
    onClick: (e) => e.stopPropagation(),
  }, svg(ICONS.chat), ' WhatsApp');

  const callBtn = h('a', {
    class: 'rep-action-btn',
    href: `tel:${cleanPhone}`,
    title: 'Call Store',
    onClick: (e) => e.stopPropagation(),
  }, svg(ICONS.phone), ' Call');

  const visitBtn = h('button', {
    type: 'button',
    class: 'rep-action-btn primary',
    onClick: (e) => {
      e.stopPropagation();
      showSheet(c.id);
    },
  }, 'Start Visit →');

  const features = siteConfig?.salesRep?.features || {};
  const showMaps = features.enableMaps !== false;
  const showWa = features.enableWhatsApp !== false;
  const showCall = features.enableCall !== false;

  const actions = [];
  if (showMaps) actions.push(mapBtn);
  if (showWa) actions.push(waBtn);
  if (showCall) actions.push(callBtn);
  actions.push(visitBtn);

  return h('article', {
    class: `rep-shop ${statusClass} ${isVisited ? 'is-visited' : ''}`,
    onClick: () => showSheet(c.id),
  },
    h('div', { class: 'rep-shop-header' },
      h('div', { class: 'rep-shop-title-area' },
        h('span', { class: 'rep-shop-name' }, c.name),
        h('span', { class: 'rep-shop-area' }, area)),
      h('div', { class: 'rep-shop-status-badge' },
        badgeEl,
        isVisited ? h('span', { class: 'rep-pill ok', style: { marginLeft: '4px' } }, 'Visited') : null)),
    h('div', { class: 'rep-shop-facts' },
      h('span', { class: 'rep-shop-fact' }, `Ref #${c.odooId}`),
      c.openAlerts
        ? [
            h('span', { class: 'rep-shop-fact' }, plural(c.openAlerts, 'lot')),
            c.cartonsAtRisk ? h('span', { class: 'rep-shop-fact' }, `${c.cartonsAtRisk} ctn`) : null,
            c.nearestExpiry ? h('span', { class: `rep-shop-fact rep-shop-expiry-text ${expirySpanClass}` }, `Nearest: ${dateText(c.nearestExpiry)} (${daysText(c.nearestDaysLeft)})`) : null,
          ]
        : h('span', { class: 'rep-shop-fact' }, 'No lots close to expiry')),
    h('div', { class: 'rep-shop-actions' }, ...actions));
}

// ---- R02 Visit Form -------------------------------------------------------------------------
async function showSheet(customerId) {
  let data;
  try {
    data = await api.shelfSheet(repId, customerId);
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
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
    if (!chosen.length) {
      error.textContent = 'Choose what happened for at least one lot.';
      error.classList.remove('hidden');
      return;
    }
    save.disabled = true;
    save.textContent = 'Saving visit…';
    try {
      const res = await api.saveShelfVisit({
        rep: repId,
        customer: data.customer.id,
        lines: chosen.map((l) => l.payload()),
      });
      markVisited(data.customer.id);
      done(data.customer.name, res);
    } catch (e) {
      error.textContent = e.message;
      error.classList.remove('hidden');
      save.disabled = false;
      save.textContent = 'Save visit';
    }
  }

  const area = data.customer.deliveryAddress || (SAMPLE_CONTACTS[data.customer.odooId]?.area) || 'Greater Accra';

  setChildren(sheetView,
    h('button', { type: 'button', class: 'rep-back', onClick: showList }, '← Back to My visits'),
    h('div', { class: 'rep-sheet-header' },
      h('h1', null, data.customer.name),
      h('div', { class: 'rep-sheet-meta' },
        h('span', null, area),
        h('span', null, `Ref #${data.customer.odooId}`),
        h('span', null, `${plural(data.lots.length, 'lot')} to inspect`))),
    data.lots.length
      ? lines.map((l) => l.el)
      : h('p', { class: 'rep-empty' }, 'Nothing is waiting for a visit at this shop.'),
    data.lots.length ? [error, save] : null);
  window.scrollTo(0, 0);
}

/** One lot on the visit form. Built once; the extra fields are only shown or hidden. */
function lotCard(lot, index) {
  const name = `outcome-${index}`;
  const cartons = h('input', {
    type: 'number', inputmode: 'numeric', min: '1', max: String(lot.deliveredCartons), step: '1',
    id: `ct-${index}`, value: String(lot.cartonsOnShelf),
  });
  const pct = h('input', {
    type: 'number', inputmode: 'decimal', min: '1', max: '99', step: '0.5',
    id: `pc-${index}`, placeholder: 'e.g. 20', value: lot.managerDiscountPct ? String(lot.managerDiscountPct) : '',
  });
  const contact = h('input', {
    type: 'text', autocomplete: 'off', id: `cn-${index}`, placeholder: 'Name of the person who agreed',
  });
  const agreed = h('input', { type: 'checkbox', id: `ag-${index}` });
  const returnReason = h('textarea', {
    id: `rr-${index}`, rows: '2', maxlength: '300',
    placeholder: 'Why is the customer returning it? (e.g. too close to expiry, damaged cartons)',
  });

  // Quick preset discount buttons
  const presetChip = (val) => h('button', {
    type: 'button', class: 'rep-preset-btn',
    onClick: () => {
      pct.value = String(val);
      pct.focus();
    },
  }, `${val}%`);

  const presets = siteConfig?.salesRep?.discountPresets || [10, 15, 20, 25];
  const presetRow = h('div', { class: 'rep-preset-row' },
    h('span', { class: 'rep-note' }, 'Presets:'),
    ...presets.map((val) => presetChip(val)));

  const cartonsRow = h('label', { for: `ct-${index}`, class: 'hidden' },
    `Cartons still on the shelf (delivered ${lot.deliveredCartons})`,
    cartons);

  const discountBox = h('div', { class: 'rep-extra hidden' },
    h('label', { for: `pc-${index}` }, 'Discount proposed (%)', pct),
    presetRow,
    h('label', { for: `cn-${index}` }, 'Customer contact person', contact),
    h('label', { class: 'rep-confirm', for: `ag-${index}` },
      agreed,
      h('span', null, 'The customer confirms this lot will not be returned for expiry')),
    h('p', { class: 'rep-note' }, lot.managerDiscountPct
      ? `★ The Sales Manager has set ${lot.managerDiscountPct}% for this lot. If the customer agrees to ${lot.managerDiscountPct}% or less it is approved straight away; more needs the Sales Manager.`
      : 'This is only a proposal. The Sales Manager approves it before it counts.'));

  const returnReasonSelect = h('select', {
    id: `rr-sel-${index}`,
    onChange: () => {
      if (returnReasonSelect.value && returnReasonSelect.value !== 'OTHER') {
        returnReason.value = returnReasonSelect.options[returnReasonSelect.selectedIndex].text;
      } else if (returnReasonSelect.value === 'OTHER') {
        returnReason.value = '';
        returnReason.focus();
      }
    },
  },
    h('option', { value: '' }, 'Quick select reason (or type below)…'),
    h('option', { value: 'EXPIRED' }, 'Approaching expiry / Expired'),
    h('option', { value: 'DAMAGED' }, 'Damaged packaging / cartons'),
    h('option', { value: 'OTHER' }, 'Other reason (specify below)'));

  const returnBox = h('div', { class: 'rep-extra hidden' },
    h('label', { for: `rr-sel-${index}` }, 'Return category', returnReasonSelect),
    h('label', { for: `rr-${index}` }, 'Reason for the return (required)', returnReason),
    h('p', { class: 'rep-note' }, 'The warehouse and your Sales Manager see this reason with the expected return.'));

  const extra = h('div', { class: 'rep-extra hidden' }, cartonsRow);

  const choose = () => {
    const o = value();
    cartonsRow.classList.toggle('hidden', !(o === 'DISCOUNT_AGREED' || o === 'RETURN_EXPECTED'));
    extra.classList.toggle('hidden', cartonsRow.classList.contains('hidden'));
    discountBox.classList.toggle('hidden', o !== 'DISCOUNT_AGREED');
    returnBox.classList.toggle('hidden', o !== 'RETURN_EXPECTED');
  };

  const radios = OUTCOMES.map(([v, label, help]) => {
    const input = h('input', { type: 'radio', name, value: v, onChange: choose });
    return {
      v,
      el: h('label', { class: 'rep-choice' },
        input,
        h('span', null,
          h('b', null, label),
          h('br'),
          h('span', { class: 'rep-note' }, help))),
    };
  });

  const value = () => (radios.map((r) => r.el.querySelector('input')).find((i) => i.checked) || {}).value || '';

  const dayClass = lot.expired ? 'expired' : lot.daysLeft <= 14 ? 'soon' : '';
  const el = h('article', { class: `card rep-lot ${lot.overdue ? ' overdue' : ''}` },
    h('div', { class: 'rep-lot-header' },
      h('div', { class: 'rep-lot-name' }, lot.productName, lot.barcode ? h('div', { class: 'rep-lot-barcode' }, `Barcode ${lot.barcode}`) : null),
      lot.overdue ? h('span', { class: 'rep-pill err' }, 'Overdue') : null),
    h('div', { class: 'rep-lot-facts' },
      h('span', { class: `rep-days ${dayClass}` }, `${dateText(lot.expiryDate)} · ${daysText(lot.daysLeft)}`),
      h('span', null, `Lot ${lot.lotName}`),
      h('span', null, `Delivered ${lot.deliveredCartons} ctn · Order ${lot.salesOrder}`)),
    lot.managerDiscountPct
      ? h('div', { class: 'rep-offer' }, h('b', null, `${lot.managerDiscountPct}% discount offered by the Sales Manager`), ' — you can offer it directly.')
      : null,
    lot.rejectedReason
      ? h('div', { class: 'rep-rejected' }, h('b', null, 'The Sales Manager turned the discount down: '), lot.rejectedReason)
      : null,
    h('fieldset', { class: 'rep-outcomes' },
      h('legend', null, 'What did you find on the shelf?'),
      radios.map((r) => r.el)),
    extra,
    returnBox,
    discountBox);

  return {
    el,
    outcome: value,
    payload() {
      const o = value();
      const out = { key: lot.key, outcome: o };
      if (o === 'DISCOUNT_AGREED' || o === 'RETURN_EXPECTED') out.cartonsOnShelf = Number(cartons.value);
      if (o === 'RETURN_EXPECTED') {
        out.returnReason = returnReason.value.trim() || returnReasonSelect.value;
      }
      if (o === 'DISCOUNT_AGREED') {
        Object.assign(out, {
          discountPct: pct.value === '' ? null : Number(pct.value),
          contactName: contact.value,
          agreed: agreed.checked,
        });
      }
      return out;
    },
  };
}

function done(shop, res) {
  const approvedNow = res.autoApproved || 0;
  const proposals = (res.byOutcome.DISCOUNT_AGREED || 0) - approvedNow;
  setChildren(sheetView,
    h('div', { class: 'card rep-done' },
      h('h1', null, 'Visit recorded successfully'),
      h('p', null, `${plural(res.saved, 'lot')} recorded at ${shop}.`),
      approvedNow ? h('p', { class: 'rep-note' }, `${plural(approvedNow, 'discount')} approved at once (within the Sales Manager's pre-approved discount). Finance will issue the credit note.`) : null,
      proposals ? h('p', { class: 'rep-note' }, `${plural(proposals, 'discount')} submitted and waiting for Sales Manager sign-off.`) : null,
      h('button', { type: 'button', class: 'rep-save', onClick: showList }, 'Back to My visits')));
  window.scrollTo(0, 0);
}

let currentStaffRole = null;

// ---- My month: target, eligible sales, recent orders -----------------------------------------
// The figures are the server's: net sales are Odoo invoices less credit notes, the target is the
// Sales Manager's. A new order counts only once it is invoiced in Odoo — never at placement.
const fig = (label, value) => h('div', { class: 'rep-fig' }, h('div', { class: 'rep-fig-k' }, label), h('div', { class: 'rep-fig-v' }, value));

const heroCard = (label, value, sub) => h('div', { class: 'bfl-hero' },
  h('span', { class: 'bfl-hero-label' }, label),
  h('b', { class: 'bfl-hero-value' }, value),
  h('span', { class: 'bfl-hero-sub' }, sub));

function renderMonthSummary(m, repLabel = '') {
  const target = hasTarget(m.target) ? Number(m.target) : null;
  const sales = Number(m.netSales) || 0;
  const pct = achievementPct(target, sales);
  const remaining = remainingTarget(target, sales);
  const over = overTargetBy(target, sales);
  const status = targetStatus(target, sales);
  const reached = status === 'REACHED' || status === 'EXCEEDED';

  // the three hero cards: My Target / My Sales / Remaining
  setChildren(monthHero,
    heroCard('Monthly Target', target ? formatGhs(target) : 'Not set',
      target ? 'Set by Sales Manager' : 'Ask Sales Manager to set one'),
    heroCard('Sales Achieved', formatGhs(sales),
      target ? `${pct.toFixed(0)}% of target achieved` : 'Invoiced sales this month'),
    heroCard('Remaining Balance', target ? formatGhs(remaining) : '—',
      over > 0 ? `Above target by ${formatGhs(over)}` : target ? 'Still to go this month' : 'No target set'));
  monthHero.classList.remove('hidden');

  // the detail panel: the achievement bar, then customers, collections and the call list
  setChildren(monthCard,
    h('div', { class: 'rep-month-head' },
      h('h2', null, `${repLabel ? `${repLabel} — ` : 'My month — '}${monthLabel(m.month)}${m.monthToDate ? ' (so far)' : ''}`),
      targetBadge(m.target, m.netSales)),
    target ? h('div', null,
      h('div', {
        class: `bfl-progress${reached ? ' reached' : status === 'BEHIND' ? ' behind' : ''}`,
        role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-valuenow': String(Math.min(100, Math.round(pct))),
        'aria-label': `Target achievement ${pct.toFixed(1)} percent`,
      }, h('i', { style: { width: `${Math.min(100, pct)}%` } })),
      h('p', { class: 'rep-note' }, 'Orders count towards the target once they are invoiced in Odoo.'))
      : h('p', { class: 'rep-note' }, 'No monthly target is set yet — the Sales Manager sets it.'),
    h('div', { class: 'rep-figs' },
      fig('Active customers', `${m.activeCustomers} of ${m.customers}`),
      fig('Collections', formatGhs(m.collections))),
    m.dormant && m.dormant.length ? h('div', null,
      h('p', { class: 'rep-note' }, 'Call these customers: no invoice for 30 days or more.'),
      h('ul', { class: 'rep-dormant' }, m.dormant.slice(0, 6).map((d) => h('li', null, `${d.customer} — ${d.days} days`)))) : null,
    h('p', { class: 'rep-note' }, '● Live Database: Verified sales & collections figures.'));
  monthCard.classList.remove('hidden');
}

function loadMyMonth() {
  return api.myMonth().then((m) => renderMonthSummary(m)).catch(() => { /* works without figures */ });
}

function loadRepMonthSummary() {
  if (currentStaffRole === 'SALES_REP') {
    loadMyMonth();
  } else if (currentStaffRole === 'ADMIN' || currentStaffRole === 'SALES_MANAGER') {
    const picked = reps.find((r) => r.id === repId);
    api.repSummary(repId).then((m) => renderMonthSummary(m, picked ? picked.name : 'Sales Rep')).catch(() => {});
  }
}

// order states from Odoo, mapped to a pill tone (green done, amber waiting, red cancelled)
const ORDER_TONE = {
  Received: 'neutral',
  'Waiting for approval': 'warning',
  Approved: '',
  Dispatched: '',
  Invoiced: 'success',
  Paid: 'success',
  Cancelled: 'error',
};

/** "Today" / "Yesterday" / "3 Feb" for an order's placed-at timestamp. */
const placedText = (iso) => {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '—';
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

function loadRecentOrders() {
  return fetch('/api/rep-orders/mine', { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(({ orders }) => {
      setChildren(recentOrdersCard,
        h('h2', null, 'Recent orders you placed'),
        orders.length ? h('div', { class: 'bfl-table-wrap' }, h('table', { class: 'bfl-table rep-orders-table' },
          h('thead', null, h('tr', null,
            h('th', null, 'Customer'), h('th', { class: 'num' }, 'Cartons'), h('th', null, 'Status'), h('th', null, 'Placed'))),
          h('tbody', null, orders.slice(0, 5).map((o) => h('tr', null,
            h('td', { class: 'primary-text' }, o.customer),
            h('td', { class: 'num' }, String(o.cartons)),
            h('td', null, h('span', { class: `bfl-pill ${ORDER_TONE[o.status] || ''}`.trim() }, o.status)),
            h('td', null, placedText(o.placedAt)))))))
          : h('p', { class: 'rep-note' }, 'No orders placed yet — tap New order to place one.'),
        h('p', { class: 'rep-note' }, 'An order counts towards your target once it is invoiced in Odoo.'));
      recentOrdersCard.classList.remove('hidden');
    })
    .catch(() => { /* the order list is a bonus; the page works without it */ });
}

// ---- Startup --------------------------------------------------------------------------------
(async function start() {
  try {
    reps = (await api.shelfReps()).reps;
  } catch (e) {
    setChildren(app, h('div', { class: 'errbox' }, e.message));
    return;
  }
  let saved = '';
  try { saved = localStorage.getItem(REP_KEY) || ''; } catch { /* storage blocked */ }
  if (!reps.length) {
    setChildren(app, h('div', { class: 'errbox' }, 'No sales rep is linked to your account yet. Please ask your Sales Manager.'));
    return;
  }
  repId = reps.some((r) => r.id === saved) ? saved : reps[0].id;

  // A rep (one name in the list) has nothing to pick: show their name and a way to sign out
  const mine = reps.length === 1;
  try {
    const me = await (await fetch('/api/auth/me')).json();
    if (me.staff) {
      currentStaffRole = me.staff.role;
      const roleTitles = {
        ADMIN: 'Administrator',
        SALES_MANAGER: 'Sales Manager',
        WAREHOUSE: 'Warehouse Administrator',
        SALES_REP: 'Sales Representative',
      };
      const roleTitle = roleTitles[me.staff.role] || me.staff.role;
      const nav = document.getElementById('repNav');
      if (nav) {
        nav.textContent = '';
        const badge = h('span', {
          class: 'rep-pill ok',
          style: 'margin-right:8px;font-size:12px;',
        }, `${roleTitle} · ${me.staff.name}`);
        const out = h('button', {
          type: 'button', class: 'rep-signout',
          onClick: async () => { await fetch('/api/staff/logout', { method: 'POST' }); location.assign('/'); },
        }, 'Sign out');
        nav.append(badge, out);
      }
      if (me.staff.role === 'SALES_REP') {
        tabs.classList.remove('hidden');
        quickActions.classList.remove('hidden');
        repGreeting.textContent = `${greeting()}, ${reps[0].name.split(' ')[0]}`;
        loadMyMonth();
        loadRecentOrders();
        const sub = document.querySelector('.brand-sub');
        if (sub) sub.textContent = `Sales Representative · ${reps[0].name}`;
      } else {
        loadRepMonthSummary();
      }
    }
  } catch { /* works without this */ }

  // Load dynamic site settings configured in Admin Studio
  try {
    siteConfig = await fetch('/api/site-settings').then((r) => r.json());
    if (siteConfig?.salesRep) {
      if (siteConfig.salesRep.portalTitle) {
        const titleEl = document.querySelector('.brand-title');
        if (titleEl) titleEl.textContent = siteConfig.salesRep.portalTitle;
        if (repGreeting.textContent === 'My visits') repGreeting.textContent = siteConfig.salesRep.portalTitle;
      }
      if (siteConfig.salesRep.portalSubtitle) {
        const subEl = document.querySelector('.brand-sub');
        if (subEl) subEl.textContent = siteConfig.salesRep.portalSubtitle;
        const subH = listView.querySelector('.rep-header-sub');
        if (subH) subH.textContent = siteConfig.salesRep.portalSubtitle;
      }
      if (siteConfig.salesRep.broadcastNotice) {
        repBroadcastBox.textContent = siteConfig.salesRep.broadcastNotice;
        repBroadcastBox.classList.remove('hidden');
      }
    }
  } catch { /* works with defaults */ }

  if (mine) document.getElementById('repAs').classList.add('hidden');
  setChildren(repSelect, reps.map((r) => h('option', { value: r.id, selected: r.id === repId }, r.name)));
  loadList();
}());
