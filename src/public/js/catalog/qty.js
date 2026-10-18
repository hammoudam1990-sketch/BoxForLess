// The carton quantity control: − [ number ] +, and the add button that becomes it.
//
// For a few cartons tap the buttons; for fifty, tap the number and type it. The number
// commits when the field loses focus or Enter is pressed; 0 removes the product from the
// request, and anything that is not a number puts the old value back.
import { h, setChildren } from '../lib/dom.js';
import { setQuantity, quantityOf, onCartChange, addToCart } from '../cart.js';
import { REQUEST_LABELS } from './labels.js';

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
  const control = h('div', { class: 'c-request-control' });
  const feedback = h('span', { class: 'c-added-feedback', 'aria-live': 'polite' });
  setChildren(host, control, feedback);
  let stepper = null;
  let addButton = null;
  let feedbackTimer = null;

  const sync = () => {
    const qty = quantityOf(item.barcode);
    if (qty < 1) {
      if (addButton) return;
      stepper = null;
      addButton = h('button', {
        class: 'c-add', type: 'button',
        onClick: () => {
          feedback.textContent = REQUEST_LABELS.added;
          if (feedbackTimer !== null) window.clearTimeout(feedbackTimer);
          feedbackTimer = window.setTimeout(() => {
            feedback.textContent = '';
            feedbackTimer = null;
          }, 1200);
          setQuantity(item, 1);
        },
      }, REQUEST_LABELS.action);
      setChildren(control, addButton);
      return;
    }
    if (!stepper) {
      addButton = null;
      stepper = createQtyStepper(item);
      setChildren(control, stepper.el);
    }
    stepper.update(qty);
  };

  sync();
  scope.add(onCartChange(sync));
  scope.add(() => { if (feedbackTimer !== null) window.clearTimeout(feedbackTimer); });
}

/**
 * The product-card control from the Oct 2026 mockup: choose a number of cartons with
 * − [ 1 ] +, then "Add to Cart" adds that many. Below it, how many are already in the cart.
 * The picker is local to the card; the cart itself is edited in the cart drawer.
 */
export function bindCartControl(host, product, scope) {
  if (!product.requestable) {
    setChildren(host, h('div', { class: 'c-noreq' }, 'Not available to order right now'));
    return;
  }
  const item = { barcode: product.id, name: product.name, pack: product.pack };
  let pick = 1;
  const input = h('input', {
    class: 'p-pick-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', value: '1',
    'aria-label': `Cartons of ${product.name} to add`,
    onFocus: (e) => e.target.select(),
    onInput: (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
      if (digits !== e.target.value) e.target.value = digits;
    },
    onBlur: () => setPick(parseInt(input.value, 10)),
    onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); add(); } },
  });
  function setPick(n) {
    pick = Number.isFinite(n) ? Math.min(MAX_CARTONS, Math.max(1, n)) : pick;
    if (document.activeElement !== input) input.value = String(pick);
  }
  const inCart = h('span', { class: 'p-in-cart', 'aria-live': 'polite' });
  const button = h('button', { type: 'button', class: 'p-add', onClick: () => add() },
    h('span', { class: 'p-add-icon', 'aria-hidden': 'true' }), REQUEST_LABELS.action);
  let resetTimer = null;
  function add() {
    setPick(parseInt(input.value, 10));
    addToCart(item, pick);
    button.classList.add('p-added');
    button.lastChild.textContent = `${REQUEST_LABELS.added} ✓`;
    if (resetTimer !== null) window.clearTimeout(resetTimer);
    resetTimer = window.setTimeout(() => {
      button.classList.remove('p-added');
      button.lastChild.textContent = REQUEST_LABELS.action;
      resetTimer = null;
    }, 1200);
    setPick(1);
  }
  setChildren(host,
    h('div', { class: 'p-pick' },
      h('button', { type: 'button', class: 'p-pick-step', 'aria-label': 'One carton fewer', onClick: () => setPick(pick - 1) }, '−'),
      input,
      h('button', { type: 'button', class: 'p-pick-step', 'aria-label': 'One carton more', onClick: () => setPick(pick + 1) }, '+')),
    button,
    inCart);
  const sync = () => {
    const q = quantityOf(item.barcode);
    inCart.textContent = q ? `${q} in cart` : '';
  };
  sync();
  scope.add(onCartChange(sync));
  scope.add(() => { if (resetTimer !== null) window.clearTimeout(resetTimer); });
}
