// The request cart as React state.
//
// The cart itself (localStorage, quantities, ordering) is ../cart.js and is covered
// by its own tests. This is only the bridge that re-renders whoever is looking at it.
import { useState, useEffect } from '../lib/react.js';
import { readCart, onCartChange } from '../cart.js';

/** The current cart lines; re-renders whenever the cart changes. */
export function useCartLines() {
  const [lines, setLines] = useState(readCart);
  useEffect(() => {
    setLines(readCart()); // pick up anything written between first render and subscribing
    return onCartChange(setLines);
  }, []);
  return lines;
}

/** Cartons of one product currently in the cart (0 when absent). */
export function useQuantity(barcode) {
  return useCartLines().find((l) => l.barcode === barcode)?.quantityCtn || 0;
}
