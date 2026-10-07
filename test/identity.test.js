import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, row, getProduct } from './helpers.js';
import { resolveBarcodeChange } from '../src/domain/review.js';

test('18. internal id is stable and NOT derived from row position', () => {
  const db = freshDb();
  // first import: Alpha at row 1, Beta at row 2
  runImport(db, [
    row({ barcode: 'A', name: 'Alpha', uom: 'CTN1' }),
    row({ barcode: 'B', name: 'Beta', uom: 'CTN1' }),
  ]);
  const alphaId = getProduct(db, 'A').id;
  const betaId = getProduct(db, 'B').id;

  // second import: reversed order + a new product inserted first
  runImport(db, [
    row({ barcode: 'C', name: 'Gamma', uom: 'CTN1' }),
    row({ barcode: 'B', name: 'Beta', uom: 'CTN1' }),
    row({ barcode: 'A', name: 'Alpha', uom: 'CTN1' }),
  ]);

  assert.equal(getProduct(db, 'A').id, alphaId, 'Alpha keeps its id despite moving to row 3');
  assert.equal(getProduct(db, 'B').id, betaId, 'Beta keeps its id');
  assert.notEqual(getProduct(db, 'C').id, alphaId);
  db.close();
});

test('identity survives an accepted barcode change (same id, new barcode)', () => {
  const db = freshDb();
  runImport(db, [row({ odooId: 'O-1', barcode: 'OLD', name: 'Alpha', uom: 'CTN1' })]);
  const idBefore = db.prepare("SELECT id FROM products WHERE source_odoo_id='O-1'").get().id;

  runImport(db, [row({ odooId: 'O-1', barcode: 'NEW', name: 'Alpha', uom: 'CTN1' })]);
  resolveBarcodeChange(db, idBefore, 'accept');

  const p = db.prepare("SELECT * FROM products WHERE source_odoo_id='O-1'").get();
  assert.equal(p.id, idBefore, 'stable identity preserved through a barcode change');
  assert.equal(p.barcode, 'NEW');
  assert.equal(p.barcode_change_pending, 0);
  db.close();
});

test('source_odoo_id is unique when present', () => {
  const db = freshDb();
  // two different new products sharing an odoo id in the same file -> both errored (duplicate)
  const { result, preview } = runImport(db, [
    row({ odooId: 'DUP', barcode: 'X', name: 'X', uom: 'CTN1' }),
    row({ odooId: 'DUP', barcode: 'Y', name: 'Y', uom: 'CTN1' }),
  ]);
  assert.equal(preview.summary.errors, 2);
  assert.equal(result.counts.created, 0);
  db.close();
});
