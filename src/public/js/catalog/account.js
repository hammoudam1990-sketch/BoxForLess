// "My orders" and "My balance" for a signed-in customer.
//
// Everything shown here is read from the server for the signed-in customer only; the browser never
// names a customer. The figures are Odoo's — where each order stands, and what the customer owes —
// and nothing is added up or worked out here. While Odoo is not connected the server marks them
// SAMPLE, and this screen says so.
//
// The drawer has no field anyone types into, so it is simply rebuilt when its data changes.
import { h, setChildren, toggleHidden } from '../lib/dom.js';
import { getJSON } from './http.js';
import { priceSession, onPrices, formatPrice } from './prices.js';

const POLL_MS = 15000;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** The six stages as a row of dots, filled up to the current one. */
function steps(order) {
  if (order.status === 'CANCELLED') return null;
  return h('div', { class: 'c-steps', role: 'img', 'aria-label': `Step ${order.step} of ${order.steps}: ${order.statusLabel}` },
    Array.from({ length: order.steps }, (_, i) => h('span', { class: `c-step-dot${i < order.step ? ' on' : ''}` })));
}

function orderCard(o) {
  return h('article', { class: 'c-order' },
    h('div', { class: 'c-order-top' },
      h('div', {},
        h('div', { class: 'c-order-num' }, o.odooNumber || o.reference),
        o.odooNumber ? h('div', { class: 'c-pack' }, `Your reference ${o.reference}`) : null),
      h('span', { class: `c-pill c-state-${o.status.toLowerCase()}` }, o.statusLabel)),
    steps(o),
    h('p', { class: 'c-order-hint' }, o.hint),
    h('ul', { class: 'c-order-items' }, o.items.map((i) => h('li', {}, `${i.cartons} × ${i.name}`))),
    h('div', { class: 'c-pack' }, `Placed ${when(o.placedAt)}`),
    o.total === null ? null : h('div', { class: 'c-order-total' }, `Invoiced ${formatPrice(o.total)}`));
}

function figure(label, value, tone = '') {
  return h('div', { class: `c-fig${tone ? ` ${tone}` : ''}` }, h('div', { class: 'c-fact-k' }, label), h('div', { class: 'c-fig-v' }, value));
}

function balanceView(a) {
  if (a.type === 'CASH') return [h('p', { class: 'c-order-hint' }, a.note)];
  const money = (n) => (n === null || n === undefined ? '—' : formatPrice(n));
  const open = a.invoices.filter((i) => i.status === 'OPEN');
  return [
    h('div', { class: 'c-figs' },
      figure('Amount owed', money(a.amountOwed)),
      figure('Overdue', money(a.overdue), a.overdue > 0 ? 'bad' : ''),
      figure('Credit limit', money(a.creditLimit)),
      figure('Available credit', money(a.availableCredit), a.availableCredit !== null && a.availableCredit <= 0 ? 'bad' : '')),
    h('p', { class: 'c-pack' }, `Figures from our sales system${a.source === 'SAMPLE' ? ' — sample figures, not real' : ''}. Available credit is your limit, less what you owe, less ${money(a.openOrders)} in orders not yet invoiced.`),
    h('h3', { class: 'c-sub' }, 'Open invoices'),
    a.paymentSchedule && !/due date/i.test(a.paymentSchedule) ? h('p', { class: 'c-pack' }, `Your payment day: ${a.paymentSchedule.toLowerCase()}.`) : null,
    open.length
      ? h('ul', { class: 'c-inv' }, open.map((i) => h('li', {},
        h('div', {}, h('b', {}, i.number), i.orderNumber ? h('span', { class: 'c-pack' }, ` · order ${i.orderNumber}`) : null),
        h('div', {}, `${formatPrice(i.amountDue)} — pay by ${day(i.payBy || i.dueDate)}`))))
      : h('p', { class: 'c-order-hint' }, 'Nothing is owed.'),
    a.payments.length ? h('h3', { class: 'c-sub' }, 'Recent payments') : null,
    a.payments.length
      ? h('ul', { class: 'c-inv' }, a.payments.map((p) => h('li', {}, h('div', {}, `${formatPrice(p.amount)}${p.invoice ? ` · ${p.invoice}` : ''}`), h('div', { class: 'c-pack' }, day(p.paidOn)))))
      : null,
  ];
}

/** Mount the drawer. Returns { open(tab) }. */
export function mountAccountUI() {
  let isOpen = false;
  let tab = 'orders';
  let timer = null;
  let opener = null;

  const body = h('div', { class: 'c-account-body', role: 'region', 'aria-live': 'polite' });
  const ordersTab = h('button', { type: 'button', class: 'c-tabbtn', role: 'tab', onClick: () => show('orders') }, 'My orders');
  const balanceTab = h('button', { type: 'button', class: 'c-tabbtn', role: 'tab', onClick: () => show('balance') }, 'My balance');
  const panel = h('section', { class: 'c-drawer-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'My orders and balance', tabindex: '-1' },
    h('header', { class: 'c-drawer-head' },
      h('h2', {}, 'My account'),
      h('button', { type: 'button', class: 'c-remove', 'aria-label': 'Close', onClick: () => close() }, '×')),
    h('div', { class: 'c-tabbtns', role: 'tablist' }, ordersTab, balanceTab),
    body);
  const el = h('div', { class: 'c-drawer hidden', id: 'accountDrawer' }, h('div', { class: 'c-drawer-backdrop', onClick: () => close() }), panel);
  document.body.append(el);

  async function load() {
    if (!isOpen) return;
    ordersTab.setAttribute('aria-selected', String(tab === 'orders'));
    balanceTab.setAttribute('aria-selected', String(tab === 'balance'));
    if (!priceSession().signedIn) { needSignIn(); return; }
    try {
      if (tab === 'orders') {
        const { orders } = await getJSON('/api/catalog/orders');
        setChildren(body, orders.length ? orders.map(orderCard) : [h('p', { class: 'c-order-hint' }, 'You have no orders yet. Add products to your request and submit it.')]);
      } else {
        setChildren(body, balanceView(await getJSON('/api/catalog/account')));
      }
    } catch (e) {
      if (e.status === 401) needSignIn();
      else setChildren(body, h('p', { class: 'c-accesserr' }, 'Could not load this just now. Please try again.'));
    }
  }

  function needSignIn() {
    setChildren(body,
      h('p', { class: 'c-order-hint' }, 'Sign in with your access code to see your orders and balance.'),
      h('button', { type: 'button', class: 'c-btn primary', onClick: () => { close(); window.dispatchEvent(new Event('bfl:sign-in')); } }, 'Sign in'));
  }

  function show(next) { tab = next; load(); }

  function open(which = 'orders') {
    tab = which;
    opener = document.activeElement;
    isOpen = true;
    toggleHidden(el, false);
    document.body.classList.add('c-noscroll');
    panel.focus({ preventScroll: true });
    load();
    clearInterval(timer);
    timer = setInterval(load, POLL_MS);
  }

  function close() {
    isOpen = false;
    clearInterval(timer);
    toggleHidden(el, true);
    document.body.classList.remove('c-noscroll');
    opener?.focus?.({ preventScroll: true });
  }

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });
  window.addEventListener('bfl:open-orders', () => open('orders'));
  window.addEventListener('bfl:open-balance', () => open('balance'));
  // signing in or out while it is open refreshes it
  onPrices(() => { if (isOpen) load(); });
  return { open, close };
}
