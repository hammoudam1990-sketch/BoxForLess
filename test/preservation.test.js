import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, runImport, row, getProduct } from './helpers.js';

test('9. existing product image is preserved across an import', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  const p = getProduct(db, '1001');

  // attach an image (application action, separate table)
  const info = db.prepare('INSERT INTO product_images (product_id, is_primary, filename, uploaded_at, is_active) VALUES (?,1,?,?,1)')
    .run(p.id, 'alpha.jpg', new Date().toISOString());
  db.prepare('UPDATE products SET primary_image_id=? WHERE id=?').run(Number(info.lastInsertRowid), p.id);

  // re-import with changed stock
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12', on_hand: 99 })]);

  const after = getProduct(db, '1001');
  assert.equal(after.on_hand, 99, 'stock updated');
  assert.equal(after.primary_image_id, Number(info.lastInsertRowid), 'primary image link preserved');
  const imgs = db.prepare('SELECT * FROM product_images WHERE product_id=?').all(p.id);
  assert.equal(imgs.length, 1, 'image row not deleted');
  assert.equal(imgs[0].filename, 'alpha.jpg');
  db.close();
});

test('image survives a product being marked inactive by import', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  const p = getProduct(db, '1001');
  db.prepare('INSERT INTO product_images (product_id, is_primary, filename, is_active) VALUES (?,1,?,1)').run(p.id, 'alpha.jpg');
  runImport(db, [row({ barcode: '2002', name: 'Other', uom: 'CTN1' })]); // 1001 absent -> inactive
  assert.equal(getProduct(db, '1001').is_active, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM product_images WHERE product_id=?').get(p.id).n, 1);
  db.close();
});

test('10. customer-managed category is preserved across an import', () => {
  const db = freshDb();
  runImport(db, [row({ barcode: '1001', name: 'Alpha', uom: 'CTN12' })]);
  const p = getProduct(db, '1001');

  // categories are now keyed on the full Odoo path (`name` is only the display
  // segment, and is no longer unique). An import whose file carries NO category
  // column must still leave an existing category assignment alone.
  const cat = db.prepare('INSERT INTO categories (name, path, level, is_active, created_at, updated_at) VALUES (?,?,1,1,?,?)')
    .run('Spices', 'Spices', new Date().toISOString(), new Date().toISOString());
  db.prepare('UPDATE products SET category_id=? WHERE id=?').run(Number(cat.lastInsertRowid), p.id);

  runImport(db, [row({ barcode: '1001', name: 'Alpha Renamed', uom: 'CTN12', on_hand: 5 })]);

  const after = getProduct(db, '1001');
  assert.equal(after.name, 'Alpha Renamed', 'odoo-controlled name updated');
  assert.equal(after.category_id, Number(cat.lastInsertRowid), 'category not overwritten by import');
  db.close();
});
