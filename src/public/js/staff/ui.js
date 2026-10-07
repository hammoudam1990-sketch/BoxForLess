// Small presentational pieces shared by the staff screens and the scanner.
import {
  html, Fragment, useState, useEffect, useRef, useCallback, createContext, useContext,
} from '../lib/react.js';
import { copyText } from '../lib/clipboard.js';

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------

const ToastContext = createContext(() => {});

/** `const toast = useToast(); toast('Saved', 'ok')` — kind is '', 'ok' or 'err'. */
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [state, setState] = useState({ msg: '', kind: '', visible: false });
  const timer = useRef(null);

  const show = useCallback((msg, kind = '') => {
    clearTimeout(timer.current);
    setState({ msg, kind, visible: true });
    timer.current = setTimeout(() => setState((s) => ({ ...s, visible: false })), 3200);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  return html`
    <${ToastContext.Provider} value=${show}>
      ${children}
      <div id="toast" class=${`toast ${state.kind}${state.visible ? '' : ' hidden'}`} role="status">${state.msg}</div>
    <//>`;
}

// ---------------------------------------------------------------------------
// pills
// ---------------------------------------------------------------------------

export const Pill = ({ tone = 'muted', children }) => html`<span class=${`pill ${tone}`}>${children}</span>`;

const STOCK = {
  IN_STOCK: ['ok', 'In stock'],
  LIMITED_STOCK: ['warn', 'Limited'],
  OUT_OF_STOCK: ['muted', 'Out of stock'],
};

export function StockPill({ status }) {
  const [tone, label] = STOCK[status] || ['muted', status || '—'];
  return html`<${Pill} tone=${tone}>${label}<//>`;
}

/** Stock state for a product row — an inactive product has no meaningful stock. */
export const ProductStatus = ({ product }) => (product.is_active
  ? html`<${StockPill} status=${product.stock_status} />`
  : html`<${Pill} tone="muted">Inactive<//>`);

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

export const Loading = () => html`<div class="card muted">Loading…</div>`;
export const ErrorCard = ({ error }) => html`<div class="card errbox">Error: ${error?.message || String(error)}</div>`;

/** Spreads the result of useAsync into Loading / ErrorCard / children(data). */
export function Async({ state, children }) {
  if (state.error) return html`<${ErrorCard} error=${state.error} />`;
  if (!state.data) return html`<${Loading} />`;
  return children(state.data);
}

// ---------------------------------------------------------------------------
// copy button
// ---------------------------------------------------------------------------

/**
 * Copies `text` (a string, or a function returning one) and says so on the button
 * itself, so there is visible feedback even over plain http.
 */
export function CopyButton({ text, class: cls = '', children }) {
  const [label, setLabel] = useState(null);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const click = async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text);
    setLabel(ok ? '✓ Copied' : 'Select it by hand');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setLabel(null), ok ? 1400 : 2500);
  };
  return html`<button type="button" class=${cls} onClick=${click}>${label ?? children}</button>`;
}

// ---------------------------------------------------------------------------
// hash navigation
// ---------------------------------------------------------------------------

export const goto = (hash) => { window.location.hash = hash; };

/** The two-column label / value block used on every detail page. */
export const KV = ({ rows }) => html`
  <div class="kv">
    ${rows.filter(Boolean).map(([k, v]) => html`<${KVRow} key=${k} k=${k} v=${v} />`)}
  </div>`;

function KVRow({ k, v }) {
  return html`<${Fragment}><div class="k">${k}</div><div>${v}</div><//>`;
}

// ---------------------------------------------------------------------------
// nav badges
// ---------------------------------------------------------------------------

/** Lets a page ask the nav to re-count pending reviews and access requests. */
export const RefreshBadgesContext = createContext(() => {});
export const useRefreshBadges = () => useContext(RefreshBadgesContext);
