// Staff shell: sidebar, top bar with search, and the router.
window.__bflBooted = true; // tells js/boot-guard.js the page started
import { api } from './api.js';
import { renderDashboard } from './dashboard.js';
import { renderProducts, renderProductDetail } from './products.js';
import { renderImports, renderImportDetail } from './imports.js';
import { renderChanges } from './changes.js';
import { renderExpiry } from './expiry.js';
import { renderSampleOdoo } from './sample-odoo.js';
import { renderApprovals } from './approvals.js';
import { renderRequests, renderRequestDetail } from './requests.js';
import { renderAccessCodes, renderAccessRequests } from './access.js';
import { renderTeam } from './team.js';
import { renderPayments } from './payments.js';
import { renderVisibility } from './visibility.js';
import { renderReports } from './reports.js';
import { renderReturns } from './returns.js';
import { renderHealth } from './health.js';
import { renderRepCustomers } from './rep-customers.js';
import { renderWorkspacePage, renderCategories } from './workspace.js';
import { renderWarehouseHome } from './warehouse.js';
import { renderVisits } from './visits.js';

const view = document.getElementById('view');
const side = document.getElementById('side');
const scrim = document.getElementById('scrim');
const menuToggle = document.getElementById('menuToggle');

// ---- who is signed in, and what their role reaches ----
// The server is what actually enforces this; hiding the rest here just keeps the screen to what a
// person can use. null = everything.
const ROLE_NAV = {
  ADMIN: null,
  SALES_MANAGER: ['access', 'codes', 'requests', 'approvals', 'expiry', 'sample-odoo', 'products', 'rep', 'team', 'rep-customers', 'payments', 'visibility', 'returns', 'reports', 'health', 'visits', 'workspace', 'workspace-data-quality'],
  WAREHOUSE: ['warehouse', 'products', 'imports', 'changes', 'expiry', 'scan', 'returns', 'reports', 'health', 'workspace', 'workspace-data-quality'],
};
const ROLE_START = { ADMIN: '#/dashboard', SALES_MANAGER: '#/access', WAREHOUSE: '#/warehouse' };
let me = { role: 'ADMIN', name: 'Staff' };
const allowed = (name) => !ROLE_NAV[me.role] || ROLE_NAV[me.role].includes(name);
const canSee = (name) => (ROLE_NAV[me.role] || []).includes(name) || !ROLE_NAV[me.role];

async function loadMe() {
  try {
    const r = await (await fetch('/api/auth/me')).json();
    if (!r.staff) { location.assign('/staff/login'); return false; }
    if (r.staff.mustChangePassword) { location.assign('/staff/login?change=1'); return false; }
    me = { role: r.staff.role, name: r.staff.name };
  } catch { /* keep the default; the server still enforces everything */ }
  document.querySelectorAll('[data-nav]').forEach((a) => { if (a.dataset.nav === 'dashboard' ? me.role !== 'ADMIN' : !canSee(a.dataset.nav)) a.classList.add('hidden'); });
  // a heading with nothing visible under it (a role that sees none of those screens) is hidden too
  document.querySelectorAll('.adm-nav .adm-label, #side .adm-label').forEach((label) => {
    let el = label.nextElementSibling; let any = false;
    while (el && !el.classList.contains('adm-label')) { if (el.dataset && el.dataset.nav && !el.classList.contains('hidden')) any = true; el = el.nextElementSibling; }
    label.classList.toggle('hidden', !any);
  });
  const who = document.getElementById('staffName');
  if (who) who.textContent = me.role === 'ADMIN' ? 'Administrator' : me.name;
  const roleEl = document.getElementById('staffRole');
  if (roleEl) roleEl.textContent = ({ ADMIN: 'Administrator', SALES_MANAGER: 'Sales Manager', SALES_REP: 'Sales rep', WAREHOUSE: 'Warehouse' })[me.role] || 'Staff account';
  return true;
}

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
    if (!allowed('changes')) throw new Error('not for this role');
    const { counts } = await api.reviews();
    reviews = counts?.total || 0;
    setBadge('reviewBadge', reviews);
  } catch { /* ignore */ }
  // Companies waiting to be let in. Shown in the nav so a request for access is not missed.
  try {
    if (!allowed('access')) throw new Error('not for this role');
    const { total } = await api.accessRequests('PENDING');
    access = total || 0;
    setBadge('accessBadge', access);
  } catch { /* ignore */ }
  let returnsLate = 0;
  try {
    if (!allowed('returns')) throw new Error('not for this role');
    returnsLate = (await api.returnsAlert()).overdue || 0;
    setBadge('returnsBadge', returnsLate);
  } catch { /* ignore */ }
  setBadge('bellCount', reviews + access + returnsLate);
  refreshConnection();
}

/** The sidebar footer: whether the stock data is current. Odoo itself is not connected until Phase 1. */
async function refreshConnection() {
  const box = document.getElementById('connStatus');
  if (!box) return;
  try {
    const stock = await api.requestStockStatus();
    const ok = stock.hasData && stock.fresh;
    const at = stock.asOf ? new Date(stock.asOf).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    box.innerHTML = `<span class="conn-dot ${ok ? 'ok' : 'warn'}" aria-hidden="true"></span>
      <span><b>${ok ? 'Stock data current' : stock.hasData ? 'Stock data out of date' : 'No stock data yet'}</b>
      <small>${at ? `Last import: ${at}` : 'Run a product import'}</small></span>`;
  } catch { /* leave the last state */ }
}

// ---- the user menu in the top bar: catalogue link, theme, sign out ----
const userBtn = document.getElementById('userBtn');
const userMenu = document.getElementById('userMenu');
const themeToggle = document.getElementById('themeToggle');
function openUserMenu(open) {
  userMenu.hidden = !open;
  userBtn.setAttribute('aria-expanded', String(open));
  if (open && themeToggle) themeToggle.textContent = window.bflTheme?.isDark() ? 'Light mode' : 'Dark mode';
}
userBtn?.addEventListener('click', () => openUserMenu(userMenu.hidden));
themeToggle?.addEventListener('click', () => { window.bflTheme?.toggle(); openUserMenu(false); });
document.addEventListener('pointerdown', (e) => {
  if (userMenu && !userMenu.hidden && !e.target.closest('.adm-user')) openUserMenu(false);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && userMenu && !userMenu.hidden) { openUserMenu(false); userBtn.focus(); } });

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
  const [routeHash] = hash.split('?');
  const [, path, arg] = routeHash.split('/'); // "#", "products", "123"
  // a role is sent to its own start page when it asks for something it cannot use
  const page = path || 'dashboard';
  if (page === 'dashboard' ? me.role !== 'ADMIN' : !allowed(page)) { location.hash = ROLE_START[me.role] || '#/dashboard'; return; }
  openSide(false);
  view.innerHTML = LOADING;
  try {
    if (path === 'dashboard' || !path) { setActiveNav('dashboard'); await renderDashboard(view); }
    else if (path === 'warehouse') { setActiveNav('warehouse'); await renderWarehouseHome(view); }
    else if (path === 'products' && arg) { setActiveNav('products'); await renderProductDetail(view, arg); }
    else if (path === 'products') { setActiveNav('products'); await renderProducts(view); }
    else if (path === 'imports' && arg) { setActiveNav('imports'); await renderImportDetail(view, arg); }
    else if (path === 'imports') { setActiveNav('imports'); await renderImports(view); }
    else if (path === 'changes') { setActiveNav('changes'); await renderChanges(view); }
    else if (path === 'requests' && arg) { setActiveNav('requests'); await renderRequestDetail(view, arg); }
    else if (path === 'requests') { setActiveNav('requests'); await renderRequests(view); }
    else if (path === 'approvals') { setActiveNav('approvals'); await renderApprovals(view); }
    else if (path === 'expiry') { setActiveNav('expiry'); await renderExpiry(view); }
    else if (path === 'sample-odoo') { setActiveNav('sample-odoo'); await renderSampleOdoo(view); }
    else if (path === 'rep-customers') { setActiveNav('rep-customers'); await renderRepCustomers(view); }
    else if (path === 'health') { setActiveNav('health'); await renderHealth(view); }
    else if (path === 'returns') { setActiveNav('returns'); await renderReturns(view); }
    else if (path === 'visits') { setActiveNav('visits'); await renderVisits(view); }
    else if (path === 'reports') { setActiveNav('reports'); await renderReports(view); }
    else if (path === 'visibility') { setActiveNav('visibility'); await renderVisibility(view); }
    else if (path === 'payments') { setActiveNav('payments'); await renderPayments(view); }
    else if (path === 'team') { setActiveNav('team'); await renderTeam(view); }
    else if (path === 'codes') { setActiveNav('codes'); await renderAccessCodes(view); }
    else if (path === 'access') { setActiveNav('access'); await renderAccessRequests(view); }
    else if (path === 'categories') { setActiveNav('categories'); await renderCategories(view); }
    else if (path === 'workspace' && arg) { setActiveNav(`workspace-${arg}`); await renderWorkspacePage(view, arg); }
    else { location.hash = '#/dashboard'; return; }
  } catch (e) {
    view.innerHTML = `<div class="card errbox">Error: ${e.message}</div>`;
  }
  refreshBadge();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('staffLogout')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    location.assign('/');
  });
  if (!(await loadMe())) return;
  route();
  window.setInterval(refreshBadge, 15000);
});
export { refreshBadge };
