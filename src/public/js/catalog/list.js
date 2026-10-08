// The catalogue list: Available Now / Full Catalogue, search, category tiles and chips,
// availability chips, sort, and paging.
//
// The filter state lives in this MODULE, not in the view, so opening a product and coming
// back finds the list exactly as it was left.
//
// How it stays typeable: the search field is built once and never rebuilt. Every other part
// of the screen is a small region that is rewritten when the state changes, and only the
// settled search term reaches the server. (An earlier screen rebuilt the container the
// search box lived in and dropped the keyboard mid-typing.)
import { h, setChildren, svg, toggleHidden } from '../lib/dom.js';
import { createScope, createLatest, debounce, tween } from '../lib/util.js';
import { getJSON } from './http.js';
import { createProductCard } from './cards.js';
import { doodle, doodleForTop } from './doodles.js';

const PAGE_SIZE = 24;
const TILE_COLOURS = 4;   // see .c-tile-N in catalog.css
const SEARCH_DELAY = 220;

/**
 * view: 'available' = active products with stock on hand (the default, because a customer
 * browsing to order cares about what they can actually have); 'full' = every active product,
 * including out-of-stock.
 */
const INITIAL = {
  view: 'available', search: '', availability: 'all', withImage: false,
  topLevel: '', categoryPath: '', sort: 'name_asc', offset: 0,
};
export const state = { ...INITIAL };

const FILTERS = [
  { key: 'all', label: 'All', facet: 'all' },
  { key: 'in_stock', label: 'In Stock', facet: 'in_stock' },
  { key: 'limited', label: 'Limited Stock', facet: 'limited' },
  { key: 'out_of_stock', label: 'Out of Stock', facet: 'out_of_stock' },
];

const SEARCH_ICON = '<svg class="c-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

let mounted = null;   // the on-screen list, if any: (patch) => void

/** Change the filters from outside the list (the tab bar). Takes effect when it is shown. */
export function patchList(patch) {
  Object.assign(state, patch);
  if (mounted) mounted(patch);
}

/** Back to "everything": no search, no category. */
export const showEverything = () => patchList({ search: '', topLevel: '', categoryPath: '', offset: 0 });

/** Which of the tab bar's Home / Categories the list is currently showing. */
export const listTab = () => (state.topLevel ? 'categories' : 'home');

const filtersActive = () => Boolean(state.search.trim() || state.topLevel || state.categoryPath
  || state.availability !== 'all' || state.withImage);

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

function chip(label, pressed, count, onClick) {
  return h('button', { class: 'c-chip', type: 'button', 'aria-pressed': String(pressed), onClick },
    label, count === null || count === undefined ? null : h('span', { class: 'n' }, count));
}

/** Build the list into `container`. Returns { destroy }. */
export function mountList(container) {
  const scope = createScope();         // listeners that live as long as the list
  let cardsScope = createScope();      // the product tiles' cart subscriptions
  const latestProducts = createLatest();
  const latestCategories = createLatest();

  let facets = null;
  let cats = [];
  let categoryVersion = 0;             // bumped whenever the categories change
  const categoryCache = new Map();     // view -> categories, so switching tabs back is instant
  let data = null;                     // the last page of products shown
  let shown = null;                    // the number currently displayed in the big stat
  let stopTween = () => {};

  // ---- the parts that are built once ----
  const numberEl = h('span', { class: 'c-stat-n' });
  const labelEl = h('span', { class: 'c-stat-l' });
  const statEl = h('div', { class: 'c-stat hidden' }, numberEl, labelEl);

  const bannerEl = h('section', { class: 'c-banner hidden', 'aria-label': 'How requests work' },
    h('h2', {}, 'Request cartons in three steps'),
    h('ol', { class: 'c-steps' }, h('li', {}, 'Add cartons'), h('li', {}, 'Enter your code'), h('li', {}, 'Send')));

  const viewButton = (key, label) => h('button', {
    type: 'button', class: 'c-view', role: 'tab', onClick: () => { if (state.view !== key) change({ view: key, offset: 0 }); },
  }, label);
  const availableTab = viewButton('available', 'Available Now');
  const fullTab = viewButton('full', 'Full Catalogue');
  const viewsEl = h('div', { class: 'c-views', role: 'tablist' }, availableTab, fullTab);

  const searchInput = h('input', {
    type: 'search', inputmode: 'search', autocomplete: 'off', placeholder: 'Find a product', 'aria-label': 'Search products',
    onInput: (e) => change({ search: e.target.value, offset: 0 }),
  });
  const clearSearch = h('button', {
    class: 'c-search-clear hidden', type: 'button', 'aria-label': 'Clear search',
    onClick: () => { change({ search: '', offset: 0 }); searchInput.focus(); },
  }, '×');
  const searchEl = h('div', { class: 'c-search' }, svg(SEARCH_ICON), searchInput, clearSearch);

  // regions that are rewritten (display: contents keeps them out of the flex gap)
  const region = () => h('div', { style: { display: 'contents' } });
  const topRegion = region();
  const subRegion = region();
  const filterRegion = h('div', { class: 'c-chips' });
  const countEl = h('span', { class: 'c-count', role: 'status' });
  const clearEl = h('button', { type: 'button', class: 'c-clear hidden', onClick: () => clearFilters() }, 'Clear filters');
  const sortEl = h('select', {
    class: 'c-sort', 'aria-label': 'Sort products', onChange: (e) => change({ sort: e.target.value, offset: 0 }),
  }, h('option', { value: 'name_asc' }, 'Name A → Z'), h('option', { value: 'name_desc' }, 'Name Z → A'));
  const sortRow = h('div', { class: 'c-sortrow' }, h('span', { class: 'c-sort-left' }, countEl, clearEl), sortEl);
  const controlsEl = h('div', { class: 'c-controls' }, topRegion, subRegion, filterRegion, sortRow);
  const resultsEl = h('div');

  setChildren(container, statEl, bannerEl, viewsEl, searchEl, controlsEl, resultsEl);

  // ---- state changes ----
  const loadLater = debounce(() => loadProducts(), SEARCH_DELAY);

  function clearFilters() {
    change({ search: '', topLevel: '', categoryPath: '', availability: 'all', withImage: false, offset: 0 });
  }

  /** Apply a change: update the screen now, and fetch products (after a pause if it was typing). */
  function change(patch) {
    Object.assign(state, patch);
    afterChange(patch);
  }

  function afterChange(patch) {
    renderAll();
    if ('view' in patch) loadCategories();
    const typingOnly = Object.keys(patch).every((k) => k === 'search' || k === 'offset');
    if ('search' in patch && typingOnly) loadLater();
    else { loadLater.cancel(); loadProducts(); }
  }
  mounted = afterChange;
  scope.add(() => { mounted = null; loadLater.cancel(); stopTween(); cardsScope.dispose(); });

  // ---- drawing ----
  const tops = () => cats.filter((c) => c.level === 1);
  // Before a category is chosen — and while not searching — the top-level categories are big
  // tiles instead of a row of chips.
  const showTiles = () => state.topLevel === '' && !state.search.trim() && tops().length > 0;

  function renderStat() {
    const f = facets;
    const total = f ? (state.view === 'available' ? (f.in_stock || 0) + (f.limited || 0) : f.all) : null;
    toggleHidden(statEl, total === null);
    if (total === null) return;
    setChildren(labelEl, 'products', h('br'), state.view === 'available' ? 'available now' : 'in the catalogue');
    stopTween();
    stopTween = tween(shown ?? 0, total, (v) => { shown = v; numberEl.textContent = v.toLocaleString(); });
  }

  // The tiles and chips are only rebuilt when something they show has changed, so the tiles'
  // rise-in animation does not replay every time an unrelated filter is touched.
  let topKey = '';
  function renderTop() {
    const key = [showTiles(), state.topLevel, state.categoryPath, categoryVersion].join('|');
    if (key === topKey) return;
    topKey = key;
    if (showTiles()) {
      setChildren(topRegion, h('section', {},
        h('h2', { class: 'c-section', id: 'shop-by-category' }, 'Shop by Category'),
        h('div', { class: 'c-tiles' }, tops().map((c, i) => h('button', {
          type: 'button', class: `c-tile c-tile-${i % TILE_COLOURS}`,
          onClick: () => change({ topLevel: c.path, categoryPath: '', offset: 0 }),
        },
        doodle(doodleForTop(c.name), { size: 'md', className: 'c-tile-doodle' }),
        h('span', { class: 'c-tile-name' }, c.name),
        h('span', { class: 'c-tile-count' }, `${c.count} products`))))));
    } else {
      setChildren(topRegion, h('div', { class: 'c-chips' },
        chip('All Categories', state.topLevel === '', null, () => change({ topLevel: '', categoryPath: '', offset: 0 })),
        tops().map((c) => chip(c.name, state.topLevel === c.path, c.count,
          () => change({ topLevel: c.path, categoryPath: '', offset: 0 })))));
    }
    const subs = state.topLevel
      ? cats.filter((c) => c.level === 2 && c.path.startsWith(`${state.topLevel} / `)) : [];
    setChildren(subRegion, subs.length ? h('div', { class: 'c-chips' },
      chip('All', state.categoryPath === '', null, () => change({ categoryPath: '', offset: 0 })),
      subs.map((c) => chip(c.name, state.categoryPath === c.path, c.count, () => change({ categoryPath: c.path, offset: 0 })))) : null);
  }

  function renderFilters() {
    const f = facets;
    setChildren(filterRegion,
      FILTERS.map((x) => chip(x.label, state.availability === x.key, f ? f[x.facet] : null,
        () => change({ availability: x.key, offset: 0 }))),
      f && f.with_image > 0 ? chip('With Image', state.withImage, f.with_image,
        () => change({ withImage: !state.withImage, offset: 0 })) : null);
  }

  function renderSortRow() {
    countEl.textContent = data && data.items.length
      ? `${data.offset + 1}–${Math.min(data.offset + data.items.length, data.total)} of ${data.total} products` : '';
    toggleHidden(clearEl, !filtersActive());
    sortEl.value = state.sort;
  }

  function renderAll() {
    availableTab.setAttribute('aria-selected', String(state.view === 'available'));
    fullTab.setAttribute('aria-selected', String(state.view === 'full'));
    if (searchInput.value !== state.search) searchInput.value = state.search;
    toggleHidden(clearSearch, !state.search);
    toggleHidden(bannerEl, !(showTiles() && state.availability === 'all' && !state.withImage));
    renderTop();
    renderFilters();
    renderSortRow();
    renderStat();
  }

  function skeletons() {
    const tile = () => h('div', { class: 'c-skeleton', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
    return h('div', { class: 'c-grid' }, [0, 1, 2, 3, 4, 5].map(tile));
  }

  function renderResults() {
    cardsScope.dispose();
    cardsScope = createScope();
    if (!data.items.length) {
      setChildren(resultsEl, h('div', { class: 'c-empty' },
        h('h2', {}, 'No products found'),
        h('p', {}, state.search ? `Nothing matches “${state.search}”. Try a different name or barcode.` : 'No products match these filters.'),
        filtersActive() ? h('button', { type: 'button', class: 'c-btn primary c-empty-action', onClick: clearFilters }, 'Clear filters') : null));
      return;
    }
    const pages = Math.ceil(data.total / data.limit);
    const page = Math.floor(data.offset / data.limit) + 1;
    const go = (delta) => {
      change({ offset: Math.max(0, state.offset + delta * PAGE_SIZE) });
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };
    setChildren(resultsEl,
      h('div', { class: 'c-grid' }, data.items.map((p) => createProductCard(p, cardsScope))),
      pages > 1 ? h('div', { class: 'c-pager' },
        h('button', { class: 'c-btn', type: 'button', disabled: page <= 1, onClick: () => go(-1) }, '← Prev'),
        h('span', { class: 'c-page-of' }, `Page ${page} of ${pages}`),
        h('button', { class: 'c-btn primary', type: 'button', disabled: page >= pages, onClick: () => go(1) }, 'Next →')) : null);
  }

  // ---- loading ----
  async function loadProducts() {
    const mine = latestProducts.next();
    cardsScope.dispose();
    setChildren(resultsEl, skeletons());
    try {
      const result = await getJSON(`/api/catalog/products?${listQuery()}`);
      if (!latestProducts.is(mine)) return;
      data = result;
      renderSortRow();
      renderResults();
    } catch (e) {
      if (!latestProducts.is(mine)) return;
      data = null;
      renderSortRow();
      setChildren(resultsEl, h('div', { class: 'c-error' }, `Could not load products: ${e.message}`));
    }
  }

  async function loadCategories() {
    const view = state.view;
    if (categoryCache.has(view)) { cats = categoryCache.get(view); categoryVersion += 1; renderAll(); return; }
    const mine = latestCategories.next();
    try {
      // the view travels with the request so the counts match the list below them
      const r = await getJSON(`/api/catalog/categories?view=${encodeURIComponent(view)}`);
      if (!latestCategories.is(mine)) return;
      cats = r.items; categoryCache.set(view, cats);
    } catch { if (!latestCategories.is(mine)) return; cats = []; }
    categoryVersion += 1;
    renderAll();
  }

  // ---- go ----
  renderAll();
  getJSON('/api/catalog/facets').then((f) => { facets = f; }, () => { facets = null; }).then(() => { renderAll(); });
  loadCategories();
  loadProducts();

  return { destroy: () => scope.dispose() };
}
