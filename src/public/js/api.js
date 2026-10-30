// Thin fetch wrapper around the REST API.
async function handle(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) window.location.assign('/staff/login');
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  products: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetch(`/api/products?${q}`).then(handle);
  },
  product: (id) => fetch(`/api/products/${id}`).then(handle),
  stats: () => fetch('/api/products/stats').then(handle),
  workspaceStatus: () => fetch('/api/admin-workspace/status').then(handle),
  workspaceQuotations: () => fetch('/api/admin-workspace/quotations').then(handle),
  workspaceVisibility: () => fetch('/api/admin-workspace/visibility').then(handle),
  workspaceStockExpiry: (band = 'all') =>
    fetch(`/api/admin-workspace/stock-expiry?band=${encodeURIComponent(band)}`).then(handle),
  workspaceDataQuality: () => fetch('/api/admin-workspace/data-quality').then(handle),
  // The Warehouse Manager's dashboard (read-only): KPIs, inventory, stock movements, alerts.
  warehouseSummary: (params = {}) => fetch(`/api/warehouse/summary?${new URLSearchParams(params)}`).then(handle),
  warehouseInventory: (params = {}) => fetch(`/api/warehouse/inventory?${new URLSearchParams(params)}`).then(handle),
  warehouseMovements: (params = {}) => fetch(`/api/warehouse/movements?${new URLSearchParams(params)}`).then(handle),
  warehouseNotifications: () => fetch('/api/warehouse/notifications').then(handle),
  // The payment due date the Sales Manager sets for an order (keyed by the request id), and the orders still without one.
  paymentDue: (requestId) => fetch(`/api/payments/orders/${encodeURIComponent(requestId)}/due-date`).then(handle),
  setPaymentDue: (requestId, body) => fetch(`/api/payments/orders/${encodeURIComponent(requestId)}/due-date`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle),
  ordersAwaitingDueDate: () => fetch('/api/payments/orders/awaiting-due-date').then(handle),
  // The Sales Manager's dashboard (managers only): figures, reps, orders, customers, targets, settings, search, alerts.
  salesSummary: (params = {}) => fetch(`/api/sales-dashboard/summary?${new URLSearchParams(params)}`).then(handle),
  salesRep: (id, params = {}) => fetch(`/api/sales-dashboard/reps/${encodeURIComponent(id)}?${new URLSearchParams(params)}`).then(handle),
  salesOrders: (params = {}) => fetch(`/api/sales-dashboard/orders?${new URLSearchParams(params)}`).then(handle),
  salesCustomers: (params = {}) => fetch(`/api/sales-dashboard/customers?${new URLSearchParams(params)}`).then(handle),
  salesCustomer: (id, params = {}) => fetch(`/api/sales-dashboard/customers/${encodeURIComponent(id)}?${new URLSearchParams(params)}`).then(handle),
  salesTargets: (month = '') => fetch(`/api/sales-dashboard/targets?${new URLSearchParams(month ? { month } : {})}`).then(handle),
  salesTargetHistory: () => fetch('/api/sales-dashboard/targets/history?limit=50').then(handle),
  setSalesTarget: (body) => fetch('/api/sales-dashboard/targets', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle),
  salesSettings: () => fetch('/api/sales-dashboard/settings').then(handle),
  setSalesSettings: (body) => fetch('/api/sales-dashboard/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(handle),
  salesSearch: (q) => fetch(`/api/sales-dashboard/search?${new URLSearchParams({ q })}`).then(handle),
  salesNotifications: () => fetch('/api/sales-dashboard/notifications').then(handle),
  siteSettings: () => fetch('/api/site-settings').then(handle),
  workspaceSiteSettings: () => fetch('/api/admin-workspace/site-settings').then(handle),
  workspaceUpdateSiteSettings: (settings) => fetch('/api/admin-workspace/site-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  }).then(handle),
  team: () => fetch('/api/team').then(handle),
  createTeamMember: (data) => fetch('/api/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }).then(handle),
  resetTeamPassword: (id) => fetch(`/api/team/${encodeURIComponent(id)}/reset-password`, {
    method: 'POST',
  }).then(handle),
  setTeamActive: (id, active) => fetch(`/api/team/${encodeURIComponent(id)}/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active }),
  }).then(handle),
  odooHealth: () => fetch('/api/odoo/health').then(handle),
  odooReconciliation: () => fetch('/api/odoo/reconciliation').then(handle),
  odooSystemStats: () => fetch('/api/odoo/system-stats').then(handle),
  odooBackups: () => fetch('/api/odoo/backups').then(handle),
  odooCreateBackup: () => fetch('/api/odoo/backups/create', { method: 'POST' }).then(handle),
  odooRetry: (id) => fetch(`/api/odoo/outbox/${encodeURIComponent(id)}/retry`, { method: 'POST' }).then(handle),
  odooRetryAll: () => fetch('/api/odoo/outbox/retry-all', { method: 'POST' }).then(handle),
  odooRunSync: (type, full = false) => fetch(`/api/odoo/sync/${encodeURIComponent(type)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full }),
  }).then(handle),

  imports: () => fetch('/api/imports').then(handle),
  importBatch: (id) => fetch(`/api/imports/${id}`).then(handle),
  uploadPreview: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/imports', { method: 'POST', body: fd }).then(handle);
  },
  confirmImport: (id) => fetch(`/api/imports/${id}/confirm`, { method: 'POST' }).then(handle),
  deleteImportSourceFile: (id) => fetch(`/api/imports/${id}/source-file`, { method: 'DELETE' }).then(handle),

  // customer list import (staff) — separate endpoint from the product import
  customerImports: () => fetch('/api/customer-imports').then(handle),
  uploadCustomerPreview: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/customer-imports', { method: 'POST', body: fd }).then(handle);
  },
  confirmCustomerImport: (id) => fetch(`/api/customer-imports/${id}/confirm`, { method: 'POST' }).then(handle),

  productImageUrl: (id) => `/api/products/${id}/image`,
  saveProductImage: (id, blob, { replace = false } = {}) => {
    const fd = new FormData();
    fd.append('image', blob, 'photo.jpg');
    const q = replace ? '?replace=true' : '';
    return fetch(`/api/products/${id}/image${q}`, { method: 'POST', body: fd }).then(handle);
  },

  reviews: () => fetch('/api/reviews').then(handle),
  resolveBarcode: (productId, decision) =>
    fetch(`/api/reviews/barcode/${productId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).then(handle),
  resolveUom: (productId, decision) =>
    fetch(`/api/reviews/uom/${productId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    }).then(handle),

  // Customer access codes. These responses carry real codes, so they are staff
  // endpoints and must never be called from the catalog bundle.
  // Customer requests (staff view)
  requestStockStatus: () => fetch('/api/requests/stock-status').then(handle),
  requests: ({ deleted = false, limit } = {}) => {
    const q = new URLSearchParams({ ...(deleted ? { deleted: 'true' } : {}), ...(limit ? { limit: String(limit) } : {}) }).toString();
    return fetch(`/api/requests${q ? `?${q}` : ''}`).then(handle);
  },

  customerCodes: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetch(`/api/requests/customers/codes?${q}`).then(handle);
  },
  issueCustomerCode: (id) => fetch(`/api/requests/customers/${id}/code`, { method: 'POST' }).then(handle),

  // Warehouse expiry list (S03) — staff only; sample data until the Odoo lot sync exists.
  expiry: (params = {}) => fetch(`/api/expiry?${new URLSearchParams(params)}`).then(handle),
  // The Sales Manager's discount on a lot in our warehouse, offered to customers (pct null switches it off).
  setExpiryDiscount: (key, pct) =>
    fetch(`/api/expiry/lots/${encodeURIComponent(key)}/discount`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct }),
    }).then(handle),
  saveExpiryDecision: (key, fields) =>
    fetch(`/api/expiry/lots/${encodeURIComponent(key)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
    }).then(handle),
  expiryCsv: async (query = '') => {
    const res = await fetch(`/api/expiry/export.csv?${query}`);
    if (res.status === 401) window.location.assign('/staff/login');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },

  // Customers' minimum shelf life (W3) — a stand-in for the Odoo customer field.
  shelfLifeCustomers: (q = '') => fetch(`/api/expiry/customers?${new URLSearchParams({ q })}`).then(handle),
  setMinShelfLife: (id, days) => fetch(`/api/expiry/customers/${id}/min-shelf-life`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days }),
  }).then(handle),

  // Which customers belong to which sales rep.
  repCustomers: () => fetch('/api/reps').then(handle),
  assignRepCustomer: (kind, id, repId) => fetch('/api/reps/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id, repId }) }).then(handle),

  // Sync health (S05): the Odoo connection, the syncs and the outbox.
  odooHealth: () => fetch('/api/odoo/health').then(handle),
  odooRetry: (id) => fetch(`/api/odoo/outbox/${id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(handle),

  // Monthly reports (S06).
  reportsStart: () => fetch('/api/reports').then(handle),
  report: (report, month) => fetch(`/api/reports/report?report=${report}&month=${month}`).then(handle),
  saveReportNotes: (body) => fetch('/api/reports/notes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(handle),
  reportTargets: () => fetch('/api/reports/targets').then(handle),
  setReportTarget: (body) => fetch('/api/reports/targets', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(handle),
  myMonth: () => fetch('/api/reports/my').then(handle),
  // Returns to classify (S04).
  returns: () => fetch('/api/returns').then(handle),
  returnsAlert: () => fetch('/api/returns/alert').then(handle),
  classifyReturn: (id, body) => fetch(`/api/returns/${id}/classify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(handle),
  // Sample Odoo: returns, credit notes and sample history.
  sampleReturnOptions: () => fetch('/api/sample-odoo/return-options').then(handle),
  sampleCreateReturn: (body) => fetch('/api/sample-odoo/returns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(handle),
  sampleReturnCreditNote: (id) => fetch(`/api/sample-odoo/returns/${id}/credit-note`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(handle),
  sampleSeedHistory: () => fetch('/api/sample-odoo/history', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(handle),

  // Payments due (S07): schedules and reminders.
  payments: () => fetch('/api/payments').then(handle),
  runPaymentReminders: () => fetch('/api/payments/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(handle),
  setPaymentSchedule: (id, body) => fetch(`/api/payments/customers/${id}/schedule`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(handle),
  markPaymentReminderSent: (id) => fetch(`/api/payments/reminders/${id}/sent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(handle),

  // Team: staff accounts (administrator and Sales Manager).
  team: () => fetch('/api/team').then(handle),
  createTeamUser: (body) => fetch('/api/team', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(handle),
  resetTeamPassword: (id) => fetch(`/api/team/${id}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(handle),
  setTeamActive: (id, active) => fetch(`/api/team/${id}/active`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
  }).then(handle),
  // Customers: Odoo ID (what they sign in with) and password reset.
  setOdooId: (id, odooId) => fetch(`/api/requests/customers/${id}/odoo-id`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ odooId }),
  }).then(handle),
  resetCustomerPassword: (id) => fetch(`/api/requests/customers/${id}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(handle),

  // Sample Odoo: the stand-in for Odoo's side of an order (404 once the real Odoo is connected).
  sampleOdoo: () => fetch('/api/sample-odoo').then(handle),
  sampleOdooStep: (id, step) => fetch(`/api/sample-odoo/orders/${id}/${step}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(handle),
  sampleOdooAge: (id) => fetch(`/api/sample-odoo/invoices/${id}/age`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(handle),
  sampleOdooCreditLimit: (id, limit) => fetch(`/api/sample-odoo/customers/${id}/credit-limit`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ limit }),
  }).then(handle),

  // Customer-shelf expiry: rep visits and the Sales Manager's approvals (sample data for now).
  shelfReps: () => fetch('/api/shelf/reps').then(handle),
  shelfVisits: (rep, q = '') => fetch(`/api/shelf/my-visits?${new URLSearchParams({ rep, q })}`).then(handle),
  shelfSheet: (rep, customer) => fetch(`/api/shelf/visit-sheet?${new URLSearchParams({ rep, customer })}`).then(handle),
  saveShelfVisit: (body) => fetch('/api/shelf/visits', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(handle),
  // the visit log (Sales Manager / administrator): every saved visit with its lines
  shelfVisitLog: (limit = 100) => fetch(`/api/shelf/visits?${new URLSearchParams({ limit })}`).then(handle),
  // The Sales Manager's discount on lots that sit on customers' shelves (the rep sees it on the visit).
  shelfLotDiscounts: () => fetch('/api/shelf/lot-discounts').then(handle),
  setShelfLotDiscount: (key, pct) => fetch(`/api/shelf/lot-discounts/${encodeURIComponent(key)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct }),
  }).then(handle),
  shelfApprovals: () => fetch('/api/shelf/approvals').then(handle),
  shelfDecide: (id, body) => fetch(`/api/shelf/approvals/${id}/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then(handle),
  shelfCreditNote: (id, ref) => fetch(`/api/shelf/approvals/${id}/credit-note`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ref }),
  }).then(handle),

  accessRequests: (status = '') =>
    fetch(`/api/requests/access-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`).then(handle),
  accessRequest: (id) => fetch(`/api/requests/access-requests/${id}`).then(handle),
  accessOptions: () => fetch('/api/requests/access-requests/options').then(handle),
  approveAccessRequest: (id, decision = {}) =>
    fetch(`/api/requests/access-requests/${id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(decision),
    }).then(handle),
  rejectAccessRequest: (id, reason = null) =>
    fetch(`/api/requests/access-requests/${id}/reject`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason }),
    }).then(handle),
};

// tiny DOM helpers
export const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const num = (n) => (n === null || n === undefined || n === '' ? '' : Number(n).toLocaleString());

export function toast(msg, kind = '') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add('hidden'), 3200);
}

export function stockPill(status) {
  const map = { IN_STOCK: ['ok', 'In stock'], LIMITED_STOCK: ['warn', 'Limited'], OUT_OF_STOCK: ['muted', 'Out of stock'] };
  const [cls, label] = map[status] || ['muted', status || '—'];
  return `<span class="pill ${cls}">${label}</span>`;
}
