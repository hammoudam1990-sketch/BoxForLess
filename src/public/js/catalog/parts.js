// Pieces shared by the catalogue list and the product page.
//
// Everything here receives customer-safe payloads from /api/catalog: no price, no
// stock quantity, no internal id. There is nothing in this file to hide.
import { html, useState, useRef, useEffect } from '../lib/react.js';
import { setQuantity } from '../cart.js';
import { useQuantity } from './useCart.js';
import { Link } from './router.js';
import { useReveal } from '../lib/hooks.js';
import { Doodle, doodleFor } from './doodles.js';

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
  const [loaded, setLoaded] = useState(false);
  const ref = useRef(null);
  // a cached image can finish loading before React has attached onLoad
  useEffect(() => { if (ref.current?.complete && ref.current.naturalWidth) setLoaded(true); }, []);
  return html`<img ref=${ref} class=${`c-img${loaded ? ' c-img-in' : ''}`} src=${image.url} alt=${name}
    loading=${eager ? 'eager' : 'lazy'} decoding="async"
    onLoad=${() => setLoaded(true)} onError=${() => setFailedUrl(image.url)} />`;
}

/**
 * The top of a tile.
 *
 * Almost nothing in this catalogue has a photo — 8,932 of 8,933 at the time of
 * writing — so the common case is NOT a picture. A tile without one is typographic:
 * the pack size (what a customer orders in) as a small label top-left and an arrow
 * top-right, with the name set large beneath. A product that has a photo gets a pale
 * canvas with the picture matted inside it and the same arrow in its corner.
 */
function Poster({ product }) {
  if (!product.image) {
    return html`
      <div class="c-card-top">
        <${Doodle} name=${doodleFor(product)} class="c-doodle-chip" />
        <span class="c-card-pack">${product.pack || ''}</span>
        <span class="c-arrow" aria-hidden="true">↗</span>
      </div>`;
  }
  return html`
    <div class="c-poster">
      <span class="c-mark" aria-hidden="true">↗</span>
      <${ProductImage} image=${product.image} name=${product.name} />
    </div>`;
}

const MAX_CARTONS = 9999;

/**
 * − [ number ] +  : for a few cartons tap the buttons; for fifty, tap the number and
 * type it. The number commits when the field loses focus or Enter is pressed; 0 removes
 * the product from the request, and anything that is not a number puts the old value
 * back. `item` is { barcode, name, pack }.
 */
export function QtyStepper({ item, qty }) {
  const [draft, setDraft] = useState(null);   // null = show the real quantity
  const set = (n) => setQuantity(item, Math.min(MAX_CARTONS, Math.max(0, n)));
  const commit = () => {
    if (draft === null) return;
    const n = parseInt(draft, 10);
    setDraft(null);
    if (Number.isFinite(n)) set(n);
  };
  return html`
    <div class="c-stepper">
      <button type="button" class="c-step" aria-label="Fewer cartons" data-sign="−" onClick=${() => set(qty - 1)}>−</button>
      <label class="c-qty">
        <input class="c-qty-input" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
          aria-label=${`Cartons of ${item.name || item.barcode}`}
          value=${draft ?? String(qty)}
          onFocus=${(e) => e.target.select()}
          onChange=${(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
          onBlur=${commit}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } }} />
        <span>CTN</span>
      </label>
      <button type="button" class="c-step" aria-label="More cartons" data-sign="+" onClick=${() => set(qty + 1)}>+</button>
    </div>`;
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
    // the pack size is already on the card (the poster, or its caption), so the button need not repeat it
    return html`<button class="c-add" type="button" onClick=${() => set(qty + 1)}>Add to request</button>`;
  }
  return html`<${QtyStepper} item=${{ barcode: product.id, name: product.name, pack: product.pack }} qty=${qty} />`;
}

export function ProductCard({ product }) {
  const [ref, reveal] = useReveal();
  return html`
    <div ref=${ref} class=${`c-card ${reveal}`}>
      <${Link} class="c-card-link" href=${`/catalog/product/${encodeURIComponent(product.id)}`}>
        <${Poster} product=${product} />
        <div class="c-card-body">
          <div class="c-name">${product.name}</div>
          ${product.pack && product.image ? html`<div class="c-pack">${product.pack}</div>` : null}
          ${product.category ? html`<div class="c-cat">${product.category.name}</div>` : null}
          <${Pill} availability=${product.availability} />
        </div>
      <//>
      <div class="c-card-actions"><${RequestControl} product=${product} /></div>
    </div>`;
}
