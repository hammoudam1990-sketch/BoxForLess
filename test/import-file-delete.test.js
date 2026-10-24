import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/index.js';
import config from '../src/config.js';
import { createPreview, confirmImport } from '../src/import/service.js';
import { freshDb, writeXlsx, row } from './helpers.js';

const envKeys = ['BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD', 'BFL_SESSION_SECRET', 'BFL_COOKIE_SECURE', 'NODE_ENV', 'NODE_TEST_CONTEXT'];
const previousEnv = {};
let db;
let server;
let base;
let uploadsDir;
let previousUploadsDir;
let cookie;

before(async () => {
  for (const key of envKeys) previousEnv[key] = process.env[key];
  const random = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
  process.env.BFL_STAFF_USERNAME = `admin-${random(5)}`;
  process.env.BFL_STAFF_PASSWORD = random();
  process.env.BFL_SESSION_SECRET = random(48);
  process.env.BFL_COOKIE_SECURE = 'false';
  process.env.NODE_ENV = 'test';
  delete process.env.NODE_TEST_CONTEXT;
  db = freshDb();
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-import-source-delete-'));
  previousUploadsDir = config.uploadsDir;
  config.uploadsDir = uploadsDir;
  server = http.createServer(createApp(db));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${base}/api/staff/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.BFL_STAFF_USERNAME, password: process.env.BFL_STAFF_PASSWORD }),
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';', 1)[0];
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  db?.close();
  if (uploadsDir) fs.rmSync(uploadsDir, { recursive: true, force: true });
  if (previousUploadsDir !== undefined) config.uploadsDir = previousUploadsDir;
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const request = (url, options = {}) => fetch(`${base}${url}`, {
  ...options,
  headers: { Cookie: cookie, Origin: base, ...options.headers },
});

test('deleting a completed product import removes only its stored workbook and preserves audit history', async () => {
  const source = writeXlsx([row({ barcode: 'DEL-1', name: 'Preserved Product', uom: 'CTN1' })]);
  try {
    const preview = createPreview(db, source, 'catalog.xlsx', { uploadsDir });
    const originalPath = db.prepare('SELECT stored_path FROM import_batches WHERE id = ?').get(preview.batchId).stored_path;
    assert.equal(fs.existsSync(originalPath), true);
    confirmImport(db, preview.batchId);
    const productBefore = db.prepare('SELECT * FROM products WHERE barcode = ?').get('DEL-1');
    const changesBefore = db.prepare('SELECT COUNT(*) AS n FROM import_changes WHERE import_batch_id = ?').get(preview.batchId).n;
    assert.ok(changesBefore > 0);

    const anonymous = await fetch(`${base}/api/imports/${preview.batchId}/source-file`, { method: 'DELETE' });
    assert.equal(anonymous.status, 401);

    const listed = await request('/api/imports').then((res) => res.json());
    assert.equal(listed.items[0].has_source_file, true);
    assert.equal(Object.hasOwn(listed.items[0], 'stored_path'), false);

    const deleted = await request(`/api/imports/${preview.batchId}/source-file`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal((await deleted.json()).wasPresent, true);
    assert.equal(fs.existsSync(originalPath), false);

    const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(preview.batchId);
    assert.equal(batch.status, 'COMPLETED');
    assert.equal(batch.stored_path, null);
    assert.ok(batch.source_file_deleted_at);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_changes WHERE import_batch_id = ?').get(preview.batchId).n, changesBefore);
    assert.deepEqual(db.prepare('SELECT * FROM products WHERE barcode = ?').get('DEL-1'), productBefore);

    const detail = await request(`/api/imports/${preview.batchId}`).then((res) => res.json());
    assert.equal(detail.batch.has_source_file, false);
    assert.ok(detail.batch.source_file_deleted_at);
    assert.equal(Object.hasOwn(detail.batch, 'stored_path'), false);

    const repeated = await request(`/api/imports/${preview.batchId}/source-file`, { method: 'DELETE' });
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json()).wasPresent, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM import_batches WHERE id = ?').get(preview.batchId).n, 1);
  } finally {
    fs.rmSync(path.dirname(source), { recursive: true, force: true });
  }
});

test('a preview source cannot be deleted before the import is confirmed', async () => {
  const source = writeXlsx([row({ barcode: 'DEL-2', name: 'Preview Product', uom: 'CTN1' })]);
  try {
    const preview = createPreview(db, source, 'pending.xlsx', { uploadsDir });
    const storedPath = db.prepare('SELECT stored_path FROM import_batches WHERE id = ?').get(preview.batchId).stored_path;
    const response = await request(`/api/imports/${preview.batchId}/source-file`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /required to confirm/);
    assert.equal(fs.existsSync(storedPath), true);
    assert.equal(db.prepare('SELECT status FROM import_batches WHERE id = ?').get(preview.batchId).status, 'PREVIEW');
  } finally {
    fs.rmSync(path.dirname(source), { recursive: true, force: true });
  }
});

test('an import batch cannot delete a file outside the managed upload directory', async () => {
  const outside = path.join(os.tmpdir(), `bfl-outside-import-${crypto.randomBytes(5).toString('hex')}.xlsx`);
  fs.writeFileSync(outside, 'keep');
  const inserted = db.prepare(`INSERT INTO import_batches (filename, status, imported_at, stored_path)
    VALUES ('outside.xlsx', 'COMPLETED', ?, ?)`).run(new Date().toISOString(), outside);
  const id = Number(inserted.lastInsertRowid);
  try {
    const response = await request(`/api/imports/${id}/source-file`, { method: 'DELETE' });
    assert.equal(response.status, 409);
    assert.equal(fs.existsSync(outside), true);
    assert.equal(db.prepare('SELECT stored_path FROM import_batches WHERE id = ?').get(id).stored_path, outside);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test('imports UI exposes an explicit delete action and preserves import history messaging', () => {
  const uiPath = new URL('../src/public/js/imports.js', import.meta.url);
  const apiPath = new URL('../src/public/js/api.js', import.meta.url);
  const ui = fs.readFileSync(uiPath, 'utf8');
  const api = fs.readFileSync(apiPath, 'utf8');
  assert.match(ui, /Delete stored file/);
  assert.match(ui, /import history and change log will be kept/);
  assert.match(ui, /Required to confirm/);
  assert.match(api, /deleteImportSourceFile: \(id\).*method: 'DELETE'/);
});
