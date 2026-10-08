// The carton quantity control: − [ number ] +, and the add button that becomes it.
//
// For a few cartons tap the buttons; for fifty, tap the number and type it. The number
// commits when the field loses focus or Enter is pressed; 0 removes the product from the
// request, and anything that is not a number puts the old value back.
import { h, setChildren } from '../lib/dom.js';
import { setQuantity, quantityOf, onCartChange } from '../cart.js';

const MAX_CARTONS = 9999;

/** `item` is { barcode, name, pack }. Returns { el, update(qty) }. */
export function createQtyStepper(item) {
  let qty = 0;
  const set = (n) => setQuantity(item, Math.min(MAX_CARTONS, Math.max(0, n)));

  const input = h('input', {
    class: 'c-qty-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off',
    'aria-label': `Cartons of ${item.name || item.barcode}`,
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
      if (digits !== e.target.value) e.target.value = digits;
    },
    onBlur: () => {
      const n = parseInt(input.value, 10);
      if (Number.isFinite(n)) { if (n !== qty) set(n); else input.value = String(qty); }
      else input.value = String(qty);   // not a number: put the old value back
    },
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } },
  });

  const el = h('div', { class: 'c-stepper' },
    h('button', { type: 'button', class: 'c-step', 'aria-label': 'Fewer cartons', 'data-sign': '−', onClick: () => set(qty - 1) }, '−'),
    h('label', { class: 'c-qty' }, input, h('span', {}, 'CTN')),
    h('button', { type: 'button', class: 'c-step', 'aria-label': 'More cartons', 'data-sign': '+', onClick: () => set(qty + 1) }, '+'));

  return {
    el,
    /** Show a new quantity (leaves the field alone while someone is typing in it). */
    update(next) {
      qty = next;
      if (document.activeElement !== input) input.value = String(next);
    },
  };
}

/**
 * Fill `host` with the add-to-request control for `product` and keep it in step with the
 * cart: an "Add to request" button at zero, the stepper from one carton up. A product
 * holding less than one whole carton is not requestable even while it still reads Limited
 * Stock, so it gets a plain note instead — better than a control whose every use would fail.
 * `scope` collects the cart subscription so it is released with the view.
 */
export function bindRequestControl(host, product, scope) {
  if (!product.requestable) {
    setChildren(host, h('div', { class: 'c-noreq' }, 'Not available to request right now'));
    return;
  }
  const item = { barcode: product.id, name: product.name, pack: product.pack };
  let stepper = null;
  let addButton = null;

  const sync = () => {
    const qty = quantityOf(item.barcode);
    if (qty < 1) {
      if (addButton) return;
      stepper = null;
      addButton = h('button', { class: 'c-add', type: 'button', onClick: () => setQuantity(item, 1) }, 'Add to request');
      setChildren(host, addButton);
      return;
    }
    if (!stepper) {
      addButton = null;
      stepper = createQtyStepper(item);
      setChildren(host, stepper.el);
    }
    stepper.update(qty);
  };

  sync();
  scope.add(onCartChange(sync));
}
