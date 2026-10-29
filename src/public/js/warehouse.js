// Warehouse home (WAREHOUSE role and the administrator): one glance at stock and expiry,
// with a way into the working screens. Every number is read from the existing staff APIs —
// products and stock bands from /api/products, lots and expiry bands from /api/expiry (S03),
// returns from /api/returns (S04), stock-data refreshes from /api/imports.
// Nothing here writes to the inventory; the warehouse's write screens stay where they are.
import { api, num } from './api.js';
import { h, setChildren } from './lib/dom.js';

// a hero stat card as a link into the working screen behind the figure
const heroCard = ({ label, value, sub, href }) => h('a', { class: 'bfl-hero', href },
  h('span', { class: 'bfl-hero-label' }, label),
  h('b', { class: 'bfl-hero-value' }, value),
  h('span', { class: 'bfl-hero-sub' }, sub));

/** "12 days left" / "Expired 3 days ago" / "No expiry date" for a lot's days-left figure. */
const leftText = (d) => (d === null || d === undefined ? 'No expiry date'
  : d < 0 ? `Expired ${-d} day${d === -1 ? '' : 's'} ago`
    : d === 0 ? 'Expires today' : `${d} day${d === 1 ? '' : 's'} left`);

/** The compact form for the Stock Overview table: "12 days" / "Expired" / "Today". */
const leftShort = (d) => (d === null || d === undefined ? '—'
  : d < 0 ? 'Expired' : d === 0 ? 'Today' : `${d} day${d === 1 ? '' : 's'}`);

const BAND_ROWS = [
  ['EXPIRED', 'Expired', 'error', 'Past the expiry date — never sold on BFL'],
  ['CRITICAL', 'Critical', 'error', 'A week or less left'],
  ['WARNING', 'Warning', 'warning', 'The one-to-two-month warning window'],
  ['EARLY', 'Early warning', '', 'Approaching the warning window'],
  ['OK', 'In date', 'success', ' comfortably within date'],
  ['NO_DATE', 'No expiry date', 'neutral', 'Not a perishable lot'],
];

const money = (v) => (v === null || v === undefined ? '—'
  : `GHS ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const dateTime = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');

/** "Good morning" / "Good afternoon" / "Good evening" for the local hour. */
const greeting = (now = new Date()) => {
  const hour = now.getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
};

export async function renderWarehouseHome(view) {
  const hero = h('div', { class: 'bfl-hero-grid', role: 'status', 'aria-label': 'Loading stock overview' },
    h('div', { class: 'bfl-skeleton' }, h('i'), h('i'), h('i')));
  const split = h('div');
  const expiryPanel = h('div');
  const dataPanel = h('div');
  setChildren(view,
    h('h1', null, `${greeting()}, Warehouse Team`),
    h('p', { class: 'muted' }, 'Here\'s your stock overview. The working screens are one tap away.'),
    hero, split, expiryPanel, dataPanel);

  // four cheap count queries against the existing products API (limit 1: only the total is read)
  const count = (params) => api.products({ filter: 'active', limit: 1, ...params }).then((d) => d.total);
  const [active, inStock, limited, out, expiry, returns, imports] = await Promise.all([
    count({}), count({ stock: 'in' }), count({ stock: 'limited' }), count({ stock: 'out' }),
    api.expiry().catch(() => null),
    api.returns().catch(() => null),
    api.imports().catch(() => null),
  ]);

  const counts = expiry?.summary?.counts || {};
  const values = expiry?.summary?.value || {};
  const expiringSoon = (counts.CRITICAL || 0) + (counts.WARNING || 0) + (counts.EARLY || 0);
  const returnsOpen = returns?.counts ? returns.counts.unclassified : null;

  setChildren(hero,
    heroCard({ label: 'Total Stock Items', value: num(active), sub: `${num(inStock)} in stock`, href: '#/products' }),
    heroCard({ label: 'Low Stock Items', value: num(limited + out), sub: `${num(limited)} limited · ${num(out)} out of stock`, href: '#/products' }),
    heroCard({ label: 'Expiring Soon', value: num(expiringSoon), sub: `${num(counts.EXPIRED || 0)} already expired`, href: '#/expiry' }),
    heroCard({ label: 'Returns to Classify', value: returnsOpen === null ? '—' : num(returnsOpen), sub: 'Waiting for a warehouse decision', href: '#/returns' }));
  hero.removeAttribute('role');
  hero.removeAttribute('aria-label');

  // Stock Overview: the lots grouped by product, soonest expiry first; Expiry Alerts: the
  // handful of lots closest to their date, each with a way into the full expiry list.
  const rows = Array.isArray(expiry?.rows) ? expiry.rows : [];
  const byProduct = new Map();
  for (const r of rows) {
    const cur = byProduct.get(r.productName) || { product: r.productName, cartons: 0, daysLeft: null };
    cur.cartons += Number(r.cartons) || 0;
    if (r.daysLeft !== null && r.daysLeft !== undefined) {
      cur.daysLeft = cur.daysLeft === null ? r.daysLeft : Math.min(cur.daysLeft, r.daysLeft);
    }
    byProduct.set(r.productName, cur);
  }
  const overview = [...byProduct.values()]
    .sort((a, b) => (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY))
    .slice(0, 6);
  const alerts = rows
    .filter((r) => ['EXPIRED', 'CRITICAL', 'WARNING', 'EARLY'].includes(r.band))
    .sort((a, b) => (a.daysLeft ?? Number.POSITIVE_INFINITY) - (b.daysLeft ?? Number.POSITIVE_INFINITY))
    .slice(0, 5);
  const alertTone = (band) => (band === 'EXPIRED' || band === 'CRITICAL' ? 'error' : band === 'WARNING' ? 'warning' : '');

  setChildren(split,
    h('div', { class: 'bfl-split' },
      h('section', { class: 'bfl-panel' },
        h('div', { class: 'bfl-panel-head' },
          h('div', null, h('h2', null, 'Stock Overview'),
            h('p', null, expiry?.source === 'SAMPLE' ? 'Sample lots until the Odoo lot sync exists — soonest expiry first.' : 'Products with the soonest-expiring lots first.')),
          h('a', { class: 'bfl-btn secondary', href: '#/expiry' }, 'View all')),
        expiry ? (overview.length ? h('div', { class: 'bfl-table-wrap' }, h('table', { class: 'bfl-table' },
          h('thead', null, h('tr', null, [h('th', null, 'Product'), h('th', { class: 'num' }, 'In Stock'), h('th', { class: 'num' }, 'Expiry')])),
          h('tbody', null, overview.map((p) => h('tr', null,
            h('td', { class: 'primary-text' }, h('span', { class: 'bfl-ellipsis', title: p.product }, p.product)),
            h('td', { class: 'num' }, `${num(p.cartons)} CTN`),
            h('td', { class: 'num' }, leftShort(p.daysLeft)))))))
          : h('div', { class: 'bfl-empty' }, h('p', null, h('b', null, 'No lots on record')), h('p', null, 'Lots appear here once stock with expiry dates is loaded.')))
          : h('div', { class: 'bfl-empty' }, h('p', null, h('b', null, 'The expiry list is not available')), h('p', null, 'Your role may not include it, or the data has not loaded yet.'))),
      h('section', { class: 'bfl-panel' },
        h('div', { class: 'bfl-panel-head' },
          h('div', null, h('h2', null, 'Expiry Alerts'), h('p', null, 'The lots closest to their expiry date.'))),
        expiry ? (alerts.length ? h('ul', { class: 'bfl-alert-list' }, alerts.map((r) => h('li', { class: 'bfl-alert-row' },
          h('span', { class: `bfl-alert-dot ${alertTone(r.band)}`.trim(), 'aria-hidden': 'true' }),
          h('span', { class: 'bfl-alert-text' }, h('b', null, r.productName), h('span', null, `${leftText(r.daysLeft)} · ${num(r.cartons)} CTN`)),
          h('a', { class: 'bfl-alert-act', href: '#/expiry' }, 'Check stock'))))
          : h('div', { class: 'bfl-empty' }, h('p', null, h('b', null, 'Nothing expiring soon')), h('p', null, 'No lots are inside a warning window.')))
          : h('div', { class: 'bfl-empty' }, h('p', null, h('b', null, 'The expiry list is not available')), h('p', null, 'Your role may not include it, or the data has not loaded yet.')))));

  // expiry bands, with the value at risk where the list provides it
  setChildren(expiryPanel,
    h('section', { class: 'bfl-panel', style: { marginBottom: '18px' } },
      h('div', { class: 'bfl-panel-head' },
        h('div', null, h('h2', null, 'Expiry tracking'), h('p', null, expiry?.source === 'SAMPLE' ? 'Sample lots until the Odoo lot sync exists.' : `Lots as of ${expiry?.asOf || 'today'}.`)),
        h('a', { class: 'bfl-btn secondary', href: '#/expiry' }, 'Open the expiry list')),
      expiry ? h('div', { class: 'bfl-table-wrap' }, h('table', { class: 'bfl-table' },
        h('thead', null, h('tr', null, ['Band', 'Lots', 'Value at risk', ''].map((t, i) => h('th', { class: i === 1 || i === 2 ? 'num' : null }, t)))),
        h('tbody', null, BAND_ROWS.map(([code, label, tone, hint]) => h('tr', null,
          h('td', null, h('span', { class: `bfl-badge ${tone}`.trim() }, label), h('span', { class: 'bfl-panel-sub', style: { margin: '0 0 0 8px' } }, hint.trim())),
          h('td', { class: 'num' }, num(counts[code] || 0)),
          h('td', { class: 'num' }, values[code] === undefined ? '—' : money(values[code])),
          h('td', { class: 'num' }, h('a', { class: 'bfl-btn secondary', href: `#/expiry?band=${code}`, style: { minHeight: '30px', fontSize: '12px' } }, 'View')))))))
        : h('div', { class: 'bfl-empty' }, h('p', null, h('b', null, 'The expiry list is not available')), h('p', null, 'Your role may not include it, or the data has not loaded yet.')),
      expiry?.summary?.needsAction ? h('p', { class: 'bfl-note warning', style: { marginTop: '12px' } },
        h('p', null, h('b', null, `${num(expiry.summary.needsAction)} lots need a decision${expiry.summary.overdue ? ` — ${num(expiry.summary.overdue)} overdue` : ''}.`))) : null));

  // stock data refreshes (the closest thing to stock movements the system records today)
  const latest = Array.isArray(imports?.items) ? imports.items[0] : null;
  setChildren(dataPanel,
    h('section', { class: 'bfl-panel' },
      h('div', { class: 'bfl-panel-head' },
        h('div', null, h('h2', null, 'Stock data'), h('p', null, 'Stock figures come from the product import; individual stock movements are not recorded in this system yet.')),
        h('a', { class: 'bfl-btn secondary', href: '#/imports' }, 'Open imports')),
      latest ? h('div', { class: 'bfl-target-grid' },
        h('div', { class: 'bfl-target-stat' }, h('span', null, 'Latest refresh'), h('b', null, latest.filename || `Import ${latest.id}`)),
        h('div', { class: 'bfl-target-stat' }, h('span', null, 'Started'), h('b', null, dateTime(latest.imported_at || latest.importedAt))),
        h('div', { class: 'bfl-target-stat' }, h('span', null, 'Status'), h('b', null, latest.status || '—')))
        : h('div', { class: 'bfl-empty' }, h('p', null, h('b', null, 'No stock import yet')), h('p', null, 'Run a product import to load stock figures.'))));
}
