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

// Who the server says we are, from the access-code session — NOT a choice made in
// the browser. There is no customer search any more: the code identifies the
// customer, so the catalog can stay public without exposing the customer list.
let accessCustomer = null;   // { name } | null
let askingForAccess = false; // showing the "I don't have a code" form

async function refreshAccess() {
  try {
    const s = await getJSON('/api/catalog/access');
    accessCustomer = s.authenticated ? s.customer : null;
  } catch { accessCustomer = null; }
  return accessCustomer;
}

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

/**
 * Keep the drawer above the on-screen keyboard.
 *
 * iOS does NOT shrink the layout viewport when the keyboard opens — only the
 * visual viewport — so a panel pinned to `bottom: 0` ends up behind the keyboard
 * with the field you are typing into hidden. visualViewport reports how much is
 * covered; `--c-kb` lifts the panel by exactly that much.
 *
 * Registered once, and a no-op on browsers without visualViewport (the panel then
 * behaves as it always did).
 */
function trackKeyboardInset() {
  const vv = window.visualViewport;
  if (!vv) return;
  // visualViewport fires `scroll` constantly while a phone keyboard settles.
  // Writing the variable on every one of those would relayout the panel under the
  // customer's fingers, so only an actual change is applied.
  let lastCovered = -1;
  const apply = () => {
    const el = document.getElementById('cartDrawer');
    if (!el || el.classList.contains('hidden')) return;
    // What the keyboard covers at the bottom of the layout viewport.
    const covered = Math.round(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    if (covered === lastCovered) return;
    lastCovered = covered;
    el.style.setProperty('--c-kb', `${covered}px`);
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
}

export function closeDrawer() {
  // drop any keyboard offset so the panel is not left lifted next time it opens
  drawerEl().style.removeProperty('--c-kb');
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

/**
 * Capture what the customer has typed into the code field, so a re-render cannot
 * throw it away.
 *
 * renderDrawer() rebuilds the whole panel with innerHTML, which destroys the input
 * and with it the value, the caret and the focus. Anything that re-renders while
 * someone is typing — a stepper, a late fetch, a resize-driven update — therefore
 * interrupts them mid-code. Rather than hunt for every caller, the field is
 * restored afterwards, which makes typing survive a re-render whatever caused it.
 */
function captureCodeField(el) {
  const input = el.querySelector('#accessCode');
  if (!input) return null;
  return {
    value: input.value,
    start: input.selectionStart,
    end: input.selectionEnd,
    focused: document.activeElement === input,
  };
}

function restoreCodeField(el, saved) {
  if (!saved) return;
  const input = el.querySelector('#accessCode');
  if (!input) return;
  input.value = saved.value;
  if (!saved.focused) return;
  input.focus({ preventScroll: true });
  // preventScroll matters on a phone: without it the browser scrolls the field
  // into view on every restore, which is itself enough to disturb typing.
  try { input.setSelectionRange(saved.start, saved.end); } catch { /* not all inputs support it */ }
}

async function renderDrawer(message = '') {
  const el = drawerEl();
  const lines = readCart();
  const typedCode = captureCodeField(el);

  // Ask the server whether requests can be submitted at all right now.
  let canSubmit = true; let blockedMessage = null;
  try {
    const s = await getJSON('/api/catalog/requests/stock-status');
    canSubmit = s.canSubmit; blockedMessage = s.message;
  } catch { /* if unknown, let the submit attempt decide */ }

  await refreshAccess();

  const customerBlock = askingForAccess
    ? `<div class="c-accessform">
         <p class="c-hint">Give us your details and Box for Less will send you an access code.</p>
         <div class="c-field"><label for="uContact">Your name</label>
           <input id="uContact" type="text" autocomplete="name" placeholder="Full name" /></div>
         <div class="c-field"><label for="uPhone">Phone</label>
           <input id="uPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Phone number" /></div>
         <div class="c-field"><label for="uCompany">Company name (optional)</label>
           <input id="uCompany" type="text" autocomplete="organization" placeholder="Company, if any" /></div>
         <div class="c-field"><label for="uAddress">Delivery address</label>
           <textarea id="uAddress" rows="3" autocomplete="street-address" required
             placeholder="Where should we deliver?"></textarea>
           <div class="c-hint">We need this before we can supply you.</div></div>
         <button type="button" class="c-btn" data-send-access>Request an access code</button>
         <button type="button" class="c-link" data-have-code>← I have a code</button>
       </div>`
    : accessCustomer
      // The saved address is pre-filled and editable: a customer can redirect one
      // delivery without it rewriting the address held on their record.
      ? `<div class="c-selected">Requesting as <b>${esc(accessCustomer.name)}</b>
           <button type="button" class="c-link" data-exit-access>Not you?</button></div>
         <div class="c-field"><label for="reqAddress">Delivery address</label>
           <textarea id="reqAddress" rows="3" autocomplete="street-address"
             placeholder="Where should we deliver?">${esc(accessCustomer.deliveryAddress || '')}</textarea>
           <div class="c-hint">${accessCustomer.deliveryAddress
    ? 'Change it if this order goes somewhere else.'
    : 'We do not have an address for you yet.'}</div></div>`
      // iOS NOTE, and do not "tidy" these attributes away:
      //   autocomplete="one-time-code" made Safari watch for an SMS passcode and
      //     re-evaluate the field on every keystroke, which dropped focus and shut
      //     the keyboard after each character. It must stay "off".
      //   inputmode="latin" is not a valid value (dropped from the spec); "text"
      //     is what gives a normal keyboard.
      //   enterkeyhint="go" labels the phone's return key, since Enter submits.
      : `<div class="c-field"><label for="accessCode">Your access code</label>
           <input id="accessCode" type="text" name="bfl-access-code" inputmode="text"
             autocapitalize="characters" autocomplete="off" autocorrect="off"
             spellcheck="false" enterkeyhint="go" placeholder="e.g. 7K2M-9XQR" />
           <div class="c-hint">Box for Less sent this to you with the catalogue link.</div>
           <div id="accessErr" class="c-accesserr"></div></div>
         <button type="button" class="c-btn" data-enter-code>Continue</button>
         <button type="button" class="c-link" data-need-code>I don't have a code</button>`;

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
          <button type="button" class="c-btn primary" data-submit
            ${canSubmit && accessCustomer ? '' : 'disabled'}>Submit request</button>
        </div>
        <p class="c-smallprint">Submitting a request is not an order and does not reserve stock.
          Our team will confirm availability with you.</p>` : ''}
    </section>`;

  wireDrawer();
  restoreCodeField(el, typedCode);
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

  el.querySelector('[data-need-code]')?.addEventListener('click', () => { askingForAccess = true; renderDrawer(); });
  el.querySelector('[data-have-code]')?.addEventListener('click', () => { askingForAccess = false; renderDrawer(); });

  el.querySelector('[data-exit-access]')?.addEventListener('click', async () => {
    await fetch('/api/catalog/access/exit', { method: 'POST' });
    accessCustomer = null;
    renderDrawer();
  });

  const codeInput = el.querySelector('#accessCode');
  const enterCode = async () => {
    const errBox = el.querySelector('#accessErr');
    const btn = el.querySelector('[data-enter-code]');
    if (errBox) errBox.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
      await getJSON('/api/catalog/access', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: codeInput?.value || '' }),
      });
      askingForAccess = false;
      renderDrawer();
    } catch (e) {
      if (errBox) errBox.textContent = e.message || 'That access code was not recognised.';
      if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
    }
  };
  el.querySelector('[data-enter-code]')?.addEventListener('click', enterCode);
  // Enter submits, so the phone keyboard's Go key works.
  codeInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); enterCode(); } });

  el.querySelector('[data-send-access]')?.addEventListener('click', async () => {
    const btn = el.querySelector('[data-send-access]');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const res = await getJSON('/api/catalog/access-requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: el.querySelector('#uCompany')?.value?.trim() || '',
          contact: el.querySelector('#uContact')?.value?.trim() || '',
          phone: el.querySelector('#uPhone')?.value?.trim() || '',
          address: el.querySelector('#uAddress')?.value?.trim() || '',
        }),
      });
      askingForAccess = false;
      renderDrawer(`<b>Thank you.</b> ${esc(res.message || '')}`);
    } catch (e) {
      // stay on the form so the details already typed are not lost behind an error
      askingForAccess = true;
      renderDrawer(`<span class="c-accesserr">${esc(e.message || 'Could not send your details.')}</span>`);
    }
  });

  el.querySelector('[data-submit]')?.addEventListener('click', submit);
}

async function submit() {
  const el = drawerEl();
  const btn = el.querySelector('[data-submit]');
  btn.disabled = true; btn.textContent = 'Submitting…';
  el.querySelectorAll('.c-line-err').forEach((n) => { n.textContent = ''; });

  // Lines and notes only. WHO is requesting comes from the signed access-code
  // session on the server — the browser cannot name a customer, so it cannot
  // submit a request in another company's name.
  const payload = {
    lines: toRequestLines(),
    notes: el.querySelector('#reqNotes')?.value || null,
    deliveryAddress: el.querySelector('#reqAddress')?.value?.trim() || null,
  };

  try {
    const res = await getJSON('/api/catalog/requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    clearCart();
    askingForAccess = false;
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
    // The session expired or was never established — fall back to the code prompt
    // with the cart intact, rather than showing a bare error.
    if (e.body?.code === 'ACCESS_CODE_REQUIRED') {
      accessCustomer = null; askingForAccess = false;
      await renderDrawer('Please enter your access code to send this request.');
      renderCartBar();
      return;
    }
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
  trackKeyboardInset();
}

export default { mountRequestUI, openDrawer, renderCartBar, setCartMutationHandler };
