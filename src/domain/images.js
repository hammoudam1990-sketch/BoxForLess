// Product image persistence. Uses the EXISTING product_images table +
// products.primary_image_id. Files live on disk (config.productImagesDir); the
// DB stores only the filename/reference so the database stays small.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { ensureCategoryPath } from './categories.js';

const TYPE_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png' };
const FIXTURE_IMAGES_DIR = path.join(config.root, 'fixtures', 'product-images');

export const FEATURED_PHOTO_PRODUCTS = [
  {
    barcode: '5281012013065',
    name: 'LAZIZA NON ALCOHOLIC BEER STRAWBERRY GLASS 330ML * 24',
    box_uom: 'CTN24',
    on_hand: 120,
    free_to_use: 120,
    category_path: 'DRINKS & BEVERAGES / SOFT DRINKS',
    fixtureFile: '5281012013065.jpg',
  },
  {
    barcode: '6281011703116',
    name: 'LUNA ICED COFFEE ORIGINAL 240ML * 24',
    box_uom: 'CTN24',
    on_hand: 90,
    free_to_use: 90,
    category_path: 'DRINKS & BEVERAGES / COFFEE & TEA',
    fixtureFile: '6281011703116.jpg',
  },
  {
    barcode: '5283011830548',
    name: 'AL AMIR TURNIP PICKLES 1000G * 12',
    box_uom: 'CTN12',
    on_hand: 65,
    free_to_use: 65,
    category_path: 'FOOD / CANNED FOOD / PICKLES & OLIVES',
    fixtureFile: '5283011830548.jpg',
  },
  {
    barcode: '5285001401116',
    name: 'CHTOURA GARDEN FAVA BEANS LEBANESE RECIPE 400G * 24',
    box_uom: 'CTN24',
    on_hand: 150,
    free_to_use: 150,
    category_path: 'FOOD / CANNED FOOD',
    fixtureFile: '5285001401116.jpg',
  },
];

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
  let filePath = path.join(storageDir, row.filename);
  if (!fs.existsSync(filePath)) {
    const fallback = path.join(FIXTURE_IMAGES_DIR, path.basename(row.filename));
    if (fs.existsSync(fallback)) filePath = fallback;
    else return null;
  }
  const ext = path.extname(row.filename).slice(1).toLowerCase();
  return {
    buffer: fs.readFileSync(filePath),
    contentType: ext === 'png' ? 'image/png' : 'image/jpeg',
    filename: row.filename,
  };
}

/** Ensure the 4 photographed products and their fixture images exist in the database. */
export function seedFeaturedProductImages(db, opts = {}) {
  const ts = new Date().toISOString();
  const latestBatch = db.prepare("SELECT id FROM import_batches WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1").get();
  const batchId = latestBatch ? latestBatch.id : null;

  for (const item of FEATURED_PHOTO_PRODUCTS) {
    const fixturePath = path.join(FIXTURE_IMAGES_DIR, item.fixtureFile);
    if (!fs.existsSync(fixturePath)) continue;

    const categoryId = ensureCategoryPath(db, item.category_path, { now: ts });
    const existing = db.prepare('SELECT id, primary_image_id FROM products WHERE barcode = ? OR UPPER(name) = UPPER(?)').get(item.barcode, item.name);
    let productId;
    if (existing) {
      productId = existing.id;
      db.prepare(
        'UPDATE products SET barcode = ?, name = ?, box_uom = ?, on_hand = ?, free_to_use = ?, forecasted = ?, odoo_category_path = ?, category_id = ?, is_active = 1, updated_at = ? WHERE id = ?'
      ).run(item.barcode, item.name, item.box_uom, item.on_hand, item.free_to_use, item.free_to_use, item.category_path, categoryId, ts, productId);
    } else {
      const info = db.prepare(
        "INSERT INTO products (barcode, name, box_uom, on_hand, free_to_use, incoming, outgoing, forecasted, odoo_category_path, category_id, is_active, data_quality_status, created_at, updated_at, last_import_id, last_seen_import_id) VALUES (?,?,?,?,?,0,0,?,?,?,1,'OK',?,?,?,?)"
      ).run(item.barcode, item.name, item.box_uom, item.on_hand, item.free_to_use, item.free_to_use, item.category_path, categoryId, ts, ts, batchId, batchId);
      productId = Number(info.lastInsertRowid);
    }

    const currentImg = readPrimaryImage(db, productId, opts);
    if (!currentImg) {
      try {
        const buf = fs.readFileSync(fixturePath);
        saveProductImage(db, productId, buf, 'image/jpeg', { ...opts, confirmReplace: true });
      } catch {
        // Fallback when storageDir is read-only (e.g. serverless): point directly to fixtureFile
        const info = db.prepare(
          'INSERT INTO product_images (product_id, is_primary, filename, url_reference, uploaded_at, is_active, sort_order) VALUES (?, 1, ?, ?, ?, 1, 0)'
        ).run(productId, item.fixtureFile, `/api/products/${productId}/image`, ts);
        db.prepare('UPDATE products SET primary_image_id = ?, updated_at = ? WHERE id = ?').run(Number(info.lastInsertRowid), ts, productId);
      }
    }
  }
}

export default { validateImage, getPrimaryImageRow, saveProductImage, readPrimaryImage, seedFeaturedProductImages };
