// Staff shell: sidebar, top bar with search, and the router.
window.__bflBooted = true; // tells js/boot-guard.js the page started
import { api } from './api.js';
import { renderDashboard } from './dashboard.js';
import { renderProducts, renderProductDetail } from './products.js';
import { renderImports, renderImportDetail } from './imports.js';
import { renderChanges } from './changes.js';
import { renderRequests, renderRequestDetail } from './requests.js';
import { renderAccessCodes, renderAccessRequests } from './access.js';

const view = document.getElementById('view');
const side = document.getElementById('side');
const scrim = document.getElementById('scrim');
const menuToggle = document.getElementById('menuToggle');

function setActiveNav(name) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === name;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function setBadge(id, n) {
  const badge = document.getElementById(id);
  if (!badge) return;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

/** Pending counts: the sidebar badges, and the bell at the top. */
async function refreshBadge() {
  let reviews = 0;
  let access = 0;
  try {
    const { counts } = await api.reviews();
    reviews = counts?.total || 0;
    setBadge('reviewBadge', reviews);
  } catch { /* ignore */ }
  // Companies waiting to be let in. Shown in the nav so a request for access is not missed.
  try {
    const { total } = await api.accessRequests('PENDING');
    access = total || 0;
    setBadge('accessBadge', access);
  } catch { /* ignore */ }
  setBadge('bellCount', reviews + access);
}

// ---- the drawer on phones and small laptops ----
function openSide(open) {
  side.classList.toggle('open', open);
  scrim.hidden = !open;
  menuToggle.setAttribute('aria-expanded', String(open));
}
menuToggle.addEventListener('click', () => openSide(!side.classList.contains('open')));
scrim.addEventListener('click', () => openSide(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') openSide(false); });

// ---- the top search: opens the product list with the search filled in ----
document.getElementById('globalSearch').addEventListener('submit', (e) => {
  e.preventDefault();
  const term = document.getElementById('gsearch').value.trim();
  try { sessionStorage.setItem('bfl.productSearch', term); } catch { /* storage blocked */ }
  if (location.hash === '#/products') route();
  else location.hash = '#/products';
});
// "/" focuses the search, unless someone is already typing somewhere
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  document.getElementById('gsearch').focus();
});

const LOADING = '<div class="card"><div class="sk-lines" role="status" aria-label="Loading"><i></i><i></i><i></i><i></i></div></div>';

async function route() {
  const hash = location.hash || '#/dashboard';
  const [, path, arg] = hash.split('/'); // "#", "products", "123"
  openSide(false);
  view.innerHTML = LOADING;
  try {
    if (path === 'dashboard' || !path) { setActiveNav('dashboard'); await renderDashboard(view); }
    else if (path === 'products' && arg) { setActiveNav('products'); await renderProductDetail(view, arg); }
    else if (path === 'products') { setActiveNav('products'); await renderProducts(view); }
    else if (path === 'imports' && arg) { setActiveNav('imports'); await renderImportDetail(view, arg); }
    else if (path === 'imports') { setActiveNav('imports'); await renderImports(view); }
    else if (path === 'changes') { setActiveNav('changes'); await renderChanges(view); }
    else if (path === 'requests' && arg) { setActiveNav('requests'); await renderRequestDetail(view, arg); }
    else if (path === 'requests') { setActiveNav('requests'); await renderRequests(view); }
    else if (path === 'codes') { setActiveNav('codes'); await renderAccessCodes(view); }
    else if (path === 'access') { setActiveNav('access'); await renderAccessRequests(view); }
    else { location.hash = '#/dashboard'; return; }
  } catch (e) {
    view.innerHTML = `<div class="card errbox">Error: ${e.message}</div>`;
  }
  refreshBadge();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('staffLogout')?.addEventListener('click', async () => {
    await fetch('/api/staff/logout', { method: 'POST' });
    location.assign('/staff/login');
  });
  route();
  window.setInterval(refreshBadge, 15000);
});
export { refreshBadge };
