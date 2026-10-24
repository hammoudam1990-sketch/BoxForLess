// Pieces shared by the catalogue list and the product page.
//
// Everything here receives customer-safe payloads from /api/catalog: no stock quantity, no
// internal id. A price and a discounted offer are added only by prices.js, from the server, and
// only for a signed-in, approved customer; for anyone else those lines are simply not there.
import { h } from '../lib/dom.js';
import { reveal } from '../lib/util.js';
import { doodle, doodleFor } from './doodles.js';
import { bindCartControl } from './qty.js';
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
 * "GHS 55.86 / carton" for the signed-in customer, from their own price class; an empty element
 * (nothing at all) for anyone else. Built once and updated in place when the session or the prices change.
 */
export function createPriceLine(barcode, scope) {
  const el = h('div', { class: 'p-price hidden' });
  const paint = () => {
    const price = priceOf(barcode);
    el.replaceChildren(...(price === null ? [] : [h('b', {}, formatPrice(price)), h('span', {}, ' / carton')]));
    el.classList.toggle('hidden', price === null);
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

/**
 * One product tile, after the Oct 2026 customer mockup: a picture (or the drawing of what kind
 * of thing it is), the stock pill, name, category, price per carton, any discounted offer, and the
 * cart control. `scope` collects its cart and price subscriptions.
 */
export function createProductCard(product, scope) {
  const actions = h('div', { class: 'p-card-actions' });
  bindCartControl(actions, product, scope);
  const href = `/catalog/product/${encodeURIComponent(product.id)}`;

  const card = h('div', { class: 'p-card' },
    h('a', { class: 'p-card-link', href },
      h('div', { class: 'p-card-pic' },
        product.image ? productImage(product.image, product.name)
          : doodle(doodleFor(product), { size: 'lg', className: 'p-card-doodle' }),
        product.pack ? h('span', { class: 'p-card-pack' }, product.pack) : null),
      h('div', { class: 'p-card-body' },
        availabilityPill(product.availability),
        h('div', { class: 'p-card-name' }, product.name),
        product.category ? h('div', { class: 'p-card-cat' }, product.category.name) : null,
        createPriceLine(product.id, scope),
        createOfferLine(product.id, scope))),
    actions);
  reveal(card);
  return card;
}
