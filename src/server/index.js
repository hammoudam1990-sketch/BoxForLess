// Express application wiring. Run: npm start
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import openDatabase from '../db/connection.js';
import config from '../config.js';
import { printUrls } from './net.js';
import productsRouter from './routes/products.js';
import importsRouter from './routes/imports.js';
import changesRouter from './routes/changes.js';
import catalogRouter from './routes/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.use(express.json());

  // make db available to routers
  app.use((req, _res, next) => { req.db = db; next(); });

  app.get('/api/health', (_req, res) => res.json({ ok: true, phase: 1 }));
  // Internal / admin API (Product Master) — unchanged.
  app.use('/api/products', productsRouter);
  app.use('/api/imports', importsRouter);
  app.use('/api/reviews', changesRouter);
  // Customer-facing API — read-only, customer-safe payloads only.
  app.use('/api/catalog', catalogRouter);

  // static frontend
  const publicDir = path.join(__dirname, '..', 'public');

  // Customer catalog pages. Both URLs serve the same shell; the client reads the
  // path. Declared BEFORE express.static so /catalog has no .html extension and
  // the deep link survives a refresh. catalog.html references its assets with
  // absolute paths, so the nested URL resolves them correctly.
  const catalogPage = (_req, res) => res.sendFile(path.join(publicDir, 'catalog.html'));
  app.get('/catalog', catalogPage);
  app.get('/catalog/product/:id', catalogPage);

  app.use(express.static(publicDir));

  // central error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error('API error:', err.message);
    res.status(err.status || 400).json({ error: err.message, code: err.code });
  });

  return app;
}

// Start only when run directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openDatabase(config.dbPath);
  const app = createApp(db);
  const { host, port } = config;

  // HTTP — always on. Explicit bind to config.host (default 0.0.0.0) so phones
  // on the same LAN can reach it; localhost still works via the loopback.
  http.createServer(app).listen(port, host, () => {
    console.log('\nBox for Less — Product Master');
    console.log(`Database: ${config.dbPath}`);
    console.log(`\nHTTP  (catalog, bind ${host}:${port}):`);
    console.log(printUrls({ scheme: 'http', port, host }));

    // HTTPS — only when certs exist. REQUIRED for the phone camera / barcode
    // scanner (getUserMedia needs a secure context). Create certs: npm run gen-cert
    const hasCerts = fs.existsSync(config.tlsKeyPath) && fs.existsSync(config.tlsCertPath);
    if (hasCerts) {
      const creds = { key: fs.readFileSync(config.tlsKeyPath), cert: fs.readFileSync(config.tlsCertPath) };
      https.createServer(creds, app).listen(config.httpsPort, host, () => {
        console.log(`\nHTTPS (camera/scanner, bind ${host}:${config.httpsPort}):`);
        console.log(printUrls({ scheme: 'https', port: config.httpsPort, host }));
        console.log('  (self-signed cert — your phone will show a one-time "not secure" warning to accept)');
      });
    } else {
      console.log('\nHTTPS not started (no cert). Camera scanning needs HTTPS — run: npm run gen-cert');
    }
    console.log('');
  });
}

export default createApp;
