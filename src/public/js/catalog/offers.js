// "Discounted — near expiry": the offers the Sales Manager has put on lots close to their expiry date.
//
// Shown only to a signed-in, approved customer (the server answers 401 otherwise, like a price). Each offer is a
// product the customer can add to their request as usual; the cartons that come from the offer carry the discount
// and the quotation names the lot. Nothing here is typed into, so the section is simply rebuilt when the offers change.
import { h } from '../lib/dom.js';
import { onPrices, offerList, refreshOffers, formatPrice } from './prices.js';
import { bindRequestControl } from './qty.js';

/** The section for the top of the catalogue list. `scope` collects its subscriptions. */
export function createOffersSection(scope) {
  const el = h('section', { class: 'c-offers hidden', 'aria-labelledby': 'offersTitle' });
  let subs = new Set();   // the cards' cart subscriptions, released whenever the section is rebuilt

  const release = () => { subs.forEach((fn) => fn()); subs = new Set(); };

  const paint = () => {
    const offers = offerList().sort((a, b) => a.daysLeft - b.daysLeft);
    el.classList.toggle('hidden', offers.length === 0);
    release();
    if (!offers.length) { el.replaceChildren(); return; }
    const cardScope = { add: (fn) => { subs.add(fn); return fn; } };
    el.replaceChildren(
      h('h2', { id: 'offersTitle', class: 'c-offers-title' }, 'Discounted — near expiry'),
      h('p', { class: 'c-offers-note' }, 'Good stock with a shorter date, at a lower price. The discount applies to the cartons shown, and discounted cartons cannot be returned. Odoo confirms the final price on your order.'),
      h('div', { class: 'c-offers-grid' }, offers.map((o) => offerCard(o, cardScope))));
  };

  scope.add(onPrices(paint));
  scope.add(release);
  refreshOffers();
  paint();
  return el;
}

function offerCard(o, cardScope) {
  const actions = h('div', { class: 'c-card-actions' });
  bindRequestControl(actions, { id: o.barcode, name: o.name, pack: '', requestable: true }, cardScope);
  return h('div', { class: 'c-offer-card' },
    h('span', { class: 'c-offer-badge' }, `${o.discountPct}% off`),
    h('a', { class: 'c-offer-name', href: `/catalog/product/${encodeURIComponent(o.barcode)}` }, o.name),
    h('div', { class: 'c-offer-when' }, `Best before ${o.bestBefore} · ${o.daysLeft} day${o.daysLeft === 1 ? '' : 's'} left`),
    o.discountedPrice !== null
      ? h('div', { class: 'c-offer-price' }, h('b', null, formatPrice(o.discountedPrice)), ' / carton ', h('s', { class: 'c-offer-was' }, formatPrice(o.price)))
      : null,
    h('div', { class: 'c-offer-limit' }, `Up to ${o.maxCartons} carton${o.maxCartons === 1 ? '' : 's'} at this price`),
    h('div', { class: 'c-offer-noreturn' }, 'Not returnable'),
    actions);
}
