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
import xlsx from 'xlsx';
import {
  validateRequest, submitRequest, listRequests, getRequest, acceptRequest, deleteRequest, restoreRequest,
  RequestValidationError, STALE_STOCK_MESSAGE,
} from '../../domain/requests.js';
import { getStockSource } from '../../domain/stock-source.js';
import { requireCustomer, clearCustomerSession } from '../customer-access.js';
import {
  createAccessRequest, toAccessRequestReceipt, listAccessRequests,
  getAccessRequest, approveAccessRequest, rejectAccessRequest, AccessRequestError,
} from '../../domain/access-requests.js';
import { issueAccessCode, listCustomerCodes, formatAccessCode } from '../../domain/access-codes.js';
import { lanAddresses } from '../net.js';
import config from '../../config.js';

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

// There is deliberately NO customer-search endpoint here any more.
//
// It used to let the catalog look up companies by name so a customer could pick
// theirs. Because the catalog is public, that made the whole customer master
// enumerable by anyone holding the link — typing letters returned real company
// names. The access code replaces it: a customer proves who they are instead of
// finding themselves in a list, so there is nothing left to search.
//
// Do not reintroduce a customer lookup on this router.

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
customerRouter.post('/requests', requireCustomer, (req, res, next) => {
  try {
    const body = req.body || {};
    const result = submitRequest(req.db, {
      lines: readLines(body),
      // Identity comes from the SIGNED SESSION, never from the request body. The
      // browser cannot name a customer it did not prove a code for, so one company
      // can no longer submit a request in another company's name.
      customerId: req.customer.id,
      unlisted: null,
      // An address typed for THIS order. Empty falls back to the one stored on
      // the customer; see submitRequest.
      deliveryAddress: body.deliveryAddress ? String(body.deliveryAddress).slice(0, 500) : null,
      notes: body.notes ? String(body.notes).slice(0, 2000) : null,
    });
    // The session ends with the order. A salesman carries one phone between
    // several customers in a day, so the next person must enter their own code
    // rather than inherit whoever ordered last. Cleared server-side, so it cannot
    // be skipped by the browser.
    clearCustomerSession(res, req.db, req.customer.id);
    // confirmation only — no internal request id
    res.status(201).json({ reference: result.reference, items: result.lineCount, submitted: true });
  } catch (e) {
    if (e instanceof RequestValidationError) {
      return res.status(e.status).json({ error: e.message, code: e.code, ...e.details });
    }
    next(e);
  }
});

// POST /api/catalog/access-requests — "I don't have a code".
//
// Open WITHOUT a code, necessarily: it is how someone with no code asks for one.
// It can only create a PENDING row — it never creates a customer, never issues a
// code and never places a request, so it cannot be used to get in by itself.
customerRouter.post('/access-requests', (req, res, next) => {
  try {
    const body = req.body || {};
    createAccessRequest(req.db, body);
    // Always the same acknowledgement, carrying no id — so submitting this form
    // reveals nothing about who is already a customer.
    res.status(201).json(toAccessRequestReceipt());
  } catch (e) {
    if (e instanceof AccessRequestError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// ---------------------------------------------------------------------------
// staff-facing
// ---------------------------------------------------------------------------

/**
 * The catalogue address to put in the message staff send out. Taken from the
 * server's own LAN address, NOT from the browser's location: staff often have the
 * shell open on localhost, and "http://localhost:3000" is useless to a customer
 * on their phone.
 */
function catalogUrlFor(req) {
  const lan = lanAddresses()[0];
  return lan
    ? `http://${lan.address}:${config.port}/catalog`
    : `${req.protocol}://${req.get('host')}/catalog`;
}

// Customer access codes — the screen staff read a code off to send it.
staffRouter.get('/customers/codes', (req, res, next) => {
  try {
    const result = listCustomerCodes(req.db, { q: req.query.q, limit: req.query.limit, offset: req.query.offset });
    result.catalogUrl = catalogUrlFor(req);
    res.json(result);
  } catch (e) { next(e); }
});

// Issue or REISSUE. Reissuing immediately invalidates the previous code, which is
// how a forwarded or leaked code is revoked.
staffRouter.post('/customers/:id/code', (req, res, next) => {
  try {
    const code = issueAccessCode(req.db, req.params.id);
    if (!code) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customerId: Number(req.params.id), code, display: formatAccessCode(code) });
  } catch (e) { next(e); }
});

staffRouter.get('/access-requests', (req, res, next) => {
  try {
    res.json(listAccessRequests(req.db, { status: req.query.status || null, limit: req.query.limit, offset: req.query.offset }));
  } catch (e) { next(e); }
});

staffRouter.get('/access-requests/:id', (req, res, next) => {
  try {
    const found = getAccessRequest(req.db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Access request not found' });
    res.json(found);
  } catch (e) { next(e); }
});

// Approve: creates (or reuses) the customer and issues the code, in one transaction.
staffRouter.post('/access-requests/:id/approve', (req, res, next) => {
  try {
    const result = approveAccessRequest(req.db, req.params.id);
    if (!result) return res.status(404).json({ error: 'Access request not found' });
    // catalogUrl travels with the code so the staff screen can offer a complete,
    // ready-to-send message without a second request.
    res.json({ ...result, display: formatAccessCode(result.code), catalogUrl: catalogUrlFor(req) });
  } catch (e) {
    if (e instanceof AccessRequestError) return res.status(409).json({ error: e.message, code: e.code });
    next(e);
  }
});

staffRouter.post('/access-requests/:id/reject', (req, res, next) => {
  try {
    const result = rejectAccessRequest(req.db, req.params.id, req.body?.reason);
    if (!result) return res.status(404).json({ error: 'Access request not found' });
    res.json(result);
  } catch (e) { next(e); }
});

// Staff DO see the stock timestamp — that is the point of the screen.
staffRouter.get('/stock-status', (req, res, next) => {
  try { res.json(getStockSource().getStockStatus(req.db)); } catch (e) { next(e); }
});

// ?deleted=true lists the withdrawn ones instead of the working list.
staffRouter.get('/', (req, res, next) => {
  try {
    res.json(listRequests(req.db, { ...req.query, deleted: req.query.deleted === 'true' }));
  } catch (e) { next(e); }
});

staffRouter.get('/:id', (req, res, next) => {
  try {
    const found = getRequest(req.db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Request not found' });
    res.json(found);
  } catch (e) { next(e); }
});

staffRouter.get('/:id/export.xlsx', (req, res, next) => {
  try {
    const found = getRequest(req.db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Request not found' });
    const { request, items, customer } = found;
    const workbook = xlsx.utils.book_new();
    const summary = [
      ['Request', request.reference || `#${request.id}`],
      ['Status', request.status || ''],
      ['Submitted', request.submitted_at || ''],
      ['Customer type', customer.label],
      ['Customer', customer.displayName || ''],
      ['Company', customer.company || ''],
      ['Contact', customer.contact || ''],
      ['Phone', customer.phone || ''],
      ['Delivery address', customer.deliveryAddress || ''],
      ['Notes', request.notes || ''],
      ['Validated against stock from', request.stock_as_of || ''],
    ];
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(summary), 'Request');
    const rows = [
      ['Product', 'Barcode', 'Pack', 'Quantity (CTN)', 'Available when requested (CTN)'],
      ...items.map((item) => [item.product_name_at_request || '', item.barcode_at_request || '',
        item.box_uom_at_request || '', Number(item.quantity_ctn) || 0, Number(item.available_ctn_at_request) || 0]),
    ];
    xlsx.utils.book_append_sheet(workbook, xlsx.utils.aoa_to_sheet(rows), 'Items');
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    const filename = `${request.reference || `request-${request.id}`}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (e) { next(e); }
});

staffRouter.post('/:id/accept', (req, res, next) => {
  try {
    const found = acceptRequest(req.db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Request not found' });
    res.json(found);
  } catch (e) {
    if (e.code === 'REQUEST_STATUS_CONFLICT') return res.status(409).json({ error: e.message });
    next(e);
  }
});

// A SOFT delete — the request is withdrawn, not destroyed, and is returned so the
// screen can show what was removed.
staffRouter.delete('/:id', (req, res, next) => {
  try {
    if (!deleteRequest(req.db, req.params.id)) return res.status(404).json({ error: 'Request not found' });
    res.json(getRequest(req.db, req.params.id));
  } catch (e) { next(e); }
});

staffRouter.post('/:id/restore', (req, res, next) => {
  try {
    const restored = restoreRequest(req.db, req.params.id);
    if (!restored) return res.status(404).json({ error: 'No withdrawn request with that id' });
    res.json(restored);
  } catch (e) { next(e); }
});

export default { customerRouter, staffRouter };
