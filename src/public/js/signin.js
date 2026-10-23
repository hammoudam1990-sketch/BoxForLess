// The sign-in page: customers (ID + password, or first-time activation) and staff (email or phone +
// password, then a new password if this is their first time).
//
// The forms are in signin.html and are only shown or hidden — never rebuilt — so what someone has
// typed is never lost. Passwords are sent over the form's own POST and never stored or logged here.
window.__bflBooted = true; // tells js/boot-guard.js the page started

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

/** A path on THIS site, or the fallback. Never an address on another site. */
function safeNext(fallback) {
  const next = params.get('next') || '';
  return next.startsWith('/') && !next.startsWith('//') && !next.includes('\\') ? next : fallback;
}

const message = $('message');
function say(text, kind = 'error') { message.textContent = text; message.className = `si-msg ${text ? kind : ''}`; }

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `That did not work (${res.status}).`); err.code = data.code; err.status = res.status; throw err; }
  return data;
}

/** Disable a button while its request runs, and always turn it back on. */
async function busy(button, fn) {
  button.disabled = true;
  say('');
  try { await fn(); } catch (e) { say(e.message); } finally { button.disabled = false; }
}

// ---- tabs ------------------------------------------------------------------------------------
function showTab(which) {
  const staff = which === 'staff';
  $('tabCustomer').setAttribute('aria-selected', String(!staff));
  $('tabStaff').setAttribute('aria-selected', String(staff));
  $('panelCustomer').classList.toggle('hidden', staff);
  $('panelStaff').classList.toggle('hidden', !staff);
  $('panelChange').classList.add('hidden');
  say('');
  (staff ? $('sId') : $('cId')).focus({ preventScroll: true });
}
$('tabCustomer').addEventListener('click', () => showTab('customer'));
$('tabStaff').addEventListener('click', () => showTab('staff'));

// show / hide a password
for (const b of document.querySelectorAll('.si-show')) {
  b.addEventListener('click', () => {
    const input = $(b.dataset.show);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.textContent = show ? 'Hide' : 'Show';
    b.setAttribute('aria-pressed', String(show));
  });
}

// ---- customer: sign in -----------------------------------------------------------------------
$('customerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('cId').value.trim();
  const password = $('cPassword').value;
  if (!id || !password) { say('Enter your customer ID and password.'); return; }
  busy($('cSubmit'), async () => {
    const r = await post('/api/auth/customer/login', { id, password });
    location.assign(safeNext(r.home));
  });
});

// ---- customer: first time --------------------------------------------------------------------
$('showActivate').addEventListener('click', () => {
  const form = $('activateForm');
  const open = form.classList.contains('hidden');
  form.classList.toggle('hidden', !open);
  $('showActivate').textContent = open ? 'Back to sign in' : 'First time? Activate your account';
  if (open) { $('aId').value = $('aId').value || $('cId').value; $('aId').focus({ preventScroll: true }); }
  say('');
});

$('activateForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = $('aId').value.trim();
  const code = $('aCode').value.trim();
  const password = $('aPassword').value;
  if (!id || !code || !password) { say('Enter your customer ID, your access code and a new password.'); return; }
  if (password !== $('aPassword2').value) { say('The two passwords are not the same.'); return; }
  busy($('aSubmit'), async () => {
    const r = await post('/api/auth/customer/activate', { id, code, password });
    location.assign(safeNext(r.home));
  });
});

// ---- staff -----------------------------------------------------------------------------------
$('staffForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const identifier = $('sId').value.trim();
  const password = $('sPassword').value;
  if (!identifier || !password) { say('Enter your email or phone number and your password.'); return; }
  busy($('sSubmit'), async () => {
    const r = await post('/api/staff/login', { identifier, password });
    if (r.mustChangePassword) { oneTime = password; showChange(); $('pNew').focus(); return; }
    location.assign(next(r.home));
  });
});

/** Staff go where they were headed if their role allows it (the server redirects otherwise), else home. */
function next(home) { return safeNext(home); }

// The one-time password just typed to sign in is kept here, so the form need not ask for it again (and a
// password manager cannot fill the wrong one into it). After a page reload it is asked for.
let oneTime = '';

function showChange() {
  $('currentRow').classList.toggle('hidden', Boolean(oneTime));
  $('panelCustomer').classList.add('hidden');
  $('panelStaff').classList.add('hidden');
  $('panelChange').classList.remove('hidden');
  document.querySelector('.si-tabs').classList.add('hidden');
  say('');
}

$('changeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if ($('pNew').value !== $('pNew2').value) { say('The two passwords are not the same.'); return; }
  busy($('pSubmit'), async () => {
    const r = await post('/api/auth/staff/password', { current: oneTime || $('pCurrent').value, next: $('pNew').value });
    location.assign(r.home || '/index.html');
  });
});

// ---- on arrival ------------------------------------------------------------------------------
// Already signed in? Go straight on, unless they came here to switch ("?switch=1").
(async () => {
  if (location.pathname.startsWith('/staff/login') || params.get('role') === 'staff') showTab('staff');
  try {
    const me = await (await fetch('/api/auth/me')).json();
    if (me.staff && me.staff.mustChangePassword) { showChange(); say('Choose your own password to continue.', 'info'); return; }
    if (params.get('switch') === '1') return;
    if (me.staff) location.assign(safeNext(me.staff.home));
    else if (me.customer && me.customer.viaPassword) location.assign(safeNext('/catalog'));
  } catch { /* the page still works without this */ }
})();
