// The customer pages around the product list, after the Oct 2026 customer mockup:
//   home      — welcome banner, featured products, and the account column
//   orders, balance, invoices, settings, help, brands
//
// Products and stock are real (/api/catalog). Prices, credit, orders and invoices are SAMPLE
// figures from ./sample-data.js, shown only to a signed-in customer and marked as samples.
import { h, setChildren, svg } from '../lib/dom.js';
import { createScope } from '../lib/util.js';
import { getJSON } from './http.js';
import { createProductCard } from './cards.js';
import { pageUrl } from './router.js';
import {
  SAMPLE_NOTE, currentCustomer, sampleAccount, sampleOrders, sampleInvoices,
  ORDER_STATUS, formatGhs, formatDate,
} from './sample-data.js';

const PATHS = {
  arrow: 'M5 12h14M13 6l6 6-6 6',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3.5 7.7 12 12l8.5-4.3M12 12v9',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h11v3M16 13.5h.01',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  lock: 'M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
};
const icon = (name) => svg(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`);
const link = (href, text, cls = 'p-link') => h('a', { class: cls, href }, text, ' ', icon('arrow'));
const sampleTag = () => h('span', { class: 'p-sample', title: SAMPLE_NOTE }, 'Sample');
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

  return h('div', { class: 'p-hero-wrap' },
    h('section', { class: 'p-hero', 'aria-labelledby': 'heroTitle' },
      h('div', { class: 'p-hero-pics' }, pics),
      h('div', { class: 'p-hero-copy' },
        h('p', { class: 'p-hero-hello' }, account ? `Welcome back, ${account.company}` : 'Welcome to Box for Less'),
        h('h1', { id: 'heroTitle' }, 'Your Trusted Wholesale Partner'),
        h('p', {}, 'Quality products, great prices, reliable delivery.'),
        h('a', { class: 'p-btn', href: pageUrl('products') }, 'View Products', ' ', icon('arrow')))),
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
        h('a', { class: 'p-btn', href: '/login.html?next=/catalog' }, 'Sign in'),
        h('a', { class: 'p-btn p-btn-ghost', href: '/register.html' }, 'Create an account')));
  }
  const a = sampleAccount(account);
  if (a.type === 'cash') {
    return card('p-account',
      panelHead('Account Overview', sampleTag()),
      h('div', { class: 'p-cash-box' },
        h('b', {}, 'Cash customer'),
        h('p', {}, 'You pay in cash on delivery. There is no credit or balance on a cash account.')),
      link(pageUrl('help'), 'Apply for a credit account'));
  }
  const pct = Math.max(0, Math.min(100, (a.available / a.creditLimit) * 100));
  return card('p-account',
    panelHead('Account Overview', sampleTag()),
    h('div', { class: 'p-credit' },
      h('span', {}, 'Available Credit'),
      h('b', {}, formatGhs(a.available)),
      h('div', { class: 'p-bar', role: 'img', 'aria-label': `${Math.round(pct)}% of the credit limit available` }, h('i', { style: { width: `${pct}%` } })),
      h('dl', {},
        h('dt', {}, 'Credit Limit'), h('dd', {}, formatGhs(a.creditLimit)),
        h('dt', {}, 'Amount Owed'), h('dd', {}, formatGhs(a.amountOwed)),
        h('dt', {}, 'Open Orders'), h('dd', {}, formatGhs(a.openOrders)))),
    link(pageUrl('balance'), 'View Full Balance'));
}

function recentOrders(account) {
  if (!account) return null;
  const orders = sampleOrders().slice(0, 4);
  return card('p-orders',
    panelHead('Recent Orders', link(pageUrl('orders'), 'View All', 'p-link p-link-sm')),
    h('ul', { class: 'p-order-list' }, orders.map((o) => h('li', {},
      h('div', { class: 'p-order-top' }, h('b', {}, o.ref), statusPill(o.status)),
      h('span', { class: 'p-muted' }, formatDate(o.at)),
      h('b', { class: 'p-order-amount' }, formatGhs(o.amount))))));
}

function quickActions(account) {
  const action = (href, name, title, sub) => h('a', { class: 'p-quick', href },
    h('span', { class: 'p-quick-icon' }, icon(name)), h('span', {}, h('b', {}, title), h('small', {}, sub)));
  return card('p-quick-panel',
    panelHead('Quick Actions'),
    action(pageUrl('products'), 'box', 'Browse Products', 'Find and order products'),
    account ? action(pageUrl('balance'), 'wallet', 'Check Account Balance', 'View credit, invoices and payments')
      : action('/register.html', 'wallet', 'Open an Account', 'Register your business to order'),
    action(pageUrl('help'), 'help', 'Need Help?', 'Contact our support team'));
}

// ------------------------------------------------------------------ home
export function mountHome(container) {
  const scope = createScope();
  let alive = true;
  scope.add(() => { alive = false; });
  const account = currentCustomer();
  const grid = h('div', { class: 'p-grid' },
    Array.from({ length: 12 }, () => h('div', { class: 'p-card p-card-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))));

  setChildren(container, h('div', { class: 'p-home' },
    h('div', { class: 'p-home-main' },
      banner(account, scope),
      account ? h('p', { class: 'p-sample-note' }, sampleTag(), ' ', SAMPLE_NOTE) : null,
      h('div', { class: 'p-section-head' },
        h('h2', {}, 'Featured Products'),
        link(pageUrl('products'), 'View All')),
      grid),
    h('aside', { class: 'p-rail', 'aria-label': 'Your account' },
      accountOverview(account),
      recentOrders(account),
      quickActions(account))));

  getJSON('/api/catalog/products?view=available&sort=name_asc&limit=12&offset=0').then((data) => {
    if (!alive) return;
    setChildren(grid, data.items.length ? data.items.map((p) => createProductCard(p, scope))
      : h('p', { class: 'p-empty' }, 'No products are available right now.'));
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
        h('a', { class: 'p-btn', href: `/login.html?next=${encodeURIComponent(location.pathname + location.search)}` }, 'Sign in'),
        h('a', { class: 'p-btn p-btn-ghost', href: '/register.html' }, 'Create an account')))));
  return { destroy() {} };
}

const pageHead = (title, sub) => h('div', { class: 'p-page-head' },
  h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), sampleTag());

const table = (head, rows) => h('div', { class: 'p-table-wrap' },
  h('table', { class: 'p-table' },
    h('thead', {}, h('tr', {}, head.map((t) => h('th', {}, t)))),
    h('tbody', {}, rows)));

export function mountOrders(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Orders');
  const orders = sampleOrders();
  setChildren(container, h('div', { class: 'p-page' },
    pageHead('Orders', 'Every order with its Box for Less and Odoo numbers. Status comes from Odoo.'),
    h('p', { class: 'p-sample-note' }, SAMPLE_NOTE),
    card('', table(['Order', 'Odoo number', 'Date', 'Cartons', 'Amount', 'Status'],
      orders.map((o) => h('tr', {},
        h('td', {}, h('b', {}, o.ref)), h('td', {}, o.odoo), h('td', {}, formatDate(o.at)),
        h('td', {}, `${o.cartons} (${o.lines} lines)`), h('td', {}, formatGhs(o.amount)), h('td', {}, statusPill(o.status))))))));
  return { destroy() {} };
}

export function mountBalance(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Account Balance');
  const a = sampleAccount(account);
  if (a.type === 'cash') {
    setChildren(container, h('div', { class: 'p-page' },
      pageHead('Account Balance'),
      card('', h('div', { class: 'p-cash-box' }, h('b', {}, 'Cash customer'),
        h('p', {}, 'Cash orders are paid on delivery, so there is no balance or credit on this account.')),
      link(pageUrl('help'), 'Apply for a company credit account'))));
    return { destroy() {} };
  }
  const tile = (label, value, tone = '') => h('div', { class: `p-tile ${tone}` }, h('span', {}, label), h('b', {}, formatGhs(value)));
  const invoices = sampleInvoices().filter((i) => i.open > 0);
  setChildren(container, h('div', { class: 'p-page' },
    pageHead('Account Balance', 'Every figure comes from Odoo. Box for Less never calculates your balance itself.'),
    h('p', { class: 'p-sample-note' }, SAMPLE_NOTE),
    h('div', { class: 'p-tiles' },
      tile('Available Credit', a.available, 'green'),
      tile('Credit Limit', a.creditLimit),
      tile('Amount Owed', a.amountOwed),
      tile('Overdue', a.overdue, 'red')),
    card('', panelHead('How available credit is worked out'),
      h('p', { class: 'p-formula' }, `Credit limit ${formatGhs(a.creditLimit)} − amount owed ${formatGhs(a.amountOwed)} − open orders ${formatGhs(a.openOrders)} = ${formatGhs(a.available)}`),
      h('p', { class: 'p-muted' }, 'An order that would go over your available credit cannot be sent. A late payment brings a reminder, not a block.')),
    card('', panelHead('Open invoices', link(pageUrl('invoices'), 'All invoices', 'p-link p-link-sm')),
      table(['Invoice', 'Order', 'Due', 'Open amount'],
        invoices.map((i) => h('tr', {}, h('td', {}, h('b', {}, i.ref)), h('td', {}, i.order), h('td', {}, formatDate(i.due)), h('td', {}, formatGhs(i.open))))))));
  return { destroy() {} };
}

export function mountInvoices(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Invoices');
  const invoices = sampleInvoices();
  const tone = { open: 'blue', overdue: 'red', paid: 'green' };
  setChildren(container, h('div', { class: 'p-page' },
    pageHead('Invoices', 'Invoices are issued in Odoo and shown here.'),
    h('p', { class: 'p-sample-note' }, SAMPLE_NOTE),
    card('', invoices.length ? table(['Invoice', 'Order', 'Date', 'Due', 'Amount', 'Open', 'Status'],
      invoices.map((i) => h('tr', {},
        h('td', {}, h('b', {}, i.ref)), h('td', {}, i.order), h('td', {}, formatDate(i.at)), h('td', {}, formatDate(i.due)),
        h('td', {}, formatGhs(i.amount)), h('td', {}, formatGhs(i.open)),
        h('td', {}, h('span', { class: `p-status ${tone[i.status]}` }, i.status[0].toUpperCase() + i.status.slice(1))))))
      : h('p', { class: 'p-empty' }, 'Cash customers have no invoices on Box for Less.'))));
  return { destroy() {} };
}

export function mountSettings(container) {
  const account = currentCustomer();
  if (!account) return needsSignIn(container, 'Settings');
  const row = (k, v) => [h('dt', {}, k), h('dd', {}, v || '—')];
  setChildren(container, h('div', { class: 'p-page' },
    h('div', { class: 'p-page-head' }, h('div', {}, h('h1', {}, 'Settings'), h('p', {}, 'Your account details. To change them, contact Box for Less.'))),
    card('', panelHead('Account'),
      h('dl', { class: 'p-details' },
        row('Company', account.company), row('Contact person', account.contact), row('Phone', account.phone),
        row('Email', account.email), row('Delivery address', account.address),
        row('Account type', account.type === 'cash' ? 'Cash customer' : 'Credit customer'))),
    card('', panelHead('Preview'),
      h('p', { class: 'p-muted' }, 'This account is saved in this browser only until customer accounts are connected to the server.'))));
  return { destroy() {} };
}

export function mountHelp(container) {
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
      h('p', {}, 'Speak to your Box for Less sales representative, or call our office during working hours.'))));
  return { destroy() {} };
}

export function mountBrands(container) {
  setChildren(container, h('div', { class: 'p-page' },
    h('div', { class: 'p-page-head' }, h('div', {}, h('h1', {}, 'Brands'))),
    card('', h('p', {}, 'Browsing by brand is coming soon, once every product has its brand recorded.'),
      link(pageUrl('products'), 'Browse all products'))));
  return { destroy() {} };
}
