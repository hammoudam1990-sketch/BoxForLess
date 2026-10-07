// Thin fetch wrapper around the STAFF REST API.
//
// Staff screens and the scanner only. Several of these calls return real customer
// access codes, so the customer catalogue must never import this file — it has its
// own, much smaller client in catalog/http.js.
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

const json = (method, body) => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const query = (params = {}) => new URLSearchParams(params).toString();

export const api = {
  products: (params = {}) => fetch(`/api/products?${query(params)}`).then(handle),
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
    fetch(`/api/reviews/barcode/${productId}`, json('POST', { decision })).then(handle),
  resolveUom: (productId, decision) =>
    fetch(`/api/reviews/uom/${productId}`, json('POST', { decision })).then(handle),

  // Customer requests (staff view)
  requestStockStatus: () => fetch('/api/requests/stock-status').then(handle),
  requests: ({ deleted = false, limit } = {}) => {
    const q = query({ ...(deleted ? { deleted: 'true' } : {}), ...(limit ? { limit } : {}) });
    return fetch(`/api/requests${q ? `?${q}` : ''}`).then(handle);
  },
  request: (id) => fetch(`/api/requests/${encodeURIComponent(id)}`).then(handle),
  acceptRequest: (id) => fetch(`/api/requests/${encodeURIComponent(id)}/accept`, { method: 'POST' }).then(handle),
  withdrawRequest: (id) => fetch(`/api/requests/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(handle),
  restoreRequest: (id) => fetch(`/api/requests/${encodeURIComponent(id)}/restore`, { method: 'POST' }).then(handle),
  /** The request as an .xlsx file. Resolves to a Blob. */
  exportRequest: async (id) => {
    const res = await fetch(`/api/requests/${encodeURIComponent(id)}/export.xlsx`);
    if (res.status === 401) window.location.assign('/staff/login');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },

  // Customer access codes. These responses carry real codes, so they are staff
  // endpoints and must never be called from the catalog bundle.
  customerCodes: (params = {}) => fetch(`/api/requests/customers/codes?${query(params)}`).then(handle),
  issueCustomerCode: (id) => fetch(`/api/requests/customers/${id}/code`, { method: 'POST' }).then(handle),

  accessRequests: (status = '') =>
    fetch(`/api/requests/access-requests${status ? `?status=${encodeURIComponent(status)}` : ''}`).then(handle),
  approveAccessRequest: (id) =>
    fetch(`/api/requests/access-requests/${id}/approve`, { method: 'POST' }).then(handle),
  rejectAccessRequest: (id, reason = null) =>
    fetch(`/api/requests/access-requests/${id}/reject`, json('POST', { reason })).then(handle),

  // Signing in is the one call that must NOT bounce to the sign-in page on a 401.
  staffLogin: async (username, password) => {
    const res = await fetch('/api/staff/login', json('POST', { username, password }));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Sign in failed (${res.status}).`);
    return body;
  },
  staffLogout: () => fetch('/api/staff/logout', { method: 'POST' }),
};

export default api;
