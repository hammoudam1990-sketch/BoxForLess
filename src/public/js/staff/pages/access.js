// Staff screens for customer access codes, and for the companies asking for one.
//
// Everything here is behind the staff sign-in. The codes shown ARE the live codes
// customers use, so nothing in this file may ever be imported by the catalogue.
import { html, useState } from '../../lib/react.js';
import { useAsync, useDebounced } from '../../lib/hooks.js';
import { api } from '../../api.js';
import { Async, CopyButton, useRefreshBadges } from '../ui.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');

/** The message staff paste into WhatsApp or SMS. */
function invitation(name, code, catalogUrl) {
  return `Hello ${name},\n\n`
    + 'You can now browse the Box for Less catalogue and send us your request here:\n'
    + `${catalogUrl}\n\n`
    + `Your access code is: ${code}\n\n`
    + 'Enter this code when you send your request. Please keep it private — it is for your company only.';
}

// ---------------------------------------------------------------------------
// access codes
// ---------------------------------------------------------------------------

export function AccessCodesPage() {
  const [query, setQuery] = useState('');
  // Only the debounced term reaches the server. The search box lives OUTSIDE the
  // part that reloads, and React keeps it mounted, so it keeps its value, caret and
  // focus while the rows underneath are replaced. (This screen once rebuilt the
  // whole view on every search and dropped the keyboard mid-typing.)
  const term = useDebounced(query.trim(), 250);
  const state = useAsync(() => api.customerCodes({ q: term, limit: 500 }), [term]);
  const data = state.data;

  return html`
    <h1>Customer access codes</h1>
    <div class="notice" style=${{ margin: '12px 0' }}>
      Send a customer the catalogue link together with their code. The code
      <b>identifies</b> them, so they never search for their own company — which is
      why the customer list is no longer exposed to anyone holding the link.
    </div>
    <div class="card">
      <div class="controls">
        <input type="search" placeholder="Search customer name…" value=${query}
          onChange=${(e) => setQuery(e.target.value)} />
        <span class="muted">${data ? `${data.total} customer${data.total === 1 ? '' : 's'}` : ''}</span>
      </div>
      ${data ? html`
        <p class="muted" style=${{ margin: '10px 0' }}>
          <b>Copy message</b> puts a ready-to-send note on the clipboard — greeting,
          catalogue link and code — for pasting into WhatsApp.<br />
          Catalogue link: <span class="code">${data.catalogUrl || ''}</span>
          <${CopyButton} class="ghost" text=${data.catalogUrl || ''}>Copy link<//>
        </p>` : null}
      ${state.error ? html`<div class="errbox">${state.error.message}</div>`
    : !data ? html`<div class="muted">Loading…</div>`
      : html`
        <table>
          <thead><tr><th>Customer</th><th>Access code</th><th>Issued</th><th></th></tr></thead>
          <tbody>
            ${data.items.map((c) => html`<${CodeRow} key=${c.id} customer=${c} catalogUrl=${data.catalogUrl} onIssued=${state.reload} />`)}
          </tbody>
        </table>`}
    </div>`;
}

function CodeRow({ customer: c, catalogUrl, onIssued }) {
  const [busy, setBusy] = useState(false);
  const code = c.access_code_display;

  const issue = async () => {
    // Reissuing invalidates the code already sent to this customer, so it is
    // confirmed rather than done on a single click.
    if (c.access_code && !window.confirm(`Reissue the code for ${c.name}?\n\nTheir current code stops working immediately.`)) return;
    setBusy(true);
    try {
      await api.issueCustomerCode(c.id);
      onIssued();
    } catch (e) { window.alert(e.message); }
    setBusy(false);
  };

  return html`
    <tr>
      <td>${c.name}${c.is_active ? '' : html` <span class="badge">inactive</span>`}</td>
      <td class="code-value code">${code || html`<span class="muted">none</span>`}</td>
      <td class="muted">${when(c.access_code_issued_at)}</td>
      <td class="nowrap">
        ${c.access_code ? html`
          <${CopyButton} class="secondary" text=${code}>Copy code<//>
          <${CopyButton} text=${() => invitation(c.name, code, catalogUrl)}>Copy message<//>` : null}
        <button class="ghost" disabled=${busy} onClick=${issue}>${c.access_code ? 'Reissue' : 'Issue'}</button>
      </td>
    </tr>`;
}

// ---------------------------------------------------------------------------
// access requests
// ---------------------------------------------------------------------------

export function AccessRequestsPage() {
  const state = useAsync(() => api.accessRequests(), []);
  const refreshBadges = useRefreshBadges();
  // Shown after an approval. Deliberately NOT window.alert(): a browser dialog's
  // text cannot be selected or copied, so the code ended up somewhere staff could
  // only retype by hand.
  const [approved, setApproved] = useState(null);

  const approve = async (r) => {
    const res = await api.approveAccessRequest(r.id);
    setApproved(res);
    state.reload();
    refreshBadges();
  };
  const reject = async (r) => {
    const reason = window.prompt('Reject this request? You can note why (optional):', '');
    if (reason === null) return;
    await api.rejectAccessRequest(r.id, reason || null);
    state.reload();
    refreshBadges();
  };

  return html`
    ${approved ? html`
      <div class="card" style=${{ marginBottom: 14 }}>
        <div class="okbox">Approved — ${approved.name}</div>
        <p class="muted">Send this to the customer. You can see it again under Access Codes.</p>
        <p class="code code-large">${approved.display}</p>
        <div class="controls">
          <${CopyButton} class="secondary" text=${approved.display}>Copy code<//>
          <${CopyButton} text=${() => invitation(approved.name, approved.display, approved.catalogUrl)}>Copy message<//>
          <button class="ghost" onClick=${() => setApproved(null)}>Done</button>
        </div>
      </div>` : null}
    <h1>Access requests</h1>
    <${Async} state=${state}>${({ items }) => {
    const pending = items.filter((r) => r.status === 'PENDING');
    return html`
      <div class="notice" style=${{ margin: '12px 0' }}>
        Companies that opened the catalogue without a code and asked for one.
        Approving creates the customer and issues their code.
        ${pending.length ? html` <b>${pending.length} waiting for a decision.</b>` : null}
      </div>
      <div class="card">
        ${items.length === 0 ? html`<p class="muted">No one has asked for access yet.</p>` : html`
          <table>
            <thead><tr><th>Company / contact</th><th>Phone</th><th>Address</th><th>Asked</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${items.map((r) => html`<${RequestRow} key=${r.id} request=${r} onApprove=${approve} onReject=${reject} />`)}
            </tbody>
          </table>`}
      </div>`;
  }}<//>`;
}

function RequestRow({ request: r, onApprove, onReject }) {
  const [busy, setBusy] = useState(false);
  const act = (fn) => async () => {
    setBusy(true);
    try { await fn(r); } catch (e) { window.alert(e.message); }
    setBusy(false);
  };
  return html`
    <tr>
      <td><b>${r.company || '—'}</b><br /><span class="muted">${r.contact}</span></td>
      <td>${r.phone}</td>
      <td class="muted">${r.delivery_address || '—'}</td>
      <td class="muted">${when(r.created_at)}</td>
      <td><span class="badge">${r.status}</span></td>
      <td class="nowrap">
        ${r.status === 'PENDING' ? html`
          <button disabled=${busy} onClick=${act(onApprove)}>Approve</button>
          <button class="danger" disabled=${busy} onClick=${act(onReject)}>Reject</button>` : null}
      </td>
    </tr>`;
}
