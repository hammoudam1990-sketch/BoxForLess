// Router + navigation shell.
import { api } from './api.js';
import { renderProducts, renderProductDetail } from './products.js';
import { renderImports, renderImportDetail } from './imports.js';
import { renderChanges } from './changes.js';

const view = document.getElementById('view');

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
}

async function refreshBadge() {
  try {
    const { counts } = await api.reviews();
    const badge = document.getElementById('reviewBadge');
    const n = counts?.total || 0;
    badge.textContent = n;
    badge.classList.toggle('hidden', n === 0);
  } catch { /* ignore */ }
}

async function route() {
  const hash = location.hash || '#/products';
  const [, path, arg] = hash.split('/'); // "#", "products", "123"
  view.innerHTML = '<div class="card muted">Loading…</div>';
  try {
    if (path === 'products' && arg) { setActiveNav('products'); await renderProductDetail(view, arg); }
    else if (path === 'products') { setActiveNav('products'); await renderProducts(view); }
    else if (path === 'imports' && arg) { setActiveNav('imports'); await renderImportDetail(view, arg); }
    else if (path === 'imports') { setActiveNav('imports'); await renderImports(view); }
    else if (path === 'changes') { setActiveNav('changes'); await renderChanges(view); }
    else { location.hash = '#/products'; }
  } catch (e) {
    view.innerHTML = `<div class="card errbox">Error: ${e.message}</div>`;
  }
  refreshBadge();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => { route(); refreshBadge(); });
export { refreshBadge };
