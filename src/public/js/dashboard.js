// The staff dashboard, after the "Admin Dashboard" mockup (Oct 2026): four KPI cards, a requests
// chart, a status donut, recent orders, and a right rail with system status, quick actions and
// recent activity.
//
// Every number is read from the server. Where the mockup shows something that does not exist yet
// (sales in GH₵, Odoo numbers, a live Odoo connection), the dashboard shows what is true today
// instead: lines rather than money, "—" for the Odoo reference, and "Not connected" for Odoo.
import { api, esc, num } from './api.js';

const DAY = 24 * 60 * 60 * 1000;
const svg = (d, cls = '') => `<svg ${cls ? `class="${cls}" ` : ''}viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  box: 'M4 7l8-4 8 4-8 4-8-4zM4 7v10l8 4 8-4V7M12 11v10',
  people: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  doc: 'M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h4',
  stack: 'M12 3 3 7.5l9 4.5 9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5',
  upload: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  personPlus: 'M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 20a6.5 6.5 0 0 1 10.6-5M18 15v6M15 18h6',
  key: 'M14.5 9.5a4 4 0 1 1-1.2-2.8L21 14.5V18h-3.5v-2h-2v-2h-2',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  calendar: 'M4 6h16v15H4zM8 3v5M16 3v5M4 10h16',
  check: 'M4 12l5 5L20 6',
  chev: 'm9 6 6 6-6 6',
};
const DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';

const STATUS = {
  SUBMITTED: { label: 'Pending Approval', tone: 'amber', color: '#f5a524' },
  ACCEPTED: { label: 'Accepted', tone: 'green', color: '#22a85a' },
  DELETED: { label: 'Withdrawn', tone: 'red', color: '#ef4444' },
};

const time = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dateTime = (ts) => new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function ago(ts) {
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
/** Short time for the status list: today shows the time, older shows the date. */
function stamp(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toDateString() === new Date().toDateString() ? time(ts) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
const customerName = (r) => r.customer?.displayName || r.customer_name
  || [r.unlisted_company, r.unlisted_contact].filter(Boolean).join(' · ') || '—';
const pill = (status) => {
  const s = STATUS[status] || { label: status || '—', tone: 'grey' };
  return `<span class="ad-pill ${s.tone}">${esc(s.label)}</span>`;
};
const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Change between this week and the week before, as the KPI's second line. */
function delta(current, previous) {
  if (!previous && !current) return { cls: 'flat', text: 'No change' };
  if (!previous) return { cls: 'up', text: `↑ ${num(current)} new` };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { cls: 'flat', text: '→ 0%' };
  return pct > 0 ? { cls: 'up', text: `↑ ${pct}%` } : { cls: 'down', text: `↓ ${Math.abs(pct)}%` };
}

// ------------------------------------------------------------------ the requests line chart
function lineChart(all, days) {
  const today = startOfDay(Date.now());
  const buckets = Array.from({ length: days }, (_, i) => ({ t: today - (days - 1 - i) * DAY, requests: 0, lines: 0 }));
  for (const r of all) {
    if (!r.submitted_at) continue;
    const i = (startOfDay(r.submitted_at) - buckets[0].t) / DAY;
    if (i >= 0 && i < days) { buckets[i].requests += 1; buckets[i].lines += r.item_count || 0; }
  }
  const W = 560; const H = 230; const L = 34; const R = 10; const T = 12; const B = 28;
  const max = Math.max(4, ...buckets.map((b) => b.lines));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const x = (i) => L + (days === 1 ? 0 : (i * (W - L - R)) / (days - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const path = (key) => buckets.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b[key]).toFixed(1)}`).join(' ');
  const labelEvery = days <= 7 ? 1 : days <= 14 ? 2 : 5;
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const total = buckets.reduce((n, b) => n + b.requests, 0);
  return `
    <svg class="ad-line-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${num(total)} requests in the last ${days} days">
      <defs><linearGradient id="adArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2563eb" stop-opacity=".22"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/>
      </linearGradient></defs>
      ${[0, 1, 2, 3, 4].map((k) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(k * step)}" y2="${y(k * step)}"/>
        <text x="${L - 8}" y="${y(k * step) + 4}" text-anchor="end">${k * step}</text>`).join('')}
      ${buckets.map((b, i) => (i % labelEvery === 0 || i === days - 1)
        ? `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${T}" y2="${H - B}" opacity=".6"/><text x="${x(i)}" y="${H - 8}" text-anchor="middle">${fmt(b.t)}</text>` : '').join('')}
      <path class="a1" d="${path('lines')} L${x(days - 1)},${y(0)} L${x(0)},${y(0)} Z"/>
      <path class="s2" d="${path('requests')}"/>
      <path class="s1" d="${path('lines')}"/>
      ${buckets.map((b, i) => `<circle class="p1" cx="${x(i)}" cy="${y(b.lines)}" r="3.2"><title>${fmt(b.t)}: ${b.lines} lines</title></circle>
        <circle class="p2" cx="${x(i)}" cy="${y(b.requests)}" r="3"><title>${fmt(b.t)}: ${b.requests} requests</title></circle>`).join('')}
    </svg>`;
}

// ------------------------------------------------------------------ the status donut
function donut(counts) {
  const entries = Object.entries(STATUS).map(([key, s]) => ({ ...s, n: counts[key] || 0 }));
  const total = entries.reduce((n, e) => n + e.n, 0);
  const R = 70; const C = 2 * Math.PI * R;
  let offset = 0;
  const rings = total ? entries.filter((e) => e.n).map((e) => {
    const len = (e.n / total) * C;
    const ring = `<circle cx="95" cy="95" r="${R}" stroke="${e.color}" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"/>`;
    offset += len;
    return ring;
  }).join('') : `<circle cx="95" cy="95" r="${R}" stroke="var(--line)"/>`;
  const pct = (n) => (total ? `${((n / total) * 100).toFixed(1)}%` : '0%');
  return `
    <div class="ad-donut-wrap">
      <div class="ad-donut" role="img" aria-label="${entries.map((e) => `${e.label} ${e.n}`).join(', ')}">
        <svg viewBox="0 0 190 190">${rings}</svg>
        <div class="ad-donut-c"><b>${num(total)}</b><span>Total Requests</span></div>
      </div>
      <ul class="ad-dlegend">
        ${entries.map((e) => `<li><i style="background:${e.color}"></i>${esc(e.label)}<b>${num(e.n)} <small>(${pct(e.n)})</small></b></li>`).join('')}
      </ul>
    </div>`;
}

// ------------------------------------------------------------------ the page
export async function renderDashboard(view) {
  const [active, withdrawn, customers, access, reviews, stock, imports, customerImports] = await Promise.all([
    api.requests({ limit: 500 }),
    api.requests({ deleted: true, limit: 500 }),
    api.customerCodes({ limit: 1 }),
    api.accessRequests('PENDING'),
    api.reviews(),
    api.requestStockStatus(),
    api.imports(),
    api.customerImports().catch(() => ({ items: [] })),
  ]);

  const all = [...active.items, ...withdrawn.items];
  const now = Date.now();
  const inWindow = (r, from, to) => {
    const t = new Date(r.submitted_at).getTime();
    return t >= from && t < to;
  };
  const thisWeek = all.filter((r) => inWindow(r, now - 7 * DAY, now + DAY));
  const lastWeek = all.filter((r) => inWindow(r, now - 14 * DAY, now - 7 * DAY));
  const counts = all.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const pending = counts.SUBMITTED || 0;
  const pendingThis = thisWeek.filter((r) => r.status === 'SUBMITTED').length;
  const pendingLast = lastWeek.filter((r) => r.status === 'SUBMITTED').length;
  const linesThis = thisWeek.reduce((n, r) => n + (r.item_count || 0), 0);
  const linesLast = lastWeek.reduce((n, r) => n + (r.item_count || 0), 0);
  const waitingAccess = access.total || 0;
  const pendingReviews = reviews.counts?.total || 0;

  const kpis = [
    { tone: 'blue', icon: ICON.box, k: 'Total Orders', v: num(all.length), d: delta(thisWeek.length, lastWeek.length), href: '#/requests' },
    { tone: 'green', icon: ICON.people, k: 'Active Customers', v: num(customers.total || 0), d: { cls: 'flat', text: 'With a code' }, s: `${num(waitingAccess)} waiting for access`, href: '#/codes' },
    { tone: 'purple', icon: ICON.doc, k: 'Pending Approval', v: num(pending), d: delta(pendingThis, pendingLast), href: '#/requests' },
    { tone: 'amber', icon: ICON.stack, k: 'Order Lines', v: num(all.reduce((n, r) => n + (r.item_count || 0), 0)), d: delta(linesThis, linesLast), href: '#/requests' },
  ];

  // System status. Odoo is not connected yet (Phase 1); the Excel imports stand in for the sync.
  const lastImport = imports.items.find((b) => b.status === 'COMPLETED') || imports.items[0];
  const lastCustomers = (customerImports.items || []).find((b) => b.status === 'COMPLETED') || (customerImports.items || [])[0];
  const stockOk = stock.hasData && stock.fresh;
  const system = [
    { label: 'Odoo Connection', st: 'Not set up', cls: 'off', at: null },
    { label: 'Product Import', st: lastImport ? (lastImport.status === 'COMPLETED' ? 'Success' : lastImport.status) : 'None yet', cls: lastImport?.status === 'COMPLETED' ? 'ok' : 'warn', at: lastImport?.completed_at || lastImport?.imported_at },
    { label: 'Customer Import', st: lastCustomers ? (lastCustomers.status === 'COMPLETED' ? 'Success' : lastCustomers.status) : 'None yet', cls: lastCustomers?.status === 'COMPLETED' ? 'ok' : 'off', at: lastCustomers?.completed_at || lastCustomers?.imported_at },
    { label: 'Stock Data', st: stockOk ? 'Current' : stock.hasData ? 'Out of date' : 'No data', cls: stockOk ? 'ok' : 'warn', at: stock.asOf },
    { label: 'Change Review', st: pendingReviews ? `${num(pendingReviews)} pending` : 'Clear', cls: pendingReviews ? 'warn' : 'ok', at: null, t: pendingReviews ? 'review' : '' },
  ];
  const healthy = stockOk && !pendingReviews && lastImport?.status === 'COMPLETED';

  // Recent activity: requests, imports and access requests, newest first.
  const activity = [
    ...all.slice(0, 8).map((r) => (r.status === 'ACCEPTED'
      ? { at: r.updated_at || r.submitted_at, title: 'Order accepted', sub: `${r.reference} · ${customerName(r)}`, href: `#/requests/${r.id}`, icon: ICON.check, tone: 'green' }
      : { at: r.submitted_at, title: r.status === 'DELETED' ? 'Order withdrawn' : 'New order received', sub: `${r.reference} · ${customerName(r)}`, href: `#/requests/${r.id}`, icon: ICON.box, tone: r.status === 'DELETED' ? 'amber' : 'blue' })),
    ...imports.items.slice(0, 3).map((b) => ({ at: b.completed_at || b.imported_at, title: 'Product import', sub: `${b.filename} · ${num(b.total_rows || 0)} rows`, href: `#/imports/${b.id}`, icon: ICON.upload, tone: 'purple' })),
    ...(access.items || []).slice(0, 3).map((a) => ({ at: a.created_at, title: 'New customer registered', sub: a.company || a.contact || 'Waiting for approval', href: '#/access', icon: ICON.personPlus, tone: 'purple' })),
  ].filter((a) => a.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 5);

  const recent = [...active.items].sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at))).slice(0, 8);
  const today = new Date();

  view.innerHTML = `
    <div class="ad-head">
      <div>
        <h1>Admin Dashboard</h1>
        <p>Overview of your Box for Less platform</p>
      </div>
      <div class="ad-clock">${svg(ICON.calendar)}<span>${esc(today.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }))}<br><span id="adClock">${esc(time(today))}</span></span></div>
    </div>

    <div class="ad-layout">
      <div class="ad-main">
        <section class="ad-kpis" aria-label="Summary">
          ${kpis.map((c) => `
            <a class="ad-kpi ad-kpi-${c.tone}" href="${c.href}">
              <span class="ad-kpi-icon">${svg(c.icon)}</span>
              <span>
                <span class="ad-kpi-k">${esc(c.k)}</span>
                <span class="ad-kpi-v">${c.v}</span>
                <span class="ad-kpi-d ${c.d.cls}">${esc(c.d.text)}</span>
                <span class="ad-kpi-s">${esc(c.s || 'vs. last 7 days')}</span>
              </span>
            </a>`).join('')}
        </section>

        <div class="ad-charts">
          <section class="ad-card">
            <div class="ad-card-head">
              <h2>Orders Overview</h2>
              <select class="ad-select" id="chartRange" aria-label="Chart period">
                <option value="7">Last 7 days</option><option value="14">Last 14 days</option><option value="30">Last 30 days</option>
              </select>
            </div>
            <div class="ad-legend"><span><i style="background:#2563eb"></i>Order lines</span><span><i style="background:#93b6f3"></i>Orders</span></div>
            <div id="chartSlot">${lineChart(all, 7)}</div>
          </section>

          <section class="ad-card">
            <div class="ad-card-head"><h2>Order Status</h2></div>
            ${donut(counts)}
          </section>
        </div>

        <section class="ad-card">
          <div class="ad-card-head"><h2>Recent Orders</h2><a href="#/requests">View All →</a></div>
          ${recent.length ? `
            <div class="ad-table-wrap">
              <table class="ad-table">
                <thead><tr><th>BFL Reference</th><th>Odoo Reference</th><th>Customer</th><th>Lines</th><th>Status</th><th>Date</th><th><span class="sr-only">Open</span></th></tr></thead>
                <tbody>
                  ${recent.map((r) => `<tr>
                    <td><a href="#/requests/${r.id}">${esc(r.reference || `#${r.id}`)}</a></td>
                    <td class="muted" title="Odoo quotations arrive in Phase 4">—</td>
                    <td>${esc(customerName(r))}</td>
                    <td>${num(r.item_count)} line${r.item_count === 1 ? '' : 's'}</td>
                    <td>${pill(r.status)}</td>
                    <td>${esc(dateTime(r.submitted_at))}</td>
                    <td><a class="ad-row-menu" href="#/requests/${r.id}" aria-label="Open ${esc(r.reference || '')}">${DOTS}</a></td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>` : '<p class="ad-empty">No orders yet. They appear here as customers send requests from the catalogue.</p>'}
        </section>
      </div>

      <aside class="ad-rail" aria-label="Status and shortcuts">
        <section class="ad-card">
          <div class="ad-card-head"><h2>System Status</h2><span class="ad-status-pill ${healthy ? 'ok' : 'warn'}">${healthy ? 'All Operational' : 'Attention Needed'}</span></div>
          <ul class="ad-sys">
            ${system.map((s) => `<li><span class="dot ${s.cls}"></span><span>${esc(s.label)}</span><span class="st ${s.cls}">${esc(s.st)}</span><span class="t">${s.at ? esc(stamp(s.at)) : '—'}</span></li>`).join('')}
          </ul>
          <a class="ad-btn-row" href="#/imports">View Import History ${svg(ICON.chev)}</a>
        </section>

        <section class="ad-card">
          <div class="ad-card-head"><h2>Quick Actions</h2></div>
          <div class="ad-quick-list">
            ${[
              ['#/imports', ICON.upload, 'Import Products'],
              ['#/access', ICON.personPlus, `Approve Access Requests${waitingAccess ? ` (${num(waitingAccess)})` : ''}`],
              ['#/codes', ICON.key, 'Send a Customer Code'],
              ['#/requests', ICON.list, 'View Orders'],
            ].map(([href, icon, label]) => `<a class="ad-quick" href="${href}">${svg(icon, 'qi')}<span>${esc(label)}</span>${svg(ICON.chev, 'chev')}</a>`).join('')}
          </div>
        </section>

        <section class="ad-card">
          <div class="ad-card-head"><h2>Recent Activity</h2><a href="#/requests">View All</a></div>
          ${activity.length ? `<ul class="ad-feed">${activity.map((a) => `
            <li><a href="${a.href}">
              <span class="ad-feed-icon ${a.tone}">${svg(a.icon)}</span>
              <span><b>${esc(a.title)}</b><small>${esc(a.sub)} · ${esc(ago(a.at))}</small></span>
            </a></li>`).join('')}</ul>` : '<p class="ad-empty">Nothing has happened yet.</p>'}
        </section>
      </aside>
    </div>`;

  view.querySelector('#chartRange').addEventListener('change', (e) => {
    view.querySelector('#chartSlot').innerHTML = lineChart(all, Number(e.target.value));
  });
  // keep the clock current while the dashboard is open
  const clock = view.querySelector('#adClock');
  const timer = setInterval(() => {
    if (!clock.isConnected) { clearInterval(timer); return; }
    clock.textContent = time(new Date());
  }, 30000);
}
