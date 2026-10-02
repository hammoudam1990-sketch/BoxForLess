// Pure helper for deciding how to render a product's primary image.
// Shared by the Product Master detail view and the Node tests, so the
// "has image -> use the image endpoint" decision is testable without a DOM.

/**
 * The URL to render a product's primary image, or null when none exists.
 * Reuses the existing GET /api/products/:id/image endpoint — no new image system.
 * @param {{id:number, primary_image_id?:number|null}} product
 * @param {{cacheBust?:boolean|number}} [opts]
 * @returns {string|null}
 */
export function primaryImageSrc(product, opts = {}) {
  if (!product || product.primary_image_id == null) return null;
  const base = `/api/products/${product.id}/image`;
  if (opts.cacheBust) {
    const t = opts.cacheBust === true ? Date.now() : opts.cacheBust;
    return `${base}?t=${t}`;
  }
  return base;
}

export default primaryImageSrc;
