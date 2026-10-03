// Request cart UI: the bottom bar, the review drawer, and submission.
//
// Kept separate from catalog.js so the browsing experience and the request
// experience stay independently readable — the catalog layout is unchanged.
//
// Everything here is presentation. No availability arithmetic happens in the
// browser: the server validates every line at submission and its verdict is what
// the customer is shown.
import {
  readCart, setQuantity, removeFromCart, clearCart, cartCount, toRequestLines,
  pruneUnavailable, onCartChange,
} from './cart.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

let onCartMutated = () => {};
/** catalog.js passes a callback so product cards re-render when the cart changes. */
export function setCartMutationHandler(fn) { onCartMutated = fn || (() => {}); }

// ---------------------------------------------------------------------------
// bottom bar
// ---------------------------------------------------------------------------

function barEl() {
  let el = document.getElementById('cartBar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cartBar';
    el.className = 'c-cartbar hidden';
    document.body.appendChild(el);
    el.addEventListener('click', (e) => { if (e.target.closest('[data-open-cart]')) openDrawer(); });
  }
  return el;
}

export function renderCartBar() {
  const el = barEl();
  const n = cartCount();
  const lines = readCart().length;
  if (!n) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="c-cartbar-info"><b>${n}</b> CTN · ${lines} product${lines === 1 ? '' : 's'}</div>
    <button class="c-btn primary" type="button" data-open-cart>Review request</button>`;
}

// ---------------------------------------------------------------------------
// drawer
// ---------------------------------------------------------------------------

let selectedCustomer = null; // { ref, name } | null
let unlistedMode = false;

function drawerEl() {
  let el = document.getElementById('cartDrawer');
  if (!el) {
    el = document.createElement('div');
    el.id = 'cartDrawer';
    el.className = 'c-drawer hidden';
    document.body.appendChild(el);
  }
  return el;
}

export function closeDrawer() {
  drawerEl().classList.add('hidden');
  document.body.classList.remove('c-noscroll');
}

export async function openDrawer() {
  const el = drawerEl();
  el.classList.remove('hidden');
  document.body.classList.add('c-noscroll');
  await renderDrawer();
}

function lineRow(l) {
  return `<div class="c-line" data-line="${esc(l.barcode)}">
      <div class="c-line-main">
        <div class="c-line-name">${esc(l.name || l.barcode)}</div>
        ${l.pack ? `<div class="c-pack">${esc(l.pack)}</div>` : ''}
        <div class="c-line-err" id="err-${esc(l.barcode)}"></div>
      </div>
      <div class="c-stepper">
        <button type="button" class="c-step" data-dec="${esc(l.barcode)}" aria-label="Fewer cartons">−</button>
        <span class="c-qty"><b>${l.quantityCtn}</b> CTN</span>
        <button type="button" class="c-step" data-inc="${esc(l.barcode)}" aria-label="More cartons">+</button>
      </div>
      <button type="button" class="c-remove" data-remove="${esc(l.barcode)}" aria-label="Remove">×</button>
    </div>`;
}

async function renderDrawer(message = '') {
  const el = drawerEl();
  const lines = readCart();

  // Ask the server whether requests can be submitted at all right now.
  let canSubmit = true; let blockedMessage = null;
  try {
    const s = await getJSON('/api/catalog/requests/stock-status');
    canSubmit = s.canSubmit; blockedMessage = s.message;
  } catch { /* if unknown, let the submit attempt decide */ }

  const customerBlock = unlistedMode
    ? `<div class="c-field"><label for="uCompany">Company name</label>
         <input id="uCompany" type="text" autocomplete="organization" placeholder="Your company" /></div>
       <div class="c-field"><label for="uContact">Your name</label>
         <input id="uContact" type="text" autocomplete="name" placeholder="Contact name" /></div>
       <div class="c-field"><label for="uPhone">Phone (optional)</label>
         <input id="uPhone" type="tel" autocomplete="tel" placeholder="Phone number" /></div>
       <button type="button" class="c-link" data-listed>← Choose from the customer list instead</button>`
    : selectedCustomer
      ? `<div class="c-selected">Requesting as <b>${esc(selectedCustomer.name)}</b>
           <button type="button" class="c-link" data-clear-customer>Change</button></div>`
      : `<div class="c-field"><label for="custQ">Your company</label>
           <input id="custQ" type="search" autocomplete="off" placeholder="Start typing your company name…" />
           <div class="c-hint">Type at least 3 characters</div>
           <div id="custResults" class="c-results"></div></div>
         <button type="button" class="c-link" data-unlisted>My company is not listed</button>`;

  el.innerHTML = `
    <div class="c-drawer-backdrop" data-close></div>
    <section class="c-drawer-panel" role="dialog" aria-label="Your request">
      <header class="c-drawer-head">
        <h2>Your request</h2>
        <button type="button" class="c-remove" data-close aria-label="Close">×</button>
      </header>
      ${!canSubmit ? `<div class="c-blocked">${esc(blockedMessage || 'Requests cannot be submitted right now.')}</div>` : ''}
      ${message ? `<div class="c-notice">${message}</div>` : ''}
      <div class="c-lines">
        ${lines.length ? lines.map(lineRow).join('') : '<p class="c-empty-cart">Your request is empty.</p>'}
      </div>
      ${lines.length ? `
        <div class="c-customer">${customerBlock}</div>
        <div class="c-field"><label for="reqNotes">Notes (optional)</label>
          <textarea id="reqNotes" rows="2" placeholder="Anything we should know"></textarea></div>
        <div class="c-drawer-actions">
          <button type="button" class="c-btn" data-clear>Clear</button>
          <button type="button" class="c-btn primary" data-submit ${canSubmit ? '' : 'disabled'}>Submit request</button>
        </div>
        <p class="c-smallprint">Submitting a request is not an order and does not reserve stock.
          Our team will confirm availability with you.</p>` : ''}
    </section>`;

  wireDrawer();
}

function wireDrawer() {
  const el = drawerEl();
  el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeDrawer));

  el.querySelectorAll('[data-inc]').forEach((b) => b.addEventListener('click', () => {
    const bc = b.dataset.inc;
    const l = readCart().find((x) => x.barcode === bc);
    setQuantity({ barcode: bc, name: l?.name, pack: l?.pack }, (l?.quantityCtn || 0) + 1);
    renderDrawer();
  }));
  el.querySelectorAll('[data-dec]').forEach((b) => b.addEventListener('click', () => {
    const bc = b.dataset.dec;
    const l = readCart().find((x) => x.barcode === bc);
    setQuantity({ barcode: bc, name: l?.name, pack: l?.pack }, (l?.quantityCtn || 0) - 1);
    renderDrawer();
  }));
  el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => {
    removeFromCart(b.dataset.remove); renderDrawer();
  }));
  el.querySelector('[data-clear]')?.addEventListener('click', () => { clearCart(); renderDrawer(); });

  el.querySelector('[data-unlisted]')?.addEventListener('click', () => { unlistedMode = true; renderDrawer(); });
  el.querySelector('[data-listed]')?.addEventListener('click', () => { unlistedMode = false; renderDrawer(); });
  el.querySelector('[data-clear-customer]')?.addEventListener('click', () => { selectedCustomer = null; renderDrawer(); });

  const q = el.querySelector('#custQ');
  if (q) {
    let t;
    q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const box = el.querySelector('#custResults');
        const term = q.value.trim();
        if (term.length < 3) { box.innerHTML = ''; return; }
        try {
          const { items } = await getJSON(`/api/catalog/customers?q=${encodeURIComponent(term)}`);
          box.innerHTML = items.length
            ? items.map((c) => `<button type="button" class="c-result" data-handle="${esc(c.handle ?? '')}" data-name="${esc(c.name)}">${esc(c.name)}</button>`).join('')
            : '<div class="c-hint">No match. You can choose “My company is not listed”.</div>';
          box.querySelectorAll('[data-name]').forEach((b) => b.addEventListener('click', () => {
            // an opaque handle — the browser never sees the Odoo customer id
            selectedCustomer = { handle: b.dataset.handle || null, name: b.dataset.name };
            renderDrawer();
          }));
        } catch { box.innerHTML = '<div class="c-hint">Search unavailable.</div>'; }
      }, 220);
    });
  }

  el.querySelector('[data-submit]')?.addEventListener('click', submit);
}

async function submit() {
  const el = drawerEl();
  const btn = el.querySelector('[data-submit]');
  btn.disabled = true; btn.textContent = 'Submitting…';
  el.querySelectorAll('.c-line-err').forEach((n) => { n.textContent = ''; });

  const payload = { lines: toRequestLines(), notes: el.querySelector('#reqNotes')?.value || null };
  if (selectedCustomer && selectedCustomer.handle) payload.customerHandle = selectedCustomer.handle;
  else {
    payload.unlisted = {
      company: el.querySelector('#uCompany')?.value?.trim() || selectedCustomer?.name || '',
      contact: el.querySelector('#uContact')?.value?.trim() || '',
      phone: el.querySelector('#uPhone')?.value?.trim() || '',
    };
  }

  try {
    const res = await getJSON('/api/catalog/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    clearCart();
    selectedCustomer = null; unlistedMode = false;
    el.innerHTML = `
      <div class="c-drawer-backdrop" data-close></div>
      <section class="c-drawer-panel" role="dialog" aria-label="Request submitted">
        <div class="c-okbox">
          <h2>Request submitted</h2>
          <p>Your reference is <b>${esc(res.reference)}</b> — ${res.items} product${res.items === 1 ? '' : 's'}.</p>
          <p class="c-smallprint">This is a request, not an order. Our team will confirm availability with you.</p>
          <button type="button" class="c-btn primary" data-close>Done</button>
        </div>
      </section>`;
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => { closeDrawer(); onCartMutated(); }));
    renderCartBar();
    onCartMutated();
  } catch (e) {
    const errors = e.body?.errors || [];
    // drop what can never succeed, keep what the customer can still fix
    pruneUnavailable(errors);
    const general = errors.filter((x) => !x.barcode);
    await renderDrawer(general.length ? esc(general[0].message) : 'Please check the highlighted products.');
    for (const err of errors.filter((x) => x.barcode)) {
      const node = drawerEl().querySelector(`#err-${CSS.escape(err.barcode)}`);
      if (node) node.textContent = err.message;
    }
    renderCartBar();
    onCartMutated();
  }
}

/** Mount once per page load. */
export function mountRequestUI() {
  renderCartBar();
  onCartChange(() => renderCartBar());
}

export default { mountRequestUI, openDrawer, renderCartBar, setCartMutationHandler };
