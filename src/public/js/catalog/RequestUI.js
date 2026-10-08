// Request cart UI: the bottom bar, the review drawer, and submission.
//
// Everything here is presentation. No availability arithmetic happens in the
// browser: the server validates every line at submission and its verdict is what the
// customer is shown.
import { html, Fragment, useState, useEffect, useRef } from '../lib/react.js';
import { setQuantity, removeFromCart, clearCart, toRequestLines, pruneUnavailable } from '../cart.js';
import { getJSON, postJSON } from './http.js';
import { useCartLines } from './useCart.js';
import { QtyStepper } from './parts.js';

// Mirrors domain/access-codes.js. Only used to decide when a typed code is COMPLETE
// enough to check; the server alone decides whether it is correct.
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
const Icon = ({ name }) => html`
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round">
    <path d=${ICONS[name]} />
  </svg>`;

/**
 * The bottom tab bar — Home, Categories, My request — and the request drawer it opens.
 * `tab` says which of Home / Categories the list is showing ('' on a product page).
 */
export function RequestUI({ tab, onHome, onCategories }) {
  const lines = useCartLines();
  const [open, setOpen] = useState(false);
  const cartons = lines.reduce((n, l) => n + l.quantityCtn, 0);

  return html`
    <nav class="c-tabbar" aria-label="Catalogue">
      <button type="button" class="c-tab" aria-current=${tab === 'home' ? 'page' : null} onClick=${onHome}>
        <${Icon} name="home" /><span>Home</span>
      </button>
      <button type="button" class="c-tab" aria-current=${tab === 'categories' ? 'page' : null} onClick=${onCategories}>
        <${Icon} name="grid" /><span>Categories</span>
      </button>
      <button type="button" class="c-tab" aria-haspopup="dialog" aria-expanded=${open} onClick=${() => setOpen(true)}>
        <span class="c-tab-icon">
          <${Icon} name="request" />
          ${cartons ? html`<span key=${cartons} class="c-tab-badge" role="status" aria-label=${`${cartons} cartons in your request`}>${cartons}</span>` : null}
        </span>
        <span>My request</span>
      </button>
    </nav>
    <${Drawer} open=${open} onClose=${() => setOpen(false)} />`;
}

function Stepper({ line }) {
  return html`<${QtyStepper} item=${{ barcode: line.barcode, name: line.name, pack: line.pack }} qty=${line.quantityCtn} />`;
}

function LineRow({ line, error }) {
  return html`
    <div class="c-line">
      <div class="c-line-main">
        <div class="c-line-name">${line.name || line.barcode}</div>
        ${line.pack ? html`<div class="c-pack">${line.pack}</div>` : null}
        <div class="c-line-err">${error || ''}</div>
      </div>
      <${Stepper} line=${line} />
      <button type="button" class="c-remove" aria-label="Remove" onClick=${() => removeFromCart(line.barcode)}>×</button>
    </div>`;
}

function Field({ id, label, hint, children }) {
  return html`
    <div class="c-field"><label for=${id}>${label}</label>${children}${hint}</div>`;
}

function Drawer({ open, onClose }) {
  const lines = useCartLines();
  const drawerRef = useRef(null);
  const submitRef = useRef(null);
  const focusSubmit = useRef(false);   // set after a code is accepted, consumed once the button is live
  const lastTried = useRef(null);      // the last complete code checked, so typing past it does not recheck

  // what the server says
  const [canSubmit, setCanSubmit] = useState(true);
  const [blocked, setBlocked] = useState(null);
  // Who the server says we are, from the access-code session — NOT a choice made in
  // the browser. There is no customer search any more: the code identifies the
  // customer, so the catalog can stay public without exposing the customer list.
  const [customer, setCustomer] = useState(null);   // { name, deliveryAddress } | null

  // what the customer is doing
  const [asking, setAsking] = useState(false);      // showing the "I don't have a code" form
  const [code, setCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [access, setAccess] = useState({ contact: '', phone: '', company: '', address: '' });
  const [sendingAccess, setSendingAccess] = useState(false);
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // what came back
  const [message, setMessage] = useState(null);
  const [lineErrors, setLineErrors] = useState({});
  const [submitted, setSubmitted] = useState(null); // { reference, items }

  /** Ask the server whether requests can be submitted at all, and who is signed in. */
  const refresh = async () => {
    try {
      const s = await getJSON('/api/catalog/requests/stock-status');
      setCanSubmit(s.canSubmit);
      setBlocked(s.message);
    } catch { /* if unknown, let the submit attempt decide */ }
    try {
      const s = await getJSON('/api/catalog/access');
      setCustomer(s.authenticated ? s.customer : null);
    } catch { setCustomer(null); }
  };

  useEffect(() => { if (open) refresh(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // The saved address is pre-filled and editable: a customer can redirect one
  // delivery without it rewriting the address held on their record. Keyed on the
  // customer, so a refresh that returns the same person does not discard an edit.
  const customerKey = customer ? `${customer.name}|${customer.deliveryAddress || ''}` : '';
  useEffect(() => { setAddress(customer?.deliveryAddress || ''); }, [customerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lock the page behind the drawer.
  useEffect(() => {
    document.body.classList.toggle('c-noscroll', open);
    return () => document.body.classList.remove('c-noscroll');
  }, [open]);

  // Keep the drawer above the on-screen keyboard.
  //
  // iOS does NOT shrink the layout viewport when the keyboard opens — only the
  // visual viewport — so a panel pinned to `bottom: 0` ends up behind the keyboard
  // with the field you are typing into hidden. visualViewport reports how much is
  // covered; `--c-kb` lifts the panel by exactly that much. A no-op on browsers
  // without visualViewport (the panel then behaves as it always did).
  useEffect(() => {
    const vv = window.visualViewport;
    const el = drawerRef.current;
    if (!open || !vv || !el) return undefined;
    // visualViewport fires `scroll` constantly while a phone keyboard settles.
    // Writing the variable on every one of those would relayout the panel under the
    // customer's fingers, so only an actual change is applied.
    let lastCovered = -1;
    const apply = () => {
      const covered = Math.round(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
      if (covered === lastCovered) return;
      lastCovered = covered;
      el.style.setProperty('--c-kb', `${covered}px`);
    };
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      el.style.removeProperty('--c-kb'); // so the panel is not left lifted next time it opens
    };
  }, [open]);

  // Move to the Submit button once a code has been accepted.
  //
  // On a phone the button sits below the keyboard, so a customer who has just typed
  // their code cannot see it come alive and assumes nothing happened. Focusing it
  // closes the keyboard, scrolls it into view, and means the next Enter sends the
  // request — a focused button activates on Enter natively.
  useEffect(() => {
    if (!focusSubmit.current || !customer) return;
    focusSubmit.current = false;
    const button = submitRef.current;
    if (button && !button.disabled) {
      button.focus();
      button.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [customer]);

  // A dialog: focus moves into it when it opens, Escape closes it, and focus goes back
  // to whatever opened it.
  const panelRef = useRef(null);
  const opener = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    opener.current = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener.current && document.contains(opener.current)) opener.current.focus({ preventScroll: true });
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setMessage(null);
    setSubmitted(null);
    onClose();
  };

  const enterCode = async (value) => {
    setCodeError('');
    setCodeBusy(true);
    try {
      await postJSON('/api/catalog/access', { code: value });
      setAsking(false);
      setMessage(null);
      focusSubmit.current = true;
      await refresh();
    } catch (e) {
      setCodeError(e.message || 'That access code was not recognised.');
    }
    setCodeBusy(false);
  };

  // Check the code as soon as it is complete, without waiting for Continue.
  //
  // A code is a fixed eight characters, so there is nothing to wait for once the
  // eighth is typed. Customers reported typing their code and seeing Submit stay
  // grey — they had not pressed Continue, and had no reason to think they needed to.
  // Continue stays for pasting and for retrying a refused code.
  //
  // `lastTried` stops a re-check firing on every keystroke past the eighth, which
  // would otherwise burn the server's per-IP attempt limit.
  const onCodeInput = (value) => {
    setCode(value);
    const complete = normalizeCodeInput(value);
    if (complete.length !== ACCESS_CODE_LENGTH || complete === lastTried.current) return;
    lastTried.current = complete;
    enterCode(value);
  };

  const exitAccess = async () => {
    await fetch('/api/catalog/access/exit', { method: 'POST' });
    lastTried.current = null;
    setCode('');
    setCustomer(null);
  };

  const sendAccessRequest = async () => {
    setSendingAccess(true);
    try {
      const res = await postJSON('/api/catalog/access-requests', {
        company: access.company.trim(),
        contact: access.contact.trim(),
        phone: access.phone.trim(),
        address: access.address.trim(),
      });
      setAsking(false);
      setMessage(html`<b>Thank you.</b> ${res.message || ''}`);
    } catch (e) {
      // stay on the form so the details already typed are not lost behind an error
      setAsking(true);
      setMessage(html`<span class="c-accesserr">${e.message || 'Could not send your details.'}</span>`);
    }
    setSendingAccess(false);
  };

  const submit = async () => {
    setSubmitting(true);
    setLineErrors({});
    setMessage(null);

    // Lines and notes only. WHO is requesting comes from the signed access-code
    // session on the server — the browser cannot name a customer, so it cannot
    // submit a request in another company's name.
    const payload = {
      lines: toRequestLines(),
      notes: notes || null,
      deliveryAddress: address.trim() || null,
    };

    try {
      const res = await postJSON('/api/catalog/requests', payload);
      clearCart();
      setAsking(false);
      setNotes('');
      // The server ended the session with the order, so the next customer on this
      // phone must enter their own code. Mirror that here or the drawer would still
      // show the previous customer's name.
      lastTried.current = null;
      setCode('');
      setCustomer(null);
      setSubmitted({ reference: res.reference, items: res.items });
    } catch (e) {
      // The session expired or was never established — fall back to the code prompt
      // with the cart intact, rather than showing a bare error.
      if (e.body?.code === 'ACCESS_CODE_REQUIRED') {
        setCustomer(null);
        setAsking(false);
        setMessage('Please enter your access code to send this request.');
      } else {
        const errors = e.body?.errors || [];
        // drop what can never succeed, keep what the customer can still fix
        pruneUnavailable(errors);
        const general = errors.filter((x) => !x.barcode);
        setMessage(general.length ? general[0].message : 'Please check the highlighted products.');
        setLineErrors(Object.fromEntries(errors.filter((x) => x.barcode).map((x) => [x.barcode, x.message])));
      }
      await refresh();
    }
    setSubmitting(false);
  };

  const setAccessField = (key) => (e) => setAccess((a) => ({ ...a, [key]: e.target.value }));

  let customerBlock;
  if (asking) {
    customerBlock = html`
      <div class="c-accessform">
        <p class="c-hint">Give us your details and Box for Less will send you an access code.</p>
        <${Field} id="uContact" label="Your name">
          <input id="uContact" type="text" autoComplete="name" placeholder="Full name"
            value=${access.contact} onChange=${setAccessField('contact')} />
        <//>
        <${Field} id="uPhone" label="Phone">
          <input id="uPhone" type="tel" inputMode="tel" autoComplete="tel" placeholder="Phone number"
            value=${access.phone} onChange=${setAccessField('phone')} />
        <//>
        <${Field} id="uCompany" label="Company name (optional)">
          <input id="uCompany" type="text" autoComplete="organization" placeholder="Company, if any"
            value=${access.company} onChange=${setAccessField('company')} />
        <//>
        <${Field} id="uAddress" label="Delivery address" hint=${html`<div class="c-hint">We need this before we can supply you.</div>`}>
          <textarea id="uAddress" rows="3" autoComplete="street-address" required placeholder="Where should we deliver?"
            value=${access.address} onChange=${setAccessField('address')}></textarea>
        <//>
        <button type="button" class="c-btn" disabled=${sendingAccess} onClick=${sendAccessRequest}>
          ${sendingAccess ? 'Sending…' : 'Request an access code'}</button>
        <button type="button" class="c-link" onClick=${() => setAsking(false)}>← I have a code</button>
      </div>`;
  } else if (customer) {
    // The company name is the confirmation that the RIGHT code was used, and a
    // salesman moving between customers reads it before every submission — so it is
    // the largest thing in the panel, not a line of body text.
    customerBlock = html`
      <${Fragment}>
      <div class="c-selected">
        <div class="c-selected-label">Requesting as</div>
        <div class="c-selected-name">${customer.name}</div>
        <button type="button" class="c-link" onClick=${exitAccess}>Not you? Use a different code</button>
      </div>
      <${Field} id="reqAddress" label="Delivery address"
        hint=${html`<div class="c-hint">${customer.deliveryAddress
    ? 'Change it if this order goes somewhere else.'
    : 'We do not have an address for you yet.'}</div>`}>
        <textarea id="reqAddress" rows="3" autoComplete="street-address" placeholder="Where should we deliver?"
          value=${address} onChange=${(e) => setAddress(e.target.value)}></textarea>
      <//>
      <//>`;
  } else {
    // iOS NOTE, and do not "tidy" these attributes away:
    //   autoComplete="one-time-code" made Safari watch for an SMS passcode and
    //     re-evaluate the field on every keystroke, which dropped focus and shut the
    //     keyboard after each character. It must stay "off".
    //   inputMode="latin" is not a valid value (dropped from the spec); "text" is
    //     what gives a normal keyboard.
    //   enterKeyHint="go" labels the phone's return key, since Enter submits.
    customerBlock = html`
      <${Fragment}>
      <${Field} id="accessCode" label="Your access code"
        hint=${html`<div class="c-hint">Box for Less sent this to you with the catalogue link.</div>
          <div class="c-accesserr">${codeError}</div>`}>
        <input id="accessCode" type="text" name="bfl-access-code" inputMode="text"
          autoCapitalize="characters" autoComplete="off" autoCorrect="off"
          spellCheck=${false} enterKeyHint="go" placeholder="e.g. 7K2M-9XQR"
          value=${code} onChange=${(e) => onCodeInput(e.target.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); enterCode(code); } }} />
      <//>
      <button type="button" class="c-btn" disabled=${codeBusy} onClick=${() => enterCode(code)}>
        ${codeBusy ? 'Checking…' : 'Continue'}</button>
      <button type="button" class="c-link" onClick=${() => setAsking(true)}>I don't have a code</button>
      <//>`;
  }

  return html`
    <div ref=${drawerRef} id="cartDrawer" class=${`c-drawer${open ? '' : ' hidden'}`}>
      <div class="c-drawer-backdrop" onClick=${close}></div>
      ${submitted ? html`
        <section class="c-drawer-panel" role="dialog" aria-modal="true" aria-label="Request submitted" tabIndex="-1" ref=${panelRef}>
          <div class="c-okbox">
            <h2>Request submitted</h2>
            <p>Your reference is <b>${submitted.reference}</b> — ${submitted.items} product${submitted.items === 1 ? '' : 's'}.</p>
            <p class="c-smallprint">This is a request, not an order. Our team will confirm availability with you.</p>
            <p class="c-smallprint"><b>The next request needs its own access code.</b>
              This keeps one customer's order from being sent under another's name.</p>
            <button type="button" class="c-btn primary" onClick=${close}>Done</button>
          </div>
        </section>` : html`
        <section class="c-drawer-panel" role="dialog" aria-modal="true" aria-label="Your request" tabIndex="-1" ref=${panelRef}>
          <header class="c-drawer-head">
            <h2>Your request</h2>
            <button type="button" class="c-remove" aria-label="Close" onClick=${close}>×</button>
          </header>
          ${!canSubmit ? html`<div class="c-blocked">${blocked || 'Requests cannot be submitted right now.'}</div>` : null}
          ${message ? html`<div class="c-notice">${message}</div>` : null}
          <div class="c-lines">
            ${lines.length
    ? lines.map((l) => html`<${LineRow} key=${l.barcode} line=${l} error=${lineErrors[l.barcode]} />`)
    : html`<p class="c-empty-cart">Your request is empty.</p>`}
          </div>
          ${lines.length ? html`
            <${Fragment}>
              <div class="c-customer">${customerBlock}</div>
              <${Field} id="reqNotes" label="Notes (optional)">
                <textarea id="reqNotes" rows="2" placeholder="Anything we should know"
                  value=${notes} onChange=${(e) => setNotes(e.target.value)}></textarea>
              <//>
              <div class="c-drawer-actions">
                <button type="button" class="c-btn" onClick=${() => { clearCart(); setLineErrors({}); }}>Clear</button>
                <button type="button" class="c-btn primary" ref=${submitRef}
                  disabled=${!(canSubmit && customer) || submitting} onClick=${submit}>
                  ${submitting ? 'Submitting…' : 'Submit request'}</button>
              </div>
              <p class="c-smallprint">Submitting a request is not an order and does not reserve stock.
                Our team will confirm availability with you.</p>
            <//>` : null}
        </section>`}
    </div>`;
}
