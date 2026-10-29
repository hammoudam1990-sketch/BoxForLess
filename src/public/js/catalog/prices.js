// Prices in the customer catalogue.
//
// A price is shown ONLY to a signed-in, approved customer, per carton in GHS, from that customer's
// own price class. The server decides: /api/catalog/prices answers 401 without a session, and the
// product lists and product pages never carry a price at all. This module only asks for the
// prices of the products on screen and shows what comes back. A visitor sees nothing here but a
// short note and a way to sign in.
//
// While the Odoo price classes are not connected the server marks every price SAMPLE, and the
// bar says so; nothing here treats a sample price as real.
import { h, toggleHidden } from '../lib/dom.js';
import { getJSON } from './http.js';

const state = { signedIn: false, name: null, source: null, available: false, prices: new Map(), offers: new Map(), limits: new Map() };
const listeners = new Set();
const wanted = new Set();
let timer = null;
let limitsLoaded = false;

const emit = () => { for (const fn of [...listeners]) fn(); };

/** Subscribe to any change in who is signed in or which prices are known. Returns the unsubscribe. */
export function onPrices(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const priceSession = () => ({ signedIn: state.signedIn, name: state.name, source: state.source, available: state.available });

/** The carton price for a barcode, or null (not signed in, not loaded yet, or no price in the class). */
export const priceOf = (barcode) => (state.signedIn && state.prices.has(String(barcode)) ? state.prices.get(String(barcode)) : null);

/** The discounted near-expiry offer on a product for this customer, or null. */
export const offerOf = (barcode) => (state.signedIn ? state.offers.get(String(barcode)) || null : null);
export const offerList = () => (state.signedIn ? [...state.offers.values()] : []);

/** Per-product purchasing limitation (max cartons per order), or null. */
export const limitOf = (barcode) => state.limits.get(String(barcode)) || null;

export async function refreshLimits() {
  try {
    const r = await getJSON('/api/catalog/limits');
    state.limits = new Map(Object.entries(r.limits || {}).map(([k, v]) => [String(k), Number(v)]));
    limitsLoaded = true;
    emit();
  } catch { /* ignore */ }
}

/**
 * What a line comes to, with the offer applied: the first maxCartons cartons of the offer at the discounted
 * price, the rest at the normal price. null when the price is not known. An estimate: Odoo works out the order.
 */
export function lineValue(barcode, quantityCtn) {
  const p = priceOf(barcode);
  if (p === null) return null;
  const o = offerOf(barcode);
  const c = o && o.discountedPrice !== null ? Math.min(quantityCtn, o.maxCartons) : 0;
  return { total: (quantityCtn - c) * p + c * (o ? o.discountedPrice : 0), offerCartons: c, normalCartons: quantityCtn - c, offer: c > 0 ? o : null, price: p };
}

/** Fetch this customer's offers (signed in only). Called when someone signs in, and after an order. */
export async function refreshOffers() {
  if (!state.signedIn) { if (state.offers.size) { state.offers.clear(); emit(); } return; }
  const who = state.name;
  try {
    const r = await getJSON('/api/catalog/offers');
    if (state.name !== who) return;
    state.offers = new Map((r.offers || []).map((o) => [String(o.barcode), o]));
    for (const o of state.offers.values()) wantPrice(o.barcode);
    emit();
  } catch (e) {
    if (e.status === 401) setSession(null);
  }
}

// Live sync: when a discount is added/changed on the staff Expiry or Approvals screen in another tab,
// or when the customer focuses back on this tab, immediately refresh offers so the discount appears at once.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'bfl.discounts.updated' && state.signedIn) refreshOffers();
  });
  window.addEventListener('focus', () => {
    if (state.signedIn) refreshOffers();
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && state.signedIn) refreshOffers();
    });
  }
  try {
    const bc = new BroadcastChannel('bfl_discounts');
    bc.addEventListener('message', () => { if (state.signedIn) refreshOffers(); });
  } catch { /* BroadcastChannel unsupported */ }
}

export const formatPrice = (n) => `GHS ${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Called with the customer the server says is signed in (or null). Clears prices when it changes. */
export function setSession(customer) {
  const name = customer ? customer.name : null;
  if (name === state.name && Boolean(customer) === state.signedIn) return;
  state.signedIn = Boolean(customer);
  state.name = name;
  state.prices.clear();
  state.offers.clear();
  state.available = false;
  state.source = null;
  emit();
  if (state.signedIn) { flush(); refreshOffers(); } // anything already asked for is fetched for the new customer
}

/** Ask the server who is signed in (once at start, and after a sign-in). */
export async function refreshSession() {
  if (!limitsLoaded) refreshLimits();
  try {
    const s = await getJSON('/api/catalog/access');
    setSession(s.authenticated ? s.customer : null);
  } catch { setSession(null); }
}

/** Say that a product's price is wanted; fetched in one batch shortly after. */
export function wantPrice(barcode) {
  const b = String(barcode);
  wanted.add(b);
  clearTimeout(timer);
  timer = setTimeout(flush, 60);
}

async function flush() {
  if (!state.signedIn || !wanted.size) return;
  const ids = [...wanted].filter((b) => !state.prices.has(b)).slice(0, 200);
  for (const b of ids) wanted.delete(b);
  if (!ids.length) return;
  const who = state.name;
  try {
    const r = await getJSON(`/api/catalog/prices?barcodes=${encodeURIComponent(ids.join(','))}`);
    if (state.name !== who) return; // someone else signed in meanwhile
    state.available = r.available;
    state.source = r.source;
    for (const b of ids) state.prices.set(b, r.prices[b] ?? null);
    emit();
  } catch (e) {
    if (e.status === 401) setSession(null); // the session ended
  }
  if (wanted.size) flush();
}

/** Go to the sign-in page and come back to the page the customer was on. */
export const goToSignIn = () => window.location.assign(`/?next=${encodeURIComponent(window.location.pathname)}`);

/**
 * The strip under the header. Built once; only its text and which controls show change. For a
 * visitor: a note and a Sign in button (the sign-in page is where the ID and password are typed).
 * For a customer: who they are, that prices are theirs, My orders / My balance, and Sign out.
 */
export function buildPriceBar() {
  const note = h('span', { class: 'c-pricebar-note' });
  const signInBtn = h('button', { type: 'button', class: 'c-pricebar-btn', onClick: goToSignIn }, 'Sign in');
  const ordersBtn = h('button', { type: 'button', class: 'c-pricebar-btn', onClick: () => window.dispatchEvent(new Event('bfl:open-orders')) }, 'My orders');
  const balanceBtn = h('button', { type: 'button', class: 'c-pricebar-btn', onClick: () => window.dispatchEvent(new Event('bfl:open-balance')) }, 'My balance');
  const signOutBtn = h('button', { type: 'button', class: 'c-pricebar-btn', onClick: signOut }, 'Sign out');
  const bar = h('div', { class: 'c-pricebar', role: 'region', 'aria-label': 'Prices' }, note, signInBtn, ordersBtn, balanceBtn, signOutBtn);
  // other parts of the page (the orders drawer) can ask for the sign-in page
  window.addEventListener('bfl:sign-in', goToSignIn);

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setSession(null);
  }

  function paint() {
    const s = priceSession();
    toggleHidden(signOutBtn, !s.signedIn);
    toggleHidden(ordersBtn, !s.signedIn);
    toggleHidden(balanceBtn, !s.signedIn);
    toggleHidden(signInBtn, s.signedIn);
    if (s.signedIn) {
      note.textContent = s.available === false && s.source
        ? `Signed in as ${s.name}. No price class is set for your account yet — please ask the Box for Less team.`
        : `Prices for ${s.name}, per carton in GHS.`;
    } else {
      note.textContent = 'Prices are shown to approved customers.';
    }
  }
  onPrices(paint);
  paint();
  return bar;
}
