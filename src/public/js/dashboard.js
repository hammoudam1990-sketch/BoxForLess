// The staff dashboard: what needs doing today, from the same data the rest of the staff app
// shows. Every number here is read from the server; nothing is estimated.
import { api, esc, num } from './api.js';

const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function customerName(r) {
  if (r.customer?.displayName) return r.customer.displayName;
  if (r.customer_name) return r.customer_name;
  return [r.unlisted_company, r.unlisted_contact].filter(Boolean).join(' · ') || '—';
}

function stockBanner(s) {
  if (!s.hasData) {
    return `<div class="stock-banner bad"><span>No completed stock import</span></div>
      <p class="muted" style="margin:8px 0 0">Customers cannot submit requests until an Odoo import runs.</p>`;
  }
  if (!s.fresh) {
    return `<div class="stock-banner bad"><span>Stock is out of date</span></div>
      <p class="muted" style="margin:8px 0 0">Last import ${esc(when(s.asOf))}. Customers cannot submit requests until a fresh import runs.</p>`;
  }
  return `<div class="stock-banner ok"><span>Stock is current</span></div>
    <p class="muted" style="margin:8px 0 0">Last import ${esc(when(s.asOf))}. Customers can submit requests.</p>`;
}

export async function renderDashboard(view) {
  const [stats, requests, access, reviews, stock] = await Promise.all([
    api.stats(),
    api.requests({ limit: 6 }),
    api.accessRequests('PENDING'),
    api.reviews(),
    api.requestStockStatus(),
  ]);

  const pendingReviews = reviews.counts?.total || 0;
  const waitingAccess = access.total || 0;
  const active = stats.active || 0;
  const total = stats.total || 0;
  const inactive = Math.max(0, total - active);
  const onPct = total ? (active / total) * 100 : 0;
  const quick = [
    ['#/products', 'Product Master', 'Find and edit products'],
    ['#/imports', 'Imports', 'Preview an Odoo export'],
    ['#/requests', 'Requests', 'Review customer requests'],
    ['#/access', 'Access requests', 'Approve new companies'],
    ['#/codes', 'Access codes', 'Send codes to customers'],
    ['scan.html', 'Scan', 'Scan a barcode'],
  ];

  view.innerHTML = `
    <div class="dash-hello">
      <div>
        <h1>${greeting()}</h1>
        <p>Here is what needs your attention today.</p>
      </div>
    </div>

    <section class="dash-tiles" aria-label="Summary">
      <a class="dash-tile" href="#/products">
        <span class="k">Active products</span>
        <span class="v">${num(active)}</span>
        <span class="s">of ${num(total)} in the Product Master</span>
      </a>
      <a class="dash-tile ${pendingReviews ? 'hot' : ''}" href="#/changes">
        <span class="k">Changes to review</span>
        <span class="v">${num(pendingReviews)}</span>
        <span class="s">${pendingReviews ? 'Barcode or unit changes waiting' : 'Nothing waiting'}</span>
      </a>
      <a class="dash-tile ${waitingAccess ? 'warn' : ''}" href="#/access">
        <span class="k">Access requests</span>
        <span class="v">${num(waitingAccess)}</span>
        <span class="s">${waitingAccess ? 'Companies asking for a code' : 'Nobody waiting'}</span>
      </a>
      <a class="dash-tile" href="#/requests">
        <span class="k">Active requests</span>
        <span class="v">${num(requests.total || 0)}</span>
        <span class="s">Submitted by customers</span>
      </a>
    </section>

    <div class="dash-cols">
      <div class="dash-col">
        <section class="dash-card">
          <div class="head"><h2>Recent requests</h2><a href="#/requests">View all →</a></div>
          ${requests.items.length ? requests.items.map((r) => `
            <a class="dash-row" href="#/requests/${r.id}">
              <span class="av" aria-hidden="true">${esc(initials(customerName(r)))}</span>
              <span>
                <span class="t">${esc(customerName(r))}</span>
                <span class="m" style="display:block">${esc(r.reference || `#${r.id}`)} · ${num(r.item_count)} line${r.item_count === 1 ? '' : 's'}</span>
              </span>
              <span class="end m">${esc(when(r.submitted_at))}</span>
            </a>`).join('') : '<p class="dash-empty">No requests yet.</p>'}
        </section>

        <section class="dash-card">
          <div class="head"><h2>Quick actions</h2></div>
          <div class="quick">
            ${quick.map(([href, label, hint]) => `<a href="${href}"><span>${esc(label)}</span><span class="muted" style="font-weight:500;font-size:14px">${esc(hint)}</span></a>`).join('')}
          </div>
        </section>
      </div>

      <div class="dash-col">
        <section class="dash-card">
          <div class="head"><h2>Stock</h2><a href="#/imports">Imports →</a></div>
          ${stockBanner(stock)}
        </section>

        <section class="dash-card">
          <div class="head"><h2>Product health</h2><a href="#/products">Open →</a></div>
          <div class="health" role="img" aria-label="${num(active)} active, ${num(inactive)} inactive">
            <i class="on" style="width:${onPct.toFixed(2)}%"></i><i class="off" style="width:${(100 - onPct).toFixed(2)}%"></i>
          </div>
          <div class="health-legend">
            <span><b>${num(active)}</b> active</span>
            <span><b>${num(inactive)}</b> inactive</span>
            <span><b>${num(stats.warnings || 0)}</b> data warnings</span>
          </div>
        </section>

        <section class="dash-card">
          <div class="head"><h2>Waiting for you</h2></div>
          ${access.items.length ? access.items.slice(0, 4).map((a) => `
            <a class="dash-row" href="#/access">
              <span class="av" aria-hidden="true">${esc(initials(a.company || a.contact))}</span>
              <span>
                <span class="t">${esc(a.company || '—')}</span>
                <span class="m" style="display:block">${esc(a.contact || '')} · asked ${esc(when(a.created_at))}</span>
              </span>
            </a>`).join('') : '<p class="dash-empty">No access requests are waiting.</p>'}
        </section>
      </div>
    </div>`;
}
