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

  imports: () => fetch('/api/imports').then(handle),
  importBatch: (id) => fetch(`/api/imports/${id}`).then(handle),
  uploadPreview: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return fetch('/api/imports', { method: 'POST', body: fd }).then(handle);
  },
  confirmImport: (id) => fetch(`/api/imports/${id}/confirm`, { method: 'POST' }).then(handle),

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
  customerCodes: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return fetch(`/api/requests/customers/codes?${q}`).then(handle);
  },
  issueCustomerCode: (id) => fetch(`/api/requests/customers/${id}/code`, { method: 'POST' }).then(handle),

  accessRequests: (status = '') =>
    fetch(`/api/requests/access-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`).then(handle),
  approveAccessRequest: (id) =>
    fetch(`/api/requests/access-requests/${id}/approve`, { method: 'POST' }).then(handle),
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
