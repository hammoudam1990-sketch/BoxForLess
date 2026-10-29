import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import openDatabase from '../src/db/connection.js';
import { createApp } from '../src/server/index.js';
import { bootstrapDatabase } from '../src/db/bootstrap.js';
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
  bootstrapDatabase(db);

  appInstance = createApp(db);
  return appInstance;
}

export default function handler(req, res) {
  const app = initializeApp();
  return app(req, res);
}
