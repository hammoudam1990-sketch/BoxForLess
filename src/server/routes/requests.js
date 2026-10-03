// Customer request endpoints + the staff view of what came in.
//
// Two audiences, deliberately separated:
//   /api/catalog/...  customer-facing — customer-safe payloads only
//   /api/requests/... staff-facing    — internal detail
//
// Customer responses never carry stock figures, internal ids, Odoo ids or any
// other customer's data. Validation is always server-side: the client's view of
// availability is a stale copy and is never trusted.
import express from 'express';
import {
  validateRequest, submitRequest, listRequests, getRequest,
  RequestValidationError, STALE_STOCK_MESSAGE,
} from '../../domain/requests.js';
import { searchCustomers, resolveCustomerHandle } from '../../domain/customers.js';
import { getStockSource } from '../../domain/stock-source.js';

export const customerRouter = express.Router();
export const staffRouter = express.Router();

/** Strip a validation verdict down to what a customer may see. */
function toCustomerVerdict(verdict) {
  return {
    ok: verdict.ok,
    // whether requests can be submitted at all — never the timestamp or age
    canSubmit: verdict.stock.hasData && verdict.stock.fresh,
    errors: verdict.errors.map((e) => ({ barcode: e.barcode, code: e.code, message: e.message })),
  };
}

/** Lines from a request body, normalised to { barcode, quantityCtn }. */
function readLines(body) {
  const raw = Array.isArray(body?.lines) ? body.lines : [];
  return raw.slice(0, 200).map((l) => ({
    barcode: String(l?.barcode ?? '').trim(),
    quantityCtn: l?.quantityCtn,
  }));
}

// ---------------------------------------------------------------------------
// customer-facing
// ---------------------------------------------------------------------------

// GET /api/catalog/customers?q=  — search-only, min length enforced, capped.
customerRouter.get('/customers', (req, res, next) => {
  try { res.json(searchCustomers(req.db, req.query.q)); } catch (e) { next(e); }
});

// GET /api/catalog/requests/stock-status — may the customer submit right now?
// Reports the verdict ONLY; the import timestamp is staff information.
customerRouter.get('/requests/stock-status', (req, res, next) => {
  try {
    const s = getStockSource().getStockStatus(req.db);
    res.json({
      canSubmit: s.hasData && s.fresh,
      message: s.hasData && s.fresh ? null : STALE_STOCK_MESSAGE,
    });
  } catch (e) { next(e); }
});

// POST /api/catalog/requests/validate — dry run, writes nothing.
customerRouter.post('/requests/validate', (req, res, next) => {
  try { res.json(toCustomerVerdict(validateRequest(req.db, readLines(req.body)))); } catch (e) { next(e); }
});

// POST /api/catalog/requests — validate THEN submit, one transaction.
customerRouter.post('/requests', (req, res, next) => {
  try {
    const body = req.body || {};
    // The browser sends an opaque handle, never an Odoo customer id. Resolving it
    // here keeps that id entirely server-side.
    const matched = body.customerHandle ? resolveCustomerHandle(req.db, body.customerHandle) : null;
    if (body.customerHandle && !matched) {
      return res.status(409).json({
        error: 'Customer not found.',
        code: 'REQUEST_INVALID',
        errors: [{ code: 'CUSTOMER_REQUIRED', message: 'Please select your company again.' }],
      });
    }
    const result = submitRequest(req.db, {
      lines: readLines(body),
      customerRef: matched ? matched.odoo_customer_ref : null,
      unlisted: body.unlisted || null,
      notes: body.notes ? String(body.notes).slice(0, 2000) : null,
    });
    // confirmation only — no internal request id
    res.status(201).json({ reference: result.reference, items: result.lineCount, submitted: true });
  } catch (e) {
    if (e instanceof RequestValidationError) {
      return res.status(e.status).json({ error: e.message, code: e.code, ...e.details });
    }
    next(e);
  }
});

// ---------------------------------------------------------------------------
// staff-facing
// ---------------------------------------------------------------------------

// Staff DO see the stock timestamp — that is the point of the screen.
staffRouter.get('/stock-status', (req, res, next) => {
  try { res.json(getStockSource().getStockStatus(req.db)); } catch (e) { next(e); }
});

staffRouter.get('/', (req, res, next) => {
  try { res.json(listRequests(req.db, req.query)); } catch (e) { next(e); }
});

staffRouter.get('/:id', (req, res, next) => {
  try {
    const found = getRequest(req.db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Request not found' });
    res.json(found);
  } catch (e) { next(e); }
});

export default { customerRouter, staffRouter };
