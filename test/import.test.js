import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, runPreview, getProduct, row } from './helpers.js';

test('1. initial import creates all products', () => {
  const db = freshDb();
  const { result } = runImport(db, [
    row({ barcode: '1001', name: 'Alpha', uom: 'CTN12', on_hand: 5 }),
    row({ barcode: '1002', name: 'Beta', uom: 'CTN6', free: 3 }),
  ]);
  assert.equal(result.counts.created, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 2);
  const a = getProduct(db, '1001');
  assert.equal(a.name, 'Alpha');
  assert.equal(a.on_hand, 5);
  assert.equal(a.is_active, 1);
  db.close();
});

test('2. second import adds a new product without touching existing', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  const before = getProduct(db, '1001');
  const { result } = runImport(db, [
    row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' }),
    row({ barcode: '2002', name: 'Gamma', uom: 'CTN24' }),
  ]);
  assert.equal(result.counts.created, 1);
  assert.equal(result.counts.unchanged, 1);
  assert.equal(getProduct(db, '1001').id, before.id); // stable identity
  db.close();
});

test('3. existing unchanged product -> no change log rows', () => {
  const db = freshDb();
  const { batchId: b1 } = runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12', on_hand: 1 })]);
  const { batchId: b2, result } = runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12', on_hand: 1 })]);
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.counts.updated, 0);
  const changesB2 = db.prepare('SELECT COUNT(*) n FROM import_changes WHERE import_batch_id=?').get(b2).n;
  assert.equal(changesB2, 0, 'no change rows for an unchanged re-import');
  db.close();
});

test('4. stock change updates values and logs PRODUCT_UPDATED', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12', on_hand: 1, free: 1 })]);
  const { batchId, result } = runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12', on_hand: 9, free: 4 })]);
  assert.equal(result.counts.updated, 1);
  const p = getProduct(db, '1001');
  assert.equal(p.on_hand, 9);
  assert.equal(p.free_to_use, 4);
  const upd = db.prepare("SELECT * FROM import_changes WHERE import_batch_id=? AND change_type='PRODUCT_UPDATED' AND field='on_hand'").get(batchId);
  assert.ok(upd);
  assert.equal(upd.old_value, '1');
  assert.equal(upd.new_value, '9');
  db.close();
});

test('5. product name change is applied and logged', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Old Name', uom: 'CTN12' })]);
  const { result } = runImport(db, [row({ barcode: '1001', name: 'New Name', uom: 'CTN12' })]);
  assert.equal(result.counts.updated, 1);
  assert.equal(getProduct(db, '1001').name, 'New Name');
  db.close();
});

test('8. product missing from later export becomes inactive (not deleted)', () => {
  const db = freshDb();
  runImport(db, [
    row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' }),
    row({ barcode: '1002', name: 'Beta', uom: 'CTN6' }),
  ]);
  const { result } = runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  assert.equal(result.counts.inactivated, 1);
  const beta = getProduct(db, '1002');
  assert.ok(beta, 'product still exists (not deleted)');
  assert.equal(beta.is_active, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 2);
  db.close();
});

test('15. every import creates an audit batch with accurate counts', () => {
  const db = freshDb();
  const { batchId } = runImport(db, [
    row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' }),
    row({ barcode: '1002', name: 'Beta', uom: 'CTN6' }),
  ]);
  const b = db.prepare('SELECT * FROM import_batches WHERE id=?').get(batchId);
  assert.equal(b.status, 'COMPLETED');
  assert.equal(b.total_rows, 2);
  assert.equal(b.created_count, 2);
  assert.ok(b.completed_at);
  const created = db.prepare("SELECT COUNT(*) n FROM import_changes WHERE import_batch_id=? AND change_type='PRODUCT_CREATED'").get(batchId).n;
  assert.equal(created, 2);
  db.close();
});

test('16. multiple sequential imports accumulate correctly', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'A', uom: 'CTN1' })]);
  runImport(db, [row({ barcode: '1001', name: 'A', uom: 'CTN1' }), row({ barcode: '1002', name: 'B', uom: 'CTN1' })]);
  runImport(db, [row({ barcode: '1002', name: 'B', uom: 'CTN1' }), row({ barcode: '1003', name: 'C', uom: 'CTN1' })]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 3);
  assert.equal(getProduct(db, '1001').is_active, 0); // absent in 3rd import
  assert.equal(getProduct(db, '1003').is_active, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM import_batches WHERE status='COMPLETED'").get().n, 3);
  db.close();
});

test('17. re-import of identical data produces zero unwanted changes', () => {
  const db = freshDb();
  const rows = [
    row({ barcode: '1001', name: 'Alpha', uom: 'CTN12', on_hand: 2, free: 2, forecasted: 2 }),
    row({ barcode: '1002', name: 'Beta', uom: 'CTN6', on_hand: 1 }),
  ];
  runImport(db, rows);
  const snapshot = db.prepare('SELECT id, barcode, name, box_uom, on_hand, free_to_use, updated_at FROM products ORDER BY id').all();
  const { batchId, result } = runImport(db, rows);
  assert.equal(result.counts.unchanged, 2);
  assert.equal(result.counts.updated, 0);
  assert.equal(result.counts.created, 0);
  assert.equal(result.counts.inactivated, 0);
  const after = db.prepare('SELECT id, barcode, name, box_uom, on_hand, free_to_use, updated_at FROM products ORDER BY id').all();
  assert.deepEqual(after, snapshot, 'no product row changed (incl. updated_at)');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM import_changes WHERE import_batch_id=?').get(batchId).n, 0);
  db.close();
});

test('preview performs no database writes to products', () => {
  const db = freshDb();
  runPreview(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, 0, 'preview must not create products');
  const b = db.prepare("SELECT * FROM import_batches ORDER BY id DESC").get();
  assert.equal(b.status, 'PREVIEW');
  db.close();
});
