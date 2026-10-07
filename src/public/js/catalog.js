// Customer-facing catalog UI. Talks ONLY to /api/catalog, which returns
// customer-safe payloads — this file never receives price, stock quantities or
// internal ids, so there is nothing here to hide.
//
// Routing: /catalog (list) and /catalog/product/:id (detail). Both URLs are
// served the same shell by the server; this module reads location.pathname.

import { setQuantity, quantityOf } from './cart.js';
import { mountRequestUI, renderCartBar, setCartMutationHandler } from './request-ui.js';

const view = document.getElementById('view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// shared bits
// ---------------------------------------------------------------------------

/** The three customer availability states. Never a quantity. */
function pill(availability) {
  if (!availability) return '';
  return `<span class="c-pill ${esc(availability.tone)}">${esc(availability.label)}</span>`;
}

const NO_IMAGE_TEXT = 'No product image available';

/** Thumbnail or the explicit placeholder. The filename is never rendered. */
function thumb(product, { eager = false } = {}) {
  // Almost nothing in this catalogue has a photo — 8,932 of 8,933 at the time of
  // writing. A 1:1 placeholder for each one filled most of every card with empty
  // grey and pushed the product name, the only real information, into a strip at
  // the bottom. A card with no photo now carries a slim accent bar instead and
  // gives its space to the name. The square is kept for products that do have an
  // image, so those still look right.
  if (!product.image) return '<div class="c-thumb-bare" aria-hidden="true"></div>';
  return `<div class="c-thumb">
    <img src="${esc(product.image.url)}" alt="${esc(product.name)}"
         loading="${eager ? 'eager' : 'lazy'}" decoding="async"
         onerror="this.parentNode.innerHTML='&lt;div class=&quot;c-noimg&quot;&gt;${NO_IMAGE_TEXT}&lt;/div&gt;'" />
  </div>`;
}

// ---------------------------------------------------------------------------
// list view
// ---------------------------------------------------------------------------

const PAGE_SIZE = 24;
// view: 'available' = active products with stock on hand (the default, because a
// customer browsing to order cares about what they can actually have);
// 'full' = every active product, including out-of-stock.
const state = { view: 'available', search: '', availability: 'all', withImage: false, topLevel: '', categoryPath: '', sort: 'name_asc', offset: 0 };

const FILTERS = [
  { key: 'all', label: 'All', facet: 'all' },
  { key: 'in_stock', label: 'In Stock', facet: 'in_stock' },
  { key: 'limited', label: 'Limited Stock', facet: 'limited' },
  { key: 'out_of_stock', label: 'Out of Stock', facet: 'out_of_stock' },
];

/**
 * The add-to-request control. A product holding less than one whole carton is not
 * requestable even while it still reads Limited Stock, so it gets a plain note
 * instead of a stepper — better than offering a control whose every use would fail.
 */
function requestControl(product) {
  if (!product.requestable) {
    return `<div class="c-noreq">Not available to request right now</div>`;
  }
  const qty = quantityOf(product.id);
  const unit = product.pack ? ` · ${esc(product.pack)}` : '';
  if (qty < 1) {
    return `<button class="c-add" type="button" data-add="${esc(product.id)}">Add to request${unit}</button>`;
  }
  return `<div class="c-stepper" data-stepper="${esc(product.id)}">
      <button type="button" class="c-step" data-dec="${esc(product.id)}" aria-label="Fewer cartons">−</button>
      <span class="c-qty"><b>${qty}</b> CTN</span>
      <button type="button" class="c-step" data-inc="${esc(product.id)}" aria-label="More cartons">+</button>
    </div>`;
}

function card(product) {
  return `<div class="c-card">
    <a class="c-card-link" href="/catalog/product/${encodeURIComponent(product.id)}">
      ${thumb(product)}
      <div class="c-card-body">
        <div class="c-name">${esc(product.name)}</div>
        ${product.pack ? `<div class="c-pack">${esc(product.pack)}</div>` : ''}
        ${product.category ? `<div class="c-cat">${esc(product.category.name)}</div>` : ''}
        ${pill(product.availability)}
      </div>
    </a>
    <div class="c-card-actions" data-product='${esc(JSON.stringify({ id: product.id, name: product.name, pack: product.pack }))}'>
      ${requestControl(product)}
    </div>
  </div>`;
}

function listShell(facets, categories) {
  // Odoo top-level categories, shown exactly as Odoo defines them — FOOD,
  // NON-FOOD, DRINKS & BEVERAGES and PETS are NOT merged.
  const cats = categories || [];
  const topChips = [`<button class="c-chip" type="button" data-top="" aria-pressed="${state.topLevel === ''}">All Categories</button>`]
    .concat(cats.filter((c) => c.level === 1).map((c) => `<button class="c-chip" type="button" data-top="${esc(c.path)}" aria-pressed="${state.topLevel === c.path}">${esc(c.name)}<span class="n">${c.count}</span></button>`))
    .join('');

  // second level of whichever top-level is selected
  const subs = state.topLevel
    ? cats.filter((c) => c.level === 2 && c.path.startsWith(`${state.topLevel} / `))
    : [];
  const subChips = subs.length
    ? [`<button class="c-chip" type="button" data-sub="" aria-pressed="${state.categoryPath === ''}">All</button>`]
      .concat(subs.map((c) => `<button class="c-chip" type="button" data-sub="${esc(c.path)}" aria-pressed="${state.categoryPath === c.path}">${esc(c.name)}<span class="n">${c.count}</span></button>`))
      .join('')
    : '';

  const chips = FILTERS.map((f) => {
    const n = facets ? facets[f.facet] : null;
    return `<button class="c-chip" type="button" data-filter="${f.key}"
      aria-pressed="${state.availability === f.key}">${esc(f.label)}${
  n === null || n === undefined ? '' : `<span class="n">${n}</span>`}</button>`;
  }).join('');

  const imageChip = facets && facets.with_image > 0
    ? `<button class="c-chip" type="button" data-withimage="1" aria-pressed="${state.withImage}">With Image<span class="n">${facets.with_image}</span></button>`
    : '';

  return `
    <div class="c-views" role="tablist">
      <button type="button" class="c-view" role="tab" data-view="available"
        aria-selected="${state.view === 'available'}">Available Now</button>
      <button type="button" class="c-view" role="tab" data-view="full"
        aria-selected="${state.view === 'full'}">Full Catalogue</button>
    </div>
    <div class="c-search">
      <input id="q" type="search" inputmode="search" autocomplete="off"
             placeholder="Search products..." aria-label="Search products"
             value="${esc(state.search)}" />
      <button class="c-search-clear ${state.search ? '' : 'hidden'}" id="clearQ" type="button" aria-label="Clear search">×</button>
    </div>
    <div class="c-controls">
      <div class="c-chips" id="topChips">${topChips}</div>
      ${subChips ? `<div class="c-chips" id="subChips">${subChips}</div>` : ''}
      <div class="c-chips">${chips}${imageChip}</div>
      <div class="c-sortrow">
        <span class="c-count" id="count"></span>
        <select class="c-sort" id="sort" aria-label="Sort products">
          <option value="name_asc"${state.sort === 'name_asc' ? ' selected' : ''}>Name A → Z</option>
          <option value="name_desc"${state.sort === 'name_desc' ? ' selected' : ''}>Name Z → A</option>
        </select>
      </div>
    </div>
    <div id="results"></div>`;
}

function listQuery() {
  const p = new URLSearchParams();
  if (state.search.trim()) p.set('search', state.search.trim());
  if (state.availability !== 'all') p.set('availability', state.availability);
  if (state.withImage) p.set('with_image', 'true');
  p.set('view', state.view);
  if (state.topLevel) p.set('top_level', state.topLevel);
  if (state.categoryPath) p.set('category_path', state.categoryPath);
  p.set('sort', state.sort);
  p.set('limit', String(PAGE_SIZE));
  p.set('offset', String(state.offset));
  return p.toString();
}

async function loadResults() {
  const results = document.getElementById('results');
  const count = document.getElementById('count');
  results.innerHTML = `<div class="c-grid">${'<div class="c-skeleton"></div>'.repeat(6)}</div>`;

  let data;
  try {
    data = await getJSON(`/api/catalog/products?${listQuery()}`);
  } catch (e) {
    results.innerHTML = `<div class="c-error">Could not load products: ${esc(e.message)}</div>`;
    return;
  }

  if (!data.items.length) {
    count.textContent = '';
    results.innerHTML = `<div class="c-empty">
      <h2>No products found</h2>
      <p>${state.search ? `Nothing matches “${esc(state.search)}”. Try a different name or barcode.` : 'No products match these filters.'}</p>
    </div>`;
    return;
  }

  const from = data.offset + 1;
  const to = Math.min(data.offset + data.items.length, data.total);
  count.textContent = `${from}–${to} of ${data.total} products`;

  const pages = Math.ceil(data.total / data.limit);
  const page = Math.floor(data.offset / data.limit) + 1;

  results.innerHTML = `<div class="c-grid">${data.items.map(card).join('')}</div>
    ${pages > 1 ? `<div class="c-pager">
      <button class="c-btn" id="prev" type="button"${page <= 1 ? ' disabled' : ''}>← Prev</button>
      <span class="c-page-of">Page ${page} of ${pages}</span>
      <button class="c-btn primary" id="next" type="button"${page >= pages ? ' disabled' : ''}>Next →</button>
    </div>` : ''}`;

  const go = (delta) => {
    state.offset = Math.max(0, state.offset + delta * PAGE_SIZE);
    loadResults();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  document.getElementById('prev')?.addEventListener('click', () => go(-1));
  document.getElementById('next')?.addEventListener('click', () => go(1));
}

async function renderList() {
  let facets = null;
  let categories = [];
  try { facets = await getJSON('/api/catalog/facets'); } catch { /* chips degrade to no counts */ }
  // the view travels with the request so the chip counts match the list below them
  try {
    categories = (await getJSON(`/api/catalog/categories?view=${encodeURIComponent(state.view)}`)).items;
  } catch { /* category chips omitted */ }

  view.innerHTML = listShell(facets, categories);

  const input = document.getElementById('q');
  const clear = document.getElementById('clearQ');

  let debounce;
  input.addEventListener('input', () => {
    state.search = input.value;
    clear.classList.toggle('hidden', !state.search);
    clearTimeout(debounce);
    debounce = setTimeout(() => { state.offset = 0; loadResults(); }, 220);
  });
  clear.addEventListener('click', () => {
    input.value = ''; state.search = ''; state.offset = 0;
    clear.classList.add('hidden');
    loadResults(); input.focus();
  });

  view.querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    state.availability = b.dataset.filter;
    state.offset = 0;
    view.querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadResults();
  }));
  view.querySelector('[data-withimage]')?.addEventListener('click', (e) => {
    state.withImage = !state.withImage;
    state.offset = 0;
    e.currentTarget.setAttribute('aria-pressed', String(state.withImage));
    loadResults();
  });
  view.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    if (state.view === b.dataset.view) return;
    state.view = b.dataset.view;
    state.offset = 0;
    renderList();   // re-render so the tab state and the counts both follow
  }));

  view.querySelectorAll('[data-top]').forEach((b) => b.addEventListener('click', () => {
    state.topLevel = b.dataset.top;
    state.categoryPath = '';  // a new top level clears any sub-category
    state.offset = 0;
    renderList();             // re-render so the sub-chips follow the selection
  }));
  view.querySelectorAll('[data-sub]').forEach((b) => b.addEventListener('click', () => {
    state.categoryPath = b.dataset.sub;
    state.offset = 0;
    view.querySelectorAll('[data-sub]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadResults();
  }));
  document.getElementById('sort').addEventListener('change', (e) => {
    state.sort = e.target.value; state.offset = 0; loadResults();
  });

  loadResults();
}

// ---------------------------------------------------------------------------
// detail view
// ---------------------------------------------------------------------------

async function renderDetail(id) {
  view.innerHTML = '<div class="c-skeleton" style="height:320px"></div>';

  let p;
  try {
    p = await getJSON(`/api/catalog/products/${encodeURIComponent(id)}`);
  } catch (e) {
    view.innerHTML = `<a class="c-back" href="/catalog">← Back to Catalog</a>
      <div class="c-error" style="margin-top:12px">${
  e.status === 404 ? 'This product is not available in the catalog.' : `Could not load this product: ${esc(e.message)}`}</div>`;
    return;
  }

  document.title = `${p.name} — Box for Less`;
  view.innerHTML = `
    <a class="c-back" href="/catalog">← Back to Catalog</a>
    <div class="c-detail">
      <div class="c-detail-grid${p.image ? '' : ' c-detail-grid-noimg'}">
        ${/* No image: the picture column is left out entirely rather than shown as
              a large empty box beside the facts. Almost nothing has a photo, and
              half a blank screen reads as a broken page. */''}
        ${p.image
    ? `<div class="c-hero"><img src="${esc(p.image.url)}" alt="${esc(p.name)}" decoding="async"
            onerror="this.parentNode.innerHTML='&lt;div class=&quot;c-noimg&quot;&gt;${NO_IMAGE_TEXT}&lt;/div&gt;'" /></div>`
    : ''}
        <div>
          <h1>${esc(p.name)}</h1>
          <div class="c-facts">
            <div><div class="c-fact-k">Barcode</div><div class="c-fact-v">${esc(p.barcode)}</div></div>
            ${p.pack ? `<div><div class="c-fact-k">Pack / UoM</div><div class="c-fact-v">${esc(p.pack)}</div></div>` : ''}
            ${p.category ? `<div>
              <div class="c-fact-k">Category</div>
              <div class="c-fact-v">${esc(p.category.name)}</div>
              <div class="c-pack" style="margin-top:2px">${esc(p.category.path)}</div>
            </div>` : ''}
            <div><div class="c-fact-k">Availability</div><div>${pill(p.availability)}</div></div>
          </div>
          <div class="c-detail-actions" data-product='${esc(JSON.stringify({ id: p.id, name: p.name, pack: p.pack }))}'>
            ${requestControl(p)}
          </div>
          <a class="c-btn" href="/catalog" style="display:inline-block;text-decoration:none;margin-top:14px">Back to Catalog</a>
        </div>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

function route() {
  const m = location.pathname.match(/^\/catalog\/product\/(.+)$/);
  if (m) return renderDetail(decodeURIComponent(m[1]));
  document.title = 'Box for Less — Digital Product Catalog';
  return renderList();
}

// Add / increment / decrement, delegated so it survives every re-render.
// Only the control itself re-renders — the grid is left alone so the page does not
// jump under the customer's thumb mid-scroll.
document.addEventListener('click', (e) => {
  const host = e.target.closest('.c-card-actions, .c-detail-actions');
  const btn = e.target.closest('[data-add], [data-inc], [data-dec]');
  if (!host || !btn) return;
  e.preventDefault();
  e.stopPropagation();

  let product;
  try { product = JSON.parse(host.dataset.product); } catch { return; }
  const current = quantityOf(product.id);
  const next = btn.hasAttribute('data-add') ? current + 1
    : btn.hasAttribute('data-inc') ? current + 1
      : current - 1;

  setQuantity({ barcode: product.id, name: product.name, pack: product.pack }, next);
  host.innerHTML = requestControl({ ...product, requestable: true });
  renderCartBar();
});

// Intercept in-app links so navigation stays a single page load on mobile.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/catalog"]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
  e.preventDefault();
  history.pushState({}, '', a.getAttribute('href'));
  window.scrollTo(0, 0);
  route();
});
window.addEventListener('popstate', route);

// The cart bar persists across views; re-render controls after a submission so
// steppers reset to "Add to request".
setCartMutationHandler(() => route());
mountRequestUI();

route();
