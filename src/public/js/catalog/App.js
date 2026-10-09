// Customer-facing catalogue. Talks ONLY to /api/catalog, which returns customer-safe
// payloads — nothing in this bundle ever receives a price, a stock quantity or an
// internal id, so there is nothing here to hide.
//
// It must stay that way: do not import ../api.js (the staff client) or anything
// from ../staff/ here.
import { html, useState, useEffect, useCallback, useRef } from '../lib/react.js';
import { useHideOnScroll } from '../lib/hooks.js';
import { usePathname, parsePath, Link } from './router.js';
import { ListView, INITIAL_LIST } from './ListView.js';
import { DetailView } from './DetailView.js';
import { RequestUI } from './RequestUI.js';

const LIST_TITLE = 'Box for Less — Digital Product Catalog';

function Header({ hidden }) {
  return html`
    <header class=${`c-header${hidden ? ' c-header-hidden' : ''}`}>
      <div class="c-header-inner">
        <${Link} class="c-brand" href="/catalog">
          <span class="c-logo" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <path d="M8 17.5 24 9l16 8.5v18L24 44l-16-8.5v-18Z" />
              <path d="m8.5 18 15.5 8 15.5-8M24 26v17M18 12.2l16 8.4v7.2" />
              <path class="c-logo-accent" d="M18 12.2v7.2" />
            </svg>
          </span>
          <span class="c-brand-text">
            <span class="c-brand-title">Box for Less</span>
            <span class="c-brand-sub">Digital Product Catalog</span>
          </span>
        <//>
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

  return html`
    <${Header} hidden=${headerHidden} />
    <main class="c-main" ref=${mainRef} tabIndex="-1">
      <div class="c-page" key=${route.name === 'detail' ? route.id : 'list'}>
        ${route.name === 'detail'
    ? html`<${DetailView} id=${route.id} />`
    : html`<${ListView} state=${list} update=${update} />`}
      </div>
    </main>
    <${RequestUI} />`;
}
