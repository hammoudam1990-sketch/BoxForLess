// Customer-facing catalogue. Talks ONLY to /api/catalog, which returns customer-safe
// payloads — nothing in this bundle ever receives a price, a stock quantity or an
// internal id, so there is nothing here to hide.
//
// It must stay that way: do not import ../api.js (the staff client) or anything
// from ../staff/ here.
import { html, useState, useEffect, useCallback, useRef } from '../lib/react.js';
import { useHideOnScroll } from '../lib/hooks.js';
import { usePathname, parsePath, navigate, Link } from './router.js';
import { ListView, INITIAL_LIST } from './ListView.js';
import { DetailView } from './DetailView.js';
import { RequestUI } from './RequestUI.js';

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
const Icon = ({ name }) => html`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d=${PATHS[name]} /></svg>`;

/** The phone menu: a dropdown from the header with the same places as the tab bar, plus search,
 *  the theme, staff sign-in and print. Closes on a choice, on Escape and on a click outside. */
function Menu({ onClose, actions }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target) && !e.target.closest('.c-menu-btn')) onClose(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [onClose]);
  const dark = window.bflTheme ? window.bflTheme.isDark() : false;
  const item = (icon, label, fn) => html`
    <button type="button" class="c-menu-item" role="menuitem" onClick=${() => { onClose(); fn(); }}><${Icon} name=${icon} />${label}</button>`;
  return html`
    <div class="c-menu" id="siteMenu" role="menu" ref=${ref}>
      ${item('home', 'Home', actions.home)}
      ${item('grid', 'Categories', actions.categories)}
      ${item('search', 'Search products', actions.search)}
      ${item('request', 'My request', actions.request)}
      <hr />
      ${item('moon', dark ? 'Light mode' : 'Dark mode', actions.theme)}
      ${item('print', 'Print this page', actions.print)}
      <a href="/staff/login" role="menuitem"><${Icon} name="staff" />Staff sign-in</a>
    </div>`;
}

function Header({ hidden, actions }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  return html`
    <header class=${`c-header${hidden ? ' c-header-hidden' : ''}`}>
      <div class="c-header-inner">
        <${Link} class="c-brand" href="/catalog">
          <span class="c-logo" role="img" aria-label="Box for Less">BFL</span>
          <span class="c-brand-text">
            <span class="c-brand-title">Box for Less</span>
            <span class="c-brand-sub">Digital Product Catalog</span>
          </span>
        <//>
        <div class="c-header-actions">
          <button type="button" class="c-icon-btn c-search-btn" aria-label="Search products" title="Search products ( / )" onClick=${actions.search}>
            <${Icon} name="search" />
          </button>
          <button type="button" class="c-icon-btn c-menu-btn" aria-label=${menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded=${menuOpen} aria-controls="siteMenu" aria-haspopup="menu" onClick=${() => setMenuOpen((o) => !o)}>
            <${Icon} name=${menuOpen ? 'close' : 'menu'} />
          </button>
          ${menuOpen ? html`<${Menu} onClose=${closeMenu} actions=${actions} />` : null}
        </div>
      </div>
    </header>`;
}

export function App() {
  const route = parsePath(usePathname());
  const headerHidden = useHideOnScroll();

  // The list's filters live here, above the router, so opening a product and coming
  // back finds the list exactly as it was left.
  const [list, setList] = useState(INITIAL_LIST);
  const update = useCallback((patch) => setList((s) => ({ ...s, ...patch })), []);

  useEffect(() => {
    if (route.name === 'list') document.title = LIST_TITLE;
  }, [route.name]);

  // After moving between the list and a product, put keyboard and screen-reader focus
  // at the top of the new content. Not on the first load, which would steal focus.
  const mainRef = useRef(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    mainRef.current?.focus({ preventScroll: true });
  }, [route.name, route.id]);

  // Home and Categories both clear the filters; Home goes to the top, Categories to the tiles.
  const reset = { search: '', topLevel: '', categoryPath: '', offset: 0 };
  const goHome = () => {
    update(reset);
    if (route.name === 'list') window.scrollTo({ top: 0, behavior: 'smooth' });
    else navigate('/catalog');
  };
  const goCategories = () => {
    update(reset);
    if (route.name !== 'list') navigate('/catalog');
    // wait for the list (and its tiles) to be on screen before scrolling to them
    setTimeout(() => {
      const el = document.getElementById('shop-by-category');
      if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76, behavior: 'smooth' });
    }, 120);
  };
  // Search: jump to the product search field (going to the list first if a product is open).
  const focusSearch = useCallback(() => {
    if (parsePath(window.location.pathname).name !== 'list') navigate('/catalog');
    setTimeout(() => {
      const input = document.querySelector('.c-search input');
      if (!input) return;
      window.scrollTo({ top: 0, behavior: 'smooth' });
      input.focus();
    }, 160);
  }, []);
  // "/" focuses the search, as on most sites — unless the person is already typing somewhere
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      focusSearch();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [focusSearch]);

  const menuActions = {
    home: goHome,
    categories: goCategories,
    search: focusSearch,
    request: () => window.dispatchEvent(new CustomEvent('bfl:open-request')),
    theme: () => window.bflTheme && window.bflTheme.toggle(),
    print: () => window.print(),
  };

  const tab = route.name !== 'list' ? '' : (list.topLevel ? 'categories' : 'home');

  return html`
    <${Header} hidden=${headerHidden} actions=${menuActions} />
    <main class="c-main" ref=${mainRef} tabIndex="-1">
      <div class=${`c-page${route.name === 'detail' ? '' : ' c-page-list'}`} key=${route.name === 'detail' ? route.id : 'list'}>
        ${route.name === 'detail'
    ? html`<${DetailView} id=${route.id} />`
    : html`<${ListView} state=${list} update=${update} />`}
      </div>
    </main>
    <${RequestUI} tab=${tab} onHome=${goHome} onCategories=${goCategories} />`;
}
