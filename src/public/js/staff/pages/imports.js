import { html, useState } from '../../lib/react.js';
import { useAsync } from '../../lib/hooks.js';
import { num, shortTimestamp } from '../../lib/format.js';
import { api } from '../../api.js';
import { Pill, Async, KV, goto, useToast } from '../ui.js';

const batchTone = (status) => (status === 'COMPLETED' ? 'ok' : status === 'FAILED' ? 'err' : 'warn');

/** A dashed drop target that also holds a plain file input. */
function DropZone({ accept, onFile, children }) {
  const [over, setOver] = useState(false);
  return html`
    <div class=${`drop${over ? ' drag' : ''}`}
      onDragOver=${(e) => { e.preventDefault(); setOver(true); }}
      onDragEnter=${(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave=${(e) => { e.preventDefault(); setOver(false); }}
      onDrop=${(e) => { e.preventDefault(); setOver(false); onFile(e.dataTransfer.files[0]); }}>
      ${children}
      <input type="file" accept=${accept}
        onChange=${(e) => { const f = e.target.files[0]; e.target.value = ''; onFile(f); }} />
    </div>`;
}

export function ImportsPage() {
  return html`
    <h1>Imports</h1>
    <${ProductImport} />
    <${CustomerImport} />
    <${ProductImportHistory} />`;
}

// ---------------------------------------------------------------------------
// product import (Odoo Product Variant export)
// ---------------------------------------------------------------------------

function ProductImport() {
  const toast = useToast();
  // idle | validating | { error } | { res }
  const [step, setStep] = useState({ kind: 'idle' });
  const [importing, setImporting] = useState(false);

  const preview = async (file) => {
    if (!file) return;
    setStep({ kind: 'validating' });
    try {
      setStep({ kind: 'preview', res: await api.uploadPreview(file) });
    } catch (e) { setStep({ kind: 'error', message: e.message }); }
  };

  const confirm = async (batchId) => {
    setImporting(true);
    try {
      const r = await api.confirmImport(batchId);
      toast(`Import complete: ${r.counts.created} new, ${r.counts.updated} updated, ${r.counts.inactivated} inactivated`, 'ok');
      goto(`#/imports/${batchId}`);
    } catch (e) { toast(e.message, 'err'); setImporting(false); }
  };

  return html`
    <div class="card">
      <h2>New import from Odoo export (.xlsx)</h2>
      <${DropZone} accept=".xlsx,.xls" onFile=${preview}>
        <p><b>Drop an Odoo Product Variant export here</b> or choose a file.</p>
        <p class="muted">Nothing is written to the database until you review the preview and click <b>Confirm Import</b>.</p>
      <//>
      <div>
        ${step.kind === 'validating' ? html`<div class="muted">Validating…</div>` : null}
        ${step.kind === 'error' ? html`<div class="errbox">${step.message}</div>` : null}
        ${step.kind === 'preview' ? html`<${ProductPreview} res=${step.res} importing=${importing} onConfirm=${confirm} />` : null}
      </div>
    </div>`;
}

function Tile({ n, label }) {
  return html`<div class="stat"><div class="n">${num(n)}</div><div class="l">${label}</div></div>`;
}

function Section({ title, items, format }) {
  if (!items || !items.length) return null;
  return html`
    <div class="section-title">${title} (${items.length})</div>
    <ul style=${{ margin: '0 0 10px', paddingLeft: 18 }}>
      ${items.slice(0, 50).map((item, i) => html`<li key=${i}>${format(item)}</li>`)}
      ${items.length > 50 ? html`<li class="muted">…and ${items.length - 50} more</li>` : null}
    </ul>`;
}

function ProductPreview({ res, importing, onConfirm }) {
  const p = res.preview;
  if (!p.ok) {
    return html`
      <div class="errbox"><b>Cannot import:</b> ${p.fatal}</div>
      ${p.missingColumns?.length ? html`<div class="muted">Missing required columns: ${p.missingColumns.join(', ')}</div>` : null}`;
  }
  const s = p.summary;
  return html`
    <h2 style=${{ marginTop: 18 }}>Import preview — batch #${res.batchId}</h2>
    <div class="stats" style=${{ marginBottom: 14 }}>
      <${Tile} n=${s.total_rows} label="Total rows" />
      <${Tile} n=${s.valid_rows} label="Valid" />
      <${Tile} n=${s.invalid_rows} label="Invalid" />
      <${Tile} n=${s.created} label="New products" />
      <${Tile} n=${s.updated} label="Updated" />
      <${Tile} n=${s.unchanged} label="Unchanged" />
      <${Tile} n=${s.inactivated} label="Will inactivate" />
      <${Tile} n=${s.barcode_changes} label="Barcode changes" />
      <${Tile} n=${s.uom_changes} label="UoM changes" />
      <${Tile} n=${s.duplicate_barcodes} label="Duplicate barcodes" />
      <${Tile} n=${s.warnings} label="Warnings" />
      <${Tile} n=${s.errors} label="Errors" />
    </div>
    ${p.unexpectedColumns?.length
    ? html`<div class="warnbox">Unexpected columns (ignored, not imported): ${p.unexpectedColumns.join(', ')}</div>` : null}
    <${Section} title="Validation errors" items=${p.errors}
      format=${(e) => `Row ${e.rowNumber} · ${e.barcode || ''} — ${e.errors.join('; ')}`} />
    <${Section} title="Barcode changes (will be flagged for review)" items=${p.barcodeChanges}
      format=${(c) => `${c.name} — ${c.old} → ${c.new}`} />
    <${Section} title="UoM changes (will be flagged for review)" items=${p.uomChanges}
      format=${(c) => `${c.name} — ${c.old} → ${c.new}`} />
    <${Section} title="Products that will become inactive" items=${p.inactivations}
      format=${(c) => `${c.barcode} — ${c.name}`} />
    <${Section} title="Data-quality warnings" items=${p.warnings}
      format=${(w) => `Row ${w.rowNumber} · ${w.barcode || ''} — ${w.warnings.join('; ')}`} />
    <div style=${{ marginTop: 14 }}>
      <button disabled=${importing} onClick=${() => onConfirm(res.batchId)}>${importing ? 'Importing…' : 'Confirm Import'}</button>
      <span class="muted"> This applies ${num(s.created)} new + ${num(s.updated)} updates in one transaction.</span>
    </div>`;
}

function ProductImportHistory() {
  const state = useAsync(() => api.imports(), []);
  return html`
    <div class="card">
      <h2>Import history</h2>
      <${Async} state=${state}>${({ items }) => (!items.length
    ? html`<div class="muted">No imports yet.</div>`
    : html`
          <table>
            <thead><tr>
              <th>#</th><th>File</th><th>Imported</th><th>Status</th>
              <th class="num">Rows</th><th class="num">New</th><th class="num">Updated</th><th class="num">Inactivated</th>
              <th class="num">Errors</th>
            </tr></thead>
            <tbody>
              ${items.map((b) => html`
                <tr key=${b.id} class="clickable" onClick=${() => goto(`#/imports/${b.id}`)}>
                  <td>#${b.id}</td><td>${b.filename}</td><td>${b.imported_at}</td>
                  <td><${Pill} tone=${batchTone(b.status)}>${b.status}<//></td>
                  <td class="num">${num(b.total_rows)}</td><td class="num">${num(b.created_count)}</td>
                  <td class="num">${num(b.updated_count)}</td><td class="num">${num(b.inactive_count)}</td>
                  <td class="num">${num(b.error_count)}</td>
                </tr>`)}
            </tbody>
          </table>`)}<//>
    </div>`;
}

// ---------------------------------------------------------------------------
// customer list import (separate endpoint, separate audit)
// ---------------------------------------------------------------------------

function CustomerImport() {
  const toast = useToast();
  const history = useAsync(() => api.customerImports(), []);
  const [step, setStep] = useState({ kind: 'idle' });
  const [importing, setImporting] = useState(false);

  const preview = async (file) => {
    if (!file) return;
    setStep({ kind: 'reading' });
    try {
      setStep({ kind: 'preview', res: await api.uploadCustomerPreview(file) });
    } catch (e) { setStep({ kind: 'error', message: e.message }); }
  };

  const confirm = async (batchId) => {
    setImporting(true);
    try {
      const r = await api.confirmCustomerImport(batchId);
      toast(`Customers imported: ${r.counts.created} new, ${r.counts.updated} updated, ${r.counts.unchanged} unchanged`, 'ok');
      history.reload();
      setStep({ kind: 'done', counts: r.counts });
    } catch (e) { toast(e.message, 'err'); }
    setImporting(false);
  };

  return html`
    <div class="card">
      <h2>Customer list import</h2>
      <p class="muted">Import the customer list from an Odoo <b>Contact (res.partner)</b> export.
        Only <b>Display Name, Email, Pricelist, Phone and Country</b> are read —
        avatar, activities and stats are ignored.</p>
      <${DropZone} accept=".xlsx,.xls" onFile=${preview}>
        <p><b>Choose a customer Excel file</b> (.xlsx)</p>
        <p class="muted">Nothing is written until you review the preview and click
          <b>Confirm Customer Import</b>.</p>
      <//>
      <div>
        ${step.kind === 'reading' ? html`<div class="muted">Reading customer file…</div>` : null}
        ${step.kind === 'error' ? html`<div class="errbox">${step.message}</div>` : null}
        ${step.kind === 'preview' ? html`<${CustomerPreview} res=${step.res} importing=${importing} onConfirm=${confirm} />` : null}
        ${step.kind === 'done' ? html`
          <div class="okbox">Customer import complete —
            ${num(step.counts.created)} new, ${num(step.counts.updated)} updated,
            ${num(step.counts.unchanged)} unchanged.</div>` : null}
      </div>
      <div class="muted" style=${{ marginTop: 12 }}>
        ${history.error ? 'Could not load customer import history.'
    : !history.data ? 'Loading…'
      : history.data.items.length ? html`<${CustomerHistory} items=${history.data.items} />` : 'No customer imports yet.'}
      </div>
    </div>`;
}

function CustomerHistory({ items }) {
  return html`
    <table>
      <thead><tr><th>File</th><th>Status</th><th>Rows</th><th>New</th><th>Updated</th><th>When</th></tr></thead>
      <tbody>
        ${items.slice(0, 10).map((b) => html`
          <tr key=${b.id}>
            <td>${b.filename}</td>
            <td>${b.status === 'COMPLETED' ? html`<${Pill} tone="ok">Applied<//>` : html`<${Pill} tone="muted">${b.status}<//>`}</td>
            <td>${num(b.total_rows)}</td><td>${num(b.new_count)}</td><td>${num(b.updated_count)}</td>
            <td>${shortTimestamp(b.confirmed_at || b.created_at)}</td>
          </tr>`)}
      </tbody>
    </table>`;
}

function Stat({ label, value, tone = '' }) {
  return html`<div class="stat"><div class="l">${label}</div><div class=${`v ${tone}`}>${num(value)}</div></div>`;
}

/** Preview panel for a customer import. Confirmation is always explicit. */
function CustomerPreview({ res, importing, onConfirm }) {
  const s = res.preview.summary;
  const { errorRows, warningRows, mappedColumns, ignoredColumns } = res.preview;
  return html`
    <div class="stats" style=${{ marginTop: 12 }}>
      <${Stat} label="Total rows" value=${s.total_rows} />
      <${Stat} label="Valid" value=${s.valid_rows} tone="ok" />
      <${Stat} label="Invalid" value=${s.invalid_rows} tone=${s.invalid_rows ? 'err' : ''} />
      <${Stat} label="Duplicates" value=${s.duplicate_rows} tone=${s.duplicate_rows ? 'warn' : ''} />
      <${Stat} label="New customers" value=${s.new_count} />
      <${Stat} label="Existing / unchanged" value=${s.unchanged_count} />
      <${Stat} label="Existing / updated" value=${s.updated_count} />
      <${Stat} label="Warnings" value=${s.warning_count} tone=${s.warning_count ? 'warn' : ''} />
    </div>
    <p class="muted">Columns read: <b>${Object.values(mappedColumns).join(', ')}</b>.
      Ignored: ${ignoredColumns.join(', ') || 'none'}.</p>
    ${errorRows.length ? html`
      <div class="notice"><b>${errorRows.length} row(s) will be skipped:</b><br />
        ${errorRows.slice(0, 10).map((r, i) => html`
          <span key=${i}>Row ${r.rowNumber} ${r.name || ''} — ${r.errors.join('; ')}<br /></span>`)}
      </div>` : null}
    ${warningRows.length ? html`
      <div class="muted" style=${{ margin: '8px 0' }}>${warningRows.length} row(s) with warnings (still imported).</div>` : null}
    <div class="scan-actions" style=${{ marginTop: 12 }}>
      ${s.valid_rows > 0
    ? html`<button disabled=${importing} onClick=${() => onConfirm(res.batchId)}>${importing ? 'Importing…' : 'Confirm Customer Import'}</button>`
    : html`<div class="errbox">No valid customer rows to import.</div>`}
    </div>`;
}

// ---------------------------------------------------------------------------
// one batch
// ---------------------------------------------------------------------------

export function ImportDetailPage({ id }) {
  const state = useAsync(() => api.importBatch(id), [id]);
  return html`<${Async} state=${state}>${({ batch: b, changes }) => html`
    <a class="back" href="#/imports">← Back to Imports</a>
    <h1>Import #${b.id} — ${b.filename}</h1>
    <div class="card">
      <${KV} rows=${[
    ['Status', html`<${Pill} tone=${batchTone(b.status)}>${b.status}<//>`],
    ['Imported at', b.imported_at],
    ['Completed at', b.completed_at || '—'],
    ['Total / Valid / Invalid', `${num(b.total_rows)} / ${num(b.valid_rows)} / ${num(b.invalid_rows)}`],
    ['New / Updated / Unchanged', `${num(b.created_count)} / ${num(b.updated_count)} / ${num(b.unchanged_count)}`],
    ['Inactivated / Reactivated', `${num(b.inactive_count)} / ${num(b.reactivated_count)}`],
    ['Barcode / UoM changes', `${num(b.barcode_change_count)} / ${num(b.uom_change_count)}`],
    ['Warnings / Errors', `${num(b.warning_count)} / ${num(b.error_count)}`],
    b.notes ? ['Notes', b.notes] : null,
  ]} />
    </div>
    <div class="card">
      <div class="section-title">Change log (${changes.length})</div>
      ${changes.length ? html`
        <table>
          <thead><tr><th>Type</th><th>Barcode</th><th>Field</th><th>Old</th><th>New</th><th>Review</th><th>Message</th></tr></thead>
          <tbody>
            ${changes.map((c, i) => html`
              <tr key=${i}>
                <td>${c.change_type}</td><td>${c.barcode || ''}</td><td>${c.field || ''}</td>
                <td>${c.old_value || ''}</td><td>${c.new_value || ''}</td>
                <td>${c.review_status === 'NA' ? '' : c.review_status}</td><td>${c.message || ''}</td>
              </tr>`)}
          </tbody>
        </table>` : html`<div class="muted">No change-log entries.</div>`}
    </div>`}<//>`;
}
