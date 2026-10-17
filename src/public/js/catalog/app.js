// The customer catalogue: header, phone menu, the page in the middle, and the tab bar.
//
// Talks ONLY to /api/catalog, which returns customer-safe payloads — nothing here ever
// receives a price, a stock quantity or an internal id, so there is nothing to hide.
// It must stay that way: do not import ../api.js (the staff client) here.
import { h, setChildren, svg, toggleHidden } from '../lib/dom.js';
import { hideHeaderOnScroll } from '../lib/util.js';
import { navigate, onRouteChange, parsePath, interceptLinks } from './router.js';
import { mountList, showEverything, listTab } from './list.js';
import { mountDetail } from './detail.js';
import { mountRequestUI } from './request.js';
import { mountSlideshow } from './slideshow.js';
import { REQUEST_LABELS } from './labels.js';

const LIST_TITLE = 'Box for Less — Digital Product Catalog';

// Plain line icons for the header and the phone menu (decorative: every control has a text label).
const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  home: 'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3.5 7.7 12 12l8.5-4.3M12 12v9',
  request: 'M7 3h10a1 1 0 0 1 1 1v17l-3.5-2-2.5 2-2.5-2L6 21V4a1 1 0 0 1 1-1zM9.5 8h5M9.5 12h5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  print: 'M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2M7 14h10v6H7z',
  staff: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
};
const icon = (name) => svg(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${PATHS[name]}"/></svg>`);
const brandMark = () => svg(`<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <path d="M16 2.5 29 9.3v13.4L16 30.5 3 22.7V9.3L16 2.5Z" fill="currentColor"/>
  <path d="m3.5 9.5 12.5 7 12.5-7M16 16.5V30" fill="none" stroke="#0b2b4b" stroke-width="2.1" stroke-linejoin="round"/>
  <path d="m9.5 6 12.7 7" fill="none" stroke="#0b2b4b" stroke-width="2.1" stroke-linecap="round"/>
</svg>`);

/** Start the catalogue in `root`. */
export function startCatalog(root) {
  let current = null;        // the page on screen: { destroy }
  let route = parsePath();

  // ---------------------------------------------------------------- header and menu
  const menuBtn = h('button', {
    type: 'button', class: 'c-icon-btn c-menu-btn', 'aria-label': 'Open menu',
    'aria-expanded': 'false', 'aria-controls': 'siteMenu', 'aria-haspopup': 'menu',
    onClick: () => setMenu(menu.classList.contains('hidden')),
  }, icon('menu'));

  const themeLabel = h('span', {}, 'Dark mode');
  const item = (name, label, fn) => h('button', {
    type: 'button', class: 'c-menu-item', role: 'menuitem', onClick: () => { setMenu(false); fn(); },
  }, icon(name), label);
  const menu = h('div', { class: 'c-menu hidden', id: 'siteMenu', role: 'menu' },
    item('home', 'Shop', () => goHome()),
    item('grid', 'Categories', () => goCategories()),
    item('search', 'Search products', () => focusSearch()),
    item('request', REQUEST_LABELS.name, () => requestUI.open()),
    h('hr'),
    item('moon', themeLabel, () => window.bflTheme && window.bflTheme.toggle()),
    item('print', 'Print this page', () => window.print()),
    h('a', { href: '/login.html', role: 'menuitem' }, icon('staff'), 'Sign in'));

  function setMenu(open) {
    toggleHidden(menu, !open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    setChildren(menuBtn, icon(open ? 'close' : 'menu'));
    if (open) themeLabel.textContent = window.bflTheme && window.bflTheme.isDark() ? 'Light mode' : 'Dark mode';
  }
  // the menu closes on Escape and on a click anywhere outside it
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setMenu(false); });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !e.target.closest('.c-menu-btn')) setMenu(false);
  });

  const headerSearch = h('div', { class: 'c-header-search' });
  const requestHeaderBadge = h('span', { class: 'c-header-request-badge', hidden: true });
  const requestHeaderBtn = h('button', {
    type: 'button', class: 'c-header-request', 'aria-label': REQUEST_LABELS.name,
    onClick: () => window.dispatchEvent(new Event('bfl:open-request')),
  }, icon('request'), requestHeaderBadge, h('span', { class: 'c-header-request-label' }, REQUEST_LABELS.name));
  const accountLink = h('a', { class: 'c-header-account', href: '/login.html', 'aria-label': 'Sign in' },
    icon('staff'), h('span', {}, 'Sign in'));
  const header = h('header', { class: 'c-header' },
    h('div', { class: 'c-header-inner' },
      h('a', { class: 'c-brand', href: '/catalog' },
        h('span', { class: 'c-logo' }, brandMark()),
        h('span', { class: 'c-brand-text' },
          h('span', { class: 'c-brand-title' }, 'Box for Less'),
          h('span', { class: 'c-brand-sub' }, 'Bigger boxes. Better value.'))),
      headerSearch,
      h('div', { class: 'c-header-actions' },
        requestHeaderBtn,
        accountLink,
        menuBtn,
        menu)));
  hideHeaderOnScroll(header);

  const navButton = (name, label, onClick) => h('button', {
    type: 'button', class: 'c-side-link', onClick,
  }, icon(name), h('span', {}, label));
  const homeNav = navButton('home', 'Home', () => goHome());
  homeNav.setAttribute('aria-current', 'page');
  const productsNav = navButton('box', 'Products', () => focusSearch());
  const categoriesNav = navButton('grid', 'View all categories', () => goCategories());
  const requestSideBadge = h('span', { class: 'c-side-request-badge', hidden: true });
  const requestNav = h('button', {
    type: 'button', class: 'c-side-link c-side-request', 'aria-label': REQUEST_LABELS.name,
    onClick: () => window.dispatchEvent(new Event('bfl:open-request')),
  }, icon('request'), h('span', {}, REQUEST_LABELS.name), requestSideBadge);
  const accountSideLink = h('a', { class: 'c-side-link', href: '/login.html', 'aria-label': 'Sign in' },
    icon('staff'), h('span', {}, 'Sign in'));
  const sidebar = h('aside', { class: 'c-sidebar', 'aria-label': 'Shop navigation' },
    h('nav', { class: 'c-side-nav' }, homeNav, productsNav, requestNav, categoriesNav, accountSideLink));

  const main = h('main', { class: 'c-main', tabindex: '-1' });
  const hero = h('section', { class: 'c-shop-hero', 'aria-labelledby': 'shop-hero-title' },
    h('div', { class: 'c-shop-hero-copy' },
      h('p', { class: 'c-shop-eyebrow' }, 'WELCOME TO BOX FOR LESS'),
      h('h1', { id: 'shop-hero-title' }, 'Your Trusted Wholesale Partner'),
      h('p', {}, 'Quality products for your business, delivered reliably.'),
      h('div', { class: 'c-shop-hero-actions' },
        h('button', { type: 'button', class: 'c-hero-button', onClick: () => focusSearch() }, 'View Products', icon('search')),
        h('button', { type: 'button', class: 'c-hero-link', onClick: () => goCategories() }, 'View categories'))),
    h('div', { class: 'c-slideshow-slot' }));
  const slideshow = mountSlideshow(hero.querySelector('.c-slideshow-slot'));
  const quickAction = (name, title, detail, onClick) => h('button', {
    type: 'button', class: 'c-quick-action', onClick,
  }, icon(name), h('span', {}, h('strong', {}, title), h('small', {}, detail)));
  const guide = h('aside', { class: 'c-shop-guide', 'aria-label': 'Quick actions' },
    h('p', { class: 'c-guide-eyebrow' }, 'HERE TO HELP'),
    h('h2', {}, 'Quick actions'),
    h('div', { class: 'c-quick-actions' },
      quickAction('box', 'Browse products', 'Find items for your business.', () => focusSearch()),
      quickAction('grid', 'View categories', 'Explore the catalogue by category.', () => goCategories()),
      quickAction('request', REQUEST_LABELS.name, 'Review the items you selected.', () => window.dispatchEvent(new Event('bfl:open-request')))));
  const primary = h('div', { class: 'c-shop-primary' }, hero, main);
  const workspace = h('div', { class: 'c-shop-workspace' }, primary, guide);
  const networkNotice = h('div', {
    class: 'c-network-notice', role: 'status', hidden: true,
  }, 'You are offline. Previously loaded catalog content remains available.');
  const updateNetworkNotice = () => { networkNotice.hidden = navigator.onLine; };
  window.addEventListener('offline', updateNetworkNotice);
  window.addEventListener('online', updateNetworkNotice);
  updateNetworkNotice();
  const content = h('div', { class: 'c-content' }, networkNotice, workspace);
  const footer = h('footer', { class: 'c-shop-footer' },
    h('div', { class: 'c-footer-brand' },
      h('span', { class: 'c-footer-logo' }, brandMark()),
      h('span', {}, h('strong', {}, 'Box for Less'), h('small', {}, 'Bigger boxes. Better value.'))),
    h('span', { class: 'c-footer-copy' }, `© ${new Date().getFullYear()} Box for Less · Wholesale product catalogue`));
  setChildren(root, h('div', { class: 'c-app-shell' }, header, sidebar, content, footer));

  const requestUI = mountRequestUI({ onHome: () => goHome(), onCategories: () => goCategories() });
  const syncTab = () => {
    const tab = route.name === 'list' ? listTab() : '';
    requestUI.setTab(tab);
    homeNav.toggleAttribute('aria-current', tab === 'home');
    categoriesNav.toggleAttribute('aria-current', tab === 'categories');
    productsNav.toggleAttribute('aria-current', false);
  };

  // ---------------------------------------------------------------- pages
  function show(first = false) {
    route = parsePath();
    headerSearch.replaceChildren();
    current?.destroy();
    const isList = route.name !== 'detail';
    hero.classList.toggle('hidden', !isList);
    guide.classList.toggle('hidden', !isList);
    workspace.classList.toggle('c-detail-workspace', !isList);
    slideshow.setActive(isList);
    // a fresh wrapper each time, so the page's rise-in animation plays again
    const page = h('div', { class: `c-page${route.name === 'list' ? ' c-page-list' : ''}` });
    setChildren(main, page);
    if (route.name === 'detail') {
      current = mountDetail(page, route.id);
    } else {
      document.title = LIST_TITLE;
      current = mountList(page, { onChange: syncTab });
      const search = page.querySelector('.c-search');
      if (search) headerSearch.append(search);
    }
    syncTab();
    setMenu(false);
    // After moving between the list and a product, put keyboard and screen-reader focus at the
    // top of the new content. Not on the first load, which would steal focus.
    if (!first) main.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- actions
  // Home and Categories both clear the filters; Home goes to the top, Categories to the tiles.
  function scrollPageTo(top) {
    const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    window.scrollTo({ top, behavior });
  }

  function goHome() {
    showEverything();
    if (route.name === 'list') scrollPageTo(0);
    else navigate('/catalog');
  }

  function goCategories() {
    showEverything();
    if (route.name !== 'list') navigate('/catalog');
    // wait for the list (and its tiles) to be on screen before scrolling to them
    setTimeout(() => {
      const el = document.getElementById('shop-by-category');
      if (el) scrollPageTo(el.getBoundingClientRect().top + window.scrollY - 76);
    }, 120);
  }

  // Search: jump to the product search field (going to the list first if a product is open).
  function focusSearch() {
    if (parsePath().name !== 'list') navigate('/catalog');
    setTimeout(() => {
      const input = document.querySelector('.c-search input');
      if (!input) return;
      scrollPageTo(0);
      input.focus();
    }, 160);
  }

  // "/" focuses the search, as on most sites — unless the person is already typing somewhere
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    focusSearch();
  });

  interceptLinks(document);
  onRouteChange(() => show());
  show(true);
}
