import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, writeXlsx, tmpUploads, row } from './helpers.js';
import { createPreview, confirmImport } from '../src/import/service.js';

test('14. a fault during apply rolls back the whole import (no partial data)', () => {
  const db = freshDb();
  // seed one product so there is prior state to protect
  runImport(db, [row({ barcode: 'SEED', name: 'Seed', uom: 'CTN1', on_hand: 1 })]);
  const seedBefore = db.prepare("SELECT * FROM products WHERE barcode='SEED'").get();
  const productsBefore = db.prepare('SELECT COUNT(*) n FROM products').get().n;
  const changesBefore = db.prepare('SELECT COUNT(*) n FROM import_changes').get().n;

  const file = writeXlsx([
    row({ barcode: 'SEED', name: 'Seed', uom: 'CTN1', on_hand: 42 }), // would update
    row({ barcode: 'NEW1', name: 'New One', uom: 'CTN1' }),            // would create
  ]);
  const { batchId } = createPreview(db, file, 'rollback.xlsx', { uploadsDir: tmpUploads() });

  assert.throws(() => {
    confirmImport(db, batchId, { faultHook: () => { throw new Error('injected failure'); } });
  }, /injected failure/);

  // nothing from the failed import must persist
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, productsBefore, 'no new product rows');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE barcode='NEW1'").get().n, 0);
  const seedAfter = db.prepare("SELECT * FROM products WHERE barcode='SEED'").get();
  assert.equal(seedAfter.on_hand, seedBefore.on_hand, 'existing product unchanged (update rolled back)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_changes').get().n, changesBefore, 'no audit rows from failed batch');

  const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(batchId);
  assert.equal(b.status, 'FAILED');
  db.close();
});
