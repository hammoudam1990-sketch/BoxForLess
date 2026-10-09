// One product: /catalog/product/:id
//
// Everything here comes from /api/catalog, whose payloads are customer-safe: no price, no
// stock quantity, no internal id.
import { h, setChildren } from '../lib/dom.js';
import { createScope } from '../lib/util.js';
import { getJSON } from './http.js';
import { availabilityPill, productImage } from './cards.js';
import { bindRequestControl } from './qty.js';
import { doodle, doodleFor } from './doodles.js';

const backLink = () => h('a', { class: 'c-back', href: '/catalog' }, '← Back to Catalog');

/** Build the product page for `id` into `container`. Returns { destroy }. */
export function mountDetail(container, id) {
  const scope = createScope();
  let alive = true;
  scope.add(() => { alive = false; });

  setChildren(container, h('div', { class: 'c-detail', role: 'status', 'aria-label': 'Loading' },
    h('div', { class: 'sk-block', style: { height: '180px', marginBottom: '18px' } }),
    h('div', { class: 'sk-lines' }, h('i'), h('i'), h('i'), h('i'))));

  getJSON(`/api/catalog/products/${encodeURIComponent(id)}`).then((p) => {
    if (!alive) return;
    document.title = `${p.name} — Box for Less`;
    setChildren(container, backLink(), render(p, scope));
  }, (e) => {
    if (!alive) return;
    setChildren(container, backLink(), h('div', { class: 'c-error', style: { marginTop: '12px' } },
      e.status === 404 ? 'This product is not available in the catalog.' : `Could not load this product: ${e.message}`));
  });

  return { destroy: () => scope.dispose() };
}

function fact(label, ...value) {
  return h('div', {}, h('div', { class: 'c-fact-k' }, label), ...value);
}

function render(p, scope) {
  const actions = h('div', { class: 'c-detail-actions' });
  bindRequestControl(actions, p, scope);

  // No image: the picture column is left out entirely rather than shown as a large empty box
  // beside the facts. Almost nothing has a photo, and half a blank screen reads as a broken page.
  return h('div', { class: 'c-detail' },
    h('div', { class: `c-detail-grid${p.image ? '' : ' c-detail-grid-noimg'}` },
      p.image ? h('div', { class: 'c-hero' },
        h('span', { class: 'c-mark', 'aria-hidden': 'true' }, '↗'),
        productImage(p.image, p.name, { eager: true })) : null,
      h('div', {},
        p.image ? null : h('div', { class: 'c-doodle-hero' }, doodle(doodleFor(p), { size: 'lg' })),
        h('h1', {}, p.name),
        h('div', { class: 'c-facts' },
          fact('Barcode', h('div', { class: 'c-fact-v' }, p.barcode)),
          p.pack ? fact('Pack / UoM', h('div', { class: 'c-fact-v' }, p.pack)) : null,
          p.category ? fact('Category',
            h('div', { class: 'c-fact-v' }, p.category.name),
            h('div', { class: 'c-pack', style: { marginTop: '2px' } }, p.category.path)) : null,
          fact('Availability', h('div', {}, availabilityPill(p.availability)))),
        actions,
        h('a', { class: 'c-btn', href: '/catalog', style: { display: 'inline-block', textDecoration: 'none', marginTop: '14px' } },
          'Back to Catalog'))));
}
