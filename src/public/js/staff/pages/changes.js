import { html, useState } from '../../lib/react.js';
import { useAsync } from '../../lib/hooks.js';
import { api } from '../../api.js';
import { Pill, Async, useToast, useRefreshBadges } from '../ui.js';

export function ChangesPage() {
  const state = useAsync(() => api.reviews(), []);
  const toast = useToast();
  const refreshBadges = useRefreshBadges();
  // the row being resolved, so only its buttons are disabled
  const [busy, setBusy] = useState(null);

  const resolve = async (c, kind, action) => {
    const key = `${kind}:${c.product_id}`;
    setBusy(key);
    try {
      if (kind === 'barcode') await api.resolveBarcode(Number(c.product_id), action);
      else await api.resolveUom(Number(c.product_id), action);
      toast(`${kind === 'barcode' ? 'Barcode' : 'UoM'} change ${action}ed`, 'ok');
      state.reload();
      refreshBadges();
    } catch (e) { toast(e.message, 'err'); }
    setBusy(null);
  };

  return html`
    <h1>Change Review</h1>
    <${Async} state=${state}>${({ counts, items }) => html`
      <div class="stats" style=${{ marginBottom: 16 }}>
        <div class="stat"><div class="n">${counts.total || 0}</div><div class="l">Pending total</div></div>
        <div class="stat"><div class="n">${counts.barcode || 0}</div><div class="l">Barcode changes</div></div>
        <div class="stat"><div class="n">${counts.uom || 0}</div><div class="l">UoM changes</div></div>
      </div>
      <div class="card">
        <h2>Pending reviews</h2>
        <p class="muted">An Odoo import never changes a barcode or UoM silently. Accept to apply the new value; reject to keep the current value.</p>
        ${items.length ? html`
          <table>
            <thead><tr>
              <th>Type</th><th>Product</th><th>Current</th><th>Incoming</th><th>Detected</th><th>Action</th>
            </tr></thead>
            <tbody>
              ${items.map((c) => {
    const kind = c.change_type === 'BARCODE_CHANGE_DETECTED' ? 'barcode' : 'uom';
    const disabled = busy === `${kind}:${c.product_id}`;
    return html`
                  <tr key=${`${kind}:${c.product_id}`}>
                    <td><${Pill} tone="info">${kind === 'barcode' ? 'Barcode' : 'UoM'}<//></td>
                    <td><a href=${`#/products/${c.product_id}`}>${c.product_name}</a><div class="muted">${c.current_barcode}</div></td>
                    <td>${c.old_value}</td>
                    <td><b>${c.new_value}</b></td>
                    <td class="muted">${c.created_at}</td>
                    <td style=${{ whiteSpace: 'nowrap' }}>
                      <button class="secondary" disabled=${disabled} onClick=${() => resolve(c, kind, 'accept')}>Accept</button>
                      <button class="ghost" disabled=${disabled} onClick=${() => resolve(c, kind, 'reject')}>Reject</button>
                    </td>
                  </tr>`;
  })}
            </tbody>
          </table>` : html`<div class="muted">Nothing to review. 🎉</div>`}
      </div>`}<//>`;
}
