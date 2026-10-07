// Pure, DOM-free scanner logic. Shared by the browser scanner (scan.js) and the
// Node test suite, so the decision logic is tested without a camera/browser.

/**
 * Choose the decoding engine.
 * @param {{hasBarcodeDetector?: boolean}} caps
 * @returns {'native'|'zxing'} native BarcodeDetector when available, else ZXing.
 */
export function chooseDecoder(caps = {}) {
  return caps.hasBarcodeDetector ? 'native' : 'zxing';
}

/**
 * Normalize a raw scanned value: strip whitespace and invisible/control chars.
 * Conservative — does not alter digits or drop meaningful characters.
 */
export function normalizeBarcode(raw) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  s = s.replace(/[\u0000-\u001f\u007f​-‏﻿]/g, ''); // control + zero-width
  s = s.replace(/\s+/g, ''); // scanned 1D codes never contain spaces
  return s.trim();
}

/** EAN-13 checksum validation. */
export function isValidEan13(code) {
  if (!/^\d{13}$/.test(String(code))) return false;
  const d = String(code).split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return check === d[12];
}

/**
 * Prepare a MANUALLY TYPED barcode for lookup.
 *
 * Deliberately gentler than normalizeBarcode(): that one strips ALL whitespace,
 * which is correct for a scanned 1D code but wrong here — a few real products
 * carry barcodes containing spaces (e.g. "SIP CAKE 47*60*11"), and squashing them
 * would make those products impossible to find by typing.
 *
 * So: drop control/zero-width characters, trim the ends only, keep everything in
 * between. Purely string work, so leading zeros survive untouched.
 *
 * @returns {{ok:boolean, code:string, error:string|null}}
 */
export function prepareManualBarcode(raw) {
  if (raw === null || raw === undefined) {
    return { ok: false, code: '', error: 'Enter a barcode.' };
  }
  const code = String(raw)
    .replace(/[\u0000-\u001f\u007f​-‏﻿]/g, '')
    .trim();
  if (!code) return { ok: false, code: '', error: 'Enter a barcode.' };
  if (code.length > 64) return { ok: false, code, error: 'That barcode is too long.' };
  return { ok: true, code, error: null };
}

/** Exact barcode match from a list of products (null if none). */
export function pickExactProduct(items, barcode) {
  if (!Array.isArray(items)) return null;
  const target = String(barcode);
  return items.find((p) => String(p.barcode) === target) || null;
}

/**
 * Debounce / duplicate suppression for a live scanner.
 * - rejects the same code seen again within `windowMs`
 * - rejects everything while `locked` (a result is on screen)
 * @param {{windowMs?: number}} opts
 */
export function createDebouncer({ windowMs = 2500 } = {}) {
  let last = null;
  let lastAt = -Infinity;
  let locked = false;
  return {
    /** @returns {boolean} true if this detection should be acted on. */
    shouldAccept(code, now = Date.now()) {
      if (locked) return false;
      if (code === last && now - lastAt < windowMs) return false;
      last = code;
      lastAt = now;
      return true;
    },
    lock() { locked = true; },
    unlock(now = Date.now()) { locked = false; last = null; lastAt = now; },
    reset() { last = null; lastAt = -Infinity; locked = false; },
    get lastCode() { return last; },
    get isLocked() { return locked; },
  };
}
