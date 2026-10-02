import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, tmpUploads } from './helpers.js';
import { createPreview, confirmImport } from '../src/import/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'sample-products.xlsx');

test('fixture derived from the real Odoo export imports cleanly', { skip: !fs.existsSync(FIXTURE) && 'fixture missing (run scripts/make-fixtures.js)' }, () => {
  const db = freshDb();
  const { batchId, preview } = createPreview(db, FIXTURE, 'sample-products.xlsx', { uploadsDir: tmpUploads() });
  assert.equal(preview.ok, true);
  assert.ok(preview.summary.total_rows > 0);
  assert.equal(preview.summary.errors, 0, 'real-export fixture has no hard errors');

  const result = confirmImport(db, batchId);
  assert.equal(result.counts.created, preview.summary.total_rows);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, preview.summary.total_rows);

  // re-import the same fixture -> fully idempotent
  const { batchId: b2 } = createPreview(db, FIXTURE, 'sample-products.xlsx', { uploadsDir: tmpUploads() });
  const r2 = confirmImport(db, b2);
  assert.equal(r2.counts.created, 0);
  assert.equal(r2.counts.updated, 0);
  assert.equal(r2.counts.unchanged, preview.summary.total_rows);
  db.close();
});
