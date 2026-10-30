// Request cart UI: the bottom tab bar, the desktop request button, the review drawer,
// and submission.
//
// Everything here is presentation. No availability arithmetic happens in the browser: the
// server validates every line at submission and its verdict is what the customer is shown.
//
// How it stays typeable: every field in the drawer (access code, the "no code" form, the
// address, the notes) is built ONCE and only shown or hidden. Nothing that holds a field is
// ever rebuilt while someone might be typing in it.
import { h, setChildren, svg, toggleHidden } from '../lib/dom.js';
import { readCart, onCartChange, removeFromCart, clearCart, toRequestLines, pruneUnavailable } from '../cart.js';
import { debounce } from '../lib/util.js';
import { getJSON, postJSON } from './http.js';
import { createQtyStepper } from './qty.js';
import { onPrices, wantPrice, formatPrice, setSession, priceSession, lineValue, refreshOffers } from './prices.js';
import { REQUEST_LABELS } from './labels.js';

// Plain line icons, one stroke weight, hidden from assistive tech (each tab has a text label).
const ICONS = {
  home: 'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  request: 'M3 4h2.2l2.3 11h10.8l2-8H6.4M9.5 19.5h.01M17 19.5h.01',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3.5 7.7 12 12l8.5-4.3M12 12v9',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
};
const icon = (name) => svg(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"/></svg>`);

const cartons = (lines) => lines.reduce((n, l) => n + l.quantityCtn, 0);

/** A labelled field: <div class="c-field"><label/>control hint</div>. */
function field(id, label, control, ...hint) {
  return h('div', { class: 'c-field' }, h('label', { for: id }, label), control, ...hint);
}

/**
 * Build the tab bar (Home, Request Return, Cart, Account), the floating cart button and the drawer.
 * Returns { setTab(tab), open() }. `tab` is 'home', 'products', 'return-requests', 'account' or ''.
 */
export function mountRequestUI({ onHome, onReturnRequests, onAccount }) {
  const drawer = createDrawer();
  const headerRequestButton = document.querySelector('.c-header-request');
  const headerRequestBadge = headerRequestButton?.querySelector('.c-header-request-badge');
  const sideRequestButton = document.querySelector('.c-side-request');
  const sideRequestBadge = sideRequestButton?.querySelector('.c-side-request-badge');

  // ---- the tab bar (phones) ----
  const homeTab = h('button', { type: 'button', class: 'c-tab', onClick: onHome }, icon('home'), h('span', {}, 'Home'));
  const returnTab = h('button', {
    type: 'button', class: 'c-tab', 'aria-label': 'Request a Return', onClick: onReturnRequests,
  }, icon('box'), h('span', {}, 'Request Return'));
  const accountTab = h('button', { type: 'button', class: 'c-tab', onClick: onAccount }, icon('user'), h('span', {}, 'Account'));
  const tabIcon = h('span', { class: 'c-tab-icon' }, icon('request'));
  const requestTab = h('button', {
    type: 'button', class: 'c-tab', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: () => drawer.open(),
  }, tabIcon, h('span', {}, REQUEST_LABELS.tab));
  const tabbar = h('nav', { class: 'c-tabbar', 'aria-label': 'Shop navigation' }, homeTab, returnTab, requestTab, accountTab);

  // ---- the floating button (wider screens) ----
  const fab = h('button', { type: 'button', class: 'c-request-fab', 'aria-haspopup': 'dialog', onClick: () => drawer.open() },
    icon('request'), h('span', {}, REQUEST_LABELS.name));

  document.body.append(tabbar, fab, drawer.el);

  // The carton count on both buttons. The tab's badge is a fresh element each time the count
  // changes, so its little pop animation plays again.
  let tabBadge = null;
  let fabBadge = null;
  const showCount = (lines) => {
    const n = cartons(lines);
    const label = `${n} cartons in your request`;
    if (headerRequestButton) headerRequestButton.setAttribute('aria-label', n ? label : REQUEST_LABELS.name);
    if (sideRequestButton) sideRequestButton.setAttribute('aria-label', n ? label : REQUEST_LABELS.name);
    if (headerRequestBadge) {
      headerRequestBadge.textContent = n ? String(n) : '';
      headerRequestBadge.hidden = !n;
    }
    if (sideRequestBadge) {
      sideRequestBadge.textContent = n ? String(n) : '';
      sideRequestBadge.hidden = !n;
    }
    tabBadge?.remove(); tabBadge = null;
    fabBadge?.remove(); fabBadge = null;
    if (!n) return;
    tabBadge = h('span', { class: 'c-tab-badge', role: 'status', 'aria-label': label }, n);
    fabBadge = h('span', { class: 'c-tab-badge', 'aria-label': label }, n);
    tabIcon.append(tabBadge);
    fab.append(fabBadge);
  };
  showCount(readCart());
  onCartChange(showCount);

  drawer.onOpenChange((isOpen) => requestTab.setAttribute('aria-expanded', String(isOpen)));
  // the phone menu's "My request" asks for the drawer through this event
  window.addEventListener('bfl:open-request', () => drawer.open());

  return {
    setTab(tab) {
      for (const [button, name] of [[homeTab, 'home'], [returnTab, 'return-requests'], [accountTab, 'account']]) {
        if (tab === name) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
    },
    open: () => drawer.open(),
  };
}

function createDrawer() {
  // ---- what the server says ----
  let canSubmit = true;
  let blocked = null;
  // Who the server says we are, from the access-code session — NOT a choice made in the
  // browser. The code identifies the customer, so the catalogue can stay public without
  // exposing the customer list.
  let customer = null;        // { name, deliveryAddress } | null
  let customerKey = '';

  // ---- what the customer is doing ----
  let isOpen = false;
  let submitting = false;
  let lineErrors = {};
  // Shelf life (W3): a customer with a minimum shelf life is warned about any product that would
  // be filled with shorter-dated stock, and must accept it or remove the product. The server checks
  // again at submission; this is only so they can see and answer it.
  let creditProblem = '';            // the message when this request would go over available credit
  let shelfWarnings = {};            // barcode -> { message }
  const accepted = new Set();        // barcodes ticked "I accept this shorter shelf life"
  let opener = null;
  const openListeners = new Set();

  // ---------------------------------------------------------------- the parts
  const backdrop = h('div', { class: 'c-drawer-backdrop', onClick: () => close() });

  const blockedEl = h('div', { class: 'c-blocked hidden' });
  const noticeEl = h('div', { class: 'c-notice hidden' });
  const linesEl = h('div', { class: 'c-lines' });

  // Not signed in: the drawer does not ask for anything here. Signing in happens on the sign-in page
  // (customer ID + password); the cart is kept in the browser, so it is still here when they return.
  const signInBlock = h('div', { class: 'c-signin-prompt' },
    h('p', { class: 'c-hint' }, 'Sign in with your customer ID and password to send your request.'),
    h('a', { class: 'c-btn primary', href: '/', onClick: (e) => { e.preventDefault(); window.location.assign(`/?next=${encodeURIComponent(window.location.pathname)}`); } }, 'Sign in'),
    h('a', { class: 'c-link', href: '/signup' }, 'New here? Register as a customer'));

  // Signed in. The company name is the confirmation that the right account is being used, so it is
  // the largest thing in the panel.
  const customerName = h('div', { class: 'c-selected-name' });
  const addressInput = h('textarea', { id: 'reqAddress', rows: '3', autocomplete: 'street-address', placeholder: 'Where should we deliver?' });
  const addressHint = h('div', { class: 'c-hint' });
  const customerBlock = h('div', {},
    h('div', { class: 'c-selected' },
      h('div', { class: 'c-selected-label' }, 'Requesting as'),
      customerName,
      h('button', { type: 'button', class: 'c-link', onClick: () => signOut() }, 'Not you? Sign out')),
    field('reqAddress', 'Delivery address', addressInput, addressHint));

  const notesInput = h('textarea', { id: 'reqNotes', rows: '2', placeholder: 'Anything we should know' });
  const submitBtn = h('button', { type: 'button', class: 'c-btn primary', onClick: () => submit() }, 'Submit request');
  const shelfHint = h('p', { class: 'c-shelf-hint hidden', role: 'status' });
  // over the customer's available credit (the server checks again at submission)
  const creditEl = h('p', { class: 'c-credit hidden', role: 'status' });
  const totalEl = h('div', { class: 'c-total hidden', role: 'status' });
  const afterLines = h('div', { class: 'hidden' },
    totalEl,
    h('div', { class: 'c-customer' }, signInBlock, customerBlock),
    field('reqNotes', 'Notes (optional)', notesInput),
    h('div', { class: 'c-drawer-actions' },
      h('button', { type: 'button', class: 'c-btn', onClick: () => { clearCart(); lineErrors = {}; } }, 'Clear'),
      submitBtn),
    shelfHint,
    creditEl,
    h('p', { class: 'c-smallprint' },
      'Submitting a request is not an order and does not reserve stock. Our team will confirm availability with you.'));

  const mainPanel = h('section', { class: 'c-drawer-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Your request', tabindex: '-1' },
    h('header', { class: 'c-drawer-head' },
      h('h2', {}, 'Your request'),
      h('button', { type: 'button', class: 'c-remove', 'aria-label': 'Close', onClick: () => close() }, '×')),
    blockedEl, noticeEl, linesEl, afterLines);

  const okRef = h('b');
  const okCount = h('span');
  const okPanel = h('section', { class: 'c-drawer-panel hidden', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Request submitted', tabindex: '-1' },
    h('div', { class: 'c-okbox' },
      h('h2', {}, 'Request submitted'),
      h('p', {}, 'Your reference is ', okRef, ' — ', okCount, '.'),
      h('p', { class: 'c-smallprint' }, 'This is a request, not an order. Our team will confirm availability with you.'),
      h('button', { type: 'button', class: 'c-btn', onClick: () => { close(); window.dispatchEvent(new Event('bfl:open-orders')); } }, 'Follow my order'),
      h('button', { type: 'button', class: 'c-btn primary', onClick: () => close() }, 'Done')));

  const el = h('div', { id: 'cartDrawer', class: 'c-drawer hidden' }, backdrop, mainPanel, okPanel);

  // ---------------------------------------------------------------- the lines
  // Keyed by barcode: a line that changes quantity keeps its row (and its place), so pressing
  // − twice lands on the same product both times.
  const rows = new Map();   // barcode -> { row, stepper, err }

  function renderLines(lines) {
    const seen = new Set();
    for (const line of lines) {
      seen.add(line.barcode);
      let r = rows.get(line.barcode);
      if (!r) {
        const stepper = createQtyStepper({ barcode: line.barcode, name: line.name, pack: line.pack });
        const err = h('div', { class: 'c-line-err' });
        const price = h('div', { class: 'c-line-price hidden' });
        const warnText = h('span');
        const tick = h('input', {
          type: 'checkbox', id: `short-${line.barcode}`,
          onChange: () => { if (tick.checked) accepted.add(line.barcode); else accepted.delete(line.barcode); render(); },
        });
        const warn = h('div', { class: 'c-shelf hidden' },
          h('div', { class: 'c-shelf-msg' }, warnText),
          h('label', { class: 'c-shelf-accept', for: `short-${line.barcode}` }, tick, 'I accept this shorter shelf life for this order'));
        const row = h('div', { class: 'c-line' },
          h('div', { class: 'c-line-main' },
            h('div', { class: 'c-line-name' }, line.name || line.barcode),
            line.pack ? h('div', { class: 'c-pack' }, line.pack) : null,
            price,
            err),
          stepper.el,
          h('button', { type: 'button', class: 'c-remove', 'aria-label': 'Remove', onClick: () => removeFromCart(line.barcode) }, '×'),
          warn);
        r = { row, stepper, err, warn, warnText, tick, price };
        rows.set(line.barcode, r);
      }
      r.stepper.update(line.quantityCtn);
      r.err.textContent = lineErrors[line.barcode] || '';
      paintWarning(line.barcode, r);
      paintPrice(line, r);
    }
    paintTotal(lines);
    for (const [barcode, r] of rows) if (!seen.has(barcode)) { r.row.remove(); rows.delete(barcode); }

    if (!lines.length) {
      setChildren(linesEl, h('p', { class: 'c-empty-cart' }, 'Your request is empty.'));
    } else {
      linesEl.querySelector('.c-empty-cart')?.remove();
      // put the rows in cart order, moving only the ones that are out of place
      lines.forEach((line, i) => {
        const row = rows.get(line.barcode).row;
        if (linesEl.children[i] !== row) linesEl.insertBefore(row, linesEl.children[i] || null);
      });
    }
    toggleHidden(afterLines, !lines.length);
  }

  /** The line's carton price and what the cartons come to — signed-in customers only. */
  function paintPrice(line, r) {
    wantPrice(line.barcode);
    const v = lineValue(line.barcode, line.quantityCtn);
    if (v === null) r.price.textContent = '';
    else if (v.offer) {
      // the cartons on the discounted near-expiry offer, then the rest at the normal price
      r.price.textContent = `${v.offerCartons} ctn at ${formatPrice(v.offer.discountedPrice)} (${v.offer.discountPct}% off, best before ${v.offer.bestBefore}, not returnable)${v.normalCartons ? ` + ${v.normalCartons} ctn at ${formatPrice(v.price)}` : ''} · ${formatPrice(v.total)}`;
    } else r.price.textContent = `${formatPrice(v.price)} / carton · ${formatPrice(v.total)}`;
    toggleHidden(r.price, v === null);
  }

  /** The request total, only when every line has a price. An estimate: Odoo works out the order's price. */
  function paintTotal(lines) {
    const values = lines.map((l) => lineValue(l.barcode, l.quantityCtn));
    const known = lines.length > 0 && values.every((v) => v !== null);
    if (known) {
      const total = values.reduce((sum, v) => sum + v.total, 0);
      totalEl.textContent = `Total ${formatPrice(total)} — Odoo confirms the final price on your order.`;
    }
    toggleHidden(totalEl, !known);
  }

  /** Show or hide one row's shelf-life warning and keep its tick in step. */
  function paintWarning(barcode, r) {
    const w = shelfWarnings[barcode];
    toggleHidden(r.warn, !w);
    if (w) r.warnText.textContent = w.message;
    r.tick.checked = Boolean(w) && accepted.has(barcode);
  }
  function paintWarnings() { for (const [barcode, r] of rows) paintWarning(barcode, r); }

  /** Products still waiting for the customer's tick. */
  const unaccepted = () => Object.keys(shelfWarnings).filter((b) => !accepted.has(b));

  /**
   * Ask the server which lines would be filled with stock below this customer's minimum. Only
   * when signed in and a request is open; a failure just means no warning is shown (the server
   * still refuses an unaccepted line at submission).
   */
  async function checkShelfLife() {
    const lines = readCart();
    if (!isOpen || !customer || !lines.length) { shelfWarnings = {}; accepted.clear(); paintWarnings(); render(); return; }
    let result;
    try { result = await postJSON('/api/catalog/requests/shelf-check', { lines: toRequestLines() }); } catch { return; }
    const next = Object.fromEntries(result.warnings.map((w) => [w.barcode, { message: w.message }]));
    // an acceptance belongs to the exact warning it was given for; a changed warning must be accepted again
    for (const b of [...accepted]) if (!next[b] || next[b].message !== shelfWarnings[b]?.message) accepted.delete(b);
    shelfWarnings = next;
    paintWarnings();
    render();
  }
  const scheduleShelfCheck = debounce(checkShelfLife, 300);

  /**
   * Would this request go over the customer's available credit? Only asked when signed in with a
   * request open. A failure just means no warning here; the server refuses an over-limit request
   * at submission regardless.
   */
  async function checkCreditNow() {
    const lines = readCart();
    if (!isOpen || !customer || !lines.length) { if (creditProblem) { creditProblem = ''; render(); } return; }
    let r;
    try { r = await postJSON('/api/catalog/requests/credit-check', { lines: toRequestLines() }); } catch { return; }
    const next = r.ok ? '' : (r.message || 'This request is over your available credit.');
    if (next !== creditProblem) { creditProblem = next; render(); }
  }
  const scheduleCreditCheck = debounce(checkCreditNow, 300);

  // ---------------------------------------------------------------- everything else
  function setNotice(content) {
    if (content === null || content === undefined || content === '') { setChildren(noticeEl); toggleHidden(noticeEl, true); return; }
    setChildren(noticeEl, ...(Array.isArray(content) ? content : [content]));
    toggleHidden(noticeEl, false);
  }

  function render() {
    toggleHidden(blockedEl, canSubmit);
    blockedEl.textContent = canSubmit ? '' : (blocked || 'Requests cannot be submitted right now.');

    toggleHidden(customerBlock, !customer);
    toggleHidden(signInBlock, Boolean(customer));
    const waiting = unaccepted().length;
    submitBtn.disabled = !(canSubmit && customer) || submitting || waiting > 0 || Boolean(creditProblem);
    creditEl.textContent = creditProblem;
    toggleHidden(creditEl, !creditProblem);
    toggleHidden(shelfHint, waiting === 0);
    shelfHint.textContent = waiting
      ? `Tick the shelf-life box on ${waiting === 1 ? 'the highlighted product' : `each of the ${waiting} highlighted products`}, or remove ${waiting === 1 ? 'it' : 'them'}, to send your request.`
      : '';
    submitBtn.textContent = submitting ? 'Submitting…' : 'Submit request';

    if (customer) {
      customerName.textContent = customer.name;
      addressHint.textContent = customer.deliveryAddress
        ? 'Change it if this order goes somewhere else.' : 'We do not have an address for you yet.';
      // The saved address is pre-filled and editable: a customer can redirect one delivery
      // without rewriting the address held on their record. Only refilled when the customer
      // changes, so a refresh that returns the same person does not discard an edit.
      const key = `${customer.name}|${customer.deliveryAddress || ''}`;
      if (key !== customerKey) { customerKey = key; addressInput.value = customer.deliveryAddress || ''; }
    } else {
      customerKey = '';
    }

  }

  /** Ask the server whether requests can be submitted at all, and who is signed in. */
  async function refresh() {
    try {
      const s = await getJSON('/api/catalog/requests/stock-status');
      canSubmit = s.canSubmit;
      blocked = s.message;
    } catch { /* if unknown, let the submit attempt decide */ }
    try {
      const s = await getJSON('/api/catalog/access');
      customer = s.authenticated ? s.customer : null;
    } catch { customer = null; }
    setSession(customer);
    render();
    checkShelfLife();
    checkCreditNow();
  }

  async function signOut() {
    await fetch('/api/catalog/access/exit', { method: 'POST' }).catch(() => {});
    customer = null;
    setSession(null);
    shelfWarnings = {};
    accepted.clear();
    paintWarnings();
    render();
  }

  async function submit() {
    submitting = true;
    lineErrors = {};
    setNotice(null);
    render();
    renderLines(readCart());

    // Lines and notes only. WHO is requesting comes from the signed access-code session on the
    // server — the browser cannot name a customer, so it cannot submit in another's name.
    const payload = {
      lines: toRequestLines(),
      notes: notesInput.value || null,
      deliveryAddress: addressInput.value.trim() || null,
      // the products whose shorter shelf life the customer ticked (the server re-checks every one)
      acceptedShortDated: Object.keys(shelfWarnings).filter((b) => accepted.has(b)),
      idempotencyKey: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };

    try {
      const res = await postJSON('/api/catalog/requests', payload);
      clearCart();
      notesInput.value = '';
      shelfWarnings = {};
      accepted.clear();
      submitting = false;
      showSubmitted(res.reference, res.items);
      refreshOffers(); // the cartons just ordered are no longer on offer
      refresh(); // the server decides whether the session continues; read it back
      return;
    } catch (e) {
      // The session expired or was never established — ask them to sign in again with the cart
      // intact, rather than showing a bare error.
      if (e.body?.code === 'ACCESS_CODE_REQUIRED') {
        customer = null;
        setSession(null);
        setNotice('Please sign in to send this request.');
      } else {
        const errors = e.body?.errors || [];
        // drop what can never succeed, keep what the customer can still fix
        pruneUnavailable(errors);
        const general = errors.filter((x) => !x.barcode);
        setNotice(general.length ? general[0].message : 'Please check the highlighted products.');
        lineErrors = Object.fromEntries(errors.filter((x) => x.barcode).map((x) => [x.barcode, x.message]));
        renderLines(readCart());
      }
      await refresh();
    }
    submitting = false;
    render();
  }

  function showSubmitted(reference, items) {
    okRef.textContent = reference;
    okCount.textContent = `${items} product${items === 1 ? '' : 's'}`;
    toggleHidden(mainPanel, true);
    toggleHidden(okPanel, false);
    okPanel.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- open / close
  // Keep the drawer above the on-screen keyboard. iOS does NOT shrink the layout viewport when
  // the keyboard opens — only the visual viewport — so a panel pinned to the bottom ends up
  // behind the keyboard. visualViewport says how much is covered; --c-kb lifts the panel by
  // exactly that much. Only an actual change is written, because visualViewport fires
  // constantly while a phone keyboard settles.
  let lastCovered = -1;
  const lift = () => {
    const vv = window.visualViewport;
    const covered = Math.round(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    if (covered === lastCovered) return;
    lastCovered = covered;
    el.style.setProperty('--c-kb', `${covered}px`);
  };

  const onKey = (e) => { if (e.key === 'Escape') close(); };

  function open() {
    if (isOpen) return;
    isOpen = true;
    opener = document.activeElement;
    toggleHidden(el, false);
    toggleHidden(mainPanel, false);
    toggleHidden(okPanel, true);
    document.body.classList.add('c-noscroll');
    document.addEventListener('keydown', onKey);
    if (window.visualViewport) {
      lastCovered = -1;
      window.visualViewport.addEventListener('resize', lift);
      window.visualViewport.addEventListener('scroll', lift);
    }
    renderLines(readCart());
    render();
    mainPanel.focus({ preventScroll: true });
    openListeners.forEach((fn) => fn(true));
    refresh();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    setNotice(null);
    toggleHidden(el, true);
    document.body.classList.remove('c-noscroll');
    document.removeEventListener('keydown', onKey);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', lift);
      window.visualViewport.removeEventListener('scroll', lift);
    }
    el.style.removeProperty('--c-kb');   // so the panel is not left lifted next time it opens
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    openListeners.forEach((fn) => fn(false));
  }

  onCartChange((lines) => { if (isOpen) { renderLines(lines); scheduleShelfCheck(); scheduleCreditCheck(); } });
  onPrices(() => { if (isOpen) renderLines(readCart()); });
  renderLines(readCart());
  render();

  return { el, open, close, onOpenChange: (fn) => openListeners.add(fn) };
}
