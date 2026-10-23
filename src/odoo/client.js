// The ONE place BFL talks to Odoo. Nothing else in the code base opens a connection to Odoo.
//
// What it guarantees, in the code and not only by the Odoo user's access rights:
//   - READ calls only: search_read, search_count, read, fields_get.
//   - WRITE calls are `create` on exactly two models — sale.order (a quotation) and res.partner (an approved
//     new customer). Anything else — write, unlink, action_confirm, action_cancel, a create on any other model,
//     a call to any other method — is refused here, before any network call (OdooForbiddenError).
//   - At most `maxPerSecond` calls a second (default 4) and 200 records a page, so people using Odoo never notice.
//   - Failures are told apart: OdooUnavailableError (timeout, connection, 5xx, 429 — try again later) versus
//     OdooRejectedError (access denied, validation, a business rule — trying again will not help).
//   - The API key is never in a log line, an error message or a returned value.
//
// Two transports, chosen by BFL_ODOO_PROTOCOL. The Odoo version decides which exists, so BOTH are here and the
// choice is configuration: "jsonrpc" (execute_kw, older and current Odoo) and "json2" (the newer bearer-key JSON
// API). To be verified against our Odoo version on staging in week 1; a later switch changes this one file.
import { redact } from './config.js';

export class OdooError extends Error {
  constructor(message, extra = {}) { super(message); this.name = this.constructor.name; Object.assign(this, extra); }
}
/** Odoo did not answer, or answered with a server-side problem: the same request may work later. */
export class OdooUnavailableError extends OdooError {}
/** Odoo understood and refused: a rule, a right, a validation. Retrying will not help. */
export class OdooRejectedError extends OdooError {}
/** BFL refused to send it: not on the list of calls BFL is allowed to make. */
export class OdooForbiddenError extends OdooError {}

export const PAGE_SIZE = 200;
const READ_METHODS = new Set(['search_read', 'search_count', 'read', 'fields_get']);
/** The two things BFL may write, and nothing else (never confirm, send, cancel, edit or delete). */
export const WRITABLE_MODELS = Object.freeze(['sale.order', 'res.partner']);

/** Is this call one BFL may make? Throws OdooForbiddenError if not. */
export function assertAllowed(model, method) {
  if (READ_METHODS.has(method)) return;
  if (method === 'create' && WRITABLE_MODELS.includes(model)) return;
  throw new OdooForbiddenError(`BFL is not allowed to call ${model}.${method} on Odoo.`);
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

/** Classify an error object Odoo returned. */
function classify(err, apiKey) {
  const data = err?.data || {};
  const name = String(data.name || '');
  const message = redact(data.message || err?.message || 'Odoo returned an error', apiKey);
  // a database lock / serialization failure is transient; everything else Odoo says is a refusal
  if (/serializ|deadlock|could not obtain lock|lock timeout/i.test(`${message} ${name}`)) return new OdooUnavailableError(message, { code: 'LOCKED' });
  const code = /AccessError|AccessDenied/i.test(name) ? 'ACCESS_DENIED' : /ValidationError|UserError|MissingError/i.test(name) ? 'VALIDATION' : 'REJECTED';
  return new OdooRejectedError(message, { code, odooName: name });
}

/**
 * @param {object} opts
 * @param {string} opts.url  @param {string} opts.db  @param {string} opts.login  @param {string} opts.apiKey
 * @param {'jsonrpc'|'json2'} [opts.protocol]  @param {number} [opts.timeoutMs]  @param {number} [opts.maxPerSecond]
 * @param {Function} [opts.onCall]  called after every call with { model, method, count, ms, ok, error } (never the key)
 * @param {Function} [opts.fetchImpl]  for tests
 */
export function createOdooClient(opts) {
  const {
    url, db, login, apiKey, protocol = 'jsonrpc', timeoutMs = 15000, maxPerSecond = 4, onCall = () => {}, fetchImpl = globalThis.fetch,
  } = opts;
  if (!url || !db || !login || !apiKey) throw new OdooError('Odoo is not configured.');
  const gap = maxPerSecond > 0 ? 1000 / maxPerSecond : 0;
  let nextAt = 0;
  let uid = null;
  let nextId = 1;

  async function throttle() {
    const now = Date.now();
    const wait = Math.max(0, nextAt - now);
    nextAt = Math.max(now, nextAt) + gap;
    if (wait) await sleep(wait);
  }

  async function post(path, body, headers = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    } catch (e) {
      clearTimeout(timer);
      const why = e?.name === 'AbortError' ? `Odoo did not answer within ${timeoutMs} ms` : `Could not reach Odoo (${redact(e?.cause?.code || e?.message || 'network error', apiKey)})`;
      throw new OdooUnavailableError(why, { code: e?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK' });
    }
    try {
      if (res.status >= 500 || res.status === 429 || res.status === 408) throw new OdooUnavailableError(`Odoo answered ${res.status}`, { code: `HTTP_${res.status}` });
      const json = await res.json().catch(() => null);
      if (!res.ok && !json) throw new OdooRejectedError(`Odoo refused the call (${res.status})`, { code: `HTTP_${res.status}` });
      return { status: res.status, json };
    } finally { clearTimeout(timer); }
  }

  async function authenticate() {
    if (protocol === 'json2') return null; // the bearer key identifies the user
    const { json } = await post('/jsonrpc', { jsonrpc: '2.0', method: 'call', id: nextId++, params: { service: 'common', method: 'authenticate', args: [db, login, apiKey, {}] } });
    if (json?.error) throw classify(json.error, apiKey);
    if (!json?.result) throw new OdooRejectedError('Odoo did not accept the integration user\'s login or API key.', { code: 'ACCESS_DENIED' });
    uid = json.result;
    return uid;
  }

  /** One raw call, with the guard, the throttle, the log. */
  async function call(model, method, args = [], kwargs = {}) {
    assertAllowed(model, method);
    await throttle();
    const t0 = Date.now();
    const done = (ok, count, error) => { try { onCall({ model, method, count, ms: Date.now() - t0, ok, error: error ? redact(error, apiKey).slice(0, 300) : null }); } catch { /* logging must never break a call */ } };
    try {
      let result;
      if (protocol === 'json2') {
        const body = method === 'create' ? { vals_list: args } : (method === 'read' ? { ids: args[0], ...kwargs } : { ...(method === 'search_count' ? { domain: args[0] } : method === 'search_read' ? { domain: args[0] } : {}), ...kwargs });
        const { json } = await post(`/json/2/${model}/${method}`, body, { Authorization: `Bearer ${apiKey}`, 'X-Odoo-Database': db });
        if (json && json.error) throw classify(json.error, apiKey);
        result = json;
      } else {
        if (uid === null) await authenticate();
        const { json } = await post('/jsonrpc', { jsonrpc: '2.0', method: 'call', id: nextId++, params: { service: 'object', method: 'execute_kw', args: [db, uid, apiKey, model, method, args, kwargs] } });
        if (json?.error) throw classify(json.error, apiKey);
        result = json?.result;
      }
      done(true, Array.isArray(result) ? result.length : 1);
      return result;
    } catch (e) {
      done(false, 0, e?.message);
      throw e;
    }
  }

  return {
    protocol,
    /** Cheap "are you there" — one small read. */
    async ping() { await call('res.partner', 'search_count', [[['id', '=', 0]]]); return true; },
    /** A page (or less) of records. */
    searchRead: (model, domain = [], fields = [], { limit = PAGE_SIZE, offset = 0, order } = {}) =>
      call(model, 'search_read', [domain], { fields, limit: Math.min(limit, PAGE_SIZE), offset, ...(order ? { order } : {}) }),
    searchCount: (model, domain = []) => call(model, 'search_count', [domain]),
    read: (model, ids, fields = []) => call(model, 'read', [ids], { fields }),
    fieldsGet: (model, attributes = ['string', 'type']) => call(model, 'fields_get', [], { attributes }),
    /** Every record that matches, in pages of 200. */
    async searchReadAll(model, domain = [], fields = [], { order = 'id asc', maxRecords = 200000 } = {}) {
      const out = [];
      for (let offset = 0; offset < maxRecords; offset += PAGE_SIZE) {
        const page = await call(model, 'search_read', [domain], { fields, limit: PAGE_SIZE, offset, order });
        out.push(...page);
        if (page.length < PAGE_SIZE) break;
      }
      return out;
    },
    /** Create ONE record. Only sale.order and res.partner are allowed. Returns the new id. */
    async create(model, values) {
      const r = await call(model, 'create', [values]);
      return Array.isArray(r) ? r[0] : r;
    },
  };
}
