// Routing for the catalogue: /catalog (list) and /catalog/product/:id (detail).
//
// The server hands both URLs the same page, so the path is what the browser reads. Links
// inside the catalogue move with history.pushState, which keeps navigation to one page load
// on a phone and lets the list keep its filters while a product is open.

const listeners = new Set();

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

/** "/catalog/product/123" -> { name: 'detail', id: '123' }; anything else is the list. */
export function parsePath(pathname = window.location.pathname) {
  const m = pathname.match(/^\/catalog\/product\/(.+)$/);
  return m ? { name: 'detail', id: decodeURIComponent(m[1]) } : { name: 'list' };
}

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
