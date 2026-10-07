// Pieces shared by the catalogue list and the product page.
//
// Everything here receives customer-safe payloads from /api/catalog: no price, no
// stock quantity, no internal id. There is nothing in this file to hide.
import { html, useState } from '../lib/react.js';
import { setQuantity } from '../cart.js';
import { useQuantity } from './useCart.js';
import { Link } from './router.js';

const NO_IMAGE_TEXT = 'No product image available';

/** The three customer availability states. Never a quantity. */
export function Pill({ availability }) {
  if (!availability) return null;
  return html`<span class=${`c-pill ${availability.tone}`}>${availability.label}</span>`;
}

/** The explicit placeholder shown when an image cannot be loaded. */
export const NoImage = () => html`<div class="c-noimg">${NO_IMAGE_TEXT}</div>`;

/**
 * A product image that falls back to the placeholder text if it fails to load.
 * The filename is never rendered.
 */
export function ProductImage({ image, name, eager = false }) {
  // remembered by URL, so a component reused for a different image starts fresh
  const [failedUrl, setFailedUrl] = useState(null);
  if (failedUrl === image.url) return html`<${NoImage} />`;
  return html`<img src=${image.url} alt=${name} loading=${eager ? 'eager' : 'lazy'} decoding="async"
    onError=${() => setFailedUrl(image.url)} />`;
}

/** Thumbnail, or — for the near-total majority with no photo — a slim accent bar. */
function Thumb({ product }) {
  // Almost nothing in this catalogue has a photo — 8,932 of 8,933 at the time of
  // writing. A 1:1 placeholder for each one filled most of every card with empty
  // grey and pushed the product name, the only real information, into a strip at
  // the bottom. A card with no photo now carries a slim accent bar instead and
  // gives its space to the name. The square is kept for products that do have an
  // image, so those still look right.
  if (!product.image) return html`<div class="c-thumb-bare" aria-hidden="true"></div>`;
  return html`<div class="c-thumb"><${ProductImage} image=${product.image} name=${product.name} /></div>`;
}

/**
 * The add-to-request control. A product holding less than one whole carton is not
 * requestable even while it still reads Limited Stock, so it gets a plain note
 * instead of a stepper — better than offering a control whose every use would fail.
 */
export function RequestControl({ product }) {
  const qty = useQuantity(product.id);
  if (!product.requestable) return html`<div class="c-noreq">Not available to request right now</div>`;

  const set = (n) => setQuantity({ barcode: product.id, name: product.name, pack: product.pack }, n);
  if (qty < 1) {
    return html`<button class="c-add" type="button" onClick=${() => set(qty + 1)}>
      Add to request${product.pack ? ` · ${product.pack}` : ''}</button>`;
  }
  return html`
    <div class="c-stepper">
      <button type="button" class="c-step" aria-label="Fewer cartons" onClick=${() => set(qty - 1)}>−</button>
      <span class="c-qty"><b>${qty}</b> CTN</span>
      <button type="button" class="c-step" aria-label="More cartons" onClick=${() => set(qty + 1)}>+</button>
    </div>`;
}

export function ProductCard({ product }) {
  return html`
    <div class="c-card">
      <${Link} class="c-card-link" href=${`/catalog/product/${encodeURIComponent(product.id)}`}>
        <${Thumb} product=${product} />
        <div class="c-card-body">
          <div class="c-name">${product.name}</div>
          ${product.pack ? html`<div class="c-pack">${product.pack}</div>` : null}
          ${product.category ? html`<div class="c-cat">${product.category.name}</div>` : null}
          <${Pill} availability=${product.availability} />
        </div>
      <//>
      <div class="c-card-actions"><${RequestControl} product=${product} /></div>
    </div>`;
}
