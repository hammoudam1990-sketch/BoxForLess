import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runPreview, runImport, row, writeXlsx, tmpUploads, HEADERS } from './helpers.js';
import { createPreview } from '../src/import/service.js';

test('11. duplicate barcode within file is detected and blocks those rows', () => {
  const db = freshDb();
  const { preview, result } = runImport(db, [
    row({ barcode: 'DUP', name: 'One', uom: 'CTN1' }),
    row({ barcode: 'DUP', name: 'Two', uom: 'CTN1' }),
    row({ barcode: 'OK1', name: 'Three', uom: 'CTN1' }),
  ]);
  assert.equal(preview.summary.duplicate_barcodes, 1);
  assert.equal(preview.summary.errors, 2, 'both duplicate rows are errors');
  assert.equal(result.counts.created, 1, 'only the unique row is created');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE barcode='DUP'").get().n, 0);
  db.close();
});

test('12. missing required field (name) is a validation error, row not created', () => {
  const db = freshDb();
  const { preview, result } = runImport(db, [
    row({ barcode: '1001', name: null, uom: 'CTN1' }),
    row({ barcode: '1002', name: 'Good', uom: 'CTN1' }),
  ]);
  assert.equal(preview.summary.errors, 1);
  assert.ok(preview.errors[0].errors.some((e) => /name/i.test(e)));
  assert.equal(result.counts.created, 1);
  db.close();
});

test('13. non-numeric stock value is a validation error (no silent repair)', () => {
  const db = freshDb();
  const r = row({ barcode: '1001', name: 'Alpha', uom: 'CTN1' });
  r['On Hand (CTN, decimal)'] = 'abc';
  const { preview, result } = runImport(db, [r]);
  assert.equal(preview.summary.errors, 1);
  assert.ok(preview.errors[0].errors.some((e) => /on_hand/.test(e)));
  assert.equal(result.counts.created, 0);
  db.close();
});

test('missing UoM is a validation error', () => {
  const db = freshDb();
  const { preview } = runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: null })]);
  assert.equal(preview.summary.errors, 1);
  assert.ok(preview.errors[0].errors.some((e) => /UoM/i.test(e)));
  db.close();
});

test('negative stock is a warning, not an error (row still imported)', () => {
  const db = freshDb();
  const { preview, result } = runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN1', forecasted: -3 })]);
  assert.equal(preview.summary.errors, 0);
  assert.equal(preview.summary.warnings, 1);
  assert.equal(result.counts.created, 1);
  assert.equal(db.prepare("SELECT data_quality_status FROM products WHERE barcode='1001'").get().data_quality_status, 'WARNING');
  db.close();
});

test('missing required COLUMN is a fatal preview (no batch confirmable)', () => {
  const db = freshDb();
  // headers without "Name"
  const rows = [{ Barcode: '1', 'Box UoM': 'CTN1' }];
  const file = writeXlsx(rows, ['Barcode', 'Box UoM']);
  const { preview, status } = createPreview(db, file, 'bad.xlsx', { uploadsDir: tmpUploads() });
  assert.equal(preview.ok, false);
  assert.equal(status, 'FAILED');
  assert.ok(preview.missingColumns.includes('name'));
  db.close();
});

test('unexpected columns are reported but never fatal', () => {
  const db = freshDb();
  const r = row({ barcode: '1001', name: 'Alpha', uom: 'CTN1' });
  r['Selling Price'] = 9.99; // extra column that must NOT break import and must NOT be imported
  const { preview, result } = runImport(db, [r], { });
  assert.ok(preview.unexpectedColumns.includes('Selling Price'));
  assert.equal(result.counts.created, 1);
  const cols = Object.keys(db.prepare('SELECT * FROM products LIMIT 1').get());
  assert.ok(!cols.includes('Selling Price'));
  assert.ok(!cols.some((c) => /price/i.test(c)), 'no pricing field leaks into product master');
  db.close();
});
