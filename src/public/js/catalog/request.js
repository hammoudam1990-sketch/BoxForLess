// Request cart UI: the bottom tab bar, the desktop "My request" button, the review drawer,
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
import { getJSON, postJSON } from './http.js';
import { createQtyStepper } from './qty.js';

// Mirrors domain/access-codes.js. Only used to decide when a typed code is COMPLETE enough to
// check; the server alone decides whether it is correct.
const ACCESS_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ACCESS_CODE_LENGTH = 8;
const normalizeCodeInput = (v) => String(v ?? '').toUpperCase().split('')
  .filter((c) => ACCESS_CODE_ALPHABET.includes(c)).join('');

// Plain line icons, one stroke weight, hidden from assistive tech (each tab has a text label).
const ICONS = {
  home: 'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  request: 'M7 3h10a1 1 0 0 1 1 1v17l-3.5-2-2.5 2-2.5-2L6 21V4a1 1 0 0 1 1-1zM9.5 8h5M9.5 12h5',
};
const icon = (name) => svg(`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"/></svg>`);

const cartons = (lines) => lines.reduce((n, l) => n + l.quantityCtn, 0);

/** A labelled field: <div class="c-field"><label/>control hint</div>. */
function field(id, label, control, ...hint) {
  return h('div', { class: 'c-field' }, h('label', { for: id }, label), control, ...hint);
}

/**
 * Build the tab bar (Home, Categories, My request), the desktop request button and the drawer.
 * Returns { setTab(tab), open() }. `tab` is 'home', 'categories' or '' (on a product page).
 */
export function mountRequestUI({ onHome, onCategories }) {
  const drawer = createDrawer();

  // ---- the tab bar (phones) ----
  const homeTab = h('button', { type: 'button', class: 'c-tab', onClick: onHome }, icon('home'), h('span', {}, 'Home'));
  const catTab = h('button', { type: 'button', class: 'c-tab', onClick: onCategories }, icon('grid'), h('span', {}, 'Categories'));
  const tabIcon = h('span', { class: 'c-tab-icon' }, icon('request'));
  const requestTab = h('button', {
    type: 'button', class: 'c-tab', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onClick: () => drawer.open(),
  }, tabIcon, h('span', {}, 'My request'));
  const tabbar = h('nav', { class: 'c-tabbar', 'aria-label': 'Catalogue' }, homeTab, catTab, requestTab);

  // ---- the floating button (wider screens) ----
  const fab = h('button', { type: 'button', class: 'c-request-fab', 'aria-haspopup': 'dialog', onClick: () => drawer.open() },
    icon('request'), h('span', {}, 'My request'));

  document.body.append(tabbar, fab, drawer.el);

  // The carton count on both buttons. The tab's badge is a fresh element each time the count
  // changes, so its little pop animation plays again.
  let tabBadge = null;
  let fabBadge = null;
  const showCount = (lines) => {
    const n = cartons(lines);
    const label = `${n} cartons in your request`;
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
      for (const [button, name] of [[homeTab, 'home'], [catTab, 'categories']]) {
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
  let asking = false;         // showing the "I don't have a code" form
  let codeBusy = false;
  let sendingAccess = false;
  let submitting = false;
  let focusSubmit = false;    // set after a code is accepted, consumed once the button is live
  let lastTried = null;       // the last complete code checked, so typing past it does not recheck
  let lineErrors = {};
  let opener = null;
  const openListeners = new Set();

  // ---------------------------------------------------------------- the parts
  const backdrop = h('div', { class: 'c-drawer-backdrop', onClick: () => close() });

  const blockedEl = h('div', { class: 'c-blocked hidden' });
  const noticeEl = h('div', { class: 'c-notice hidden' });
  const linesEl = h('div', { class: 'c-lines' });

  // the access code
  const codeInput = h('input', {
    id: 'accessCode', type: 'text', name: 'bfl-access-code', inputmode: 'text',
    // iOS NOTE, and do not "tidy" these attributes away:
    //   autocomplete="one-time-code" made Safari watch for an SMS passcode and re-evaluate the
    //     field on every keystroke, which dropped focus and shut the keyboard after each
    //     character. It must stay "off".
    //   enterkeyhint="go" labels the phone's return key, since Enter submits.
    autocapitalize: 'characters', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
    enterkeyhint: 'go', placeholder: 'e.g. 7K2M-9XQR',
    onInput: (e) => onCodeInput(e.target.value),
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); enterCode(codeInput.value); } },
  });
  const codeError = h('div', { class: 'c-accesserr' });
  const continueBtn = h('button', { type: 'button', class: 'c-btn', onClick: () => enterCode(codeInput.value) }, 'Continue');
  const codeBlock = h('div', {},
    field('accessCode', 'Your access code', codeInput,
      h('div', { class: 'c-hint' }, 'Box for Less sent this to you with the catalogue link.'), codeError),
    continueBtn,
    h('button', { type: 'button', class: 'c-link', onClick: () => { asking = true; render(); } }, "I don't have a code"));

  // "I don't have a code"
  const uContact = h('input', { id: 'uContact', type: 'text', autocomplete: 'name', placeholder: 'Full name' });
  const uPhone = h('input', { id: 'uPhone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: 'Phone number' });
  const uCompany = h('input', { id: 'uCompany', type: 'text', autocomplete: 'organization', placeholder: 'Company, if any' });
  const uAddress = h('textarea', { id: 'uAddress', rows: '3', autocomplete: 'street-address', required: true, placeholder: 'Where should we deliver?' });
  const sendAccessBtn = h('button', { type: 'button', class: 'c-btn', onClick: () => sendAccessRequest() }, 'Request an access code');
  const askBlock = h('div', { class: 'c-accessform' },
    h('p', { class: 'c-hint' }, 'Give us your details and Box for Less will send you an access code.'),
    field('uContact', 'Your name', uContact),
    field('uPhone', 'Phone', uPhone),
    field('uCompany', 'Company name (optional)', uCompany),
    field('uAddress', 'Delivery address', uAddress, h('div', { class: 'c-hint' }, 'We need this before we can supply you.')),
    sendAccessBtn,
    h('button', { type: 'button', class: 'c-link', onClick: () => { asking = false; render(); } }, '← I have a code'));

  // signed in with a code. The company name is the confirmation that the RIGHT code was used,
  // and a salesman moving between customers reads it before every submission, so it is the
  // largest thing in the panel.
  const customerName = h('div', { class: 'c-selected-name' });
  const addressInput = h('textarea', { id: 'reqAddress', rows: '3', autocomplete: 'street-address', placeholder: 'Where should we deliver?' });
  const addressHint = h('div', { class: 'c-hint' });
  const customerBlock = h('div', {},
    h('div', { class: 'c-selected' },
      h('div', { class: 'c-selected-label' }, 'Requesting as'),
      customerName,
      h('button', { type: 'button', class: 'c-link', onClick: () => exitAccess() }, 'Not you? Use a different code')),
    field('reqAddress', 'Delivery address', addressInput, addressHint));

  const notesInput = h('textarea', { id: 'reqNotes', rows: '2', placeholder: 'Anything we should know' });
  const submitBtn = h('button', { type: 'button', class: 'c-btn primary', onClick: () => submit() }, 'Submit request');
  const afterLines = h('div', { class: 'hidden' },
    h('div', { class: 'c-customer' }, codeBlock, askBlock, customerBlock),
    field('reqNotes', 'Notes (optional)', notesInput),
    h('div', { class: 'c-drawer-actions' },
      h('button', { type: 'button', class: 'c-btn', onClick: () => { clearCart(); lineErrors = {}; } }, 'Clear'),
      submitBtn),
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
      h('p', { class: 'c-smallprint' }, h('b', {}, 'The next request needs its own access code.'),
        " This keeps one customer's order from being sent under another's name."),
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
        const row = h('div', { class: 'c-line' },
          h('div', { class: 'c-line-main' },
            h('div', { class: 'c-line-name' }, line.name || line.barcode),
            line.pack ? h('div', { class: 'c-pack' }, line.pack) : null,
            err),
          stepper.el,
          h('button', { type: 'button', class: 'c-remove', 'aria-label': 'Remove', onClick: () => removeFromCart(line.barcode) }, '×'));
        r = { row, stepper, err };
        rows.set(line.barcode, r);
      }
      r.stepper.update(line.quantityCtn);
      r.err.textContent = lineErrors[line.barcode] || '';
    }
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

  // ---------------------------------------------------------------- everything else
  function setNotice(content) {
    if (content === null || content === undefined || content === '') { setChildren(noticeEl); toggleHidden(noticeEl, true); return; }
    setChildren(noticeEl, ...(Array.isArray(content) ? content : [content]));
    toggleHidden(noticeEl, false);
  }

  function render() {
    toggleHidden(blockedEl, canSubmit);
    blockedEl.textContent = canSubmit ? '' : (blocked || 'Requests cannot be submitted right now.');

    toggleHidden(askBlock, !asking);
    toggleHidden(customerBlock, asking || !customer);
    toggleHidden(codeBlock, asking || Boolean(customer));

    continueBtn.disabled = codeBusy;
    continueBtn.textContent = codeBusy ? 'Checking…' : 'Continue';
    sendAccessBtn.disabled = sendingAccess;
    sendAccessBtn.textContent = sendingAccess ? 'Sending…' : 'Request an access code';
    submitBtn.disabled = !(canSubmit && customer) || submitting;
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

    // Move to the Submit button once a code has been accepted. On a phone the button sits
    // below the keyboard, so a customer who has just typed their code cannot see it come
    // alive. Focusing it closes the keyboard, scrolls it into view, and means the next Enter
    // sends the request.
    if (focusSubmit && customer && !submitBtn.disabled) {
      focusSubmit = false;
      submitBtn.focus();
      submitBtn.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    render();
  }

  async function enterCode(value) {
    codeError.textContent = '';
    codeBusy = true;
    render();
    try {
      await postJSON('/api/catalog/access', { code: value });
      asking = false;
      setNotice(null);
      focusSubmit = true;
      await refresh();
    } catch (e) {
      codeError.textContent = e.message || 'That access code was not recognised.';
    }
    codeBusy = false;
    render();
  }

  // Check the code as soon as it is complete, without waiting for Continue. A code is a fixed
  // eight characters, so there is nothing to wait for once the eighth is typed. Continue stays
  // for pasting and for retrying a refused code. `lastTried` stops a re-check firing on every
  // keystroke past the eighth, which would burn the server's per-IP attempt limit.
  function onCodeInput(value) {
    const complete = normalizeCodeInput(value);
    if (complete.length !== ACCESS_CODE_LENGTH || complete === lastTried) return;
    lastTried = complete;
    enterCode(value);
  }

  async function exitAccess() {
    await fetch('/api/catalog/access/exit', { method: 'POST' }).catch(() => {});
    lastTried = null;
    codeInput.value = '';
    customer = null;
    render();
  }

  async function sendAccessRequest() {
    sendingAccess = true;
    render();
    try {
      const res = await postJSON('/api/catalog/access-requests', {
        company: uCompany.value.trim(),
        contact: uContact.value.trim(),
        phone: uPhone.value.trim(),
        address: uAddress.value.trim(),
      });
      asking = false;
      setNotice([h('b', {}, 'Thank you.'), ` ${res.message || ''}`]);
    } catch (e) {
      // stay on the form so the details already typed are not lost behind an error
      asking = true;
      setNotice(h('span', { class: 'c-accesserr' }, e.message || 'Could not send your details.'));
    }
    sendingAccess = false;
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
    };

    try {
      const res = await postJSON('/api/catalog/requests', payload);
      clearCart();
      asking = false;
      notesInput.value = '';
      // The server ended the session with the order, so the next customer on this phone must
      // enter their own code. Mirror that here or the drawer would still show the previous
      // customer's name.
      lastTried = null;
      codeInput.value = '';
      customer = null;
      submitting = false;
      showSubmitted(res.reference, res.items);
      return;
    } catch (e) {
      // The session expired or was never established — fall back to the code prompt with the
      // cart intact, rather than showing a bare error.
      if (e.body?.code === 'ACCESS_CODE_REQUIRED') {
        customer = null;
        asking = false;
        setNotice('Please enter your access code to send this request.');
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

  onCartChange((lines) => { if (isOpen) renderLines(lines); });
  renderLines(readCart());
  render();

  return { el, open, close, onOpenChange: (fn) => openListeners.add(fn) };
}
