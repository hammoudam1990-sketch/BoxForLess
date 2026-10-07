// Staff shell: top bar, hash routing, and the nav badges.
import { html, Component, useState, useEffect, useCallback } from '../lib/react.js';
import { useHash } from '../lib/hooks.js';
import { api } from '../api.js';
import { ToastProvider, RefreshBadgesContext, ErrorCard, goto } from './ui.js';
import { ProductsPage, ProductDetailPage } from './pages/products.js';
import { ImportsPage, ImportDetailPage } from './pages/imports.js';
import { ChangesPage } from './pages/changes.js';
import { RequestsPage, RequestDetailPage } from './pages/requests.js';
import { AccessCodesPage, AccessRequestsPage } from './pages/access.js';

/** "#/products/123" -> { name: 'products', arg: '123' }. Empty hash is Product Master. */
export function parseHash(hash) {
  const [, name = 'products', arg] = (hash || '#/products').split('/');
  return { name, arg };
}

const ROUTES = {
  products: { nav: 'products', list: ProductsPage, detail: ProductDetailPage },
  imports: { nav: 'imports', list: ImportsPage, detail: ImportDetailPage },
  changes: { nav: 'changes', list: ChangesPage },
  requests: { nav: 'requests', list: RequestsPage, detail: RequestDetailPage },
  codes: { nav: 'codes', list: AccessCodesPage },
  access: { nav: 'access', list: AccessRequestsPage },
};

/** A page that throws while rendering shows an error card instead of a blank screen. */
class PageBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null, key: props.resetKey }; }

  static getDerivedStateFromError(error) { return { error }; }

  // moving to another page clears the error
  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  render() {
    return this.state.error ? html`<${ErrorCard} error=${this.state.error} />` : this.props.children;
  }
}

function Badge({ n }) {
  return html`<span class=${`badge${n ? '' : ' hidden'}`}>${n}</span>`;
}

function Nav({ active, badges }) {
  const link = (name, label, extra = null) => html`
    <a href=${`#/${name}`} class=${active === name ? 'active' : ''}>${label}${extra}</a>`;
  const signOut = async () => {
    await api.staffLogout();
    window.location.assign('/staff/login');
  };
  return html`
    <header class="topbar">
      <div class="brand">
        <span class="logo">BFL</span>
        <div>
          <div class="brand-title">Box for Less</div>
          <div class="brand-sub">Product Master · Phase 1</div>
        </div>
      </div>
      <nav class="mainnav">
        ${link('products', 'Product Master')}
        ${link('imports', 'Imports')}
        ${link('changes', 'Change Review ', html`<${Badge} n=${badges.review} />`)}
        ${link('requests', 'Requests')}
        ${link('codes', 'Access Codes')}
        ${link('access', 'Access Requests ', html`<${Badge} n=${badges.access} />`)}
        <a href="scan.html">📷 Scan</a>
        <button class="ghost" type="button" onClick=${signOut}>Sign out</button>
      </nav>
    </header>`;
}

export function App() {
  const hash = useHash();
  const { name, arg } = parseHash(hash);
  const route = ROUTES[name];
  const [badges, setBadges] = useState({ review: 0, access: 0 });

  // Companies waiting to be let in are shown in the nav so a request for access is
  // not missed — nobody thinks to open a screen that is usually empty.
  const refreshBadges = useCallback(async () => {
    const [review, access] = await Promise.all([
      api.reviews().then((r) => r.counts?.total || 0).catch(() => null),
      api.accessRequests('PENDING').then((r) => r.total || 0).catch(() => null),
    ]);
    setBadges((b) => ({ review: review ?? b.review, access: access ?? b.access }));
  }, []);

  // like the old router, re-count on every navigation
  useEffect(() => { refreshBadges(); }, [hash, refreshBadges]);
  useEffect(() => { if (!route) goto('#/products'); }, [route]);

  const Page = route && (arg && route.detail ? route.detail : route.list);

  return html`
    <${ToastProvider}>
      <${RefreshBadgesContext.Provider} value=${refreshBadges}>
        <${Nav} active=${route?.nav} badges=${badges} />
        <main class="view">
          <${PageBoundary} resetKey=${hash}>
            ${Page ? html`<${Page} key=${hash} id=${arg} />` : null}
          <//>
        </main>
      <//>
    <//>`;
}
