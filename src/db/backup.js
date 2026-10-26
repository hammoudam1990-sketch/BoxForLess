// Automated zero-downtime SQLite backup engine.
// Uses SQLite's built-in VACUUM INTO to create an atomic, non-blocking point-in-time snapshot,
// then applies retention pruning to avoid disk exhaustion.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Creates an atomic point-in-time backup of the SQLite database.
 * @param {import('node:sqlite').DatabaseSync} db - Active database connection
 * @param {string} destinationDir - Directory where backups are written
 * @param {object} options
 * @param {number} [options.maxKeep=7] - Number of most recent backups to retain
 * @param {Date} [options.now=new Date()] - Reference date for filename
 * @returns {{ target: string, filename: string, sizeBytes: number, durationMs: number, pruned: number }}
 */
export function backupDatabase(db, destinationDir, { maxKeep = 7, now = new Date() } = {}) {
  fs.mkdirSync(destinationDir, { recursive: true });

  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filename = `bfl-backup-${stamp}.db`;
  const target = path.join(destinationDir, filename);

  const t0 = Date.now();
  // Escape single quotes for SQLite string literal
  const escapedTarget = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedTarget}'`);
  const durationMs = Date.now() - t0;

  const stat = fs.statSync(target);
  const sizeBytes = stat.size;

  // Prune older backups beyond maxKeep
  const entries = fs.readdirSync(destinationDir)
    .filter((f) => f.startsWith('bfl-backup-') && f.endsWith('.db'))
    .sort(); // Lexicographical sort matches ISO timestamp order

  let pruned = 0;
  while (entries.length > maxKeep) {
    const oldest = entries.shift();
    try {
      fs.unlinkSync(path.join(destinationDir, oldest));
      pruned++;
    } catch {
      // Ignore deletion errors on already removed files
    }
  }

  return {
    target,
    filename,
    sizeBytes,
    durationMs,
    pruned,
  };
}
