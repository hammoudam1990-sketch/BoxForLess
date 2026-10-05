// Staff view of submitted customer requests. READ-ONLY in Stage 3: there is no
// status workflow, no approval, no conversion to a quotation — those are later
// stages. This screen answers one question: what have customers asked for?
//
// Unlike the customer-facing catalog, staff DO see the stock timestamp and the
// snapshot figures, because judging a request needs them.
import { esc, num } from './api.js';

async function getJSON(url) {
  const res = await fetch(url);
  if (res.status === 401) window.location.assign('/staff/login');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmt(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? esc(ts) : d.toLocaleString();
}

/** The stock-freshness banner: the single thing that gates customer submissions. */
function stockBanner(status) {
  if (!status.hasData) {
    return `<div class="errbox">No completed stock import — customers <b>cannot submit requests</b>.
      Run an Odoo import to enable requests.</div>`;
  }
  if (!status.fresh) {
    return `<div class="errbox">Stock data is older than ${esc(status.freshnessHours)}h
      (last import ${fmt(status.asOf)}) — customers <b>cannot submit requests</b> until a fresh import runs.</div>`;
  }
  return `<div class="okbox">Stock current as of <b>${fmt(status.asOf)}</b> — customers can submit requests.</div>`;
}

/**
 * There are exactly two customer paths: EXISTING (selected from the imported
 * customer master) and NEW (details captured on the request). A New Customer is a
 * complete outcome, not a problem to resolve — no Odoo matching exists in this
 * phase — so it gets a neutral badge, never a warning.
 */
function customerTypeBadge(c) {
  const cls = c.type === 'EXISTING_CUSTOMER' ? 'ok' : 'info';
  return `<span class="pill ${cls}">${esc(c.label)}</span>`;
}

function customerCell(r) {
  const c = r.customer || { type: r.customer_id ? 'EXISTING_CUSTOMER' : 'NEW_CUSTOMER', label: r.customer_id ? 'EXISTING CUSTOMER' : 'NEW CUSTOMER', displayName: r.customer_name || [r.unlisted_company, r.unlisted_contact].filter(Boolean).join(' · ') };
  return `${esc(c.displayName || '—')} ${customerTypeBadge(c)}`;
}

export async function renderRequests(view) {
  const [status, list] = await Promise.all([
    getJSON('/api/requests/stock-status'),
    getJSON('/api/requests'),
  ]);

  const rows = list.items.map((r) => `
    <tr>
      <td><a href="#/requests/${r.id}"><b>${esc(r.reference || `#${r.id}`)}</b></a></td>
      <td>${customerCell(r)}</td>
      <td>${num(r.item_count)}</td>
      <td>${fmt(r.submitted_at)}</td>
      <td>${esc(r.status || '—')}</td>
    </tr>`).join('');

  view.innerHTML = `
    <h1>Customer requests</h1>
    ${stockBanner(status)}
    <div class="notice" style="margin:12px 0">
      A request is <b>not an order and not a reservation</b>. Stock is not held, so two
      customers can request the same cartons. Confirm availability before committing.
    </div>
    <div class="card">
      ${list.total === 0
    ? '<p class="muted">No requests submitted yet.</p>'
    : `<table>
            <thead><tr><th>Reference</th><th>Customer</th><th>Lines</th><th>Submitted</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
          <p class="muted" style="margin-top:10px">${list.items.length} of ${list.total}</p>`}
    </div>`;
}

export async function renderRequestDetail(view, id) {
  const { request, items, customer } = await getJSON(`/api/requests/${encodeURIComponent(id)}`);
  const c = customer || { type: 'NEW_CUSTOMER', label: 'NEW CUSTOMER', displayName: '', company: null, contact: null, phone: null };

  const lines = items.map((i) => `
    <tr>
      <td>${esc(i.product_name_at_request || '')}</td>
      <td>${esc(i.barcode_at_request || '')}</td>
      <td>${esc(i.box_uom_at_request || '')}</td>
      <td><b>${num(i.quantity_ctn)}</b> CTN</td>
      <td>${num(i.available_ctn_at_request)} CTN</td>
    </tr>`).join('');

  view.innerHTML = `
    <a class="back" href="#/requests">← All requests</a>
    <h1>${esc(request.reference || `Request #${request.id}`)}</h1>
    <div class="controls">
      <button type="button" class="button-link" data-export-request>Download Excel</button>
      ${request.status === 'SUBMITTED' ? '<button type="button" data-accept-request>Accept request</button>' : ''}
      <button type="button" class="danger" data-delete-request>Delete request</button>
    </div>
    <div class="card">
      <div class="kv">
        <div class="k">Customer</div><div><b>${esc(c.displayName || '—')}</b></div>
        <div class="k">Customer type</div><div>${customerTypeBadge(c)}</div>
        <div class="k">Submitted</div><div>${fmt(request.submitted_at)}</div>
        <div class="k">Status</div><div>${esc(request.status || '—')}</div>
        <div class="k">Validated against stock from</div><div>${fmt(request.stock_as_of)}</div>
      </div>
    </div>

    <div class="section-title">${c.type === 'EXISTING_CUSTOMER' ? 'Customer (from the customer list)' : 'New customer details'}</div>
    <div class="card">
      <div class="kv">
        ${c.company ? `<div class="k">${c.type === 'EXISTING_CUSTOMER' ? 'Customer' : 'Company'}</div><div>${esc(c.company)}</div>` : ''}
        ${c.contact ? `<div class="k">Contact name</div><div>${esc(c.contact)}</div>` : ''}
        ${c.phone ? `<div class="k">Phone</div><div>${esc(c.phone)}</div>` : ''}
        ${request.delivery_address ? `<div class="k">Delivery address</div><div>${esc(request.delivery_address)}</div>` : ''}
        ${request.notes ? `<div class="k">Notes</div><div>${esc(request.notes)}</div>` : ''}
      </div>
      ${c.type === 'NEW_CUSTOMER'
    ? `<p class="muted" style="margin-top:10px">Captured on this request. These details are not
         in the customer list; they will feed the Cash-on-Delivery workflow in a later phase.</p>`
    : '<p class="muted" style="margin-top:10px">Selected from the imported customer list.</p>'}
    </div>

    <div class="section-title">Requested items</div>
    <div class="card">
      <table>
        <thead><tr><th>Product</th><th>Barcode</th><th>Pack</th><th>Requested</th><th>Available when requested</th></tr></thead>
        <tbody>${lines}</tbody>
      </table>
      <p class="muted" style="margin-top:10px">
        Product name, barcode, pack and availability are <b>snapshots taken at submission</b>,
        so this request still reads correctly even if the product changes later.
      </p>
    </div>`;

  view.querySelector('[data-accept-request]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const res = await fetch(`/api/requests/${encodeURIComponent(id)}/accept`, { method: 'POST' });
      if (res.status === 401) { window.location.assign('/staff/login'); return; }
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      await renderRequestDetail(view, id);
    } catch (error) {
      window.alert(`Could not accept this request: ${error.message}`);
      button.disabled = false;
    }
  });

  view.querySelector('[data-delete-request]')?.addEventListener('click', async (event) => {
    if (!window.confirm(`Delete ${request.reference || 'this request'} and its item list? This cannot be undone.`)) return;
    event.currentTarget.disabled = true;
    try {
      const res = await fetch(`/api/requests/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.status === 401) { window.location.assign('/staff/login'); return; }
      if (!res.ok) throw new Error((await res.json()).error || `HTTP ${res.status}`);
      window.location.hash = '#/requests';
    } catch (error) {
      window.alert(`Could not delete this request: ${error.message}`);
      event.currentTarget.disabled = false;
    }
  });

  view.querySelector('[data-export-request]')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const res = await fetch(`/api/requests/${encodeURIComponent(id)}/export.xlsx`);
      if (res.status === 401) { window.location.assign('/staff/login'); return; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${request.reference || `request-${id}`}.xlsx`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      window.alert(`Could not download this request: ${error.message}`);
    } finally { button.disabled = false; }
  });
}

export default { renderRequests, renderRequestDetail };
