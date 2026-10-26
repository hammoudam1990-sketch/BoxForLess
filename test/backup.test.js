import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from '../src/db/backup.js';

test('backupDatabase creates a valid SQLite database copy and prunes old backups', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-backup-test-'));
  const srcDbPath = path.join(tmpDir, 'source.db');
  const backupDir = path.join(tmpDir, 'backups');

  const db = new DatabaseSync(srcDbPath);
  db.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, note TEXT);');
  db.exec("INSERT INTO test_data (note) VALUES ('snapshot 1'), ('snapshot 2');");

  // Run 3 backups with maxKeep = 2
  const b1 = backupDatabase(db, backupDir, { maxKeep: 2, now: new Date(Date.now() - 20000) });
  assert.ok(fs.existsSync(b1.target));
  assert.equal(b1.pruned, 0);

  const b2 = backupDatabase(db, backupDir, { maxKeep: 2, now: new Date(Date.now() - 10000) });
  assert.ok(fs.existsSync(b2.target));
  assert.equal(b2.pruned, 0);

  const b3 = backupDatabase(db, backupDir, { maxKeep: 2, now: new Date() });
  assert.ok(fs.existsSync(b3.target));
  assert.equal(b3.pruned, 1, 'Oldest backup was pruned');

  // Verify only 2 backup files remain in backupDir
  const remaining = fs.readdirSync(backupDir).filter((f) => f.startsWith('bfl-backup-'));
  assert.equal(remaining.length, 2);
  assert.ok(!remaining.includes(b1.filename), 'Oldest backup b1 was removed');
  assert.ok(remaining.includes(b2.filename));
  assert.ok(remaining.includes(b3.filename));

  // Verify the backup database is readable and contains the committed data
  const verifyDb = new DatabaseSync(b3.target);
  const rows = verifyDb.prepare('SELECT note FROM test_data ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, 'snapshot 1');
  assert.equal(rows[1].note, 'snapshot 2');
  verifyDb.close();

  db.close();
  // Cleanup tmpDir
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
