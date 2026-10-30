// The Sales Manager's module: the dashboard (#/sales), Team Performance (#/performance, #/performance/:rep), Sales
// Targets (#/targets), Orders (#/orders), Customers (#/customers, #/customers/:id), Notifications, Settings
// (#/sales-settings) and search results (#/search?q=).
//
// Every figure comes from GET /api/sales-dashboard/* (src/domain/sales-dashboard.js): sales are Odoo invoices less
// credit notes, targets are the ones set on Sales Targets, outstanding is what is still unpaid on Odoo's invoices.
// Nothing here invents a number; where data is missing the screen says so. Same building blocks and styles as the
// warehouse module (dash-ui.js, css/warehouse.css). Fields someone types into are built once; only rows and figures
// around them are repainted.
import { api, toast } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';
import { debounce, createLatest } from './lib/util.js';
import { icon } from './lib/lucide.js';
import {
  qty, ghs, ghsShort, dateText, plural, greeting, ago, badge, card, cardHead, viewAll, loading, empty, errorBox,
  pageHead, hashParam, periodControl, SALES_PERIODS, niceStep, s, barPath, onResize,
} from './dash-ui.js';

// ------------------------------------------------------------------ shared bits
const STATUS = {
  ON_TRACK: ['On Track', 'success'], AT_RISK: ['At Risk', 'warning'], BELOW_TARGET: ['Below Target', 'danger'], NO_TARGET: ['No Target', 'neutral'],
};
const ACTIVITY = { ACTIVE: ['Active', 'success'], QUIET: ['Quiet', 'warning'], DORMANT: ['No recent activity', 'danger'], NEW: ['No orders yet', 'neutral'] };
const statusBadge = (st) => badge(...(STATUS[st] || [st, 'neutral']));
const avatar = (initials) => h('span', { class: 'sm-avatar', 'aria-hidden': 'true' }, initials);
const pctText = (p) => (p === null || p === undefined ? '—' : `${Number(p).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
const SAMPLE_TEXT = 'Odoo is not connected yet: sales, invoices and balances come from the stand-in for Odoo.';
const PREVIOUS = {
  today: 'yesterday', week: 'the same days last week', month: 'the same days last month', last_month: 'the month before',
  quarter: 'the same days last quarter', year: 'the same dates last year', custom: 'the period before',
};

/** The period chosen on any sales screen is kept while moving between them (not a custom range). */
function savedPeriod() {
  try { const p = sessionStorage.getItem('bfl.salesPeriod'); if (p && SALES_PERIODS.some(([v]) => v === p) && p !== 'custom') return p; } catch { /* storage blocked */ }
  return 'month';
}
function savePeriod(p) { try { if (p.period !== 'custom') sessionStorage.setItem('bfl.salesPeriod', p.period); } catch { /* storage blocked */ } }
const salesPeriodControl = (onChange) => periodControl((p) => { savePeriod(p); onChange(p); }, savedPeriod(), SALES_PERIODS);

/** A progress bar: the bar to 100%, the exact figure beside it; an optional marker for "expected by today". */
function progress(pctValue, expectedPct = null, tone = '') {
  const width = Math.max(0, Math.min(100, Number(pctValue) || 0));
  return h('span', { class: 'sm-progress-wrap' },
    h('span', { class: `sm-progress ${tone}`, role: 'img', 'aria-label': `${pctText(pctValue)} achieved${expectedPct !== null ? `, ${pctText(expectedPct)} expected by today` : ''}` },
      h('i', { style: { width: `${width}%` } }),
      expectedPct !== null && expectedPct < 100 ? h('b', { class: 'sm-progress-mark', style: { left: `${Math.max(0, Math.min(100, expectedPct))}%` }, title: 'Expected by today' }) : null),
    h('span', { class: 'sm-progress-text' }, pctText(pctValue)));
}
const toneFor = (st) => ({ ON_TRACK: 'success', AT_RISK: 'warning', BELOW_TARGET: 'danger' }[st] || '');

/** One KPI card. */
const kpiCard = ({ href, iconName, tone, title, value, sub, extra }) => h(href ? 'a' : 'div', { class: 'wh-kpi', href },
  h('span', { class: `wh-kpi-icon ${tone}` }, icon(iconName)),
  h('span', { class: 'wh-kpi-body' },
    h('span', { class: 'wh-kpi-title' }, title),
    h('b', { class: 'wh-kpi-value' }, value),
    extra || null,
    sub ? h('span', { class: 'wh-kpi-text' }, sub) : null));

function changeLine(changePct, previousValue, period, formatter = ghs) {
  if (changePct === null || changePct === undefined) {
    return h('span', { class: 'sm-change' }, previousValue ? '' : `Nothing in ${PREVIOUS[period] || 'the period before'}`);
  }
  const up = changePct >= 0;
  return h('span', { class: `sm-change ${up ? 'up' : 'down'}`, title: `${formatter(previousValue)} in ${PREVIOUS[period]}` },
    icon(up ? 'arrowUp' : 'arrowDown'), `${pctText(Math.abs(changePct))} vs. ${PREVIOUS[period] || 'the period before'}`);
}

/** A simple pager for a list held in memory. */
function pager(onGo) {
  const count = h('span', { class: 'wh-muted', role: 'status' });
  const prev = h('button', { type: 'button', class: 'wh-page-btn', 'aria-label': 'Previous page', onClick: () => onGo(-1) }, icon('chevronLeft'));
  const next = h('button', { type: 'button', class: 'wh-page-btn', 'aria-label': 'Next page', onClick: () => onGo(1) }, icon('chevronRight'));
  const pageOf = h('span', { class: 'wh-muted' });
  return {
    el: h('div', { class: 'wh-table-foot' }, count, h('div', { class: 'wh-pager' }, prev, pageOf, next)),
    paint(offset, shown, total, size, noun) {
      const last = Math.min(offset + shown, total);
      count.textContent = total ? `Showing ${qty(offset + 1)}–${qty(last)} of ${plural(total, noun)}` : '';
      pageOf.textContent = `Page ${Math.floor(offset / size) + 1} of ${qty(Math.max(1, Math.ceil(total / size)))}`;
      prev.disabled = offset === 0;
      next.disabled = last >= total;
    },
  };
}

// ------------------------------------------------------------------ the reps table (dashboard card and full page)
const REP_SORTS = {
  achieved: (a, b) => b.achieved - a.achieved || a.name.localeCompare(b.name),
  progress: (a, b) => (b.progressPct ?? -1) - (a.progressPct ?? -1) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
};

export function createRepsTable({ pageSize = 6, status: initialStatus = '' } = {}) {
  const state = { search: '', status: initialStatus, sort: 'achieved', offset: 0 };
  let rows = [];
  const search = h('input', { type: 'search', class: 'wh-input wh-search', placeholder: 'Search representatives…', 'aria-label': 'Search representatives', onInput: debounce(() => { state.search = search.value.trim().toLowerCase(); state.offset = 0; paint(); }, 200) });
  const status = h('select', { class: 'wh-select', 'aria-label': 'Status', onChange: () => { state.status = status.value; state.offset = 0; paint(); } },
    h('option', { value: '' }, 'All Statuses'), Object.entries(STATUS).map(([k, [t]]) => h('option', { value: k, selected: k === initialStatus }, t)));
  const sort = h('select', { class: 'wh-select', 'aria-label': 'Sort by', onChange: () => { state.sort = sort.value; paint(); } },
    h('option', { value: 'achieved' }, 'Sort: Sales achieved'), h('option', { value: 'progress' }, 'Sort: Target achievement'), h('option', { value: 'name' }, 'Sort: Name'));
  const tbody = h('tbody');
  const table = h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table sm-reps' },
    h('thead', null, h('tr', null, ['Representative', 'Target', 'Sales Achieved', 'Remaining', 'Progress', 'Status', 'Last Activity']
      .map((t, i) => h('th', { scope: 'col', class: i >= 1 && i <= 3 ? 'num' : null }, t)))),
    tbody));
  const body = h('div', null, loading(4));
  const foot = pager((d) => { state.offset = Math.max(0, state.offset + d * pageSize); paint(); });
  const el = h('div', null, h('div', { class: 'wh-filters' }, h('label', { class: 'wh-search-wrap' }, icon('search'), search), status, sort), body);

  function row(r) {
    const open = () => { location.hash = `#/performance/${encodeURIComponent(r.id)}`; };
    return h('tr', { class: 'wh-row-link', tabindex: '0', 'aria-label': `Open ${r.name}`, onClick: open, onKeydown: (e) => { if (e.key === 'Enter') open(); } },
      h('td', { class: 'sm-rep-cell' }, avatar(r.initials), h('span', null, h('b', null, r.name),
        h('span', { class: 'wh-muted' }, r.account ? plural(r.customers, 'customer') : r.sample ? 'Sample rep, no BFL account' : 'Salesperson in Odoo, no BFL account'))),
      h('td', { class: 'num' }, r.target === null ? h('span', { class: 'wh-muted' }, 'No target') : ghs(r.target, 0)),
      h('td', { class: 'num' }, h('b', null, ghs(r.achieved, 0))),
      h('td', { class: 'num' }, r.target === null ? '—' : r.exceededBy > 0 ? h('span', { class: 'sm-over' }, `+${ghs(r.exceededBy, 0)} over`) : ghs(r.remaining, 0)),
      h('td', null, r.target === null ? h('span', { class: 'wh-muted' }, '—') : progress(r.progressPct, r.expectedPct, toneFor(r.status))),
      h('td', null, statusBadge(r.status)),
      h('td', { class: 'sm-activity' }, r.lastActivity ? [h('span', null, ago(r.lastActivity.at)), h('span', { class: 'wh-muted' }, r.lastActivity.what)] : h('span', { class: 'wh-muted' }, 'No activity yet')));
  }

  function paint() {
    let list = rows.filter((r) => (!state.search || r.name.toLowerCase().includes(state.search)) && (!state.status || r.status === state.status));
    list = [...list].sort(REP_SORTS[state.sort]);
    if (!list.length) { setChildren(body, empty(rows.length ? 'No representatives match' : 'No sales representatives yet', rows.length ? 'Try another search or status.' : 'Add a sales rep on Team Accounts.')); return; }
    if (state.offset >= list.length) state.offset = 0;
    setChildren(tbody, list.slice(state.offset, state.offset + pageSize).map(row));
    foot.paint(state.offset, Math.min(pageSize, list.length - state.offset), list.length, pageSize, 'representative');
    setChildren(body, table, list.length > pageSize ? foot.el : null);
  }
  return { el, setRows(next) { rows = next; paint(); }, showError(e) { setChildren(body, errorBox(e)); } };
}

// ------------------------------------------------------------------ the sales performance chart (line + area)
function performanceChart(perf) {
  const pts = perf.points;
  const tip = h('div', { class: 'wh-tip hidden', role: 'status' });
  const plot = h('div', { class: 'wh-chart-plot sm-line-plot' });
  const tableBox = h('div', { class: 'hidden' });
  const toggle = h('button', { type: 'button', class: 'wh-btn ghost', 'aria-pressed': 'false', onClick: () => {
    const show = tableBox.classList.contains('hidden');
    toggleHidden(tableBox, !show); toggleHidden(plot, show);
    toggle.setAttribute('aria-pressed', String(show));
    setChildren(toggle, icon(show ? 'reports' : 'table'), show ? 'Chart view' : 'Table view');
  } }, icon('table'), 'Table view');
  const legend = h('div', { class: 'wh-legend' },
    h('span', null, h('i', { class: 'sm-key-line' }), 'Actual Sales'),
    perf.hasTarget ? h('span', null, h('i', { class: 'sm-key-line dashed' }), 'Sales Target') : null);
  const label = (p) => (perf.unit === 'month'
    ? new Date(`${p.key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    : new Date(`${p.key}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));

  setChildren(tableBox, h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table' },
    h('thead', null, h('tr', null, h('th', null, perf.unit === 'month' ? 'Month' : 'Day'), h('th', { class: 'num' }, 'Sales'), h('th', { class: 'num' }, 'Sales to date'), h('th', { class: 'num' }, 'Target to date'))),
    h('tbody', null, pts.map((p) => h('tr', null, h('td', null, label(p)), h('td', { class: 'num' }, ghs(p.actual)), h('td', { class: 'num' }, p.cumActual === null ? '—' : ghs(p.cumActual)), h('td', { class: 'num' }, p.cumTarget === null ? '—' : ghs(p.cumTarget))))))));

  function draw() {
    const width = Math.max(300, plot.clientWidth || 640);
    const height = 270;
    const L = 70; const R = 14; const T = 14; const B = 32;
    const pw = width - L - R; const ph = height - T - B;
    const max = Math.max(1, ...pts.map((p) => Math.max(p.cumActual || 0, p.cumTarget || 0)));
    const step = niceStep(max);
    const top = step * Math.ceil(max / step);
    const y = (v) => T + ph * (1 - v / top);
    const x = (i) => L + (pts.length === 1 ? pw / 2 : (i * pw) / (pts.length - 1));
    const svgEl = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'wh-chart-svg sm-line', role: 'img', 'aria-label': `Sales to date against the target, by ${perf.unit}` });
    for (let v = 0; v <= top + 1e-9; v += step) {
      svgEl.append(s('line', { class: v === 0 ? 'wh-axis' : 'wh-grid', x1: L, x2: width - R, y1: y(v), y2: y(v) }));
      svgEl.append(s('text', { class: 'wh-tick', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, ghsShort(v)));
    }
    const every = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor(pw / 64))));
    pts.forEach((p, i) => { if (i % every === 0 || i === pts.length - 1) svgEl.append(s('text', { class: 'wh-tick', x: x(i), y: height - 10, 'text-anchor': i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle' }, label(p))); });
    const actual = pts.map((p, i) => [i, p.cumActual]).filter(([, v]) => v !== null);
    if (perf.hasTarget) svgEl.append(s('path', { class: 'sm-target-line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.cumTarget)}`).join('') }));
    if (actual.length) {
      const line = actual.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i)},${y(v)}`).join('');
      svgEl.append(s('path', { class: 'sm-area', d: `${line}L${x(actual[actual.length - 1][0])},${y(0)}L${x(actual[0][0])},${y(0)}Z` }));
      svgEl.append(s('path', { class: 'sm-actual-line', d: line }));
    }
    const cross = s('line', { class: 'sm-cross hidden', y1: T, y2: T + ph });
    const dotA = s('circle', { class: 'sm-dot-actual hidden', r: 4.5 });
    const dotT = s('circle', { class: 'sm-dot-target hidden', r: 4 });
    svgEl.append(cross, dotA, dotT);
    const slot = pw / Math.max(1, pts.length - 1);
    pts.forEach((p, i) => {
      const hit = s('rect', { class: 'wh-hit', x: Math.max(L, x(i) - slot / 2), y: T, width: pts.length === 1 ? pw : slot, height: ph });
      hit.addEventListener('pointermove', (ev) => {
        cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.classList.remove('hidden');
        if (p.cumActual !== null) { dotA.setAttribute('cx', x(i)); dotA.setAttribute('cy', y(p.cumActual)); dotA.classList.remove('hidden'); } else dotA.classList.add('hidden');
        if (p.cumTarget !== null) { dotT.setAttribute('cx', x(i)); dotT.setAttribute('cy', y(p.cumTarget)); dotT.classList.remove('hidden'); } else dotT.classList.add('hidden');
        setChildren(tip, h('b', null, label(p)),
          h('span', null, `Sales: ${ghs(p.actual)}`),
          h('span', null, h('i', { class: 'sm-key-line' }), `Sales to date: ${p.cumActual === null ? '—' : ghs(p.cumActual)}`),
          p.cumTarget !== null ? h('span', null, h('i', { class: 'sm-key-line dashed' }), `Target to date: ${ghs(p.cumTarget)}`) : null);
        toggleHidden(tip, false);
        const box = plot.getBoundingClientRect();
        tip.style.left = `${Math.min(Math.max(8, (ev.clientX - box.left) + 14), box.width - 210)}px`;
        tip.style.top = `${Math.max(4, y(Math.max(p.cumActual || 0, p.cumTarget || 0)) - 30)}px`;
      });
      hit.addEventListener('pointerleave', () => { [cross, dotA, dotT].forEach((n) => n.classList.add('hidden')); toggleHidden(tip, true); });
      svgEl.append(hit);
    });
    setChildren(plot, svgEl, tip);
  }
  const el = h('div', { class: 'wh-chart' }, h('div', { class: 'wh-chart-bar' }, legend, toggle), plot, tableBox,
    h('p', { class: 'wh-note' }, perf.hasTarget ? perf.method : 'No team target is set for this period: set one on Sales Targets to draw the target line.'));
  onResize(plot, draw);
  return el;
}

// ------------------------------------------------------------------ sales by representative (donut)
const DONUT_TOP = 5;
function donutChart(byRep) {
  const total = byRep.slices.reduce((t, x) => t + x.value, 0);
  if (!byRep.slices.length || total <= 0) return empty('No sales in this period', 'Sales appear once Odoo invoices orders.');
  const top = byRep.slices.slice(0, DONUT_TOP);
  const rest = byRep.slices.slice(DONUT_TOP);
  const slices = rest.length ? [...top, { name: `Other reps (${rest.length})`, repId: null, value: rest.reduce((t, x) => t + x.value, 0), share: rest.reduce((t, x) => t + (x.share || 0), 0), other: true }] : top;
  const size = 184; const R = 86; const r = 58; const c = size / 2;
  const svgEl = s('svg', { viewBox: `0 0 ${size} ${size}`, width: size, height: size, class: 'sm-donut', role: 'img', 'aria-label': `Sales by representative: ${slices.map((x) => `${x.name} ${pctText(x.share)}`).join(', ')}` });
  const centerValue = s('text', { class: 'sm-donut-value', x: c, y: c - 2, 'text-anchor': 'middle' }, ghsShort(total));
  const centerLabel = s('text', { class: 'sm-donut-label', x: c, y: c + 16, 'text-anchor': 'middle' }, 'Total sales');
  const rows = [];
  let a0 = -Math.PI / 2;
  slices.forEach((x, i) => {
    const sweep = (x.value / total) * Math.PI * 2;
    const a1 = a0 + sweep;
    const p = (rad, radius) => [c + radius * Math.cos(rad), c + radius * Math.sin(rad)];
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = p(a0, R); const [x1, y1] = p(a1, R); const [x2, y2] = p(a1, r); const [x3, y3] = p(a0, r);
    const d = slices.length === 1
      ? `M${c},${c - R}A${R},${R} 0 1 1 ${c - 0.01},${c - R}L${c - 0.01},${c - r}A${r},${r} 0 1 0 ${c},${c - r}Z`
      : `M${x0},${y0}A${R},${R} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r},${r} 0 ${large} 0 ${x3},${y3}Z`;
    const cls = x.other ? 'sm-slice-other' : `sm-slice-${i}`;
    const arc = s('path', { class: `sm-slice ${cls}`, d });
    const focus = (on) => {
      arc.classList.toggle('on', on); rows[i]?.classList.toggle('on', on);
      centerValue.textContent = on ? pctText(x.share) : ghsShort(total);
      centerLabel.textContent = on ? x.name.split(' ')[0] : 'Total sales';
    };
    arc.addEventListener('pointerenter', () => focus(true));
    arc.addEventListener('pointerleave', () => focus(false));
    if (x.repId) { arc.addEventListener('click', () => { location.hash = `#/performance/${encodeURIComponent(x.repId)}`; }); arc.style.cursor = 'pointer'; }
    svgEl.append(arc);
    a0 = a1;
    const name = x.repId ? h('a', { href: `#/performance/${encodeURIComponent(x.repId)}`, class: 'wh-ref' }, x.name) : h('span', null, x.name);
    rows.push(h('tr', { onPointerenter: () => focus(true), onPointerleave: () => focus(false) },
      h('td', null, h('i', { class: `sm-swatch ${cls}`, 'aria-hidden': 'true' }), name),
      h('td', { class: 'num' }, ghs(x.value, 0)), h('td', { class: 'num' }, pctText(x.share))));
  });
  svgEl.append(centerValue, centerLabel);
  return h('div', { class: 'sm-donut-wrap' }, svgEl,
    h('table', { class: 'wh-table sm-donut-table' },
      h('thead', null, h('tr', null, h('th', null, 'Representative'), h('th', { class: 'num' }, 'Sales'), h('th', { class: 'num' }, 'Share'))),
      h('tbody', null, rows)));
}

// ------------------------------------------------------------------ team performance panel
function teamPanel(d) {
  const t = d.team;
  const row = (key, title, tone, href) => h('li', null, h('a', { class: 'wh-expiry-row', href },
    h('span', { class: `wh-dot ${tone}`, 'aria-hidden': 'true' }),
    h('span', { class: 'wh-expiry-text' }, h('b', null, title), h('small', null, t.reps ? `${pctText((t.counts[key] / t.reps) * 100)} of the team` : '—')),
    h('b', { class: 'wh-expiry-n' }, qty(t.counts[key])), icon('chevronRight')));
  return h('div', null,
    h('ul', { class: 'wh-expiry' },
      row('ON_TRACK', 'On Target', 'success', '#/performance?status=ON_TRACK'),
      row('AT_RISK', 'At Risk', 'warning', '#/performance?status=AT_RISK'),
      row('BELOW_TARGET', 'Below Target', 'danger', '#/performance?status=BELOW_TARGET')),
    t.counts.NO_TARGET ? h('p', { class: 'wh-note' }, `${plural(t.counts.NO_TARGET, 'rep')} with no target for this period.`) : null,
    h('p', { class: 'wh-note' }, `Against the target expected by today: on target at ${pctText(d.thresholds.onTrackPct)} or more, at risk from ${pctText(d.thresholds.atRiskPct)}. `,
      h('a', { href: '#/sales-settings', class: 'wh-ref' }, 'Change')));
}

// ------------------------------------------------------------------ orders table
function ordersTable(items, { compact = false } = {}) {
  if (!items.length) return empty('No orders in this period', 'Orders customers and reps place on BFL appear here.');
  const amount = (o) => (o.amount === null ? h('span', { class: 'wh-muted' }, '—')
    : [ghs(o.amount), o.amountKind === 'ESTIMATE' ? h('span', { class: 'wh-muted sm-est', title: 'Price-list estimate until Odoo invoices the order' }, ' est.') : null]);
  const head = compact ? ['Order', 'Customer', 'Amount', 'Status'] : ['Order #', 'Customer', 'Representative', 'Amount', 'Status', 'Pay by', 'Date'];
  return h('div', { class: 'wh-table-wrap' }, h('table', { class: `wh-table sm-orders${compact ? ' compact' : ''}` },
    h('thead', null, h('tr', null, head.map((t) => h('th', { scope: 'col', class: t === 'Amount' ? 'num' : null }, t)))),
    h('tbody', null, items.map((o) => {
      const open = () => { location.hash = `#/requests/${o.requestId}`; };
      const ref = [h('b', null, o.odooNumber || o.reference), o.odooNumber ? h('span', { class: 'wh-muted' }, o.reference) : null];
      const due = o.customerType === 'CASH' ? h('span', { class: 'wh-muted' }, 'Cash') : o.dueDate ? dateText(o.dueDate)
        : ['CANCELLED', 'PAID'].includes(o.state) ? '—' : h('span', { class: 'sm-missing' }, 'Not set');
      return h('tr', { class: 'wh-row-link', tabindex: '0', 'aria-label': `Open order ${o.reference}`, onClick: open, onKeydown: (e) => { if (e.key === 'Enter') open(); } },
        compact ? h('td', { class: 'wh-td-name' }, ...ref, h('span', { class: 'wh-muted' }, dateText(o.placedAt))) : h('td', { class: 'wh-td-name' }, ...ref),
        compact ? h('td', { class: 'wh-td-name' }, h('b', null, o.customer), h('span', { class: 'wh-muted' }, o.rep || 'No rep'))
          : h('td', null, o.customerId ? h('a', { class: 'wh-ref', href: `#/customers/${o.customerId}`, onClick: (e) => e.stopPropagation() }, o.customer) : o.customer),
        compact ? null : h('td', null, o.rep || h('span', { class: 'wh-muted' }, 'No rep')),
        h('td', { class: 'num wh-nowrap' }, amount(o)),
        h('td', null, badge(o.stateLabel, o.tone)),
        compact ? null : h('td', { class: 'wh-nowrap' }, due),
        compact ? null : h('td', { class: 'wh-nowrap' }, dateText(o.placedAt)));
    }))));
}

// ------------------------------------------------------------------ the dashboard
export async function renderSalesHome(view) {
  const latest = createLatest();
  const kpis = h('div', { class: 'wh-kpis sm-kpis', 'aria-label': 'Key figures' }, Array.from({ length: 6 }, () => h('div', { class: 'wh-kpi' }, loading(2))));
  const perfBody = h('div', null, loading(6));
  const donutBody = h('div', null, loading(5));
  const teamBody = h('div', null, loading(4));
  const ordersBody = h('div', null, loading(5));
  const sourceNote = h('p', { class: 'wh-note hidden' });
  const reps = createRepsTable({ pageSize: 6 });
  const period = salesPeriodControl((p) => load(p));

  setChildren(view, h('div', { class: 'wh-page sm-page' },
    pageHead('Sales Manager Dashboard', 'Track your team\'s performance, sales targets and business growth.', period.el,
      `${greeting()} · ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}`),
    kpis,
    h('div', { class: 'sm-analytics' },
      card('sm-perf-card', cardHead('Sales Performance', 'Total sales vs. target for the selected period'), perfBody),
      card('', cardHead('Sales by Representative', null, viewAll('#/performance')), donutBody),
      card('', cardHead('Team Performance', null, viewAll('#/performance')), teamBody)),
    h('div', { class: 'sm-bottom' },
      card('', cardHead('Sales Representatives', 'Target, sales and progress for the selected period', viewAll('#/performance')), reps.el),
      card('', cardHead('Recent Orders', null, viewAll('#/orders')), ordersBody)),
    sourceNote));

  async function load(p = period.value()) {
    const mine = latest.next();
    let d;
    try { d = await api.salesSummary(p); } catch (e) {
      if (!latest.is(mine)) return;
      for (const b of [kpis, perfBody, donutBody, teamBody, ordersBody]) setChildren(b, errorBox(e));
      reps.showError(e);
      return;
    }
    if (!latest.is(mine)) return;
    const k = d.kpis;
    const per = d.range.period;
    setChildren(kpis,
      kpiCard({ href: '#/reports', iconName: 'banknote', tone: 'blue', title: 'Total Sales', value: ghs(k.totalSales.value), extra: changeLine(k.totalSales.changePct, k.totalSales.previous, per) }),
      kpiCard({ href: '#/targets', iconName: 'target', tone: 'purple', title: k.target.wholeMonth ? 'Monthly Target' : 'Sales Target',
        value: k.target.value === null ? 'Not set' : ghs(k.target.value, 0),
        extra: k.target.value === null ? null : progress(k.target.achievedPct),
        sub: k.target.value === null ? 'Set it on Sales Targets' : `${pctText(k.target.achievedPct)} achieved${k.target.wholeMonth ? '' : ' · share of the monthly targets'}${k.target.partial ? ' · not every month has a target' : ''}` }),
      kpiCard({ href: '#/targets', iconName: 'trendingUp', tone: 'orange', title: 'Remaining to Target',
        value: k.remaining.value === null ? '—' : ghs(k.remaining.value, 0),
        sub: k.remaining.value === null ? 'No target set' : k.remaining.exceededBy > 0 ? h('span', { class: 'sm-over' }, `Target exceeded by ${ghs(k.remaining.exceededBy, 0)}`) : `To reach the ${k.target.wholeMonth ? 'monthly ' : ''}target` }),
      kpiCard({ href: '#/performance', iconName: 'users', tone: 'blue', title: 'Active Sales Reps', value: qty(k.activeReps.value), sub: `${qty(k.activeReps.value)} of ${plural(k.activeReps.total, 'representative')} · ${qty(k.activeReps.withSales)} with sales` }),
      kpiCard({ href: '#/orders', iconName: 'cart', tone: 'blue', title: 'Total Orders', value: qty(k.totalOrders.value), extra: changeLine(k.totalOrders.changePct, k.totalOrders.previous, per, qty) }),
      kpiCard({ href: '#/customers?owing=1', iconName: 'wallet', tone: 'red', title: 'Outstanding Balances', value: ghs(k.outstanding.value, 0), sub: `${plural(k.outstanding.customers, 'customer')} with unpaid invoices` }));
    setChildren(perfBody, d.performance.points.length ? performanceChart(d.performance) : empty('Nothing to chart', 'Choose another period.'));
    setChildren(donutBody, donutChart(d.salesByRep));
    setChildren(teamBody, teamPanel(d));
    reps.setRows(d.reps);
    setChildren(ordersBody, ordersTable(d.recentOrders, { compact: true }));
    sourceNote.textContent = d.source === 'SAMPLE' ? SAMPLE_TEXT : '';
    toggleHidden(sourceNote, !sourceNote.textContent);
  }
  await load();
}

// ------------------------------------------------------------------ team performance (all reps) and one rep
export async function renderPerformance(view, repId = null) {
  if (repId) return renderRepDetail(view, decodeURIComponent(repId));
  const latest = createLatest();
  const summary = h('div', { class: 'wh-kpis sm-kpis-4' }, Array.from({ length: 4 }, () => h('div', { class: 'wh-kpi' }, loading(2))));
  const reps = createRepsTable({ pageSize: 25, status: hashParam('status') });
  const period = salesPeriodControl((p) => load(p));
  setChildren(view, h('div', { class: 'wh-page sm-page' },
    pageHead('Team Performance', 'Every representative\'s target, sales and progress for the same period. Open a representative for their customers, orders and trend.', period.el),
    summary,
    card('', reps.el)));
  async function load(p = period.value()) {
    const mine = latest.next();
    let d;
    try { d = await api.salesSummary(p); } catch (e) { if (latest.is(mine)) { setChildren(summary, errorBox(e)); reps.showError(e); } return; }
    if (!latest.is(mine)) return;
    const c = d.team.counts;
    setChildren(summary,
      kpiCard({ iconName: 'userCheck', tone: 'blue', title: 'On Target', value: qty(c.ON_TRACK), sub: `of ${plural(d.team.reps, 'rep')}` }),
      kpiCard({ iconName: 'alert', tone: 'orange', title: 'At Risk', value: qty(c.AT_RISK), sub: `${pctText(d.thresholds.atRiskPct)}–${pctText(d.thresholds.onTrackPct)} of expected` }),
      kpiCard({ iconName: 'trendingUp', tone: 'red', title: 'Below Target', value: qty(c.BELOW_TARGET), sub: `under ${pctText(d.thresholds.atRiskPct)} of expected` }),
      kpiCard({ href: '#/targets', iconName: 'target', tone: 'purple', title: 'No Target', value: qty(c.NO_TARGET), sub: 'Set targets on Sales Targets' }));
    reps.setRows(d.reps);
  }
  await load();
}

function miniTrend(trend) {
  const plot = h('div', { class: 'wh-chart-plot sm-trend-plot' });
  function draw() {
    const width = Math.max(280, plot.clientWidth || 480);
    const height = 200; const L = 64; const R = 8; const T = 10; const B = 28;
    const pw = width - L - R; const ph = height - T - B;
    const max = Math.max(1, ...trend.map((m) => Math.max(m.sales, m.target || 0)));
    const step = niceStep(max); const top = step * Math.ceil(max / step);
    const y = (v) => T + ph * (1 - Math.max(0, v) / top);
    const gw = pw / trend.length; const bw = Math.min(34, gw * 0.55);
    const svgEl = s('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'wh-chart-svg', role: 'img', 'aria-label': 'Sales per month against target, last six months' });
    for (let v = 0; v <= top + 1e-9; v += step) {
      svgEl.append(s('line', { class: v === 0 ? 'wh-axis' : 'wh-grid', x1: L, x2: width - R, y1: y(v), y2: y(v) }));
      svgEl.append(s('text', { class: 'wh-tick', x: L - 8, y: y(v) + 4, 'text-anchor': 'end' }, ghsShort(v)));
    }
    trend.forEach((m, i) => {
      const cx = L + gw * (i + 0.5);
      const bar = s('path', { class: 'wh-bar wh-bar-available', d: barPath(cx - bw / 2, y(m.sales), bw, y(0)) });
      bar.append(s('title', {}, `${m.month}: ${ghs(m.sales)}${m.target !== null ? ` · target ${ghs(m.target)}` : ''}`));
      svgEl.append(bar);
      if (m.target !== null) svgEl.append(s('line', { class: 'sm-target-tick', x1: cx - bw / 2 - 5, x2: cx + bw / 2 + 5, y1: y(m.target), y2: y(m.target) }));
      svgEl.append(s('text', { class: 'wh-tick', x: cx, y: height - 9, 'text-anchor': 'middle' }, new Date(`${m.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' })));
    });
    setChildren(plot, svgEl);
  }
  onResize(plot, draw);
  return h('div', null, h('div', { class: 'wh-legend' }, h('span', null, h('i', { class: 'wh-key wh-bar-available' }), 'Sales'), h('span', null, h('i', { class: 'sm-key-line dashed' }), 'Target')), plot);
}

async function renderRepDetail(view, repId) {
  const latest = createLatest();
  const head = h('div');
  const kpis = h('div', { class: 'wh-kpis sm-kpis-4' }, Array.from({ length: 8 }, () => h('div', { class: 'wh-kpi' }, loading(2))));
  const trendBody = h('div', null, loading(4));
  const customersBody = h('div', null, loading(4));
  const ordersBody = h('div', null, loading(4));
  const period = salesPeriodControl((p) => load(p));
  setChildren(view, h('div', { class: 'wh-page sm-page' },
    h('a', { class: 'wh-link sm-back', href: '#/performance' }, icon('chevronLeft'), 'Team Performance'),
    h('div', { class: 'wh-head' }, head, period.el),
    kpis,
    h('div', { class: 'sm-bottom' },
      card('', cardHead('Customers', 'Sales in the period, what is still owed, and the last order'), customersBody),
      card('', cardHead('Sales Trend', 'The last six months against this rep\'s target'), trendBody)),
    card('', cardHead('Orders in the period'), ordersBody)));
  async function load(p = period.value()) {
    const mine = latest.next();
    let d;
    try { d = await api.salesRep(repId, p); } catch (e) {
      if (!latest.is(mine)) return;
      setChildren(head, h('h1', null, 'Representative')); setChildren(kpis, errorBox(e)); setChildren(trendBody); setChildren(customersBody); setChildren(ordersBody);
      return;
    }
    if (!latest.is(mine)) return;
    const r = d.rep;
    setChildren(head, h('div', { class: 'sm-rep-head' }, avatar(r.initials),
      h('div', null, h('h1', null, r.name), h('p', { class: 'wh-sub' }, `${plural(r.customers, 'assigned customer')}${r.account ? '' : r.sample ? ' · sample rep, no BFL account' : ' · no BFL account'} · `, statusBadge(r.status)))));
    setChildren(kpis,
      kpiCard({ iconName: 'target', tone: 'purple', title: 'Assigned Target', value: r.target === null ? 'Not set' : ghs(r.target, 0), sub: r.target === null ? 'Set it on Sales Targets' : `Expected by today: ${ghs(r.expected, 0)}` }),
      kpiCard({ iconName: 'banknote', tone: 'blue', title: 'Actual Sales', value: ghs(r.achieved, 0) }),
      kpiCard({ iconName: 'trendingUp', tone: 'blue', title: 'Target Achievement', value: pctText(r.progressPct), extra: r.target === null ? null : progress(r.progressPct, r.expectedPct, toneFor(r.status)) }),
      kpiCard({ iconName: 'target', tone: 'orange', title: 'Remaining Target', value: r.target === null ? '—' : ghs(r.remaining, 0), sub: r.exceededBy > 0 ? h('span', { class: 'sm-over' }, `Exceeded by ${ghs(r.exceededBy, 0)}`) : null }),
      kpiCard({ iconName: 'cart', tone: 'blue', title: 'Orders', value: qty(r.orders), sub: d.range.label }),
      kpiCard({ iconName: 'receipt', tone: 'blue', title: 'Average Invoice', value: d.averageInvoice === null ? '—' : ghs(d.averageInvoice, 0), sub: `${plural(d.invoices, 'invoice')} in the period` }),
      kpiCard({ iconName: 'wallet', tone: 'red', title: 'Outstanding', value: ghs(d.outstanding, 0), sub: 'Unpaid by their customers' }),
      kpiCard({ iconName: 'history', tone: 'blue', title: 'Last Activity', value: r.lastActivity ? ago(r.lastActivity.at) : '—', sub: r.lastActivity ? r.lastActivity.what : 'No activity yet' }));
    setChildren(trendBody, miniTrend(d.trend));
    setChildren(customersBody, d.customers.length ? h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table' },
      h('thead', null, h('tr', null, h('th', null, 'Customer'), h('th', { class: 'num' }, 'Sales'), h('th', { class: 'num' }, 'Outstanding'), h('th', null, 'Last order'))),
      h('tbody', null, d.customers.map((c) => h('tr', { class: 'wh-row-link', tabindex: '0', onClick: () => { location.hash = `#/customers/${c.id}`; }, onKeydown: (e) => { if (e.key === 'Enter') location.hash = `#/customers/${c.id}`; } },
        h('td', { class: 'wh-td-name' }, h('b', null, c.name), h('span', { class: 'wh-muted' }, [c.ref, c.type === 'CASH' ? 'Cash' : null].filter(Boolean).join(' · ') || '—')),
        h('td', { class: 'num' }, ghs(c.sales, 0)), h('td', { class: 'num' }, c.outstanding ? ghs(c.outstanding, 0) : '—'), h('td', { class: 'wh-nowrap' }, c.lastOrder ? dateText(c.lastOrder) : '—'))))))
      : empty('No customers assigned', 'Assign customers on Rep Customers.'));
    setChildren(ordersBody, ordersTable(d.orders));
  }
  await load();
}

// ------------------------------------------------------------------ sales targets
export async function renderSalesTargets(view) {
  const today = new Date().toISOString().slice(0, 10);
  const month = h('input', { type: 'month', class: 'wh-input', 'aria-label': 'Month', value: hashParam('month') || today.slice(0, 7), onChange: () => load() });
  const appliesTo = h('select', { class: 'wh-select', 'aria-label': 'The targets you save apply to' },
    h('option', { value: 'MONTH' }, 'Save for the chosen month'), h('option', { value: 'DEFAULT' }, 'Save as the default for every month'));
  const body = h('div', null, loading(6));
  const history = h('div', null, loading(4));
  setChildren(view, h('div', { class: 'wh-page sm-page' },
    pageHead('Sales Targets', 'Net-sales targets for the team and for each representative. A month\'s own target wins over the default. Every change is kept with who made it and why.',
      h('div', { class: 'wh-period' }, icon('calendar'), month, appliesTo)),
    body,
    card('', cardHead('Target History', 'Every change: the old and new amount, who made it, when and why'), history)));

  function targetForm(scope, rep, current) {
    const amount = h('input', { type: 'number', min: '0', step: '100', class: 'wh-input sm-amount', 'aria-label': `New target${rep ? ` for ${rep}` : ' for the team'}`, placeholder: current.value === null ? 'Amount (GH₵)' : String(current.value) });
    const reason = h('input', { type: 'text', class: 'wh-input sm-reason', maxlength: '300', placeholder: 'Reason for the change', 'aria-label': 'Reason for the change' });
    const save = h('button', { type: 'submit', class: 'wh-btn' }, 'Save');
    const msg = h('span', { class: 'sm-form-msg', role: 'status' });
    return h('form', { class: 'sm-target-form', onSubmit: async (e) => {
      e.preventDefault();
      if (amount.value === '') { msg.textContent = 'Enter an amount.'; return; }
      save.disabled = true; msg.textContent = '';
      try {
        await api.setSalesTarget({ scope, rep, month: appliesTo.value === 'DEFAULT' ? 'DEFAULT' : month.value, value: Number(amount.value), reason: reason.value });
        toast('Target saved.');
        await load();
      } catch (err) { msg.textContent = err.message; } finally { save.disabled = false; }
    } }, amount, current.value === null ? null : reason, save, msg);
  }

  async function load() {
    let d; let hist;
    try { [d, hist] = await Promise.all([api.salesTargets(month.value), api.salesTargetHistory()]); } catch (e) { setChildren(body, errorBox(e)); setChildren(history); return; }
    const sourceText = (t) => (t.source === 'MONTH' ? `Set for ${d.month}${t.setBy ? ` by ${t.setBy}` : ''}` : t.source === 'DEFAULT' ? 'The default for every month' : 'No target');
    const rec = d.reconciliation;
    setChildren(body,
      h('div', { class: 'sm-bottom' },
        card('', cardHead('Team Target', `${d.month}${d.monthToDate ? ' · month to date' : ''}`),
          h('div', { class: 'sm-target-head' },
            h('div', null, h('b', { class: 'sm-big' }, d.team.value === null ? 'Not set' : ghs(d.team.value, 0)), h('p', { class: 'wh-muted' }, sourceText(d.team))),
            h('div', null, h('span', { class: 'wh-muted' }, 'Achieved'), h('b', { class: 'sm-big' }, ghs(d.team.achieved, 0)), d.team.value ? progress(d.team.achievedPct) : null)),
          targetForm('COMPANY', null, d.team)),
        card('', cardHead('Reconciliation', 'The team target against the sum of the representatives\' targets'),
          h('dl', { class: 'sm-facts' },
            h('dt', null, 'Sum of rep targets'), h('dd', null, ghs(rec.sumOfReps, 0)),
            h('dt', null, 'Team target'), h('dd', null, rec.team === null ? 'Not set' : ghs(rec.team, 0)),
            h('dt', null, 'Difference'), h('dd', null, rec.difference === null ? '—' : rec.difference === 0 ? h('span', { class: 'sm-over' }, 'They match') : `${ghs(Math.abs(rec.difference), 0)} — the team target is ${rec.difference > 0 ? 'higher' : 'lower'}`)),
          rec.repsWithoutTarget.length ? h('p', { class: 'wh-note' }, `No target for: ${rec.repsWithoutTarget.join(', ')}.`) : null,
          h('p', { class: 'wh-note' }, 'The team target and the rep targets are kept separately: the team target can include customers with no rep.'))),
      card('', cardHead('Representative Targets', 'Each rep\'s net-sales target, their sales this month and progress'),
        d.reps.length ? h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table' },
          h('thead', null, h('tr', null, h('th', null, 'Representative'), h('th', { class: 'num' }, 'Target'), h('th', { class: 'num' }, 'Achieved'), h('th', null, 'Progress'), h('th', null, 'Change target'))),
          h('tbody', null, d.reps.map((r) => h('tr', null,
            h('td', { class: 'wh-td-name' }, h('b', null, r.name), h('span', { class: 'wh-muted' }, sourceText(r))),
            h('td', { class: 'num' }, r.value === null ? '—' : ghs(r.value, 0)), h('td', { class: 'num' }, ghs(r.achieved, 0)),
            h('td', null, r.value ? progress(r.achievedPct) : h('span', { class: 'wh-muted' }, '—')),
            h('td', null, targetForm('REP', r.name, r))))))) : empty('No sales representatives yet', 'Add one on Team Accounts.')));
    const who = (x) => (x.scope === 'COMPANY' ? 'Team' : x.scopeValue);
    setChildren(history, hist.items.length ? h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table' },
      h('thead', null, h('tr', null, h('th', null, 'When'), h('th', null, 'Target'), h('th', null, 'Month'), h('th', { class: 'num' }, 'Old'), h('th', { class: 'num' }, 'New'), h('th', null, 'By'), h('th', null, 'Reason'))),
      h('tbody', null, hist.items.map((x) => h('tr', null,
        h('td', { class: 'wh-nowrap' }, dateText(x.changedAt)), h('td', null, who(x)), h('td', null, x.month === 'DEFAULT' ? 'Every month' : x.month),
        h('td', { class: 'num' }, x.oldValue === null ? '—' : ghs(x.oldValue, 0)), h('td', { class: 'num' }, x.newValue === null ? 'Cleared' : ghs(x.newValue, 0)),
        h('td', null, x.changedBy || '—'), h('td', null, x.reason || h('span', { class: 'wh-muted' }, '—')))))))
      : empty('No changes recorded yet', 'Changes appear here as targets are set.'));
  }
  await load();
}

// ------------------------------------------------------------------ orders
export async function renderOrdersPage(view) {
  const state = { search: '', state: hashParam('state'), rep: '', offset: 0 };
  const PAGE = 25;
  const latest = createLatest();
  const body = h('div', null, loading(6));
  const search = h('input', { type: 'search', class: 'wh-input wh-search', placeholder: 'Search order number or customer…', 'aria-label': 'Search orders', onInput: debounce(() => { state.search = search.value.trim(); state.offset = 0; load(); }, 250) });
  const stateSel = h('select', { class: 'wh-select', 'aria-label': 'Status', onChange: () => { state.state = stateSel.value; state.offset = 0; load(); } },
    h('option', { value: '' }, 'All Statuses'), h('option', { value: 'AWAITING_DUE_DATE', selected: state.state === 'AWAITING_DUE_DATE' }, 'Payment due date not set'));
  const repSel = h('select', { class: 'wh-select', 'aria-label': 'Representative', onChange: () => { state.rep = repSel.value; state.offset = 0; load(); } }, h('option', { value: '' }, 'All Representatives'));
  const foot = pager((d) => { state.offset = Math.max(0, state.offset + d * PAGE); load(); });
  const period = salesPeriodControl(() => { state.offset = 0; load(); });
  let optionsLoaded = false;
  setChildren(view, h('div', { class: 'wh-page sm-page' },
    pageHead('Orders', 'Orders placed on BFL, with their Odoo number, status and the payment due date. Open an order to see its lines or set when it is to be paid.', period.el),
    card('', h('div', { class: 'wh-filters' }, h('label', { class: 'wh-search-wrap' }, icon('search'), search), stateSel, repSel), body, foot.el)));
  async function load() {
    const mine = latest.next();
    let d;
    try { d = await api.salesOrders({ ...period.value(), ...state, limit: PAGE }); } catch (e) { if (latest.is(mine)) setChildren(body, errorBox(e)); return; }
    if (!latest.is(mine)) return;
    if (!optionsLoaded) {
      optionsLoaded = true;
      stateSel.append(...Object.entries(d.states).map(([k, t]) => h('option', { value: k, selected: k === state.state }, t)));
      repSel.append(...d.reps.map((r) => h('option', { value: r }, r)), h('option', { value: 'Unassigned' }, 'No rep'));
    }
    setChildren(body, ordersTable(d.items));
    foot.paint(d.offset, d.items.length, d.total, d.limit, 'order');
  }
  await load();
}

// ------------------------------------------------------------------ customers
export async function renderCustomersPage(view, id = null) {
  if (id) return renderCustomerDetail(view, id);
  const state = { search: '', rep: '', activity: '', owing: hashParam('owing') === '1', sort: hashParam('owing') === '1' ? 'outstanding' : 'name', offset: 0 };
  const PAGE = 25;
  const latest = createLatest();
  const body = h('div', null, loading(6));
  const counts = h('div', { class: 'wh-type-counts' });
  const search = h('input', { type: 'search', class: 'wh-input wh-search', placeholder: 'Search customer name or ID…', 'aria-label': 'Search customers', onInput: debounce(() => { state.search = search.value.trim(); state.offset = 0; load(); }, 250) });
  const repSel = h('select', { class: 'wh-select', 'aria-label': 'Representative', onChange: () => { state.rep = repSel.value; state.offset = 0; load(); } }, h('option', { value: '' }, 'All Representatives'));
  const activitySel = h('select', { class: 'wh-select', 'aria-label': 'Activity', onChange: () => { state.activity = activitySel.value; state.offset = 0; load(); } },
    h('option', { value: '' }, 'All Activity'), Object.entries(ACTIVITY).map(([k, [t]]) => h('option', { value: k }, t)));
  const sortSel = h('select', { class: 'wh-select', 'aria-label': 'Sort by', onChange: () => { state.sort = sortSel.value; load(); } },
    [['name', 'Sort: Name'], ['sales', 'Sort: Sales'], ['outstanding', 'Sort: Outstanding'], ['activity', 'Sort: Last activity']].map(([v, t]) => h('option', { value: v, selected: v === state.sort }, t)));
  const owing = h('input', { type: 'checkbox', checked: state.owing, onChange: () => { state.owing = owing.checked; state.offset = 0; load(); } });
  const foot = pager((d) => { state.offset = Math.max(0, state.offset + d * PAGE); load(); });
  const period = salesPeriodControl(() => { state.offset = 0; load(); });
  let optionsLoaded = false;
  setChildren(view, h('div', { class: 'wh-page sm-page' },
    pageHead('Customers', 'Every customer with their representative, sales in the period, what they still owe and when they last ordered. Active = an order or invoice in the last 30 days.', period.el),
    card('', h('div', { class: 'wh-filters' }, h('label', { class: 'wh-search-wrap' }, icon('search'), search), repSel, activitySel, sortSel,
      h('label', { class: 'sm-check' }, owing, 'Owing money only')), counts, body, foot.el)));
  async function load() {
    const mine = latest.next();
    let d;
    try { d = await api.salesCustomers({ ...period.value(), search: state.search, rep: state.rep, activity: state.activity, owing: state.owing ? '1' : '', sort: state.sort, offset: state.offset, limit: PAGE }); } catch (e) { if (latest.is(mine)) setChildren(body, errorBox(e)); return; }
    if (!latest.is(mine)) return;
    if (!optionsLoaded) { optionsLoaded = true; repSel.append(...d.reps.map((r) => h('option', { value: r }, r)), h('option', { value: 'Unassigned' }, 'No rep')); }
    setChildren(counts, Object.entries(d.counts).filter(([, n]) => n).map(([k, n]) => badge(`${ACTIVITY[k][0]}: ${qty(n)}`, ACTIVITY[k][1])));
    setChildren(body, d.items.length ? h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table' },
      h('thead', null, h('tr', null, ['Customer', 'Representative', 'Sales', 'Orders', 'Outstanding', 'Last activity', 'Status'].map((t) => h('th', { scope: 'col', class: ['Sales', 'Orders', 'Outstanding'].includes(t) ? 'num' : null }, t)))),
      h('tbody', null, d.items.map((c) => {
        const open = () => { location.hash = `#/customers/${c.id}`; };
        return h('tr', { class: 'wh-row-link', tabindex: '0', 'aria-label': `Open ${c.name}`, onClick: open, onKeydown: (e) => { if (e.key === 'Enter') open(); } },
          h('td', { class: 'wh-td-name' }, h('b', null, c.name), h('span', { class: 'wh-muted' }, [c.ref ? `ID ${c.ref}` : null, c.type === 'CASH' ? 'Cash' : null, c.priceClass].filter(Boolean).join(' · '))),
          h('td', null, c.rep || h('span', { class: 'wh-muted' }, 'No rep')),
          h('td', { class: 'num' }, ghs(c.sales, 0)), h('td', { class: 'num' }, qty(c.orders)),
          h('td', { class: 'num' }, c.outstanding ? h('b', null, ghs(c.outstanding, 0)) : '—'),
          h('td', { class: 'wh-nowrap' }, c.lastActivity ? dateText(c.lastActivity) : '—'),
          h('td', null, badge(...ACTIVITY[c.activity])));
      })))) : empty('No customers match', 'Try another search or filter.'));
    foot.paint(d.offset, d.items.length, d.total, d.limit, 'customer');
  }
  await load();
}

async function renderCustomerDetail(view, id) {
  const latest = createLatest();
  const head = h('div');
  const kpis = h('div', { class: 'wh-kpis sm-kpis-4' }, Array.from({ length: 4 }, () => h('div', { class: 'wh-kpi' }, loading(2))));
  const trendBody = h('div', null, loading(4));
  const invoicesBody = h('div', null, loading(3));
  const ordersBody = h('div', null, loading(4));
  const period = salesPeriodControl((p) => load(p));
  setChildren(view, h('div', { class: 'wh-page sm-page' },
    h('a', { class: 'wh-link sm-back', href: '#/customers' }, icon('chevronLeft'), 'Customers'),
    h('div', { class: 'wh-head' }, head, period.el),
    kpis,
    h('div', { class: 'sm-bottom' },
      card('', cardHead('Sales Trend', 'Net sales per month, last six months'), trendBody),
      card('', cardHead('Unpaid Invoices', 'What is still owed today'), invoicesBody)),
    card('', cardHead('Order History', 'The latest orders, with the payment due date'), ordersBody)));
  async function load(p = period.value()) {
    const mine = latest.next();
    let d;
    try { d = await api.salesCustomer(id, p); } catch (e) { if (latest.is(mine)) { setChildren(head, h('h1', null, 'Customer')); setChildren(kpis, errorBox(e)); } return; }
    if (!latest.is(mine)) return;
    const c = d.customer;
    setChildren(head, h('h1', null, c.name), h('p', { class: 'wh-sub' }, [c.ref ? `Customer ID ${c.ref}` : null, c.type === 'CASH' ? 'Cash customer' : 'Credit customer', c.priceClass, c.rep ? `Rep: ${c.rep}` : 'No rep'].filter(Boolean).join(' · '), ' ', badge(...ACTIVITY[d.activity])));
    setChildren(kpis,
      kpiCard({ iconName: 'banknote', tone: 'blue', title: 'Sales', value: ghs(d.sales.value, 0), sub: `${plural(d.sales.invoices, 'invoice')} · ${d.range.label}` }),
      kpiCard({ iconName: 'wallet', tone: 'red', title: 'Outstanding', value: ghs(d.outstanding, 0), sub: d.finance ? `Overdue (Odoo): ${ghs(d.finance.overdue, 0)}` : 'Cash customer' }),
      kpiCard({ iconName: 'creditCard', tone: 'purple', title: 'Credit Limit', value: !d.finance || d.finance.creditLimit === null ? '—' : ghs(d.finance.creditLimit, 0), sub: d.finance ? 'From Odoo' : 'No credit on a cash account' }),
      kpiCard({ iconName: 'history', tone: 'blue', title: 'Last Order', value: d.lastOrder ? ago(d.lastOrder) : '—', sub: d.lastOrder ? dateText(d.lastOrder) : 'No orders yet' }));
    setChildren(trendBody, miniTrend(d.trend.map((m) => ({ ...m, target: null }))));
    setChildren(invoicesBody, d.openInvoices.length ? h('div', { class: 'wh-table-wrap' }, h('table', { class: 'wh-table' },
      h('thead', null, h('tr', null, h('th', null, 'Invoice'), h('th', null, 'Odoo due date'), h('th', { class: 'num' }, 'Amount'), h('th', { class: 'num' }, 'Still due'))),
      h('tbody', null, d.openInvoices.map((i) => h('tr', null, h('td', null, h('b', null, i.number)), h('td', null, dateText(i.dueDate)), h('td', { class: 'num' }, ghs(i.amount)), h('td', { class: 'num' }, h('b', null, ghs(i.due))))))))
      : empty('Nothing owed', 'Every invoice is paid.'));
    setChildren(ordersBody, ordersTable(d.orders));
  }
  await load();
}

// ------------------------------------------------------------------ notifications, settings, search
export async function renderSalesNotifications(view) {
  const body = h('div', null, loading(4));
  setChildren(view, h('div', { class: 'wh-page sm-page' }, pageHead('Notifications', 'What needs the sales team\'s attention now, each with where to deal with it.'), card('', body)));
  let d;
  try { d = await api.salesNotifications(); } catch (e) { setChildren(body, errorBox(e)); return; }
  setChildren(body, d.items.length
    ? h('ul', { class: 'wh-notes' }, d.items.map((n) => h('li', null, h('a', { href: n.href, class: 'wh-note-row' },
      h('span', { class: `wh-dot ${n.level === 'red' ? 'danger' : 'warning'}`, 'aria-hidden': 'true' }),
      h('span', { class: 'wh-expiry-text' }, h('b', null, n.title), h('small', null, n.detail)),
      h('b', { class: 'wh-expiry-n' }, qty(n.count)), icon('chevronRight')))))
    : empty('Nothing needs your attention', 'No registrations, requests, due dates or overdue invoices are waiting.'));
}

export async function renderSalesSettings(view) {
  const onTrack = h('input', { type: 'number', min: '50', max: '150', step: '1', class: 'wh-input sm-amount', 'aria-label': 'On target at' });
  const atRisk = h('input', { type: 'number', min: '10', max: '149', step: '1', class: 'wh-input sm-amount', 'aria-label': 'At risk from' });
  const msg = h('p', { class: 'sm-form-msg', role: 'status' });
  const meta = h('p', { class: 'wh-note' });
  const save = h('button', { type: 'submit', class: 'wh-btn' }, 'Save');
  setChildren(view, h('div', { class: 'wh-page sm-page' },
    pageHead('Settings', 'How the dashboard classifies the team, and links to your account.'),
    card('', cardHead('Team performance thresholds', 'A representative is compared with the share of their target expected by today (their target spread evenly over the days), not with the whole target.'),
      h('form', { class: 'sm-settings-form', onSubmit: async (e) => {
        e.preventDefault(); save.disabled = true; msg.textContent = '';
        try { paint(await api.setSalesSettings({ onTrackPct: Number(onTrack.value), atRiskPct: Number(atRisk.value) })); toast('Thresholds saved.'); } catch (err) { msg.textContent = err.message; } finally { save.disabled = false; }
      } },
      h('label', { class: 'pd-field' }, h('span', null, 'On target at (% of expected)'), onTrack),
      h('label', { class: 'pd-field' }, h('span', null, 'At risk from (% of expected)'), atRisk), save),
      msg, meta,
      h('p', { class: 'wh-note' }, 'Example: on the 10th of a 30-day month with a GH₵ 30,000 target, GH₵ 10,000 is expected. With the defaults (100% / 80%) a rep at GH₵ 10,000 or more is on target, from GH₵ 8,000 at risk, and below that below target.')),
    card('', cardHead('Your team'), h('ul', { class: 'sm-links' },
      h('li', null, h('a', { class: 'wh-ref', href: '#/team' }, 'Team accounts (sales reps)')),
      h('li', null, h('a', { class: 'wh-ref', href: '#/rep-customers' }, 'Which customers each rep looks after'))))));
  function paint(t) {
    onTrack.value = t.onTrackPct; atRisk.value = t.atRiskPct;
    meta.textContent = t.updatedAt ? `Last changed by ${t.updatedBy || 'staff'} on ${dateText(t.updatedAt)}.` : 'These are the defaults.';
  }
  try { paint(await api.salesSettings()); } catch (e) { msg.textContent = e.message; }
}

export async function renderSalesSearch(view) {
  const q = hashParam('q');
  const body = h('div', null, loading(4));
  setChildren(view, h('div', { class: 'wh-page sm-page' }, pageHead('Search', q ? `Results for “${q}”` : 'Type at least two letters in the search box above.'), body));
  if (q.length < 2) { setChildren(body); return; }
  let d;
  try { d = await api.salesSearch(q); } catch (e) { setChildren(body, errorBox(e)); return; }
  const group = (title, items, row) => card('', cardHead(title, plural(items.length, 'result')), items.length ? h('ul', { class: 'wh-notes' }, items.map(row)) : empty('Nothing found'));
  const item = (href, title, sub) => h('li', null, h('a', { class: 'wh-note-row', href }, h('span', { class: 'wh-expiry-text' }, h('b', null, title), h('small', null, sub)), icon('chevronRight')));
  setChildren(body, h('div', { class: 'sm-bottom' },
    group('Orders', d.orders, (o) => item(`#/requests/${o.requestId}`, `${o.odooNumber || o.reference} · ${o.customer}`, `${o.stateLabel} · ${dateText(o.placedAt)}${o.amount !== null ? ` · ${ghs(o.amount)}` : ''}`)),
    group('Customers', d.customers, (c) => item(`#/customers/${c.id}`, c.name, [c.ref ? `ID ${c.ref}` : null, c.rep ? `Rep: ${c.rep}` : 'No rep'].filter(Boolean).join(' · '))),
    group('Products', d.products, (p) => item(`#/products/${p.id}`, p.name, p.barcode)),
    group('Sales Representatives', d.reps, (r) => item(`#/performance/${encodeURIComponent(r.id)}`, r.name, 'Team performance'))));
}
