// The Warehouse Manager's module: the dashboard (#/warehouse), the full Inventory (#/inventory), Stock Movements
// (#/movements) and Notifications (#/notifications).
//
// Every figure comes from GET /api/warehouse/* (src/domain/warehouse.js): products and stock from Odoo, lots from the
// expiry list, movements from records BFL already keeps. Nothing here invents a number; where data is missing the
// screen says so. Nothing someone types into is rebuilt: the search box, the filters and the date fields are made
// once; only the rows, the figures and the chart around them are replaced.
import { api } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';
import { debounce, createLatest } from './lib/util.js';
import { icon } from './lib/lucide.js';

// ------------------------------------------------------------------ formatting
const qty = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${qty(Math.abs(n))}`;
const dateText = (iso) => (iso ? new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—');
const plural = (n, w) => `${qty(n)} ${w}${n === 1 ? '' : 's'}`;
const greeting = (now = new Date()) => (now.getHours() < 12 ? 'Good morning' : now.getHours() < 17 ? 'Good afternoon' : 'Good evening');

const STATUS = {
  IN_STOCK: ['In stock', 'success'], LOW_STOCK: ['Low stock', 'warning'], OUT_OF_STOCK: ['Out of stock', 'danger'],
};
const MOVE = {
  STOCK_IN: ['Stock In', 'success'], STOCK_OUT: ['Stock Out', 'danger'], TRANSFER: ['Transfer', 'info'], ADJUSTMENT: ['Adjustment', 'warning'], RETURN: ['Return', 'purple'],
};
const badge = (label, tone) => h('span', { class: `wh-badge ${tone}` }, label);
const LOCATION = { MAIN: 'Main warehouse', CLEARANCE: 'Clearance' };

const card = (cls, ...children) => h('section', { class: `wh-card ${cls || ''}`.trim() }, ...children);
const cardHead = (title, sub, right) => h('div', { class: 'wh-card-head' },
  h('div', null, h('h2', null, title), sub ? h('p', null, sub) : null), right || null);
const viewAll = (href, label = 'View All') => h('a', { class: 'wh-link', href }, label, icon('arrowRight'));
const loading = (lines = 3) => h('div', { class: 'wh-skeleton', role: 'status', 'aria-label': 'Loading' }, Array.from({ length: lines }, () => h('i')));
const empty = (title, text) => h('div', { class: 'wh-empty' }, h('b', null, title), text ? h('p', null, text) : null);
const errorBox = (e) => h('div', { class: 'wh-error', role: 'alert' }, icon('alert'), h('span', null, e?.message || 'Could not load this. Try again.'));
const sampleTag = (text) => h('span', { class: 'wh-tag', title: text }, 'Sample');

// ------------------------------------------------------------------ period control (built once)
const PERIOD_OPTIONS = [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['last_month', 'Last Month'], ['year', 'This Year'], ['custom', 'Custom Date Range']];

function periodControl(onChange, initial = 'week') {
  const today = new Date().toISOString().slice(0, 10);
  const select = h('select', { class: 'wh-select', 'aria-label': 'Date range' },
    PERIOD_OPTIONS.map(([v, t]) => h('option', { value: v, selected: v === initial }, t)));
  const from = h('input', { type: 'date', class: 'wh-input', 'aria-label': 'From', max: today });
  const to = h('input', { type: 'date', class: 'wh-input', 'aria-label': 'To', max: today, value: today });
  const apply = h('button', { type: 'button', class: 'wh-btn', onClick: () => { if (from.value && to.value) onChange(value()); } }, 'Apply');
  const custom = h('span', { class: 'wh-custom hidden' }, from, h('span', { class: 'wh-muted' }, 'to'), to, apply);
  select.addEventListener('change', () => {
    toggleHidden(custom, select.value !== 'custom');
    if (select.value !== 'custom') onChange(value());
    else from.focus();
  });
  function value() {
    return select.value === 'custom' ? { period: 'custom', from: from.value, to: to.value } : { period: select.value };
  }
  return { el: h('div', { class: 'wh-period' }, icon('calendar'), select, custom), value };
}

// ------------------------------------------------------------------ inventory table (dashboard card and full page)
/**
 * The inventory: search, category, location and status filters (combined), sortable columns and paging.
 * @param {{pageSize:number, search?:string, compact?:boolean}} opts
 */
export function createInventoryTable({ pageSize = 6, search: initialSearch = '', compact = false } = {}) {
  const state = { search: initialSearch, category: '', location: '', status: '', sort: 'name', dir: 'asc', offset: 0 };
  const latest = createLatest();
  let optionsLoaded = false;

  const search = h('input', {
    type: 'search', class: 'wh-input wh-search', placeholder: 'Search products, SKUs or locations…', 'aria-label': 'Search the inventory', value: initialSearch,
    onInput: debounce(() => { state.search = search.value.trim(); state.offset = 0; load(); }, 250),
  });
  const category = h('select', { class: 'wh-select', 'aria-label': 'Category', onChange: () => { state.category = category.value; state.offset = 0; load(); } },
    h('option', { value: '' }, 'All Categories'));
  const locationSel = h('select', { class: 'wh-select', 'aria-label': 'Location', onChange: () => { state.location = locationSel.value; state.offset = 0; load(); } },
    h('option', { value: '' }, 'All Locations'));
  const status = h('select', { class: 'wh-select', 'aria-label': 'Stock status', onChange: () => { state.status = status.value; state.offset = 0; load(); } },
    [['', 'All Statuses'], ['IN_STOCK', 'In stock'], ['LOW_STOCK', 'Low stock'], ['OUT_OF_STOCK', 'Out of stock'], ['EXPIRING_SOON', 'Expiring soon']]
      .map(([v, t]) => h('option', { value: v }, t)));

  const COLS = [
    [null, 'Product', null], ['name', '', null], ['sku', 'SKU', null], ['available', 'Available', 'num'],
    [null, 'Location', null], ['status', 'Stock Status', null], ['expiry', 'Expiry Date', null],
  ];
  const headCells = COLS.map(([key, label, cls], i) => {
    if (i === 0) return h('th', { class: 'wh-th-img', scope: 'col' }, h('span', { class: 'sr-only' }, 'Image'));
    if (i === 1) {
      return h('th', { scope: 'col', 'data-sort': 'name' }, h('button', { type: 'button', class: 'wh-sort', onClick: () => sortBy('name') }, 'Product Name', icon('sort')));
    }
    return h('th', { scope: 'col', class: cls, 'data-sort': key || '' },
      key ? h('button', { type: 'button', class: 'wh-sort', onClick: () => sortBy(key) }, label, icon('sort')) : label);
  });
  const tbody = h('tbody');
  const table = h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table wh-inventory' }, h('thead', null, h('tr', null, headCells)), tbody));
  const count = h('span', { class: 'wh-muted', role: 'status' });
  const prev = h('button', { type: 'button', class: 'wh-page-btn', 'aria-label': 'Previous page', onClick: () => go(-1) }, icon('chevronLeft'));
  const next = h('button', { type: 'button', class: 'wh-page-btn', 'aria-label': 'Next page', onClick: () => go(1) }, icon('chevronRight'));
  const pageOf = h('span', { class: 'wh-muted' });
  const footer = h('div', { class: 'wh-table-foot' }, count, h('div', { class: 'wh-pager' }, prev, pageOf, next));
  const note = h('p', { class: 'wh-note hidden' });
  const body = h('div', null, loading(compact ? 4 : 6));

  const el = h('div', { class: `wh-inventory-table${compact ? ' wh-compact' : ''}` },
    h('div', { class: 'wh-filters' }, h('label', { class: 'wh-search-wrap' }, icon('search'), search), category, locationSel, status),
    body, note);

  function sortBy(key) {
    state.dir = state.sort === key && state.dir === 'asc' ? 'desc' : 'asc';
    state.sort = key;
    state.offset = 0;
    load();
  }
  function go(delta) { state.offset = Math.max(0, state.offset + delta * pageSize); load(); }

  function row(p) {
    const pic = p.image
      ? h('img', { src: p.image, alt: '', loading: 'lazy', class: 'wh-thumb' })
      : h('span', { class: 'wh-thumb wh-thumb-empty', 'aria-hidden': 'true' }, icon('package'));
    const [statusLabel, tone] = STATUS[p.status] || ['—', 'neutral'];
    const open = () => { location.hash = `#/products/${p.id}`; };
    return h('tr', {
      class: 'wh-row-link', tabindex: '0', 'aria-label': `Open ${p.name}`,
      onClick: open, onKeydown: (e) => { if (e.key === 'Enter') open(); },
    },
    h('td', { class: 'wh-td-img' }, pic),
    h('td', { class: 'wh-td-name' }, h('b', null, p.name), h('span', { class: 'wh-muted' }, [p.barcode, p.pack].filter(Boolean).join(' · '))),
    h('td', { class: 'wh-mono' }, p.sku || '—'),
    h('td', { class: 'num' }, h('b', null, qty(p.available)), h('span', { class: 'wh-muted' }, ' CTN')),
    h('td', null, p.locations.length ? p.locations.map((l) => LOCATION[l] || l).join(', ') : h('span', { class: 'wh-muted' }, '—')),
    h('td', null, h('span', { class: 'wh-badges' }, badge(statusLabel, tone), p.expiringSoon ? badge('Expiring soon', 'amber') : null)),
    h('td', null, p.nextExpiry ? dateText(p.nextExpiry) : h('span', { class: 'wh-muted' }, '—')));
  }

  function paintOptions(o) {
    if (optionsLoaded) return;
    optionsLoaded = true;
    category.append(...o.categories.map((c) => h('option', { value: c.path }, `${c.level > 1 ? '— ' : ''}${c.label} (${qty(c.products)})`)));
    locationSel.append(...o.locations.map((l) => h('option', { value: l.value }, l.label)));
  }

  async function load() {
    const mine = latest.next();
    let d;
    try {
      d = await api.warehouseInventory({ ...state, limit: pageSize });
    } catch (e) { if (latest.is(mine)) setChildren(body, errorBox(e)); return; }
    if (!latest.is(mine)) return;
    paintOptions(d.options);
    for (const th of headCells) {
      const key = th.dataset.sort;
      if (key) th.setAttribute('aria-sort', key === d.sort ? (d.dir === 'asc' ? 'ascending' : 'descending') : 'none');
    }
    if (!d.items.length) {
      setChildren(body, empty('No products match', 'Try another search, or clear a filter.'));
    } else {
      setChildren(tbody, d.items.map(row));
      setChildren(body, table, footer);
    }
    const last = Math.min(d.offset + d.items.length, d.total);
    count.textContent = d.total ? `Showing ${qty(d.offset + 1)}–${qty(last)} of ${plural(d.total, 'product')}` : '';
    const pages = Math.max(1, Math.ceil(d.total / d.limit));
    pageOf.textContent = `Page ${Math.floor(d.offset / d.limit) + 1} of ${qty(pages)}`;
    prev.disabled = d.offset === 0;
    next.disabled = last >= d.total;
    note.textContent = d.lotSource === 'SAMPLE' ? 'Location and expiry date come from the lots on the expiry list, which are sample lots until the Odoo lot sync exists. A product with no lot shows —.' : '';
    toggleHidden(note, !note.textContent);
  }

  load();
  return { el, reload: load };
}

// ------------------------------------------------------------------ stock movements table
function movementsTable(items, { compact = false } = {}) {
  if (!items.length) return empty('No stock movements in this period', 'Movements appear when stock changes between imports, deliveries are validated or returns are received.');
  return h('div', { class: 'wh-table-wrap' }, h('table', { class: `wh-table wh-moves${compact ? ' compact' : ''}` },
    // compact (the dashboard panel): the date goes under the product and the reference is left to the full page
    h('thead', null, h('tr', null,
      compact ? null : h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Product'), h('th', { scope: 'col' }, compact ? 'Type' : 'Movement Type'),
      h('th', { scope: 'col', class: 'num' }, compact ? 'Qty' : 'Quantity'), compact ? null : h('th', { scope: 'col' }, 'Reference'))),
    h('tbody', null, items.map((m) => {
      const [label, tone] = MOVE[m.type] || [m.type, 'neutral'];
      const open = () => { location.hash = `#/inventory?q=${encodeURIComponent(m.barcode)}`; };
      return h('tr', { class: 'wh-row-link', tabindex: '0', title: m.note, onClick: open, onKeydown: (e) => { if (e.key === 'Enter') open(); } },
        compact ? null : h('td', { class: 'wh-nowrap' }, dateText(m.at)),
        h('td', { class: 'wh-td-name' }, h('b', null, m.product), h('span', { class: 'wh-muted' }, compact ? dateText(m.at) : m.barcode,
          compact && m.source === 'SAMPLE_ODOO' ? sampleTag('From the Sample Odoo stand-in until Odoo is connected') : null)),
        h('td', null, badge(label, tone)),
        h('td', { class: `num wh-qty ${m.quantity > 0 ? 'in' : 'out'}` }, signed(m.quantity)),
        compact ? null : h('td', { class: 'wh-nowrap' }, m.href
          ? h('a', { class: 'wh-ref', href: m.href, onClick: (e) => e.stopPropagation() }, m.reference)
          : h('span', { class: 'wh-mono' }, m.reference),
        m.source === 'SAMPLE_ODOO' ? sampleTag('From the Sample Odoo stand-in until Odoo is connected') : null));
    }))));
}

// ------------------------------------------------------------------ the stock-levels chart (grouped bars)
const SERIES = [['available', 'wh-bar-available'], ['incoming', 'wh-bar-incoming']];
const niceStep = (max) => {
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
};
const NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}, text = null) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== null) el.textContent = text;
  return el;
};
/** A bar with 4px rounded top corners, square at the baseline. */
const barPath = (x, top, w, base) => {
  const r = Math.min(4, w / 2, Math.max(0, base - top));
  return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + w - r}Q${x + w},${top} ${x + w},${top + r}V${base}Z`;
};

function stockChart(levels) {
  const groups = levels.groups;
  const tip = h('div', { class: 'wh-tip hidden', role: 'status' });
  const plot = h('div', { class: 'wh-chart-plot' });
  const tableBox = h('div', { class: 'hidden' });
  const toggle = h('button', { type: 'button', class: 'wh-btn ghost', 'aria-pressed': 'false', onClick: () => {
    const show = tableBox.classList.contains('hidden');
    toggleHidden(tableBox, !show); toggleHidden(plot, show);
    toggle.setAttribute('aria-pressed', String(show));
    setChildren(toggle, icon(show ? 'reports' : 'table'), show ? 'Chart view' : 'Table view');
  } }, icon('table'), 'Table view');
  const legend = h('div', { class: 'wh-legend' }, levels.series.map((x, i) => h('span', null, h('i', { class: `wh-key ${SERIES[i][1]}` }), x.label)));

  setChildren(tableBox, h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table' },
    h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', { class: 'num' }, 'Available (CTN)'), h('th', { class: 'num' }, 'Incoming (CTN)'), h('th', { class: 'num' }, 'Products'))),
    h('tbody', null, groups.map((g) => h('tr', null, h('td', null, g.label), h('td', { class: 'num' }, qty(g.available)), h('td', { class: 'num' }, qty(g.incoming)), h('td', { class: 'num' }, qty(g.products))))))));

  function draw() {
    const width = Math.max(300, plot.clientWidth || 640);
    const height = 260;
    const L = 52; const R = 8; const T = 14; const B = 44;
    const pw = width - L - R; const ph = height - T - B;
    const max = Math.max(1, ...groups.flatMap((g) => [g.available, g.incoming]));
    const step = niceStep(max);
    const top = step * Math.ceil(max / step);
    const y = (v) => T + ph * (1 - v / top);
    const gw = pw / groups.length;
    const bw = Math.max(4, Math.min(30, (gw * 0.62 - 2) / 2));
    const svgEl = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'wh-chart-svg', role: 'img', 'aria-label': `Available and incoming cartons for ${groups.length} categories` });
    for (let v = 0; v <= top + 1e-9; v += step) {
      svgEl.append(s('line', { class: v === 0 ? 'wh-axis' : 'wh-grid', x1: L, x2: width - R, y1: y(v), y2: y(v) }));
      svgEl.append(s('text', { class: 'wh-tick', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, Number(v).toLocaleString(undefined, { notation: v >= 10000 ? 'compact' : 'standard' })));
    }
    const maxChars = Math.max(4, Math.floor(gw / 7));
    groups.forEach((g, i) => {
      const cx = L + gw * (i + 0.5);
      const hit = s('rect', { class: 'wh-hit', x: L + gw * i, y: T, width: gw, height: ph });
      const marks = SERIES.map(([key, cls], k) => {
        const x = k === 0 ? cx - bw - 1 : cx + 1;        // a 2px gap between the pair
        return s('path', { class: `wh-bar ${cls}`, d: barPath(x, y(g[key]), bw, y(0)) });
      });
      const label = g.label.length > maxChars ? `${g.label.slice(0, maxChars - 1)}…` : g.label;
      const text = s('text', { class: 'wh-tick wh-cat', x: cx, y: height - B + 18, 'text-anchor': 'middle' }, label);
      const show = (ev) => {
        marks.forEach((m) => m.classList.add('on'));
        setChildren(tip, h('b', null, g.label),
          h('span', null, h('i', { class: 'wh-key wh-bar-available' }), `Available: ${qty(g.available)} CTN`),
          h('span', null, h('i', { class: 'wh-key wh-bar-incoming' }), `Incoming: ${qty(g.incoming)} CTN`),
          h('span', { class: 'wh-muted' }, plural(g.products, 'product')));
        toggleHidden(tip, false);
        const box = plot.getBoundingClientRect();
        const px = (ev.clientX ?? box.left + cx) - box.left;
        tip.style.left = `${Math.min(Math.max(8, px + 12), box.width - 190)}px`;
        tip.style.top = `${Math.max(4, y(Math.max(g.available, g.incoming)) - 40)}px`;
      };
      const hide = () => { marks.forEach((m) => m.classList.remove('on')); toggleHidden(tip, true); };
      hit.addEventListener('pointermove', show);
      hit.addEventListener('pointerleave', hide);
      svgEl.append(...marks, text, hit);
    });
    setChildren(plot, svgEl, tip);
  }

  const el = h('div', { class: 'wh-chart' }, h('div', { class: 'wh-chart-bar' }, legend, toggle), plot, tableBox);
  if ('ResizeObserver' in window) {
    let last = 0;
    new ResizeObserver(() => { if (plot.isConnected && Math.abs(plot.clientWidth - last) > 4) { last = plot.clientWidth; draw(); } }).observe(plot);
  }
  requestAnimationFrame(draw);
  return el;
}

// ------------------------------------------------------------------ the dashboard
const KPIS = [
  ['totalProducts', 'Total Products', 'Active products in inventory', 'package', 'blue', '#/inventory'],
  ['lowStock', 'Low Stock Items', 'Need reorder soon', 'alert', 'orange', '#/inventory?status=LOW_STOCK'],
  ['outOfStock', 'Out of Stock', 'Currently unavailable', 'packageX', 'red', '#/inventory?status=OUT_OF_STOCK'],
  ['expiringSoon', 'Expiring Soon', 'Lots within 1–2 months', 'clock', 'purple', '#/expiry?band=CRITICAL,WARNING'],
  ['recentMovements', 'Recent Movements', null, 'movements', 'blue', '#/movements'],
];
const EXPIRY_ROWS = [
  ['EXPIRED', 'Expired', 'Lots past their expiry date', 'danger', 'EXPIRED'],
  ['SOON', 'Expiring Soon', 'Within 1–2 months', 'warning', 'CRITICAL,WARNING'],
  ['IN_DATE', 'In Date', 'Valid expiry date', 'success', 'EARLY,OK'],
  ['NO_DATE', 'No Expiry Date', 'No expiry information', 'neutral', 'NO_DATE'],
];

export async function renderWarehouseHome(view) {
  const latest = createLatest();
  const kpis = h('div', { class: 'wh-kpis', 'aria-label': 'Key figures' }, KPIS.map(() => h('div', { class: 'wh-kpi' }, loading(2))));
  const expiryBody = h('div', null, loading(4));
  const movesBody = h('div', null, loading(4));
  const movesNote = h('p', { class: 'wh-note hidden' });
  const chartBody = h('div', null, loading(5));
  const inventory = createInventoryTable({ pageSize: 6, compact: true });
  const period = periodControl((p) => load(p));

  const quick = (href, iconName, title, text) => h('a', { class: 'wh-quick', href }, h('span', { class: 'wh-quick-icon' }, icon(iconName)), h('span', null, h('b', null, title), h('small', null, text)));

  setChildren(view, h('div', { class: 'wh-page' },
    h('div', { class: 'wh-head' },
      h('div', null,
        h('p', { class: 'wh-eyebrow' }, `${greeting()} · ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`),
        h('h1', null, 'Warehouse Dashboard'),
        h('p', { class: 'wh-sub' }, 'Stock overview, inventory status and warehouse operations.')),
      period.el),
    kpis,
    h('div', { class: 'wh-grid' },
      h('div', { class: 'wh-col' },
        card('wh-inventory-card', cardHead('Inventory Overview', null, viewAll('#/inventory')), inventory.el),
        card('', cardHead('Warehouse Stock Levels', 'Cartons available to sell and incoming (pending receipt in Odoo), by category', null), chartBody)),
      h('div', { class: 'wh-col' },
        card('', cardHead('Expiry Tracking', 'Lots by expiry status', viewAll('#/expiry')), expiryBody),
        card('', cardHead('Stock Movements', null, viewAll('#/movements')), movesBody, movesNote),
        card('', cardHead('Quick Actions'), h('div', { class: 'wh-quick-grid' },
          quick('scan.html', 'scan', 'Scan Product', 'Check stock or find a product'),
          quick('#/imports', 'upload', 'Update Stock', 'Load the latest stock export from Odoo'),
          quick('#/expiry?band=CRITICAL,WARNING', 'expiry', 'Check Expiry Dates', 'View lots expiring soon'),
          quick('#/reports', 'reports', 'View Reports', 'Warehouse and stock reports')))))));

  async function load(p = period.value()) {
    const mine = latest.next();
    let d;
    try { d = await api.warehouseSummary(p); } catch (e) {
      if (!latest.is(mine)) return;
      setChildren(kpis, errorBox(e)); setChildren(expiryBody, errorBox(e)); setChildren(movesBody, errorBox(e)); setChildren(chartBody, errorBox(e));
      return;
    }
    if (!latest.is(mine)) return;
    setChildren(kpis, KPIS.map(([key, title, text, iconName, tone, href]) => h('a', { class: 'wh-kpi', href },
      h('span', { class: `wh-kpi-icon ${tone}` }, icon(iconName)),
      h('span', { class: 'wh-kpi-body' },
        h('span', { class: 'wh-kpi-title' }, title),
        h('b', { class: 'wh-kpi-value' }, qty(d.kpis[key])),
        h('span', { class: 'wh-kpi-text' }, key === 'recentMovements' ? `In ${d.range.label.toLowerCase()}` : key === 'lowStock' ? `${text} (${d.thresholds.lowStockAtOrBelow} cartons or fewer)` : text)))));

    const ex = d.expiry;
    setChildren(expiryBody, h('ul', { class: 'wh-expiry' }, EXPIRY_ROWS.map(([key, title, text, tone, bands]) => h('li', null,
      h('a', { href: `#/expiry?band=${bands}`, class: 'wh-expiry-row' },
        h('span', { class: `wh-dot ${tone}`, 'aria-hidden': 'true' }),
        h('span', { class: 'wh-expiry-text' }, h('b', null, title), h('small', null, text)),
        h('b', { class: 'wh-expiry-n' }, qty(ex[key])), icon('chevronRight'))))),
    h('p', { class: 'wh-note' }, `${plural(ex.total, 'lot')}, counted lot by lot`, ex.source === 'SAMPLE' ? ' · sample lots until the Odoo lot sync exists' : '', '.'));

    setChildren(movesBody, movementsTable(d.movements.latest, { compact: true }));
    movesNote.textContent = d.movements.total ? `${plural(d.movements.total, 'movement')} in ${d.range.label.toLowerCase()}.` : '';
    toggleHidden(movesNote, !d.movements.total);

    setChildren(chartBody, d.stockLevels.groups.length ? stockChart(d.stockLevels) : empty('No stock to show', 'Run a stock import to load stock figures.'));
  }

  await load();
}

// ------------------------------------------------------------------ full pages
const hashParam = (name) => new URLSearchParams(location.hash.split('?')[1] || '').get(name) || '';

export async function renderInventoryPage(view) {
  let fromTopBar = '';
  try { fromTopBar = sessionStorage.getItem('bfl.inventorySearch') || ''; sessionStorage.removeItem('bfl.inventorySearch'); } catch { /* storage blocked */ }
  const table = createInventoryTable({ pageSize: 25, search: fromTopBar || hashParam('q') });
  const status = hashParam('status');
  if (status) {
    const sel = table.el.querySelector('select[aria-label="Stock status"]');
    sel.value = status;
    sel.dispatchEvent(new Event('change'));
  }
  setChildren(view, h('div', { class: 'wh-page' },
    h('div', { class: 'wh-head' }, h('div', null, h('h1', null, 'Inventory'), h('p', { class: 'wh-sub' }, 'Every active product with its available cartons, stock status, location and next expiry. Open a row for the product\'s details.'))),
    card('', table.el)));
}

export async function renderMovementsPage(view) {
  const state = { type: '', offset: 0 };
  const PAGE = 25;
  const latest = createLatest();
  const body = h('div', null, loading(6));
  const typeSel = h('select', { class: 'wh-select', 'aria-label': 'Movement type', onChange: () => { state.type = typeSel.value; state.offset = 0; load(); } },
    h('option', { value: '' }, 'All Movement Types'));
  const period = periodControl(() => { state.offset = 0; load(); }, 'month');
  const summary = h('div', { class: 'wh-type-counts' });
  const foot = h('div', { class: 'wh-table-foot' });

  setChildren(view, h('div', { class: 'wh-page' },
    h('div', { class: 'wh-head' },
      h('div', null, h('h1', null, 'Stock Movements'), h('p', { class: 'wh-sub' }, 'What moved in and out of the warehouse, from records BFL keeps: stock changes between Odoo stock imports, deliveries validated in Odoo and returns received.')),
      period.el),
    card('', h('div', { class: 'wh-filters' }, typeSel, summary), body, foot),
    h('p', { class: 'wh-note' }, 'Stock is recorded in Odoo, never in BFL. Transfers and adjustments are not read from Odoo yet, so none are listed; nothing here is estimated.')));

  async function load() {
    const mine = latest.next();
    let d;
    try { d = await api.warehouseMovements({ ...period.value(), type: state.type, limit: PAGE, offset: state.offset }); } catch (e) {
      if (latest.is(mine)) setChildren(body, errorBox(e));
      return;
    }
    if (!latest.is(mine)) return;
    if (typeSel.options.length === 1) typeSel.append(...Object.entries(d.types).map(([k, t]) => h('option', { value: k }, t)));
    setChildren(summary, Object.entries(d.byType).filter(([, n]) => n).map(([k, n]) => badge(`${MOVE[k][0]}: ${qty(n)}`, MOVE[k][1])));
    setChildren(body, movementsTable(d.items));
    const last = Math.min(d.offset + d.items.length, d.total);
    const prev = h('button', { type: 'button', class: 'wh-page-btn', 'aria-label': 'Previous page', disabled: d.offset === 0, onClick: () => { state.offset = Math.max(0, state.offset - PAGE); load(); } }, icon('chevronLeft'));
    const next = h('button', { type: 'button', class: 'wh-page-btn', 'aria-label': 'Next page', disabled: last >= d.total, onClick: () => { state.offset += PAGE; load(); } }, icon('chevronRight'));
    setChildren(foot, h('span', { class: 'wh-muted', role: 'status' }, d.total ? `Showing ${qty(d.offset + 1)}–${qty(last)} of ${plural(d.total, 'movement')} · ${d.range.label}` : `No movements · ${d.range.label}`),
      d.total > PAGE ? h('div', { class: 'wh-pager' }, prev, next) : null);
  }
  await load();
}

export async function renderNotifications(view) {
  const body = h('div', null, loading(4));
  setChildren(view, h('div', { class: 'wh-page' },
    h('div', { class: 'wh-head' }, h('div', null, h('h1', null, 'Notifications'), h('p', { class: 'wh-sub' }, 'What needs the warehouse\'s attention now, each with where to deal with it.'))),
    card('', body)));
  let d;
  try { d = await api.warehouseNotifications(); } catch (e) { setChildren(body, errorBox(e)); return; }
  setChildren(body, d.items.length
    ? h('ul', { class: 'wh-notes' }, d.items.map((n) => h('li', null, h('a', { href: n.href, class: 'wh-note-row' },
      h('span', { class: `wh-dot ${n.level === 'red' ? 'danger' : 'warning'}`, 'aria-hidden': 'true' }),
      h('span', { class: 'wh-expiry-text' }, h('b', null, n.title), h('small', null, n.detail)),
      h('b', { class: 'wh-expiry-n' }, qty(n.count)), icon('chevronRight')))))
    : empty('Nothing needs your attention', 'Stock data is current and no lot, return or change is waiting.'));
}
