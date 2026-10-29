// Staff screen S06 — Monthly reports.
//
// The CEO summary (twelve measures), the Sales Manager report and the Warehouse report, for any month
// (the month in progress is month-to-date). Every section can be downloaded as CSV, and a report can be
// printed or saved as PDF from the browser. The report owner writes three lines before it goes out; the
// Sales Manager sets monthly targets. Company-wide reports are for managers only; no report holds a cost
// figure, a phone number or an address.
//
// Built once: the notes and target fields are created a single time and only their values and the report
// body around them change, so nothing being typed is rebuilt.
import { api, toast } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';

const MARK_TEXT = { green: 'On track', amber: 'Close', red: 'Behind' };
const num = (n, d = 0) => Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

/** Format one value by its type; null is a dash, never a zero. */
export function fmt(value, type) {
  if (value === null || value === undefined || value === '') return '—';
  switch (type) {
    case 'ghs': return `GHS ${num(value, 2)}`;
    case 'int': return num(value);
    case 'pct': return `${num(value, 1)}%`;
    case 'days': return `${num(value, 1)} days`;
    case 'date': return new Date(`${String(value).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    default: return String(value);
  }
}
const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export async function renderReports(view) {
  const start = await api.reportsStart();
  if (!start.reports.length) { setChildren(view, h('h1', null, 'Monthly reports'), h('p', { class: 'muted' }, 'Your role has no monthly report.')); return; }
  const state = { report: start.reports[0].key, month: start.months[1] || start.current };
  let data = null;

  // ---- controls (built once) ---------------------------------------------------------------------
  const tabs = h('div', { class: 'rep-tabs', role: 'tablist' });
  const monthSel = h('select', { 'aria-label': 'Month', onChange: () => { state.month = monthSel.value; load(); } },
    start.months.map((m) => h('option', { value: m, selected: m === state.month }, monthName(m) + (m === start.current ? ' (so far)' : ''))));
  const printBtn = h('button', { type: 'button', class: 'secondary', onClick: () => window.print() }, 'Print or save as PDF');
  const banner = h('div', { class: 'notice' });
  const body = h('div', { class: 'rpt-body' });

  // notes: three lines, written by the report owner
  const what = h('textarea', { rows: '2', maxlength: '500', 'aria-label': 'What happened' });
  const why = h('textarea', { rows: '2', maxlength: '500', 'aria-label': 'Why' });
  const action = h('textarea', { rows: '2', maxlength: '500', 'aria-label': 'What we will do' });
  const saveNotes = h('button', { type: 'button', onClick: saveNotesNow }, 'Save the three lines');
  const notesInfo = h('span', { class: 'muted' });
  const notesCard = h('div', { class: 'card rpt-notes' },
    h('h2', null, 'Three lines of explanation'),
    h('p', { class: 'muted' }, 'Written by the report owner before the report is sent: what happened, why, and what we will do.'),
    h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'What happened'), what),
    h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'Why'), why),
    h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'What we will do'), action),
    h('div', { class: 'controls' }, saveNotes, notesInfo));
  const notesPrint = h('div', { class: 'card rpt-notes-print hidden' });

  // targets (managers)
  const tScope = h('select', { 'aria-label': 'Target for', onChange: syncTarget }, [['COMPANY', 'The company'], ['REP', 'A sales rep']].map(([v, t]) => h('option', { value: v }, t)));
  const tRep = h('select', { 'aria-label': 'Which rep' });
  const tMeasure = h('select', { 'aria-label': 'Measure' });
  const tMonth = h('input', { type: 'month', 'aria-label': 'Month' });
  const tEvery = h('label', { class: 'rpt-check' }, h('input', { type: 'checkbox', id: 'tEvery', checked: true, onChange: syncTarget }), ' Every month');
  const tValue = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', 'aria-label': 'Target value', placeholder: 'Target' });
  const tList = h('tbody');
  const targetsCard = h('details', { class: 'card rpt-targets hidden' },
    h('summary', null, 'Monthly targets'),
    h('p', { class: 'muted' }, 'Entered by the Sales Manager. Without a target, "vs target" is left blank and the mark compares with last year. A month\'s own target wins over the one for every month. Leave the value empty and save to clear one.'),
    h('div', { class: 'team-grid' },
      h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'For'), tScope), h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'Rep'), tRep),
      h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'Measure'), tMeasure), h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'Month'), tEvery, tMonth),
      h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'Value'), tValue)),
    h('div', { class: 'controls' }, h('button', { type: 'button', onClick: saveTarget }, 'Save target')),
    h('div', { class: 'exp-wrap' }, h('table', null, h('thead', null, h('tr', null, ['For', 'Measure', 'Month', 'Target'].map((t) => h('th', null, t)))), tList)));

  setChildren(view,
    h('h1', null, 'Monthly reports'),
    h('div', { class: 'controls no-print' }, tabs, monthSel, printBtn),
    banner, body,
    h('div', { class: 'no-print' }, notesCard, targetsCard),
    notesPrint);

  function paintTabs() {
    setChildren(tabs, start.reports.map((r) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(r.key === state.report), class: `rep-tab${r.key === state.report ? ' on' : ''}`,
      onClick: () => { state.report = r.key; paintTabs(); load(); },
    }, r.title)));
  }

  // ---- loading ----------------------------------------------------------------------------------
  async function load() {
    setChildren(body, h('div', { class: 'card' }, h('div', { class: 'sk-lines', role: 'status', 'aria-label': 'Loading' }, h('i'), h('i'), h('i'))));
    try { data = await api.report(state.report, state.month); } catch (e) { setChildren(body, h('div', { class: 'card errbox' }, e.message)); return; }
    paint();
  }

  function csvLink(id) {
    return h('a', { class: 'btn-link no-print', href: `/api/reports/csv?report=${state.report}&month=${state.month}&section=${id}`, download: '' }, 'Download CSV');
  }

  function measuresTable() {
    return h('div', { class: 'card' },
      h('div', { class: 'rpt-head' }, h('h2', null, 'Twelve measures'), csvLink('measures')),
      h('div', { class: 'exp-wrap' }, h('table', { class: 'rpt-table' },
        h('thead', null, h('tr', null, ['Measure', 'This month', 'Last month', 'Same month last year', 'Target', ''].map((t, i) => h('th', { class: i > 0 && i < 5 ? 'num' : null }, t)))),
        h('tbody', null, data.measures.map((m) => h('tr', null,
          h('td', null, h('b', null, m.name), h('div', { class: 'muted rpt-hint' }, m.hint), m.extra && m.thisMonth !== null ? h('div', { class: 'rpt-extra' }, m.extra) : null, m.unavailable ? h('div', { class: 'muted rpt-hint' }, m.unavailable) : null),
          h('td', { class: 'num' }, h('b', null, fmt(m.thisMonth, m.unit))), h('td', { class: 'num' }, fmt(m.lastMonth, m.unit)), h('td', { class: 'num' }, fmt(m.lastYear, m.unit)),
          h('td', { class: 'num' }, m.target === null ? '—' : fmt(m.target, m.key === 'net_sales_vs_target' ? 'pct' : m.unit)),
          h('td', null, m.mark ? h('span', { class: `rpt-mark ${m.mark}`, title: `${MARK_TEXT[m.mark]} against ${m.against}` }, MARK_TEXT[m.mark]) : null)))))));
  }

  function sectionCard(sec) {
    return h('div', { class: 'card rpt-section' },
      h('div', { class: 'rpt-head' }, h('h2', null, sec.title), csvLink(sec.id)),
      sec.intro ? h('p', { class: 'muted' }, sec.intro) : null,
      sec.rows.length
        ? h('div', { class: 'exp-wrap' }, h('table', { class: 'rpt-table' },
          h('thead', null, h('tr', null, sec.columns.map((c) => h('th', { class: c.type !== 'text' && c.type !== 'date' ? 'num' : null }, c.label)))),
          h('tbody', null, sec.rows.slice(0, 200).map((row) => h('tr', null, sec.columns.map((c) => h('td', { class: c.type !== 'text' && c.type !== 'date' ? 'num' : null }, fmt(row[c.key], c.type))))))))
        : h('p', { class: 'muted' }, 'Nothing to show for this month.'),
      sec.rows.length > 200 ? h('p', { class: 'muted' }, `Showing the first 200 of ${sec.rows.length} rows. The CSV has them all.`) : null,
      h('p', { class: 'muted rpt-foot' }, h('b', null, 'Source: '), sec.source, sec.action ? h('span', null, ' · ', h('b', null, 'Drives: '), sec.action) : null));
  }

  function paint() {
    const r = data;
    banner.className = 'notice';
    setChildren(banner,
      h('b', null, `${r.title} — ${monthName(r.month)}${r.monthToDate ? ' (month to date, as of ' + fmt(r.asOf, 'date') + ')' : ''}. `),
      r.purpose, ` For: ${r.recipients}. `,
      r.monthToDate ? 'Marks (on track / close / behind) appear once the month is complete.' : '');
    setChildren(body, r.measures ? measuresTable() : null, r.sections.map(sectionCard));

    // the three lines
    const owner = start.reports.find((x) => x.key === state.report);
    if (document.activeElement !== what && document.activeElement !== why && document.activeElement !== action) {
      what.value = r.notes.what || ''; why.value = r.notes.why || ''; action.value = r.notes.action || '';
    }
    toggleHidden(notesCard, !owner.canWriteNotes);
    notesInfo.textContent = r.notes.writtenBy ? `Last saved by ${r.notes.writtenBy} on ${new Date(r.notes.writtenAt).toLocaleString()}` : 'Not written yet.';
    // on paper the three lines sit with the report
    const lines = [['What happened', r.notes.what], ['Why', r.notes.why], ['What we will do', r.notes.action]].filter(([, t]) => t);
    setChildren(notesPrint, h('h2', null, 'Three lines of explanation'), lines.map(([k, t]) => h('p', null, h('b', null, `${k}: `), t)));
    toggleHidden(notesPrint, lines.length === 0);
  }

  async function saveNotesNow() {
    saveNotes.disabled = true;
    try {
      data.notes = await api.saveReportNotes({ report: state.report, month: state.month, what: what.value, why: why.value, action: action.value });
      notesInfo.textContent = 'Saved.';
      paint();
    } catch (e) { toast(e.message, 'err'); } finally { saveNotes.disabled = false; }
  }

  // ---- targets ----------------------------------------------------------------------------------
  let targetInfo = null;
  function syncTarget() {
    toggleHidden(tRep.parentElement, tScope.value !== 'REP');
    tMonth.hidden = tEvery.querySelector('input').checked;
    if (targetInfo) {
      const repOk = ['net_sales', 'collections', 'active_customers'];
      setChildren(tMeasure, Object.entries(targetInfo.measures).filter(([k]) => tScope.value === 'COMPANY' || repOk.includes(k)).map(([k, t]) => h('option', { value: k }, t)));
    }
  }
  async function loadTargets() {
    if (!start.canSetTargets) return;
    targetInfo = await api.reportTargets();
    setChildren(tRep, targetInfo.reps.map((r) => h('option', { value: r }, r)));
    syncTarget();
    paintTargets();
    toggleHidden(targetsCard, false);
  }
  function paintTargets() {
    setChildren(tList, targetInfo.targets.map((t) => h('tr', null, h('td', null, t.scope === 'COMPANY' ? 'Company' : t.scopeValue), h('td', null, targetInfo.measures[t.measure] || t.measure),
      h('td', null, t.month === 'DEFAULT' ? 'Every month' : monthName(t.month)), h('td', { class: 'num' }, num(t.value, 2)))));
  }
  async function saveTarget() {
    try {
      await api.setReportTarget({
        scope: tScope.value, scopeValue: tScope.value === 'REP' ? tRep.value : '', measure: tMeasure.value,
        month: tEvery.querySelector('input').checked ? 'DEFAULT' : tMonth.value, value: tValue.value.trim(),
      });
      toast('Target saved.', 'ok');
      tValue.value = '';
      await loadTargets();
      load();
    } catch (e) { toast(e.message, 'err'); }
  }

  paintTabs();
  await load();
  loadTargets().catch(() => {});
}
