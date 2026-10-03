// Staff view of submitted customer requests. READ-ONLY in Stage 3: there is no
// status workflow, no approval, no conversion to a quotation — those are later
// stages. This screen answers one question: what have customers asked for?
//
// Unlike the customer-facing catalog, staff DO see the stock timestamp and the
// snapshot figures, because judging a request needs them.
import { esc, num } from './api.js';

async function getJSON(url) {
  const res = await fetch(url);
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

function customerCell(r) {
  if (r.customer_name) return esc(r.customer_name);
  const who = [r.unlisted_company, r.unlisted_contact].filter(Boolean).map(esc).join(' · ');
  return `${who || '—'} <span class="pill warn">Not in customer master</span>`;
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
  const { request, items } = await getJSON(`/api/requests/${encodeURIComponent(id)}`);

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
    <div class="card">
      <div class="kv">
        <div class="k">Customer</div><div>${customerCell(request)}</div>
        ${request.odoo_customer_ref ? `<div class="k">Odoo customer ID</div><div>${esc(request.odoo_customer_ref)}</div>` : ''}
        ${request.unlisted_phone ? `<div class="k">Phone given</div><div>${esc(request.unlisted_phone)}</div>` : ''}
        <div class="k">Submitted</div><div>${fmt(request.submitted_at)}</div>
        <div class="k">Status</div><div>${esc(request.status || '—')}</div>
        <div class="k">Validated against stock from</div><div>${fmt(request.stock_as_of)}</div>
        ${request.notes ? `<div class="k">Notes</div><div>${esc(request.notes)}</div>` : ''}
      </div>
    </div>

    ${request.needs_customer_match ? `<div class="notice">This customer was <b>not in the customer master</b>.
      Match them to an Odoo customer before processing.</div>` : ''}

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
}

export default { renderRequests, renderRequestDetail };
