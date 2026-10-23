// A FAKE Odoo for automated tests (and for trying the sync on a laptop). It answers like Odoo over HTTP —
// the `execute_kw` JSON-RPC transport and the newer bearer-key `/json/2/` transport — and it can misbehave on
// purpose, so the outbox, the retries and the duplicate checks are tested against failure, not just success:
//   - fakeOdoo.fail('timeout' | 'http500' | 'http429' | 'locked' | 'reject:<message>' | 'lose-response', { times, only })
//       timeout        holds the answer past the client's timeout
//       http500        answers 500
//       lose-response  PERFORMS the call, then drops the connection — the classic "it was created but we never
//                      heard back", which is how a duplicate quotation would happen if the worker did not check
//   - fakeOdoo.setDown(true)  the whole server refuses connections' worth of 503s
// It also enforces the integration user's rights: only the reads and the two creates are allowed; write, unlink
// and any action_* method answer AccessError, exactly as the real user's rights should.
import http from 'node:http';

const READS = new Set(['search_read', 'search_count', 'read', 'fields_get']);
const WRITES = new Set(['sale.order', 'res.partner']);

function match(rec, domain) {
  return domain.every((term) => {
    if (!Array.isArray(term)) return true;
    const [field, op, value] = term;
    let v = rec[field];
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number') v = v[0]; // many2one -> id
    switch (op) {
      case '=': return v === value || (value === false && (v === false || v === null || v === undefined));
      case '!=': return v !== value;
      case '>': return v > value;
      case '>=': return v >= value;
      case '<': return v < value;
      case '<=': return v <= value;
      case 'in': return value.includes(v);
      case 'not in': return !value.includes(v);
      case 'ilike': return String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
      default: throw new Error(`fake Odoo: unsupported operator ${op}`);
    }
  });
}

export class FakeOdoo {
  constructor({ db = 'bfl_test', login = 'bfl-integration', apiKey = 'test-key-123' } = {}) {
    this.db = db; this.login = login; this.apiKey = apiKey;
    this.uid = 7;
    this.models = {
      'res.partner': [], 'product.product': [], 'sale.order': [], 'res.users': [], 'product.pricelist': [], 'account.move': [], 'account.payment': [],
    };
    this.seq = { 'res.partner': 1000, 'product.product': 5000, 'sale.order': 0, 'res.users': 20, 'product.pricelist': 1 };
    this.faults = [];
    this.down = false;
    this.calls = [];          // every call made: { model, method }
    this.delayMs = 0;
    this.clock = () => new Date();
  }

  stamp() { return this.clock().toISOString().replace('T', ' ').slice(0, 19); }

  /** Add a record to a model (as the Odoo side's own data). */
  add(model, rec) {
    const id = rec.id ?? ++this.seq[model];
    const row = { active: true, write_date: this.stamp(), ...rec, id };
    this.models[model].push(row);
    return row;
  }

  /** Change a record as someone in Odoo would. */
  touch(model, id, patch) {
    const r = this.models[model].find((x) => x.id === id);
    Object.assign(r, patch, { write_date: this.stamp() });
    return r;
  }

  /** Make the next `times` calls misbehave. `only` limits it to 'create' or 'read'. */
  fail(kind, { times = 1, only = null } = {}) { this.faults.push({ kind, times, only }); }
  setDown(v) { this.down = Boolean(v); }
  created(model) { return this.models[model].filter((r) => r._createdByBfl); }

  nextFault(method) {
    const write = method === 'create';
    const f = this.faults.find((x) => x.times > 0 && (!x.only || (x.only === 'create') === write));
    if (f) f.times -= 1;
    return f || null;
  }

  // ---- the model methods --------------------------------------------------------------------
  exec(model, method, args, kwargs = {}) {
    this.calls.push({ model, method });
    const rows = this.models[model];
    if (!rows) throw { name: 'odoo.exceptions.UserError', message: `Object ${model} doesn't exist` };
    const allowed = READS.has(method) || (method === 'create' && WRITES.has(model));
    if (!allowed) throw { name: 'odoo.exceptions.AccessError', message: `You are not allowed to ${method} on ${model} (integration user).` };
    if (method === 'search_count') return rows.filter((r) => match(r, args[0] || [])).length;
    if (method === 'fields_get') return {};
    if (method === 'read') return rows.filter((r) => args[0].includes(r.id)).map((r) => this.project(r, kwargs.fields));
    if (method === 'search_read') {
      let found = rows.filter((r) => match(r, args[0] || []) && (r.active !== false || (args[0] || []).some((t) => t[0] === 'active')));
      const order = String(kwargs.order || 'id asc').split(',')[0].trim().split(/\s+/);
      const dir = order[1] === 'desc' ? -1 : 1;
      found = [...found].sort((a, b) => (a[order[0]] > b[order[0]] ? dir : a[order[0]] < b[order[0]] ? -dir : 0));
      const off = kwargs.offset || 0;
      return found.slice(off, kwargs.limit ? off + kwargs.limit : undefined).map((r) => this.project(r, kwargs.fields));
    }
    return this.create(model, args[0]);
  }

  project(r, fields) {
    if (!fields || !fields.length) return { ...r };
    const o = { id: r.id };
    for (const f of fields) o[f] = r[f] === undefined ? false : r[f];
    return o;
  }

  create(model, values) {
    if (model === 'sale.order') {
      for (const cmd of values.order_line || []) {
        const prod = this.models['product.product'].find((p) => p.id === cmd[2].product_id);
        if (!prod) throw { name: 'odoo.exceptions.MissingError', message: `Product ${cmd[2].product_id} does not exist` };
        if (prod.active === false) throw { name: 'odoo.exceptions.UserError', message: `The product "${prod.name}" is archived and cannot be sold.` };
      }
      if (!this.models['res.partner'].some((p) => p.id === values.partner_id)) throw { name: 'odoo.exceptions.ValidationError', message: 'The customer does not exist.' };
      const n = ++this.seq['sale.order'];
      const total = (values.order_line || []).reduce((s, c) => s + c[2].product_uom_qty * 10, 0);
      return this.add('sale.order', { ...values, id: undefined, name: `S${String(n).padStart(5, '0')}`, state: 'draft', amount_total: total, amount_untaxed: total, _createdByBfl: true }).id;
    }
    const n = ++this.seq['res.partner'];
    return this.add('res.partner', { ...values, id: n, _createdByBfl: true }).id;
  }

  // ---- the HTTP face ------------------------------------------------------------------------
  async handle(path, headers, body) {
    if (this.down) return { status: 503, json: { error: 'down' } };
    if (path === '/jsonrpc') {
      const { service, method, args } = body.params || {};
      if (service === 'common' && method === 'authenticate') {
        const [db, login, key] = args;
        return { status: 200, json: { jsonrpc: '2.0', id: body.id, result: db === this.db && login === this.login && key === this.apiKey ? this.uid : false } };
      }
      if (service === 'object' && method === 'execute_kw') {
        const [db, uid, key, model, m, a, kw] = args;
        if (db !== this.db || uid !== this.uid || key !== this.apiKey) return { status: 200, json: { jsonrpc: '2.0', id: body.id, error: { code: 100, message: 'Odoo Session Expired', data: { name: 'odoo.http.SessionExpiredException', message: 'Access denied' } } } };
        return this.run(m, () => this.exec(model, m, a, kw), body.id);
      }
    }
    const j2 = /^\/json\/2\/([\w.]+)\/(\w+)$/.exec(path);
    if (j2) {
      if (headers.authorization !== `Bearer ${this.apiKey}` || headers['x-odoo-database'] !== this.db) return { status: 401, json: { error: { message: 'Invalid API key' } } };
      const [, model, m] = j2;
      const args = m === 'create' ? body.vals_list : m === 'read' ? [body.ids] : [body.domain || []];
      const kwargs = { ...body }; delete kwargs.domain; delete kwargs.vals_list; delete kwargs.ids;
      const out = await this.run(m, () => (m === 'create' ? body.vals_list.map((v) => this.exec(model, 'create', [v])) : this.exec(model, m, args, kwargs)), 0);
      return out.json.error ? { status: 422, json: { error: out.json.error } } : { status: 200, json: out.json.result };
    }
    return { status: 404, json: {} };
  }

  async run(method, fn, id) {
    const fault = this.nextFault(method);
    if (fault) {
      if (fault.kind === 'http500') return { status: 500, json: {} };
      if (fault.kind === 'http429') return { status: 429, json: {} };
      if (fault.kind === 'locked') return { status: 200, json: { jsonrpc: '2.0', id, error: { code: 200, message: 'could not serialize access due to concurrent update', data: { name: 'psycopg2.errors.SerializationFailure', message: 'could not serialize access due to concurrent update' } } } };
      if (fault.kind === 'timeout') await new Promise((r) => { setTimeout(r, 400); });
      if (fault.kind.startsWith('reject:')) return { status: 200, json: { jsonrpc: '2.0', id, error: { code: 200, message: fault.kind.slice(7), data: { name: 'odoo.exceptions.UserError', message: fault.kind.slice(7) } } } };
      if (fault.kind === 'lose-response') { fn(); return { status: 'drop' }; }
    }
    if (this.delayMs) await new Promise((r) => { setTimeout(r, this.delayMs); });
    try { return { status: 200, json: { jsonrpc: '2.0', id, result: fn() } }; } catch (e) {
      return { status: 200, json: { jsonrpc: '2.0', id, error: { code: 200, message: e.message || String(e), data: { name: e.name || 'odoo.exceptions.UserError', message: e.message || String(e) } } } };
    }
  }

  /** Start listening on a free port; returns the base URL. */
  async start(port = 0) {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', async () => {
        let out;
        try { out = await this.handle(req.url, req.headers, raw ? JSON.parse(raw) : {}); } catch (e) { out = { status: 500, json: { error: String(e.message || e) } }; }
        if (out.status === 'drop') { req.socket.destroy(); return; }
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    await new Promise((r) => this.server.listen(port, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  async stop() {
    this.server?.closeAllConnections?.();
    await new Promise((r) => { if (this.server) this.server.close(r); else r(); });
  }
}
