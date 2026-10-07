import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, row, getProduct } from './helpers.js';
import { resolveBarcodeChange, resolveUomChange, listPendingReviews } from '../src/domain/review.js';

test('7. UoM change is flagged for review, NOT silently applied', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  const { batchId, result } = runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN24' })]);
  assert.equal(result.counts.uom_changes, 1);
  const p = getProduct(db, '1001');
  assert.equal(p.box_uom, 'CTN12', 'stored UoM unchanged until reviewed');
  assert.equal(p.uom_change_pending, 1);
  assert.equal(p.pending_uom, 'CTN24');
  const ch = db.prepare("SELECT * FROM import_changes WHERE import_batch_id=? AND change_type='UOM_CHANGE_DETECTED'").get(batchId);
  assert.ok(ch);
  assert.equal(ch.review_status, 'PENDING');
  db.close();
});

test('UoM review: accept applies the new value; reject keeps the old', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN24' })]);

  // accept
  resolveUomChange(db, getProduct(db, '1001').id, 'accept');
  let p = getProduct(db, '1001');
  assert.equal(p.box_uom, 'CTN24');
  assert.equal(p.uom_change_pending, 0);
  assert.equal(p.pending_uom, null);

  // another change then reject
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN6' })]);
  resolveUomChange(db, getProduct(db, '1001').id, 'reject');
  p = getProduct(db, '1001');
  assert.equal(p.box_uom, 'CTN24', 'rejected change keeps previous value');
  assert.equal(p.uom_change_pending, 0);
  db.close();
});

test('6. barcode change (matched by stable Odoo id) is flagged, NOT applied', () => {
  const db = freshDb();
  runImport(db, [row({ odooId: 'O-1', barcode: 'BC-OLD', name: 'Alpha', uom: 'CTN12' })]);
  const { batchId, result } = runImport(db, [row({ odooId: 'O-1', barcode: 'BC-NEW', name: 'Alpha', uom: 'CTN12' })]);
  assert.equal(result.counts.barcode_changes, 1);
  const p = db.prepare("SELECT * FROM products WHERE source_odoo_id='O-1'").get();
  assert.equal(p.barcode, 'BC-OLD', 'barcode not silently replaced');
  assert.equal(p.barcode_change_pending, 1);
  assert.equal(p.pending_barcode, 'BC-NEW');
  const ch = db.prepare("SELECT * FROM import_changes WHERE import_batch_id=? AND change_type='BARCODE_CHANGE_DETECTED'").get(batchId);
  assert.ok(ch);
  assert.equal(ch.review_status, 'PENDING');
  db.close();
});

test('barcode change without a stable Odoo id is handled safely as add + inactivate', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: 'BC-OLD', name: 'Alpha', uom: 'CTN12' })]);
  const { result } = runImport(db, [row({ barcode: 'BC-NEW', name: 'Alpha', uom: 'CTN12' })]);
  // no odoo id -> cannot know it's the same product; old becomes inactive, new created. Nothing deleted.
  assert.equal(result.counts.created, 1);
  assert.equal(result.counts.inactivated, 1);
  assert.equal(getProduct(db, 'BC-OLD').is_active, 0);
  assert.equal(getProduct(db, 'BC-NEW').is_active, 1);
  db.close();
});

test('pending reviews are listed for the Change Review screen', () => {
  const db = freshDb();
  runImport(db, [row({ odooId: 'O-1', barcode: 'B1', name: 'A', uom: 'CTN1' })]);
  runImport(db, [row({ odooId: 'O-1', barcode: 'B2', name: 'A', uom: 'CTN2' })]);
  const pending = listPendingReviews(db);
  assert.equal(pending.length, 2); // one barcode + one uom
  db.close();
});
