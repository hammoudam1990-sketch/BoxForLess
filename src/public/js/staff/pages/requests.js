// Staff view of submitted customer requests.
//
// Unlike the customer-facing catalog, staff DO see the stock timestamp and the
// snapshot figures, because judging a request needs them.
import { html, useState } from '../../lib/react.js';
import { useAsync } from '../../lib/hooks.js';
import { num, formatDateTime } from '../../lib/format.js';
import { api } from '../../api.js';
import { Pill, Async, KV, goto } from '../ui.js';

/** The stock-freshness banner: the single thing that gates customer submissions. */
function StockBanner({ status }) {
  if (!status.hasData) {
    return html`<div class="errbox">No completed stock import — customers <b>cannot submit requests</b>.
      Run an Odoo import to enable requests.</div>`;
  }
  if (!status.fresh) {
    return html`<div class="errbox">Stock data is older than ${status.freshnessHours}h
      (last import ${formatDateTime(status.asOf)}) — customers <b>cannot submit requests</b> until a fresh import runs.</div>`;
  }
  return html`<div class="okbox">Stock current as of <b>${formatDateTime(status.asOf)}</b> — customers can submit requests.</div>`;
}

/**
 * There are exactly two customer paths: EXISTING (selected from the imported
 * customer master) and NEW (details captured on the request). A New Customer is a
 * complete outcome, not a problem to resolve — no Odoo matching exists in this
 * phase — so it gets a neutral badge, never a warning.
 */
function CustomerTypeBadge({ customer: c }) {
  return html`<${Pill} tone=${c.type === 'EXISTING_CUSTOMER' ? 'ok' : 'info'}>${c.label}<//>`;
}

function CustomerCell({ request: r }) {
  const c = r.customer || {
    type: r.customer_id ? 'EXISTING_CUSTOMER' : 'NEW_CUSTOMER',
    label: r.customer_id ? 'EXISTING CUSTOMER' : 'NEW CUSTOMER',
    displayName: r.customer_name || [r.unlisted_company, r.unlisted_contact].filter(Boolean).join(' · '),
  };
  return html`${c.displayName || '—'} <${CustomerTypeBadge} customer=${c} />`;
}

export function RequestsPage() {
  const [showDeleted, setShowDeleted] = useState(false);
  const state = useAsync(async () => {
    const [status, list, withdrawn] = await Promise.all([
      api.requestStockStatus(),
      api.requests({ deleted: showDeleted }),
      // counted even when not shown, so the tab can say how many there are
      api.requests({ deleted: true, limit: 1 }),
    ]);
    return { status, list, withdrawn };
  }, [showDeleted]);

  return html`
    <h1>Customer requests</h1>
    <${Async} state=${state}>${({ status, list, withdrawn }) => html`
      <${StockBanner} status=${status} />
      <div class="notice" style=${{ margin: '12px 0' }}>
        A request is <b>not an order and not a reservation</b>. Stock is not held, so two
        customers can request the same cartons. Confirm availability before committing.
      </div>
      <div class="controls">
        <button type="button" class=${showDeleted ? 'ghost' : ''} onClick=${() => setShowDeleted(false)}>Active requests</button>
        <button type="button" class=${showDeleted ? '' : 'ghost'} onClick=${() => setShowDeleted(true)}>
          Withdrawn${withdrawn.total ? ` (${withdrawn.total})` : ''}
        </button>
      </div>
      ${showDeleted ? html`
        <div class="notice" style=${{ margin: '12px 0' }}>
          Withdrawn requests are <b>kept, not destroyed</b>. The customer, the lines and the
          quantities are all still here, and a request removed by mistake can be restored.
        </div>` : null}
      <div class="card">
        ${list.total === 0
    ? html`<p class="muted">${showDeleted ? 'Nothing has been withdrawn.' : 'No requests submitted yet.'}</p>`
    : html`
            <table>
              <thead><tr><th>Reference</th><th>Customer</th><th>Lines</th>
                <th>${showDeleted ? 'Withdrawn' : 'Submitted'}</th><th>Status</th></tr></thead>
              <tbody>
                ${list.items.map((r) => html`
                  <tr key=${r.id}>
                    <td><a href=${`#/requests/${r.id}`}><b>${r.reference || `#${r.id}`}</b></a></td>
                    <td><${CustomerCell} request=${r} /></td>
                    <td>${num(r.item_count)}</td>
                    <td>${formatDateTime(showDeleted ? r.deleted_at : r.submitted_at)}</td>
                    <td>${r.status || '—'}</td>
                  </tr>`)}
              </tbody>
            </table>
            <p class="muted" style=${{ marginTop: 10 }}>${list.items.length} of ${list.total}</p>`}
      </div>`}<//>`;
}

export function RequestDetailPage({ id }) {
  const state = useAsync(() => api.request(id), [id]);
  return html`<${Async} state=${state}>${(data) => html`<${RequestDetail} id=${id} data=${data} reload=${state.reload} />`}<//>`;
}

function RequestDetail({ id, data, reload }) {
  const { request, items, customer } = data;
  const [busy, setBusy] = useState(null);
  const c = customer || { type: 'NEW_CUSTOMER', label: 'NEW CUSTOMER', displayName: '', company: null, contact: null, phone: null };

  // Runs one action with the same shape every time: lock the button, report a
  // failure in a dialog, unlock. `then` runs only on success.
  const run = async (name, failure, action, then) => {
    setBusy(name);
    try {
      await action();
      if (then) then();
    } catch (error) {
      window.alert(`${failure}: ${error.message}`);
    }
    setBusy(null);
  };

  const accept = () => run('accept', 'Could not accept this request', () => api.acceptRequest(id), reload);
  const restore = () => run('restore', 'Could not restore this request', () => api.restoreRequest(id), reload);
  const withdraw = () => {
    if (!window.confirm(
      `Withdraw ${request.reference || 'this request'}?\n\n`
      + 'It leaves the active list but is kept in full — customer, lines and quantities — '
      + 'and can be restored from the Withdrawn tab.',
    )) return;
    run('withdraw', 'Could not withdraw this request', () => api.withdrawRequest(id), () => goto('#/requests'));
  };
  const download = () => run('export', 'Could not download this request', async () => {
    const url = URL.createObjectURL(await api.exportRequest(id));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${request.reference || `request-${id}`}.xlsx`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return html`
    <a class="back" href="#/requests">← All requests</a>
    <h1>${request.reference || `Request #${request.id}`}</h1>
    <div class="controls">
      <button type="button" class="button-link" disabled=${busy === 'export'} onClick=${download}>Download Excel</button>
      ${request.status === 'SUBMITTED'
    ? html`<button type="button" disabled=${busy === 'accept'} onClick=${accept}>Accept request</button>` : null}
      ${request.status === 'DELETED'
    ? html`<button type="button" disabled=${busy === 'restore'} onClick=${restore}>Restore request</button>`
    : html`<button type="button" class="danger" disabled=${busy === 'withdraw'} onClick=${withdraw}>Withdraw request</button>`}
    </div>
    <div class="card">
      <${KV} rows=${[
    ['Customer', html`<b>${c.displayName || '—'}</b>`],
    ['Customer type', html`<${CustomerTypeBadge} customer=${c} />`],
    ['Submitted', formatDateTime(request.submitted_at)],
    ['Status', request.status || '—'],
    request.deleted_at ? ['Withdrawn', formatDateTime(request.deleted_at)] : null,
    ['Validated against stock from', formatDateTime(request.stock_as_of)],
  ]} />
    </div>

    <div class="section-title">${c.type === 'EXISTING_CUSTOMER' ? 'Customer (from the customer list)' : 'New customer details'}</div>
    <div class="card">
      <${KV} rows=${[
    c.company ? [c.type === 'EXISTING_CUSTOMER' ? 'Customer' : 'Company', c.company] : null,
    c.contact ? ['Contact name', c.contact] : null,
    c.phone ? ['Phone', c.phone] : null,
    request.delivery_address ? ['Delivery address', request.delivery_address] : null,
    request.notes ? ['Notes', request.notes] : null,
  ]} />
      ${c.type === 'NEW_CUSTOMER'
    ? html`<p class="muted" style=${{ marginTop: 10 }}>Captured on this request. These details are not
         in the customer list; they will feed the Cash-on-Delivery workflow in a later phase.</p>`
    : html`<p class="muted" style=${{ marginTop: 10 }}>Selected from the imported customer list.</p>`}
    </div>

    <div class="section-title">Requested items</div>
    <div class="card">
      <table>
        <thead><tr><th>Product</th><th>Barcode</th><th>Pack</th><th>Requested</th><th>Available when requested</th></tr></thead>
        <tbody>
          ${items.map((i, n) => html`
            <tr key=${n}>
              <td>${i.product_name_at_request || ''}</td>
              <td>${i.barcode_at_request || ''}</td>
              <td>${i.box_uom_at_request || ''}</td>
              <td><b>${num(i.quantity_ctn)}</b> CTN</td>
              <td>${num(i.available_ctn_at_request)} CTN</td>
            </tr>`)}
        </tbody>
      </table>
      <p class="muted" style=${{ marginTop: 10 }}>
        Product name, barcode, pack and availability are <b>snapshots taken at submission</b>,
        so this request still reads correctly even if the product changes later.
      </p>
    </div>`;
}
