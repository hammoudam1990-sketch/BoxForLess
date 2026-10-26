import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openDatabase from '../src/db/connection.js';
import { createApp } from '../src/server/index.js';
import { createPreview, confirmImport } from '../src/import/service.js';
import config from '../src/config.js';

let appInstance = null;

function initializeApp() {
  if (appInstance) return appInstance;

  let dbPath = config.dbPath;

  // On Vercel serverless platform, the project files are read-only.
  // SQLite requires write access for WAL journal, so we use /tmp on Vercel.
  if (process.env.VERCEL) {
    const tmpDbPath = '/tmp/product_master.db';
    if (!fs.existsSync(tmpDbPath)) {
      const candidates = [
        path.resolve(process.cwd(), 'data', 'product_master.db'),
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'product_master.db'),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          try {
            fs.copyFileSync(cand, tmpDbPath);
            break;
          } catch (e) {
            console.error('Could not copy db from candidate:', cand, e.message);
          }
        }
      }
    }
    dbPath = tmpDbPath;
  }

  const db = openDatabase(dbPath);

  // Self-healing bootstrap: if brand new /tmp database with 0 products, seed from sample fixture
  try {
    const prodCount = db.prepare('SELECT COUNT(*) AS c FROM products').get()?.c || 0;
    if (prodCount === 0) {
      const candidates = [
        path.resolve(process.cwd(), 'fixtures', 'sample-products.xlsx'),
        path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-products.xlsx'),
      ];
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          const { batchId, preview } = createPreview(db, cand, 'sample-products.xlsx');
          if (preview.ok) {
            confirmImport(db, batchId);
          }
          break;
        }
      }
    }
  } catch (err) {
    console.warn('[vercel] Auto-seed products note:', err.message);
  }

  appInstance = createApp(db);
  return appInstance;
}

export default function handler(req, res) {
  const app = initializeApp();
  return app(req, res);
}
