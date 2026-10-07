// The catalogue list: Available Now / Full Catalogue, search, category and
// availability chips, sort, and paging.
//
// The filter state is owned by the App, not by this component, so opening a product
// and coming back finds the list exactly as it was left.
import { html, useRef } from '../lib/react.js';
import { useAsync, useDebounced } from '../lib/hooks.js';
import { getJSON } from './http.js';
import { ProductCard } from './parts.js';

const PAGE_SIZE = 24;

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
  const subs = state.topLevel ? cats.filter((c) => c.level === 2 && c.path.startsWith(`${state.topLevel} / `)) : [];

  const go = (delta) => {
    update({ offset: Math.max(0, state.offset + delta * PAGE_SIZE) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const data = results.data;
  const count = data && data.items.length
    ? `${data.offset + 1}–${Math.min(data.offset + data.items.length, data.total)} of ${data.total} products`
    : '';

  return html`
    <div class="c-views" role="tablist">
      <button type="button" class="c-view" role="tab" aria-selected=${state.view === 'available'}
        onClick=${() => state.view !== 'available' && update({ view: 'available', offset: 0 })}>Available Now</button>
      <button type="button" class="c-view" role="tab" aria-selected=${state.view === 'full'}
        onClick=${() => state.view !== 'full' && update({ view: 'full', offset: 0 })}>Full Catalogue</button>
    </div>
    <div class="c-search">
      <input ref=${searchRef} type="search" inputMode="search" autoComplete="off"
        placeholder="Search products..." aria-label="Search products"
        value=${state.search} onChange=${(e) => update({ search: e.target.value, offset: 0 })} />
      <button class=${`c-search-clear${state.search ? '' : ' hidden'}`} type="button" aria-label="Clear search"
        onClick=${() => { update({ search: '', offset: 0 }); searchRef.current?.focus(); }}>×</button>
    </div>
    <div class="c-controls">
      <div class="c-chips">
        <${Chip} pressed=${state.topLevel === ''} onClick=${() => update({ topLevel: '', categoryPath: '', offset: 0 })}>All Categories<//>
        ${tops.map((c) => html`
          <${Chip} key=${c.path} pressed=${state.topLevel === c.path} count=${c.count}
            onClick=${() => update({ topLevel: c.path, categoryPath: '', offset: 0 })}>${c.name}<//>`)}
      </div>
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
        <span class="c-count">${count}</span>
        <select class="c-sort" aria-label="Sort products" value=${state.sort}
          onChange=${(e) => update({ sort: e.target.value, offset: 0 })}>
          <option value="name_asc">Name A → Z</option>
          <option value="name_desc">Name Z → A</option>
        </select>
      </div>
    </div>
    <div><${Results} results=${results} search=${state.search} go=${go} /></div>`;
}

function Results({ results, search, go }) {
  if (results.loading) {
    return html`<div class="c-grid">${[0, 1, 2, 3, 4, 5].map((i) => html`<div key=${i} class="c-skeleton"></div>`)}</div>`;
  }
  if (results.error) return html`<div class="c-error">Could not load products: ${results.error.message}</div>`;

  const data = results.data;
  if (!data.items.length) {
    return html`
      <div class="c-empty">
        <h2>No products found</h2>
        <p>${search ? `Nothing matches “${search}”. Try a different name or barcode.` : 'No products match these filters.'}</p>
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
