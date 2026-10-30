// Sales rep phone app (/rep), after the "My visits" / "Visit form" mockup (Oct 2026).
// Screen 1 lists shops with expiring lots, nearest expiry first. Screen 2 is the shelf check.
// The mockup's discount proposal is left out: Phase 1 forbids discounts and prices.
import { h, setChildren, svg } from './lib/dom.js';

const app = document.getElementById('app');
const ICON = {
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  shop: 'M3 9l1.5-5h15L21 9M3 9v11h18V9M3 9c0 2 3 2 3 0s3-2 3 0 3 2 3 0 3-2 3 0 3 2 3 0M9 20v-6h6v6',
  alert: 'M12 3 2 21h20L12 3zM12 10v5M12 18v.5',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
  box: 'M12 3 4 7v10l8 4 8-4V7l-8-4zM4 7l8 4 8-4M12 11v10',
  back: 'M19 12H5M11 6l-6 6 6 6',
  camera: 'M4 8h3l2-3h6l2 3h3v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
  save: 'M5 3h12l4 4v14H3V3zM7 3v6h8V3M7 21v-7h10v7',
  chevron: 'M9 6l6 6-6 6',
};
const icon = (key) => svg(`<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="${ICON[key]}"/></svg>`);
const logo = () => svg(`<svg viewBox="0 0 48 48" aria-hidden="true"><path d="m24 3 19 10.5v21L24 45 5 34.5v-21L24 3Z" fill="#fff"/><path d="m5.5 13.5 18.5 10 18.5-10M24 24v20.5M15 8l19 11M33 8 14 19" fill="none" stroke="#0b2a52" stroke-width="2.6" stroke-linejoin="round"/></svg>`);

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) { location.href = '/rep/login'; throw new Error('Signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Something went wrong. Try again.');
  return body;
}

const tone = (days) => (days <= 7 ? 'red' : days <= 14 ? 'amber' : 'green');
const expiryText = (days) => (days < 0 ? `Expired ${-days} day${days === -1 ? '' : 's'} ago` : days === 0 ? 'Expires today' : `Expires in ${days} day${days === 1 ? '' : 's'}`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function toast(text) {
  const el = h('div', { class: 'rp-toast', role: 'status' }, text);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

let repName = '';
let repRoleLabel = 'Sales Representative';
let repMonthData = null;
const formatGhs = (n) => `GH₵ ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function signOut() {
  await fetch('/api/rep/logout', { method: 'POST' }).catch(() => {});
  location.href = '/rep/login';
}

/* ---------- Screen 1: My visits ---------- */
async function renderHome() {
  const list = h('div', { class: 'rp-shop-grid' });
  const tiles = h('div', { class: 'rp-tiles' });
  let timer;
  const search = h('input', {
    type: 'search', placeholder: 'Find a customer by name or ID', 'aria-label': 'Find a customer', autocomplete: 'off',
    onInput: () => { clearTimeout(timer); timer = setTimeout(load, 250); },
  });

  const m = repMonthData;
  const targetCard = m ? h('div', {
    class: 'rp-card',
    style: { marginBottom: '12px', padding: '14px', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '12px' },
  },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } },
      h('b', { style: { fontSize: '15px', color: '#0f172a' } }, `Monthly Sales Target (${m.month})`),
      h('span', { class: `pill ${m.remainingTarget === 0 ? 'green' : 'amber'}` }, m.target ? `${m.vsTarget ?? 0}% achieved` : 'Target')),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '13px' } },
      h('div', null, h('div', { style: { color: '#64748b', fontSize: '11px' } }, 'Target'), h('b', null, m.target !== null ? formatGhs(m.target) : 'Not set')),
      h('div', null, h('div', { style: { color: '#64748b', fontSize: '11px' } }, 'Sales Achieved'), h('b', { style: { color: '#15803d' } }, formatGhs(m.netSales))),
      h('div', null, h('div', { style: { color: '#64748b', fontSize: '11px' } }, 'Remaining Balance'), h('b', { style: { color: '#b45309' } }, m.remainingTarget !== null ? formatGhs(m.remainingTarget) : '—')))) : null;

  setChildren(app,
    h('header', { class: 'rp-head' },
      h('div', { class: 'row' },
        h('div', { class: 'rp-brand' }, logo(), h('div', null, h('b', null, 'Box for Less'), h('small', null, 'Bigger boxes. Better value.'))),
        h('button', { class: 'rp-icon-btn', type: 'button', 'aria-label': 'Sign out', title: 'Sign out', onClick: signOut }, icon('user'))),
      h('h1', null, 'My visits'),
      h('p', null, `${repName} · ${repRoleLabel}`)),
    h('div', { class: 'rp-body' },
      targetCard,
      h('label', { class: 'rp-search' }, icon('search'), search),
      tiles,
      h('h2', { class: 'rp-h' }, 'Shops ', h('small', null, '(sorted by nearest expiry)')),
      list));

  async function load() {
    try {
      const d = await api(`/api/rep/shops?q=${encodeURIComponent(search.value.trim())}`);
      setChildren(tiles,
        tile('shop', d.summary.shopsToVisit, 'shops to visit'),
        tile('alert', d.summary.overdue, 'overdue', 'red'),
        tile('clock', d.summary.lotsExpiring, 'lots expiring'));
      setChildren(list, d.shops.length ? d.shops.map(shopCard)
        : h('p', { class: 'rp-empty' }, search.value.trim() ? 'No shop matches that search.' : 'No shops have lots expiring soon.'));
    } catch (e) { setChildren(list, h('p', { class: 'rp-err' }, e.message)); }
  }
  load();
}

const tile = (key, value, label, cls = '') => h('div', { class: `rp-tile ${cls}` }, icon(key), h('b', null, String(value)), label);

function shopCard(s) {
  const t = tone(s.nearestDays);
  return h('article', { class: `rp-card${s.overdue ? ' overdue' : ''}` },
    h('div', { class: 'rp-shop' },
      h('div', null,
        h('h3', null, s.name),
        s.area ? h('div', { class: 'meta' }, s.area) : null,
        h('div', { class: 'rp-pills' },
          h('span', { class: 'pill' }, `ID ${s.ref}`),
          h('span', { class: `pill ${s.overdue ? 'red' : t}` }, s.overdue ? 'Visit overdue' : expiryText(s.nearestDays))),
        h('div', { class: 'meta' }, `${plural(s.lots, 'lot')} expiring`)),
      h('a', { class: 'rp-btn', href: `#/shop/${s.id}` }, 'Start visit', icon('chevron'))));
}

/* ---------- Screen 2: Visit form ---------- */
const MAX_PHOTO_EDGE = 1600;
function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('That photo could not be read.'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That photo could not be read.')); };
    img.src = url;
  });
}

async function renderVisit(shopId) {
  setChildren(app, h('p', { class: 'rp-empty' }, 'Loading…'));
  let data;
  try { data = await api(`/api/rep/shops/${shopId}/lots`); } catch (e) {
    setChildren(app, h('div', { class: 'rp-body' }, h('p', { class: 'rp-err' }, e.message), h('a', { class: 'rp-btn', href: '#/' }, 'Back')));
    return;
  }

  const state = new Map(); // lotId -> { shelf, outcome, returnReason, returnNote, photo }
  for (const lot of data.lots) state.set(lot.id, { shelf: lot.shelfCtn, outcome: 'OK', returnReason: '', returnNote: '', photo: null });

  const errBox = h('div');
  const contact = h('input', { class: 'rp-input', type: 'text', id: 'contact', autocomplete: 'off', placeholder: 'Who did you speak to?' });
  const agree = h('input', { type: 'checkbox', id: 'agree' });
  const recorded = h('div', { class: 'rp-count' });
  const saveBtn = h('button', { class: 'rp-btn wide', type: 'button' }, icon('save'), 'Save visit');
  const refreshCount = () => { recorded.textContent = `${plural([...state.values()].filter((s) => s.outcome !== 'NOT_CHECKED').length, 'lot')} recorded`; };

  const cards = data.lots.map((lot) => lotCard(lot, state.get(lot.id), refreshCount));
  refreshCount();

  saveBtn.addEventListener('click', async () => {
    setChildren(errBox);
    if (!contact.value.trim()) {
      setChildren(errBox, h('p', { class: 'rp-err' }, 'Enter the customer contact name.'));
      contact.focus();
      return;
    }
    const form = new FormData();
    form.append('visit', JSON.stringify({
      customerId: data.shop.id,
      contactName: contact.value.trim(),
      noReturnAgreed: agree.checked,
      lines: data.lots.map((l) => {
        const s = state.get(l.id);
        const line = { lotId: l.id, shelfCtn: s.shelf, outcome: s.outcome };
        if (s.outcome === 'RETURN') {
          line.returnReason = s.returnReason;
          line.returnNote = s.returnNote;
        }
        return line;
      }),
    }));
    for (const lot of data.lots) {
      const photo = state.get(lot.id).photo;
      if (photo) form.append(`photo_${lot.id}`, photo.blob, `lot-${lot.id}.jpg`);
    }
    saveBtn.disabled = true;
    try {
      await api('/api/rep/visits', { method: 'POST', body: form });
      toast(`Visit saved - ${data.shop.name}`);
      location.hash = '#/';
    } catch (e) {
      setChildren(errBox, h('p', { class: 'rp-err' }, e.message));
      saveBtn.disabled = false;
    }
  });

  setChildren(app,
    h('header', { class: 'rp-head small' },
      h('div', { class: 'row' },
        h('a', { class: 'rp-back', href: '#/', 'aria-label': 'Back to my visits' }, icon('back')),
        h('div', null, h('h1', null, data.shop.name), h('p', null, `ID ${data.shop.ref}${data.shop.area ? ` · ${data.shop.area}` : ''}`)))),
    h('div', { class: 'rp-body rp-form' },
      h('h2', { class: 'rp-h' }, 'Open alerts ', h('small', null, `(${plural(data.lots.length, 'lot')})`)),
      data.lots.length ? cards : h('p', { class: 'rp-empty' }, 'No open lots for this shop.'),
      h('label', { for: 'contact' }, 'Customer contact name'),
      contact,
      h('label', { class: 'rp-check', for: 'agree' }, agree, h('span', null, 'Customer agrees: lots marked for expiry will not be returned.')),
      recorded,
      errBox,
      saveBtn));
}

function lotCard(lot, st, refreshCount) {
  const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: lot.deliveredCtn, value: st.shelf, 'aria-label': 'Cartons still on shelf' });
  const stepper = h('div', { class: 'stepper' });
  const setShelf = (n) => {
    st.shelf = Math.max(0, Math.min(lot.deliveredCtn, Number.isFinite(n) ? Math.trunc(n) : 0));
    input.value = st.shelf;
  };
  input.addEventListener('change', () => setShelf(Number(input.value)));
  setChildren(stepper,
    h('button', { type: 'button', 'aria-label': 'One fewer carton', onClick: () => setShelf(st.shelf - 1) }, '−'),
    input,
    h('button', { type: 'button', 'aria-label': 'One more carton', onClick: () => setShelf(st.shelf + 1) }, '+'));

  const buttons = [['SOLD_OUT', 'Sold out'], ['RETURN', 'Return'], ['NOT_CHECKED', 'Not checked']].map(([value, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => {
      st.outcome = st.outcome === value ? 'OK' : value;
      if (st.outcome === 'SOLD_OUT') setShelf(0);
      sync();
      refreshCount();
    });
    return [value, b];
  });
  const reasonSelect = h('select', {
    class: 'rp-input',
    style: { marginTop: '8px' },
    onChange: () => {
      st.returnReason = reasonSelect.value;
      reasonNote.hidden = reasonSelect.value !== 'OTHER';
    },
  },
    h('option', { value: '' }, 'Choose return reason (required)…'),
    h('option', { value: 'EXPIRED' }, 'Approaching expiry / Expired'),
    h('option', { value: 'DAMAGED' }, 'Damaged cartons / packaging'),
    h('option', { value: 'OTHER' }, 'Other reason (specify)'));
  const reasonNote = h('input', {
    class: 'rp-input',
    type: 'text',
    placeholder: 'Specify other return reason…',
    hidden: true,
    style: { marginTop: '6px' },
    onInput: () => { st.returnNote = reasonNote.value.trim(); },
  });
  const returnReasonWrap = h('div', { hidden: true }, reasonSelect, reasonNote);

  function sync() {
    for (const [value, b] of buttons) b.setAttribute('aria-pressed', String(st.outcome === value));
    stepper.classList.toggle('off', st.outcome === 'SOLD_OUT' || st.outcome === 'NOT_CHECKED');
    returnReasonWrap.hidden = st.outcome !== 'RETURN';
  }

  const photoSlot = h('div');
  const file = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const showPhoto = () => {
    if (!st.photo) { setChildren(photoSlot); return; }
    setChildren(photoSlot, h('div', { class: 'thumb', style: { backgroundImage: `url(${st.photo.url})` } },
      h('button', { type: 'button', 'aria-label': 'Remove photo', onClick: () => { URL.revokeObjectURL(st.photo.url); st.photo = null; showPhoto(); } }, '×')));
  };
  file.addEventListener('change', async () => {
    const picked = file.files[0];
    file.value = '';
    if (!picked) return;
    try {
      const blob = await shrink(picked);
      if (st.photo) URL.revokeObjectURL(st.photo.url);
      st.photo = { blob, url: URL.createObjectURL(blob) };
      showPhoto();
    } catch (e) { toast(e.message); }
  });

  const t = tone(lot.daysLeft);
  const card = h('article', { class: 'rp-card lot' },
    h('div', { class: 'lot-img', style: lot.hasImage ? { backgroundImage: `url(/api/rep/products/${lot.productId}/image)` } : null, role: 'img', 'aria-label': lot.productName }),
    h('div', null,
      h('h3', null, lot.packSize ? `${lot.productName} - ${lot.packSize}` : lot.productName),
      h('span', { class: `pill ${t}` }, icon('clock'), expiryText(lot.daysLeft)),
      h('div', { class: 'sub' }, `Lot ${lot.lotCode}`),
      h('div', { class: 'sub' }, `Delivered: ${plural(lot.deliveredCtn, 'carton')}`)),
    h('div', { class: 'lot-label' }, 'Cartons still on shelf'),
    h('div', { class: 'lot-row' }, stepper,
      h('button', { class: 'rp-btn ghost', type: 'button', onClick: () => file.click() }, icon('camera'), 'Take photo'),
      photoSlot, file),
    h('div', { class: 'outcomes' }, buttons.map(([, b]) => b)),
    returnReasonWrap);
  sync();
  return card;
}

/* ---------- routing ---------- */
function route() {
  const m = /^#\/shop\/(\d+)$/.exec(location.hash);
  window.scrollTo(0, 0);
  if (m) renderVisit(Number(m[1])); else renderHome();
}
window.addEventListener('hashchange', route);
api('/api/rep/me').then((me) => {
  repName = me.name;
  repRoleLabel = me.roleLabel || 'Sales Representative';
  repMonthData = me.monthSummary || null;
}).catch(() => {}).finally(() => route());
