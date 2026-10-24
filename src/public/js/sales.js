import { esc, num } from './api.js';

const view = document.getElementById('view');
const sidebar = document.getElementById('smSidebar');
const scrim = document.getElementById('smScrim');
const menuToggle = document.getElementById('smMenuToggle');
const searchInput = document.getElementById('smSearch');
const userBtn = document.getElementById('userBtn');
const userMenu = document.getElementById('userMenu');

const ICON = {
  requests: 'M7 3h10l3 3v15H4V3zM8 10h8M8 14h8M8 18h5',
  pending: 'M12 7v5l3 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  customers: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3.5 4.8',
  products: 'm12 3 9 5v8l-9 5-9-5V8zM3.5 8.2 12 13l8.5-4.8M12 13v8',
  download: 'M12 3v12m-5-5 5 5 5-5M4 20h16',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'm15 18-6-6 6-6M20 12H9',
  search: 'M10.8 10.8m-6.8 0a6.8 6.8 0 1 0 13.6 0a6.8 6.8 0 1 0-13.6 0M16 16l5 5',
  empty: 'M4 5h16v14H4zM8 9h8M8 13h8M8 17h5',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[name]}"/></svg>`;
const dateTime = (ts) => ts
  ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—';

function statusLabel(status) {
  if (status === 'SUBMITTED') return '<span class="sm-status pending">Pending</span>';
  if (status === 'ACCEPTED') return '<span class="sm-status accepted">Accepted</span>';
  if (status === 'DELETED') return '<span class="sm-status withdrawn">Withdrawn</span>';
  return `<span class="sm-status other">${esc(status || '—')}</span>`;
}

async function apiGet(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
  if (response.status === 401) {
    location.replace('/sales/login');
    throw new Error('Signed out');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function parseRoute() {
  const hash = location.hash.slice(1) || '/dashboard';
  const [pathname, query = ''] = hash.split('?');
  return { parts: pathname.split('/').filter(Boolean), query: new URLSearchParams(query) };
}

function navigate(path) {
  location.hash = `/${path}`;
}

function setActiveNav(route) {
  document.querySelectorAll('.sm-nav [data-route], .sm-sidebar-bottom [data-route]').forEach((link) => {
    const active = link.dataset.route === route;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function setPendingBadge(count) {
  for (const badge of [document.getElementById('smPendingBadge'), document.getElementById('smNotificationBadge')]) {
    badge.hidden = !count;
    badge.textContent = count > 99 ? '99+' : String(count);
  }
}

function csvDownload(filename, rows) {
  const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const csv = `\ufeff${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pageHead(title, subtitle, actions = '') {
  return `<header class="sm-page-head"><div><div class="sm-eyebrow">Sales Manager</div><h1>${esc(title)}</h1><p>${esc(subtitle)}</p></div><div class="sm-actions">${actions}</div></header>`;
}

function emptyState(title, message = 'There is no data to show yet.') {
  return `<div class="sm-empty">${icon('empty')}<p><b>${esc(title)}</b></p><p>${esc(message)}</p></div>`;
}

function errorState(error) {
  return `<div class="sm-error" role="alert">${esc(error.message || 'Something went wrong. Please try again.')}</div>`;
}

function statusOptions(selected = 'all') {
  return [['all', 'All statuses'], ['pending', 'Pending'], ['accepted', 'Accepted'], ['withdrawn', 'Withdrawn']]
    .map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
}

function recentTable(rows) {
  if (!rows.length) return emptyState('No requests yet', 'Customer requests will appear here when submitted.');
  return `<div class="sm-table-wrap"><table class="sm-table">
    <thead><tr><th>Reference</th><th>Customer</th><th>Items (CTN)</th><th>Submitted</th><th>Status</th><th>Action</th></tr></thead>
    <tbody>${rows.map((request) => `<tr>
      <td class="primary-text">${esc(request.reference || `REQ-${request.id}`)}</td>
      <td>${esc(request.customer)}</td>
      <td>${num(request.cartons ?? request.lines)}</td>
      <td>${esc(dateTime(request.submittedAt))}</td>
      <td>${statusLabel(request.status)}</td>
      <td><div class="sm-table-actions">
        <button class="sm-table-btn" type="button" data-view-request="${request.id}">${icon('eye')}View</button>
        <button class="sm-table-btn" type="button" data-export-request="${request.id}" aria-label="Export ${esc(request.reference || `request ${request.id}`)}">${icon('download')}Export</button>
      </div></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function barChart(series) {
  const width = 760;
  const height = 250;
  const left = 38;
  const right = 8;
  const top = 14;
  const bottom = 34;
  const maxValue = Math.max(4, ...series.flatMap((item) => [item.requests, item.accepted]));
  const step = Math.max(1, Math.ceil(maxValue / 4));
  const chartMax = step * 4;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const groupWidth = plotWidth / Math.max(series.length, 1);
  const barWidth = Math.min(16, Math.max(3, groupWidth * .3));
  const y = (value) => top + plotHeight * (1 - value / chartMax);
  const dateLabel = (date) => new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const labelEvery = series.length <= 14 ? 1 : series.length <= 30 ? 4 : 7;
  return `<div class="sm-chart-wrap"><svg class="sm-bar-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Requests submitted and accepted per day">
    ${[0, 1, 2, 3, 4].map((i) => {
      const gy = y(i * step);
      return `<line class="gridline" x1="${left}" x2="${width - right}" y1="${gy}" y2="${gy}"/><text class="axis-label" x="${left - 8}" y="${gy + 3}" text-anchor="end">${i * step}</text>`;
    }).join('')}
    ${series.map((item, index) => {
      const center = left + (index + .5) * groupWidth;
      const submittedX = center - barWidth - 1;
      const acceptedX = center + 1;
      const submittedY = y(item.requests);
      const acceptedY = y(item.accepted);
      const showLabel = series.length <= 14;
      return `<rect class="bar-submitted" x="${submittedX}" y="${submittedY}" width="${barWidth}" height="${Math.max(0, top + plotHeight - submittedY)}" rx="2"><title>${dateLabel(item.date)}: ${item.requests} submitted</title></rect>
        <rect class="bar-accepted" x="${acceptedX}" y="${acceptedY}" width="${barWidth}" height="${Math.max(0, top + plotHeight - acceptedY)}" rx="2"><title>${dateLabel(item.date)}: ${item.accepted} accepted</title></rect>
        ${showLabel && item.requests ? `<text class="bar-value" x="${submittedX + barWidth / 2}" y="${Math.max(10, submittedY - 4)}" text-anchor="middle">${item.requests}</text>` : ''}
        ${index % labelEvery === 0 || index === series.length - 1 ? `<text class="axis-label" x="${center}" y="${height - 8}" text-anchor="middle">${dateLabel(item.date)}</text>` : ''}`;
    }).join('')}
  </svg></div>`;
}

function stockPanel(stock) {
  const total = stock.total || 0;
  const inPercent = total ? Math.round(stock.inStock / total * 100) : 0;
  const limitedPercent = total ? Math.round(stock.limited / total * 100) : 0;
  const outPercent = Math.max(0, 100 - inPercent - limitedPercent);
  const limitedEnd = inPercent + limitedPercent;
  const rows = [
    ['blue', 'In stock', stock.inStock, inPercent],
    ['amber', 'Limited stock', stock.limited, limitedPercent],
    ['red', 'Out of stock', stock.outOfStock, outPercent],
  ];
  return `<div class="sm-stock-content">
    <div class="sm-donut${total ? '' : ' no-data'}" style="--in-stock:${inPercent}%;--limited-end:${limitedEnd}%" role="img" aria-label="${num(total)} active products: ${num(stock.inStock)} in stock, ${num(stock.limited)} limited, ${num(stock.outOfStock)} out of stock">
      <div class="sm-donut-center"><b>${num(total)}</b><span>Active products</span></div>
    </div>
    <ul class="sm-stock-legend">${rows.map(([tone, label, value, percent]) => `<li><i class="sm-legend-dot ${tone}" aria-hidden="true"></i><span>${label}</span><b>${num(value)} <small>${percent}%</small></b></li>`).join('')}</ul>
  </div>`;
}

async function renderDashboard(days) {
  const data = await apiGet(`/api/sales/overview?days=${days}`);
  const pending = data.attention.pendingApproval || 0;
  setPendingBadge(pending);
  const inventory = data.inventory || { total: 0, inStock: 0, limited: 0, outOfStock: 0 };
  const availablePercent = inventory.total ? Math.round(inventory.inStock / inventory.total * 100) : 0;
  const today = new Date();

  view.innerHTML = `
    ${pageHead('Sales Manager Dashboard', `Overview of requests, customers and product availability · ${today.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
      `<label class="sr-only" for="smRange">Dashboard date range</label><select class="sm-select" id="smRange">${[7, 14, 30, 90].map((n) => `<option value="${n}"${n === data.days ? ' selected' : ''}>Last ${n} days</option>`).join('')}</select><button class="sm-btn" id="smDownload" type="button">${icon('download')}Download report</button>`)}
    <section class="sm-kpis" aria-label="Key metrics">
      <button class="sm-kpi-card" type="button" data-route-to="requests?status=all">
        <span class="sm-kpi-icon">${icon('requests')}</span><span class="sm-kpi-copy"><span class="sm-kpi-label">Total Requests Today</span><b class="sm-kpi-value">${num(data.today.requests)}</b><span class="sm-kpi-sub"><span class="sm-kpi-delta">${num(data.today.cartons)} cartons requested</span></span></span><span class="sm-kpi-arrow">›</span>
      </button>
      <button class="sm-kpi-card" type="button" data-route-to="requests?status=pending">
        <span class="sm-kpi-icon amber">${icon('pending')}</span><span class="sm-kpi-copy"><span class="sm-kpi-label">Pending Review</span><b class="sm-kpi-value">${num(pending)}</b><span class="sm-kpi-sub">Requests awaiting review</span></span><span class="sm-kpi-arrow">›</span>
      </button>
      <button class="sm-kpi-card" type="button" data-route-to="customers">
        <span class="sm-kpi-icon">${icon('customers')}</span><span class="sm-kpi-copy"><span class="sm-kpi-label">Active Customers</span><b class="sm-kpi-value">${num(data.activeCustomers)}</b><span class="sm-kpi-sub">${num(data.current.customers)} submitted a request in this period</span></span><span class="sm-kpi-arrow">›</span>
      </button>
      <button class="sm-kpi-card" type="button" data-route-to="products">
        <span class="sm-kpi-icon green">${icon('products')}</span><span class="sm-kpi-copy"><span class="sm-kpi-label">Products Available Now</span><b class="sm-kpi-value">${num(inventory.inStock)} <span class="sm-muted" style="font-size:14px;font-weight:550">/ ${num(inventory.total)}</span></b><span class="sm-kpi-sub">${availablePercent}% in stock</span></span><span class="sm-stock-ring sm-stock-kpi" style="--ring:${availablePercent}%"><span>${availablePercent}%</span></span>
      </button>
    </section>

    <section class="sm-dashboard-grid" aria-label="Request and stock charts">
      <article class="sm-panel">
        <div class="sm-panel-head"><h2>Requests by Day — Last ${data.days} Days</h2><div class="sm-chart-legend"><span><i class="submitted"></i>Submitted</span><span><i class="accepted"></i>Accepted</span></div></div>
        ${barChart(data.series)}
      </article>
      <article class="sm-panel">
        <div class="sm-panel-head"><h2>Stock Status Breakdown</h2><button type="button" class="sm-link-btn" data-route-to="products">View products</button></div>
        ${stockPanel(inventory)}
      </article>
    </section>

    <section class="sm-panel sm-table-panel">
      <div class="sm-panel-head"><div><h2>Recent Requests</h2><p>Latest customer requests · view and export are read-only</p></div><button class="sm-link-btn" type="button" data-route-to="requests?status=all">View All ${icon('arrow')}</button></div>
      ${recentTable(data.recent)}
    </section>`;

  document.getElementById('smRange').addEventListener('change', (event) => loadRoute(`/dashboard?days=${event.target.value}`));
  document.getElementById('smDownload').addEventListener('click', () => {
    csvDownload(`sales-summary-${today.toISOString().slice(0, 10)}.csv`, [
      ['Measure', 'Today', `Last ${data.days} days`],
      ['Requests', data.today.requests, data.current.requests],
      ['Order lines', data.today.lines, data.current.lines],
      ['Cartons requested', data.today.cartons, data.current.cartons],
      ['Customers ordering', data.today.customers, data.current.customers],
      [],
      ['Stock status', 'Products'],
      ['In stock', inventory.inStock],
      ['Limited stock', inventory.limited],
      ['Out of stock', inventory.outOfStock],
      [],
      ['Recent request', 'Customer', 'Cartons', 'Status', 'Submitted'],
      ...data.recent.map((r) => [r.reference || `REQ-${r.id}`, r.customer, r.cartons, r.status, r.submittedAt]),
    ]);
  });
}

async function renderRequests(route) {
  const status = route.query.get('status') || 'all';
  const search = route.query.get('search') || '';
  const page = Math.max(0, Number(route.query.get('page')) || 0);
  const limit = 25;
  const data = await apiGet(`/api/sales/requests?${new URLSearchParams({ status, search, limit: String(limit), offset: String(page * limit) })}`);
  const actions = `<div class="sm-filters"><input id="smListSearch" type="search" value="${esc(search)}" placeholder="Search reference or customer" aria-label="Search requests"><select id="smStatus" aria-label="Filter request status">${statusOptions(status)}</select></div>`;
  view.innerHTML = `${pageHead('Requests', `${num(data.total)} requests · read-only view`, actions)}
    <section class="sm-panel sm-table-panel">${recentTable(data.items)}
      ${pager(data.total, page, limit, `requests?status=${encodeURIComponent(status)}&search=${encodeURIComponent(search)}`)}
    </section>`;
  document.getElementById('smListSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadRoute(`/requests?status=${encodeURIComponent(status)}&search=${encodeURIComponent(event.target.value.trim())}`);
  });
  document.getElementById('smStatus').addEventListener('change', (event) => loadRoute(`/requests?status=${event.target.value}&search=${encodeURIComponent(search)}`));
}

async function renderRequestDetail(id) {
  const data = await apiGet(`/api/sales/requests/${encodeURIComponent(id)}`);
  const { request } = data;
  const date = new Date().toISOString().slice(0, 10);
  const actions = `<button class="sm-btn" type="button" data-action="export-request-detail">${icon('download')}Export request</button>`;
  view.innerHTML = `${pageHead(request.reference || `Request ${request.id}`, `${esc(request.customer)} · Submitted ${esc(dateTime(request.submittedAt))}`, actions)}
    <div class="sm-actions" style="margin-bottom:12px"><button class="sm-btn" type="button" data-route-to="requests?status=all">${icon('back')}Back to requests</button>${statusLabel(request.status)}</div>
    <section class="sm-detail-grid"><article class="sm-panel"><h2>Request summary</h2>
      <div class="sm-setting-row"><span>Reference</span><b>${esc(request.reference || `REQ-${request.id}`)}</b></div>
      <div class="sm-setting-row"><span>Customer</span><b>${esc(request.customer)}</b></div>
      <div class="sm-setting-row"><span>Submitted</span><b>${esc(dateTime(request.submittedAt))}</b></div>
      <div class="sm-setting-row"><span>Status</span><b>${esc(statusText(request.status))}</b></div>
      <div class="sm-setting-row"><span>Permission</span><b>View-only</b></div>
    </article><article class="sm-panel"><h2>Requested products</h2>
      ${data.items.length ? `<ul class="sm-detail-lines">${data.items.map((item) => `<li><span><b>${esc(item.name)}</b><br><small class="sm-muted">${esc(item.boxUom || 'Cartons')}</small></span><b>${num(item.cartons)} CTN</b></li>`).join('')}</ul>` : emptyState('No items recorded')}
    </article></section>`;
  view.querySelector('[data-action="export-request-detail"]').addEventListener('click', () => {
    csvDownload(`${request.reference || `request-${request.id}`}.csv`, [
      ['Reference', request.reference || `REQ-${request.id}`],
      ['Customer', request.customer],
      ['Status', statusText(request.status)],
      ['Submitted', request.submittedAt],
      [],
      ['Product', 'Pack', 'Cartons'],
      ...data.items.map((item) => [item.name, item.boxUom, item.cartons]),
    ]);
  });
}

function statusText(status) {
  return status === 'SUBMITTED' ? 'Pending' : status === 'ACCEPTED' ? 'Accepted' : status === 'DELETED' ? 'Withdrawn' : status || '—';
}

function pager(total, page, limit, base) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages < 2) return '';
  const prefix = base.includes('?') ? '&' : '?';
  return `<div class="sm-pager"><button class="sm-table-btn" type="button" data-route-to="${esc(`${base}${prefix}page=${Math.max(0, page - 1)}`)}" ${page === 0 ? 'disabled' : ''}>Previous</button><span>Page ${page + 1} of ${pages}</span><button class="sm-table-btn" type="button" data-route-to="${esc(`${base}${prefix}page=${Math.min(pages - 1, page + 1)}`)}" ${page >= pages - 1 ? 'disabled' : ''}>Next</button></div>`;
}

async function renderProducts(route) {
  const search = route.query.get('search') || '';
  const page = Math.max(0, Number(route.query.get('page')) || 0);
  const limit = 30;
  const data = await apiGet(`/api/sales/products?${new URLSearchParams({ search, limit: String(limit), offset: String(page * limit) })}`);
  view.innerHTML = `${pageHead('Products', `${num(data.total)} active products · live stock information`,
    `<div class="sm-filters"><input id="smListSearch" type="search" value="${esc(search)}" placeholder="Search product or barcode" aria-label="Search products"></div>`)}
    <section class="sm-panel sm-table-panel">${data.items.length ? `<div class="sm-table-wrap"><table class="sm-table">
      <thead><tr><th>Product</th><th>Barcode</th><th>Pack</th><th>Free to Use</th><th>Stock Status</th></tr></thead>
      <tbody>${data.items.map((p) => `<tr><td class="primary-text">${esc(p.name)}</td><td>${esc(p.barcode)}</td><td>${esc(p.boxUom || '—')}</td><td>${num(p.freeToUse)}</td><td>${stockPill(p.stockStatus)}</td></tr>`).join('')}</tbody>
    </table></div>` : emptyState('No products found', 'Try a different name or barcode.')}
    ${pager(data.total, page, limit, `products?search=${encodeURIComponent(search)}`)}</section>`;
  document.getElementById('smListSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadRoute(`/products?search=${encodeURIComponent(event.target.value.trim())}`);
  });
}

function stockPill(status) {
  if (status === 'IN_STOCK') return '<span class="sm-stock-pill in">In stock</span>';
  if (status === 'LIMITED_STOCK') return '<span class="sm-stock-pill limited">Limited</span>';
  return '<span class="sm-stock-pill out">Out of stock</span>';
}

async function renderCustomers(route) {
  const search = route.query.get('search') || '';
  const page = Math.max(0, Number(route.query.get('page')) || 0);
  const limit = 30;
  const data = await apiGet(`/api/sales/customers?${new URLSearchParams({ search, limit: String(limit), offset: String(page * limit) })}`);
  view.innerHTML = `${pageHead('Customers', `${num(data.total)} active customers · contact details are not shown`,
    `<div class="sm-filters"><input id="smListSearch" type="search" value="${esc(search)}" placeholder="Search customer name" aria-label="Search customers"></div>`)}
    <section class="sm-panel sm-table-panel">${data.items.length ? `<div class="sm-table-wrap"><table class="sm-table">
      <thead><tr><th>Customer</th><th>Requests</th><th>Cartons requested</th><th>Action</th></tr></thead>
      <tbody>${data.items.map((c) => `<tr><td class="primary-text">${esc(c.name)}</td><td>${num(c.requests)}</td><td>${num(c.cartons)}</td><td><button class="sm-table-btn" type="button" data-view-customer="${c.id}">${icon('eye')}View</button></td></tr>`).join('')}</tbody>
    </table></div>` : emptyState('No customers found', 'Try another customer name.')}
    ${pager(data.total, page, limit, `customers?search=${encodeURIComponent(search)}`)}</section>`;
  document.getElementById('smListSearch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadRoute(`/customers?search=${encodeURIComponent(event.target.value.trim())}`);
  });
}

async function renderCustomerDetail(id) {
  const data = await apiGet(`/api/sales/customers/${encodeURIComponent(id)}`);
  view.innerHTML = `${pageHead(data.customer.name, 'Customer request history',
    `<button class="sm-btn" type="button" data-route-to="customers">${icon('back')}Back to customers</button>`)}
    <section class="sm-panel sm-table-panel"><div class="sm-panel-head"><h2>Recent requests</h2></div>
      ${recentTable(data.requests.map((r) => ({ ...r, customer: data.customer.name, cartons: r.cartons })))}
    </section>`;
}

async function renderImports() {
  const data = await apiGet('/api/sales/imports');
  view.innerHTML = `${pageHead('Imports', 'Recent product-data refreshes · view-only access')}
    <section class="sm-panel sm-table-panel">${data.items.length ? `<div class="sm-table-wrap"><table class="sm-table">
      <thead><tr><th>Import</th><th>Started</th><th>Completed</th><th>Status</th><th>Rows</th><th>Created</th><th>Updated</th><th>Errors</th></tr></thead>
      <tbody>${data.items.map((item) => `<tr><td class="primary-text">${esc(item.filename)}</td><td>${esc(dateTime(item.importedAt))}</td><td>${esc(dateTime(item.completedAt))}</td><td>${esc(item.status)}</td><td>${num(item.totalRows)}</td><td>${num(item.created)}</td><td>${num(item.updated)}</td><td>${num(item.errors)}</td></tr>`).join('')}</tbody>
    </table></div>` : emptyState('No imports recorded', 'Product imports will appear here after an administrator runs an import.')}</section>`;
}

function renderSettings() {
  view.innerHTML = `${pageHead('Settings', 'Your Sales Manager workspace and access')}
    <section class="sm-detail-grid"><article class="sm-panel"><h2>Account</h2>
      <div class="sm-setting-row"><span>Role</span><b>Sales Manager</b></div>
      <div class="sm-setting-row"><span>Workspace</span><b>Box for Less</b></div>
      <div class="sm-setting-row"><span>Session</span><b>Protected team sign-in</b></div>
    </article><article class="sm-panel"><h2>Permissions</h2>
      <div class="sm-setting-row"><span>Dashboard and reports</span><b>Available</b></div>
      <div class="sm-setting-row"><span>Product and stock visibility</span><b>View-only</b></div>
      <div class="sm-setting-row"><span>Customer request review</span><b>View and export</b></div>
      <div class="sm-setting-row"><span>Request approval, imports and edits</span><b>Admin only</b></div>
      <p class="sm-muted" style="margin:12px 0 0;font-size:12px">Role permissions are managed by your administrator.</p>
    </article></section>`;
}

let renderSequence = 0;
async function renderRoute() {
  const sequence = ++renderSequence;
  const route = parseRoute();
  const key = route.parts[0] || 'dashboard';
  const navKey = ['request', 'customer', 'product'].includes(key) ? ({ request: 'requests', customer: 'customers', product: 'products' })[key] : key;
  setActiveNav(navKey);
  sidebar.classList.remove('open');
  scrim.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.setAttribute('aria-label', 'Open navigation');
  view.innerHTML = '<div class="sm-panel sm-loading" role="status">Loading…</div>';
  try {
    if (key === 'dashboard') await renderDashboard(Number(route.query.get('days')) || 14);
    else if (key === 'requests') await renderRequests(route);
    else if (key === 'request' && route.parts[1]) await renderRequestDetail(route.parts[1]);
    else if (key === 'products') await renderProducts(route);
    else if (key === 'customers') await renderCustomers(route);
    else if (key === 'customer' && route.parts[1]) await renderCustomerDetail(route.parts[1]);
    else if (key === 'imports') await renderImports();
    else if (key === 'settings') renderSettings();
    else navigate('dashboard');
  } catch (error) {
    if (sequence === renderSequence && error.message !== 'Signed out') view.innerHTML = errorState(error);
  }
  if (sequence !== renderSequence) return;
  if (searchInput && document.activeElement !== searchInput) searchInput.value = route.query.get('search') || '';
}

function loadRoute(hash) {
  location.hash = hash.startsWith('/') ? hash : `/${hash}`;
  if (parseRoute().parts.join('/') === location.hash.slice(2).split('?')[0]) renderRoute();
}

function routeToRequest(id) { navigate(`request/${encodeURIComponent(id)}`); }

view.addEventListener('click', async (event) => {
  const routeLink = event.target.closest('[data-route-to]');
  if (routeLink && !routeLink.disabled) { loadRoute(routeLink.dataset.routeTo); return; }
  const requestButton = event.target.closest('[data-view-request]');
  if (requestButton) { routeToRequest(requestButton.dataset.viewRequest); return; }
  const customerButton = event.target.closest('[data-view-customer]');
  if (customerButton) { navigate(`customer/${encodeURIComponent(customerButton.dataset.viewCustomer)}`); return; }
  const exportButton = event.target.closest('[data-export-request]');
  if (exportButton) {
    try {
      const data = await apiGet(`/api/sales/requests/${encodeURIComponent(exportButton.dataset.exportRequest)}`);
      const request = data.request;
      csvDownload(`${request.reference || `request-${request.id}`}.csv`, [
        ['Reference', request.reference || `REQ-${request.id}`], ['Customer', request.customer],
        ['Status', statusText(request.status)], ['Submitted', request.submittedAt], [],
        ['Product', 'Pack', 'Cartons'], ...data.items.map((item) => [item.name, item.boxUom, item.cartons]),
      ]);
    } catch (error) {
      if (error.message !== 'Signed out') alert(error.message);
    }
  }
});

document.getElementById('smRange')?.addEventListener('change', (event) => loadRoute(`/dashboard?days=${event.target.value}`));
document.getElementById('smNotifications').addEventListener('click', () => loadRoute('/requests?status=pending'));
document.getElementById('smSearchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const search = searchInput.value.trim();
  const route = parseRoute().parts[0];
  const target = route === 'products' ? 'products' : route === 'customers' ? 'customers' : 'requests';
  loadRoute(`/${target}?search=${encodeURIComponent(search)}${target === 'requests' ? '&status=all' : ''}`);
});
menuToggle.addEventListener('click', () => {
  const open = !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', open);
  scrim.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
  menuToggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
});
scrim.addEventListener('click', () => {
  sidebar.classList.remove('open');
  scrim.hidden = true;
  menuToggle.setAttribute('aria-expanded', 'false');
});
userBtn.addEventListener('click', () => {
  const open = userMenu.hidden;
  userMenu.hidden = !open;
  userBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('pointerdown', (event) => {
  if (!userMenu.hidden && !event.target.closest('.sm-profile')) {
    userMenu.hidden = true;
    userBtn.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!userMenu.hidden) { userMenu.hidden = true; userBtn.setAttribute('aria-expanded', 'false'); userBtn.focus(); }
    sidebar.classList.remove('open');
    scrim.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
  }
});
document.getElementById('salesLogout').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/sales/logout', { method: 'POST' });
    if (!response.ok) throw new Error(`Sign out failed (${response.status}).`);
    location.replace('/login.html');
  } catch (error) {
    view.insertAdjacentHTML('afterbegin', errorState(error));
  }
});
window.addEventListener('hashchange', renderRoute);
if (!location.hash) location.hash = '#/dashboard';
else renderRoute();
