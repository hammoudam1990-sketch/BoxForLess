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
  'data-quality': 'Data Quality Readiness',
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
    const rows = data.items.map((lot) => `<tr><td>${esc(lot.product)}<div class="muted">${esc(lot.barcode || '')}</div></td><td>${esc(lot.customer)}</td><td>${esc(lot.lotCode)}</td><td>${esc(lot.expiryDate)}</td><td>${lot.daysLeft < 0 ? `${num(Math.abs(lot.daysLeft))} days overdue` : `${num(lot.daysLeft)} days`}</td><td>${lot.returnExpected ? 'Return recorded' : esc(lot.lastOutcome || '—')}</td><td>${num(lot.deliveredCartons)} CTN</td></tr>`);
    view.innerHTML = `<div class="ad-head"><div><h1>Stock &amp; Expiry</h1><p>Expiry bands calculated from local delivery-lot records; no Odoo feed is connected.</p></div></div>
      <section class="ad-card"><label for="expiryBand">Expiry band</label><select id="expiryBand">${Object.entries(bandLabel).map(([value, label]) => `<option value="${value}"${band === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
      <p class="mu">Showing ${num(data.items.length)} lot(s). This screen is informational; it does not write off, return, or change stock.</p></section>
      ${card('Lots by expiry', renderTable(['Product', 'Customer', 'Lot', 'Expiry', 'Time remaining', 'Latest visit', 'Delivered'], rows, 'No delivery lots are available for this expiry band.'))}`;
    view.querySelector('#expiryBand').addEventListener('change', (event) => {
      location.hash = `#/workspace/stock?band=${encodeURIComponent(event.target.value)}`;
    });
    return;
  }

  if (key === 'data-quality') {
    const report = await api.workspaceDataQuality();
    const ready = report.status === 'READY_FOR_SYNC';
    const s = report.summary;
    const d = report.details;

    const b1Rows = d.B1_duplicate_customers.map((c) => `<tr><td><span class="ad-pill amber">${esc(c.type)}</span></td><td><b>${esc(c.key)}</b></td><td>${esc(c.details)}</td><td>${num(c.count)}</td></tr>`);
    const b2Rows = d.B2_customers_without_salesperson.map((c) => `<tr><td>#${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.odooRef || '—')}</td><td>${esc(c.phone || c.email || '—')}</td></tr>`);
    const b3Rows = d.B3_customers_without_price_class.map((c) => `<tr><td>#${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.odooRef || '—')}</td><td>${esc(c.customerType || 'CREDIT')}</td></tr>`);
    const b4Rows = d.B4_customers_without_credit_limit.map((c) => `<tr><td>#${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.odooRef || '—')}</td><td>${esc(c.salesperson || '—')}</td><td>${c.creditLimit ? `${num(c.creditLimit)} GHS` : '0 GHS'}</td></tr>`);
    const b5Rows = d.B5_customers_without_contact.map((c) => `<tr><td>#${c.id}</td><td>${esc(c.name)}</td><td>${esc(c.odooRef || '—')}</td><td>${esc(c.salesperson || '—')}</td></tr>`);
    const b6Rows = d.B6_products_without_barcode_or_category.map((p) => `<tr><td>#${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.barcode || 'MISSING')}</td><td>${esc(p.categoryPath || 'MISSING')}</td></tr>`);
    const b7Rows = d.B7_products_without_brand.map((p) => `<tr><td>#${p.id}</td><td>${esc(p.name)}</td><td>${esc(p.barcode || '—')}</td><td>${esc(p.categoryPath || '—')}</td></tr>`);
    const b8Rows = d.B8_lots_without_expiry.map((l) => `<tr><td>#${l.id}</td><td>${esc(l.product)}</td><td>${esc(l.customer)}</td><td>${esc(l.lotCode || '—')}</td><td>${num(l.cartons)} CTN</td></tr>`);

    view.innerHTML = `<div class="ad-head">
      <div>
        <h1>Data Quality Readiness (Group B Pre-Sync Audit)</h1>
        <p>Checks local BFL records against the Readiness Checklist (ODOO_CONNECTION_PLAN.md Section 3). Fix discrepancies in Odoo before enabling Phase 1 live sync.</p>
      </div>
      <div>
        <span class="ad-pill ${ready ? 'green' : 'amber'}" style="font-size:0.9rem;padding:6px 12px;">
          ${ready ? 'Ready for Odoo Sync' : 'Action Required in Odoo'}
        </span>
      </div>
    </div>

    <div class="ad-kpis">
      <div class="ad-kpi ${ready ? 'ad-kpi-green' : 'ad-kpi-amber'}">
        <span class="ad-kpi-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm1 15h-2v-2h2zm0-4h-2V7h2z"/></svg>
        </span>
        <span>
          <span class="ad-kpi-k">Total Discrepancies</span>
          <b class="ad-kpi-v">${num(report.totalIssues)}</b>
        </span>
      </div>
      <div class="ad-kpi ad-kpi-green">
        <span class="ad-kpi-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/></svg>
        </span>
        <span>
          <span class="ad-kpi-k">Active Customers Audited</span>
          <b class="ad-kpi-v">${num(report.totals.customers)}</b>
        </span>
      </div>
      <div class="ad-kpi ad-kpi-green">
        <span class="ad-kpi-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>
        </span>
        <span>
          <span class="ad-kpi-k">Active Products Audited</span>
          <b class="ad-kpi-v">${num(report.totals.products)}</b>
        </span>
      </div>
    </div>

    ${card(`B1 · Duplicate Customers (${num(s.B1.count)})`, 
      `<p class="mu">Customers with matching names, phone numbers or email addresses in Odoo. Merge or differentiate them in Odoo.</p>` +
      renderTable(['Match Type', 'Matched Key', 'Customer Records', 'Count'], b1Rows, 'No duplicate customers detected.'))}

    ${card(`B2 · Customers Without a Salesperson (${num(s.B2.count)})`, 
      `<p class="mu">Customers without an assigned Salesperson (<code>user_id</code> in Odoo). Reps will not be able to see or visit these customers.</p>` +
      renderTable(['ID', 'Customer Name', 'Odoo Ref', 'Contact'], b2Rows, 'All customers have an assigned salesperson.'))}

    ${card(`B3 · Customers Without a Price Class (${num(s.B3.count)})`, 
      `<p class="mu">Customers without an assigned Pricelist in Odoo (<code>property_product_pricelist</code>). In Phase 3, these customers will see no prices.</p>` +
      renderTable(['ID', 'Customer Name', 'Odoo Ref', 'Type'], b3Rows, 'All customers have an assigned price class.'))}

    ${card(`B4 · Credit Customers Without a Credit Limit (${num(s.B4.count)})`, 
      `<p class="mu">Credit accounts with no credit limit or 0 limit in Odoo (<code>credit_limit</code>). In Phase 5, orders will be blocked at checkout.</p>` +
      renderTable(['ID', 'Customer Name', 'Odoo Ref', 'Salesperson', 'Limit'], b4Rows, 'All credit customers have a positive credit limit.'))}

    ${card(`B5 · Customers Without Phone or Email (${num(s.B5.count)})`, 
      `<p class="mu">Customers missing both phone and email. Notifications, access codes and payment reminders cannot be delivered to them.</p>` +
      renderTable(['ID', 'Customer Name', 'Odoo Ref', 'Salesperson'], b5Rows, 'All customers have a phone number or email.'))}

    ${card(`B6 · Products Without Barcode or Category (${num(s.B6.count)})`, 
      `<p class="mu">Products missing a Barcode or Category path in Odoo. These products cannot be scanned or categorized in the digital catalogue.</p>` +
      renderTable(['ID', 'Product Name', 'Barcode', 'Category Path'], b6Rows, 'All products have a valid barcode and category.'))}

    ${card(`B7 · Products Missing Recognizable Brand (${num(s.B7.count)})`, 
      `<p class="mu">Products where brand prefix could not be determined from name. Fill the <code>x_brand</code> field in Odoo for clean filtering.</p>` +
      renderTable(['ID', 'Product Name', 'Barcode', 'Category'], b7Rows.slice(0, 100), 'All products have an identifiable brand.'))}

    ${card(`B8 · Perishable Lots Without Expiry Date (${num(s.B8.count)})`, 
      `<p class="mu">Delivery lots with missing expiration dates. The warehouse cannot monitor shelf-life or calculate early warning alerts for these.</p>` +
      renderTable(['ID', 'Product', 'Customer', 'Lot Code', 'Quantity'], b8Rows, 'All delivery lots have valid expiration dates.'))}
    `;
    return;
  }

  const status = await api.workspaceStatus();
  if (key === 'users') {
    await renderUsersPage(view, status);
    return;
  }
  if (key === 'settings') {
    await renderSettingsBuilder(view, status);
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

async function renderSettingsBuilder(view, status) {
  let settings;
  try {
    settings = await api.workspaceSiteSettings();
  } catch (_e) {
    settings = {
      storefront: {
        storeName: 'Box for Less',
        tagline: 'Wholesale Confectionery & Beverage Distribution',
        supportPhone: '+233 24 456 7890',
        whatsappNumber: '+233 24 456 7890',
        currencySymbol: 'GH₵',
        announcement: { enabled: true, text: 'Real-time inventory sync active. Guaranteed next-day delivery across Greater Accra.', tone: 'brand' },
        hero: { headline: 'Direct Wholesale Ordering Platform', subtitle: 'Premium confectionery, beverages, biscuits, and daily FMCG lines at transparent bulk rates.', ctaText: 'Explore Catalog', ctaLink: '#catalog' },
        policies: { allowGuestBrowsing: true, requireAccessCodeToOrder: true, hideOutOfStock: false, showExactStock: true, enableBulkReorder: true },
      },
      salesRep: {
        portalTitle: 'Sales Rep Field Hub',
        portalSubtitle: 'Route navigation, customer balance checks & shelf expiry audits',
        features: { enableWhatsApp: true, enableMaps: true, enableCall: true, enableQuickDiscount: true },
        broadcastNotice: 'Team Target: Prioritize Near-Expiry stock batches for promotional clearance today.',
        discountPresets: [5, 10, 15, 20, 25],
        expiryWarningDays: 60,
        requireCustomerConfirmation: true,
      },
      operations: {
        outOfStockThreshold: 0,
        lowStockThreshold: 20,
        warehouseNotice: 'Central Warehouse: Spintex Road, Accra. Operating hours: Mon-Sat 08:00 - 17:00 GMT.',
      },
    };
  }

  let draft = JSON.parse(JSON.stringify(settings));
  let activeTab = 'storefront';
  let previewDevice = 'desktop';

  function showToast(msg, type = 'success') {
    const existing = document.querySelector('.sb-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = `sb-toast ${type}`;
    const icon = type === 'success'
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    t.innerHTML = `<span style="display:grid;place-items:center;">${icon}</span> <span>${esc(msg)}</span>`;
    document.body.appendChild(t);
    setTimeout(() => { t.remove(); }, 3500);
  }

  function getToneClass(tone) {
    return ['brand', 'info', 'warn', 'ok'].includes(tone) ? `tone-${tone}` : 'tone-brand';
  }

  function render() {
    view.innerHTML = `
      <div class="sb-container">
        <!-- Header Bar -->
        <div class="sb-header-bar">
          <div class="sb-header-titles">
            <h1>Settings &amp; Site Configuration</h1>
            <p>Admin configuration for customer storefront, sales representative field tools, and inventory parameters.</p>
          </div>
          <div class="sb-header-actions">
            <button type="button" class="sb-btn sb-btn-ghost" id="sbResetBtn">Reset Defaults</button>
            <button type="button" class="sb-btn sb-btn-primary" id="sbSaveBtn">Save Changes</button>
          </div>
        </div>

        <!-- Navigation Tabs -->
        <div class="sb-tabs">
          <button type="button" class="sb-tab-btn ${activeTab === 'storefront' ? 'active' : ''}" data-tab="storefront">Storefront</button>
          <button type="button" class="sb-tab-btn ${activeTab === 'salesRep' ? 'active' : ''}" data-tab="salesRep">Sales Rep Hub</button>
          <button type="button" class="sb-tab-btn ${activeTab === 'operations' ? 'active' : ''}" data-tab="operations">Inventory &amp; Operations</button>
          <button type="button" class="sb-tab-btn ${activeTab === 'preview' ? 'active' : ''}" data-tab="preview">Preview Device</button>
        </div>

        <!-- Main Layout: Editor & Live Preview -->
        <div class="sb-layout">
          <!-- Editor Column -->
          <div class="sb-sections">

            <!-- STOREFRONT TAB -->
            <div id="tab-storefront" class="${activeTab === 'storefront' ? '' : 'hidden'}">
              <!-- Branding Section -->
              <div class="sb-card" style="margin-bottom:18px;">
                <div class="sb-card-head">
                  <h2>Store Identity &amp; Branding</h2>
                  <span>Displayed on customer portal headers &amp; invoices</span>
                </div>
                <div class="sb-form-grid">
                  <div class="sb-field">
                    <label>Store Name</label>
                    <input type="text" class="sb-input" id="sfStoreName" value="${esc(draft.storefront.storeName || '')}" placeholder="Box for Less">
                  </div>
                  <div class="sb-field">
                    <label>Tagline</label>
                    <input type="text" class="sb-input" id="sfTagline" value="${esc(draft.storefront.tagline || '')}" placeholder="Wholesale Confectionery & Beverage Distribution">
                  </div>
                  <div class="sb-field">
                    <label>Customer Support Phone</label>
                    <input type="text" class="sb-input" id="sfSupportPhone" value="${esc(draft.storefront.supportPhone || '')}" placeholder="+233 24 000 0000">
                  </div>
                  <div class="sb-field">
                    <label>WhatsApp Helpline</label>
                    <input type="text" class="sb-input" id="sfWhatsapp" value="${esc(draft.storefront.whatsappNumber || '')}" placeholder="+233 24 000 0000">
                  </div>
                  <div class="sb-field">
                    <label>Currency Symbol</label>
                    <input type="text" class="sb-input" id="sfCurrency" value="${esc(draft.storefront.currencySymbol || 'GH₵')}" placeholder="GH₵">
                  </div>
                </div>
              </div>

              <!-- Announcement Banner -->
              <div class="sb-card" style="margin-bottom:18px;">
                <div class="sb-card-head">
                  <h2>Announcement Banner</h2>
                  <span>High-visibility message strip across top of storefront</span>
                </div>
                <div class="sb-switch-row" style="margin-bottom: 12px;">
                  <div class="sb-switch-info">
                    <b>Enable Announcement Bar</b>
                    <span>Broadcast announcements, delivery windows, or flash deals to all buyers</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="sfAnnounceEnabled" ${draft.storefront.announcement.enabled ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-form-grid">
                  <div class="sb-field full">
                    <label>Announcement Text</label>
                    <input type="text" class="sb-input" id="sfAnnounceText" value="${esc(draft.storefront.announcement.text || '')}" placeholder="e.g. Real-time inventory sync active. Next-day delivery across Accra.">
                  </div>
                  <div class="sb-field">
                    <label>Badge Tone / Color</label>
                    <select class="sb-select" id="sfAnnounceTone">
                      <option value="brand" ${draft.storefront.announcement.tone === 'brand' ? 'selected' : ''}>Brand / Primary (Official notice)</option>
                      <option value="info" ${draft.storefront.announcement.tone === 'info' ? 'selected' : ''}>Blue (Information & updates)</option>
                      <option value="warn" ${draft.storefront.announcement.tone === 'warn' ? 'selected' : ''}>Amber (Urgent / Warning)</option>
                      <option value="ok" ${draft.storefront.announcement.tone === 'ok' ? 'selected' : ''}>Green (Offer / Confirmation)</option>
                    </select>
                  </div>
                </div>
              </div>

              <!-- Hero Customizer -->
              <div class="sb-card" style="margin-bottom:18px;">
                <div class="sb-card-head">
                  <h2>Hero Section</h2>
                  <span>Primary landing headline and call-to-action</span>
                </div>
                <div class="sb-form-grid">
                  <div class="sb-field full">
                    <label>Hero Headline</label>
                    <input type="text" class="sb-input" id="sfHeroHeadline" value="${esc(draft.storefront.hero.headline || '')}" placeholder="Direct Wholesale Ordering Platform">
                  </div>
                  <div class="sb-field full">
                    <label>Hero Subtitle / Description</label>
                    <textarea class="sb-textarea" id="sfHeroSubtitle" placeholder="Order confectionery, biscuits, beverages & snacks...">${esc(draft.storefront.hero.subtitle || '')}</textarea>
                  </div>
                  <div class="sb-field">
                    <label>Call-to-Action (CTA) Button Text</label>
                    <input type="text" class="sb-input" id="sfHeroCtaText" value="${esc(draft.storefront.hero.ctaText || 'Explore Catalog')}" placeholder="Browse Catalog">
                  </div>
                  <div class="sb-field">
                    <label>CTA Target URL / Anchor</label>
                    <input type="text" class="sb-input" id="sfHeroCtaLink" value="${esc(draft.storefront.hero.ctaLink || '#catalog')}" placeholder="#catalog">
                  </div>
                </div>
              </div>

              <!-- Storefront Policies -->
              <div class="sb-card">
                <div class="sb-card-head">
                  <h2>Customer Access &amp; Display Policies</h2>
                  <span>Control browsing privacy, carton visibility and reordering</span>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Allow Guest Browsing</b>
                    <span>Permit visitors to view product catalogue before entering access code or signing in</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="sfPolicyGuest" ${draft.storefront.policies.allowGuestBrowsing ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Require Access Code to Order</b>
                    <span>Customers must enter their verified company access code to finalize quotations</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="sfPolicyCode" ${draft.storefront.policies.requireAccessCodeToOrder ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Hide Out of Stock Products</b>
                    <span>Automatically remove zero-inventory items from the public catalogue list</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="sfPolicyHideOos" ${draft.storefront.policies.hideOutOfStock ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Show Exact Stock Counts</b>
                    <span>Display exact carton counts (e.g. '142 CTN') instead of generic 'In Stock' badge</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="sfPolicyExactStock" ${draft.storefront.policies.showExactStock ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Enable 1-Click Wholesale Reorders</b>
                    <span>Allow buyers to instantly re-add previous orders directly from their account history</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="sfPolicyReorder" ${draft.storefront.policies.enableBulkReorder ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
              </div>
            </div>

            <!-- SALES REP TAB -->
            <div id="tab-salesRep" class="${activeTab === 'salesRep' ? '' : 'hidden'}">
              <!-- Rep Branding -->
              <div class="sb-card" style="margin-bottom:18px;">
                <div class="sb-card-head">
                  <h2>Sales Rep Portal Configuration</h2>
                  <span>Controls the field app at /rep.html used by route sales representatives</span>
                </div>
                <div class="sb-form-grid">
                  <div class="sb-field">
                    <label>Portal Title</label>
                    <input type="text" class="sb-input" id="repPortalTitle" value="${esc(draft.salesRep.portalTitle || '')}" placeholder="Sales Rep Field Hub">
                  </div>
                  <div class="sb-field">
                    <label>Header Subtitle</label>
                    <input type="text" class="sb-input" id="repPortalSubtitle" value="${esc(draft.salesRep.portalSubtitle || '')}" placeholder="Daily route, shop visits & shelf audits">
                  </div>
                </div>
              </div>

              <!-- Rep Field Broadcast Notice -->
              <div class="sb-card" style="margin-bottom:18px;">
                <div class="sb-card-head">
                  <h2>Route Broadcast Notice</h2>
                  <span>Displays a high-visibility bulletin to all sales reps on their daily route</span>
                </div>
                <div class="sb-field full">
                  <label>Broadcast Message</label>
                  <textarea class="sb-textarea" id="repBroadcast" placeholder="e.g. Team Target: Prioritize Near-Expiry stock batches today!">${esc(draft.salesRep.broadcastNotice || '')}</textarea>
                  <small>Sales reps will see this pinned at the top of their shop visit list.</small>
                </div>
              </div>

              <!-- Rep Action Toggles -->
              <div class="sb-card" style="margin-bottom:18px;">
                <div class="sb-card-head">
                  <h2>Field Action Shortcuts</h2>
                  <span>Enable or disable quick action buttons on customer cards</span>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Enable 1-Tap WhatsApp Chat</b>
                    <span>Allows rep to launch WhatsApp conversation prefilled with store greeting</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="repFeatureWa" ${draft.salesRep.features.enableWhatsApp ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Enable Google Maps Navigation</b>
                    <span>Direct GPS shortcut opening the shop's geolocation or area on Google Maps</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="repFeatureMaps" ${draft.salesRep.features.enableMaps ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Enable Direct Phone Calling</b>
                    <span>Instant telephone dialer link to call store owner or procurement manager</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="repFeatureCall" ${draft.salesRep.features.enableCall ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
                <div class="sb-switch-row">
                  <div class="sb-switch-info">
                    <b>Enable Quick On-The-Spot Expiry Clearance</b>
                    <span>Permits rep to offer pre-approved clearance discounts directly during shop visit</span>
                  </div>
                  <label class="sb-switch">
                    <input type="checkbox" id="repFeatureDiscount" ${draft.salesRep.features.enableQuickDiscount ? 'checked' : ''}>
                    <span class="sb-slider"></span>
                  </label>
                </div>
              </div>

              <!-- Rep Expiry & Discount Rules -->
              <div class="sb-card">
                <div class="sb-card-head">
                  <h2>Expiry Audit &amp; Clearance Presets</h2>
                  <span>Configure pre-approved clearance percentages and warning horizons</span>
                </div>
                <div class="sb-form-grid">
                  <div class="sb-field">
                    <label>Discount Preset Percentages (%)</label>
                    <input type="text" class="sb-input" id="repDiscountPresets" value="${esc((draft.salesRep.discountPresets || [5, 10, 15, 20, 25]).join(', '))}" placeholder="5, 10, 15, 20, 25">
                    <small>Comma-separated percentage presets available to field reps</small>
                  </div>
                  <div class="sb-field">
                    <label>Expiry Warning Horizon (Days)</label>
                    <input type="number" class="sb-input" id="repExpiryDays" min="7" max="365" value="${draft.salesRep.expiryWarningDays || 60}">
                    <small>Lots expiring within this many days trigger yellow/orange shelf alerts</small>
                  </div>
                </div>
              </div>
            </div>

            <!-- OPERATIONS TAB -->
            <div id="tab-operations" class="${activeTab === 'operations' ? '' : 'hidden'}">
              <div class="sb-card" style="margin-bottom:18px;">
                <div class="sb-card-head">
                  <h2>Stock &amp; Warehouse Parameters</h2>
                  <span>Configure inventory classification thresholds and dispatch notes</span>
                </div>
                <div class="sb-form-grid">
                  <div class="sb-field">
                    <label>Out-of-Stock Threshold (CTN)</label>
                    <input type="number" class="sb-input" id="opOosThreshold" min="0" value="${draft.operations.outOfStockThreshold ?? 0}">
                    <small>Cartons at or below this count show as Out of Stock</small>
                  </div>
                  <div class="sb-field">
                    <label>Limited-Stock Warning (CTN)</label>
                    <input type="number" class="sb-input" id="opLowThreshold" min="1" value="${draft.operations.lowStockThreshold ?? 20}">
                    <small>Cartons at or below this count show 'Limited Stock' badge</small>
                  </div>
                  <div class="sb-field full">
                    <label>Warehouse Dispatch Slip Notice</label>
                    <textarea class="sb-textarea" id="opWhNotice" placeholder="Central Warehouse hours, loading dock instructions...">${esc(draft.operations.warehouseNotice || '')}</textarea>
                  </div>
                </div>
              </div>

              <!-- Database & System Stats -->
              <div class="sb-card">
                <div class="sb-card-head">
                  <h2>Master System Diagnostics</h2>
                  <span>Active database connections and catalog inventory</span>
                </div>
                <p>Active products in catalogue: <b>${num(status.data.products)}</b></p>
                <p>Active registered customers: <b>${num(status.data.customers)}</b></p>
                <p>Master database: <b>data/product_master.db (SQLite WAL mode)</b></p>
                <p>Role security gate: <b>Admin &amp; Sales Manager authenticated</b></p>
                <p class="mu">Last settings update: <b>${draft._meta?.updatedAt ? new Date(draft._meta.updatedAt).toLocaleString() : 'System default'}</b> by <b>${esc(draft._meta?.updatedBy || 'system')}</b></p>
              </div>
            </div>

          </div>

          <!-- Live Interactive Preview Column -->
          <div class="sb-preview-panel">
            <div class="sb-preview-toolbar">
              <span>Live Interactive Preview</span>
              <div class="sb-device-selector">
                <button type="button" class="sb-dev-btn ${previewDevice === 'desktop' ? 'active' : ''}" data-dev="desktop">Desktop</button>
                <button type="button" class="sb-dev-btn ${previewDevice === 'mobile' ? 'active' : ''}" data-dev="mobile">Mobile</button>
                <button type="button" class="sb-dev-btn ${previewDevice === 'rep' ? 'active' : ''}" data-dev="rep">Rep View</button>
              </div>
            </div>

            <!-- Preview Screen Bezel -->
            <div class="sb-preview-screen ${previewDevice === 'desktop' ? 'desktop' : 'mobile'}" id="sbPreviewScreen">
              <div class="sb-mock-canvas" id="sbMockCanvas">
                <!-- Content dynamically injected by updateLivePreview() -->
              </div>
            </div>
            <div style="font-size:12px; color:var(--muted); text-align:center;">
              Real-time preview updates automatically as options are modified.
            </div>
          </div>

        </div>
      </div>
    `;

    bindEvents();
    updateLivePreview();
  }

  function updateLivePreview() {
    const canvas = document.getElementById('sbMockCanvas');
    if (!canvas) return;

    if (previewDevice === 'rep') {
      canvas.innerHTML = `
        <div class="sb-mock-rep-header">
          <h3>${esc(draft.salesRep.portalTitle || 'Sales Rep Field Hub')}</h3>
          <p>${esc(draft.salesRep.portalSubtitle || 'Daily field visits & shelf audits')}</p>
        </div>
        ${draft.salesRep.broadcastNotice ? `
          <div class="sb-mock-rep-broadcast">
            ${esc(draft.salesRep.broadcastNotice)}
          </div>` : ''}
        <div class="sb-mock-rep-card">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <b style="font-size:13px;">Kaneshie Supermarket #1</b>
              <div style="font-size:11px; color:#64748b;">Kaneshie Market, Accra</div>
            </div>
            <span style="font-size:10px; font-weight:700; background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:4px;">1 Lot Pending</span>
          </div>
          <div style="font-size:11px; margin-top:4px; color:#475569;">
            Lot: <b>LOT-2026-CHOC</b> — 12 CTN (${draft.salesRep.expiryWarningDays || 60}d horizon)
          </div>
          <div class="sb-mock-actions" style="margin-top:6px;">
            ${draft.salesRep.features.enableMaps ? '<button type="button" class="sb-mock-act-btn">Map</button>' : ''}
            ${draft.salesRep.features.enableWhatsApp ? '<button type="button" class="sb-mock-act-btn">WhatsApp</button>' : ''}
            ${draft.salesRep.features.enableCall ? '<button type="button" class="sb-mock-act-btn">Call</button>' : ''}
            <button type="button" class="sb-mock-act-btn primary">Start Visit</button>
          </div>
          ${draft.salesRep.features.enableQuickDiscount ? `
            <div style="margin-top:6px; font-size:11px; color:#475569;">
              Clearance Presets: ${(draft.salesRep.discountPresets || [5, 10, 15, 20, 25]).map((p) => `<span style="display:inline-block; padding:1px 5px; margin-right:3px; background:#e2e8f0; border-radius:3px; font-size:10px; font-weight:600;">-${p}%</span>`).join('')}
            </div>` : ''}
        </div>
      `;
      return;
    }

    canvas.innerHTML = `
      ${draft.storefront.announcement.enabled ? `
        <div class="sb-mock-announcement ${getToneClass(draft.storefront.announcement.tone)}">
          ${esc(draft.storefront.announcement.text || 'Wholesale ordering active')}
        </div>` : ''}
      <div class="sb-mock-nav">
        <div class="sb-mock-brand">
          <b>${esc(draft.storefront.storeName || 'Box for Less')}</b>
        </div>
        <div class="sb-mock-contact">
          Support: ${esc(draft.storefront.supportPhone || '+233 24 000 0000')}
        </div>
      </div>
      <div class="sb-mock-hero">
        <h3>${esc(draft.storefront.hero.headline || 'Direct Wholesale Ordering Platform')}</h3>
        <p>${esc(draft.storefront.hero.subtitle || 'Order confectionery, biscuits, beverages & snacks.')}</p>
        <span class="sb-mock-cta">${esc(draft.storefront.hero.ctaText || 'Browse Catalog')}</span>
      </div>
      <div class="sb-mock-products">
        <div class="sb-mock-card">
          <div class="sb-mock-thumb">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
          </div>
          <div class="sb-mock-title">Digestive Chocolate 400g</div>
          <div class="sb-mock-price">${esc(draft.storefront.currencySymbol || 'GH₵')} 340.00 / ctn</div>
          <span class="sb-mock-badge in">${draft.storefront.policies.showExactStock ? '142 CTN' : 'In Stock'}</span>
        </div>
        <div class="sb-mock-card">
          <div class="sb-mock-thumb">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
          </div>
          <div class="sb-mock-title">Cream Sandwich Biscuits</div>
          <div class="sb-mock-price">${esc(draft.storefront.currencySymbol || 'GH₵')} 280.00 / ctn</div>
          <span class="sb-mock-badge in">${draft.storefront.policies.showExactStock ? '98 CTN' : 'In Stock'}</span>
        </div>
      </div>
    `;
  }

  function bindEvents() {
    view.querySelectorAll('.sb-tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        if (tab === 'preview') {
          previewDevice = previewDevice === 'rep' ? 'desktop' : 'rep';
          activeTab = 'storefront';
        } else {
          activeTab = tab;
        }
        render();
      });
    });

    view.querySelectorAll('.sb-dev-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        previewDevice = btn.dataset.dev;
        const screen = document.getElementById('sbPreviewScreen');
        if (screen) {
          screen.className = `sb-preview-screen ${previewDevice === 'desktop' ? 'desktop' : 'mobile'}`;
        }
        view.querySelectorAll('.sb-dev-btn').forEach((b) => b.classList.toggle('active', b === btn));
        updateLivePreview();
      });
    });

    const onInput = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', (e) => { fn(e.target.value); updateLivePreview(); });
    };
    const onCheck = (id, fn) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', (e) => { fn(e.target.checked); updateLivePreview(); });
    };

    onInput('sfStoreName', (v) => { draft.storefront.storeName = v; });
    onInput('sfTagline', (v) => { draft.storefront.tagline = v; });
    onInput('sfSupportPhone', (v) => { draft.storefront.supportPhone = v; });
    onInput('sfWhatsapp', (v) => { draft.storefront.whatsappNumber = v; });
    onInput('sfCurrency', (v) => { draft.storefront.currencySymbol = v; });

    onCheck('sfAnnounceEnabled', (v) => { draft.storefront.announcement.enabled = v; });
    onInput('sfAnnounceText', (v) => { draft.storefront.announcement.text = v; });
    const selTone = document.getElementById('sfAnnounceTone');
    if (selTone) selTone.addEventListener('change', (e) => {
      draft.storefront.announcement.tone = e.target.value;
      updateLivePreview();
    });

    onInput('sfHeroHeadline', (v) => { draft.storefront.hero.headline = v; });
    onInput('sfHeroSubtitle', (v) => { draft.storefront.hero.subtitle = v; });
    onInput('sfHeroCtaText', (v) => { draft.storefront.hero.ctaText = v; });
    onInput('sfHeroCtaLink', (v) => { draft.storefront.hero.ctaLink = v; });

    onCheck('sfPolicyGuest', (v) => { draft.storefront.policies.allowGuestBrowsing = v; });
    onCheck('sfPolicyCode', (v) => { draft.storefront.policies.requireAccessCodeToOrder = v; });
    onCheck('sfPolicyHideOos', (v) => { draft.storefront.policies.hideOutOfStock = v; });
    onCheck('sfPolicyExactStock', (v) => { draft.storefront.policies.showExactStock = v; });
    onCheck('sfPolicyReorder', (v) => { draft.storefront.policies.enableBulkReorder = v; });

    onInput('repPortalTitle', (v) => { draft.salesRep.portalTitle = v; });
    onInput('repPortalSubtitle', (v) => { draft.salesRep.portalSubtitle = v; });
    onInput('repBroadcast', (v) => { draft.salesRep.broadcastNotice = v; });
    onCheck('repFeatureWa', (v) => { draft.salesRep.features.enableWhatsApp = v; });
    onCheck('repFeatureMaps', (v) => { draft.salesRep.features.enableMaps = v; });
    onCheck('repFeatureCall', (v) => { draft.salesRep.features.enableCall = v; });
    onCheck('repFeatureDiscount', (v) => { draft.salesRep.features.enableQuickDiscount = v; });
    onInput('repDiscountPresets', (v) => {
      draft.salesRep.discountPresets = v.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0 && n <= 100);
    });
    onInput('repExpiryDays', (v) => { draft.salesRep.expiryWarningDays = Number(v) || 60; });

    onInput('opOosThreshold', (v) => { draft.operations.outOfStockThreshold = Number(v) || 0; });
    onInput('opLowThreshold', (v) => { draft.operations.lowStockThreshold = Number(v) || 20; });
    onInput('opWhNotice', (v) => { draft.operations.warehouseNotice = v; });

    const saveBtn = document.getElementById('sbSaveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        try {
          const updated = await api.workspaceUpdateSiteSettings(draft);
          draft._meta = updated._meta;
          showToast('Site settings saved successfully.', 'success');
        } catch (err) {
          showToast(err.message || 'Failed to save settings.', 'error');
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save Changes';
        }
      });
    }

    const resetBtn = document.getElementById('sbResetBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        if (!confirm('Reset all site settings to default configuration?')) return;
        draft = JSON.parse(JSON.stringify(settings));
        render();
        showToast('Settings reset to defaults (unsaved).', 'info');
      });
    }
  }

  render();
}

async function renderUsersPage(view, status) {
  let teamData;
  try {
    teamData = await api.team();
  } catch (err) {
    view.innerHTML = `<div class="ad-head"><div><h1>Users &amp; Roles</h1><p style="color:var(--err);">Failed to load team members: ${esc(err.message)}</p></div></div>`;
    return;
  }

  let users = teamData.users || [];
  const roles = teamData.roles || [];
  const reps = teamData.reps || [];

  let filterRole = 'ALL';
  let searchQuery = '';

  function getInitials(name) {
    if (!name) return '??';
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function getRoleBadge(role) {
    const map = {
      ADMIN: { cls: 'admin', label: 'Administrator' },
      SALES_MANAGER: { cls: 'manager', label: 'Sales Manager' },
      SALES_REP: { cls: 'rep', label: 'Sales Rep' },
      WAREHOUSE: { cls: 'warehouse', label: 'Warehouse' },
    };
    const r = map[role] || { cls: 'manager', label: role };
    return `<span class="usr-role-badge ${r.cls}">${esc(r.label)}</span>`;
  }

  function showUserToast(msg, type = 'success') {
    const existing = document.querySelector('.sb-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.className = `sb-toast ${type}`;
    const icon = type === 'success'
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    t.innerHTML = `<span style="display:grid;place-items:center;">${icon}</span> <span>${esc(msg)}</span>`;
    document.body.appendChild(t);
    setTimeout(() => { t.remove(); }, 3500);
  }

  function showCredentialsModal(userName, tempPassword) {
    const existing = document.getElementById('usrCredModal');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'usrCredModal';
    backdrop.className = 'usr-modal-backdrop';
    backdrop.innerHTML = `
      <div class="usr-modal-box">
        <div class="usr-modal-head">
          <h2>Temporary Password Generated</h2>
          <button type="button" class="usr-modal-close" id="usrCredClose">&times;</button>
        </div>
        <div class="usr-modal-body">
          <p style="margin:0;font-size:14px;color:var(--ink);">
            A one-time temporary password was generated for <b>${esc(userName)}</b>.
            Share this securely with the user. They will be prompted to choose a permanent password upon initial sign-in.
          </p>
          <div class="usr-pwd-banner">
            <span style="font-size:12px;font-weight:600;color:#166534;text-transform:uppercase;letter-spacing:0.5px;">Temporary Sign-In Password</span>
            <div class="usr-pwd-val">
              <span id="usrPwdText">${esc(tempPassword)}</span>
              <button type="button" class="usr-btn-sm success" id="usrCopyPwdBtn">Copy Password</button>
            </div>
          </div>
          <p style="margin:0;font-size:12.5px;color:var(--muted);">
            Notice: This password is shown once and cannot be retrieved later. You can generate a new one at any time using <b>Reset Password</b>.
          </p>
        </div>
        <div class="usr-modal-foot">
          <button type="button" class="sb-btn sb-btn-primary" id="usrCredDone">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    document.getElementById('usrCredClose').addEventListener('click', close);
    document.getElementById('usrCredDone').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const copyBtn = document.getElementById('usrCopyPwdBtn');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(tempPassword);
        copyBtn.textContent = 'Copied to Clipboard';
        setTimeout(() => { copyBtn.textContent = 'Copy Password'; }, 2000);
      } catch (_err) {
        showUserToast('Failed to copy. Please copy manually.', 'error');
      }
    });
  }

  function openAddUserModal() {
    const existing = document.getElementById('usrAddModal');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.id = 'usrAddModal';
    backdrop.className = 'usr-modal-backdrop';

    const repOptions = reps.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}${r.sample ? ' (Sample Rep)' : ''}</option>`).join('');

    backdrop.innerHTML = `
      <div class="usr-modal-box">
        <div class="usr-modal-head">
          <h2>Add Team Member</h2>
          <button type="button" class="usr-modal-close" id="usrAddClose">&times;</button>
        </div>
        <form id="usrAddForm">
          <div class="usr-modal-body">
            <div class="sb-field">
              <label>Full Name *</label>
              <input type="text" class="sb-input" id="newUserName" required placeholder="e.g. Kwesi Mensah" style="width:100%;">
            </div>
            <div class="sb-field">
              <label>Email Address</label>
              <input type="email" class="sb-input" id="newUserEmail" placeholder="e.g. kwesi@boxforless.com" style="width:100%;">
              <small style="color:var(--muted);font-size:12px;">Used for sign-in and security notifications</small>
            </div>
            <div class="sb-field">
              <label>Phone Number (optional)</label>
              <input type="tel" class="sb-input" id="newUserPhone" placeholder="e.g. 0244123456" style="width:100%;">
              <small style="color:var(--muted);font-size:12px;">Staff can sign in with either email or phone</small>
            </div>
            <div class="sb-field">
              <label>Account Role *</label>
              <select class="sb-input" id="newUserRole" style="width:100%;">
                <option value="ADMIN">Administrator (Full system &amp; user control)</option>
                <option value="SALES_MANAGER">Sales Manager (Approvals, customers, rep oversight)</option>
                <option value="SALES_REP">Sales Rep (Field visits, barcode scanning, requests)</option>
                <option value="WAREHOUSE">Warehouse (Stock, lot expiry, barcode audits)</option>
              </select>
            </div>
            <div class="sb-field" id="newUserRepWrap" style="display:none;">
              <label>Link to Sales Rep Territory</label>
              <select class="sb-input" id="newUserRepId" style="width:100%;">
                <option value="NEW">Create new territory code</option>
                ${repOptions}
              </select>
              <small style="color:var(--muted);font-size:12px;">Links this user to an existing field salesperson record</small>
            </div>
          </div>
          <div class="usr-modal-foot">
            <button type="button" class="sb-btn sb-btn-ghost" id="usrAddCancel">Cancel</button>
            <button type="submit" class="sb-btn sb-btn-primary" id="usrAddSubmit">Create Account</button>
          </div>
        </form>
      </div>
    `;
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    document.getElementById('usrAddClose').addEventListener('click', close);
    document.getElementById('usrAddCancel').addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

    const roleSelect = document.getElementById('newUserRole');
    const repWrap = document.getElementById('newUserRepWrap');
    roleSelect.addEventListener('change', () => {
      repWrap.style.display = roleSelect.value === 'SALES_REP' ? 'block' : 'none';
    });

    const form = document.getElementById('usrAddForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('usrAddSubmit');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';

      const name = document.getElementById('newUserName').value.trim();
      const email = document.getElementById('newUserEmail').value.trim();
      const phone = document.getElementById('newUserPhone').value.trim();
      const role = roleSelect.value;
      const repId = role === 'SALES_REP' ? document.getElementById('newUserRepId').value : undefined;

      try {
        const res = await api.createTeamUser({ name, email, phone, role, repId });
        close();
        showUserToast(`Account for ${name} created successfully!`, 'success');
        showCredentialsModal(name, res.temporaryPassword);
        const updated = await api.team();
        users = updated.users || [];
        render();
      } catch (err) {
        showUserToast(err.message || 'Failed to create user.', 'error');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
      }
    });
  }

  function render() {
    const totalCount = users.length;
    const adminCount = users.filter((u) => u.role === 'ADMIN').length;
    const managerCount = users.filter((u) => u.role === 'SALES_MANAGER').length;
    const repCount = users.filter((u) => u.role === 'SALES_REP').length;
    const warehouseCount = users.filter((u) => u.role === 'WAREHOUSE').length;
    const inactiveCount = users.filter((u) => !u.active).length;
    const activeCount = users.filter((u) => u.active).length;
    const activePct = totalCount > 0 ? Math.round((activeCount / totalCount) * 100) : 100;

    let filtered = users.filter((u) => {
      if (filterRole === 'ADMIN' && u.role !== 'ADMIN') return false;
      if (filterRole === 'SALES_MANAGER' && u.role !== 'SALES_MANAGER') return false;
      if (filterRole === 'SALES_REP' && u.role !== 'SALES_REP') return false;
      if (filterRole === 'WAREHOUSE' && u.role !== 'WAREHOUSE') return false;
      if (filterRole === 'INACTIVE' && u.active) return false;
      return true;
    });

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((u) =>
        (u.name && u.name.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.phone && u.phone.includes(q)) ||
        (u.roleLabel && u.roleLabel.toLowerCase().includes(q))
      );
    }

    const envRoles = [
      ['Admin', status.roles.admin],
      ['Sales Manager', status.roles.salesManager],
      ['Sales Rep', status.roles.salesRep],
    ];

    view.innerHTML = `
      <div class="usr-head">
        <div>
          <h1>Users &amp; Access Control</h1>
          <p>Manage staff accounts, assign administrative roles, reset passwords, and control team access.</p>
        </div>
        <button type="button" class="sb-btn sb-btn-primary" id="usrAddBtn">
          Add Team Member
        </button>
      </div>

      <!-- KPI Summary Cards -->
      <div class="ad-kpis" style="margin-bottom:20px;">
        <div class="ad-kpi ad-kpi-blue">
          <span class="ad-kpi-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </span>
          <span>
            <span class="ad-kpi-k">Total Team</span>
            <b class="ad-kpi-v">${num(totalCount)}</b>
          </span>
        </div>
        <div class="ad-kpi ad-kpi-purple">
          <span class="ad-kpi-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </span>
          <span>
            <span class="ad-kpi-k">Administrators</span>
            <b class="ad-kpi-v">${num(adminCount)}</b>
          </span>
        </div>
        <div class="ad-kpi ad-kpi-green">
          <span class="ad-kpi-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/></svg>
          </span>
          <span>
            <span class="ad-kpi-k">Sales Team</span>
            <b class="ad-kpi-v">${num(managerCount + repCount)}</b>
          </span>
        </div>
        <div class="ad-kpi ad-kpi-amber">
          <span class="ad-kpi-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
          </span>
          <span>
            <span class="ad-kpi-k">Active Status</span>
            <b class="ad-kpi-v">${activePct}%</b>
          </span>
        </div>
      </div>

      <!-- Main Directory Section -->
      <section class="ad-card" style="margin-bottom:24px;">
        <!-- Toolbar & Filter Chips -->
        <div class="usr-toolbar">
          <div class="usr-chips">
            <button type="button" class="usr-chip ${filterRole === 'ALL' ? 'active' : ''}" data-filter="ALL">All (${totalCount})</button>
            <button type="button" class="usr-chip ${filterRole === 'ADMIN' ? 'active' : ''}" data-filter="ADMIN">Admins (${adminCount})</button>
            <button type="button" class="usr-chip ${filterRole === 'SALES_MANAGER' ? 'active' : ''}" data-filter="SALES_MANAGER">Managers (${managerCount})</button>
            <button type="button" class="usr-chip ${filterRole === 'SALES_REP' ? 'active' : ''}" data-filter="SALES_REP">Reps (${repCount})</button>
            <button type="button" class="usr-chip ${filterRole === 'WAREHOUSE' ? 'active' : ''}" data-filter="WAREHOUSE">Warehouse (${warehouseCount})</button>
            ${inactiveCount > 0 ? `<button type="button" class="usr-chip ${filterRole === 'INACTIVE' ? 'active' : ''}" data-filter="INACTIVE">Inactive (${inactiveCount})</button>` : ''}
          </div>
          <input type="search" id="usrSearchInput" class="usr-search-input" placeholder="Search by name, email, or role..." value="${esc(searchQuery)}">
        </div>

        <!-- Team Table -->
        <div class="ad-table-wrap">
          <table class="ad-table">
            <thead>
              <tr>
                <th>Team Member</th>
                <th>Assigned Role</th>
                <th>Territory / Rep ID</th>
                <th>Last Active</th>
                <th>Account Status</th>
                <th style="text-align:right;">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${filtered.length ? filtered.map((u) => {
                const repObj = reps.find((r) => r.id === u.repId);
                const repDisplay = repObj ? `${esc(repObj.name)} <small style="color:var(--muted);">${repObj.sample ? '(Sample)' : ''}</small>` : (u.repId ? esc(u.repId) : '—');
                const avatarCls = u.role === 'ADMIN' ? 'admin' : (u.role === 'SALES_MANAGER' ? 'manager' : (u.role === 'SALES_REP' ? 'rep' : 'warehouse'));
                const contactDisplay = [u.email, u.phone].filter(Boolean).map(esc).join(' • ');

                return `
                  <tr>
                    <td>
                      <div class="usr-user-cell">
                        <div class="usr-avatar ${avatarCls}">${getInitials(u.name)}</div>
                        <div class="usr-info">
                          <b>${esc(u.name)}</b>
                          <span>${contactDisplay || 'No contact specified'}</span>
                        </div>
                      </div>
                    </td>
                    <td>${getRoleBadge(u.role)}</td>
                    <td>${repDisplay}</td>
                    <td><small style="color:var(--muted);">${u.lastLoginAt ? date(u.lastLoginAt) : 'Never signed in'}</small></td>
                    <td>
                      <span class="usr-status-pill ${u.active ? 'active' : 'inactive'}">
                        <span class="usr-status-dot"></span>
                        ${u.active ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    <td>
                      <div class="usr-actions">
                        <button type="button" class="usr-btn-sm" data-action="reset" data-id="${u.id}" data-name="${esc(u.name)}" title="Generate temporary one-time password">
                          Reset Password
                        </button>
                        <button type="button" class="usr-btn-sm ${u.active ? 'danger' : 'success'}" data-action="toggle-active" data-id="${u.id}" data-active="${u.active ? '1' : '0'}" title="${u.active ? 'Deactivate user' : 'Reactivate user'}">
                          ${u.active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                `;
              }).join('') : `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--muted);">No team members found matching your search.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>

      <!-- Environment Fallback Reference -->
      ${card('Configured Deployment Fallback Roles', `
        ${renderTable(['Role', 'Status'], envRoles.map(([name, ready]) => `<tr><td>${name}</td><td>${statusPill(ready)}</td></tr>`), 'No roles configured.')}
        <p class="mu" style="margin-top:12px;font-size:13px;color:var(--muted);">
          Environment-configured sign-in credentials configured in server environment variables act as bootstrap/recovery accounts.
        </p>
      `)}
    `;

    document.getElementById('usrAddBtn')?.addEventListener('click', openAddUserModal);

    const searchInput = document.getElementById('usrSearchInput');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        render();
        const newSearch = document.getElementById('usrSearchInput');
        if (newSearch) {
          newSearch.focus();
          newSearch.setSelectionRange(newSearch.value.length, newSearch.value.length);
        }
      });
    }

    view.querySelectorAll('.usr-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        filterRole = chip.dataset.filter;
        render();
      });
    });

    view.querySelectorAll('button[data-action="reset"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const name = btn.dataset.name;
        if (!confirm(`Are you sure you want to generate a new temporary password for ${name}?`)) return;
        try {
          const res = await api.resetTeamPassword(id);
          showUserToast(`Password reset for ${name}.`, 'success');
          showCredentialsModal(name, res.temporaryPassword);
        } catch (err) {
          showUserToast(err.message || 'Failed to reset password.', 'error');
        }
      });
    });

    view.querySelectorAll('button[data-action="toggle-active"]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id);
        const currentActive = btn.dataset.active === '1';
        const nextActive = !currentActive;
        const actionLabel = nextActive ? 'reactivate' : 'deactivate';
        if (!confirm(`Are you sure you want to ${actionLabel} this account?`)) return;
        try {
          await api.setTeamActive(id, nextActive);
          showUserToast(`Account ${nextActive ? 'activated' : 'deactivated'} successfully.`, 'success');
          const updated = await api.team();
          users = updated.users || [];
          render();
        } catch (err) {
          showUserToast(err.message || 'Failed to update account status.', 'error');
        }
      });
    });
  }

  render();
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
