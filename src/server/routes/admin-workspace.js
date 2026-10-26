import express from 'express';
import config from '../../config.js';
import { runDataQualityAudit } from '../../domain/data-quality.js';
import { getSiteSettings, updateSiteSettings } from '../../domain/site-settings.js';

const router = express.Router();
const EXPIRY_BANDS = new Set(['all', 'expired', 'critical', 'warning', 'early', 'ok']);

router.get('/status', (req, res, next) => {
  try {
    const latestProductImport = req.db.prepare(
      `SELECT id, filename, status, imported_at, completed_at
         FROM import_batches ORDER BY id DESC LIMIT 1`
    ).get() || null;
    const latestCustomerImport = req.db.prepare(
      `SELECT id, filename, status, created_at, confirmed_at
         FROM customer_imports ORDER BY id DESC LIMIT 1`
    ).get() || null;
    const configured = (username, password) => Boolean(
      process.env[username]
      && process.env[password]
      && Buffer.byteLength(process.env[password]) >= 12
      && process.env.BFL_SESSION_SECRET
      && Buffer.byteLength(process.env.BFL_SESSION_SECRET) >= 32
    );
    res.json({
      data: {
        products: req.db.prepare('SELECT COUNT(*) AS n FROM products WHERE is_active = 1').get().n,
        customers: req.db.prepare('SELECT COUNT(*) AS n FROM customers WHERE is_active = 1').get().n,
        quotations: req.db.prepare('SELECT COUNT(*) AS n FROM quotations').get().n,
      },
      roles: {
        admin: configured('BFL_STAFF_USERNAME', 'BFL_STAFF_PASSWORD'),
        salesManager: configured('BFL_SALES_USERNAME', 'BFL_SALES_PASSWORD'),
        salesRep: configured('BFL_REP_USERNAME', 'BFL_REP_PASSWORD'),
      },
      imports: { latestProductImport, latestCustomerImport },
      integrations: { odoo: 'NOT_CONNECTED' },
      stockThresholds: {
        outOfStockAtOrBelow: config.stock.outOfStockAtOrBelow,
        limitedAtOrBelow: config.stock.limitedAtOrBelow,
      },
    });
  } catch (error) { next(error); }
});

router.get('/quotations', (req, res, next) => {
  try {
    const items = req.db.prepare(
      `SELECT q.id, q.odoo_reference AS odooReference, q.status, q.created_at AS createdAt,
              r.id AS requestId, r.reference AS requestReference,
              COALESCE(c.name, r.unlisted_company, 'Unnamed customer') AS customer
         FROM quotations q
         LEFT JOIN requests r ON r.id = q.request_id
         LEFT JOIN customers c ON c.id = r.customer_id
        ORDER BY q.id DESC LIMIT 200`
    ).all();
    res.json({ items, integration: 'NOT_CONNECTED' });
  } catch (error) { next(error); }
});

router.get('/visibility', (req, res, next) => {
  try {
    const counts = req.db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS visible,
              SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS hidden
         FROM products`
    ).get();
    res.json({
      policy: 'ACTIVE_PRODUCTS_VISIBLE_TO_AUTHENTICATED_CUSTOMERS',
      customerSpecificRules: false,
      ...counts,
    });
  } catch (error) { next(error); }
});

router.get('/stock-expiry', (req, res, next) => {
  try {
    const band = String(req.query.band || 'all');
    if (!EXPIRY_BANDS.has(band)) return res.status(400).json({ error: 'Unknown expiry band.' });

    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const items = req.db.prepare(
      `SELECT l.id, l.lot_code AS lotCode, l.expiry_date AS expiryDate,
              l.delivered_ctn AS deliveredCartons, p.name AS product,
              p.box_uom AS pack, c.name AS customer,
              (SELECT v.outcome FROM rep_visit_lines v WHERE v.lot_id = l.id ORDER BY v.id DESC LIMIT 1) AS lastOutcome
         FROM delivery_lots l
         JOIN products p ON p.id = l.product_id
         JOIN customers c ON c.id = l.customer_id
        WHERE c.is_active = 1
        ORDER BY l.expiry_date, l.id LIMIT 1000`
    ).all().map((lot) => {
      const daysLeft = Math.floor((Date.parse(`${lot.expiryDate}T00:00:00Z`) - todayUtc) / 86400000);
      const expiryBand = daysLeft < 0 ? 'expired'
        : daysLeft <= 7 ? 'critical'
          : daysLeft <= 30 ? 'warning'
            : daysLeft <= 60 ? 'early' : 'ok';
      return { ...lot, daysLeft, band: expiryBand, returnExpected: lot.lastOutcome === 'RETURN' };
    }).filter((lot) => band === 'all' || lot.band === band);

    res.json({
      items,
      source: 'LOCAL_DELIVERY_LOTS',
      odooConnected: false,
      windowDays: 60,
      summary: Object.fromEntries([...EXPIRY_BANDS].filter((key) => key !== 'all')
        .map((key) => [key, items.filter((lot) => lot.band === key).length])),
    });
  } catch (error) { next(error); }
});

router.get('/data-quality', (req, res, next) => {
  try {
    const report = runDataQualityAudit(req.db);
    res.json(report);
  } catch (error) { next(error); }
});

router.get('/site-settings', (req, res, next) => {
  try {
    const settings = getSiteSettings(req.db);
    res.json(settings);
  } catch (error) { next(error); }
});

router.put('/site-settings', (req, res, next) => {
  try {
    const updatedBy = req.staff?.name || req.staff?.role || 'admin';
    const updated = updateSiteSettings(req.db, req.body, updatedBy);
    res.json(updated);
  } catch (error) { next(error); }
});

export default router;
