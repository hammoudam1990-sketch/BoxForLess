// Routing for the catalogue: /catalog (list) and /catalog/product/:id (detail).
//
// The server hands both URLs the same shell, so the path is what the client reads.
// In-app links go through history.pushState, which keeps navigation a single page
// load on a phone and lets the list keep its filters while a product is open.
import { html, useState, useEffect } from '../lib/react.js';

const listeners = new Set();

/** Move to an in-app URL without reloading the page. */
export function navigate(href) {
  window.history.pushState({}, '', href);
  window.scrollTo(0, 0);
  listeners.forEach((fn) => fn());
}

/** The current pathname; re-renders on navigate() and on the browser's back/forward. */
export function usePathname() {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    listeners.add(sync);
    window.addEventListener('popstate', sync);
    return () => { listeners.delete(sync); window.removeEventListener('popstate', sync); };
  }, []);
  return path;
}

/** "/catalog/product/123" -> { name: 'detail', id: '123' }; anything else is the list. */
export function parsePath(pathname) {
  const m = pathname.match(/^\/catalog\/product\/(.+)$/);
  return m ? { name: 'detail', id: decodeURIComponent(m[1]) } : { name: 'list' };
}

/** An ordinary <a href> that navigates in place unless the user asked for a new tab. */
export function Link({ href, children, ...rest }) {
  const onClick = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || rest.target) return;
    e.preventDefault();
    navigate(href);
  };
  return html`<a href=${href} onClick=${onClick} ...${rest}>${children}</a>`;
}
