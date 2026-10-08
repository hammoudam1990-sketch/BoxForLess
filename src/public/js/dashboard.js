// The staff dashboard, restyled after the light "Financial Dashboard" reference: a greeting band,
// rounded white cards, an orange accent, a bubble chart and an activity feed. Every number is read
// from the server. Nothing is estimated, and no percentage changes are shown, because the system
// keeps no history to compare with.
import { api, esc, num } from './api.js';

const when = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const dateLabel = () => new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' });
const ICON = {
  box: 'M4 7l8-4 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10',
  request: 'M7 3h10a1 1 0 0 1 1 1v17l-3.5-2-2.5 2-2.5-2L6 21V4a1 1 0 0 1 1-1zM9.5 8h5M9.5 12h5',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  check: 'M4 12l5 5L20 6',
  upload: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
};
const svg = (d) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;

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

/** Bubbles sized by product count, one per top-level category. */
function bubbles(tops) {
  const max = Math.max(1, ...tops.map((t) => t.count));
  const size = (n) => 46 + Math.sqrt(n / max) * 150;   // px diameter, 46..196
  return `<div class="bubbles" role="img" aria-label="${tops.map((t) => `${t.name} ${num(t.count)}`).join(', ')}">
    ${tops.map((t, i) => `
      <div class="bubble ${i === 0 ? 'hot' : ''}" style="width:${size(t.count).toFixed(0)}px;height:${size(t.count).toFixed(0)}px">
        <b>${num(t.count)}</b><span>${esc(t.name)}</span>
      </div>`).join('')}
  </div>`;
}

export async function renderDashboard(view) {
  const [stats, requests, access, reviews, stock, inStock, limited, out, imports, categories] = await Promise.all([
    api.stats(),
    api.requests({ limit: 8 }),
    api.accessRequests('PENDING'),
    api.reviews(),
    api.requestStockStatus(),
    api.products({ stock: 'in', limit: 1 }),
    api.products({ stock: 'limited', limit: 1 }),
    api.products({ stock: 'out', limit: 1 }),
    api.imports(),
    fetch('/api/catalog/categories?view=full').then((r) => (r.ok ? r.json() : { items: [] })).catch(() => ({ items: [] })),
  ]);

  const pendingReviews = reviews.counts?.total || 0;
  const waitingAccess = access.total || 0;
  const toAccept = requests.items.filter((r) => r.status === 'SUBMITTED').length;
  const active = stats.active || 0;
  const total = stats.total || 0;
  const inactive = Math.max(0, total - active);
  const activePct = total ? (active / total) * 100 : 0;
  const tops = (categories.items || []).filter((c) => c.level === 1).map((c) => ({ name: c.name, count: c.count }));

  // Tasks are counted from the same data as the rest of the app. Each one links to where it is done.
  const tasks = [
    { n: pendingReviews, label: 'Changes to review', href: '#/changes', icon: ICON.check },
    { n: waitingAccess, label: 'Access requests to approve', href: '#/access', icon: ICON.person },
    { n: toAccept, label: 'Recent requests to accept', href: '#/requests', icon: ICON.request },
    { n: stock.hasData && stock.fresh ? 0 : 1, label: 'Stock import needed', href: '#/imports', icon: ICON.upload },
  ];
  const taskTotal = tasks.reduce((n, t) => n + t.n, 0);

  // Recent activity: imports and customer requests, newest first.
  const activity = [
    ...imports.items.slice(0, 5).map((b) => ({ at: b.imported_at, text: `Product import “${b.filename}”`, sub: `${b.status} · ${num(b.total_rows || 0)} rows`, href: `#/imports/${b.id}`, icon: ICON.upload })),
    ...requests.items.slice(0, 5).map((r) => ({ at: r.submitted_at, text: `Request ${r.reference || `#${r.id}`} from ${customerName(r)}`, sub: `${num(r.item_count)} line${r.item_count === 1 ? '' : 's'}`, href: `#/requests/${r.id}`, icon: ICON.request })),
    ...access.items.slice(0, 3).map((a) => ({ at: a.created_at, text: `Access requested by ${a.company || a.contact || 'a company'}`, sub: 'Waiting for approval', href: '#/access', icon: ICON.person })),
  ].filter((a) => a.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8);

  view.innerHTML = `
    <section class="hero">
      <div class="hero-date">
        <span class="hero-day">${new Date().getDate()}</span>
        <span class="hero-month">${esc(dateLabel())}</span>
      </div>
      <div class="hero-text">
        <h1>Hey, need a hand?</h1>
        <p>You have <b>${num(taskTotal)}</b> ${taskTotal === 1 ? 'thing' : 'things'} to do today.</p>
      </div>
      <button class="hero-btn" type="button" data-scroll="tasks">Show my tasks <span aria-hidden="true">→</span></button>
    </section>

    <section class="dstats" aria-label="Summary">
      <a class="dstat" href="#/products">
        <span class="dstat-k">Active products</span>
        <span class="dstat-v">${num(active)}</span>
        <span class="dstat-s">of ${num(total)} in the Product Master</span>
      </a>
      <a class="dstat" href="#/requests">
        <span class="dstat-k">Active requests</span>
        <span class="dstat-v">${num(requests.total || 0)}</span>
        <span class="dstat-s">Submitted by customers</span>
      </a>
      <a class="dstat ${waitingAccess ? 'attn' : ''}" href="#/access">
        <span class="dstat-k">Access requests</span>
        <span class="dstat-v">${num(waitingAccess)}</span>
        <span class="dstat-s">${waitingAccess ? 'Companies waiting for a code' : 'Nobody waiting'}</span>
      </a>
      <a class="dstat ${pendingReviews ? 'attn' : ''}" href="#/changes">
        <span class="dstat-k">Changes to review</span>
        <span class="dstat-v">${num(pendingReviews)}</span>
        <span class="dstat-s">${pendingReviews ? 'Barcode or unit changes' : 'Nothing waiting'}</span>
      </a>
    </section>

    <div class="grid-main">
      <section class="dcard" id="tasks">
        <div class="dcard-head"><div><h2>My tasks</h2><p class="muted">Each one opens the place it is done</p></div></div>
        <ul class="tasks">
          ${tasks.map((t) => `
            <li>
              <a href="${t.href}" class="task ${t.n ? 'open' : ''}">
                <span class="task-icon">${svg(t.icon)}</span>
                <span class="task-label">${esc(t.label)}</span>
                <span class="task-n">${num(t.n)}</span>
              </a>
            </li>`).join('')}
        </ul>
      </section>

      <section class="dcard">
        <div class="dcard-head"><div><h2>Products by category</h2><p class="muted">Top-level categories, every product counted</p></div><a href="#/products">Open →</a></div>
        ${tops.length ? bubbles(tops) : '<p class="muted">No categories yet.</p>'}
      </section>
    </div>

    <div class="grid-row">
      <section class="dcard">
        <div class="dcard-head"><div><h2>Stock by level</h2><p class="muted">Every product, by free stock</p></div></div>
        <div class="levels">
          <div><span class="dot ok"></span>In stock <b>${num(inStock.total)}</b></div>
          <div><span class="dot warn"></span>Limited <b>${num(limited.total)}</b></div>
          <div><span class="dot off"></span>Out <b>${num(out.total)}</b></div>
        </div>
        <div class="stockbar" role="img" aria-label="In stock ${num(inStock.total)}, limited ${num(limited.total)}, out ${num(out.total)}">
          <i class="ok" style="flex:${inStock.total}"></i><i class="warn" style="flex:${limited.total}"></i><i class="off" style="flex:${out.total}"></i>
        </div>
        <div class="stock-note">
          <span class="dpill ${stock.hasData && stock.fresh ? 'ok' : 'err'}">${stock.hasData && stock.fresh ? 'Stock is current' : stock.hasData ? 'Stock is out of date' : 'No stock import yet'}</span>
          <p class="muted">${stock.hasData ? `Last import ${esc(when(stock.asOf))}.` : 'Run an Odoo import to enable requests.'}</p>
        </div>
      </section>

      <section class="dcard">
        <div class="dcard-head"><div><h2>Product health</h2></div></div>
        <div class="donut-wrap">
          <div class="donut" style="background: conic-gradient(var(--orange) 0 ${activePct.toFixed(2)}%, #e6e3dd ${activePct.toFixed(2)}% 100%)" role="img" aria-label="${num(active)} active, ${num(inactive)} inactive">
            <div class="donut-hole"><b>${num(total)}</b><span>products</span></div>
          </div>
          <ul class="dlegend">
            <li><i class="orange"></i>Active <b>${num(active)}</b></li>
            <li><i class="grey"></i>Inactive <b>${num(inactive)}</b></li>
            <li><i class="warn"></i>Data warnings <b>${num(stats.warnings || 0)}</b></li>
          </ul>
        </div>
      </section>
    </div>

    <div class="grid-row">
      <section class="dcard dcard-wide">
        <div class="dcard-head"><div><h2>Recent activity</h2><p class="muted">Imports, requests and access requests, newest first</p></div></div>
        ${activity.length ? `<ul class="feed">${activity.map((a) => `
          <li><a href="${a.href}">
            <span class="feed-icon">${svg(a.icon)}</span>
            <span class="feed-text"><b>${esc(a.text)}</b><span class="muted">${esc(a.sub)}</span></span>
            <span class="feed-time muted">${esc(when(a.at))}</span>
          </a></li>`).join('')}</ul>` : '<p class="muted">Nothing has happened yet.</p>'}
      </section>

      <section class="dcard">
        <div class="dcard-head"><div><h2>Requests</h2></div><a href="#/requests">View all →</a></div>
        ${requests.items.length ? requests.items.slice(0, 5).map((r) => `
          <a class="drow" href="#/requests/${r.id}">
            <span class="drow-t">${esc(customerName(r))}</span>
            <span class="muted">${esc(r.reference || `#${r.id}`)} · ${num(r.item_count)} line${r.item_count === 1 ? '' : 's'}</span>
            <span>${statusPill(r.status)}</span>
          </a>`).join('') : '<p class="muted">No requests yet.</p>'}
      </section>
    </div>`;

  // Scroll to the task list. (A #hash link would be read by the router as a page change.)
  view.querySelector('[data-scroll="tasks"]')?.addEventListener('click', () => {
    view.querySelector('#tasks')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
