// Staff screen S03 — the Expiry list.
//
// SAMPLE DATA until the Odoo lot sync exists (the screen says so). Built once: the search box
// and every field in the table are created a single time and only the rows underneath change,
// so nothing someone is typing into is ever rebuilt.
import { api, toast } from './api.js';
import { h, setChildren } from './lib/dom.js';
import { debounce, createLatest } from './lib/util.js';

const BANDS = [
  ['EXPIRED', 'Expired', 'err'],
  ['CRITICAL', 'Critical', 'err'],
  ['WARNING', 'Warning', 'warn'],
  ['EARLY', 'Early warning', 'info'],
  ['OK', 'Fine', 'ok'],
  ['NO_DATE', 'No date', 'muted'],
];
const BAND = Object.fromEntries(BANDS.map(([code, label, tone]) => [code, { label, tone }]));

const ACTIONS = [
  ['', 'Choose…'],
  ['MOVE_TO_CLEARANCE', 'Move to clearance'],
  ['PUSH_THROUGH_REPS', 'Push through sales reps'],
  ['RETURN_TO_SUPPLIER', 'Return to supplier'],
  ['DONATE_OR_WRITE_OFF', 'Donate or write off'],
];
const STATUSES = [['OPEN', 'Open'], ['IN_PROGRESS', 'In progress'], ['DONE', 'Done']];

const money = (v) => (v === null || v === undefined ? null
  : `GHS ${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function select(options, value, props = {}) {
  return h('select', props, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
}

export async function renderExpiry(view) {
  // a link may open the list already filtered: #/expiry?band=EXPIRED, or several bands: ?band=CRITICAL,WARNING
  const bandParam = String(new URLSearchParams(location.hash.split('?')[1] || '').get('band') || '').toUpperCase()
    .split(',').filter((b) => BANDS.some(([code]) => code === b)).join(',');
  const state = { band: bandParam, category: '', location: '', status: '', q: '', within60d: false };
  const latest = createLatest();
  // only the Sales Manager (or the administrator) sets the discount customers are offered on a lot
  const me = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({}));
  const canDiscount = ['ADMIN', 'SALES_MANAGER'].includes(me.staff?.role);
  let data = null;
  const repNames = canDiscount
    ? await api.shelfReps().then((r) => (r.reps || []).map((x) => x.name).filter(Boolean)).catch(() => [])
    : [];
  // ---- the parts that are built once -------------------------------------------------
  const tiles = new Map();   // band code -> { button, count, value }
  const tileRow = h('div', { class: 'exp-tiles', role: 'group', 'aria-label': 'Filter by expiry band' });
  for (const [code, label] of BANDS.filter(([c]) => c !== 'NO_DATE')) {
    const count = h('span', { class: 'exp-tile-n' }, '–');
    const value = h('span', { class: 'exp-tile-v' }, '');
    const button = h('button', {
      type: 'button', class: `exp-tile ${BAND[code].tone}`, 'aria-pressed': 'false',
      onClick: () => setBand(state.band === code ? '' : code),
    }, count, h('span', { class: 'exp-tile-l' }, label), value);
    tiles.set(code, { button, count, value });
    tileRow.appendChild(button);
  }

  const summaryLine = h('p', { class: 'muted exp-summary', role: 'status' });
  const checkBox = h('details', { class: 'card exp-check' });
  const search = h('input', {
    type: 'search', placeholder: 'Search product, barcode, lot or shop…', 'aria-label': 'Search lots',
    onInput: debounce(() => { state.q = search.value.trim(); load(); }, 250),
  });
  const bandSel = select([['', 'All bands'], ...BANDS.map(([c, l]) => [c, l])], '', {
    'aria-label': 'Band', onChange: () => setBand(bandSel.value),
  });
  const categorySel = h('select', { 'aria-label': 'Category', onChange: () => { state.category = categorySel.value; load(); } });
  const locationSel = select([
    ['', 'All stock (Warehouse & Shop)'],
    ['WAREHOUSE', 'Warehouse stock only'],
    ['MAIN', 'Main warehouse'],
    ['CLEARANCE', 'Clearance warehouse'],
    ['SHOP', 'Customer shop stock'],
  ], '', {
    'aria-label': 'Stock location (Warehouse vs Shop)', onChange: () => { state.location = locationSel.value; load(); },
  });
  const twoMonthBtn = h('button', {
    type: 'button',
    class: 'secondary',
    'aria-pressed': 'false',
    onClick: () => {
      state.within60d = !state.within60d;
      twoMonthBtn.setAttribute('aria-pressed', String(state.within60d));
      twoMonthBtn.className = state.within60d ? 'primary' : 'secondary';
      if ( data ) paint();
    },
  }, '1–2 Months Left (≤ 60d)');
  const statusSel = select([['', 'Any status'], ...STATUSES], '', {
    'aria-label': 'Status', onChange: () => { state.status = statusSel.value; load(); },
  });
  // Customers' minimum shelf life (W3). The search box is built once; only the list under it changes.
  const minSearch = h('input', {
    type: 'search', placeholder: 'Find a customer by name…', 'aria-label': 'Find a customer',
    onInput: debounce(() => loadMinCustomers(), 250),
  });
  const minList = h('div', { class: 'exp-min-list' });
  const minLatest = createLatest();
  const minBox = h('details', { class: 'card exp-minlife', onToggle: () => { if (minBox.open && !minList.children.length) loadMinCustomers(); } },
    h('summary', null, "Customers' minimum shelf life"),
    h('p', { class: 'muted' },
      'A customer with a minimum is warned before an order that would be filled with shorter-dated stock, and must accept it. ',
      'In the live system this is a field on the customer in Odoo; here you set it by hand. Empty search shows customers who already have one.'),
    minSearch, minList);
  const csvBtn = h('button', { type: 'button', class: 'secondary', onClick: downloadCsv }, 'Download CSV');
  const count = h('span', { class: 'muted', role: 'status' });
  const tbody = h('tbody');
  const emptyNote = h('p', { class: 'muted hidden' }, 'No lots match these filters.');

  setChildren(view,
    h('h1', null, 'Expiry list'),
    h('div', { class: 'notice exp-banner' },
      h('b', null, 'Warehouse & Customer Shop Expiry Management. '),
      'Distinguishes internal warehouse stock (Main / Clearance) from stock supplied to customer shops, highlights lots within 1–2 months (≤ 60 days) of expiry, and applies live customer catalogue discounts.'),
    tileRow,
    summaryLine,
    checkBox,
    minBox,
    h('div', { class: 'card' },
      h('div', { class: 'controls exp-controls' }, search, locationSel, twoMonthBtn, bandSel, categorySel, statusSel, csvBtn),
      h('div', { class: 'exp-count' }, count),
      h('div', { class: 'exp-wrap' },
        h('table', { class: 'exp-table' },
          h('thead', null, h('tr', null, [
            'Product', 'Lot', 'Expires', 'Days left', 'Band', 'Cartons', 'Location', 'Value at risk', 'Action', 'Assigned sales rep', 'Decide by', 'Status', 'Customer discount',
          ].map((t, i) => h('th', { class: i === 3 || i === 5 || i === 7 ? 'num' : null }, t)))),
          tbody),
        emptyNote)),
    h('p', { class: 'muted exp-foot' },
      'Value at risk is cartons × selling price, shown to staff only. The move, return or write-off itself is done in Odoo by the warehouse; this list records the decision. ',
      'A customer discount puts the lot in the "Discounted — near expiry" section of the customers\' catalogue (signed-in customers only) and on their quotation; only the Sales Manager sets it.'));

  // ---- behaviour -----------------------------------------------------------------------
  function minRow(c) {
    const input = h('input', { type: 'number', min: '1', max: '730', step: '1', inputmode: 'numeric', 'aria-label': `Minimum days for ${c.name}`, value: c.minShelfLifeDays ?? '', placeholder: 'none' });
    const state = h('span', { class: 'muted', role: 'status' });
    const save = async (days) => {
      try {
        const r = await api.setMinShelfLife(c.id, days);
        input.value = r.minShelfLifeDays ?? '';
        state.textContent = r.minShelfLifeDays ? 'Saved' : 'Cleared';
      } catch (e) { toast(e.message, 'err'); }
    };
    return h('div', { class: 'exp-min-row' },
      h('div', { class: 'exp-min-name' }, h('b', null, c.name), c.odooRef ? h('span', { class: 'muted' }, ` ${c.odooRef}`) : null),
      h('label', { class: 'exp-min-field' }, input, ' days'),
      h('button', { type: 'button', onClick: () => save(input.value.trim() === '' ? null : input.value.trim()) }, 'Save'),
      h('button', { type: 'button', class: 'secondary', onClick: () => save(null) }, 'Clear'),
      state);
  }

  async function loadMinCustomers() {
    const mine = minLatest.next();
    let r;
    try { r = await api.shelfLifeCustomers(minSearch.value.trim()); } catch (e) { toast(e.message, 'err'); return; }
    if (!minLatest.is(mine)) return;
    setChildren(minList, r.customers.length ? r.customers.map(minRow) : [h('p', { class: 'muted' }, minSearch.value.trim() ? 'No customer matches.' : 'No customer has a minimum yet. Search for one above.')]);
  }

  function setBand(code) {
    state.band = code;
    bandSel.value = code;
    load();
  }

  function query() {
    return Object.fromEntries(Object.entries(state).filter(([k, v]) => k !== 'within60d' && v !== ''));
  }

  async function load() {
    const mine = latest.next();
    let next;
    try { next = await api.expiry(query()); } catch (e) { toast(e.message, 'err'); return; }
    if (!latest.is(mine)) return;
    data = next;
    paint();
  }

  /** Refresh only the numbers (after a save), leaving the rows and their fields untouched. */
  async function refreshNumbers() {
    try { data = { ...data, summary: (await api.expiry(query())).summary }; paintSummary(); } catch { /* the save already succeeded */ }
  }

  function paint() {
    paintSummary();
    paintOptions();
    paintCheck();
    const visibleRows = state.within60d
      ? data.rows.filter((r) => r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 60)
      : data.rows;
    setChildren(tbody, visibleRows.map(rowEl));
    emptyNote.classList.toggle('hidden', visibleRows.length > 0);
    count.textContent = visibleRows.length === data.summary.lots
      ? `${plural(visibleRows.length, 'lot')}`
      : `${visibleRows.length} of ${plural(data.summary.lots, 'lot')}`;
    for (const [code, t] of tiles) t.button.setAttribute('aria-pressed', String(state.band.split(',').includes(code)));
    if (bandSel.value !== state.band) bandSel.value = BANDS.some(([c]) => c === state.band) ? state.band : '';
  }

  function paintSummary() {
    const s = data.summary;
    for (const [code, t] of tiles) {
      t.count.textContent = s.counts[code].toLocaleString();
      const v = s.value.byBand[code];
      t.value.textContent = v === undefined ? '' : (money(v) || '');
    }
    const parts = [];
    if (s.needsAction) parts.push(`${plural(s.needsAction, 'lot')} still need a decision`);
    if (s.overdue) parts.push(`${s.overdue} overdue`);
    parts.push(`value at risk ${money(s.value.total)}`);
    if (s.value.unpriced) parts.push(`${plural(s.value.unpriced, 'lot')} without a price`);
    summaryLine.textContent = parts.join(' · ');
  }

  function paintOptions() {
    fill(categorySel, [['', 'All categories'], ...data.options.categories.map((c) => [c, c])], state.category);
  }

  function paintCheck() {
    const items = data.checkEntries;
    checkBox.classList.toggle('hidden', items.length === 0);
    setChildren(checkBox,
      h('summary', null, h('b', null, 'Check these entries'), ` (${items.length}) — expiry dates that look like typing mistakes`),
      h('ul', { class: 'exp-check-list' }, items.map((e) => h('li', null,
        h('b', null, e.productName), e.barcode ? ` · Barcode ${e.barcode}` : '', ` · lot ${e.lotName} · expires ${e.expiryDate} · received ${e.receivedDate}`,
        h('div', { class: 'muted' }, e.issues.map((i) => i.text).join('; '))))));
  }

  function rowEl(r) {
    const tone = BAND[r.band];
    const label = `${r.productName}, lot ${r.lotName}`;
    const overdue = h('span', { class: 'pill err hidden' }, 'Overdue');
    const flag = () => overdue.classList.toggle('hidden', !r.overdue);
    flag();

    const save = async (field, value, control) => {
      control.disabled = true;
      try {
        const { row } = await api.saveExpiryDecision(r.key, { [field]: value });
        Object.assign(r, row);
        flag();
        tr.classList.toggle('needs-action', r.needsAction);
        toast('Saved', 'ok');
        refreshNumbers();
      } catch (e) {
        toast(e.message, 'err');
        control.value = r[field] || '';   // put the field back as it was
      } finally { control.disabled = false; }
    };

    const actionSel = select(ACTIONS, r.action || '', { 'aria-label': `Action for ${label}`, onChange: (e) => save('action', e.target.value, e.target) });
    // Assign the lot to one named sales rep, saved through the existing decision save (the `owner` field holds the rep's name).
    const repSel = h('select', { 'aria-label': `Sales rep for ${label}` },
      h('option', { value: '' }, 'Choose a sales rep…'),
      repNames.map((n) => h('option', { value: n, selected: n === r.owner }, n)));
    if (r.owner && !repNames.includes(r.owner)) repSel.appendChild(h('option', { value: r.owner, selected: true }, r.owner));
    const repNow = h('div', { class: 'muted' });
    const paintRep = () => { repNow.textContent = r.owner ? `Assigned to ${r.owner}` : 'Not assigned'; repSel.value = r.owner || ''; };
    const assignBtn = h('button', { type: 'button', class: 'secondary', onClick: async (e) => {
      if (!repSel.value) { toast('Choose a sales rep first.', 'err'); return; }
      await save('owner', repSel.value, e.currentTarget); paintRep();
    } }, 'Assign');
    paintRep();
    const repCell = !canDiscount ? h('span', { class: r.owner ? '' : 'muted' }, r.owner || 'Not assigned')
      : h('div', { class: 'exp-rep-assign' }, repSel, assignBtn, repNow);
    const dateIn = h('input', {
      type: 'date', value: r.decideBy || '', 'aria-label': `Decide by, ${label}`,
      onChange: (e) => save('decideBy', e.target.value, e.target),
    });
    const statusSelect = select(STATUSES, r.status, { 'aria-label': `Status of ${label}`, onChange: (e) => save('status', e.target.value, e.target) });

    // the discount customers are offered on this lot
    const discIn = h('input', {
      type: 'number', min: '1', max: '90', step: '1', inputmode: 'decimal', placeholder: '%', value: r.discountPct ?? '',
      'aria-label': `Customer discount percent for ${label}`, class: 'exp-disc-in',
      onKeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); saveDisc(discIn.value.trim() === '' ? null : discIn.value.trim(), setBtn); } },
    });
    const discNote = h('div', { class: 'muted exp-disc-note' });
    const paintDisc = () => {
      discIn.value = r.discountPct ?? '';
      removeBtn.classList.toggle('hidden', r.discountPct === null || r.discountPct === undefined);
      discNote.textContent = r.discountPct && !r.inCatalogue ? 'This product is not in the customer catalogue, so customers cannot see this offer.' : (r.discountPct ? 'On offer to customers' : '');
    };
    const notifyDiscountChanged = () => {
      try { localStorage.setItem('bfl.discounts.updated', String(Date.now())); } catch {}
      try { const bc = new BroadcastChannel('bfl_discounts'); bc.postMessage({ type: 'discount_updated', at: Date.now() }); bc.close(); } catch {}
    };
    const saveDisc = async (pct, control) => {
      control.disabled = true;
      try {
        const { row } = await api.setExpiryDiscount(r.key, pct);
        Object.assign(r, row);
        paintDisc();
        notifyDiscountChanged();
        toast(pct === null ? 'Discount removed' : 'Discount saved — now live on the customer catalogue', 'ok');
      } catch (e) { toast(e.message, 'err'); paintDisc(); } finally { control.disabled = false; }
    };
    const setBtn = h('button', { type: 'button', class: 'secondary', onClick: (e) => saveDisc(discIn.value.trim() === '' ? null : discIn.value.trim(), e.currentTarget) }, 'Set');
    const removeBtn = h('button', { type: 'button', class: 'ghost hidden', onClick: (e) => saveDisc(null, e.currentTarget) }, 'Remove');
    paintDisc();
    const discCell = !r.actionable ? h('span', { class: 'muted' }, '—')
      : canDiscount ? h('div', { class: 'exp-disc' }, discIn, ' %', setBtn, removeBtn, discNote)
        : (r.discountPct ? h('span', { class: 'pill info' }, `${r.discountPct}% off`) : h('span', { class: 'muted' }, 'none'));

    const isWithin60 = r.daysLeft !== null && r.daysLeft >= 0 && r.daysLeft <= 60;
    const windowBadge = isWithin60
      ? h('div', null, h('span', { class: `pill ${r.daysLeft <= 30 ? 'err' : 'warn'}` }, r.daysLeft <= 30 ? '≤ 1 mo left' : '1–2 mo left'))
      : null;
    const locCell = r.location === 'SHOP'
      ? h('div', null, h('span', { class: 'pill warn' }, 'Shop stock'), r.shopName ? h('div', { class: 'muted' }, r.shopName) : null)
      : r.location === 'CLEARANCE'
        ? h('div', null, h('span', { class: 'pill info' }, 'Clearance'), h('div', { class: 'muted' }, 'Warehouse'))
        : h('div', null, h('span', { class: 'pill ok' }, 'Main'), h('div', { class: 'muted' }, 'Warehouse'));

    const tr = h('tr', { class: `${r.band === 'EXPIRED' ? 'row-expired' : ''}${r.needsAction ? ' needs-action' : ''}` },
      h('td', null, h('b', null, r.productName), h('div', { class: 'muted' }, r.barcode)),
      h('td', null, r.lotName),
      h('td', null, r.expiryDate || '—'),
      h('td', { class: `num${r.daysLeft !== null && r.daysLeft < 0 ? ' days-neg' : ''}` },
        r.daysLeft === null ? '—' : r.daysLeft.toLocaleString(),
        windowBadge),
      h('td', null, h('span', { class: `pill ${tone.tone}` }, tone.label)),
      h('td', { class: 'num' }, r.cartons.toLocaleString()),
      h('td', null, locCell),
      h('td', { class: 'num' }, money(r.valueAtRisk) || h('span', { class: 'muted' }, 'no price')),
      h('td', null, r.actionable ? actionSel : h('span', { class: 'muted' }, '—')),
      h('td', null, r.actionable ? repCell : h('span', { class: 'muted' }, '—')),
      h('td', null, r.actionable ? [dateIn, overdue] : h('span', { class: 'muted' }, '—')),
      h('td', null, r.actionable ? statusSelect : h('span', { class: 'muted' }, '—')),
      h('td', null, discCell));
    return tr;
  }

  async function downloadCsv() {
    csvBtn.disabled = true;
    try {
      const q = new URLSearchParams(query()).toString();
      const blob = await api.expiryCsv(q);
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: `expiry-list-${data?.asOf || 'today'}.csv` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast(e.message, 'err'); } finally { csvBtn.disabled = false; }
  }

  function fill(sel, options, value) {
    setChildren(sel, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
    sel.value = options.some(([v]) => v === value) ? value : '';
  }

  await load();
}
