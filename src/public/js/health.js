// Staff screen S05 — Sync health.
//
// Is Odoo reachable, when did each kind of data last sync, what is waiting in the outbox, and what needs a
// person. Until Odoo is connected the screen says so plainly: the Sample Odoo stand-in is in use and nothing
// is being read from or sent to Odoo. A FAILED outbox entry shows Odoo's reason and a Retry button (it keeps
// its reference, so retrying cannot create a duplicate). The kill switch is in Odoo: disable the integration
// user, and orders queue until it is back. The API key is never shown here.
//
// No field is typed into on this screen, so it simply refreshes itself.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const ago = (m) => (m === null || m === undefined ? '—' : m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`);
const MODE = {
  STAND_IN: ['Not connected to Odoo', 'The Sample Odoo stand-in is in use. Nothing is being read from, or sent to, Odoo.', 'notice'],
  CONFIGURED_SYNC_OFF: ['Odoo is configured, but syncing is off', 'Set BFL_ODOO_SYNC=on on the server to start the sync jobs and the outbox worker.', 'notice'],
  CONNECTED: ['Connected to Odoo', 'The sync jobs and the outbox worker are running.', 'okbox'],
};

export async function renderHealth(view) {
  const me = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({}));
  const canRetry = ['ADMIN', 'SALES_MANAGER'].includes(me.staff?.role);
  const body = h('div');
  setChildren(view, h('h1', null, 'Sync health'), body);

  async function load() {
    let d;
    try { d = await api.odooHealth(); } catch (e) { setChildren(body, h('div', { class: 'card errbox' }, e.message)); return; }
    const [title, text, cls] = MODE[d.mode];
    setChildren(body,
      h('div', { class: cls }, h('b', null, `${title}. `), text,
        d.config.configured ? h('span', { class: 'muted' }, ` ${d.config.url} · database ${d.config.db} · user ${d.config.login} · ${d.config.protocol}`) : null),
      d.alerts.length ? h('div', { class: 'card' }, h('h2', null, 'Needs attention'),
        h('ul', null, d.alerts.map((a) => h('li', { class: a.level === 'red' ? 'err' : 'warn' }, a.message)))) : null,
      h('div', { class: 'card' },
        h('h2', null, 'Odoo'),
        h('p', null, 'Last answered: ', h('b', null, d.odoo.lastAnswerAt ? `${when(d.odoo.lastAnswerAt)} (${ago(d.odoo.minutesSinceAnswer)})` : 'never')),
        d.odoo.lastError ? h('p', { class: 'muted' }, `Last failed call: ${d.odoo.lastError.model}.${d.odoo.lastError.method} at ${when(d.odoo.lastError.at)} — ${d.odoo.lastError.error}`) : null,
        h('p', { class: 'muted' }, 'Kill switch: disable the integration user in Odoo. Orders keep queueing and send themselves when it is back.')),
      h('div', { class: 'card' },
        h('h2', null, 'Data syncs'),
        h('div', { class: 'exp-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['Data', 'Every', 'Last good run', 'Records', 'Runs ok / failed', 'Last error'].map((t) => h('th', null, t)))),
          h('tbody', null, d.sync.map((s) => h('tr', null,
            h('td', null, h('b', null, s.label), s.stale ? h('span', { class: 'badge err' }, ' stale') : null), h('td', null, `${s.intervalMinutes} min`),
            h('td', null, s.lastSuccessAt ? `${when(s.lastSuccessAt)} (${ago(s.ageMinutes)})` : 'never'), h('td', { class: 'num' }, String(s.recordsLast)),
            h('td', null, `${s.runsOk} / ${s.runsFailed}`), h('td', { class: 'muted' }, s.lastError || '—'))))))),
      h('div', { class: 'card' },
        h('h2', null, 'Outbox: what BFL sends to Odoo'),
        h('p', null, `Pending ${d.outbox.summary.PENDING} · sent ${d.outbox.summary.SENT} · failed ${d.outbox.summary.FAILED}. Only draft quotations and approved new customers are ever sent.`),
        d.outbox.queue.length ? h('div', { class: 'exp-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['What', 'Reference', 'Status', 'Tries', 'Next try', 'Reason', ''].map((t) => h('th', null, t)))),
          h('tbody', null, d.outbox.queue.map((q) => h('tr', null,
            h('td', null, q.kind === 'CREATE_PARTNER' ? 'New customer' : 'Quotation'), h('td', null, q.ref.replace(/^(quotation|partner):/, '')),
            h('td', null, h('span', { class: `badge${q.status === 'FAILED' ? ' err' : ''}` }, q.status === 'FAILED' ? 'Failed' : 'Pending')),
            h('td', { class: 'num' }, String(q.attempts)), h('td', null, q.nextAttemptAt ? when(q.nextAttemptAt) : '—'), h('td', { class: 'muted' }, q.error || '—'),
            h('td', null, q.status === 'FAILED' && canRetry ? h('button', { type: 'button', class: 'secondary', onClick: () => retry(q.id) }, 'Retry') : null)))))) : h('p', { class: 'muted' }, 'Nothing is waiting.')),
      d.changes.length ? h('div', { class: 'card' }, h('h2', null, 'Recent sync changes'),
        h('p', { class: 'muted' }, 'Customers linked by name, products or customers BFL does not know, anything deactivated. Linked-by-name and ambiguous names need a person.'),
        h('ul', null, d.changes.map((c) => h('li', null, `${when(c.at)} — ${c.type}: ${c.change}${c.detail ? ` — ${c.detail}` : ''}`)))) : null,
      d.calls.length ? h('div', { class: 'card' }, h('h2', null, 'Recent calls to Odoo'),
        h('div', { class: 'exp-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['When', 'Call', 'Records', 'Time', 'Result'].map((t) => h('th', null, t)))),
          h('tbody', null, d.calls.map((c) => h('tr', null, h('td', null, when(c.at)), h('td', null, `${c.model}.${c.method}`), h('td', { class: 'num' }, c.count ?? '—'), h('td', { class: 'num' }, c.ms === null ? '—' : `${c.ms} ms`),
            h('td', null, c.ok ? 'ok' : h('span', { class: 'err' }, c.error || 'failed')))))))) : null);
  }

  async function retry(id) {
    try { await api.odooRetry(id); toast('Put back in the queue.', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  await load();
  clearInterval(view.healthTimer);
  view.healthTimer = setInterval(() => { if (!view.isConnected || location.hash.split('/')[1] !== 'health') { clearInterval(view.healthTimer); return; } load(); }, 15000);
}
