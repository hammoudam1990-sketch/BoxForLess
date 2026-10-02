import { api, esc, num, toast } from './api.js';

export async function renderImports(view) {
  view.innerHTML = `
    <h1>Imports</h1>
    <div class="card">
      <h2>New import from Odoo export (.xlsx)</h2>
      <div class="drop" id="drop">
        <p><b>Drop an Odoo Product Variant export here</b> or choose a file.</p>
        <input type="file" id="file" accept=".xlsx,.xls" />
        <p class="muted">Nothing is written to the database until you review the preview and click <b>Confirm Import</b>.</p>
      </div>
      <div id="previewArea"></div>
    </div>
    <div class="card">
      <h2>Import history</h2>
      <div id="history"><div class="muted">Loading…</div></div>
    </div>`;

  const drop = view.querySelector('#drop');
  const fileInput = view.querySelector('#file');
  const previewArea = view.querySelector('#previewArea');

  const doPreview = async (file) => {
    if (!file) return;
    previewArea.innerHTML = '<div class="muted">Validating…</div>';
    try {
      const res = await api.uploadPreview(file);
      previewArea.innerHTML = previewHtml(res);
      if (res.preview.ok) {
        previewArea.querySelector('#confirmBtn').addEventListener('click', async (ev) => {
          ev.target.disabled = true; ev.target.textContent = 'Importing…';
          try {
            const r = await api.confirmImport(res.batchId);
            toast(`Import complete: ${r.counts.created} new, ${r.counts.updated} updated, ${r.counts.inactivated} inactivated`, 'ok');
            location.hash = `#/imports/${res.batchId}`;
          } catch (e) { toast(e.message, 'err'); ev.target.disabled = false; ev.target.textContent = 'Confirm Import'; }
        });
      }
    } catch (e) { previewArea.innerHTML = `<div class="errbox">${esc(e.message)}</div>`; }
  };

  fileInput.addEventListener('change', (e) => doPreview(e.target.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => doPreview(e.dataTransfer.files[0]));

  await loadHistory(view.querySelector('#history'));
}

function previewHtml(res) {
  const p = res.preview;
  if (!p.ok) {
    return `<div class="errbox"><b>Cannot import:</b> ${esc(p.fatal)}</div>
      ${p.missingColumns?.length ? `<div class="muted">Missing required columns: ${p.missingColumns.join(', ')}</div>` : ''}`;
  }
  const s = p.summary;
  const tile = (n, l, cls = '') => `<div class="stat"><div class="n ${cls}">${num(n)}</div><div class="l">${l}</div></div>`;
  return `
    <h2 style="margin-top:18px">Import preview — batch #${res.batchId}</h2>
    <div class="stats" style="margin-bottom:14px">
      ${tile(s.total_rows, 'Total rows')}
      ${tile(s.valid_rows, 'Valid')}
      ${tile(s.invalid_rows, 'Invalid')}
      ${tile(s.created, 'New products')}
      ${tile(s.updated, 'Updated')}
      ${tile(s.unchanged, 'Unchanged')}
      ${tile(s.inactivated, 'Will inactivate')}
      ${tile(s.barcode_changes, 'Barcode changes')}
      ${tile(s.uom_changes, 'UoM changes')}
      ${tile(s.duplicate_barcodes, 'Duplicate barcodes')}
      ${tile(s.warnings, 'Warnings')}
      ${tile(s.errors, 'Errors')}
    </div>
    ${p.unexpectedColumns?.length ? `<div class="warnbox">Unexpected columns (ignored, not imported): ${p.unexpectedColumns.map(esc).join(', ')}</div>` : ''}
    ${section('Validation errors', p.errors, (e) => `Row ${e.rowNumber} · ${esc(e.barcode || '')} — ${e.errors.map(esc).join('; ')}`)}
    ${section('Barcode changes (will be flagged for review)', p.barcodeChanges, (c) => `${esc(c.name)} — ${esc(c.old)} → ${esc(c.new)}`)}
    ${section('UoM changes (will be flagged for review)', p.uomChanges, (c) => `${esc(c.name)} — ${esc(c.old)} → ${esc(c.new)}`)}
    ${section('Products that will become inactive', p.inactivations, (c) => `${esc(c.barcode)} — ${esc(c.name)}`)}
    ${section('Data-quality warnings', p.warnings, (w) => `Row ${w.rowNumber} · ${esc(w.barcode || '')} — ${w.warnings.map(esc).join('; ')}`)}
    <div style="margin-top:14px">
      <button id="confirmBtn">Confirm Import</button>
      <span class="muted"> This applies ${num(s.created)} new + ${num(s.updated)} updates in one transaction.</span>
    </div>`;
}

function section(title, items, fmt) {
  if (!items || !items.length) return '';
  return `<div class="section-title">${title} (${items.length})</div>
    <ul style="margin:0 0 10px; padding-left:18px">${items.slice(0, 50).map((i) => `<li>${fmt(i)}</li>`).join('')}
    ${items.length > 50 ? `<li class="muted">…and ${items.length - 50} more</li>` : ''}</ul>`;
}

async function loadHistory(node) {
  const { items } = await api.imports();
  if (!items.length) { node.innerHTML = '<div class="muted">No imports yet.</div>'; return; }
  node.innerHTML = `<table><thead><tr>
    <th>#</th><th>File</th><th>Imported</th><th>Status</th>
    <th class="num">Rows</th><th class="num">New</th><th class="num">Updated</th><th class="num">Inactivated</th>
    <th class="num">Errors</th></tr></thead><tbody>
    ${items.map((b) => `<tr class="clickable" onclick="location.hash='#/imports/${b.id}'">
      <td>#${b.id}</td><td>${esc(b.filename)}</td><td>${esc(b.imported_at)}</td>
      <td><span class="pill ${b.status === 'COMPLETED' ? 'ok' : b.status === 'FAILED' ? 'err' : 'warn'}">${b.status}</span></td>
      <td class="num">${num(b.total_rows)}</td><td class="num">${num(b.created_count)}</td>
      <td class="num">${num(b.updated_count)}</td><td class="num">${num(b.inactive_count)}</td>
      <td class="num">${num(b.error_count)}</td>
    </tr>`).join('')}</tbody></table>`;
}

export async function renderImportDetail(view, id) {
  const { batch: b, changes } = await api.importBatch(id);
  view.innerHTML = `
    <a class="back" href="#/imports">← Back to Imports</a>
    <h1>Import #${b.id} — ${esc(b.filename)}</h1>
    <div class="card">
      <div class="kv">
        <div class="k">Status</div><div><span class="pill ${b.status === 'COMPLETED' ? 'ok' : b.status === 'FAILED' ? 'err' : 'warn'}">${b.status}</span></div>
        <div class="k">Imported at</div><div>${esc(b.imported_at)}</div>
        <div class="k">Completed at</div><div>${esc(b.completed_at || '—')}</div>
        <div class="k">Total / Valid / Invalid</div><div>${num(b.total_rows)} / ${num(b.valid_rows)} / ${num(b.invalid_rows)}</div>
        <div class="k">New / Updated / Unchanged</div><div>${num(b.created_count)} / ${num(b.updated_count)} / ${num(b.unchanged_count)}</div>
        <div class="k">Inactivated / Reactivated</div><div>${num(b.inactive_count)} / ${num(b.reactivated_count)}</div>
        <div class="k">Barcode / UoM changes</div><div>${num(b.barcode_change_count)} / ${num(b.uom_change_count)}</div>
        <div class="k">Warnings / Errors</div><div>${num(b.warning_count)} / ${num(b.error_count)}</div>
        ${b.notes ? `<div class="k">Notes</div><div>${esc(b.notes)}</div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="section-title">Change log (${changes.length})</div>
      ${changes.length ? `<table><thead><tr><th>Type</th><th>Barcode</th><th>Field</th><th>Old</th><th>New</th><th>Review</th><th>Message</th></tr></thead><tbody>
        ${changes.map((c) => `<tr>
          <td>${esc(c.change_type)}</td><td>${esc(c.barcode || '')}</td><td>${esc(c.field || '')}</td>
          <td>${esc(c.old_value || '')}</td><td>${esc(c.new_value || '')}</td>
          <td>${c.review_status === 'NA' ? '' : esc(c.review_status)}</td><td>${esc(c.message || '')}</td>
        </tr>`).join('')}</tbody></table>` : '<div class="muted">No change-log entries.</div>'}
    </div>`;
}
