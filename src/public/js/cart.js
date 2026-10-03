// The request cart.
//
// Lives in localStorage until the customer submits: there are no accounts and no
// server session in Stage 3, so there is nowhere else to keep it. It holds only
// what the customer chose — a public product id (barcode), a carton count, and a
// label for display. No stock figures, because the browser's idea of availability
// is a stale copy and the server re-checks everything at submission anyway.
//
// Quantities are CTN only.

const KEY = 'bfl.request.cart.v1';
const listeners = new Set();

/** Read the cart, tolerating cleared, blocked or corrupt storage. */
export function readCart() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((l) => l && typeof l.barcode === 'string' && Number.isInteger(l.quantityCtn) && l.quantityCtn >= 1);
  } catch {
    return []; // private mode / blocked storage / bad JSON — an empty cart, never a crash
  }
}

function writeCart(lines) {
  try { localStorage.setItem(KEY, JSON.stringify(lines)); } catch { /* storage unavailable: cart is session-only */ }
  for (const fn of listeners) { try { fn(lines); } catch { /* a bad listener must not break the cart */ } }
  return lines;
}

/** Subscribe to cart changes. Returns an unsubscribe function. */
export function onCartChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function cartCount() {
  return readCart().reduce((n, l) => n + l.quantityCtn, 0);
}
export function cartLineCount() { return readCart().length; }
export function quantityOf(barcode) {
  const line = readCart().find((l) => l.barcode === barcode);
  return line ? line.quantityCtn : 0;
}

/** Set an exact carton count; 0 or less removes the line. */
export function setQuantity(product, quantityCtn) {
  const qty = Math.floor(Number(quantityCtn) || 0);
  const lines = readCart().filter((l) => l.barcode !== product.barcode);
  if (qty >= 1) {
    lines.push({
      barcode: product.barcode,
      quantityCtn: qty,
      name: product.name,     // display only; the server re-reads the real name
      pack: product.pack || null,
    });
  }
  return writeCart(lines);
}

export function addToCart(product, quantityCtn = 1) {
  return setQuantity(product, quantityOf(product.barcode) + Math.max(1, Math.floor(Number(quantityCtn) || 1)));
}
export function removeFromCart(barcode) {
  return writeCart(readCart().filter((l) => l.barcode !== barcode));
}
export function clearCart() { return writeCart([]); }

/** The payload shape the API expects — quantities only, nothing derived. */
export function toRequestLines() {
  return readCart().map((l) => ({ barcode: l.barcode, quantityCtn: l.quantityCtn }));
}

/**
 * Drop lines the server rejected as permanently unavailable, keeping the ones the
 * customer can still fix by lowering the quantity.
 */
export function pruneUnavailable(errors = []) {
  const drop = new Set(
    errors.filter((e) => e.code === 'PRODUCT_UNAVAILABLE' || e.code === 'NOT_REQUESTABLE')
      .map((e) => e.barcode)
  );
  if (!drop.size) return readCart();
  return writeCart(readCart().filter((l) => !drop.has(l.barcode)));
}

export default { readCart, setQuantity, addToCart, removeFromCart, clearCart, cartCount, toRequestLines };
