// Routing for the catalogue: /catalog (list) and /catalog/product/:id (detail).
//
// The server hands both URLs the same shell, so the path is what the client reads. In-app
// links go through history.pushState, which keeps navigation a single page load on a phone
// and lets the list keep its filters while a product is open.
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

/** "/catalog/product/123" -> { name: 'detail', id: '123' }; anything else is the list. */
export function parsePath(pathname) {
  const m = pathname.match(/^\/catalog\/product\/(.+)$/);
  return m ? { name: 'detail', id: decodeURIComponent(m[1]) } : { name: 'list' };
}

export const currentRoute = () => parsePath(window.location.pathname);

/** Move to an in-app URL without reloading the page. */
export function navigate(href) {
  window.history.pushState({}, '', href);
  window.scrollTo(0, 0);
  notify();
}

/** Call `fn` after navigate() and after the browser's back / forward. */
export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Plain <a href="/catalog…"> links navigate in place, unless the person asked for a new tab
 * (modifier keys, middle click, target=_blank). Installed once; it covers every link on the
 * page, including the ones created later.
 */
export function installRouter() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href^="/catalog"]');
    if (!a || a.target) return;
    e.preventDefault();
    navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', notify);
}
