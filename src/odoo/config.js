// How BFL is told to reach Odoo. Everything comes from the server's environment (in practice `.env.local`
// locally and the host's secret configuration in production) — never from Git, the database or a browser.
// The API key is read here ONCE, handed to the client, and never logged, returned or put in an error.
//
//   BFL_ODOO_URL            https://odoo.example.com           (no trailing path)
//   BFL_ODOO_DB             the Odoo database name
//   BFL_ODOO_LOGIN          the integration user's login, e.g. bfl-integration
//   BFL_ODOO_API_KEY        that user's API key
//   BFL_ODOO_PROTOCOL       jsonrpc (default; execute_kw) or json2 (bearer-key JSON API, newer Odoo)
//   BFL_ODOO_CASH_PARTNER_ID  the Odoo id of the SHARED cash customer account
//   BFL_ODOO_TIMEOUT_MS     per-call timeout (default 15000)
//   BFL_ODOO_SYNC           "on" to start the scheduled sync jobs and the outbox worker
//
// Until all of the first four are set, Odoo is "not configured": the Sample Odoo stand-in is what the
// screens use, and nothing here makes a network call.
export function odooConfig(env = process.env) {
  const url = String(env.BFL_ODOO_URL || '').trim().replace(/\/+$/, '');
  const db = String(env.BFL_ODOO_DB || '').trim();
  const login = String(env.BFL_ODOO_LOGIN || '').trim();
  const apiKey = String(env.BFL_ODOO_API_KEY || '');
  const protocol = String(env.BFL_ODOO_PROTOCOL || 'jsonrpc').trim().toLowerCase();
  return {
    configured: Boolean(url && db && login && apiKey),
    url, db, login, apiKey,
    protocol: protocol === 'json2' ? 'json2' : 'jsonrpc',
    cashPartnerId: env.BFL_ODOO_CASH_PARTNER_ID ? Number(env.BFL_ODOO_CASH_PARTNER_ID) : null,
    timeoutMs: Number(env.BFL_ODOO_TIMEOUT_MS) > 0 ? Number(env.BFL_ODOO_TIMEOUT_MS) : 15000,
    syncOn: String(env.BFL_ODOO_SYNC || '').toLowerCase() === 'on',
  };
}

/** A copy of the config that is safe to show or log: the key is never in it. */
export function publicOdooConfig(cfg = odooConfig()) {
  return {
    configured: cfg.configured, url: cfg.url || null, db: cfg.db || null, login: cfg.login || null,
    protocol: cfg.protocol, hasKey: Boolean(cfg.apiKey), cashPartnerId: cfg.cashPartnerId, syncOn: cfg.syncOn,
  };
}

/** Remove a key (and anything that looks like a bearer token) from text before it is logged or shown. */
export function redact(text, apiKey) {
  let s = String(text ?? '');
  if (apiKey) s = s.split(apiKey).join('[key]');
  return s.replace(/Bearer\s+\S+/gi, 'Bearer [key]');
}
