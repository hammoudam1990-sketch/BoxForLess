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
  validateRequest, listRequests, getRequest, acceptRequest, deleteRequest, restoreRequest,
  RequestValidationError, STALE_STOCK_MESSAGE,
} from '../../domain/requests.js';
import { getStockSource } from '../../domain/stock-source.js';
import { checkRequestLines } from '../../domain/shelf-life.js';
import { placeRequest, readLines } from '../../domain/place-request.js';
import { requireCustomer, clearCustomerSession, currentCustomer } from '../customer-access.js';
import {
  createAccessRequest, toAccessRequestReceipt, listAccessRequests,
  getAccessRequest, approveAccessRequest, rejectAccessRequest, AccessRequestError,
  findDuplicates, repChoices, CustomerType,
} from '../../domain/access-requests.js';
import { listPriceClasses, DEFAULT_PRICE_CLASS, CASH_PRICE_CLASS } from '../../domain/prices.js';
import { listPending, outboxSummary } from '../../domain/outbox.js';
import { pricesForCustomer } from '../../domain/prices.js';
import { clearanceOffersFor } from '../../domain/lot-discounts.js';
import { listOrdersFor, accountFor, checkCredit } from '../../domain/orders.js';
import { invoicePdf, statementPdf, statementCsv, DocumentError } from '../../domain/customer-documents.js';
import { resetCustomerPassword, setOdooCustomerId, CustomerAuthError } from '../../domain/customer-auth.js';
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
  try {
    // a visitor or customer is judged as that viewer: a product hidden from them is refused like an unknown one
    const c = currentCustomer(req);
    res.json(toCustomerVerdict(validateRequest(req.db, readLines(req.body), { viewer: c ? { customerId: c.id } : null })));
  } catch (e) { next(e); }
});

// POST /api/catalog/requests/shelf-check — which lines of MY request would be filled with stock
// below my minimum shelf life? Identity is the signed session. Says nothing about quantities or
// lots: only the message and the date the stock expires.
// GET /api/catalog/prices?barcodes=a,b,c — the signed-in customer's own carton prices.
//
// The ONLY place a price leaves the server. It needs a customer session (401 otherwise, so a
// visitor or a customer whose code has not been entered never sees one), answers for the
// session's customer alone (nothing in the query names a customer), and returns the price class
// name to nobody — only numbers for the barcodes asked about.
customerRouter.get('/prices', requireCustomer, (req, res, next) => {
  try {
    const barcodes = String(req.query.barcodes || '').split(',').map((b) => b.trim()).filter(Boolean);
    res.json(pricesForCustomer(req.db, req.customer.id, barcodes));
  } catch (e) { next(e); }
});

// GET /api/catalog/offers — the discounted near-expiry offers THIS customer may use. Like a price, an offer is for
// a signed-in, approved customer only (401 otherwise), answers for the session's customer alone, and carries no
// internal id, no lot's real stock beyond "up to N cartons at this price", and no cost.
customerRouter.get('/offers', requireCustomer, (req, res, next) => {
  try {
    const offers = [...clearanceOffersFor(req.db, req.customer.id).values()].map((o) => ({
      barcode: o.barcode, name: o.name, bestBefore: o.expiryDate, daysLeft: o.daysLeft, discountPct: o.discountPct,
      maxCartons: o.cartons, price: o.price, discountedPrice: o.discountedPrice,
    }));
    res.json({ currency: 'GHS', per: 'carton', offers });
  } catch (e) { next(e); }
});

// GET /api/catalog/orders — MY orders: BFL's reference, Odoo's number, and where each one stands.
// Identity is the session; there is no parameter that could name another customer.
customerRouter.get('/orders', requireCustomer, (req, res, next) => {
  try { res.json({ orders: listOrdersFor(req.db, req.customer.id) }); } catch (e) { next(e); }
});

// GET /api/catalog/account — MY balance as Odoo reports it (a cash customer has none).
customerRouter.get('/account', requireCustomer, (req, res, next) => {
  try { res.json({ source: 'SAMPLE', ...accountFor(req.db, req.customer.id) }); } catch (e) { next(e); }
});

// Downloads for MY account: a copy of one of my invoices (PDF) and my account statement (PDF or CSV). The customer is the
// session's; an invoice number that is not mine is "not found". A cash account has nothing to download.
const sendDocumentError = (e, res, next) => (e instanceof DocumentError ? res.status(e.status).json({ error: e.message }) : next(e));
const attachment = (res, type, filename) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
};
customerRouter.get('/invoices/:number/pdf', requireCustomer, (req, res, next) => {
  try {
    const doc = invoicePdf(req.db, req.customer.id, String(req.params.number || '').slice(0, 64), new Date().toISOString().slice(0, 10));
    attachment(res, 'application/pdf', doc.filename);
    res.end(doc.buffer);
  } catch (e) { sendDocumentError(e, res, next); }
});
customerRouter.get('/statement.pdf', requireCustomer, (req, res, next) => {
  try {
    const doc = statementPdf(req.db, req.customer.id, new Date().toISOString().slice(0, 10));
    attachment(res, 'application/pdf', doc.filename);
    res.end(doc.buffer);
  } catch (e) { sendDocumentError(e, res, next); }
});
customerRouter.get('/statement.csv', requireCustomer, (req, res, next) => {
  try {
    const doc = statementCsv(req.db, req.customer.id, new Date().toISOString().slice(0, 10));
    attachment(res, 'text/csv; charset=utf-8', doc.filename);
    res.end(doc.text);
  } catch (e) { sendDocumentError(e, res, next); }
});

// GET /api/catalog/profile — MY contact & account profile for the Settings screen (no internal id, code, or price class).
customerRouter.get('/profile', requireCustomer, (req, res, next) => {
  try {
    const row = req.db.prepare(
      'SELECT name, phone, email, delivery_address, salesperson, customer_type FROM customers WHERE id = ? AND is_active = 1'
    ).get(req.customer.id);
    if (!row) return res.status(404).json({ error: 'Customer not found.' });
    res.json({
      name: row.name,
      phone: row.phone || null,
      email: row.email || null,
      deliveryAddress: row.delivery_address || null,
      salesperson: row.salesperson || null,
      customerType: row.customer_type || 'CREDIT',
      viaPassword: req.customer.method === 'password',
    });
  } catch (e) { next(e); }
});

// POST /api/catalog/requests/credit-check — would MY request go over MY available credit? A dry run
// for the drawer; the same check is enforced again when the request is submitted. Says nothing when
// there is nothing to check (cash customer, no limit known).
customerRouter.post('/requests/credit-check', requireCustomer, (req, res, next) => {
  try {
    const r = checkCredit(req.db, req.customer.id, readLines(req.body));
    res.json({ checked: r.checked, ok: r.ok, message: r.message || null });
  } catch (e) { next(e); }
});

customerRouter.post('/requests/shelf-check', requireCustomer, (req, res, next) => {
  try {
    const { minDays, warnings } = checkRequestLines(req.db, req.customer.id, readLines(req.body));
    res.json({ minDays, warnings: warnings.map((w) => ({ barcode: w.barcode, message: w.message, expiryDate: w.expiryDate })) });
  } catch (e) { next(e); }
});

const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes
const idempotencyStore = new Map();

export const resetIdempotencyStore = () => idempotencyStore.clear();

function cleanIdempotencyStore(now = Date.now()) {
  if (idempotencyStore.size > 500) {
    for (const [k, v] of idempotencyStore.entries()) {
      if (now - v.timestamp > IDEMPOTENCY_TTL_MS) idempotencyStore.delete(k);
    }
  }
}

// POST /api/catalog/requests — validate THEN submit, one transaction. Supports X-Idempotency-Key.
customerRouter.post('/requests', requireCustomer, (req, res, next) => {
  const idempotencyKey = String(req.headers['x-idempotency-key'] || req.body?.idempotencyKey || '').trim();
  const cacheKey = idempotencyKey ? `${req.customer.id}:${idempotencyKey.slice(0, 120)}` : null;
  const now = Date.now();
  cleanIdempotencyStore(now);

  if (cacheKey && idempotencyStore.has(cacheKey)) {
    const entry = idempotencyStore.get(cacheKey);
    if (entry.inFlight) {
      return res.status(409).json({ error: 'A request with this idempotency key is currently processing. Please wait.', code: 'CONCURRENT_REQUEST' });
    }
    return res.status(200).json({ ...entry.result, duplicate: true });
  }

  if (cacheKey) {
    idempotencyStore.set(cacheKey, { inFlight: true, timestamp: now });
  }

  try {
    // The checks (shelf life, credit, discounted offers) and the draft quotation for Odoo live in placeRequest, which a
    // sales rep's order uses too. Identity comes from the SIGNED SESSION, never from the request body: the browser
    // cannot name a customer it did not prove a code for, so one company cannot submit a request in another's name.
    const result = placeRequest(req.db, { customerId: req.customer.id, body: req.body || {} });
    // The session ends with the order. A salesman carries one phone between
    // several customers in a day, so the next person must enter their own code
    // rather than inherit whoever ordered last. Cleared server-side, so it cannot
    // be skipped by the browser.
    // a code session ends with the order (shared phone); a password session stays
    if (req.customer.method !== 'password') clearCustomerSession(res, req.db, req.customer.id);
    // confirmation only — no internal request id
    const receipt = { reference: result.reference, items: result.lineCount, submitted: true };
    if (cacheKey) {
      idempotencyStore.set(cacheKey, { inFlight: false, result: receipt, timestamp: Date.now() });
    }
    res.status(201).json(receipt);
  } catch (e) {
    if (cacheKey) idempotencyStore.delete(cacheKey);
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
    const { reference } = createAccessRequest(req.db, body);
    // Always the same acknowledgement, carrying no database id — so submitting this form
    // reveals nothing about who is already a customer.
    res.status(201).json(toAccessRequestReceipt(reference));
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
  // BFL_PUBLIC_URL wins wherever it is set, because once this is hosted the
  // machine's own address is an internal one no customer can reach.
  if (config.publicUrl) return `${String(config.publicUrl).replace(/\/+$/, '')}/catalog`;
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

// A customer's Odoo ID — what they sign in with. A stand-in for the Odoo sync, which will set it.
staffRouter.put('/customers/:id/odoo-id', (req, res, next) => {
  try { res.json(setOdooCustomerId(req.db, req.params.id, req.body?.odooId)); } catch (e) {
    if (e instanceof CustomerAuthError) return res.status(e.status).json({ error: e.message, code: e.code });
    next(e);
  }
});

// Reset a customer's password: it is cleared, their sessions end, and a NEW access code is issued so
// they can activate again and choose a new password.
staffRouter.post('/customers/:id/reset-password', (req, res, next) => {
  try {
    const code = resetCustomerPassword(req.db, req.params.id);
    if (!code) return res.status(404).json({ error: 'Customer not found' });
    res.json({ customerId: Number(req.params.id), code, display: formatAccessCode(code) });
  } catch (e) { next(e); }
});

staffRouter.get('/access-requests', (req, res, next) => {
  try {
    res.json(listAccessRequests(req.db, { status: req.query.status || null, limit: req.query.limit, offset: req.query.offset }));
  } catch (e) { next(e); }
});

// What the Approvals screen offers when deciding: the price classes, the reps, and what is
// waiting to go to Odoo. (Registered BEFORE '/:id' so 'options' is not read as an id.)
staffRouter.get('/access-requests/options', (req, res, next) => {
  try {
    res.json({
      priceClasses: listPriceClasses(),
      defaultPriceClass: DEFAULT_PRICE_CLASS,
      cashPriceClass: CASH_PRICE_CLASS,
      reps: repChoices(req.db),
      customerTypes: Object.values(CustomerType),
      source: 'SAMPLE',
      outbox: { summary: outboxSummary(req.db), pending: listPending(req.db, 20).map((p) => ({ id: p.id, kind: p.kind, name: p.payload?.values?.name, reference: p.payload?.values?.ref, createdAt: p.createdAt })) },
    });
  } catch (e) { next(e); }
});

// One registration with its duplicate check, for the decision.
staffRouter.get('/access-requests/:id', (req, res, next) => {
  try {
    const found = getAccessRequest(req.db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Access request not found' });
    res.json({ ...found, duplicates: findDuplicates(req.db, found), suggestedType: found.company ? CustomerType.CREDIT : CustomerType.CASH });
  } catch (e) { next(e); }
});

// Approve: creates (or reuses) the customer and issues the code, in one transaction.
staffRouter.post('/access-requests/:id/approve', (req, res, next) => {
  try {
    const body = req.body || {};
    // The decision comes from the Sales Manager's screen; `strict` is set here, never by the client.
    const result = approveAccessRequest(req.db, req.params.id, {
      strict: true,
      customerType: body.customerType,
      priceClass: body.priceClass,
      salespersonId: body.salespersonId,
      linkCustomerId: body.linkCustomerId,
      createNew: body.createNew === true,
    });
    if (!result) return res.status(404).json({ error: 'Access request not found' });
    // catalogUrl travels with the code so the staff screen can offer a complete,
    // ready-to-send message without a second request.
    res.json({ ...result, display: formatAccessCode(result.code), catalogUrl: catalogUrlFor(req) });
  } catch (e) {
    if (e instanceof AccessRequestError) return res.status(e.status).json({ error: e.message, code: e.code, ...(e.details || {}) });
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
