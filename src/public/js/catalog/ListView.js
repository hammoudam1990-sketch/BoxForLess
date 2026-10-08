// The catalogue list: Available Now / Full Catalogue, search, category and
// availability chips, sort, and paging.
//
// The filter state is owned by the App, not by this component, so opening a product
// and coming back finds the list exactly as it was left.
import { html, useRef } from '../lib/react.js';
import { useAsync, useDebounced, useCountUp } from '../lib/hooks.js';
import { getJSON } from './http.js';
import { ProductCard } from './parts.js';
import { Doodle, doodleForTop } from './doodles.js';

const PAGE_SIZE = 24;
// how many colours the category tiles cycle through (see .c-tile-N in catalog.css)
const TILE_COLOURS = 4;

/**
 * view: 'available' = active products with stock on hand (the default, because a
 * customer browsing to order cares about what they can actually have);
 * 'full' = every active product, including out-of-stock.
 */
export const INITIAL_LIST = {
  view: 'available', search: '', availability: 'all', withImage: false,
  topLevel: '', categoryPath: '', sort: 'name_asc', offset: 0,
};

const FILTERS = [
  { key: 'all', label: 'All', facet: 'all' },
  { key: 'in_stock', label: 'In Stock', facet: 'in_stock' },
  { key: 'limited', label: 'Limited Stock', facet: 'limited' },
  { key: 'out_of_stock', label: 'Out of Stock', facet: 'out_of_stock' },
];

function Chip({ pressed, count, onClick, children }) {
  return html`
    <button class="c-chip" type="button" aria-pressed=${pressed} onClick=${onClick}>
      ${children}${count === null || count === undefined ? null : html`<span class="n">${count}</span>`}
    </button>`;
}

function listQuery(s, search) {
  const p = new URLSearchParams();
  if (search.trim()) p.set('search', search.trim());
  if (s.availability !== 'all') p.set('availability', s.availability);
  if (s.withImage) p.set('with_image', 'true');
  p.set('view', s.view);
  if (s.topLevel) p.set('top_level', s.topLevel);
  if (s.categoryPath) p.set('category_path', s.categoryPath);
  p.set('sort', s.sort);
  p.set('limit', String(PAGE_SIZE));
  p.set('offset', String(s.offset));
  return p.toString();
}

export function ListView({ state, update }) {
  const searchRef = useRef(null);

  // chip counts degrade to "no counts" if these fail; the list still works
  const facets = useAsync(() => getJSON('/api/catalog/facets').catch(() => null), []);
  // the view travels with the request so the chip counts match the list below them
  const categories = useAsync(
    () => getJSON(`/api/catalog/categories?view=${encodeURIComponent(state.view)}`).then((r) => r.items).catch(() => []),
    [state.view],
  );

  // Only the settled search term reaches the server; the field itself is bound to
  // `state.search` and is never re-created while someone types in it.
  const search = useDebounced(state.search, 220);
  const results = useAsync(
    () => getJSON(`/api/catalog/products?${listQuery(state, search)}`),
    [state.view, search, state.availability, state.withImage, state.topLevel, state.categoryPath, state.sort, state.offset],
  );

  const f = facets.data;
  const cats = categories.data || [];
  // Odoo top-level categories, shown exactly as Odoo defines them — FOOD, NON-FOOD,
  // DRINKS & BEVERAGES and PETS are NOT merged.
  const tops = cats.filter((c) => c.level === 1);
  // second level of whichever top-level is selected
  // Before a category is chosen — and while not searching — the top-level categories
  // are big coloured tiles, as in the Box for Less app, instead of a row of chips.
  const showTiles = state.topLevel === '' && !state.search.trim() && tops.length > 0;
  // The banner only introduces the whole range, so it goes as soon as anything narrows it.
  const showBanner = showTiles && state.availability === 'all' && !state.withImage;
  const subs = state.topLevel ? cats.filter((c) => c.level === 2 && c.path.startsWith(`${state.topLevel} / `)) : [];

  const go = (delta) => {
    update({ offset: Math.max(0, state.offset + delta * PAGE_SIZE) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // The big number: what can be requested now (in stock + limited), or the whole range.
  const total = f ? (state.view === 'available' ? (f.in_stock || 0) + (f.limited || 0) : f.all) : null;

  const shownTotal = useCountUp(total);
  const filtersActive = Boolean(state.search.trim() || state.topLevel || state.categoryPath
    || state.availability !== 'all' || state.withImage);
  const clearFilters = () => update({ search: '', topLevel: '', categoryPath: '', availability: 'all', withImage: false, offset: 0 });

  const data = results.data;
  const count = data && data.items.length
    ? `${data.offset + 1}–${Math.min(data.offset + data.items.length, data.total)} of ${data.total} products`
    : '';

  return html`
    ${total != null ? html`
      <div class="c-stat">
        <span class="c-stat-n">${(shownTotal ?? total).toLocaleString()}</span>
        <span class="c-stat-l">products<br />${state.view === 'available' ? 'available now' : 'in the catalogue'}</span>
      </div>` : null}
    ${showBanner ? html`
      <section class="c-banner" aria-label="How requests work">
        <h2>Request cartons in three steps</h2>
        <ol class="c-steps"><li>Add cartons</li><li>Enter your code</li><li>Send</li></ol>
      </section>` : null}
    <div class="c-views" role="tablist">
      <button type="button" class="c-view" role="tab" aria-selected=${state.view === 'available'}
        onClick=${() => state.view !== 'available' && update({ view: 'available', offset: 0 })}>Available Now</button>
      <button type="button" class="c-view" role="tab" aria-selected=${state.view === 'full'}
        onClick=${() => state.view !== 'full' && update({ view: 'full', offset: 0 })}>Full Catalogue</button>
    </div>
    <div class="c-search">
      <svg class="c-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
      </svg>
      <input ref=${searchRef} type="search" inputMode="search" autoComplete="off"
        placeholder="Find a product" aria-label="Search products"
        value=${state.search} onChange=${(e) => update({ search: e.target.value, offset: 0 })} />
      <button class=${`c-search-clear${state.search ? '' : ' hidden'}`} type="button" aria-label="Clear search"
        onClick=${() => { update({ search: '', offset: 0 }); searchRef.current?.focus(); }}>×</button>
    </div>
    <div class="c-controls">
      ${showTiles ? html`
        <section>
          <h2 class="c-section" id="shop-by-category">Shop by Category</h2>
          <div class="c-tiles">
            ${tops.map((c, i) => html`
              <button key=${c.path} type="button" class=${`c-tile c-tile-${i % TILE_COLOURS}`}
                onClick=${() => update({ topLevel: c.path, categoryPath: '', offset: 0 })}>
                <${Doodle} name=${doodleForTop(c.name)} size="md" class="c-tile-doodle" />
                <span class="c-tile-name">${c.name}</span>
                <span class="c-tile-count">${c.count} products</span>
              </button>`)}
          </div>
        </section>` : html`
        <div class="c-chips">
          <${Chip} pressed=${state.topLevel === ''} onClick=${() => update({ topLevel: '', categoryPath: '', offset: 0 })}>All Categories<//>
          ${tops.map((c) => html`
            <${Chip} key=${c.path} pressed=${state.topLevel === c.path} count=${c.count}
              onClick=${() => update({ topLevel: c.path, categoryPath: '', offset: 0 })}>${c.name}<//>`)}
        </div>`}
      ${subs.length ? html`
        <div class="c-chips">
          <${Chip} pressed=${state.categoryPath === ''} onClick=${() => update({ categoryPath: '', offset: 0 })}>All<//>
          ${subs.map((c) => html`
            <${Chip} key=${c.path} pressed=${state.categoryPath === c.path} count=${c.count}
              onClick=${() => update({ categoryPath: c.path, offset: 0 })}>${c.name}<//>`)}
        </div>` : null}
      <div class="c-chips">
        ${FILTERS.map((x) => html`
          <${Chip} key=${x.key} pressed=${state.availability === x.key} count=${f ? f[x.facet] : null}
            onClick=${() => update({ availability: x.key, offset: 0 })}>${x.label}<//>`)}
        ${f && f.with_image > 0 ? html`
          <${Chip} pressed=${state.withImage} count=${f.with_image}
            onClick=${() => update({ withImage: !state.withImage, offset: 0 })}>With Image<//>` : null}
      </div>
      <div class="c-sortrow">
        <span class="c-sort-left">
          <span class="c-count" role="status">${count}</span>
          ${filtersActive ? html`<button type="button" class="c-clear" onClick=${clearFilters}>Clear filters</button>` : null}
        </span>
        <select class="c-sort" aria-label="Sort products" value=${state.sort}
          onChange=${(e) => update({ sort: e.target.value, offset: 0 })}>
          <option value="name_asc">Name A → Z</option>
          <option value="name_desc">Name Z → A</option>
        </select>
      </div>
    </div>
    <div><${Results} results=${results} search=${state.search} go=${go} onClear=${filtersActive ? clearFilters : null} /></div>`;
}

function Results({ results, search, go, onClear }) {
  if (results.loading) {
    return html`<div class="c-grid">${[0, 1, 2, 3, 4, 5].map((i) => html`<div key=${i} class="c-skeleton" aria-hidden="true"><i></i><i></i><i></i><i></i></div>`)}</div>`;
  }
  if (results.error) return html`<div class="c-error">Could not load products: ${results.error.message}</div>`;

  const data = results.data;
  if (!data.items.length) {
    return html`
      <div class="c-empty">
        <h2>No products found</h2>
        <p>${search ? `Nothing matches “${search}”. Try a different name or barcode.` : 'No products match these filters.'}</p>
        ${onClear ? html`<button type="button" class="c-btn primary c-empty-action" onClick=${onClear}>Clear filters</button>` : null}
      </div>`;
  }

  const pages = Math.ceil(data.total / data.limit);
  const page = Math.floor(data.offset / data.limit) + 1;
  return html`
    <div class="c-grid">${data.items.map((p) => html`<${ProductCard} key=${p.id} product=${p} />`)}</div>
    ${pages > 1 ? html`
      <div class="c-pager">
        <button class="c-btn" type="button" disabled=${page <= 1} onClick=${() => go(-1)}>← Prev</button>
        <span class="c-page-of">Page ${page} of ${pages}</span>
        <button class="c-btn primary" type="button" disabled=${page >= pages} onClick=${() => go(1)}>Next →</button>
      </div>` : null}`;
}
