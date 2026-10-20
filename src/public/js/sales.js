// The Sales Manager dashboard (/sales), after the "Sales Manager" mockup (Oct 2026). A separate
// app from the admin panel: its own sign-in, its own read-only API (/api/sales/overview).
//
// The mockup is money-led (GH¢ sales, credit limits, payments due, sales by rep). Phase 1 shows no
// price or amount anywhere, so this keeps the layout but counts what is really recorded:
// requests, order lines and cartons. The money panels return only when pricing is approved.
import { esc, num } from './api.js';

const svg = (d, cls = '') => `<svg ${cls ? `class="${cls}" ` : ''}viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  personPlus: 'M10 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 20a6.5 6.5 0 0 1 10.6-5M18 15v6M15 18h6',
  clipboard: 'M9 4h6v3H9zM7 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-1M9 12h6M9 16h4',
  swap: 'M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4',
  userQuestion: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
};

const STATUS = {
  SUBMITTED: { label: 'Pending approval', tone: 'amber', color: '#f5a524' },
  ACCEPTED: { label: 'Accepted', tone: 'green', color: '#22a85a' },
  DELETED: { label: 'Withdrawn', tone: 'red', color: '#ef4444' },
};
const statusOf = (k) => STATUS[k] || { label: k || '—', tone: 'grey', color: '#94a3b8' };
const pill = (status) => `<span class="ad-pill ${statusOf(status).tone}">${esc(statusOf(status).label)}</span>`;
const dateTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

function greeting(d) {
  const h = d.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
function waited(ts) {
  if (!ts) return '';
  const h = Math.max(0, (Date.now() - new Date(ts).getTime()) / 3600000);
  return h < 1 ? 'oldest: under 1h' : h < 48 ? `oldest: ${Math.floor(h)}h` : `oldest: ${Math.floor(h / 24)}d`;
}

function delta(current, previous) {
  if (!previous && !current) return { cls: 'flat', text: 'No change' };
  if (!previous) return { cls: 'up', text: `↑ ${num(current)} new` };
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return { cls: 'flat', text: '→ 0%' };
  return pct > 0 ? { cls: 'up', text: `↑ ${pct}%` } : { cls: 'down', text: `↓ ${Math.abs(pct)}%` };
}

function sparkline(values, color) {
  const W = 140; const H = 36;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(values.length === 1 ? 0 : (i * W) / (values.length - 1)).toFixed(1)},${(H - 3 - (H - 6) * (v / max)).toFixed(1)}`);
  return `<svg class="sm-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="M${pts.join(' L')} L${W},${H} L0,${H} Z" fill="${color}" opacity=".12"/>
    <path d="M${pts.join(' L')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

function areaChart(series) {
  const W = 560; const H = 230; const L = 34; const R = 10; const T = 12; const B = 28;
  const max = Math.max(4, ...series.map((s) => s.cartons));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const n = series.length;
  const x = (i) => L + (n === 1 ? 0 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const line = (key) => series.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s[key]).toFixed(1)}`).join(' ');
  const every = n <= 7 ? 1 : n <= 30 ? 5 : 15;
  const fmt = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `
    <svg class="ad-line-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cartons and requests per day">
      <defs><linearGradient id="smArea" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#2563eb" stop-opacity=".22"/><stop offset="1" stop-color="#2563eb" stop-opacity="0"/>
      </linearGradient></defs>
      ${[0, 1, 2, 3, 4].map((k) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(k * step)}" y2="${y(k * step)}"/>
        <text x="${L - 8}" y="${y(k * step) + 4}" text-anchor="end">${k * step}</text>`).join('')}
      ${series.map((s, i) => (i % every === 0 || i === n - 1)
        ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${fmt(s.date)}</text>` : '').join('')}
      <path d="${line('cartons')} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#smArea)"/>
      <path class="s2" d="${line('requests')}"/>
      <path class="s1" d="${line('cartons')}"/>
      ${series.map((s, i) => `<circle class="p1" cx="${x(i)}" cy="${y(s.cartons)}" r="${n > 30 ? 0 : 3}"><title>${fmt(s.date)}: ${s.cartons} cartons, ${s.requests} requests</title></circle>`).join('')}
    </svg>`;
}

function barList(rows, valueKey, unit, empty) {
  if (!rows.length) return `<p class="ad-empty">${esc(empty)}</p>`;
  const max = Math.max(1, ...rows.map((r) => r[valueKey]));
  return `<ol class="sm-bars">${rows.map((r) => `
    <li><span class="sm-bar-name" title="${esc(r.name)}">${esc(r.name)}<small>${num(r.requests)} request${r.requests === 1 ? '' : 's'}</small></span>
      <span class="sm-bar-track"><i style="width:${Math.max(4, (r[valueKey] / max) * 100)}%"></i></span>
      <b>${num(r[valueKey])} <small>${unit}</small></b></li>`).join('')}</ol>`;
}

function csvFor(data) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['Box for Less — sales summary', `last ${data.days} days`],
    [],
    ['Measure', 'This period', 'Previous period'],
    ['Requests', data.current.requests, data.previous.requests],
    ['Order lines', data.current.lines, data.previous.lines],
    ['Cartons requested', data.current.cartons, data.previous.cartons],
    ['Customers ordering', data.current.customers, data.previous.customers],
    [],
    ['Top customers', 'Requests', 'Cartons'],
    ...data.topCustomers.map((c) => [c.name, c.requests, c.cartons]),
    [],
    ['Top products', 'Requests', 'Cartons'],
    ...data.topProducts.map((p) => [p.name, p.requests, p.cartons]),
  ];
  return rows.map((r) => r.map(q).join(',')).join('\r\n');
}

async function fetchOverview(days) {
  const res = await fetch(`/api/sales/overview?days=${days}`);
  if (res.status === 401) { location.replace('/sales/login'); throw new Error('Signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status}).`);
  return body;
}

const LOADING = '<div class="card"><div class="sk-lines" role="status" aria-label="Loading"><i></i><i></i><i></i><i></i></div></div>';

export async function renderSalesManager(view, days = 30) {
  const data = await fetchOverview(days);
  const { current, previous, attention } = data;
  const today = new Date();

  const attn = [
    { tone: 'blue', icon: ICON.personPlus, n: attention.registrations, label: 'Registrations waiting' },
    { tone: 'amber', icon: ICON.clipboard, n: attention.pendingApproval, label: 'Requests awaiting approval', sub: waited(attention.oldestPending) },
    { tone: 'purple', icon: ICON.swap, n: attention.importChanges, label: 'Import changes to review' },
    { tone: 'red', icon: ICON.userQuestion, n: attention.unmatchedCustomers, label: 'Requests from unlisted customers' },
  ];
  const kpis = [
    { k: 'Requests', v: num(current.requests), d: delta(current.requests, previous.requests), spark: data.series.map((s) => s.requests), color: '#2563eb' },
    { k: 'Cartons requested', v: num(current.cartons), d: delta(current.cartons, previous.cartons), spark: data.series.map((s) => s.cartons), color: '#22a85a' },
    { k: 'Customers ordering', v: num(current.customers), d: delta(current.customers, previous.customers) },
    { k: 'Avg cartons per request', v: String(current.avgCartons), d: delta(current.avgCartons, previous.avgCartons) },
  ];
  const statusEntries = Object.entries(data.statusCounts);
  const statusTotal = statusEntries.reduce((n, [, c]) => n + c, 0);

  view.innerHTML = `
    <div class="ad-head">
      <div>
        <h1>${esc(greeting(today))}</h1>
        <p>${esc(today.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))} — here is what needs your attention.</p>
      </div>
      <div class="sm-tools">
        <select class="ad-select" id="smRange" aria-label="Period">
          ${[7, 30, 90].map((d) => `<option value="${d}"${d === data.days ? ' selected' : ''}>Last ${d} days</option>`).join('')}
        </select>
        <button type="button" class="sm-btn" id="smDownload">${svg(ICON.download)}Download report</button>
      </div>
    </div>

    <section class="sm-attn" aria-label="Needs attention">
      ${attn.map((a) => `
        <div class="sm-attn-card ${a.tone}${a.n ? ' has' : ''}">
          <span class="sm-attn-icon">${svg(a.icon)}</span>
          <span class="sm-attn-body"><b>${num(a.n)}</b><span>${esc(a.label)}</span>${a.sub && a.n ? `<small>${esc(a.sub)}</small>` : ''}</span>
        </div>`).join('')}
    </section>

    <section class="sm-kpis" aria-label="Summary for the last ${data.days} days">
      ${kpis.map((c) => `
        <div class="sm-kpi">
          <span class="sm-kpi-k">${esc(c.k)}</span>
          <span class="sm-kpi-row"><b>${c.v}</b><span class="ad-kpi-d ${c.d.cls}">${esc(c.d.text)}</span></span>
          <span class="sm-kpi-s">vs previous ${data.days} days</span>
          ${c.spark ? sparkline(c.spark, c.color) : ''}
        </div>`).join('')}
    </section>

    <div class="sm-grid">
      <section class="ad-card sm-span-2">
        <div class="ad-card-head"><h2>Recent requests</h2></div>
        ${data.recent.length ? `
          <div class="ad-table-wrap"><table class="ad-table">
            <thead><tr><th>Reference</th><th>Customer</th><th>Lines</th><th>Status</th><th>Submitted</th></tr></thead>
            <tbody>${data.recent.map((r) => `<tr>
              <td>${esc(r.reference || `#${r.id}`)}</td>
              <td>${esc(r.customer)}</td>
              <td>${num(r.lines)}</td>
              <td>${pill(r.status)}</td>
              <td>${esc(dateTime(r.submittedAt))}</td>
            </tr>`).join('')}</tbody></table></div>`
    : '<p class="ad-empty">No requests yet. They appear here as customers send them from the catalogue.</p>'}
      </section>

      <section class="ad-card">
        <div class="ad-card-head"><h2>Request status</h2></div>
        ${statusTotal ? `
          <div class="sm-stack" role="img" aria-label="Status split">${statusEntries.map(([k, c]) => `<i style="flex:${c};background:${statusOf(k).color}" title="${esc(statusOf(k).label)}: ${c}"></i>`).join('')}</div>
          <ul class="ad-dlegend">${statusEntries.map(([k, c]) => `<li><i style="background:${statusOf(k).color}"></i>${esc(statusOf(k).label)}<b>${num(c)} <small>(${Math.round((c / statusTotal) * 100)}%)</small></b></li>`).join('')}</ul>`
    : '<p class="ad-empty">No requests in this period.</p>'}
      </section>

      <section class="ad-card sm-span-2">
        <div class="ad-card-head"><h2>Requests over time</h2><span class="sm-sub">Last ${data.days} days</span></div>
        <div class="ad-legend"><span><i style="background:#2563eb"></i>Cartons</span><span><i style="background:#93b6f3"></i>Requests</span></div>
        ${areaChart(data.series)}
      </section>

      <section class="ad-card">
        <div class="ad-card-head"><h2>Top customers</h2></div>
        ${barList(data.topCustomers, 'cartons', 'ctn', 'No customer has ordered in this period.')}
      </section>

      <section class="ad-card sm-span-2">
        <div class="ad-card-head"><h2>Top products</h2></div>
        ${barList(data.topProducts, 'cartons', 'ctn', 'No products requested in this period.')}
      </section>

      <section class="ad-card sm-locked">
        <div class="ad-card-head"><h2>Coming with pricing</h2></div>
        <ul>
          <li>Sales value &amp; average order value</li>
          <li>Customers near their credit limit</li>
          <li>Payments due &amp; overdue</li>
          <li>Sales by rep</li>
        </ul>
        <p>These need prices and Odoo accounting data. Prices stay hidden until they are approved.</p>
      </section>
    </div>`;

  view.querySelector('#smRange').addEventListener('change', (e) => load(view, Number(e.target.value)));
  view.querySelector('#smDownload').addEventListener('click', () => {
    const blob = new Blob([`\ufeff${csvFor(data)}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sales-summary-${today.toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

function load(view, days) {
  view.innerHTML = LOADING;
  return renderSalesManager(view, days).catch((err) => {
    if (err.message !== 'Signed out') view.innerHTML = `<div class="card errbox">Error: ${esc(err.message)}</div>`;
  });
}

// ---- page boot: user menu, sign out, first load
const view = document.getElementById('view');
const userBtn = document.getElementById('userBtn');
const userMenu = document.getElementById('userMenu');
const openMenu = (open) => { userMenu.hidden = !open; userBtn.setAttribute('aria-expanded', String(open)); };
userBtn.addEventListener('click', () => openMenu(userMenu.hidden));
document.addEventListener('pointerdown', (e) => { if (!userMenu.hidden && !e.target.closest('.adm-user')) openMenu(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !userMenu.hidden) { openMenu(false); userBtn.focus(); } });
document.getElementById('salesLogout').addEventListener('click', async () => {
  await fetch('/api/sales/logout', { method: 'POST' }).catch(() => {});
  location.replace('/sales/login');
});
load(view, 30);
