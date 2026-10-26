// The customer catalogue shell, after the Oct 2026 customer mockup: a navy header (brand, search,
// notifications, account), a left menu, the page in the middle, and a navy footer. On phones the
// left menu folds into the header menu and the tab bar at the bottom (see request.js).
//
// Talks ONLY to /api/catalog, which returns customer-safe payloads. Prices, credit and orders
// on screen come from the server (./customer-data.js) for the signed-in customer's own session.
// Do not import ../api.js (the staff client) here.
import { h, setChildren, svg } from '../lib/dom.js';
import { navigate, onRouteChange, parsePath, interceptLinks, pageUrl } from './router.js';
import { mountList, showEverything, patchList, state as listState } from './list.js';
import { mountDetail } from './detail.js';
import { mountRequestUI } from './request.js';
import {
  mountHome, mountOrders, mountBalance, mountInvoices, mountSettings, mountHelp, mountBrands,
} from './pages.js';
import { REQUEST_LABELS } from './labels.js';
import { loadCustomerData, currentCustomer, orderList, signOutCustomer } from './customer-data.js';

const ACCOUNT_PAGES = ['home', 'orders', 'balance', 'invoices', 'settings'];

const TITLE = 'Box for Less — Wholesale Catalogue';

const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  home: 'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3.5 7.7 12 12l8.5-4.3M12 12v9',
  cart: 'M3 4h2.2l2.3 11h10.8l2-8H6.4M9.5 19.5h.01M17 19.5h.01',
  orders: 'M5 4h14v17H5zM9 8h6M9 12h6M9 16h3M8 2v4M16 2v4',
  balance: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  invoice: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.5a7 7 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2 1.2L10 21h4l.5-2.5a7 7 0 0 0 2-1.2l2.4.9 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  tag: 'M3 12V4h8l10 10-8 8L3 12zM7.5 8.5h.01',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  help: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  bell: 'M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9zM10 21h4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  chevron: 'm6 9 6 6 6-6',
  signOut: 'M15 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3M10 8l-4 4 4 4M6 12h10',
};
const icon = (name) => svg(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${PATHS[name]}"/></svg>`);
const brandMark = () => svg(`<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
  <path d="m24 3 19 10.5v21L24 45 5 34.5v-21L24 3Z" fill="currentColor"/>
  <path d="m5.5 13.5 18.5 10 18.5-10M24 24v20.5M15 8l19 11M33 8 14 19" fill="none" stroke="#0b2a55" stroke-width="2.6" stroke-linejoin="round"/>
</svg>`);
const brand = (cls, name = 'Box for Less', tagline = 'Bigger boxes. Better value.') => h('a', { class: cls, href: '/catalog' },
  h('span', { class: 'p-logo' }, brandMark()),
  h('span', {}, h('b', {}, name), h('small', {}, tagline)));

const PAGE_MOUNTS = {
  orders: mountOrders, balance: mountBalance, invoices: mountInvoices,
  settings: mountSettings, help: mountHelp, brands: mountBrands,
};

/** Start the catalogue in `root`. */
export async function startCatalog(root) {
  const [_, siteConfig] = await Promise.all([
    loadCustomerData(),
    fetch('/api/site-settings').then((r) => r.json()).catch(() => null),
  ]);
  window.__bflSiteSettings = siteConfig;
  const storeName = siteConfig?.storefront?.storeName || 'Box for Less';
  const tagline = siteConfig?.storefront?.tagline || 'Bigger boxes. Better value.';
  const announceStrip = siteConfig?.storefront?.announcement?.enabled && siteConfig?.storefront?.announcement?.text
    ? h('div', { class: `p-announcement-strip tone-${siteConfig.storefront.announcement.tone || 'brand'}` }, siteConfig.storefront.announcement.text)
    : null;

  let current = null;        // the page on screen: { destroy }
  let route = parsePath();
  const account = currentCustomer();
  const signOut = () => signOutCustomer();

  // ---------------------------------------------------------------- header
  // The search: on the Products page it filters as you type; elsewhere Enter (or the button)
  // opens Products with the term. The field is built once and never rebuilt.
  const searchInput = h('input', {
    type: 'search', inputmode: 'search', autocomplete: 'off', 'aria-label': 'Search products',
    placeholder: 'Search for products, barcodes or categories…',
    onInput: (e) => { if (route.name === 'products') patchList({ search: e.target.value, offset: 0 }); },
  });
  const searchForm = h('form', {
    class: 'p-search', role: 'search',
    onSubmit: (e) => {
      e.preventDefault();
      patchList({ search: searchInput.value, offset: 0 });
      if (route.name !== 'products') navigate(pageUrl('products'));
    },
  }, searchInput, h('button', { type: 'submit', class: 'p-search-btn', 'aria-label': 'Search' }, icon('search')));

  const pending = account ? orderList().filter((o) => o.status === 'pending').length : 0;
  const bell = h('a', {
    class: 'p-bell', href: account ? pageUrl('orders') : '/?next=%2Fcatalog',
    'aria-label': pending ? `${pending} order waiting for approval` : 'Notifications',
  }, icon('bell'), pending ? h('span', { class: 'p-badge' }, pending) : null);

  const userMenu = h('div', { class: 'p-user-menu', role: 'menu', hidden: true },
    account
      ? [h('p', { class: 'p-user-menu-head' }, 'Signed in as', h('b', {}, account.company)),
        h('a', { href: pageUrl('balance'), role: 'menuitem' }, icon('balance'), 'Account Balance'),
        h('a', { href: pageUrl('orders'), role: 'menuitem' }, icon('orders'), 'Orders'),
        h('a', { href: pageUrl('settings'), role: 'menuitem' }, icon('settings'), 'Settings'),
        h('hr'),
        h('button', { type: 'button', role: 'menuitem', onClick: signOut }, icon('signOut'), 'Sign out')]
      : [h('a', { href: '/?next=%2Fcatalog', role: 'menuitem' }, icon('user'), 'Sign in'),
        h('a', { href: '/signup', role: 'menuitem' }, icon('box'), 'Create an account')]);
  const userBtn = h('button', {
    type: 'button', class: 'p-user', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onClick: () => setUserMenu(userMenu.hidden),
  },
  h('span', { class: 'p-avatar' }, icon('user')),
  h('span', { class: 'p-user-name' }, account ? `Hello, ${account.company}` : 'Sign in'),
  icon('chevron'));
  function setUserMenu(open) {
    userMenu.hidden = !open;
    userBtn.setAttribute('aria-expanded', String(open));
  }

  const menuBtn = h('button', {
    type: 'button', class: 'p-menu-btn', 'aria-label': 'Open menu', 'aria-expanded': 'false', 'aria-controls': 'pSide',
    onClick: () => setSide(!side.classList.contains('open')),
  }, icon('menu'));

  const header = h('header', { class: 'p-header' },
    h('div', { class: 'p-header-inner' },
      menuBtn,
      brand('p-brand', storeName, tagline),
      searchForm,
      h('div', { class: 'p-header-actions' }, bell, h('div', { class: 'p-user-wrap' }, userBtn, userMenu))));

  // ---------------------------------------------------------------- left menu
  // The cart badge is kept up to date by request.js (.c-side-request-badge).
  const cartBadge = h('span', { class: 'c-side-request-badge p-badge p-badge-blue', hidden: true });
  const navLink = (name, label, iconName, extra) => h('a', { class: 'p-nav-link', href: pageUrl(name), 'data-page': name }, icon(iconName), h('span', {}, label), extra);
  const cartLink = h('button', {
    type: 'button', class: 'p-nav-link c-side-request', 'aria-label': REQUEST_LABELS.name,
    onClick: () => { setSide(false); window.dispatchEvent(new Event('bfl:open-request')); },
  }, icon('cart'), h('span', {}, REQUEST_LABELS.name), cartBadge);
  const side = h('aside', { class: 'p-side', id: 'pSide', 'aria-label': 'Shop navigation' },
    h('nav', { class: 'p-nav' },
      navLink('home', 'Home', 'home'),
      navLink('products', 'Products', 'box'),
      cartLink,
      navLink('orders', 'Orders', 'orders'),
      navLink('balance', 'Account Balance', 'balance'),
      navLink('invoices', 'Invoices', 'invoice'),
      navLink('settings', 'Settings', 'settings')),
    h('hr'),
    h('p', { class: 'p-side-label' }, 'Quick Links'),
    h('nav', { class: 'p-nav p-nav-small', 'aria-label': 'Quick links' },
      navLink('brands', 'View All Brands', 'tag'),
      h('button', { type: 'button', class: 'p-nav-link', onClick: () => { setSide(false); goCategories(); } }, icon('grid'), h('span', {}, 'View All Categories')),
      navLink('help', 'Help & Support', 'help')),
    account ? h('button', { type: 'button', class: 'p-nav-link p-signout', onClick: signOut }, icon('signOut'), h('span', {}, 'Sign out')) : null);
  const scrim = h('div', { class: 'p-scrim', hidden: true, onClick: () => setSide(false) });
  function setSide(open) {
    side.classList.toggle('open', open);
    scrim.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    setChildren(menuBtn, icon(open ? 'close' : 'menu'));
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setSide(false); setUserMenu(false); } });
  document.addEventListener('pointerdown', (e) => {
    if (!userMenu.hidden && !e.target.closest('.p-user-wrap')) setUserMenu(false);
  });

  // ---------------------------------------------------------------- page area and footer
  const main = h('main', { class: 'p-main', tabindex: '-1' });
  const networkNotice = h('div', { class: 'c-network-notice', role: 'status', hidden: true },
    'You are offline. Previously loaded catalogue content remains available.');
  const updateNetworkNotice = () => { networkNotice.hidden = navigator.onLine; };
  window.addEventListener('offline', updateNetworkNotice);
  window.addEventListener('online', updateNetworkNotice);
  updateNetworkNotice();

  const footLink = (href, text) => h('a', { href }, text);
  const footer = h('footer', { class: 'p-footer' },
    h('div', { class: 'p-footer-inner' },
      brand('p-brand p-brand-foot', storeName, tagline),
      h('nav', { class: 'p-footer-links', 'aria-label': 'Footer' },
        footLink(pageUrl('help'), 'About Us'), footLink(pageUrl('help'), 'Contact'),
        footLink(pageUrl('help'), 'Terms & Conditions'), footLink(pageUrl('help'), 'Privacy Policy')),
      h('span', { class: 'p-copy' }, `© ${new Date().getFullYear()} ${storeName}. All rights reserved.`)));

  setChildren(root, h('div', { class: 'p-shell' },
    announceStrip,
    header,
    h('div', { class: 'p-body' }, side, h('div', { class: 'p-content' }, networkNotice, main)),
    footer,
    scrim));

  const requestUI = mountRequestUI({
    onHome: () => navigate('/catalog'),
    onProducts: () => goProducts(),
    onAccount: () => navigate(pageUrl(account ? 'balance' : 'settings')),
  });

  // ---------------------------------------------------------------- pages
  let showToken = 0;
  async function show(first = false) {
    const token = (showToken += 1);
    if (ACCOUNT_PAGES.includes(parsePath().name)) await loadCustomerData();   // fresh figures
    if (token !== showToken) return;   // the customer moved on while this loaded
    route = parsePath();
    current?.destroy();
    side.querySelectorAll('[data-page]').forEach((a) => {
      if (a.dataset.page === route.name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    requestUI.setTab(route.name === 'home' ? 'home' : route.name === 'products' ? 'products'
      : ['balance', 'orders', 'invoices', 'settings'].includes(route.name) ? 'account' : '');
    const page = h('div', { class: `c-page p-page-${route.name}${route.name === 'products' ? ' c-page-list' : ''}` });
    setChildren(main, page);
    if (route.name === 'detail') {
      current = mountDetail(page, route.id);
    } else if (route.name === 'products') {
      document.title = `Products — ${TITLE}`;
      current = mountList(page, { onChange: () => {} });
      // the list has its own search box; the header search stands in for it
      page.querySelector('.c-search')?.remove();
      searchInput.value = listState.search;
    } else if (route.name === 'home') {
      document.title = TITLE;
      current = mountHome(page);
    } else {
      current = PAGE_MOUNTS[route.name](page);
      document.title = `${page.querySelector('h1')?.textContent || 'Box for Less'} — ${TITLE}`;
    }
    setSide(false);
    setUserMenu(false);
    if (!first) main.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- actions
  const scrollPageTo = (top) => window.scrollTo({ top, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });

  function goProducts() {
    if (route.name !== 'products') navigate(pageUrl('products'));
    else scrollPageTo(0);
  }

  function goCategories() {
    showEverything();
    if (route.name !== 'products') navigate(pageUrl('products'));
    // wait for the list (and its category tiles) to be on screen before scrolling to them
    setTimeout(() => {
      const el = document.getElementById('shop-by-category');
      if (el) scrollPageTo(el.getBoundingClientRect().top + window.scrollY - 90);
    }, 200);
  }

  // "/" focuses the search, as on most sites — unless the person is already typing somewhere
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    searchInput.focus();
  });

  window.addEventListener('bfl:open-orders', () => navigate(pageUrl('orders')));
  window.addEventListener('bfl:open-balance', () => navigate(pageUrl('balance')));

  interceptLinks(document);
  onRouteChange(() => show());
  show(true);
}
