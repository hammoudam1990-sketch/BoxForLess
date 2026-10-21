// Read-only API for the Sales Manager dashboard. Mounted behind requireSales, so it is
// reachable only with a sales-manager session. It returns counts of requests, lines and
// cartons — never a price or amount (Phase 1).
import express from 'express';
import { salesOverview } from '../../domain/sales-overview.js';
import { computeStockStatus } from '../../domain/stock.js';
import { searchProducts } from '../../domain/products.js';

const router = express.Router();

router.get('/overview', (req, res, next) => {
  try { res.json(salesOverview(req.db, { days: Number(req.query.days) || 30 })); } catch (e) { next(e); }
});

router.get('/requests', (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit) || 50), 1), 100);
    const offset = Math.min(Math.max(Math.floor(Number(req.query.offset) || 0), 0), 1_000_000);
    const status = String(req.query.status || 'all');
    const search = String(req.query.search || '').trim().slice(0, 100);
    const where = [];
    const params = [];
    if (status === 'pending') where.push("r.status = 'SUBMITTED'");
    else if (status === 'accepted') where.push("r.status = 'ACCEPTED'");
    else if (status === 'withdrawn') where.push("r.status = 'DELETED'");
    else if (status !== 'all') return res.status(400).json({ error: 'Unknown request status.' });
    if (search) {
      where.push("(COALESCE(r.reference, '') LIKE ? OR COALESCE(c.name, r.unlisted_company, '') LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = req.db.prepare(
      `SELECT COUNT(*) AS n FROM requests r LEFT JOIN customers c ON c.id = r.customer_id ${whereSql}`
    ).get(...params).n;
    const items = req.db.prepare(
      `SELECT r.id, r.reference, COALESCE(c.name, r.unlisted_company, 'Unnamed customer') AS customer,
              r.status, r.submitted_at AS submittedAt,
              (SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id) AS lines,
              (SELECT COALESCE(SUM(i.quantity_ctn), 0) FROM request_items i WHERE i.request_id = r.id) AS cartons
         FROM requests r LEFT JOIN customers c ON c.id = r.customer_id ${whereSql}
        ORDER BY r.id DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    res.json({ total, limit, offset, status, items });
  } catch (e) { next(e); }
});

router.get('/requests/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Request not found.' });
    const request = req.db.prepare(
      `SELECT r.id, r.reference, COALESCE(c.name, r.unlisted_company, 'Unnamed customer') AS customer,
              r.status, r.submitted_at AS submittedAt
         FROM requests r LEFT JOIN customers c ON c.id = r.customer_id WHERE r.id = ?`
    ).get(id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    const items = req.db.prepare(
      `SELECT COALESCE(i.product_name_at_request, p.name, 'Product') AS name,
              COALESCE(i.box_uom_at_request, p.box_uom, '') AS boxUom,
              i.quantity_ctn AS cartons
         FROM request_items i LEFT JOIN products p ON p.id = i.product_id
        WHERE i.request_id = ? ORDER BY i.id`
    ).all(id);
    res.json({ request, items });
  } catch (e) { next(e); }
});

router.get('/products', (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit) || 50), 1), 100);
    const offset = Math.min(Math.max(Math.floor(Number(req.query.offset) || 0), 0), 1_000_000);
    const data = searchProducts(req.db, {
      search: String(req.query.search || '').slice(0, 100),
      filter: 'active',
      sort: 'name_asc',
      limit,
      offset,
    });
    res.json({
      total: data.total,
      items: data.items.map((p) => ({
        id: p.id,
        name: p.name,
        barcode: p.barcode,
        boxUom: p.box_uom,
        freeToUse: p.free_to_use,
        stockStatus: computeStockStatus(p),
      })),
    });
  } catch (e) { next(e); }
});

router.get('/customers', (req, res, next) => {
  try {
    const search = String(req.query.search || '').trim().slice(0, 100);
    const limit = Math.min(Math.max(Math.floor(Number(req.query.limit) || 50), 1), 100);
    const offset = Math.min(Math.max(Math.floor(Number(req.query.offset) || 0), 0), 1_000_000);
    const where = ['c.is_active = 1'];
    const params = [];
    if (search) { where.push('c.name LIKE ?'); params.push(`%${search}%`); }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const total = req.db.prepare(`SELECT COUNT(*) AS n FROM customers c ${whereSql}`).get(...params).n;
    const items = req.db.prepare(
      `SELECT c.id, c.name, COUNT(DISTINCT r.id) AS requests,
              COALESCE(SUM(i.quantity_ctn), 0) AS cartons
         FROM customers c
         LEFT JOIN requests r ON r.customer_id = c.id AND COALESCE(r.status, '') != 'DELETED'
         LEFT JOIN request_items i ON i.request_id = r.id
         ${whereSql}
        GROUP BY c.id ORDER BY c.name COLLATE NOCASE LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    res.json({ total, limit, offset, items });
  } catch (e) { next(e); }
});

router.get('/customers/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(404).json({ error: 'Customer not found.' });
    const customer = req.db.prepare(
      `SELECT id, name FROM customers WHERE id = ? AND is_active = 1`
    ).get(id);
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    const requests = req.db.prepare(
      `SELECT r.id, r.reference, r.status, r.submitted_at AS submittedAt,
              (SELECT COUNT(*) FROM request_items i WHERE i.request_id = r.id) AS lines,
              (SELECT COALESCE(SUM(i.quantity_ctn), 0) FROM request_items i WHERE i.request_id = r.id) AS cartons
         FROM requests r WHERE r.customer_id = ? AND COALESCE(r.status, '') != 'DELETED'
        ORDER BY r.id DESC LIMIT 20`
    ).all(id);
    res.json({ customer, requests });
  } catch (e) { next(e); }
});

router.get('/imports', (req, res, next) => {
  try {
    const items = req.db.prepare(
      `SELECT id, filename, imported_at AS importedAt, completed_at AS completedAt, status,
              total_rows AS totalRows, created_count AS created, updated_count AS updated,
              error_count AS errors
         FROM import_batches ORDER BY id DESC LIMIT 50`
    ).all();
    res.json({ items });
  } catch (e) { next(e); }
});

export default router;
