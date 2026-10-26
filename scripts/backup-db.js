#!/usr/bin/env node
// CLI script to take an atomic SQLite backup with VACUUM INTO and prune older files.
import path from 'node:path';
import openDatabase from '../src/db/connection.js';
import config from '../src/config.js';
import { backupDatabase } from '../src/db/backup.js';

const destinationDir = process.env.BACKUP_DIR || path.join(path.dirname(config.dbPath), 'backups');
const maxKeep = Number(process.env.BACKUP_MAX_KEEP || 7);

console.log(`[backup] Starting atomic backup for database: ${config.dbPath}`);
console.log(`[backup] Target directory: ${destinationDir}`);

let db;
try {
  db = openDatabase(config.dbPath);
  const result = backupDatabase(db, destinationDir, { maxKeep });
  console.log(`[backup] Backup created: ${result.filename} (${(result.sizeBytes / 1024).toFixed(1)} KB) in ${result.durationMs}ms`);
  if (result.pruned > 0) {
    console.log(`[backup] Pruned ${result.pruned} older backup(s) (retaining latest ${maxKeep})`);
  }
  console.log('[backup] Backup completed successfully.');
} catch (err) {
  console.error('[backup] Backup failed:', err.message);
  process.exit(1);
} finally {
  db?.close();
}
