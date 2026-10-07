// Customer-facing catalogue. Talks ONLY to /api/catalog, which returns customer-safe
// payloads — nothing in this bundle ever receives a price, a stock quantity or an
// internal id, so there is nothing here to hide.
//
// It must stay that way: do not import ../api.js (the staff client) or anything
// from ../staff/ here.
import { html, useState, useEffect, useCallback } from '../lib/react.js';
import { usePathname, parsePath, Link } from './router.js';
import { ListView, INITIAL_LIST } from './ListView.js';
import { DetailView } from './DetailView.js';
import { RequestUI } from './RequestUI.js';

const LIST_TITLE = 'Box for Less — Digital Product Catalog';

function Header() {
  return html`
    <header class="c-header">
      <div class="c-header-inner">
        <${Link} class="c-brand" href="/catalog">
          <span class="c-logo">BFL</span>
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

  // The list's filters live here, above the router, so opening a product and coming
  // back finds the list exactly as it was left.
  const [list, setList] = useState(INITIAL_LIST);
  const update = useCallback((patch) => setList((s) => ({ ...s, ...patch })), []);

  useEffect(() => {
    if (route.name === 'list') document.title = LIST_TITLE;
  }, [route.name]);

  return html`
    <${Header} />
    <main class="c-main" aria-live="polite">
      ${route.name === 'detail'
    ? html`<${DetailView} key=${route.id} id=${route.id} />`
    : html`<${ListView} state=${list} update=${update} />`}
    </main>
    <${RequestUI} />`;
}
