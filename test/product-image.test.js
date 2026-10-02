// Proves the Product Master detail view renders the ACTUAL image (via the
// existing GET /api/products/:id/image endpoint) rather than the filename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDb, runImport, row, getProduct, tmpUploads } from './helpers.js';
import { primaryImageSrc } from '../src/public/js/product-image.js';
import { getProductDetail } from '../src/domain/products.js';
import { saveProductImage } from '../src/domain/images.js';
import { createApp } from '../src/server/index.js';
import config from '../src/config.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-pi-')); }
function startApp(db) {
  const server = http.createServer(createApp(db));
  return new Promise((res) => server.listen(0, () => res({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('detail view: product WITH primary_image_id renders the image endpoint URL', () => {
  assert.equal(primaryImageSrc({ id: 1739, primary_image_id: 5 }), '/api/products/1739/image');
  assert.match(primaryImageSrc({ id: 1739, primary_image_id: 5 }, { cacheBust: true }),
    /^\/api\/products\/1739\/image\?t=\d+$/);
});

test('detail view: product WITHOUT image yields null (clean placeholder, no filename)', () => {
  assert.equal(primaryImageSrc({ id: 1739, primary_image_id: null }), null);
  assert.equal(primaryImageSrc({ id: 1739 }), null);
  assert.equal(primaryImageSrc(null), null);
});

test('detail API exposes primary_image_id + primary row after a save (data the UI needs)', () => {
  const db = freshDb();
  const storageDir = tmpDir();
  runImport(db, [row({ barcode: '5283013330912', name: 'PLEIN SOLEIL CHICKEN STOCK 20G * 24', uom: 'CTN24' })], { uploadsDir: tmpUploads() });
  const pid = getProduct(db, '5283013330912').id;
  saveProductImage(db, pid, JPEG, 'image/jpeg', { storageDir });

  const d = getProductDetail(db, pid);
  assert.ok(d.product.primary_image_id, 'primary_image_id present in detail payload');
  assert.equal(primaryImageSrc(d.product), `/api/products/${pid}/image`);
  const primary = d.images.find((i) => i.is_primary && i.is_active);
  assert.ok(primary && primary.filename, 'primary image row present for the optional filename caption');
  db.close();
});

test('image endpoint: serves the image (200), and fails gracefully (404, not 500) when the file is missing', async () => {
  const db = freshDb();
  config.productImagesDir = tmpDir(); // route reads from config; align it with the test dir
  runImport(db, [row({ barcode: '5283013330912', name: 'PLEIN SOLEIL CHICKEN STOCK', uom: 'CTN24' })], { uploadsDir: tmpUploads() });
  const pid = getProduct(db, '5283013330912').id;
  saveProductImage(db, pid, JPEG, 'image/jpeg'); // uses config.productImagesDir

  const { server, base } = await startApp(db);
  try {
    const ok = await fetch(`${base}/api/products/${pid}/image`);
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /image\/jpeg/);

    // simulate a failed/missing image file on disk -> graceful 404
    const r = db.prepare('SELECT filename FROM product_images WHERE product_id=? AND is_active=1').get(pid);
    fs.unlinkSync(path.join(config.productImagesDir, r.filename));
    const gone = await fetch(`${base}/api/products/${pid}/image`);
    assert.equal(gone.status, 404, 'missing file returns 404, never a 500');

    // a product that never had an image -> 404
    runImport(db, [row({ barcode: 'NOIMG', name: 'No Image Product', uom: 'CTN1' }), row({ barcode: '5283013330912', name: 'PLEIN SOLEIL CHICKEN STOCK', uom: 'CTN24' })], { uploadsDir: tmpUploads() });
    const noimgId = getProduct(db, 'NOIMG').id;
    const none = await fetch(`${base}/api/products/${noimgId}/image`);
    assert.equal(none.status, 404);
  } finally {
    server.close();
    db.close();
  }
});
