// The sales rep's "New order" screens: pick one of your customers, add products and cartons, review, place.
//
// The order is the customer's own order, placed by the rep: the server runs the same checks (stock, the customer's
// minimum shelf life, credit, discounted offers) and sends the same draft quotation to Odoo. A person approves it
// there. Which customers a rep may order for is decided on the server; this page only shows what it is given.
//
// Nothing someone is typing into is ever rebuilt: the customer search, the product search, each product's carton box
// (until the next search), the notes and the address are made once. Only the lists around them are replaced.
import { h, setChildren } from './lib/dom.js';
import { debounce, createLatest } from './lib/util.js';

const money = (n) => (n === null || n === undefined ? '—' : `GHS ${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const dateText = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const PAGE = 30;

/** Call the API and keep the body whatever the status: a refused order explains itself in the body. */
async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.location.assign('/');
  return { ok: res.ok, status: res.status, data };
}
const messageOf = (data, fallback = 'Something went wrong. Please try again.') => (data.errors && data.errors.length ? data.errors.map((e) => e.message).join(' ') : data.error || fallback);

/**
 * @param {{ onBack: () => void }} options  onBack goes back to the visits screen
 * @returns {{ el: HTMLElement, open: () => void }}
 */
export function createOrderView({ onBack }) {
  const state = { customer: null, cart: new Map(), search: '', offset: 0, items: [], total: 0, review: null };
  const latestCustomers = createLatest();
  const latestProducts = createLatest();

  // ---- pieces built once ----------------------------------------------------------------------------
  const customerSearch = h('input', {
    type: 'search', class: 'rep-search', placeholder: 'Find a customer by name or Odoo ID', 'aria-label': 'Find a customer',
    inputmode: 'search', autocomplete: 'off', onInput: debounce(() => loadCustomers(customerSearch.value.trim()), 250),
  });
  const customerList = h('div');
  const productSearch = h('input', {
    type: 'search', class: 'rep-search', placeholder: 'Find a product', 'aria-label': 'Find a product',
    inputmode: 'search', autocomplete: 'off', onInput: debounce(() => { state.search = productSearch.value.trim(); loadProducts(true); }, 250),
  });
  const productList = h('div');
  const moreBtn = h('button', { type: 'button', class: 'rep-more hidden', onClick: () => loadProducts(false) }, 'Show more products');
  const cartBox = h('div', { class: 'card rep-cart' });
  const reviewBtn = h('button', { type: 'button', class: 'rep-save', onClick: review }, 'Review order');
  const orderError = h('div', { class: 'errbox rep-error hidden', role: 'alert' });
  const customerTitle = h('h1');
  const customerNote = h('p', { class: 'rep-note' });

  const notes = h('textarea', { id: 'repOrderNotes', rows: '3', maxlength: '2000', placeholder: 'Anything the office should know (optional)' });
  const address = h('input', { type: 'text', id: 'repOrderAddress', maxlength: '500', autocomplete: 'off', placeholder: "Leave empty to use the customer's address on file" });
  const reviewBody = h('div');
  const placeBtn = h('button', { type: 'button', class: 'rep-save', onClick: place }, 'Place order');
  const placeError = h('div', { class: 'errbox rep-error hidden', role: 'alert' });
  const accepts = new Map();   // barcode -> checkbox, rebuilt only when a review is shown

  const mineList = h('div');

  const pickView = h('section', { 'aria-label': 'Choose a customer' },
    h('h1', null, 'New order'),
    h('p', { class: 'rep-note' }, 'Choose the customer you are ordering for. You can only order for customers the Sales Manager has given you.'),
    customerSearch, customerList,
    h('button', { type: 'button', class: 'rep-link', onClick: showMine }, 'Orders I have placed'));
  const orderView = h('section', { 'aria-label': 'Order', class: 'hidden' },
    h('button', { type: 'button', class: 'rep-back', onClick: () => show(pickView) }, '← Customers'),
    customerTitle, customerNote, productSearch, productList, moreBtn, cartBox, orderError, reviewBtn);
  const reviewView = h('section', { 'aria-label': 'Review order', class: 'hidden' },
    h('button', { type: 'button', class: 'rep-back', onClick: () => show(orderView) }, '← Change the order'),
    h('h1', null, 'Review order'),
    reviewBody,
    h('div', { class: 'card rep-review-extra' },
      h('label', { for: 'repOrderAddress' }, 'Delivery address', address),
      h('label', { for: 'repOrderNotes' }, 'Notes', notes)),
    placeError, placeBtn);
  const doneView = h('section', { 'aria-label': 'Order placed', class: 'hidden' });
  const mineView = h('section', { 'aria-label': 'Orders I placed', class: 'hidden' },
    h('button', { type: 'button', class: 'rep-back', onClick: () => show(pickView) }, '← Customers'),
    h('h1', null, 'Orders I have placed'), mineList);

  const views = [pickView, orderView, reviewView, doneView, mineView];
  const el = h('div', { class: 'hidden' }, views);
  function show(view) {
    for (const v of views) v.classList.toggle('hidden', v !== view);
    window.scrollTo(0, 0);
  }

  // ---- customers --------------------------------------------------------------------------------------
  async function loadCustomers(q = '') {
    const mine = latestCustomers.next();
    const r = await call(`/api/rep-orders/customers?${new URLSearchParams({ q })}`);
    if (!latestCustomers.is(mine)) return;
    if (!r.ok) { setChildren(customerList, h('div', { class: 'errbox' }, messageOf(r.data))); return; }
    if (!r.data.customers.length) {
      setChildren(customerList, h('p', { class: 'rep-empty' }, q ? 'No customer on your list matches that.' : 'No customer has been given to you yet. Please ask your Sales Manager.'));
      return;
    }
    setChildren(customerList, r.data.customers.map((c) => h('button', { type: 'button', class: 'rep-shop', onClick: () => startOrder(c) },
      h('span', { class: 'rep-shop-name' }, c.name),
      h('span', { class: 'rep-shop-meta' }, h('span', null, c.odooId ? `Odoo ID ${c.odooId}` : 'No Odoo ID yet'), c.cash ? h('span', { class: 'pill' }, 'Cash customer') : null))));
  }

  function startOrder(customer) {
    if (!state.customer || state.customer.id !== customer.id) { state.cart = new Map(); productSearch.value = ''; state.search = ''; }
    state.customer = customer;
    customerTitle.textContent = customer.name;
    customerNote.textContent = `${customer.odooId ? `Odoo ID ${customer.odooId} · ` : ''}Prices are this customer's own, per carton.`;
    orderError.classList.add('hidden');
    renderCart();
    show(orderView);
    loadProducts(true);
  }

  // ---- products ---------------------------------------------------------------------------------------
  async function loadProducts(fresh) {
    if (!state.customer) return;
    const mine = latestProducts.next();
    const offset = fresh ? 0 : state.offset;
    const r = await call(`/api/rep-orders/products?${new URLSearchParams({ customer: state.customer.id, search: state.search, limit: PAGE, offset })}`);
    if (!latestProducts.is(mine)) return;
    if (!r.ok) { setChildren(productList, h('div', { class: 'errbox' }, messageOf(r.data))); moreBtn.classList.add('hidden'); return; }
    state.items = fresh ? r.data.items : state.items.concat(r.data.items);
    state.offset = state.items.length;
    state.total = r.data.total;
    state.sample = r.data.source === 'SAMPLE';
    renderProducts();
  }

  function renderProducts() {
    if (!state.items.length) { setChildren(productList, h('p', { class: 'rep-empty' }, 'No product matches that.')); moreBtn.classList.add('hidden'); return; }
    setChildren(productList,
      state.sample ? h('p', { class: 'rep-note' }, 'Sample prices until Odoo is connected.') : null,
      state.items.map(productRow));
    moreBtn.classList.toggle('hidden', state.items.length >= state.total);
  }

  function productRow(p) {
    const inCart = state.cart.get(p.barcode);
    const qty = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '9999', step: '1', 'aria-label': `Cartons of ${p.name}`, value: String(inCart ? inCart.qty : 1) });
    const add = h('button', { type: 'button', class: 'rep-add', onClick: () => {
      const n = Math.floor(Number(qty.value));
      if (!Number.isFinite(n) || n < 1) { qty.focus(); return; }
      state.cart.set(p.barcode, { barcode: p.barcode, name: p.name, qty: n, price: p.price, offer: p.offer });
      add.textContent = 'Update';
      orderError.classList.add('hidden');
      renderCart();
    } }, inCart ? 'Update' : 'Add');
    const facts = [
      p.pack ? h('span', null, p.pack) : null,
      h('span', { class: `pill${p.requestable ? '' : ' err'}` }, p.requestable ? p.availability.label : 'Out of stock'),
    ];
    return h('article', { class: 'card rep-product' },
      h('div', { class: 'rep-lot-name' }, p.name),
      h('div', { class: 'rep-lot-facts' }, facts),
      h('div', { class: 'rep-price' }, p.price === null ? 'No price yet' : `${money(p.price)} per carton`),
      p.offer ? h('div', { class: 'rep-offer' }, h('b', null, `${p.offer.discountPct}% off`), ` up to ${plural(p.offer.maxCartons, 'carton')} at ${money(p.offer.discountedPrice)} (best before ${dateText(p.offer.bestBefore)}). Not returnable.`) : null,
      p.requestable ? h('div', { class: 'rep-qty' }, h('label', null, 'Cartons', qty), add) : null);
  }

  // ---- the order so far ---------------------------------------------------------------------------------
  function renderCart() {
    const lines = [...state.cart.values()];
    if (!lines.length) { setChildren(cartBox, h('h2', null, 'The order'), h('p', { class: 'rep-note' }, 'Nothing added yet.')); reviewBtn.disabled = true; return; }
    reviewBtn.disabled = false;
    const cartons = lines.reduce((n, l) => n + l.qty, 0);
    setChildren(cartBox,
      h('h2', null, `The order · ${plural(cartons, 'carton')}`),
      h('ul', { class: 'rep-cart-list' }, lines.map((l) => h('li', null,
        h('span', null, h('b', null, `${l.qty} × `), l.name),
        h('button', { type: 'button', class: 'rep-remove', 'aria-label': `Remove ${l.name}`, onClick: () => { state.cart.delete(l.barcode); renderCart(); renderProducts(); } }, 'Remove')))));
  }

  const payload = (extra = {}) => ({ customer: state.customer.id, lines: [...state.cart.values()].map((l) => ({ barcode: l.barcode, quantityCtn: l.qty })), ...extra });

  // ---- review -------------------------------------------------------------------------------------------
  async function review() {
    orderError.classList.add('hidden');
    reviewBtn.disabled = true;
    const r = await call('/api/rep-orders/review', { method: 'POST', body: payload() });
    reviewBtn.disabled = false;
    if (!r.ok) { orderError.textContent = messageOf(r.data); orderError.classList.remove('hidden'); return; }
    state.review = r.data;
    renderReview();
    show(reviewView);
  }

  function renderReview() {
    const rv = state.review;
    accepts.clear();
    const blockers = [];
    if (!rv.canSubmit) blockers.push('The stock list is out of date, so orders cannot be placed right now. Ask the warehouse to refresh it.');
    for (const e of rv.errors) blockers.push(e.message);
    if (rv.credit.checked && !rv.credit.ok) {
      blockers.push(`This order comes to about ${money(rv.credit.orderValue)}, which is more than the customer's available credit of ${money(rv.credit.available)}. Reduce it, or ask the Sales Manager.`);
    }
    const lines = [...state.cart.values()];
    const warned = new Map(rv.shelf.warnings.map((w) => [w.barcode, w]));
    setChildren(reviewBody,
      h('div', { class: 'card' },
        h('h2', null, rv.customer.name),
        h('ul', { class: 'rep-cart-list' }, lines.map((l) => h('li', null, h('span', null, h('b', null, `${l.qty} × `), l.name),
          l.price === null ? null : h('span', { class: 'rep-note' }, money(l.price * l.qty))))),
        rv.estimate === null
          ? h('p', { class: 'rep-note' }, 'No price list for this customer yet, so there is no estimate. Odoo works out the price.')
          : h('p', null, h('b', null, `About ${money(rv.estimate)}`), h('span', { class: 'rep-note' }, ' at this customer\'s prices, with any near-expiry discount. Odoo works out the final price; a person approves the order there.'))),
      blockers.length ? h('div', { class: 'errbox' }, blockers.map((b) => h('p', null, b))) : null,
      rv.shelf.warnings.length ? h('div', { class: 'card' },
        h('h2', null, 'Shorter shelf life than this customer asked for'),
        rv.shelf.warnings.map((w) => {
          const box = h('input', { type: 'checkbox', id: `acc-${w.barcode}`, onChange: syncPlace });
          accepts.set(w.barcode, box);
          const name = lines.find((l) => l.barcode === w.barcode)?.name || w.barcode;
          return h('label', { class: 'rep-confirm', for: `acc-${w.barcode}` }, box, h('span', null, h('b', null, name), h('br'), `${w.message}. The customer agrees to take it.`));
        })) : null);
    placeError.classList.add('hidden');
    placeBtn.dataset.blocked = blockers.length ? '1' : '';
    syncPlace();
  }

  function syncPlace() {
    const allAccepted = [...accepts.values()].every((b) => b.checked);
    placeBtn.disabled = Boolean(placeBtn.dataset.blocked) || !allAccepted;
  }

  // ---- place --------------------------------------------------------------------------------------------
  async function place() {
    placeError.classList.add('hidden');
    placeBtn.disabled = true;
    placeBtn.textContent = 'Placing…';
    const r = await call('/api/rep-orders', { method: 'POST', body: payload({
      acceptedShortDated: [...accepts.entries()].filter(([, b]) => b.checked).map(([k]) => k),
      deliveryAddress: address.value.trim(), notes: notes.value.trim(),
    }) });
    placeBtn.textContent = 'Place order';
    if (!r.ok) {
      placeError.textContent = messageOf(r.data);
      placeError.classList.remove('hidden');
      syncPlace();
      return;
    }
    const name = state.customer.name;
    state.cart = new Map();
    notes.value = '';
    address.value = '';
    setChildren(doneView,
      h('div', { class: 'card rep-done' },
        h('h1', null, 'Order placed'),
        h('p', null, `${plural(r.data.items, 'product')} ordered for ${name}.`),
        h('p', null, h('b', null, r.data.reference)),
        h('p', { class: 'rep-note' }, 'A draft quotation is on its way to Odoo, where a person approves it. The customer can follow it in their own account.'),
        h('button', { type: 'button', class: 'rep-save', onClick: () => { show(pickView); loadCustomers(customerSearch.value.trim()); } }, 'Another order'),
        h('button', { type: 'button', class: 'rep-link', onClick: onBack }, 'Back to my visits')));
    show(doneView);
  }

  // ---- the orders this rep placed -------------------------------------------------------------------------
  async function showMine() {
    show(mineView);
    setChildren(mineList, h('p', { class: 'rep-note' }, 'Loading…'));
    const r = await call('/api/rep-orders/mine');
    if (!r.ok) { setChildren(mineList, h('div', { class: 'errbox' }, messageOf(r.data))); return; }
    setChildren(mineList, r.data.orders.length
      ? r.data.orders.map((o) => h('article', { class: 'card rep-product' },
        h('div', { class: 'rep-lot-name' }, o.customer),
        h('div', { class: 'rep-lot-facts' }, h('span', null, o.reference), o.odooNumber ? h('span', null, `Odoo ${o.odooNumber}`) : null, h('span', null, plural(o.cartons, 'carton'))),
        h('span', { class: 'pill' }, o.status)))
      : h('p', { class: 'rep-empty' }, 'You have not placed an order yet.'));
  }

  return {
    el,
    open() {
      el.classList.remove('hidden');
      show(state.customer && state.cart.size ? orderView : pickView);
      loadCustomers(customerSearch.value.trim());
    },
    close() { el.classList.add('hidden'); },
  };
}
