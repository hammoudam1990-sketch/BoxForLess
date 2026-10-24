// Admin workspace views. Where an approved Odoo source is unavailable,
// the page says so rather than presenting invented financial or quotation data.
import { api, esc, num } from './api.js';

const TITLES = {
  quotations: 'Quotations',
  visibility: 'Product Visibility',
  stock: 'Stock & Expiry',
  invoices: 'Invoices',
  payments: 'Payments',
  credit: 'Credit & Balances',
  users: 'Users & Roles',
  settings: 'Settings',
  sync: 'Sync Logs',
};
const date = (value) => value ? new Date(value).toLocaleString() : '—';
const card = (title, body) => `<section class="ad-card"><h2>${title}</h2>${body}</section>`;
const statusPill = (active) => `<span class="ad-pill ${active ? 'green' : 'amber'}">${active ? 'Configured' : 'Not configured'}</span>`;

function odooRequired(title) {
  return `<div class="ad-head"><div><h1>${title}</h1><p>Odoo financial data is not connected.</p></div></div>
    <section class="ad-card">
      <span class="ad-source-tag">Odoo source required</span>
      <h2>No financial records are available</h2>
      <p>To keep this screen accurate, it will not estimate or invent invoices, payments, credit limits, balances, or prices. Connect an approved Odoo staging/API source or import a verified export before using this feature.</p>
    </section>`;
}

function renderTable(headers, rows, empty) {
  return rows.length
    ? `<div class="ad-table-wrap"><table class="ad-table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : `<p class="ad-empty">${empty}</p>`;
}

async function renderWorkspacePage(view, key) {
  if (!TITLES[key]) { location.hash = '#/dashboard'; return; }
  if (['invoices', 'payments', 'credit'].includes(key)) {
    view.innerHTML = odooRequired(TITLES[key]);
    return;
  }

  if (key === 'quotations') {
    const { items, integration } = await api.workspaceQuotations();
    const rows = items.map((q) => `<tr><td>${esc(q.odooReference || `Local #${q.id}`)}</td><td>${esc(q.requestReference || '—')}</td><td>${esc(q.customer)}</td><td>${esc(q.status || 'Unspecified')}</td><td>${date(q.createdAt)}</td></tr>`);
    view.innerHTML = `<div class="ad-head"><div><h1>Quotations</h1><p>Existing local quotation records only. Customer requests are not Odoo quotations.</p></div></div>
      ${card('Odoo connection', `<p>${integration === 'CONNECTED' ? 'Connected' : 'Not connected — new quotes are not sent to Odoo.'}</p><a class="ad-btn-row" href="#/requests">Review customer requests</a>`)}
      ${card('Saved quotation records', renderTable(['Reference', 'Request', 'Customer', 'Status', 'Created'], rows, 'No quotation records have been created.'))}`;
    return;
  }

  if (key === 'visibility') {
    const data = await api.workspaceVisibility();
    view.innerHTML = `<div class="ad-head"><div><h1>Product Visibility</h1><p>Current customer catalogue policy, enforced by the catalog API.</p></div></div>
      <div class="ad-kpis">
        <div class="ad-kpi ad-kpi-green"><span class="ad-kpi-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></span><span><span class="ad-kpi-k">Visible products</span><b class="ad-kpi-v">${num(data.visible || 0)}</b></span></div>
        <div class="ad-kpi ad-kpi-amber"><span class="ad-kpi-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6Z"/><path d="m4 4 16 16"/></svg></span><span><span class="ad-kpi-k">Hidden products</span><b class="ad-kpi-v">${num(data.hidden || 0)}</b></span></div>
      </div>
      ${card('Active policy', `<p>Active products are visible to authenticated customers; inactive products are hidden.</p><p><b>Customer-specific rules:</b> Not configured. Visibility is not yet customizable by customer, brand, or category.</p><a class="ad-btn-row" href="#/products">Open Product Master</a>`)}`;
    return;
  }

  if (key === 'stock') {
    const band = new URLSearchParams(location.hash.split('?')[1] || '').get('band') || 'all';
    const data = await api.workspaceStockExpiry(band);
    const bandLabel = { expired: 'Expired', critical: 'Critical · 0–7 days', warning: 'Warning · 8–30 days', early: 'Early · 31–60 days', ok: 'Over 60 days', all: 'All lots' };
    const rows = data.items.map((lot) => `<tr><td>${esc(lot.product)}</td><td>${esc(lot.customer)}</td><td>${esc(lot.lotCode)}</td><td>${esc(lot.expiryDate)}</td><td>${lot.daysLeft < 0 ? `${num(Math.abs(lot.daysLeft))} days overdue` : `${num(lot.daysLeft)} days`}</td><td>${lot.returnExpected ? 'Return recorded' : esc(lot.lastOutcome || '—')}</td><td>${num(lot.deliveredCartons)} CTN</td></tr>`);
    view.innerHTML = `<div class="ad-head"><div><h1>Stock &amp; Expiry</h1><p>Expiry bands calculated from local delivery-lot records; no Odoo feed is connected.</p></div></div>
      <section class="ad-card"><label for="expiryBand">Expiry band</label><select id="expiryBand">${Object.entries(bandLabel).map(([value, label]) => `<option value="${value}"${band === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <p class="mu">Showing ${num(data.items.length)} lot(s). This screen is informational; it does not write off, return, or change stock.</p></section>
      ${card('Lots by expiry', renderTable(['Product', 'Customer', 'Lot', 'Expiry', 'Time remaining', 'Latest visit', 'Delivered'], rows, 'No delivery lots are available for this expiry band.'))}`;
    view.querySelector('#expiryBand').addEventListener('change', (event) => {
      location.hash = `#/workspace/stock?band=${encodeURIComponent(event.target.value)}`;
    });
    return;
  }

  const status = await api.workspaceStatus();
  if (key === 'users') {
    const roles = [
      ['Admin', status.roles.admin],
      ['Sales Manager', status.roles.salesManager],
      ['Sales Rep', status.roles.salesRep],
    ];
    view.innerHTML = `<div class="ad-head"><div><h1>Users &amp; Roles</h1><p>Deployment role configuration status. Credentials are never shown here.</p></div></div>
      ${card('Configured sign-in roles', renderTable(['Role', 'Status'], roles.map(([name, ready]) => `<tr><td>${name}</td><td>${statusPill(ready)}</td></tr>`), 'No roles configured.'))}
      <p class="mu">This deployment uses environment-configured accounts; this page does not create users or change permissions.</p>`;
    return;
  }
  if (key === 'settings') {
    view.innerHTML = `<div class="ad-head"><div><h1>Settings</h1><p>Current operational settings. Sensitive credentials are not exposed.</p></div></div>
      ${card('Catalogue and stock', `<p>Active products: <b>${num(status.data.products)}</b></p><p>Active customers: <b>${num(status.data.customers)}</b></p><p>Out-of-stock threshold: <b>${num(status.stockThresholds.outOfStockAtOrBelow)} CTN</b></p><p>Limited-stock threshold: <b>${num(status.stockThresholds.limitedAtOrBelow)} CTN</b></p><p>Theme: use the account menu to switch light/dark mode.</p>`)}
      ${card('Data source', `<p>Odoo: <b>Not connected</b>. Product/customer imports remain manually initiated by staff.</p>`)}`;
    return;
  }
  const { items: productImports } = await api.imports();
  const { items: customerImports } = await api.customerImports();
  const imports = [
    ...productImports.map((item) => ({ type: 'Product variants', filename: item.filename, status: item.status, at: item.completed_at || item.imported_at })),
    ...customerImports.map((item) => ({ type: 'Customers', filename: item.filename, status: item.status, at: item.confirmed_at || item.created_at })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  const rows = imports.map((item) => `<tr><td>${esc(item.type)}</td><td>${esc(item.filename)}</td><td>${esc(item.status)}</td><td>${date(item.at)}</td></tr>`);
  view.innerHTML = `<div class="ad-head"><div><h1>Sync Logs</h1><p>Audit history for manually imported files. This is not a live Odoo sync log.</p></div></div>
    ${card('Connection', '<p>Odoo live sync: <b>Not connected</b>. No automatic sync or retry queue is active.</p>')}
    ${card('Import history', renderTable(['Data type', 'Source file', 'Status', 'Last activity'], rows, 'No imported files recorded.'))}
    <a class="ad-btn-row" href="#/imports">Open Imports</a>`;
}

export { renderWorkspacePage };

/** Categories: the Odoo category tree as the catalogue sees it, with product counts. */
export async function renderCategories(view) {
  const res = await fetch('/api/catalog/categories?view=full');
  const { items = [] } = res.ok ? await res.json() : {};
  const tops = items.filter((c) => c.level === 1);
  const subsOf = (top) => items.filter((c) => c.level === 2 && c.path.startsWith(`${top.path} / `));
  view.innerHTML = `
    <div class="ad-head">
      <div><h1>Categories</h1><p>${num(tops.length)} top-level categories from Odoo, with active product counts. Categories are changed in Odoo, never here.</p></div>
    </div>
    ${tops.length ? `<div class="ad-cat-grid">${tops.map((t) => `
      <section class="ad-cat">
        <b>${esc(t.name)}</b><span>${num(t.count)} products</span>
        ${subsOf(t).length ? `<ul>${subsOf(t).map((s) => `<li><span>${esc(s.name)}</span><span>${num(s.count)}</span></li>`).join('')}</ul>` : ''}
      </section>`).join('')}</div>` : '<div class="ad-card"><p class="ad-empty">No categories yet. Run a product import.</p></div>'}`;
}
