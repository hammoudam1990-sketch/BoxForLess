// One product: /catalog/product/:id
import { html, useEffect } from '../lib/react.js';
import { useAsync } from '../lib/hooks.js';
import { getJSON } from './http.js';
import { Link } from './router.js';
import { Pill, ProductImage, RequestControl } from './parts.js';
import { Doodle, doodleFor } from './doodles.js';

export function DetailView({ id }) {
  const state = useAsync(() => getJSON(`/api/catalog/products/${encodeURIComponent(id)}`), [id]);
  const p = state.data;

  useEffect(() => {
    if (p) document.title = `${p.name} — Box for Less`;
  }, [p]);

  if (state.loading) return html`
    <div class="c-detail-skeleton" role="status" aria-label="Loading product" aria-busy="true">
      <div class="c-skeleton c-detail-skeleton-image" aria-hidden="true"></div>
      <div class="c-detail-skeleton-copy" aria-hidden="true">
        <i></i><i></i><i></i><i></i>
      </div>
    </div>`;

  if (state.error) {
    return html`
      <${Link} class="c-back" href="/catalog">← Back to Catalog<//>
      <div class="c-error" style=${{ marginTop: 12 }}>
        ${state.error.status === 404
    ? 'This product is not available in the catalog.'
    : `Could not load this product: ${state.error.message}`}
      </div>`;
  }

  // No image: the picture column is left out entirely rather than shown as a large
  // empty box beside the facts. Almost nothing has a photo, and half a blank screen
  // reads as a broken page.
  return html`
    <${Link} class="c-back" href="/catalog">← Back to Catalog<//>
    <div class="c-detail">
      <div class=${`c-detail-grid${p.image ? '' : ' c-detail-grid-noimg'}`}>
        ${p.image ? html`<div class="c-hero"><span class="c-mark" aria-hidden="true">↗</span><${ProductImage} image=${p.image} name=${p.name} /></div>` : null}
        <div>
          ${p.image ? null : html`<div class="c-doodle-hero"><${Doodle} name=${doodleFor(p)} size="lg" /></div>`}
          <h1>${p.name}</h1>
          <div class="c-facts">
            <div><div class="c-fact-k">Barcode</div><div class="c-fact-v">${p.barcode}</div></div>
            ${p.pack ? html`<div><div class="c-fact-k">Pack / UoM</div><div class="c-fact-v">${p.pack}</div></div>` : null}
            ${p.category ? html`
              <div>
                <div class="c-fact-k">Category</div>
                <div class="c-fact-v">${p.category.name}</div>
                <div class="c-pack" style=${{ marginTop: 2 }}>${p.category.path}</div>
              </div>` : null}
            <div><div class="c-fact-k">Availability</div><div><${Pill} availability=${p.availability} /></div></div>
          </div>
          <div class="c-detail-actions"><${RequestControl} product=${p} /></div>
          <${Link} class="c-btn" href="/catalog" style=${{ display: 'inline-block', textDecoration: 'none', marginTop: 14 }}>Back to Catalog<//>
        </div>
      </div>
    </div>`;
}
