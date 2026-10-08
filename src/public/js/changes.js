import { api, esc, toast } from './api.js';
import { refreshBadge } from './app.js';

export async function renderChanges(view) {
  const { counts, items } = await api.reviews();
  view.innerHTML = `
    <h1>Change Review</h1>
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="n">${counts.total || 0}</div><div class="l">Pending total</div></div>
      <div class="stat"><div class="n">${counts.barcode || 0}</div><div class="l">Barcode changes</div></div>
      <div class="stat"><div class="n">${counts.uom || 0}</div><div class="l">UoM changes</div></div>
    </div>
    <div class="card">
      <h2>Pending reviews</h2>
      <p class="muted">An Odoo import never changes a barcode or UoM silently. Accept to apply the new value; reject to keep the current value.</p>
      <div id="list">${items.length ? listHtml(items) : '<div class="muted">Nothing to review. 🎉</div>'}</div>
    </div>`;

  view.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { action, kind, pid } = btn.dataset;
      btn.disabled = true;
      try {
        if (kind === 'barcode') await api.resolveBarcode(Number(pid), action);
        else await api.resolveUom(Number(pid), action);
        toast(`${kind === 'barcode' ? 'Barcode' : 'UoM'} change ${action}ed`, 'ok');
        await renderChanges(view);
        refreshBadge();
      } catch (e) { toast(e.message, 'err'); btn.disabled = false; }
    });
  });
}

function listHtml(items) {
  return `<table><thead><tr>
    <th>Type</th><th>Product</th><th>Current</th><th>Incoming</th><th>Detected</th><th>Action</th>
  </tr></thead><tbody>
  ${items.map((c) => {
    const kind = c.change_type === 'BARCODE_CHANGE_DETECTED' ? 'barcode' : 'uom';
    return `<tr>
      <td><span class="pill info">${kind === 'barcode' ? 'Barcode' : 'UoM'}</span></td>
      <td><a href="#/products/${c.product_id}">${esc(c.product_name)}</a><div class="muted">${esc(c.current_barcode)}</div></td>
      <td>${esc(c.old_value)}</td>
      <td><b>${esc(c.new_value)}</b></td>
      <td class="muted">${esc(c.created_at)}</td>
      <td style="white-space:nowrap">
        <button class="secondary" data-action="accept" data-kind="${kind}" data-pid="${c.product_id}">Accept</button>
        <button class="ghost" data-action="reject" data-kind="${kind}" data-pid="${c.product_id}">Reject</button>
      </td>
    </tr>`;
  }).join('')}</tbody></table>`;
}
