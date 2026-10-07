import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshDb, runImport, row, getProduct, tmpUploads } from './helpers.js';
import openDatabase from '../src/db/connection.js';
import {
  validateImage, saveProductImage, readPrimaryImage, getPrimaryImageRow,
  ImageValidationError, ReplaceConfirmationRequired,
} from '../src/domain/images.js';

function tmpDir(p = 'bfl-img-') { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);

function seedProduct(db, barcode = '5283007112449') {
  runImport(db, [row({ barcode, name: 'SMEDS CHEESE', uom: 'CTN12', free: 3 })], { uploadsDir: tmpUploads() });
  return getProduct(db, barcode).id;
}

// ---- validation ----
test('image validation accepts JPEG and PNG with correct magic bytes', () => {
  assert.deepEqual(validateImage(JPEG, 'image/jpeg'), { ext: 'jpg' });
  assert.deepEqual(validateImage(PNG, 'image/png'), { ext: 'png' });
});

test('image validation rejects unsupported type, content mismatch, empty, oversize', () => {
  assert.throws(() => validateImage(JPEG, 'image/gif'), ImageValidationError);           // type
  assert.throws(() => validateImage(Buffer.from('not an image'), 'image/jpeg'), ImageValidationError); // magic
  assert.throws(() => validateImage(Buffer.alloc(0), 'image/jpeg'), ImageValidationError); // empty
  assert.throws(() => validateImage(JPEG, 'image/jpeg', 10), ImageValidationError);        // oversize (cap 10 bytes)
});

// ---- association + success ----
test('saving associates the image with the stable product id and persists the file', () => {
  const db = freshDb();
  const storageDir = tmpDir();
  const pid = seedProduct(db);

  const res = saveProductImage(db, pid, JPEG, 'image/jpeg', { storageDir });
  assert.equal(res.productId, pid);

  const prod = getProduct(db, '5283007112449');
  assert.equal(prod.primary_image_id, res.imageId, 'primary_image_id points to the new image');
  const imgRow = db.prepare('SELECT * FROM product_images WHERE id=?').get(res.imageId);
  assert.equal(imgRow.product_id, pid, 'image row is linked to the product id (not barcode)');
  assert.equal(imgRow.is_primary, 1);

  const read = readPrimaryImage(db, pid, { storageDir });
  assert.ok(read, 'image can be read back');
  assert.equal(read.contentType, 'image/jpeg');
  assert.deepEqual(read.buffer, JPEG, 'stored bytes match the uploaded bytes');
  db.close();
});

// ---- failure ----
test('save failure (invalid image) leaves NO image row and NO primary pointer', () => {
  const db = freshDb();
  const storageDir = tmpDir();
  const pid = seedProduct(db);

  assert.throws(() => saveProductImage(db, pid, Buffer.from('nope'), 'image/jpeg', { storageDir }), ImageValidationError);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_images').get().n, 0);
  assert.equal(getProduct(db, '5283007112449').primary_image_id, null);
  db.close();
});

test('save to a non-existent product throws and writes nothing', () => {
  const db = freshDb();
  const storageDir = tmpDir();
  assert.throws(() => saveProductImage(db, 9999, JPEG, 'image/jpeg', { storageDir }), /not found/i);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_images').get().n, 0);
  db.close();
});

// ---- replacement protection ----
test('existing image is protected: replacing requires explicit confirmation', () => {
  const db = freshDb();
  const storageDir = tmpDir();
  const pid = seedProduct(db);

  const first = saveProductImage(db, pid, JPEG, 'image/jpeg', { storageDir });

  // second save WITHOUT confirmation -> blocked, first image untouched
  assert.throws(() => saveProductImage(db, pid, PNG, 'image/png', { storageDir }), ReplaceConfirmationRequired);
  assert.equal(getProduct(db, '5283007112449').primary_image_id, first.imageId, 'original image preserved');

  // second save WITH confirmation -> replaces
  const second = saveProductImage(db, pid, PNG, 'image/png', { storageDir, confirmReplace: true });
  assert.notEqual(second.imageId, first.imageId);
  assert.equal(getProduct(db, '5283007112449').primary_image_id, second.imageId);
  assert.equal(db.prepare('SELECT is_active FROM product_images WHERE id=?').get(first.imageId).is_active, 0, 'old row kept as inactive history');
  assert.equal(readPrimaryImage(db, pid, { storageDir }).contentType, 'image/png');
  db.close();
});

// ---- survives reload (real file DB reopened) ----
test('saved image survives a database reload (persisted on disk)', () => {
  const dbPath = path.join(tmpDir('bfl-db-'), 'master.db');
  const storageDir = tmpDir();
  let db = openDatabase(dbPath);
  const pid = seedProduct(db);
  const res = saveProductImage(db, pid, JPEG, 'image/jpeg', { storageDir });
  db.close();

  // reopen the same database file
  db = openDatabase(dbPath);
  const rowAfter = getPrimaryImageRow(db, pid);
  assert.ok(rowAfter, 'primary image row persists after reload');
  assert.equal(rowAfter.id, res.imageId);
  const read = readPrimaryImage(db, pid, { storageDir });
  assert.ok(read && read.buffer.length > 0, 'image file still readable after reload');
  db.close();
});
