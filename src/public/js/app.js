// Router + navigation shell.
window.__bflBooted = true; // tells js/boot-guard.js the page started
import { api } from './api.js';
import { renderProducts, renderProductDetail } from './products.js';
import { renderImports, renderImportDetail } from './imports.js';
import { renderChanges } from './changes.js';
import { renderRequests, renderRequestDetail } from './requests.js';
import { renderAccessCodes, renderAccessRequests } from './access.js';

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

  // Companies waiting to be let in. Shown in the nav so a request for access is
  // not missed — nobody thinks to open a screen that is usually empty.
  try {
    const { total } = await api.accessRequests('PENDING');
    const badge = document.getElementById('accessBadge');
    badge.textContent = total;
    badge.classList.toggle('hidden', total === 0);
  } catch { /* ignore */ }
}

async function route() {
  const hash = location.hash || '#/products';
  const [, path, arg] = hash.split('/'); // "#", "products", "123"
  view.innerHTML = '<div class="card muted"><span class="spinner" aria-hidden="true"></span>Loading…</div>';
  try {
    if (path === 'products' && arg) { setActiveNav('products'); await renderProductDetail(view, arg); }
    else if (path === 'products') { setActiveNav('products'); await renderProducts(view); }
    else if (path === 'imports' && arg) { setActiveNav('imports'); await renderImportDetail(view, arg); }
    else if (path === 'imports') { setActiveNav('imports'); await renderImports(view); }
    else if (path === 'changes') { setActiveNav('changes'); await renderChanges(view); }
    else if (path === 'requests' && arg) { setActiveNav('requests'); await renderRequestDetail(view, arg); }
    else if (path === 'requests') { setActiveNav('requests'); await renderRequests(view); }
    else if (path === 'codes') { setActiveNav('codes'); await renderAccessCodes(view); }
    else if (path === 'access') { setActiveNav('access'); await renderAccessRequests(view); }
    else { location.hash = '#/products'; }
  } catch (e) {
    view.innerHTML = `<div class="card errbox">Error: ${e.message}</div>`;
  }
  refreshBadge();
}

// phone menu: the nav folds away behind a Menu button, and closes after a choice
const topbar = document.querySelector('.topbar');
const menuToggle = document.getElementById('menuToggle');
menuToggle?.addEventListener('click', () => {
  const open = topbar.classList.toggle('menu-open');
  menuToggle.setAttribute('aria-expanded', String(open));
});
const syncTheme = () => { const b = document.getElementById('themeBtn'); if (b) b.textContent = window.bflTheme?.isDark() ? 'Light mode' : 'Dark mode'; };
document.getElementById('themeBtn')?.addEventListener('click', () => { window.bflTheme?.toggle(); syncTheme(); });
window.addEventListener('bfl:theme', syncTheme);
window.addEventListener('hashchange', () => { topbar?.classList.remove('menu-open'); menuToggle?.setAttribute('aria-expanded', 'false'); });
window.addEventListener('load', syncTheme);

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('staffLogout')?.addEventListener('click', async () => {
    await fetch('/api/staff/logout', { method: 'POST' });
    location.assign('/staff/login');
  });
  route();
  refreshBadge();
});
export { refreshBadge };
