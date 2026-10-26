// Staff screen S05 — Sync Health & Operations Center.
//
// Shows Odoo connectivity status, data sync intervals, outbox queue with retry controls,
// automated daily reconciliation audits, database backup snapshots, and server resource metrics.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
const ago = (m) => (m === null || m === undefined ? '—' : m < 1 ? 'just now' : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`);
const formatMb = (bytes) => (bytes ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : '0 MB');
const formatUptime = (sec) => {
  const d = Math.floor(sec / 86400);
  const hr = Math.floor((sec % 86400) / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${hr}h ${min}m`;
  if (hr > 0) return `${hr}h ${min}m`;
  return `${min}m ${sec % 60}s`;
};

const MODE = {
  STAND_IN: ['Not connected to Odoo', 'The Sample Odoo stand-in is in use. Nothing is being read from, or sent to, Odoo.', 'notice'],
  CONFIGURED_SYNC_OFF: ['Odoo is configured, but syncing is off', 'Set BFL_ODOO_SYNC=on on the server to start the sync jobs and the outbox worker.', 'notice'],
  CONNECTED: ['Connected to Odoo', 'The sync jobs and the outbox worker are running.', 'okbox'],
};

export async function renderHealth(view) {
  const me = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({}));
  const isAdmin = me.staff?.role === 'ADMIN';
  const canRetry = ['ADMIN', 'SALES_MANAGER'].includes(me.staff?.role);

  const header = h('div', { style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px;' },
    h('div', null,
      h('h1', { style: 'margin: 0;' }, 'Sync Health & Operations'),
      h('p', { class: 'muted', style: 'margin: 4px 0 0;' }, 'System status, outbox queues, reconciliation audits, and automated database backups.')
    ),
    h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; align-items: center;' },
      h('button', { type: 'button', class: 'secondary', onClick: () => load() }, 'Refresh'),
      h('button', { type: 'button', class: 'secondary', onClick: () => triggerRecon() }, 'Audit Reconciliation'),
      isAdmin ? h('button', { type: 'button', class: 'primary', onClick: () => createBackup() }, 'Instant Backup') : null
    )
  );

  const body = h('div');
  setChildren(view, header, body);

  async function triggerRecon() {
    try {
      const res = await api.odooReconciliation();
      if (res.isClean) {
        toast('Reconciliation Audit Passed: 0 discrepancies.', 'ok');
      } else {
        toast(`Discrepancies found: ${res.totalDiscrepancies}`, 'warn');
      }
      await load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function createBackup() {
    try {
      toast('Creating atomic database snapshot…', 'notice');
      const b = await api.odooCreateBackup();
      toast(`Backup saved: ${b.filename} (${(b.sizeBytes / 1024).toFixed(1)} KB)`, 'ok');
      await load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function retryAllFailed() {
    try {
      const res = await api.odooRetryAll();
      toast(`Retried ${res.retriedCount} outbox item(s).`, 'ok');
      await load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function runSingleSync(type) {
    try {
      toast(`Triggering sync for ${type}…`, 'notice');
      await api.odooRunSync(type);
      toast(`Sync completed for ${type}.`, 'ok');
      await load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function load() {
    let d;
    let rec = null;
    let stats = null;
    let backupsData = null;

    try {
      [d, rec, stats, backupsData] = await Promise.all([
        api.odooHealth(),
        api.odooReconciliation().catch(() => null),
        api.odooSystemStats().catch(() => null),
        api.odooBackups().catch(() => ({ backups: [] })),
      ]);
    } catch (e) {
      setChildren(body, h('div', { class: 'card errbox' }, e.message));
      return;
    }

    const [title, text, cls] = MODE[d.mode];
    const backups = backupsData?.backups || [];

    // System stats tiles
    const statsCard = stats ? h('div', { class: 'card' },
      h('h2', null, 'System Resources & Storage'),
      h('div', { style: 'display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 10px;' },
        h('div', { class: 'notice', style: 'padding: 10px; border-radius: 6px;' },
          h('small', { class: 'muted' }, 'SQLite Database Size'),
          h('div', { style: 'font-size: 18px; font-weight: bold; margin-top: 4px;' }, formatMb(stats.dbSizeBytes)),
          h('small', { class: 'muted' }, `${stats.productCount} products · ${stats.customerCount} customers`)
        ),
        h('div', { class: 'notice', style: 'padding: 10px; border-radius: 6px;' },
          h('small', { class: 'muted' }, 'Server Runtime'),
          h('div', { style: 'font-size: 18px; font-weight: bold; margin-top: 4px;' }, stats.nodeVersion),
          h('small', { class: 'muted' }, `Uptime: ${formatUptime(stats.uptimeSeconds)}`)
        ),
        h('div', { class: 'notice', style: 'padding: 10px; border-radius: 6px;' },
          h('small', { class: 'muted' }, 'Memory Usage'),
          h('div', { style: 'font-size: 18px; font-weight: bold; margin-top: 4px;' }, formatMb(stats.heapUsedBytes)),
          h('small', { class: 'muted' }, `Process RSS: ${formatMb(stats.rssBytes)}`)
        ),
        h('div', { class: 'notice', style: 'padding: 10px; border-radius: 6px;' },
          h('small', { class: 'muted' }, 'Outbox Queue'),
          h('div', { style: 'font-size: 18px; font-weight: bold; margin-top: 4px;' }, `${stats.outboxPending} Pending`),
          h('small', { class: stats.outboxFailed > 0 ? 'err' : 'muted' }, `${stats.outboxFailed} Failed`)
        )
      )
    ) : null;

    // Database Backups Card
    const backupsCard = h('div', { class: 'card' },
      h('div', { style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;' },
        h('h2', { style: 'margin: 0;' }, 'Zero-Downtime Database Snapshots (VACUUM INTO)'),
        isAdmin ? h('button', { type: 'button', class: 'secondary', onClick: () => createBackup() }, '+ Create Snapshot Now') : null
      ),
      h('p', { class: 'muted', style: 'margin: 6px 0 12px;' }, 'Atomic point-in-time SQLite backups with automated 7-day retention pruning.'),
      backups.length ? h('div', { class: 'exp-wrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['Backup Archive', 'Size', 'Created At'].map((t) => h('th', null, t)))),
          h('tbody', null, backups.map((b) => h('tr', null,
            h('td', null, h('b', null, b.filename)),
            h('td', { class: 'num' }, `${(b.sizeBytes / 1024).toFixed(1)} KB`),
            h('td', null, when(b.createdAt))
          )))
        )
      ) : h('p', { class: 'muted' }, 'No backup files stored yet. Click "Create Snapshot Now" or wait for the daily automated backup.')
    );

    // Outbox Card with Batch Retry
    const failedCount = d.outbox.summary.FAILED || 0;
    const outboxHeader = h('div', { style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;' },
      h('h2', { style: 'margin: 0;' }, 'Outbox: What BFL Sends to Odoo'),
      (failedCount > 0 && canRetry) ? h('button', { type: 'button', class: 'secondary', onClick: () => retryAllFailed() }, `Retry All Failed (${failedCount})`) : null
    );

    const outboxCard = h('div', { class: 'card' },
      outboxHeader,
      h('p', null, `Pending ${d.outbox.summary.PENDING} · sent ${d.outbox.summary.SENT} · failed ${failedCount}. Only draft quotations and approved new customers are ever sent.`),
      d.outbox.queue.length ? h('div', { class: 'exp-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['What', 'Reference', 'Status', 'Tries', 'Next try', 'Reason', ''].map((t) => h('th', null, t)))),
        h('tbody', null, d.outbox.queue.map((q) => h('tr', null,
          h('td', null, q.kind === 'CREATE_PARTNER' ? 'New customer' : 'Quotation'),
          h('td', null, q.ref.replace(/^(quotation|partner):/, '')),
          h('td', null, h('span', { class: `badge${q.status === 'FAILED' ? ' err' : ''}` }, q.status === 'FAILED' ? 'Failed' : 'Pending')),
          h('td', { class: 'num' }, String(q.attempts)),
          h('td', null, q.nextAttemptAt ? when(q.nextAttemptAt) : '—'),
          h('td', { class: 'muted' }, q.error || '—'),
          h('td', null, q.status === 'FAILED' && canRetry ? h('button', { type: 'button', class: 'secondary', onClick: () => retry(q.id) }, 'Retry') : null)
        )))
      )) : h('p', { class: 'muted' }, 'Nothing is waiting.')
    );

    // Data Syncs Card with manual triggers
    const syncCard = h('div', { class: 'card' },
      h('h2', null, 'Data Syncs'),
      h('div', { class: 'exp-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Data', 'Every', 'Last good run', 'Records', 'Runs ok / failed', 'Last error', ''].map((t) => h('th', null, t)))),
        h('tbody', null, d.sync.map((s) => h('tr', null,
          h('td', null, h('b', null, s.label), s.stale ? h('span', { class: 'badge err' }, ' stale') : null),
          h('td', null, `${s.intervalMinutes} min`),
          h('td', null, s.lastSuccessAt ? `${when(s.lastSuccessAt)} (${ago(s.ageMinutes)})` : 'never'),
          h('td', { class: 'num' }, String(s.recordsLast)),
          h('td', null, `${s.runsOk} / ${s.runsFailed}`),
          h('td', { class: 'muted' }, s.lastError || '—'),
          h('td', null, isAdmin && s.type ? h('button', { type: 'button', class: 'secondary', onClick: () => runSingleSync(s.type) }, 'Sync now') : null)
        )))
      ))
    );

    setChildren(body,
      h('div', { class: cls },
        h('b', null, `${title}. `), text,
        d.config.configured ? h('span', { class: 'muted' }, ` ${d.config.url} · database ${d.config.db} · user ${d.config.login} · ${d.config.protocol}`) : null
      ),
      d.alerts.length ? h('div', { class: 'card' },
        h('h2', null, 'Needs attention'),
        h('ul', null, d.alerts.map((a) => h('li', { class: a.level === 'red' ? 'err' : 'warn' }, a.message)))
      ) : null,
      statsCard,
      rec ? h('div', { class: 'card' },
        h('div', { style: 'display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;' },
          h('h2', { style: 'margin: 0;' }, 'Daily Reconciliation (BFL vs Odoo)'),
          h('button', { type: 'button', class: 'secondary', onClick: () => triggerRecon() }, 'Scan Now')
        ),
        rec.isClean
          ? h('div', { class: 'okbox', style: 'margin-top: 10px;' }, h('b', null, 'Reconciliation Clean: '), '0 discrepancies across Outbox, Quotations, and Finances.')
          : h('div', { class: 'card', style: 'margin-top: 10px;' },
              h('p', { class: 'warn' }, h('b', null, `Discrepancies detected: ${rec.totalDiscrepancies}`)),
              rec.summary.outboxAnomaliesCount ? h('p', null, `• Outbox anomalies: ${rec.summary.outboxAnomaliesCount} (failed or pending > 2 hours)`) : null,
              rec.summary.unlinkedRequestsCount ? h('p', null, `• Unlinked customer requests: ${rec.summary.unlinkedRequestsCount}`) : null,
              rec.summary.missingOdooNumberCount ? h('p', null, `• Orders waiting for Odoo number: ${rec.summary.missingOdooNumberCount}`) : null,
              rec.summary.staleSyncCount ? h('p', null, `• Stale sync jobs: ${rec.summary.staleSyncCount}`) : null
            )
      ) : null,
      backupsCard,
      h('div', { class: 'card' },
        h('h2', null, 'Odoo Connection Details'),
        h('p', null, 'Last answered: ', h('b', null, d.odoo.lastAnswerAt ? `${when(d.odoo.lastAnswerAt)} (${ago(d.odoo.minutesSinceAnswer)})` : 'never')),
        d.odoo.lastError ? h('p', { class: 'muted' }, `Last failed call: ${d.odoo.lastError.model}.${d.odoo.lastError.method} at ${when(d.odoo.lastError.at)} — ${d.odoo.lastError.error}`) : null,
        h('p', { class: 'muted' }, 'Kill switch: disable the integration user in Odoo. Orders keep queueing and send themselves when it is back.')
      ),
      syncCard,
      outboxCard,
      d.changes.length ? h('div', { class: 'card' },
        h('h2', null, 'Recent Sync Changes'),
        h('p', { class: 'muted' }, 'Customers linked by name, products or customers BFL does not know, anything deactivated. Linked-by-name and ambiguous names need a person.'),
        h('ul', null, d.changes.map((c) => h('li', null, `${when(c.at)} — ${c.type}: ${c.change}${c.detail ? ` — ${c.detail}` : ''}`)))
      ) : null,
      d.calls.length ? h('div', { class: 'card' },
        h('h2', null, 'Recent Calls to Odoo'),
        h('div', { class: 'exp-wrap' }, h('table', null,
          h('thead', null, h('tr', null, ['When', 'Call', 'Records', 'Time', 'Result'].map((t) => h('th', null, t)))),
          h('tbody', null, d.calls.map((c) => h('tr', null,
            h('td', null, when(c.at)),
            h('td', null, `${c.model}.${c.method}`),
            h('td', { class: 'num' }, c.count ?? '—'),
            h('td', { class: 'num' }, c.ms === null ? '—' : `${c.ms} ms`),
            h('td', null, c.ok ? 'ok' : h('span', { class: 'err' }, c.error || 'failed'))
          )))
        ))
      ) : null
    );
  }

  async function retry(id) {
    try { await api.odooRetry(id); toast('Put back in the queue.', 'ok'); await load(); } catch (e) { toast(e.message, 'err'); }
  }

  await load();
  clearInterval(view.healthTimer);
  view.healthTimer = setInterval(() => { if (!view.isConnected || location.hash.split('/')[1] !== 'health') { clearInterval(view.healthTimer); return; } load(); }, 15000);
}
