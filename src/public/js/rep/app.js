// Sales-rep screens, after the Oct 2026 mockup:
//   #/            R01 My visits — shops with open expiry alerts, nearest expiry first
//   #/visit/:id   R02 Visit form — per lot: cartons on the shelf, photo, outcome
//
// Shops, lots and the rep are SAMPLE data (./data.js); saved visits stay in this browser.
// Every field someone types into is built once per screen and only shown or hidden.
window.__bflBooted = true; // tells boot-guard.js the page started
import { h, setChildren, svg } from '../lib/dom.js';
import { doodle } from '../catalog/doodles.js';
import { readCart, onCartChange } from '../cart.js';
import {
  REP, shopsToVisit, findShop, allShops, saveVisit, orderingFor, setOrderingFor, resetSample, expiryTone, REVISIT_DAYS, drawingFor,
} from './data.js';

const P = {
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5',
  store: 'M4 9.5 5.5 4h13L20 9.5M4 9.5h16M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5 11.5V20h14v-8.5M10 20v-5h4v5',
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5h.01',
  calendar: 'M4 6h16v15H4zM8 3v5M16 3v5M4 10h16M8 14h3M13 14h3M8 17h3',
  people: 'M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5',
  chevronDown: 'm6 9 6 6 6-6',
  chevronRight: 'm9 6 6 6-6 6',
  pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  box: 'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3.5 7.7 12 12l8.5-4.3M12 12v9',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  warn: 'M12 4 2.5 20h19L12 4zM12 10v4.5M12 17.5h.01',
  check: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 12.5l2.7 2.7L16 9.8',
  back: 'M19 12H5M11 6l-6 6 6 6',
  camera: 'M4 8h3.5L9 5.5h6L16.5 8H20v11H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20a8 8 0 0 1 16 0',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  close: 'M6 6l12 12M18 6L6 18',
  visits: 'M4 11.5 12 4l8 7.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  cart: 'M3 4h2.2l2.3 11h10.8l2-8H6.4M9.5 19.5h.01M17 19.5h.01',
};
const icon = (name, cls = '') => svg(`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="${P[name]}"/></svg>`);
const brandMark = () => svg(`<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">
  <path d="m24 3 19 10.5v21L24 45 5 34.5v-21L24 3Z" fill="currentColor"/>
  <path d="m5.5 13.5 18.5 10 18.5-10M24 24v20.5M15 8l19 11M33 8 14 19" fill="none" stroke="#0b2a55" stroke-width="2.6" stroke-linejoin="round"/>
</svg>`);
const sampleTag = () => h('span', { class: 'r-sample', title: 'Shops, lots and the rep shown here are sample data until rep accounts and Odoo expiry alerts are connected.' }, 'Sample');

function expiryChip(days, overdue = false) {
  if (overdue) return h('span', { class: 'r-chip red' }, icon('alert'), 'Visit overdue');
  const tone = expiryTone(days);
  return h('span', { class: `r-chip ${tone}` }, icon(tone === 'red' ? 'warn' : tone === 'amber' ? 'clock' : 'check'),
    days <= 0 ? 'Expired' : `Expires in ${days} day${days === 1 ? '' : 's'}`);
}

const root = document.getElementById('root');
let toastTimer = null;
function toast(text) {
  let el = document.querySelector('.r-toast');
  if (!el) { el = h('div', { class: 'r-toast', role: 'status' }); document.body.append(el); }
  el.textContent = text;
  el.classList.add('on');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('on'), 2600);
}

// ------------------------------------------------------------------ bottom tab bar
function tabbar(active) {
  const cartBadge = h('span', { class: 'r-tab-badge', hidden: true });
  const syncCart = (lines) => {
    const n = lines.reduce((sum, l) => sum + l.quantityCtn, 0);
    cartBadge.textContent = n;
    cartBadge.hidden = !n;
  };
  syncCart(readCart());
  onCartChange(syncCart);
  const tab = (href, name, label, extra) => h('a', { class: 'r-tab', href, 'aria-current': active === name ? 'page' : null },
    h('span', { class: 'r-tab-icon' }, icon(name), extra), h('span', {}, label));
  return h('nav', { class: 'r-tabbar', 'aria-label': 'Rep navigation' },
    tab('#/', 'visits', 'Visits'),
    tab('/catalog', 'store', 'Shop'),
    tab('/catalog?p=products', 'cart', 'Request', cartBadge),
    tab('#/account', 'user', 'Account'));
}

// ------------------------------------------------------------------ R01 My visits
function renderVisits() {
  document.title = 'My visits — Box for Less';
  const shops = shopsToVisit();
  const lotsExpiring = shops.reduce((n, s) => n + s.open.length, 0);
  const overdue = shops.filter((s) => s.overdue).length;

  const list = h('div', { class: 'r-shops' });
  const empty = h('p', { class: 'r-empty', hidden: true }, 'No shop matches that name or ID.');
  const drawList = (term) => {
    const q = term.trim().toLowerCase();
    const shown = shops.filter((s) => !q || s.name.toLowerCase().includes(q) || s.id.includes(q));
    setChildren(list, shown.map(shopCard));
    empty.hidden = shown.length > 0;
  };
  const search = h('input', {
    type: 'search', class: 'r-search-input', placeholder: 'Find a customer by name or ID', autocomplete: 'off',
    'aria-label': 'Find a customer by name or ID', onInput: (e) => drawList(e.target.value),
  });

  // "Ordering for": the customer a rep is ordering on behalf of in the shop.
  const current = orderingFor();
  const select = h('select', {
    class: 'r-ordering-select', 'aria-label': 'Ordering for',
    onChange: (e) => {
      const shop = allShops().find((s) => s.id === e.target.value) || null;
      setOrderingFor(shop);
      toast(shop ? `Ordering for ${shop.name}` : 'No customer chosen');
    },
  },
  h('option', { value: '' }, 'Choose a customer'),
  allShops().map((s) => h('option', { value: s.id, selected: current?.id === s.id }, `${s.name} · ID ${s.id}`)));

  const stat = (iconName, n, label, cls = '') => h('div', { class: `r-stat ${cls}` },
    h('span', { class: 'r-stat-top' }, icon(iconName), h('b', {}, n)), h('span', {}, label));

  drawList('');
  setChildren(root, h('div', { class: 'r-app' },
    header(h('div', { class: 'r-head-title' }, h('h1', {}, 'My visits'), h('p', {}, `${REP.name} - ${REP.role}`))),
    h('main', { class: 'r-main' },
      h('label', { class: 'r-search' }, icon('search'), search),
      h('div', { class: 'r-stats' },
        stat('store', shops.length, 'shops to visit'),
        stat('alert', overdue, 'overdue', 'red'),
        stat('calendar', lotsExpiring, 'lots expiring')),
      h('label', { class: 'r-ordering' }, icon('people'), h('span', { class: 'r-ordering-k' }, 'Ordering for:'), select, icon('chevronDown', 'r-ordering-chev')),
      h('div', { class: 'r-section-head' }, h('h2', {}, 'Shops ', h('small', {}, '(sorted by nearest expiry)')), sampleTag()),
      list, empty,
      shops.length ? null : h('div', { class: 'r-done' }, icon('check'), h('b', {}, 'All visits done'), h('p', {}, 'No open expiry alerts in your shops.'))),
    tabbar('visits')));
}

function shopCard(shop) {
  return h('article', { class: `r-shop${shop.overdue ? ' overdue' : ''}` },
    h('span', { class: 'r-shop-icon' }, icon('store')),
    h('div', { class: 'r-shop-body' },
      h('h3', {}, shop.name),
      h('p', { class: 'r-where' }, icon('pin'), shop.area),
      h('div', { class: 'r-chips' }, h('span', { class: 'r-chip grey' }, `ID ${shop.id}`), expiryChip(shop.nearest, shop.overdue)),
      h('p', { class: 'r-lots' }, icon('box'), `${shop.open.length} lot${shop.open.length === 1 ? '' : 's'} expiring`)),
    h('a', { class: 'r-start', href: `#/visit/${shop.id}` }, 'Start visit', icon('chevronRight')));
}

function header(content, { back = false } = {}) {
  return h('header', { class: `r-head${back ? ' r-head-back' : ''}` },
    back ? null : h('div', { class: 'r-head-brand' },
      h('span', { class: 'r-logo' }, brandMark()),
      h('span', {}, h('b', {}, 'Box for Less'), h('small', {}, 'Bigger boxes. Better value.')),
      h('a', { class: 'r-account', href: '#/account', 'aria-label': 'Account' }, icon('user'))),
    content);
}

// ------------------------------------------------------------------ R02 Visit form
const OUTCOMES = [
  ['sold_out', 'Sold out'], ['discount', 'Discount'], ['return', 'Return'], ['not_checked', 'Not checked'],
];

function renderVisit(id) {
  const shop = findShop(id);
  if (!shop) { location.hash = '#/'; return; }
  document.title = `Visit ${shop.name} — Box for Less`;
  const states = shop.open.map((lot) => ({ lot, shelf: null, outcome: null, discount: '', photo: null }));
  const recorded = h('span', {});
  const message = h('p', { class: 'r-form-error', role: 'alert', hidden: true });

  const countRecorded = () => {
    const n = states.filter((s) => s.outcome).length;
    recorded.textContent = `${n} of ${states.length} lot${states.length === 1 ? '' : 's'} recorded`;
  };

  const lotCards = states.map((st, i) => lotCard(st, i, countRecorded));

  const contact = h('input', { class: 'r-input', type: 'text', autocomplete: 'off', placeholder: 'Name of the person you spoke to', id: 'contactName' });
  const agree = h('input', { type: 'checkbox', id: 'agree' });
  const agreeRow = h('label', { class: 'r-agree', for: 'agree' }, agree,
    h('span', {}, 'Customer agrees: the discounted lots will not be returned for expiry'));

  const save = h('button', { type: 'button', class: 'r-save', onClick: () => submit() }, icon('save'), 'Save visit');

  function submit() {
    message.hidden = true;
    const missing = states.findIndex((s) => !s.outcome);
    if (missing >= 0) return fail(`Choose an outcome for ${states[missing].lot.product} (lot ${states[missing].lot.lot}).`, lotCards[missing].focusTarget);
    const discounts = states.filter((s) => s.outcome === 'discount');
    for (const s of discounts) {
      const pct = Number(s.discount);
      if (!Number.isFinite(pct) || pct < 1 || pct > 90) {
        return fail(`Enter a discount between 1 and 90% for ${s.lot.product}.`, lotCards[states.indexOf(s)].discountInput);
      }
    }
    if (discounts.length && !contact.value.trim()) return fail('Enter the name of the customer contact who agreed the discount.', contact);
    if (discounts.length && !agree.checked) return fail('Tick the box to record that the customer agrees not to return the discounted lots.', agree);
    const ok = saveVisit({
      shopId: shop.id, shopName: shop.name, contact: contact.value.trim(), agreed: discounts.length ? agree.checked : null,
      lines: states.map((s) => ({
        lot: s.lot.lot, product: s.lot.product, shelf: s.outcome === 'sold_out' ? 0 : s.shelf,
        outcome: s.outcome, discount: s.outcome === 'discount' ? Number(s.discount) : null, photo: s.photo,
      })),
    });
    if (!ok) return fail('This phone could not save the visit (storage is full or blocked). Remove some photos and try again.');
    const pending = discounts.length;
    location.hash = '#/';
    toast(pending ? `Visit saved. ${pending} discount${pending === 1 ? '' : 's'} sent for Sales Manager approval.` : 'Visit saved.');
    return undefined;
  }
  function fail(text, focus) {
    message.textContent = text;
    message.hidden = false;
    focus?.focus();
    focus?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  countRecorded();
  setChildren(root, h('div', { class: 'r-app' },
    header(h('div', { class: 'r-head-row' },
      h('a', { class: 'r-back', href: '#/', 'aria-label': 'Back to my visits' }, icon('back')),
      h('div', { class: 'r-head-title' }, h('h1', {}, shop.name), h('p', {}, `ID ${shop.id} - ${shop.area}`))), { back: true }),
    h('main', { class: 'r-main r-visit' },
      h('div', { class: 'r-section-head' }, h('h2', {}, 'Open alerts ', h('small', {}, `(${states.length} lot${states.length === 1 ? '' : 's'})`)), sampleTag()),
      h('div', { class: 'r-lot-list' }, lotCards.map((c) => c.el)),
      h('div', { class: 'r-contact' },
        h('label', { for: 'contactName' }, 'Customer contact name'),
        h('span', { class: 'r-input-wrap' }, icon('user'), contact)),
      agreeRow,
      h('div', { class: 'r-recorded' }, recorded),
      message,
      save),
    tabbar('visits')));
}

/** One lot in the visit form. Returns { el, focusTarget, discountInput }. */
function lotCard(st, index, onChange) {
  const { lot } = st;
  const qty = h('input', {
    class: 'r-qty-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', value: '', placeholder: '–',
    'aria-label': `Cartons of ${lot.product} still on the shelf`,
    onInput: (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
      if (digits !== e.target.value) e.target.value = digits;
      st.shelf = digits === '' ? null : Number(digits);
    },
  });
  const step = (d) => {
    st.shelf = Math.max(0, Math.min(lot.delivered, (st.shelf ?? 0) + d));
    qty.value = String(st.shelf);
  };

  // photo: a small JPEG kept with the visit (resized so localStorage can hold it)
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'r-file', 'aria-label': `Photo of ${lot.product} on the shelf` });
  const thumb = h('div', { class: 'r-thumb', hidden: true });
  const photoBtn = h('button', { type: 'button', class: 'r-photo-btn', onClick: () => fileInput.click() }, icon('camera'), 'Take photo');
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      st.photo = await shrinkPhoto(file);
      setChildren(thumb,
        h('img', { src: st.photo, alt: `Shelf photo of ${lot.product}` }),
        h('button', { type: 'button', class: 'r-thumb-x', 'aria-label': 'Remove photo', onClick: () => { st.photo = null; thumb.hidden = true; setChildren(thumb); } }, icon('close')));
      thumb.hidden = false;
    } catch { toast('That photo could not be read. Try again.'); }
  });

  // outcome buttons, and the discount field shown only for "Discount"
  const discountInput = h('input', {
    class: 'r-input r-discount-input', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'e.g. 20',
    'aria-label': `Proposed discount for ${lot.product}, in percent`,
    onInput: (e) => {
      const digits = e.target.value.replace(/\D/g, '').slice(0, 2);
      if (digits !== e.target.value) e.target.value = digits;
      st.discount = digits;
    },
  });
  const discountRow = h('div', { class: 'r-discount', hidden: true },
    h('label', {}, 'Proposed discount %', discountInput),
    h('span', { class: 'r-hint' }, 'Waits for Sales Manager approval'));
  const notCheckedHint = h('p', { class: 'r-hint r-hint-line', hidden: true }, `Due again in ${REVISIT_DAYS} days.`);
  const outcomeButtons = OUTCOMES.map(([key, label]) => h('button', {
    type: 'button', class: 'r-outcome', 'aria-pressed': 'false',
    onClick: () => {
      st.outcome = key;
      outcomeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(OUTCOMES[i][0] === key)));
      discountRow.hidden = key !== 'discount';
      notCheckedHint.hidden = key !== 'not_checked';
      if (key === 'sold_out') { st.shelf = 0; qty.value = '0'; }
      if (key === 'discount') discountInput.focus();
      card.classList.add('done');
      onChange();
    },
  }, label));

  const body = h('div', { class: 'r-lot-body' },
    h('div', { class: 'r-lot-row' },
      h('div', { class: 'r-shelf' },
        h('span', { class: 'r-label' }, 'Cartons still on shelf'),
        h('div', { class: 'r-qty' },
          h('button', { type: 'button', 'aria-label': 'One carton fewer', onClick: () => step(-1) }, '−'),
          qty,
          h('button', { type: 'button', 'aria-label': 'One carton more', onClick: () => step(1) }, '+'))),
      photoBtn, fileInput, thumb),
    h('div', { class: 'r-outcomes', role: 'group', 'aria-label': `Outcome for ${lot.product}` }, outcomeButtons),
    discountRow, notCheckedHint);

  const toggle = h('button', {
    type: 'button', class: 'r-lot-toggle', 'aria-expanded': 'true', 'aria-label': `Show or hide ${lot.product}`,
    onClick: () => {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
    },
  }, icon('chevronDown'));

  const card = h('section', { class: 'r-lot' },
    h('div', { class: 'r-lot-head' },
      h('span', { class: 'r-lot-pic' }, doodle(drawingFor(lot.product), { size: 'lg' })),
      h('div', { class: 'r-lot-info' },
        h('h3', {}, lot.product, h('span', {}, ` - Carton of ${lot.pack}`)),
        h('p', { class: 'r-lot-no' }, `Lot ${lot.lot}`),
        expiryChip(lot.days),
        h('p', { class: 'r-delivered' }, `Delivered: ${lot.delivered} cartons`)),
      toggle),
    body);
  return { el: card, focusTarget: outcomeButtons[0], discountInput };
}

/** Resize a photo to at most 480px and return it as a JPEG data URL. */
function shrinkPhoto(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 480 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
    img.src = url;
  });
}

// ------------------------------------------------------------------ account
function renderAccount() {
  document.title = 'Account — Box for Less';
  setChildren(root, h('div', { class: 'r-app' },
    header(h('div', { class: 'r-head-title' }, h('h1', {}, 'Account'), h('p', {}, `${REP.name} - ${REP.role}`))),
    h('main', { class: 'r-main' },
      h('section', { class: 'r-card' },
        h('h2', {}, 'Preview'),
        h('p', {}, 'Rep sign-in arrives with accounts (Phase 2), and the expiry alerts are read from Odoo in Phase 7. Until then this page uses sample shops, and visits are saved on this phone only.'),
        h('button', {
          type: 'button', class: 'r-photo-btn', onClick: () => { resetSample(); toast('Sample visits cleared.'); location.hash = '#/'; },
        }, 'Start the sample over')),
      h('section', { class: 'r-card' },
        h('h2', {}, 'Links'),
        h('a', { class: 'r-link', href: '/catalog' }, 'Customer catalogue', icon('chevronRight')),
        h('a', { class: 'r-link', href: '/' }, 'Box for Less home', icon('chevronRight')))),
    tabbar('user')));
}

// ------------------------------------------------------------------ routing
function route() {
  const [, page, id] = (location.hash || '#/').split('/');
  window.scrollTo(0, 0);
  if (page === 'visit' && id) renderVisit(decodeURIComponent(id));
  else if (page === 'account') renderAccount();
  else renderVisits();
}
window.addEventListener('hashchange', route);
route();
