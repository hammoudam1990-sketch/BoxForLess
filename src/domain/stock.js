// Stock-status computation. COMPUTED on read, never stored, so Phase 3 can
// surface IN_STOCK / LIMITED_STOCK / OUT_OF_STOCK with zero schema change.
import { StockStatus } from './constants.js';
import config from '../config.js';

/**
 * @param {object} product - a product row (needs the availability field)
 * @param {object} [thresholds] - override config.stock
 * @returns {string} one of StockStatus
 */
export function computeStockStatus(product, thresholds = config.stock) {
  const qty = Number(product?.[thresholds.availabilityField] ?? 0);
  if (!Number.isFinite(qty) || qty <= thresholds.outOfStockAtOrBelow) {
    return StockStatus.OUT_OF_STOCK;
  }
  if (qty <= thresholds.limitedAtOrBelow) return StockStatus.LIMITED_STOCK;
  return StockStatus.IN_STOCK;
}

export default computeStockStatus;
