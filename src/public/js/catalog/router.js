// Routing for the catalogue.
//
//   /catalog                    home (welcome banner, featured products, account column)
//   /catalog?p=products         the full product list with search and filters
//   /catalog?p=orders|balance|invoices|settings|help|brands
//   /catalog/product/:id        one product
//
// The server hands every /catalog URL the same page, so the path and ?p= are what the browser
// reads. Links inside the catalogue move with history.pushState, which keeps navigation to one
// page load on a phone and lets the list keep its filters while a product is open.

const listeners = new Set();
export const PAGES = ['products', 'orders', 'balance', 'invoices', 'settings', 'help', 'brands'];

/** Move to an in-app URL without reloading the page. */
export function navigate(href) {
  window.history.pushState({}, '', href);
  window.scrollTo(0, 0);
  listeners.forEach((fn) => fn());
}

/** Run `fn` whenever the route changes, by a link or by the browser's back / forward. */
export function onRouteChange(fn) {
  listeners.add(fn);
  window.addEventListener('popstate', fn);
  return () => { listeners.delete(fn); window.removeEventListener('popstate', fn); };
}

/** The current route: { name: 'detail', id } | { name: 'home' } | { name: <one of PAGES> }. */
export function parsePath(pathname = window.location.pathname, search = window.location.search) {
  const m = pathname.match(/^\/catalog\/product\/(.+)$/);
  if (m) return { name: 'detail', id: decodeURIComponent(m[1]) };
  const page = new URLSearchParams(search).get('p');
  return { name: PAGES.includes(page) ? page : 'home' };
}

/** The URL of a page: pageUrl('orders') -> '/catalog?p=orders'; pageUrl('home') -> '/catalog'. */
export const pageUrl = (name) => (name === 'home' ? '/catalog' : `/catalog?p=${name}`);

/**
 * Make every ordinary click on a catalogue link (<a href="/catalog…">) navigate in place.
 * A click with a modifier key, a middle click or a link with a target still opens normally.
 */
export function interceptLinks(root = document) {
  root.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target || a.hasAttribute('download')) return;
    const url = new URL(a.href, window.location.href);
    if (url.origin !== window.location.origin || !/^\/catalog(\/|$)/.test(url.pathname)) return;
    e.preventDefault();
    navigate(url.pathname + url.search);
  });
}
