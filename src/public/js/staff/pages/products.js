import { html, useState, useMemo } from '../../lib/react.js';
import { useAsync, useDebounced } from '../../lib/hooks.js';
import { num } from '../../lib/format.js';
import { api } from '../../api.js';
import { primaryImageSrc } from '../../product-image.js';
import { Pill, ProductStatus, Async, ErrorCard, KV, goto } from '../ui.js';

function QualityPill({ product: p }) {
  if (p.data_quality_status === 'WARNING') return html`<${Pill} tone="warn">Warning<//>`;
  if (p.data_quality_status === 'ERROR') return html`<${Pill} tone="err">Error<//>`;
  return html`<${Pill} tone="ok">OK<//>`;
}

function ReviewFlags({ product: p }) {
  return html`
    ${p.barcode_change_pending ? html`<${Pill} tone="info">Barcode review<//>` : null}
    ${' '}
    ${p.uom_change_pending ? html`<${Pill} tone="info">UoM review<//>` : null}`;
}

const STATS = [
  ['total', 'Total'], ['active', 'Active'], ['inactive', 'Inactive'],
  ['warnings', 'Data Warnings'], ['barcode_pending', 'Barcode Review'], ['uom_pending', 'UoM Review'],
];

export function ProductsPage() {
  const stats = useAsync(() => api.stats(), []);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  // The search box is typed into, so only the DEBOUNCED value reaches the server.
  // Nothing above the input is re-created while someone is typing.
  const term = useDebounced(search, 220);
  const list = useAsync(() => api.products({ search: term, filter, limit: 200 }), [term, filter]);

  return html`
    <h1>Product Master</h1>
    ${stats.error ? html`<${ErrorCard} error=${stats.error} />` : null}
    ${stats.data ? html`
      <div class="stats" style=${{ marginBottom: 16 }}>
        ${STATS.map(([key, label]) => html`
          <div class="stat" key=${key}><div class="n">${num(stats.data[key])}</div><div class="l">${label}</div></div>`)}
      </div>` : null}
    <div class="card">
      <div class="controls">
        <input type="search" placeholder="Search barcode, name, or Odoo ID…"
          value=${search} onChange=${(e) => setSearch(e.target.value)} />
        <select value=${filter} onChange=${(e) => setFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="warning">Data quality warning</option>
          <option value="barcode_review">Barcode review</option>
          <option value="uom_review">UoM review</option>
        </select>
        <span class="muted">${list.data
    ? `${num(list.data.total)} match${list.data.total === 1 ? '' : 'es'} (showing ${list.data.items.length})`
    : ''}</span>
      </div>
      ${list.error ? html`<div class="errbox">${list.error.message}</div>`
    : !list.data ? html`<div class="muted">Loading…</div>`
      : html`<${ProductTable} items=${list.data.items} />`}
    </div>`;
}

function ProductTable({ items }) {
  if (!items.length) return html`<div class="muted">No products found.</div>`;
  return html`
    <table>
      <thead><tr>
        <th>Barcode</th><th>Product Name</th><th>UoM</th>
        <th class="num">On Hand</th><th class="num">Free To Use</th><th class="num">Incoming</th>
        <th class="num">Outgoing</th><th class="num">Forecasted</th><th>Status</th><th>Data Quality</th>
      </tr></thead>
      <tbody>
        ${items.map((p) => html`
          <tr key=${p.id} class="clickable" onClick=${() => goto(`#/products/${p.id}`)}>
            <td>${p.barcode}</td>
            <td>${p.name}</td>
            <td>${p.box_uom || ''}</td>
            <td class="num">${num(p.on_hand)}</td>
            <td class="num">${num(p.free_to_use)}</td>
            <td class="num">${num(p.incoming)}</td>
            <td class="num">${num(p.outgoing)}</td>
            <td class="num">${num(p.forecasted)}</td>
            <td><${ProductStatus} product=${p} /></td>
            <td><${QualityPill} product=${p} /> <${ReviewFlags} product=${p} /></td>
          </tr>`)}
      </tbody>
    </table>`;
}

/**
 * The saved primary image, via the existing GET /api/products/:id/image endpoint.
 * Falls back to a clean placeholder (no image) or an "unavailable" state (the
 * request fails) — never a broken-image icon.
 */
function PrimaryImage({ product: p, images = [] }) {
  const [failed, setFailed] = useState(false);
  // Computed once per product: a fresh timestamp on every render would change the
  // src each time and make the browser refetch the image forever.
  const src = useMemo(
    () => primaryImageSrc(p, { cacheBust: true }),
    [p.id, p.primary_image_id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (!src) return html`<div class="img-ph">No product image</div>`;
  const primaryRow = images.find((i) => i.is_primary && i.is_active) || images.find((i) => i.is_primary);
  return html`
    ${failed
    ? html`<div class="img-ph">Image unavailable</div>`
    : html`<img class="saved-photo" src=${src} alt=${`${p.name} product photo`} onError=${() => setFailed(true)} />`}
    ${primaryRow?.filename
    ? html`<div class="muted" style=${{ fontSize: 12, marginTop: 6, wordBreak: 'break-all' }}>${primaryRow.filename}</div>`
    : null}`;
}

export function ProductDetailPage({ id }) {
  const state = useAsync(() => api.product(id), [id]);
  return html`<${Async} state=${state}>${(d) => html`<${ProductDetail} d=${d} />`}<//>`;
}

function ProductDetail({ d }) {
  const p = d.product;
  const warnings = [];
  if (p.barcode_change_pending) warnings.push(html`Barcode change pending review: <b>${p.barcode}</b> → <b>${p.pending_barcode}</b>`);
  if (p.uom_change_pending) warnings.push(html`UoM change pending review: <b>${p.box_uom}</b> → <b>${p.pending_uom}</b>`);
  if (p.data_quality_notes) warnings.push(html`Data quality: ${p.data_quality_notes}`);

  return html`
    <a class="back" href="#/products">← Back to Product Master</a>
    <h1>${p.name}</h1>
    ${warnings.length ? html`
      <div class="warnbox">
        ${warnings.map((w, i) => html`<span key=${i}>${i ? html`<br />` : null}${w}</span>`)}
      </div>` : null}
    <div class="row">
      <div class="card" style=${{ flex: '2 1 420px' }}>
        <div class="section-title">Product Identity</div>
        <${KV} rows=${[
    ['Internal ID', p.id],
    ['Source Odoo ID', p.source_odoo_id || html`<span class="muted">— (not in current export)</span>`],
    ['Barcode', p.barcode],
    ['Status', p.is_active ? html`<${Pill} tone="ok">Active<//>` : html`<${Pill} tone="muted">Inactive<//>`],
  ]} />
        <div class="section-title">Product Information</div>
        <${KV} rows=${[
    ['Name', p.name],
    ['Box UoM', p.box_uom || ''],
    ['Category', d.category ? d.category.name : html`<span class="muted">Uncategorised</span>`],
  ]} />
        <div class="section-title">Stock Information <span class="muted">(informational, from Odoo)</span></div>
        <${KV} rows=${[
    ['Availability', html`<${ProductStatus} product=${p} />`],
    ['On Hand', num(p.on_hand)],
    ['Free To Use', num(p.free_to_use)],
    ['Incoming', num(p.incoming)],
    ['Outgoing', num(p.outgoing)],
    ['Forecasted', num(p.forecasted)],
  ]} />
      </div>
      <div class="card" style=${{ flex: '1 1 220px' }}>
        <div class="section-title">Primary Image</div>
        <${PrimaryImage} product=${p} images=${d.images} />
      </div>
    </div>

    <div class="card">
      <div class="section-title">Import History</div>
      ${d.importHistory.length ? html`<${ImportHistory} batches=${d.importHistory} />` : html`<div class="muted">No imports recorded.</div>`}
    </div>

    <div class="card">
      <div class="section-title">Change History</div>
      ${d.changeHistory.length ? html`<${ChangeHistory} changes=${d.changeHistory} />` : html`<div class="muted">No changes recorded.</div>`}
    </div>`;
}

function ImportHistory({ batches }) {
  return html`
    <table>
      <thead><tr><th>Batch</th><th>File</th><th>Imported</th><th>Status</th></tr></thead>
      <tbody>
        ${batches.map((b) => html`
          <tr key=${b.id} class="clickable" onClick=${() => goto(`#/imports/${b.id}`)}>
            <td>#${b.id}</td><td>${b.filename}</td><td>${b.imported_at}</td><td>${b.status}</td>
          </tr>`)}
      </tbody>
    </table>`;
}

function ChangeHistory({ changes }) {
  return html`
    <table>
      <thead><tr><th>When</th><th>Type</th><th>Field</th><th>Old</th><th>New</th><th>Review</th></tr></thead>
      <tbody>
        ${changes.map((c, i) => html`
          <tr key=${i}>
            <td>${c.created_at}</td><td>${c.change_type}</td><td>${c.field || ''}</td>
            <td>${c.old_value || ''}</td><td>${c.new_value || ''}</td>
            <td>${c.review_status === 'NA' ? '' : html`<${Pill} tone=${c.review_status === 'PENDING' ? 'warn' : 'ok'}>${c.review_status}<//>`}</td>
          </tr>`)}
      </tbody>
    </table>`;
}
