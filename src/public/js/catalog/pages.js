// The customer pages around the product list, after the Oct 2026 customer mockup:
//   home      — welcome banner, featured products, and the account column
//   orders, balance, invoices, settings, help, brands
//
// Products, stock, prices, credit, orders and invoices all come from the server (/api/catalog) for the signed-in
// customer's own session, through ./customer-data.js. Until Odoo is connected they come from a stand-in for Odoo,
// so the pages say "Sample".
import { h, setChildren, svg, toggleHidden } from '../lib/dom.js';
import { createScope } from '../lib/util.js';
import { getJSON } from './http.js';
import { createProductCard } from './cards.js';
import { navigate, pageUrl } from './router.js';
import { patchList } from './list.js';
import { onPrices, offerList, refreshOffers } from './prices.js';
import { createOffersSection, createUpcomingSection } from './offers.js';
import {
  SAMPLE_NOTE, currentCustomer, accountSummary, orderList, invoiceList,
  ORDER_STATUS, formatGhs, formatDate,
} from './customer-data.js';
import { addLinesToCart } from '../cart.js';
import { postJSON } from './http.js';

/** A figure, or a dash where Odoo has not given us one (a credit limit, say). */
const money = (n) => (n === null || n === undefined ? '—' : formatGhs(n));

const PATHS = {
  arrow: 'M5 12h14M13 6l6 6-6 6',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3.5 7.7 12 12l8.5-4.3M12 12v9',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11v3M16 13.5h.01',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  lock: 'M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  download: 'M12 3v12M7 10l5 5 5-5M4 19h16',
};
const icon = (name) => svg(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`);
const link = (href, text, cls = 'p-link') => h('a', { class: cls, href }, text, ' ', icon('arrow'));
const sampleTag = () => null;
const statusPill = (key) => {
  const s = ORDER_STATUS[key] || { label: key, tone: 'grey' };
  return h('span', { class: `p-status ${s.tone}` }, s.label);
};
const card = (cls, ...children) => h('section', { class: `p-panel ${cls || ''}` }, ...children);
const panelHead = (title, ...right) => h('div', { class: 'p-panel-head' }, h('h2', {}, title), ...right);

// ------------------------------------------------------------------ the welcome banner
const SLIDES = [
  { src: '/img/shop-slide-warehouse.webp', alt: 'Box for Less cartons in a wholesale warehouse' },
  { src: '/img/shop-slide-sugar.webp', alt: 'A pack of sugar' },
  { src: '/img/shop-slide-biscuits.webp', alt: 'A box of chocolate biscuits' },
];

function banner(account, scope) {
  let current = 0;
  const pics = SLIDES.map((s, i) => h('img', {
    class: `p-hero-pic${i === 0 ? ' on' : ''}`, src: s.src, alt: i === 0 ? s.alt : '', 'aria-hidden': i === 0 ? null : 'true',
    loading: i === 0 ? 'eager' : 'lazy', decoding: 'async',
  }));
  const dots = SLIDES.map((s, i) => h('button', {
    type: 'button', class: 'p-dot', 'aria-label': `Show picture ${i + 1}`, 'aria-pressed': String(i === 0),
    onClick: () => { show(i); restart(); },
  }));
  function show(i) {
    current = (i + SLIDES.length) % SLIDES.length;
    pics.forEach((p, k) => { p.classList.toggle('on', k === current); p.alt = k === current ? SLIDES[k].alt : ''; });
    dots.forEach((d, k) => d.setAttribute('aria-pressed', String(k === current)));
  }
  let timer = null;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const restart = () => { window.clearInterval(timer); if (!still) timer = window.setInterval(() => show(current + 1), 6500); };
  restart();
  scope.add(() => window.clearInterval(timer));

  const siteConfig = window.__bflSiteSettings;
  const storeName = siteConfig?.storefront?.storeName || 'Box for Less';
  const hero = siteConfig?.storefront?.hero || {};
  const headline = hero.headline || 'Your Trusted Wholesale Partner';
  const subtitle = hero.subtitle || 'Quality products, great prices, reliable delivery.';
  const ctaText = hero.ctaText || 'View Products';
  const ctaLink = hero.ctaLink || pageUrl('products');

  return h('div', { class: 'p-hero-wrap' },
    h('section', { class: 'p-hero', 'aria-labelledby': 'heroTitle' },
      h('div', { class: 'p-hero-pics' }, pics),
      h('div', { class: 'p-hero-copy' },
        h('p', { class: 'p-hero-hello' }, account ? `Welcome back, ${account.company}` : `Welcome to ${storeName}`),
        h('h1', { id: 'heroTitle' }, headline),
        h('p', {}, subtitle),
        h('a', { class: 'p-btn', href: ctaLink }, ctaText, ' ', icon('arrow')))),
    h('div', { class: 'p-dots' }, dots));
}

// ------------------------------------------------------------------ the account column
function accountOverview(account) {
  if (!account) {
    return card('p-account',
      panelHead('Your Account'),
      h('div', { class: 'p-signin-box' },
        icon('lock'),
        h('p', {}, 'Sign in to see your prices, credit and orders.'),
        h('a', { class: 'p-btn', href: '/?next=%2Fcatalog' }, 'Sign in'),
        h('a', { class: 'p-btn p-btn-ghost', href: '/signup' }, 'Create an account')));
  }
  const a = accountSummary();
  if (a.type === 'cash') {
    return card('p-account',
      panelHead('Account Overview', sampleTag()),
      h('div', { class: 'p-cash-box' },
        h('b', {}, 'Cash customer'),
        h('p', {}, 'You pay in cash on delivery. There is no credit or balance on a cash account.')),
      link(pageUrl('help'), 'Apply for a credit account'));
  }
  const pct = a.creditLimit ? Math.max(0, Math.min(100, (a.available / a.creditLimit) * 100)) : 0;
  return card('p-account',
    panelHead('Account Overview', sampleTag()),
    h('div', { class: 'p-credit' },
      account.customerId || account.customerClass ? h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;' },
        account.customerId ? h('span', { class: 'p-status blue' }, `Customer ID #${account.customerId}`) : null,
        account.customerClass ? h('span', { class: 'p-status green' }, account.customerClass) : null) : null,
      h('span', {}, 'Available Credit'),
      h('b', {}, money(a.available)),
      h('div', { class: 'p-bar', role: 'img', 'aria-label': `${Math.round(pct)}% of the credit limit available` }, h('i', { style: { width: `${pct}%` } })),
      h('dl', {},
        h('dt', {}, 'Credit Limit'), h('dd', {}, money(a.creditLimit)),
        h('dt', {}, 'Amount Owed'), h('dd', {}, money(a.amountOwed)),
        h('dt', {}, 'Open Orders'), h('dd', {}, money(a.openOrders)))),
    link(pageUrl('balance'), 'View Full Balance'));
}

async function reorderOrderItems(items) {
  let toAdd = items || [];
  if (toAdd.some((i) => !i.barcode)) {
    try {
      const res = await getJSON('/api/catalog/products?view=available&limit=250');
      const byName = new Map((res.items || []).map((p) => [p.name, p]));
      toAdd = toAdd.map((i) => {
        const match = byName.get(i.name);
        return match ? { ...match, cartons: i.cartons } : i;
      });
    } catch { /* proceed */ }
  }
  addLinesToCart(toAdd);
  window.dispatchEvent(new CustomEvent('bfl:open-request'));
}

function recentOrders(account) {
  if (!account) return null;
  const orders = orderList().slice(0, 4);
  return card('p-orders',
    panelHead('Recent Orders', link(pageUrl('orders'), 'View All', 'p-link p-link-sm')),
    h('ul', { class: 'p-order-list' }, orders.map((o) => h('li', {},
      h('div', { class: 'p-order-top' }, h('b', {}, o.ref), statusPill(o.status)),
      h('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin: 4px 0;' },
        h('span', { class: 'p-muted' }, formatDate(o.at)),
        h('button', {
          type: 'button',
          class: 'p-link p-link-sm',
          style: 'background:none; border:none; color:var(--bfl-primary, #0052cc); cursor:pointer; font-weight:600; padding:2px 4px;',
          title: 'Add items from this order to your request cart',
          onClick: () => { reorderOrderItems(o.items); },
        }, 'Reorder')),
      h('b', { class: 'p-order-amount' }, o.amount === null ? '—' : formatGhs(o.amount))))));
}

function quickActions(account) {
  const action = (href, name, title, sub) => h('a', { class: 'p-quick', href },
    h('span', { class: 'p-quick-icon' }, icon(name)), h('span', {}, h('b', {}, title), h('small', {}, sub)));
  return card('p-quick-panel',
    panelHead('Quick Actions'),
    action(pageUrl('products'), 'box', 'Browse Products', 'Find and order products'),
    account ? action(pageUrl('balance'), 'wallet', 'Check Account Balance', 'View credit, invoices and payments')
      : action('/signup', 'wallet', 'Open an Account', 'Register your business to order'),
    action(pageUrl('help'), 'help', 'Need Help?', 'Contact our support team'));
}

/**
 * The "Discounted Products" tab: every product the Sales Manager (or the administrator) has put a discount on, as
 * product cards with this customer's price and the discounted price. Like a price, an offer is for a signed-in,
 * approved customer only — the server answers 401 otherwise — so a visitor is asked to sign in instead.
 * Returns { el, badge }: the panel, and the count shown on its tab.
 */
function discountedPanel(account, scope) {
  const el = h('div', { id: 'homeDiscounted', role: 'tabpanel', 'aria-labelledby': 'homeTabDiscounted', class: 'p-home-discounted' });
  const badge = h('span', { class: 'p-badge p-home-tab-count', hidden: true });
  if (!account) {
    setChildren(el, card('p-signin-page',
      h('div', { class: 'p-signin-box' },
        icon('lock'),
        h('p', {}, 'Sign in to see the products on discount, with your own price and the discounted price.'),
        h('a', { class: 'p-btn', href: '/?next=%2Fcatalog' }, 'Sign in'))));
    return { el, badge };
  }

  const products = new Map();   // barcode -> the catalogue product (or null when it cannot be shown)
  let cardsScope = createScope();
  let shownKey = null;
  let loaded = false;           // until the first offers fetch answers, an empty list means "not known yet"
  scope.add(() => cardsScope.dispose());

  const productOf = (barcode) => {
    if (!products.has(barcode)) {
      products.set(barcode, getJSON(`/api/catalog/products/${encodeURIComponent(barcode)}`).catch(() => null));
    }
    return products.get(barcode);
  };

  async function paint() {
    const offers = offerList().sort((a, b) => a.daysLeft - b.daysLeft);
    badge.textContent = String(offers.length);
    badge.hidden = offers.length === 0;
    if (!offers.length && !loaded) return;
    // the cards keep their own price and offer lines up to date; rebuild only when the set of products changes
    const key = offers.map((o) => o.barcode).join('|');
    if (key === shownKey) return;
    shownKey = key;
    if (!offers.length) {
      cardsScope.dispose();
      setChildren(el, h('p', { class: 'p-empty' }, 'No products are on discount right now. Discounts on near-expiry stock appear here as soon as they are set.'));
      return;
    }
    const found = (await Promise.all(offers.map((o) => productOf(o.barcode)))).filter(Boolean);
    if (key !== shownKey) return;   // the offers changed while the products loaded
    cardsScope.dispose();
    cardsScope = createScope();
    setChildren(el,
      h('p', { class: 'p-home-discounted-note' }, 'Good stock with a shorter date, at a lower price. The discounted cartons cannot be returned; Odoo confirms the final price on your order.'),
      found.length ? h('div', { class: 'p-grid' }, found.map((p) => createProductCard(p, cardsScope)))
        : h('p', { class: 'p-empty' }, 'No products are on discount right now.'));
  }

  setChildren(el, h('p', { class: 'p-empty', role: 'status' }, 'Loading discounted products…'));
  scope.add(onPrices(() => { paint(); }));
  refreshOffers().finally(() => { loaded = true; paint(); });
  paint();
  return { el, badge };
}

// ------------------------------------------------------------------ home
export function mountHome(container) {
  const scope = createScope();
  let alive = true;
  scope.add(() => { alive = false; });
  const account = currentCustomer();
  const grid = h('div', { class: 'p-grid', id: 'homeFeatured', role: 'tabpanel', 'aria-labelledby': 'homeTabFeatured' },
    Array.from({ length: 12 }, () => h('div', { class: 'p-card p-card-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))));
  const discounted = discountedPanel(account, scope);

  // Featured and Discounted sit side by side as two tabs over the same spot on the page.
  const tab = (id, panel, label, extra) => h('button', {
    type: 'button', role: 'tab', id, class: 'p-home-tab', 'aria-controls': panel, onClick: () => showTab(id),
  }, label, extra);
  const featuredTab = tab('homeTabFeatured', 'homeFeatured', 'Featured Products');
  const discountedTab = tab('homeTabDiscounted', 'homeDiscounted', 'Discounted Products', discounted.badge);
  function showTab(id) {
    const onDiscounted = id === 'homeTabDiscounted';
    featuredTab.setAttribute('aria-selected', String(!onDiscounted));
    discountedTab.setAttribute('aria-selected', String(onDiscounted));
    toggleHidden(grid, onDiscounted);
    toggleHidden(discounted.el, !onDiscounted);
  }
  showTab('homeTabFeatured');

  setChildren(container, h('div', { class: 'p-home' },
    h('div', { class: 'p-home-main' },
      banner(account, scope),
      account ? createOffersSection(scope) : null,
      createUpcomingSection(scope),
      h('div', { class: 'p-section-head' },
        h('div', { class: 'p-home-tabs', role: 'tablist', 'aria-label': 'Products on the home page' }, featuredTab, discountedTab),
        link(pageUrl('products'), 'View All')),
      grid,
      discounted.el),
    h('aside', { class: 'p-rail', 'aria-label': 'Your account' },
      accountOverview(account),
      recentOrders(account),
      quickActions(account))));

  let baseItems = [];
  let lastOfferKey = '';
  let cardsScope = createScope();
  scope.add(() => cardsScope.dispose());

  async function renderFeaturedGrid() {
    if (!alive || !baseItems.length) return;
    const offers = offerList();
    const offerBarcodes = offers.map((o) => String(o.barcode));
    const byId = new Map(baseItems.map((p) => [String(p.id), p]));
    const missing = offerBarcodes.filter((b) => !byId.has(b));
    if (missing.length) {
      const fetched = await Promise.all(
        missing.map((b) => getJSON(`/api/catalog/products/${encodeURIComponent(b)}`).catch(() => null)),
      );
      if (!alive) return;
      for (const p of fetched) {
        if (p && p.id) {
          byId.set(String(p.id), p);
          baseItems.unshift(p);
        }
      }
    }
    const seen = new Set();
    const merged = [];
    for (const b of offerBarcodes) {
      const p = byId.get(b);
      if (p && !seen.has(p.id)) {
        seen.add(p.id);
        merged.push(p);
      }
    }
    for (const p of baseItems) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        merged.push(p);
      }
      if (merged.length >= 12) break;
    }
    cardsScope.dispose();
    cardsScope = createScope();
    setChildren(grid, merged.length ? merged.map((p) => createProductCard(p, cardsScope))
      : h('p', { class: 'p-empty' }, 'No products are available right now.'));
  }

  scope.add(onPrices(() => {
    const key = offerList().map((o) => `${o.barcode}:${o.discountPct}`).sort().join('|');
    if (key !== lastOfferKey) {
      lastOfferKey = key;
      renderFeaturedGrid();
    }
  }));

  Promise.all([
    getJSON('/api/catalog/products?view=available&with_image=true&sort=name_asc&limit=12&offset=0').catch(() => ({ items: [] })),
    getJSON('/api/catalog/products?view=available&sort=name_asc&limit=12&offset=0'),
  ]).then(([withImg, allAvail]) => {
    if (!alive) return;
    const seen = new Set();
    for (const p of [...(withImg.items || []), ...(allAvail.items || [])]) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        baseItems.push(p);
      }
    }
    lastOfferKey = offerList().map((o) => `${o.barcode}:${o.discountPct}`).sort().join('|');
    renderFeaturedGrid();
  }, () => {
    if (!alive) return;
    setChildren(grid, h('div', { class: 'c-error', role: 'alert' },
      h('h2', {}, 'We could not load the products'), h('p', {}, 'Check your connection and try again.')));
  });

  return { destroy: () => scope.dispose() };
}

// ------------------------------------------------------------------ account pages
function needsSignIn(container, title) {
  setChildren(container, h('div', { class: 'p-page' },
    h('h1', {}, title),
    card('p-signin-page',
      h('div', { class: 'p-signin-box' },
        icon('lock'),
        h('p', {}, `Sign in to see your ${title.toLowerCase()}.`),
        h('a', { class: 'p-btn', href: `/?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Sign in'),
        h('a', { class: 'p-btn p-btn-ghost', href: '/signup' }, 'Create an account')))));
  return { destroy() {} };
}

const pageHead = (title, sub, actions = null) => h('div', { class: 'p-page-head' },
  h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), sampleTag(), actions);

// Downloads of the signed-in customer's own documents (the server takes the customer from the session).
const STATEMENT_PDF = '/api/catalog/statement.pdf';
const STATEMENT_CSV = '/api/catalog/statement.csv';
const invoicePdfUrl = (ref) => `/api/catalog/invoices/${encodeURIComponent(ref)}/pdf`;
const statementButtons = () => h('div', { class: 'p-downloads' },
  h('a', { class: 'p-btn', href: STATEMENT_PDF, download: '' }, icon('download'), 'Download statement (PDF)'),
  h('a', { class: 'p-btn p-btn-ghost', href: STATEMENT_CSV, download: '' }, 'Excel / CSV'));

const table = (head, rows) => h('div', { class: 'p-table-wrap' },
  h('table', { class: 'p-table' },
    h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))),
    h('tbody', {}, rows)));

export function mountOrders(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Orders');
  const orders = orderList();
  setChildren(container, h('div', { class: 'p-page' },
    pageHead('Orders', 'Every order with its Box for Less and Odoo numbers. The status follows Odoo; the amount appears once Odoo has invoiced it.'),
    card('', table(['Order', 'Odoo number', 'Date', 'Cartons', 'Amount', 'Pay by', 'Status', 'Action'],
      orders.map((o) => h('tr', {},
        h('td', {}, h('b', {}, o.ref),
          o.items.filter((i) => i.discountedCartons).map((i) => h('div', { class: 'p-muted' }, `${i.discountedCartons} × ${i.name} at ${i.discountPct}% off (not returnable)`))),
        h('td', {}, o.odoo), h('td', {}, formatDate(o.at)),
        h('td', {}, `${o.cartons} (${o.lines} lines)`), h('td', {}, o.amount === null ? '—' : formatGhs(o.amount)),
        h('td', {}, o.payBy ? formatDate(o.payBy) : '—'), h('td', {}, statusPill(o.status)),
        h('td', {}, h('button', {
          type: 'button',
          class: 'p-btn p-btn-secondary p-btn-sm',
          style: 'padding: 4px 10px; font-size: 13px; cursor: pointer; white-space: nowrap;',
          title: 'Add all items from this order into your cart',
          onClick: () => { reorderOrderItems(o.items); },
        }, 'Reorder'))))))));
  return { destroy() {} };
}

export function mountBalance(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Account Balance');
  const a = accountSummary();
  if (a.type === 'cash') {
    setChildren(container, h('div', { class: 'p-page' },
      pageHead('Account Balance'),
      card('', h('div', { class: 'p-cash-box' }, h('b', {}, 'Cash customer'),
        h('p', {}, 'Cash orders are paid on delivery, so there is no balance or credit on this account.')),
      link(pageUrl('help'), 'Apply for a company credit account'))));
    return { destroy() {} };
  }
  const tile = (label, value, tone = '') => h('div', { class: `p-tile ${tone}` }, h('span', {}, label), h('b', {}, money(value)));
  const invoices = invoiceList().filter((i) => i.open > 0);
  setChildren(container, h('div', { class: 'p-page' },
    pageHead('Account Balance', 'Your live credit position, open invoices, and available limit.', statementButtons()),
    h('div', { class: 'p-tiles' },
      tile('Available Credit', a.available, 'green'),
      tile('Credit Limit', a.creditLimit),
      tile('Amount Owed', a.amountOwed),
      tile('Overdue', a.overdue, 'red')),
    card('', panelHead('How available credit is worked out'),
      h('p', { class: 'p-formula' }, `Credit limit ${money(a.creditLimit)} − amount owed ${money(a.amountOwed)} − open orders ${money(a.openOrders)} = ${money(a.available)}`),
      h('p', { class: 'p-muted' }, 'An order that would go over your available credit cannot be sent. A late payment brings a reminder, not a block.')),
    card('', panelHead('Open invoices', link(pageUrl('invoices'), 'All invoices', 'p-link p-link-sm')),
      table(['Invoice', 'Order', 'Pay by', 'Open amount'],
        invoices.map((i) => h('tr', {}, h('td', {}, h('b', {}, i.ref)), h('td', {}, i.order), h('td', {}, formatDate(i.payBy)), h('td', {}, formatGhs(i.open))))))));
  return { destroy() {} };
}

export function mountInvoices(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Invoices');
  const invoices = invoiceList();
  const tone = { open: 'blue', overdue: 'red', paid: 'green' };
  setChildren(container, h('div', { class: 'p-page' },
    pageHead('Invoices', 'Your invoices and payment status. Download a copy of any invoice, or your account statement.', invoices.length ? statementButtons() : null),
    card('', invoices.length ? table(['Invoice', 'Order', 'Date', 'Pay by', 'Amount', 'Open', 'Status', 'Download'],
      invoices.map((i) => h('tr', {},
        h('td', {}, h('b', {}, i.ref)), h('td', {}, i.order), h('td', {}, formatDate(i.at)), h('td', {}, formatDate(i.payBy)),
        h('td', {}, formatGhs(i.amount)), h('td', {}, formatGhs(i.open)),
        h('td', {}, h('span', { class: `p-status ${tone[i.status]}` }, i.status[0].toUpperCase() + i.status.slice(1))),
        h('td', {}, h('a', { class: 'p-link p-link-sm p-invoice-pdf', href: invoicePdfUrl(i.ref), download: '', 'aria-label': `Download invoice ${i.ref} as PDF` }, icon('download'), 'PDF')))))
      : h('p', { class: 'p-empty' }, 'No invoices found on this account.'))));
  return { destroy() {} };
}

export function mountSettings(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Settings');
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v || '—')];
  const curInput = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Current password', style: 'padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;width:100%;max-width:320px;' });
  const nextInput = h('input', { type: 'password', required: true, autocomplete: 'new-password', placeholder: 'New password (min 8 chars)', style: 'padding:8px 12px;border:1px solid #cbd5e1;border-radius:8px;width:100%;max-width:320px;' });
  const statusEl = h('p', { class: 'p-muted', role: 'status', style: 'margin-top:8px;font-weight:600;' });
  const saveBtn = h('button', { type: 'submit', class: 'p-btn', style: 'margin-top:8px;' }, 'Update Password');
  const pwForm = h('form', {
    style: 'display:flex;flex-direction:column;gap:10px;margin-top:10px;align-items:flex-start;',
    onSubmit: async (e) => {
      e.preventDefault();
      statusEl.textContent = '';
      saveBtn.disabled = true;
      try {
        const res = await fetch('/api/auth/customer/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ current: curInput.value, next: nextInput.value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Could not update password.');
        curInput.value = '';
        nextInput.value = '';
        statusEl.style.color = '#15803d';
        statusEl.textContent = 'Password updated successfully.';
      } catch (err) {
        statusEl.style.color = '#b91c1c';
        statusEl.textContent = err.message;
      } finally {
        saveBtn.disabled = false;
      }
    },
  }, curInput, nextInput, saveBtn, statusEl);

  setChildren(container, h('div', { class: 'p-page' },
    h('div', { class: 'p-page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Your account details and password security.'))),
    card('', panelHead('Account'),
      h('dl', { class: 'p-details' },
        row('Customer ID', account.customerId ? `#${account.customerId}` : '—'),
        row('Customer Class', account.customerClass || '—'),
        row('Company', account.company), row('Sales Representative', account.contact), row('Phone', account.phone),
        row('Email', account.email), row('Delivery address', account.address),
        row('Account type', account.type === 'cash' ? 'Cash customer' : 'Credit customer'))),
    card('', panelHead('Change Password'),
      h('p', { class: 'p-muted' }, 'Update the password you use to sign in with your Customer ID or email.'),
      pwForm)));
  return { destroy() {} };
}

export function mountHelp(container) {
  const account = currentCustomer();
  const rep = account?.salesRep;
  const repContact = !account
    ? h('p', {}, 'Sign in to see the Sales Representative assigned to your account.')
    : rep
      ? h('div', { class: 'p-support-contact' },
        h('p', {}, h('b', {}, rep.name)),
        rep.phone ? h('p', {}, 'Phone: ', h('a', { href: `tel:${rep.phone}` }, rep.phone)) : null,
        rep.email ? h('p', {}, 'Email: ', h('a', { href: `mailto:${rep.email}` }, rep.email)) : null,
        !rep.phone && !rep.email ? h('p', { class: 'p-muted' }, 'Your representative is assigned, but their direct contact details are not available here. Please contact the Box for Less office and ask for them by name.') : null)
      : h('p', {}, 'No Sales Representative is currently assigned to your account. Please contact the Box for Less office for assistance.');
  setChildren(container, h('div', { class: 'p-page' },
    h('div', { class: 'p-page-head' }, h('div', {}, h('h1', {}, 'Help & Support'), h('p', {}, 'How ordering with Box for Less works.'))),
    card('', panelHead('Ordering'),
      h('ul', { class: 'p-list' },
        h('li', {}, 'Order in whole cartons. A product with less than one carton in stock shows its stock label but cannot be added.'),
        h('li', {}, 'Your order is a request: stock is not held, and our team confirms every order before it is prepared.'),
        h('li', {}, 'Stock labels are In Stock, Limited Stock or Out of Stock. They are updated every day.'))),
    card('', panelHead('Credit accounts'),
      h('p', {}, 'Companies can apply for a credit account. Our Sales Manager sets your credit limit and payment schedule. Cash customers pay on delivery.')),
    card('', panelHead('Contact us'),
      h('p', {}, 'For account help, contact the Sales Representative assigned to you:'),
      repContact)));
  return { destroy() {} };
}

export function mountCustomerReturns(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Request a Return');

  setChildren(container, h('div', { class: 'p-page' },
    h('div', { class: 'p-page-head' }, h('div', {},
      h('h1', {}, 'Request a Return'),
      h('p', {}, 'Choose cartons from a dispatched, invoiced, or paid order and tell us why you would like to return them.'))),
    card('', h('p', { class: 'p-muted' },
      'A manager reviews each request. Approval records the decision only; it does not issue a credit or change stock in Odoo. Contact your Sales Representative to arrange next steps.')),
    card('', panelHead('Request a return'), h('div', { class: 'p-return-items', role: 'status' }, 'Loading eligible purchases…')),
    card('', panelHead('Your return requests'), h('div', { class: 'p-return-history', role: 'status' }, 'Loading your requests…'))));

  const itemsEl = container.querySelector('.p-return-items');
  const historyEl = container.querySelector('.p-return-history');

  async function load() {
    try {
      const data = await getJSON('/api/catalog/return-requests');
      renderItems(data.items || []);
      renderHistory(data.requests || []);
    } catch (error) {
      setChildren(itemsEl, h('p', { class: 'p-empty', role: 'alert' }, error.message));
      setChildren(historyEl, h('p', { class: 'p-empty' }, 'Could not load your return requests.'));
    }
  }

  function renderItems(items) {
    if (!items.length) {
      setChildren(itemsEl, h('p', { class: 'p-empty' }, 'There are no eligible cartons available to return. Only dispatched, invoiced, or paid orders are shown.'));
      return;
    }
    const quantity = h('input', { type: 'number', min: '1', step: '1', required: true, value: '1', 'aria-label': 'Cartons to return' });
    const select = h('select', {
      required: true,
      'aria-label': 'Purchased product',
      onChange: () => { quantity.max = String(items[Number(select.value)]?.availableCartons || 1); },
    },
      items.map((item, index) => h('option', { value: String(index) },
        `${item.productName} · ${item.orderReference} · ${item.availableCartons} of ${item.purchasedCartons} cartons available`)));
    quantity.max = String(items[0].availableCartons);
    const reason = h('textarea', { required: true, maxlength: '1000', rows: '4', placeholder: 'Tell us why you are requesting this return.', 'aria-label': 'Reason for return' });
    const message = h('p', { role: 'status', class: 'p-muted', 'aria-live': 'polite' });
    const submit = h('button', { type: 'submit', class: 'p-btn' }, 'Submit return request');
    const form = h('form', {
      class: 'p-return-form',
      onSubmit: async (event) => {
        event.preventDefault();
        const selected = items[Number(select.value)];
        if (!selected) return;
        if (!reason.value.trim()) { reason.setCustomValidity('Enter a reason for the return.'); reason.reportValidity(); return; }
        reason.setCustomValidity('');
        submit.disabled = true;
        message.textContent = 'Submitting…';
        try {
          await postJSON('/api/catalog/return-requests', {
            orderReference: selected.orderReference, barcode: selected.barcode,
            cartons: Number(quantity.value), reason: reason.value,
          });
          reason.value = '';
          message.textContent = 'Your return request has been submitted.';
          await load();
        } catch (error) {
          message.textContent = error.message;
        } finally { submit.disabled = false; }
      },
    },
    h('label', {}, 'Purchased product', select),
    h('label', {}, 'Cartons to return', quantity),
    h('label', {}, 'Reason for return', reason),
    submit, message);
    setChildren(itemsEl, form);
  }

  function renderHistory(requests) {
    if (!requests.length) {
      setChildren(historyEl, h('p', { class: 'p-empty' }, 'You have not submitted a return request.'));
      return;
    }
    setChildren(historyEl, requests.map((request) => h('article', { class: 'p-return-history-item' },
      h('div', {}, h('b', {}, request.productName), h('span', { class: 'p-muted' }, ` · ${request.reference}`)),
      h('p', {}, `${request.cartons} carton${request.cartons === 1 ? '' : 's'} from order ${request.orderReference}`),
      h('p', {}, h('b', {}, 'Your reason: '), request.reason),
      h('p', {}, h('b', {}, 'Status: '), request.status),
      request.status === 'DECLINED' ? h('p', { class: 'p-return-decline' }, h('b', {}, 'Manager’s reason: '), request.declineReason) : null,
      h('p', { class: 'p-muted' }, formatDate(request.createdAt)))));
  }

  load();
  return { destroy() {} };
}

export function mountBrands(container) {
  const brandGrid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-top:12px;' },
    h('p', { class: 'p-muted' }, 'Loading brands…'));
  setChildren(container, h('div', { class: 'p-page' },
    h('div', { class: 'p-page-head' }, h('div', {}, h('h1', {}, 'Brands & Product Lines'), h('p', {}, 'Select any brand below to browse its available products.'))),
    card('', brandGrid)));

  getJSON('/api/catalog/products?view=full&limit=250').then((res) => {
    const counts = new Map();
    for (const p of res.items || []) {
      const words = String(p.name || '').trim().split(/\s+/);
      let brand = words[0] || 'OTHER';
      if (words.length >= 2 && ['AL', 'CHTOURA', 'ST', 'EL'].includes(brand.toUpperCase())) {
        brand = `${words[0]} ${words[1]}`;
      }
      brand = brand.toUpperCase();
      counts.set(brand, (counts.get(brand) || 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    setChildren(brandGrid, entries.map(([brand, count]) => h('button', {
      type: 'button',
      class: 'p-quick',
      style: 'text-align:left;cursor:pointer;border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:14px;',
      onClick: () => {
        patchList({ search: brand, offset: 0 });
        navigate(pageUrl('products'));
      },
    }, h('span', {}, h('b', {}, brand), h('small', { style: 'display:block;color:#64748b;margin-top:4px;' }, `${count} product${count === 1 ? '' : 's'}`)))));
  }).catch(() => {
    setChildren(brandGrid, link(pageUrl('products'), 'Browse all products'));
  });
  return { destroy() {} };
}
