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

const LIST_TITLE = 'Box for Less — Digital Product Catalog';

// Plain line icons for the header and the phone menu (decorative: every control has a text label).
const PATHS = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6L6 18',
  home: 'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  request: 'M7 3h10a1 1 0 0 1 1 1v17l-3.5-2-2.5 2-2.5-2L6 21V4a1 1 0 0 1 1-1zM9.5 8h5M9.5 12h5',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  print: 'M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v5a1 1 0 0 1-1 1h-2M7 14h10v6H7z',
  staff: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
};
const icon = (name) => svg(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${PATHS[name]}"/></svg>`);

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
    item('home', 'Home', () => goHome()),
    item('grid', 'Categories', () => goCategories()),
    item('search', 'Search products', () => focusSearch()),
    item('request', 'My request', () => requestUI.open()),
    h('hr'),
    item('moon', themeLabel, () => window.bflTheme && window.bflTheme.toggle()),
    item('print', 'Print this page', () => window.print()),
    h('a', { href: '/staff/login', role: 'menuitem' }, icon('staff'), 'Staff sign-in'));

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

  const header = h('header', { class: 'c-header' },
    h('div', { class: 'c-header-inner' },
      h('a', { class: 'c-brand', href: '/catalog' },
        h('span', { class: 'c-logo', role: 'img', 'aria-label': 'Box for Less' }, 'BFL'),
        h('span', { class: 'c-brand-text' },
          h('span', { class: 'c-brand-title' }, 'Box for Less'),
          h('span', { class: 'c-brand-sub' }, 'Digital Product Catalog'))),
      h('div', { class: 'c-header-actions' },
        h('button', {
          type: 'button', class: 'c-icon-btn c-search-btn', 'aria-label': 'Search products',
          title: 'Search products ( / )', onClick: () => focusSearch(),
        }, icon('search')),
        menuBtn,
        menu)));
  hideHeaderOnScroll(header);

  const main = h('main', { class: 'c-main', tabindex: '-1' });
  setChildren(root, header, main);

  const requestUI = mountRequestUI({ onHome: () => goHome(), onCategories: () => goCategories() });
  const syncTab = () => requestUI.setTab(route.name === 'list' ? listTab() : '');

  // ---------------------------------------------------------------- pages
  function show(first = false) {
    route = parsePath();
    current?.destroy();
    // a fresh wrapper each time, so the page's rise-in animation plays again
    const page = h('div', { class: `c-page${route.name === 'list' ? ' c-page-list' : ''}` });
    setChildren(main, page);
    if (route.name === 'detail') {
      current = mountDetail(page, route.id);
    } else {
      document.title = LIST_TITLE;
      current = mountList(page, { onChange: syncTab });
    }
    syncTab();
    setMenu(false);
    // After moving between the list and a product, put keyboard and screen-reader focus at the
    // top of the new content. Not on the first load, which would steal focus.
    if (!first) main.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- actions
  // Home and Categories both clear the filters; Home goes to the top, Categories to the tiles.
  function goHome() {
    showEverything();
    if (route.name === 'list') window.scrollTo({ top: 0, behavior: 'smooth' });
    else navigate('/catalog');
  }

  function goCategories() {
    showEverything();
    if (route.name !== 'list') navigate('/catalog');
    // wait for the list (and its tiles) to be on screen before scrolling to them
    setTimeout(() => {
      const el = document.getElementById('shop-by-category');
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76, behavior: 'smooth' });
    }, 120);
  }

  // Search: jump to the product search field (going to the list first if a product is open).
  function focusSearch() {
    if (parsePath().name !== 'list') navigate('/catalog');
    setTimeout(() => {
      const input = document.querySelector('.c-search input');
      if (!input) return;
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
