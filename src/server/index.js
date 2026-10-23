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
import expiryRouter from './routes/expiry.js';
import shelfRouter from './routes/shelf.js';
import sampleOdooRouter from './routes/sample-odoo.js';
import catalogRouter from './routes/catalog.js';
import customerImportsRouter from './routes/customer-imports.js';
import { customerRouter as requestsCustomerRouter, staffRouter as requestsStaffRouter } from './routes/requests.js';
import { requireStaff, requireRole, privatePageFor, staffLogin, staffLogout, staffSessionStatus } from './staff-auth.js';
import authRouter from './routes/auth.js';
import teamRouter from './routes/team.js';
import paymentsRouter from './routes/payments.js';
import visibilityRouter from './routes/visibility.js';
import reportsRouter from './routes/reports.js';
import returnsRouter from './routes/returns.js';
import odooRouter from './routes/odoo.js';
import repsRouter from './routes/reps.js';
import { startOdooJobs } from '../odoo/jobs.js';
import { takeStockSnapshot } from '../domain/reports.js';
import { runReminders } from '../domain/payments.js';
import { todayString } from '../domain/expiry-list.js';
import { enterAccessCode, accessStatus, exitAccess } from './customer-access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.set('trust proxy', process.env.NODE_ENV === 'production' ? 1 : false);
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // make db available to routers
  app.use((req, _res, next) => { req.db = db; next(); });

  app.get('/api/health', (_req, res) => res.json({ ok: true, phase: 1 }));
  app.get('/api/staff/session', staffSessionStatus);
  app.post('/api/staff/login', staffLogin);
  app.post('/api/staff/logout', staffLogout);
  // Customer access code — public by necessity: entering a code is how a customer
  // identifies themselves. Rate-limited per IP in customer-access.js.
  app.get('/api/catalog/access', accessStatus);
  app.post('/api/catalog/access', enterAccessCode);
  app.post('/api/catalog/access/exit', exitAccess);
  // Sign-in for customers (ID + password), password changes, who-am-I, sign-out.
  app.use('/api/auth', authRouter);
  // Internal / admin API. Each area is open to the roles that work in it; { SALES_MANAGER: 'r' } is read-only.
  app.use('/api/products', requireStaff, requireRole('ADMIN', 'WAREHOUSE', { SALES_MANAGER: 'r' }), productsRouter);
  app.use('/api/imports', requireStaff, requireRole('ADMIN', 'WAREHOUSE'), importsRouter);
  app.use('/api/reviews', requireStaff, requireRole('ADMIN', 'WAREHOUSE'), changesRouter);
  // Warehouse expiry list (staff only; sample data until the Odoo lot sync exists).
  app.use('/api/expiry', requireStaff, requireRole('ADMIN', 'WAREHOUSE', 'SALES_MANAGER'), expiryRouter);
  // Customer-shelf alerts: rep visits and discount approvals (staff only; sample data for now).
  // (the rep screens and the approvals have their own role checks inside the router)
  app.use('/api/shelf', requireStaff, shelfRouter);
  // The stand-in for Odoo's side of an order (staff only; off once the real Odoo is connected).
  app.use('/api/sample-odoo', requireStaff, requireRole('ADMIN', 'SALES_MANAGER'), sampleOdooRouter);
  // Customer-list import — staff only, and a separate audit from product imports.
  app.use('/api/customer-imports', requireStaff, requireRole('ADMIN', 'SALES_MANAGER'), customerImportsRouter);
  // Staff view of submitted customer requests (internal detail).
  app.use('/api/requests', requireStaff, requireRole('ADMIN', 'SALES_MANAGER'), requestsStaffRouter);
  // Staff accounts: the administrator manages all, a Sales Manager manages sales reps.
  // Payments due and reminder schedules (S07): the Sales Manager and the administrator.
  // Monthly reports (S06): each report checks its own roles inside the router; a sales rep gets only /my.
  app.use('/api/reports', requireStaff, requireRole('ADMIN', 'SALES_MANAGER', 'WAREHOUSE', 'SALES_REP'), reportsRouter);
  // Returns to classify (S04): the warehouse records the reason; a Sales Manager can read.
  app.use('/api/returns', requireStaff, requireRole('ADMIN', 'WAREHOUSE', { SALES_MANAGER: 'r' }), returnsRouter);
  // Sync health (S05): the Odoo connection, the sync jobs and the outbox.
  app.use('/api/odoo', requireStaff, requireRole({ ADMIN: 'rw', SALES_MANAGER: 'rw', WAREHOUSE: 'r' }), odooRouter);
  // Product visibility rules (S02): the Sales Manager and the administrator.
  app.use('/api/visibility', requireStaff, requireRole('ADMIN', 'SALES_MANAGER'), visibilityRouter);
  app.use('/api/payments', requireStaff, requireRole('ADMIN', 'SALES_MANAGER'), paymentsRouter);
  app.use('/api/reps', requireStaff, requireRole('ADMIN', 'SALES_MANAGER'), repsRouter);
  app.use('/api/team', requireStaff, requireRole('ADMIN', 'SALES_MANAGER'), teamRouter);
  // Customer-facing API — customer-safe payloads only. The request routes mount
  // FIRST so /api/catalog/requests is not shadowed by the catalog router's
  // /products/:id style paths.
  app.use('/api/catalog', requestsCustomerRouter);
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
  app.get('/signup', (_req, res) => res.sendFile(path.join(publicDir, 'signup.html')));
  // Legacy customer-shop entry point. Real access codes establish a signed
  // catalog session before the customer continues to the authoritative catalog.
  app.get('/customer-shop', (_req, res) => res.sendFile(path.join(publicDir, 'customer shop.html')));

  // The sign-in page is the front door. Customers sign in with their Odoo ID and a password; staff with
  // an email or phone number and a password. It also links to browsing the catalogue and registering.
  const signInPage = (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.sendFile(path.join(publicDir, 'signin.html')); };
  app.get('/', signInPage);
  app.get('/staff/login', signInPage);
  app.get('/signin', signInPage);

  // The staff shell, the rep screens and the scanner are private, and each is for its own roles:
  // someone who signs in with the wrong role is sent to their own home instead.
  app.get('/index.html', privatePageFor('ADMIN', 'SALES_MANAGER', 'WAREHOUSE'), (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.get('/scan.html', privatePageFor('ADMIN', 'WAREHOUSE'), (_req, res) => res.sendFile(path.join(publicDir, 'scan.html')));
  app.get('/rep.html', privatePageFor('ADMIN', 'SALES_MANAGER', 'SALES_REP'), (_req, res) => res.sendFile(path.join(publicDir, 'rep.html')));

  app.use(express.static(publicDir, { index: false }));

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

  // Payment reminders: look for reminders that are due now, then once an hour. Idempotent (one per customer
  // per day), and only logs — nothing is sent until a person marks it sent. BFL_REMINDERS=off turns it off.
  // The Odoo connection: only when it is configured AND BFL_ODOO_SYNC=on. Otherwise nothing here touches a network.
  startOdooJobs(db);

  if (process.env.BFL_REMINDERS !== 'off') {
    const tick = () => {
      try { runReminders(db, todayString()); } catch (e) { console.error('Reminder run failed:', e.message); }
      try { takeStockSnapshot(db, todayString()); } catch (e) { console.error('Stock snapshot failed:', e.message); } // month-end stock for the Warehouse report
    };
    tick();
    setInterval(tick, 60 * 60 * 1000).unref();
  }

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
