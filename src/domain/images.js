// Product image persistence. Uses the EXISTING product_images table +
// products.primary_image_id. Files live on disk (config.productImagesDir); the
// DB stores only the filename/reference so the database stays small.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

const TYPE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };

export class ImageValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ImageValidationError'; this.code = 'IMAGE_INVALID'; this.status = 400; }
}
export class ReplaceConfirmationRequired extends Error {
  constructor(msg) { super(msg); this.name = 'ReplaceConfirmationRequired'; this.code = 'REPLACE_CONFIRM_REQUIRED'; this.status = 409; }
}
export class ProductNotFound extends Error {
  constructor(msg) { super(msg); this.name = 'ProductNotFound'; this.code = 'PRODUCT_NOT_FOUND'; this.status = 404; }
}

/**
 * Validate image bytes: declared type must be JPEG/PNG, content magic bytes must
 * match, and size must be within the cap. Throws ImageValidationError otherwise.
 * @returns {{ext:string}}
 */
export function validateImage(buffer, mimetype, maxBytes = config.maxImageBytes) {
  if (!buffer || buffer.length === 0) throw new ImageValidationError('Empty image');
  if (buffer.length > maxBytes) {
    throw new ImageValidationError(`Image too large (max ${Math.round(maxBytes / 1024 / 1024)}MB)`);
  }
  const ext = TYPE_EXT[mimetype];
  if (!ext) throw new ImageValidationError('Unsupported image type (use JPEG or PNG)');

  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  if (mimetype === 'image/jpeg' && !isJpeg) throw new ImageValidationError('File content is not a valid JPEG');
  if (mimetype === 'image/png' && !isPng) throw new ImageValidationError('File content is not a valid PNG');
  return { ext };
}

/** The current active primary image row for a product, or null. */
export function getPrimaryImageRow(db, productId) {
  const p = db.prepare('SELECT primary_image_id FROM products WHERE id = ?').get(productId);
  if (!p || !p.primary_image_id) return null;
  return db.prepare('SELECT * FROM product_images WHERE id = ? AND is_active = 1').get(p.primary_image_id) || null;
}

/**
 * Persist an image against the stable product identity (products.id).
 * Replacement protection: if a primary image already exists, requires
 * opts.confirmReplace, else throws ReplaceConfirmationRequired.
 * Transactional: a failure leaves no DB row and no orphan primary pointer.
 * @returns {{imageId:number, filename:string, productId:number}}
 */
export function saveProductImage(db, productId, buffer, mimetype, opts = {}) {
  const storageDir = opts.storageDir || config.productImagesDir;
  const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
  if (!product) throw new ProductNotFound(`Product ${productId} not found`);

  const { ext } = validateImage(buffer, mimetype, opts.maxBytes);

  const existing = getPrimaryImageRow(db, productId);
  if (existing && !opts.confirmReplace) {
    throw new ReplaceConfirmationRequired('Product already has an image; confirm replacement');
  }

  fs.mkdirSync(storageDir, { recursive: true });
  const filename = `${productId}-${Date.now()}.${ext}`;
  const filePath = path.join(storageDir, filename);
  fs.writeFileSync(filePath, buffer);

  const now = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    const info = db.prepare(
      `INSERT INTO product_images (product_id, is_primary, filename, url_reference, uploaded_at, is_active, sort_order)
       VALUES (?, 1, ?, ?, ?, 1, 0)`
    ).run(productId, filename, `/api/products/${productId}/image`, now);
    const imageId = Number(info.lastInsertRowid);
    db.prepare('UPDATE products SET primary_image_id = ?, updated_at = ? WHERE id = ?').run(imageId, now, productId);
    if (existing) {
      // keep the old row as history but deactivate it; the new one is primary
      db.prepare('UPDATE product_images SET is_primary = 0, is_active = 0 WHERE id = ?').run(existing.id);
    }
    db.exec('COMMIT');
    if (existing && existing.filename) {
      try { fs.unlinkSync(path.join(storageDir, existing.filename)); } catch { /* best-effort */ }
    }
    return { imageId, filename, productId };
  } catch (e) {
    db.exec('ROLLBACK');
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw e;
  }
}

/** Read the primary image file for serving. Returns null if none on disk. */
export function readPrimaryImage(db, productId, opts = {}) {
  const storageDir = opts.storageDir || config.productImagesDir;
  const row = getPrimaryImageRow(db, productId);
  if (!row || !row.filename) return null;
  const filePath = path.join(storageDir, row.filename);
  if (!fs.existsSync(filePath)) return null;
  const ext = path.extname(row.filename).slice(1).toLowerCase();
  return {
    buffer: fs.readFileSync(filePath),
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    filename: row.filename,
  };
}

export default { validateImage, getPrimaryImageRow, saveProductImage, readPrimaryImage };
