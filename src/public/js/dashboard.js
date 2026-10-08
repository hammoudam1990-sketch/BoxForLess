// The staff dashboard, laid out like the Tailgrids reference: summary cards with icons, a bar
// chart, a donut, and a recent-orders table. Every number is read from the server. Nothing is
// estimated, and no change percentages are shown because the system keeps no history to compare.
import { api, esc, num } from './api.js';

const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const ICON = {
  box: 'M4 7l8-4 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10',
  request: 'M7 3h10a1 1 0 0 1 1 1v17l-3.5-2-2.5 2-2.5-2L6 21V4a1 1 0 0 1 1-1zM9.5 8h5M9.5 12h5',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  check: 'M4 12l5 5L20 6',
};
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

function customerName(r) {
  if (r.customer?.displayName) return r.customer.displayName;
  if (r.customer_name) return r.customer_name;
  return [r.unlisted_company, r.unlisted_contact].filter(Boolean).join(' · ') || '—';
}

function statusPill(status) {
  const map = { SUBMITTED: ['warn', 'Submitted'], ACCEPTED: ['ok', 'Accepted'], DELETED: ['muted', 'Withdrawn'] };
  const [tone, label] = map[status] || ['muted', status || '—'];
  return `<span class="dpill ${tone}">${esc(label)}</span>`;
}

/** Bars for product counts by stock level, scaled to the largest. */
function barChart(bands) {
  const max = Math.max(1, ...bands.map((b) => b.n));
  return `<div class="dbars" role="img" aria-label="${bands.map((b) => `${b.label} ${num(b.n)}`).join(', ')}">
    ${bands.map((b) => `
      <div class="dbar-col">
        <span class="dbar-val">${num(b.n)}</span>
        <div class="dbar-track"><i style="height:${((b.n / max) * 100).toFixed(1)}%" class="${b.tone}"></i></div>
        <span class="dbar-lab">${esc(b.label)}</span>
      </div>`).join('')}
  </div>`;
}

export async function renderDashboard(view) {
  const [stats, requests, access, reviews, stock, inStock, limited, out] = await Promise.all([
    api.stats(),
    api.requests({ limit: 6 }),
    api.accessRequests('PENDING'),
    api.reviews(),
    api.requestStockStatus(),
    api.products({ stock: 'in', limit: 1 }),
    api.products({ stock: 'limited', limit: 1 }),
    api.products({ stock: 'out', limit: 1 }),
  ]);

  const pendingReviews = reviews.counts?.total || 0;
  const waitingAccess = access.total || 0;
  const activeRequests = requests.total || 0;
  const active = stats.active || 0;
  const total = stats.total || 0;
  const inactive = Math.max(0, total - active);
  const activePct = total ? (active / total) * 100 : 0;
  const bands = [
    { label: 'In stock', n: inStock.total, tone: 'ok' },
    { label: 'Limited', n: limited.total, tone: 'warn' },
    { label: 'Out', n: out.total, tone: 'off' },
  ];

  view.innerHTML = `
    <div class="dash-head">
      <div>
        <h1>Dashboard</h1>
        <p class="muted">${greeting()}. Here is what needs your attention.</p>
      </div>
    </div>

    <section class="dstats" aria-label="Summary">
      <a class="dstat" href="#/products">
        <span class="dstat-icon">${svg(ICON.box)}</span>
        <span class="dstat-k">Active products</span>
        <span class="dstat-v">${num(active)}</span>
        <span class="dstat-s">of ${num(total)} in the Product Master</span>
      </a>
      <a class="dstat" href="#/requests">
        <span class="dstat-icon">${svg(ICON.request)}</span>
        <span class="dstat-k">Active requests</span>
        <span class="dstat-v">${num(activeRequests)}</span>
        <span class="dstat-s">Submitted by customers</span>
      </a>
      <a class="dstat ${waitingAccess ? 'attn' : ''}" href="#/access">
        <span class="dstat-icon">${svg(ICON.person)}</span>
        <span class="dstat-k">Access requests</span>
        <span class="dstat-v">${num(waitingAccess)}</span>
        <span class="dstat-s">${waitingAccess ? 'Companies waiting for a code' : 'Nobody waiting'}</span>
      </a>
      <a class="dstat ${pendingReviews ? 'attn' : ''}" href="#/changes">
        <span class="dstat-icon">${svg(ICON.check)}</span>
        <span class="dstat-k">Changes to review</span>
        <span class="dstat-v">${num(pendingReviews)}</span>
        <span class="dstat-s">${pendingReviews ? 'Barcode or unit changes' : 'Nothing waiting'}</span>
      </a>
    </section>

    <div class="dcharts">
      <section class="dcard dcard-wide">
        <div class="dcard-head">
          <div><h2>Products by stock level</h2><p class="muted">Every product in the Product Master, by free stock</p></div>
          <a href="#/products">Open →</a>
        </div>
        ${barChart(bands)}
      </section>

      <section class="dcard">
        <div class="dcard-head"><div><h2>Product health</h2><p class="muted">Active against inactive</p></div></div>
        <div class="donut-wrap">
          <div class="donut" style="background: conic-gradient(var(--ok, #2f7d4f) 0 ${activePct.toFixed(2)}%, #d8d2c7 ${activePct.toFixed(2)}% 100%)" role="img" aria-label="${num(active)} active, ${num(inactive)} inactive">
            <div class="donut-hole"><b>${num(total)}</b><span>products</span></div>
          </div>
          <ul class="dlegend">
            <li><i class="ok"></i>Active <b>${num(active)}</b></li>
            <li><i class="off"></i>Inactive <b>${num(inactive)}</b></li>
            <li><i class="warn"></i>Data warnings <b>${num(stats.warnings || 0)}</b></li>
          </ul>
        </div>
      </section>
    </div>

    <div class="dcharts dcharts-2">
      <section class="dcard dcard-wide">
        <div class="dcard-head">
          <div><h2>Recent requests</h2><p class="muted">The latest orders from customers</p></div>
          <a href="#/requests">View all →</a>
        </div>
        ${requests.items.length ? `
        <div class="dtable-wrap"><table class="dtable">
          <thead><tr><th>Reference</th><th>Customer</th><th class="num">Lines</th><th>Submitted</th><th>Status</th></tr></thead>
          <tbody>${requests.items.map((r) => `
            <tr>
              <td><a href="#/requests/${r.id}"><b>${esc(r.reference || `#${r.id}`)}</b></a></td>
              <td>${esc(customerName(r))}</td>
              <td class="num">${num(r.item_count)}</td>
              <td class="muted">${esc(when(r.submitted_at))}</td>
              <td>${statusPill(r.status)}</td>
            </tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">No requests yet.</p>'}
      </section>

      <div class="dcol">
        <section class="dcard">
          <div class="dcard-head"><div><h2>Stock</h2></div><a href="#/imports">Imports →</a></div>
          ${stock.hasData && stock.fresh
            ? `<span class="dpill ok">Stock is current</span><p class="muted">Last import ${esc(when(stock.asOf))}. Customers can submit requests.</p>`
            : stock.hasData
              ? `<span class="dpill err">Stock is out of date</span><p class="muted">Last import ${esc(when(stock.asOf))}. Customers cannot submit requests until a fresh import runs.</p>`
              : `<span class="dpill err">No stock import yet</span><p class="muted">Customers cannot submit requests until an Odoo import runs.</p>`}
        </section>

        <section class="dcard">
          <div class="dcard-head"><div><h2>Waiting for a code</h2></div><a href="#/access">Open →</a></div>
          ${access.items.length ? access.items.slice(0, 4).map((a) => `
            <a class="drow" href="#/access">
              <span class="drow-t">${esc(a.company || '—')}</span>
              <span class="muted">${esc(a.contact || '')} · ${esc(when(a.created_at))}</span>
            </a>`).join('') : '<p class="muted">No access requests are waiting.</p>'}
        </section>
      </div>
    </div>`;
}
