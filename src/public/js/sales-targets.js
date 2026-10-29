// Sales Manager — Team Performance and Sales Targets screens (and the dashboard's target panel).
//
// The figures come from the monthly-reports API (S06): net sales are Odoo invoices less credit
// notes, targets are the ones the Sales Manager entered. These screens only read and display them;
// eligibility rules stay on the server.
//
// The reports API needs a staff sign-in. A Sales Manager who opened this dashboard with the
// environment team account (not their own staff account) sees a clear sign-in state instead of
// broken numbers.
import { h, setChildren } from './lib/dom.js';
import { teamTargetRow, targetSkeleton } from './target-progress.js';
import {
  formatGhs, monthLabel, targetStatus, TARGET_STATUS_LABEL, TARGET_STATUS_TONE,
  hasTarget, achievementPct, remainingTarget, overTargetBy,
} from './lib/targets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function reportsFetch(path, options) {
  const res = await fetch(path, { headers: { Accept: 'application/json' }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** True when the reports API answers; false when this session has no staff sign-in. */
async function reportsReachable() {
  try { await reportsFetch('/api/reports'); return true; } catch { return false; }
}

/** The state shown when the reports API cannot be reached from this session. */
function staffSignInState() {
  return h('section', { class: 'bfl-panel' },
    h('div', { class: 'bfl-empty' },
      h('p', null, h('b', null, 'Sign in with your staff account')),
      h('p', null, 'Team targets and sales figures come from the monthly reports, which need your own Sales Manager staff sign-in — the shared team sign-in cannot read them.'),
      h('p', null, h('a', { class: 'bfl-btn secondary', href: '/staff/login' }, 'Go to staff sign-in'))));
}

function errorPanel(error) {
  return h('section', { class: 'bfl-panel' },
    h('div', { class: 'bfl-error-state', role: 'alert' },
      h('p', null, h('b', null, 'Could not load')), h('p', null, error.message || 'Something went wrong. Please try again.')));
}

/* ------------------------------------------------------------------ dashboard overview */

/** The "+12% from last month" line under a hero figure. */
function deltaLine(thisMonth, lastMonth) {
  const now = Number(thisMonth) || 0;
  const last = Number(lastMonth);
  if (!Number.isFinite(last) || last <= 0) {
    return h('span', { class: 'bfl-delta flat' }, now > 0 ? 'No figure for last month' : 'No invoices yet this month');
  }
  const pct = ((now - last) / last) * 100;
  const dir = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
  return h('span', { class: `bfl-delta ${dir}` }, `${pct > 0 ? '+' : ''}${pct.toFixed(0)}% from last month`);
}

const heroCard = (label, value, ...subs) => h('div', { class: 'bfl-hero' },
  h('span', { class: 'bfl-hero-label' }, label),
  h('b', { class: 'bfl-hero-value' }, value),
  ...subs.map((s) => (typeof s === 'string' ? h('span', { class: 'bfl-hero-sub' }, s) : s)));

/** One compact team-table row: name, target, sales and an inline progress bar with its %. */
function repProgressRow(r) {
  const pct = achievementPct(r.target, r.netSales);
  const status = targetStatus(r.target, r.netSales);
  const tone = status === 'REACHED' || status === 'EXCEEDED' ? ' reached' : status === 'BEHIND' ? ' behind' : '';
  return h('tr', null,
    h('td', { class: 'primary-text' }, r.rep),
    h('td', { class: 'num' }, hasTarget(r.target) ? formatGhs(r.target) : '—'),
    h('td', { class: 'num' }, formatGhs(r.netSales)),
    h('td', null, h('div', { class: 'bfl-progress-cell' },
      h('div', {
        class: `bfl-progress${tone}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-valuenow': String(Math.min(100, Math.round(pct))), 'aria-label': `${r.rep}: ${pct.toFixed(0)} percent of target`,
      }, h('i', { style: { width: `${Math.min(100, pct)}%` } })),
      h('span', null, hasTarget(r.target) ? `${pct.toFixed(0)}%` : '—'))));
}

/**
 * The dashboard's sales-performance zone: three hero cards (this month's net sales with the
 * delta on last month, the team target with its achievement bar, the remaining balance) and
 * the Sales Representatives table. Reads the CEO and SALES monthly reports, so it needs a
 * staff sign-in — the shared team sign-in sees the sign-in state instead of broken numbers.
 */
export async function mountSalesOverview(container) {
  if (!container) return;
  setChildren(container, targetSkeleton());
  let start;
  try { start = await reportsFetch('/api/reports'); } catch (e) {
    setChildren(container, e.status === 401 ? staffSignInState() : errorPanel(e));
    return;
  }
  const month = start.current;
  let ceo; let sales;
  try {
    [ceo, sales] = await Promise.all([
      reportsFetch(`/api/reports/report?report=CEO&month=${encodeURIComponent(month)}`),
      reportsFetch(`/api/reports/report?report=SALES&month=${encodeURIComponent(month)}`),
    ]);
  } catch (e) { setChildren(container, errorPanel(e)); return; }

  const netSales = (ceo.measures || []).find((m) => m.key === 'net_sales') || {};
  const achieved = Number(netSales.thisMonth) || 0;
  const target = hasTarget(netSales.target) ? Number(netSales.target) : null;
  const pct = achievementPct(target, achieved);
  const remaining = remainingTarget(target, achieved);
  const over = overTargetBy(target, achieved);
  const status = targetStatus(target, achieved);
  const reached = status === 'REACHED' || status === 'EXCEEDED';
  const soFar = ceo.monthToDate ? ' (so far)' : '';

  const hero = h('div', { class: 'bfl-hero-grid', 'aria-label': `Sales performance for ${monthLabel(month)}` },
    heroCard('Total Sales This Month', formatGhs(achieved), deltaLine(achieved, netSales.lastMonth)),
    heroCard('Team Target', target ? formatGhs(target) : 'Not set',
      target ? `${pct.toFixed(0)}% achieved${soFar}` : 'Set one on the Sales Targets screen',
      target ? h('div', {
        class: `bfl-progress${reached ? ' reached' : status === 'BEHIND' ? ' behind' : ''}`,
        role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100',
        'aria-valuenow': String(Math.min(100, Math.round(pct))), 'aria-label': `Team target ${pct.toFixed(0)} percent achieved`,
      }, h('i', { style: { width: `${Math.min(100, pct)}%` } })) : null),
    heroCard('Remaining', target ? formatGhs(remaining) : '—',
      over > 0 ? `Above target by ${formatGhs(over)}` : target ? 'Still to go this month' : 'No company target set'));

  const section = (sales.sections || []).find((s) => s.id === 'sales_by_rep');
  const rows = (section ? section.rows : []).slice().sort((a, b) => b.netSales - a.netSales).slice(0, 6);
  const table = h('section', { class: 'bfl-panel' },
    h('div', { class: 'bfl-panel-head' },
      h('div', null,
        h('h2', null, 'Sales Representatives'),
        h('p', null, `Eligible net sales against each representative's target · ${monthLabel(month)}${sales.monthToDate ? ' (so far)' : ''}`)),
      h('a', { class: 'bfl-btn secondary', href: '#/team' }, 'View all')),
    rows.length ? h('div', { class: 'bfl-table-wrap' }, h('table', { class: 'bfl-table' },
      h('thead', null, h('tr', null,
        [h('th', null, 'Name'), h('th', { class: 'num' }, 'Target'), h('th', { class: 'num' }, 'Sales'), h('th', null, 'Progress')])),
      h('tbody', null, rows.map(repProgressRow))))
      : h('div', { class: 'bfl-empty' },
        h('p', null, h('b', null, 'No sales activity yet')),
        h('p', null, 'Representatives appear here once Odoo invoices them for this month.')));

  setChildren(container, hero, table);
}

/* ------------------------------------------------------------------ team performance */

const TEAM_SORTS = {
  name: (a, b) => a.rep.localeCompare(b.rep),
  achieved: (a, b) => b.netSales - a.netSales,
  target: (a, b) => (b.target || 0) - (a.target || 0),
  pct: (a, b) => pctOf(b) - pctOf(a),
};
const pctOf = (r) => (r.target ? (r.netSales / r.target) * 100 : -1);

export async function renderTeamPerformance(view, route, { pageHead }) {
  const month = route.query.get('month') || '';
  const search = (route.query.get('search') || '').toLowerCase();
  const sort = route.query.get('sort') || 'achieved';

  // pageHead returns an HTML string in sales.js
  const mount = h('div', null, targetSkeleton());
  view.innerHTML = pageHead('Team Performance', 'Eligible net sales against each representative\'s monthly target');
  view.appendChild(mount);

  let start;
  try { start = await reportsFetch('/api/reports'); } catch (e) {
    setChildren(mount, e.status === 401 ? staffSignInState() : errorPanel(e));
    return;
  }
  const chosen = month || start.current;
  let report;
  try { report = await reportsFetch(`/api/reports/report?report=SALES&month=${encodeURIComponent(chosen)}`); } catch (e) {
    setChildren(mount, errorPanel(e));
    return;
  }
  const section = (report.sections || []).find((s) => s.id === 'sales_by_rep');
  let rows = section ? section.rows : [];
  if (search) rows = rows.filter((r) => r.rep.toLowerCase().includes(search));
  rows = [...rows].sort(TEAM_SORTS[sort] || TEAM_SORTS.achieved);

  const monthSel = h('select', { 'aria-label': 'Month', class: 'sm-select', onChange: () => go() },
    start.months.map((m) => h('option', { value: m, selected: m === chosen }, monthLabel(m) + (m === start.current ? ' (so far)' : ''))));
  const searchBox = h('input', {
    type: 'search', value: route.query.get('search') || '', placeholder: 'Find a representative',
    'aria-label': 'Find a representative', class: 'sm-select', style: { minWidth: '180px' },
    onKeydown: (e) => { if (e.key === 'Enter') go(); },
  });
  const sortSel = h('select', { 'aria-label': 'Sort by', class: 'sm-select', onChange: () => go() },
    [['achieved', 'Sort: sales achieved'], ['pct', 'Sort: target %'], ['target', 'Sort: target'], ['name', 'Sort: name']]
      .map(([v, t]) => h('option', { value: v, selected: v === sort }, t)));
  function go() {
    const q = new URLSearchParams({ month: monthSel.value, sort: sortSel.value });
    if (searchBox.value.trim()) q.set('search', searchBox.value.trim());
    location.hash = `#/team?${q}`;
  }

  const totals = rows.reduce((t, r) => ({ sales: t.sales + r.netSales, target: t.target + (r.target || 0) }), { sales: 0, target: 0 });
  setChildren(mount,
    h('section', { class: 'bfl-panel' },
      h('div', { class: 'bfl-panel-head' },
        h('div', null,
          h('h2', null, `Sales by representative — ${monthLabel(chosen)}${report.monthToDate ? ' (month to date)' : ''}`),
          h('p', null, 'Eligible sales are Odoo invoices less credit notes. Cancelled or rejected orders never count.')),
        h('div', { class: 'sm-filters' }, searchBox, monthSel, sortSel)),
      rows.length ? h('div', { class: 'bfl-table-wrap' }, h('table', { class: 'bfl-table' },
        h('thead', null, h('tr', null,
          ['Representative', 'Monthly target', 'Achieved', 'Remaining', 'Achieved %', 'Active customers', 'Collections', 'Visits', 'Progress']
            .map((t, i) => h('th', { class: i >= 1 && i <= 7 ? 'num' : null }, t)))),
        h('tbody', null, rows.map((r) => teamTargetRow({
          name: r.rep, target: r.target, sales: r.netSales,
          extraCells: [
            h('td', { class: 'num' }, String(r.active ?? 0)),
            h('td', { class: 'num' }, formatGhs(r.collections)),
            h('td', { class: 'num' }, String(r.visits ?? 0)),
          ],
        }))))) : h('div', { class: 'bfl-empty' },
        h('p', null, h('b', null, 'No representatives to show')),
        h('p', null, search ? 'No representative matches that search.' : 'There is no sales activity for this month yet.')),
      rows.length ? h('p', { class: 'bfl-panel-sub', style: { margin: '12px 0 0' } },
        `Team total: ${formatGhs(totals.sales)} achieved${totals.target ? ` of ${formatGhs(totals.target)} targeted` : ''} · ${rows.length} representative${rows.length === 1 ? '' : 's'}`) : null));
}

/* ------------------------------------------------------------------ sales targets */

export async function renderSalesTargets(view, route, { pageHead }) {
  const mount = h('div', null, targetSkeleton());
  view.innerHTML = pageHead('Sales Targets', 'The monthly targets the team is measured against');
  view.appendChild(mount);

  let data;
  try { data = await reportsFetch('/api/reports/targets'); } catch (e) {
    setChildren(mount, e.status === 401 ? staffSignInState() : errorPanel(e));
    return;
  }
  const measures = Object.entries(data.measures || {});
  const reps = data.reps || [];

  // the form (built once)
  const scope = h('select', { 'aria-label': 'Target for', onChange: syncForm },
    [h('option', { value: 'REP' }, 'A sales rep'), h('option', { value: 'COMPANY' }, 'The company')]);
  const rep = h('select', { 'aria-label': 'Which rep' }, reps.map((r) => h('option', { value: r }, r)));
  const measure = h('select', { 'aria-label': 'Measure' });
  const every = h('input', { type: 'checkbox', checked: true, onChange: syncForm });
  const month = h('input', { type: 'month', 'aria-label': 'Month' });
  const value = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', 'aria-label': 'Target value', placeholder: 'e.g. 10000' });
  const feedback = h('p', { class: 'bfl-panel-sub', role: 'status' });
  const saveBtn = h('button', { type: 'button', class: 'bfl-btn', onClick: save }, 'Save target');
  const listBody = h('tbody');

  function syncForm() {
    const isRep = scope.value === 'REP';
    rep.disabled = !isRep;
    const allowed = isRep ? measures.filter(([k]) => ['net_sales', 'collections', 'active_customers'].includes(k)) : measures;
    const keep = [...measure.options].map((o) => o.value);
    const wanted = allowed.map(([k]) => k);
    if (keep.join() !== wanted.join()) setChildren(measure, allowed.map(([k, label]) => h('option', { value: k }, label)));
    month.disabled = every.checked;
  }

  async function save() {
    feedback.textContent = '';
    const body = {
      scope: scope.value,
      scopeValue: scope.value === 'REP' ? rep.value : '',
      measure: measure.value,
      month: every.checked ? 'DEFAULT' : month.value,
      value: value.value === '' ? '' : Number(value.value),
    };
    if (scope.value === 'REP' && !rep.value) { feedback.textContent = 'Choose the rep first.'; return; }
    if (!every.checked && !month.value) { feedback.textContent = 'Choose a month, or tick "every month".'; return; }
    saveBtn.disabled = true;
    try {
      const r = await reportsFetch('/api/reports/targets', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      feedback.textContent = r.cleared ? 'Target cleared.' : `Target saved: ${formatGhsOrPlain(body.measure, r.value)}.`;
      value.value = '';
      await loadList();
    } catch (e) { feedback.textContent = e.message; } finally { saveBtn.disabled = false; }
  }

  const formatGhsOrPlain = (m, v) => (m === 'net_sales' || m === 'collections' || m === 'avg_order_value' ? formatGhs(v) : Number(v).toLocaleString());

  async function loadList() {
    const fresh = await reportsFetch('/api/reports/targets');
    const rows = fresh.targets || [];
    setChildren(listBody, rows.length ? rows.map((t) => h('tr', null,
      h('td', { class: 'primary-text' }, t.scope === 'COMPANY' ? 'The company' : t.scopeValue),
      h('td', null, (fresh.measures || {})[t.measure] || t.measure),
      h('td', null, t.month === 'DEFAULT' ? 'Every month' : monthLabel(t.month)),
      h('td', { class: 'num' }, formatGhsOrPlain(t.measure, t.value)),
      h('td', null, h('span', { class: 'bfl-badge neutral' }, t.setBy ? `by ${t.setBy}` : '—'))))
      : h('tr', null, h('td', { colspan: '5' }, h('div', { class: 'bfl-empty' },
        h('p', null, h('b', null, 'No targets yet')),
        h('p', null, 'Save one above. Without a target, reports compare with last year instead.')))));
  }

  syncForm();
  await loadList();
  setChildren(mount,
    h('section', { class: 'bfl-panel' },
      h('div', { class: 'bfl-panel-head' },
        h('div', null, h('h2', null, 'Set a target'),
          h('p', null, 'A month\'s own target wins over the "every month" one. Leave the value empty and save to clear a target.'))),
      h('div', { class: 'sm-filters', style: { flexWrap: 'wrap', gap: '10px' } },
        h('label', { class: 'bfl-field' }, h('span', null, 'For'), scope),
        h('label', { class: 'bfl-field' }, h('span', null, 'Rep'), rep),
        h('label', { class: 'bfl-field' }, h('span', null, 'Measure'), measure),
        h('label', { class: 'bfl-field' }, h('span', null, 'Month'), month),
        h('div', { class: 'bfl-field', style: { alignSelf: 'end' } }, h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center', minHeight: '38px' } }, every, ' Every month')),
        h('label', { class: 'bfl-field' }, h('span', null, 'Value'), value),
        h('div', { style: { alignSelf: 'end' } }, saveBtn)),
      feedback),
    h('section', { class: 'bfl-panel', style: { marginTop: '16px' } },
      h('div', { class: 'bfl-panel-head' }, h('div', null, h('h2', null, 'Current targets'), h('p', null, 'Everything the team is measured against.'))),
      h('div', { class: 'bfl-table-wrap' }, h('table', { class: 'bfl-table' },
        h('thead', null, h('tr', null, ['For', 'Measure', 'Month', 'Target', 'Set by'].map((t, i) => h('th', { class: i === 3 ? 'num' : null }, t)))),
        listBody))));
}

export { targetStatus, TARGET_STATUS_LABEL, TARGET_STATUS_TONE, esc };
