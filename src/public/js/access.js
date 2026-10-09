// Staff screens for customer access codes, and for the companies asking for one.
//
// Everything here is behind the staff sign-in. The codes shown ARE the live codes
// customers use, so this module must never be imported by the catalog bundle.
import { api } from './api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` only exists in a SECURE CONTEXT. The staff shell is
 * normally opened over plain http on the LAN (http://192.168.x.x:3000), where it
 * is undefined — which is why Copy silently did nothing. The hidden-textarea +
 * execCommand route still works there, so it is the fallback rather than the
 * other way round.
 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the http-safe path */ }

  const ta = document.createElement('textarea');
  ta.value = text;
  // off-screen but still focusable; `display:none` cannot be selected
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-1000px';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  document.body.removeChild(ta);
  return ok;
}

/** Copy, and say so on the button itself so there is visible feedback. */
async function copyWithFeedback(button, text) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  const ok = await copyText(text);
  button.textContent = ok ? '✓ Copied' : 'Select it by hand';
  setTimeout(() => { button.textContent = original; }, ok ? 1400 : 2500);
  return ok;
}

/** The message staff paste into WhatsApp or SMS. */
function invitation(name, code, catalogUrl) {
  return `Hello ${name},\n\n`
    + 'You can now browse the Box for Less catalogue and send us your request here:\n'
    + `${catalogUrl}\n\n`
    + `Your access code is: ${code}\n\n`
    + 'Enter this code when you send your request. Please keep it private — it is for your company only.';
}

/**
 * One customer's row. Kept separate from the page shell because the shell —
 * crucially the search box — must survive a search.
 */
function codeRow(c) {
  return `
    <tr data-id="${c.id}">
      <td>${esc(c.name)}${c.is_active ? '' : ' <span class="badge">inactive</span>'}</td>
      <td class="code-value code">${c.access_code_display ? esc(c.access_code_display) : '<span class="muted">none</span>'}</td>
      <td class="muted">${when(c.access_code_issued_at)}</td>
      <td class="nowrap">
        ${c.access_code ? `
          <button class="secondary" data-copy>Copy code</button>
          <button data-copy-msg>Copy message</button>` : ''}
        <button class="ghost" data-issue>${c.access_code ? 'Reissue' : 'Issue'}</button>
      </td>
    </tr>`;
}

/**
 * Replace ONLY the table body and the count.
 *
 * This used to re-run renderAccessCodes(), which rewrote view.innerHTML — and that
 * destroyed the search box the operator was typing into. Searching is debounced, so
 * the rebuild landed a moment AFTER they paused: the first few characters arrived,
 * then focus vanished and everything typed next went nowhere. Never rebuild an
 * ancestor of the field that triggered the update.
 */
async function refreshCodeRows(view, query) {
  const data = await api.customerCodes({ q: query, limit: 500 });
  const body = view.querySelector('#codeRows');
  if (!body) return data;
  body.innerHTML = data.items.map(codeRow).join('');
  const count = view.querySelector('#codeCount');
  if (count) count.textContent = `${data.total} customer${data.total === 1 ? '' : 's'}`;
  wireCodeRows(view, data);
  return data;
}

export async function renderAccessCodes(view, query = '') {
  const data = await api.customerCodes({ q: query, limit: 500 });

  const rows = data.items.map(codeRow).join('');

  view.innerHTML = `
    <h1>Customer access codes</h1>
    <div class="notice" style="margin:12px 0">
      Send a customer the catalogue link together with their code. The code
      <b>identifies</b> them, so they never search for their own company — which is
      why the customer list is no longer exposed to anyone holding the link.
    </div>
    <div class="card">
      <div class="controls">
        <input id="codeSearch" type="search" placeholder="Search customer name…" value="${esc(query)}" />
        <span class="muted" id="codeCount">${data.total} customer${data.total === 1 ? '' : 's'}</span>
      </div>
      <p class="muted" style="margin:10px 0">
        <b>Copy message</b> puts a ready-to-send note on the clipboard — greeting,
        catalogue link and code — for pasting into WhatsApp.<br>
        Catalogue link: <span class="code">${esc(data.catalogUrl || '')}</span>
        <button class="ghost" data-copy-link>Copy link</button>
      </p>
      <table>
        <thead><tr><th>Customer</th><th>Access code</th><th>Issued</th><th></th></tr></thead>
        <tbody id="codeRows">${rows}</tbody>
      </table>
    </div>`;

  view.querySelector('[data-copy-link]')?.addEventListener('click', (e) => {
    copyWithFeedback(e.currentTarget, data.catalogUrl || '');
  });

  const search = view.querySelector('#codeSearch');
  let t;
  search.addEventListener('input', () => {
    clearTimeout(t);
    // Refreshes the ROWS only. Re-rendering the whole view here would destroy this
    // very input mid-search.
    t = setTimeout(() => refreshCodeRows(view, search.value.trim()), 250);
  });

  wireCodeRows(view, data);
}

/** Wire the per-row buttons. Re-run whenever the rows are replaced. */
function wireCodeRows(view, data) {
  const codeOf = (btn) => btn.closest('tr').querySelector('.code-value').textContent.trim();
  const nameOf = (btn) => btn.closest('tr').querySelector('td').textContent.trim();

  view.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    copyWithFeedback(b, codeOf(b));
  }));

  view.querySelectorAll('[data-copy-msg]').forEach((b) => b.addEventListener('click', () => {
    copyWithFeedback(b, invitation(nameOf(b), codeOf(b), data.catalogUrl));
  }));

  view.querySelectorAll('[data-issue]').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    // Reissuing invalidates the code already sent to this customer, so it is
    // confirmed rather than done on a single click.
    if (codeOf(b) !== 'none'
      && !window.confirm(`Reissue the code for ${nameOf(b)}?\n\nTheir current code stops working immediately.`)) return;
    b.disabled = true;
    try {
      await api.issueCustomerCode(row.dataset.id);
      await refreshCodeRows(view, view.querySelector('#codeSearch')?.value.trim() || '');
    } catch (e) {
      b.disabled = false;
      window.alert(e.message);
    }
  }));
}

export async function renderAccessRequests(view, approved = null) {
  const data = await api.accessRequests();
  const pending = data.items.filter((r) => r.status === 'PENDING');
  const snapshot = JSON.stringify(data.items.map((r) => [r.id, r.status, r.updated_at]));

  // Shown after an approval. Deliberately NOT window.alert(): a browser dialog's
  // text cannot be selected or copied, so the code ended up somewhere staff could
  // only retype by hand.
  const approvedPanel = approved ? `
    <div class="card" style="margin-bottom:14px">
      <div class="okbox">Approved — ${esc(approved.name)}</div>
      <p class="muted">Send this to the customer. You can see it again under Access Codes.</p>
      <p class="code code-large">${esc(approved.display)}</p>
      <div class="controls">
        <button class="secondary" data-copy-new-code>Copy code</button>
        <button data-copy-new-msg>Copy message</button>
        <button class="ghost" data-dismiss-approved>Done</button>
      </div>
    </div>` : '';

  const rows = data.items.map((r) => `
    <tr data-id="${r.id}">
      <td><b>${esc(r.company || r.contact)}</b>${r.company ? `<br><span class="muted">${esc(r.contact)}</span>` : ''}</td>
      <td>${esc(r.phone)}</td>
      <td class="muted">${esc(r.delivery_address || '—')}</td>
      <td class="muted">${when(r.created_at)}</td>
      <td><span class="badge">${esc(r.status)}</span></td>
      <td class="nowrap">
        ${r.status === 'PENDING' ? `
          <button data-approve>Approve</button>
          <button class="danger" data-reject>Reject</button>` : ''}
      </td>
    </tr>`).join('');

  view.innerHTML = `
    ${approvedPanel}
    <h1>Access requests</h1>
    <div class="notice" style="margin:12px 0">
      People who opened the catalogue without a code and asked for one.
      Approving creates the customer and issues their code.
      ${pending.length ? `<b>${pending.length} waiting for a decision.</b>` : ''}
    </div>
    <p class="muted" data-access-refresh-error role="status" aria-live="polite"></p>
    <div class="card">
      ${data.items.length === 0
    ? '<p class="muted">No one has asked for access yet.</p>'
    : `<table>
            <thead><tr><th>Customer / business</th><th>Phone</th><th>Address</th><th>Asked</th><th>Status</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`}
    </div>`;

  if (approved) {
    view.querySelector('[data-copy-new-code]')?.addEventListener('click', (e) => {
      copyWithFeedback(e.currentTarget, approved.display);
    });
    view.querySelector('[data-copy-new-msg]')?.addEventListener('click', (e) => {
      copyWithFeedback(e.currentTarget, invitation(approved.name, approved.display, approved.catalogUrl));
    });
    view.querySelector('[data-dismiss-approved]')?.addEventListener('click', () => renderAccessRequests(view));
  }

  view.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    b.disabled = true;
    try {
      await renderAccessRequests(view, await api.approveAccessRequest(row.dataset.id));
    } catch (e) {
      b.disabled = false;
      window.alert(e.message);
    }
  }));

  view.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const row = b.closest('tr');
    const reason = window.prompt('Reject this request? You can note why (optional):', '');
    if (reason === null) return;
    b.disabled = true;
    try {
      await api.rejectAccessRequest(row.dataset.id, reason || null);
      await renderAccessRequests(view);
    } catch (e) {
      b.disabled = false;
      window.alert(e.message);
    }
  }));

  clearInterval(view.accessRequestPollTimer);
  let polling = false;
  view.accessRequestPollTimer = setInterval(async () => {
    if (!view.isConnected || location.hash.split('/')[1] !== 'access') {
      clearInterval(view.accessRequestPollTimer);
      return;
    }
    if (polling) return;
    polling = true;
    try {
      const latest = await api.accessRequests();
      const nextSnapshot = JSON.stringify(latest.items.map((r) => [r.id, r.status, r.updated_at]));
      if (nextSnapshot !== snapshot) await renderAccessRequests(view, approved);
      else {
        const error = view.querySelector('[data-access-refresh-error]');
        if (error) error.textContent = '';
      }
    } catch (e) {
      const error = view.querySelector('[data-access-refresh-error]');
      if (error) error.textContent = `Could not refresh access requests: ${e.message}`;
    } finally {
      polling = false;
    }
  }, 10000);
}

export default { renderAccessCodes, renderAccessRequests };
