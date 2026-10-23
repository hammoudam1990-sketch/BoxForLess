// Pieces shared by the catalogue list and the product page.
//
// Everything here receives customer-safe payloads from /api/catalog: no price, no stock
// quantity, no internal id. A price is added only by prices.js, from /api/catalog/prices,
// and only for a signed-in customer.
import { h } from '../lib/dom.js';
import { reveal } from '../lib/util.js';
import { doodle, doodleFor } from './doodles.js';
import { bindRequestControl } from './qty.js';
import { onPrices, priceOf, wantPrice, formatPrice, offerOf } from './prices.js';

const NO_IMAGE_TEXT = 'No product image available';

/** The three customer availability states. Never a quantity. */
export function availabilityPill(availability) {
  if (!availability) return null;
  return h('span', { class: `c-pill ${availability.tone}` }, availability.label);
}

/** A product photo that fades in once loaded and falls back to a note if it cannot load. */
export function productImage(image, name, { eager = false } = {}) {
  const img = h('img', {
    class: 'c-img', src: image.url, alt: name, decoding: 'async', loading: eager ? 'eager' : 'lazy',
  });
  img.addEventListener('load', () => img.classList.add('c-img-in'));
  img.addEventListener('error', () => img.replaceWith(h('div', { class: 'c-noimg' }, NO_IMAGE_TEXT)));
  // a cached image can finish loading before the listener is attached
  if (img.complete && img.naturalWidth) img.classList.add('c-img-in');
  return img;
}

/**
 * The top of a tile.
 *
 * Almost nothing in this catalogue has a photo — 8,932 of 8,933 at the time of writing —
 * so the common case is NOT a picture. A tile without one shows a small drawing of what
 * KIND of thing it is (a sack, a bottle, a jar…), the pack size and an arrow. A product
 * that has a photo gets a pale canvas with the picture matted inside it.
 */
function tileTop(product) {
  if (!product.image) {
    return h('div', { class: 'c-card-top' },
      doodle(doodleFor(product), { className: 'c-doodle-chip' }),
      h('span', { class: 'c-card-pack' }, product.pack || ''),
      h('span', { class: 'c-arrow', 'aria-hidden': 'true' }, '↗'));
  }
  return h('div', { class: 'c-poster' },
    h('span', { class: 'c-mark', 'aria-hidden': 'true' }, '↗'),
    productImage(product.image, product.name));
}

/**
 * "GHS 55.86 / carton" for the signed-in customer; an empty element (nothing at all) for anyone
 * else. Built once and updated in place when the session or the prices change.
 */
export function createPriceLine(barcode, scope) {
  const el = h('div', { class: 'c-price hidden' });
  const paint = () => {
    const p = priceOf(barcode);
    el.textContent = p === null ? '' : `${formatPrice(p)} / carton`;
    el.classList.toggle('hidden', p === null);
  };
  scope.add(onPrices(paint));
  paint();
  wantPrice(barcode);
  return el;
}

/**
 * The discounted near-expiry offer on a product, for the signed-in customer; nothing at all for anyone else or
 * when there is none. "20% off, best before 12 Nov 2026, GHS 76.80 per carton, up to 14 cartons".
 */
export function createOfferLine(barcode, scope) {
  const el = h('div', { class: 'c-offer hidden' });
  const paint = () => {
    const o = offerOf(barcode);
    el.classList.toggle('hidden', !o);
    if (!o) { el.replaceChildren(); return; }
    el.replaceChildren(
      h('span', { class: 'c-offer-badge' }, `${o.discountPct}% off`),
      h('span', { class: 'c-offer-text' },
        ` Best before ${o.bestBefore}`,
        o.discountedPrice !== null ? [' · ', h('b', null, formatPrice(o.discountedPrice)), ' / carton ', h('s', { class: 'c-offer-was' }, formatPrice(o.price))] : null,
        `, up to ${o.maxCartons} carton${o.maxCartons === 1 ? '' : 's'} at this price. Not returnable.`));
  };
  scope.add(onPrices(paint));
  paint();
  return el;
}

/** One product tile. `scope` collects its cart subscription. */
export function createProductCard(product, scope) {
  const actions = h('div', { class: 'c-card-actions' });
  bindRequestControl(actions, product, scope);

  const card = h('div', { class: 'c-card' },
    h('a', { class: 'c-card-link', href: `/catalog/product/${encodeURIComponent(product.id)}` },
      tileTop(product),
      h('div', { class: 'c-card-body' },
        h('div', { class: 'c-name' }, product.name),
        product.pack && product.image ? h('div', { class: 'c-pack' }, product.pack) : null,
        product.category ? h('div', { class: 'c-cat' }, product.category.name) : null,
        availabilityPill(product.availability),
        createPriceLine(product.id, scope),
        createOfferLine(product.id, scope))),
    actions);
  reveal(card);
  return card;
}
