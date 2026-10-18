// Pieces shared by the catalogue list and the product page.
//
// Everything here receives customer-safe payloads from /api/catalog: no price, no stock
// quantity, no internal id. There is nothing in this file to hide.
import { h } from '../lib/dom.js';
import { reveal } from '../lib/util.js';
import { doodle, doodleFor } from './doodles.js';
import { bindCartControl } from './qty.js';
import { samplePrice, formatGhs } from './sample-data.js';

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

/** The price line: "GH₵ 120.00 / carton" for a signed-in customer (sample until Phase 3), else nothing. */
export function priceLine(product) {
  const price = samplePrice(product);
  return price === null ? null
    : h('div', { class: 'p-price' }, h('b', {}, formatGhs(price)), h('span', {}, ' / carton'));
}

/**
 * One product tile, after the Oct 2026 customer mockup: a picture (or the drawing of what kind
 * of thing it is), the stock pill, name, category, price per carton, and the cart control.
 * `scope` collects its cart subscription.
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
        priceLine(product))),
    actions);
  reveal(card);
  return card;
}
