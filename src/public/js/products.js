import { api, esc, num, toast, stockPill } from './api.js';
import { primaryImageSrc } from './product-image.js';

function qualityPill(p) {
  if (p.data_quality_status === 'WARNING') return '<span class="pill warn">Warning</span>';
  if (p.data_quality_status === 'ERROR') return '<span class="pill err">Error</span>';
  return '<span class="pill ok">OK</span>';
}
function reviewFlags(p) {
  const out = [];
  if (p.barcode_change_pending) out.push('<span class="pill info">Barcode review</span>');
  if (p.uom_change_pending) out.push('<span class="pill info">UoM review</span>');
  return out.join(' ');
}

// Render the actual primary image via the existing GET /api/products/:id/image
// endpoint. Falls back to a clean placeholder (no image) or an "unavailable"
// state (image request fails) — never a broken-image icon.
function primaryImageHtml(p, images = []) {
  const src = primaryImageSrc(p, { cacheBust: true });
  if (!src) return '<div class="img-ph">No product image</div>';
  const primaryRow = images.find((i) => i.is_primary && i.is_active) || images.find((i) => i.is_primary);
  const filename = primaryRow?.filename;
  return `
    <img class="saved-photo" src="${esc(src)}" alt="${esc(p.name)} product photo"
         onerror="this.classList.add('hidden'); this.nextElementSibling.classList.remove('hidden');" />
    <div class="img-ph hidden">Image unavailable</div>
    ${filename ? `<div class="muted" style="font-size:12px;margin-top:6px;word-break:break-all">${esc(filename)}</div>` : ''}`;
}

export async function renderProducts(view) {
  const stats = await api.stats();
  view.innerHTML = `
    <h1>Product Master</h1>
    <div class="stats" style="margin-bottom:16px">
      <div class="stat"><div class="n">${num(stats.total)}</div><div class="l">Total</div></div>
      <div class="stat"><div class="n">${num(stats.active)}</div><div class="l">Active</div></div>
      <div class="stat"><div class="n">${num(stats.inactive)}</div><div class="l">Inactive</div></div>
      <div class="stat"><div class="n">${num(stats.warnings)}</div><div class="l">Data Warnings</div></div>
      <div class="stat"><div class="n">${num(stats.barcode_pending)}</div><div class="l">Barcode Review</div></div>
      <div class="stat"><div class="n">${num(stats.uom_pending)}</div><div class="l">UoM Review</div></div>
    </div>
    <div class="card">
      <div class="controls">
        <input type="search" id="q" placeholder="Search barcode, name, or Odoo ID…" />
        <select id="filter">
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="warning">Data quality warning</option>
          <option value="barcode_review">Barcode review</option>
          <option value="uom_review">UoM review</option>
        </select>
        <span class="muted" id="count"></span>
      </div>
      <div id="tableWrap"><div class="sk-lines" role="status" aria-label="Loading"><i></i><i></i><i></i><i></i></div></div>
    </div>`;

  const q = view.querySelector('#q');
  const filter = view.querySelector('#filter');
  let timer;
  const load = async () => {
    const data = await api.products({ search: q.value, filter: filter.value, limit: 200 });
    view.querySelector('#count').textContent = `${num(data.total)} match${data.total === 1 ? '' : 'es'} (showing ${data.items.length})`;
    view.querySelector('#tableWrap').innerHTML = tableHtml(data.items);
  };
  q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 220); });
  filter.addEventListener('change', load);
  await load();
}

function tableHtml(items) {
  if (!items.length) return '<div class="muted">No products found.</div>';
  const rows = items.map((p) => `
    <tr class="clickable" onclick="location.hash='#/products/${p.id}'">
      <td>${esc(p.barcode)}</td>
      <td>${esc(p.name)}</td>
      <td>${esc(p.box_uom || '')}</td>
      <td class="num">${num(p.on_hand)}</td>
      <td class="num">${num(p.free_to_use)}</td>
      <td class="num">${num(p.incoming)}</td>
      <td class="num">${num(p.outgoing)}</td>
      <td class="num">${num(p.forecasted)}</td>
      <td>${p.is_active ? stockPill(p.stock_status) : '<span class="pill muted">Inactive</span>'}</td>
      <td>${qualityPill(p)} ${reviewFlags(p)}</td>
    </tr>`).join('');
  return `<table>
    <thead><tr>
      <th>Barcode</th><th>Product Name</th><th>UoM</th>
      <th class="num">On Hand</th><th class="num">Free To Use</th><th class="num">Incoming</th>
      <th class="num">Outgoing</th><th class="num">Forecasted</th><th>Status</th><th>Data Quality</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

export async function renderProductDetail(view, id) {
  const d = await api.product(id);
  const p = d.product;
  const warnings = [];
  if (p.barcode_change_pending) warnings.push(`Barcode change pending review: <b>${esc(p.barcode)}</b> → <b>${esc(p.pending_barcode)}</b>`);
  if (p.uom_change_pending) warnings.push(`UoM change pending review: <b>${esc(p.box_uom)}</b> → <b>${esc(p.pending_uom)}</b>`);
  if (p.data_quality_notes) warnings.push(`Data quality: ${esc(p.data_quality_notes)}`);

  view.innerHTML = `
    <a class="back" href="#/products">← Back to Product Master</a>
    <h1>${esc(p.name)}</h1>
    ${warnings.length ? `<div class="warnbox">${warnings.join('<br>')}</div>` : ''}
    <div class="row">
      <div class="card" style="flex:2 1 420px">
        <div class="section-title">Product Identity</div>
        <div class="kv">
          <div class="k">Internal ID</div><div>${p.id}</div>
          <div class="k">Source Odoo ID</div><div>${esc(p.source_odoo_id) || '<span class="muted">— (not in current export)</span>'}</div>
          <div class="k">Barcode</div><div>${esc(p.barcode)}</div>
          <div class="k">Status</div><div>${p.is_active ? '<span class="pill ok">Active</span>' : '<span class="pill muted">Inactive</span>'}</div>
        </div>
        <div class="section-title">Product Information</div>
        <div class="kv">
          <div class="k">Name</div><div>${esc(p.name)}</div>
          <div class="k">Box UoM</div><div>${esc(p.box_uom || '')}</div>
          <div class="k">Category</div><div>${d.category ? esc(d.category.name) : '<span class="muted">Uncategorised</span>'}</div>
        </div>
        <div class="section-title">Stock Information <span class="muted">(informational, from Odoo)</span></div>
        <div class="kv">
          <div class="k">Availability</div><div>${p.is_active ? stockPill(p.stock_status) : '<span class="pill muted">Inactive</span>'}</div>
          <div class="k">On Hand</div><div>${num(p.on_hand)}</div>
          <div class="k">Free To Use</div><div>${num(p.free_to_use)}</div>
          <div class="k">Incoming</div><div>${num(p.incoming)}</div>
          <div class="k">Outgoing</div><div>${num(p.outgoing)}</div>
          <div class="k">Forecasted</div><div>${num(p.forecasted)}</div>
        </div>
      </div>
      <div class="card" style="flex:1 1 220px">
        <div class="section-title">Primary Image</div>
        ${primaryImageHtml(p, d.images)}
      </div>
    </div>

    <div class="card">
      <div class="section-title">Import History</div>
      ${d.importHistory.length ? importHistTable(d.importHistory) : '<div class="muted">No imports recorded.</div>'}
    </div>

    <div class="card">
      <div class="section-title">Change History</div>
      ${d.changeHistory.length ? changeTable(d.changeHistory) : '<div class="muted">No changes recorded.</div>'}
    </div>`;
}

function importHistTable(batches) {
  return `<table><thead><tr><th>Batch</th><th>File</th><th>Imported</th><th>Status</th></tr></thead><tbody>
    ${batches.map((b) => `<tr class="clickable" onclick="location.hash='#/imports/${b.id}'">
      <td>#${b.id}</td><td>${esc(b.filename)}</td><td>${esc(b.imported_at)}</td><td>${esc(b.status)}</td>
    </tr>`).join('')}</tbody></table>`;
}
function changeTable(changes) {
  return `<table><thead><tr><th>When</th><th>Type</th><th>Field</th><th>Old</th><th>New</th><th>Review</th></tr></thead><tbody>
    ${changes.map((c) => `<tr>
      <td>${esc(c.created_at)}</td><td>${esc(c.change_type)}</td><td>${esc(c.field || '')}</td>
      <td>${esc(c.old_value || '')}</td><td>${esc(c.new_value || '')}</td>
      <td>${c.review_status === 'NA' ? '' : `<span class="pill ${c.review_status === 'PENDING' ? 'warn' : 'ok'}">${c.review_status}</span>`}</td>
    </tr>`).join('')}</tbody></table>`;
}
