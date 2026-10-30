// Pieces shared by the catalogue list and the product page.
//
// Everything here receives customer-safe payloads from /api/catalog: no stock quantity, no
// internal id. A price and a discounted offer are added only by prices.js, from the server, and
// only for a signed-in, approved customer; for anyone else those lines are simply not there.
import { h } from '../lib/dom.js';
import { reveal } from '../lib/util.js';
import { doodle, doodleFor } from './doodles.js';
import { bindCartControl } from './qty.js';
import { onPrices, priceOf, wantPrice, formatPrice, offerOf, limitOf } from './prices.js';

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
 * When the product has an active discount offer, shows the discounted price alongside the crossed-out original price.
 */
export function createPriceLine(barcode, scope) {
  const el = h('div', { class: 'p-price hidden' });
  const paint = () => {
    const o = offerOf(barcode);
    const price = priceOf(barcode) ?? (o ? o.price : null);
    if (price === null && (!o || o.discountedPrice === null)) {
      el.replaceChildren();
      el.classList.add('hidden');
      return;
    }
    if (o && o.discountedPrice !== null) {
      el.replaceChildren(
        h('b', { style: { color: '#b42318' } }, formatPrice(o.discountedPrice)),
        h('span', {}, ' / carton '),
        price !== null ? h('s', { class: 'c-offer-was', style: { marginLeft: '4px', opacity: '0.65', fontSize: '0.9em' } }, formatPrice(price)) : null,
      );
    } else {
      el.replaceChildren(h('b', {}, formatPrice(price)), h('span', {}, ' / carton'));
    }
    el.classList.remove('hidden');
  };
  scope.add(onPrices(paint));
  paint();
  wantPrice(barcode);
  return el;
}

/**
 * Prominent discount badge overlaid on the product picture when an offer is active.
 */
export function createDiscountBadge(barcode, scope) {
  const badge = h('span', {
    class: 'c-offer-badge hidden',
    style: { position: 'absolute', top: '10px', left: '10px', zIndex: '2', boxShadow: '0 2px 6px rgba(0,0,0,0.2)' },
  });
  const paint = () => {
    const o = offerOf(barcode);
    badge.classList.toggle('hidden', !o);
    badge.textContent = o ? `${o.discountPct}% OFF` : '';
  };
  scope.add(onPrices(paint));
  paint();
  return badge;
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
 * Per-product purchasing limit badge ("Limit: max 25 cartons / order") when configured.
 */
export function createLimitLine(barcode, scope) {
  const el = h('div', {
    class: 'c-limit hidden',
    style: { fontSize: '11.5px', fontWeight: '600', color: '#9a3412', background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: '6px', padding: '2px 7px', marginTop: '4px', display: 'inline-block' },
  });
  const paint = () => {
    const lim = limitOf(barcode);
    el.classList.toggle('hidden', !lim);
    el.textContent = lim ? `Order limit: max ${lim} ctn / order` : '';
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
      h('div', { class: 'p-card-pic', style: { position: 'relative' } },
        createDiscountBadge(product.id, scope),
        product.image ? productImage(product.image, product.name)
          : doodle(doodleFor(product), { size: 'lg', className: 'p-card-doodle' }),
        product.pack ? h('span', { class: 'p-card-pack' }, product.pack) : null),
      h('div', { class: 'p-card-body' },
        availabilityPill(product.availability),
        h('div', { class: 'p-card-name' }, product.name),
        product.category ? h('div', { class: 'p-card-cat' }, product.category.name) : null,
        createPriceLine(product.id, scope),
        createLimitLine(product.id, scope),
        createOfferLine(product.id, scope))),
    actions);
  reveal(card);
  return card;
}
