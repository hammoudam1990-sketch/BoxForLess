// First-sign-in password change for staff, in the same design as the main sign-in page.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const message = $('loginMessage');
const form = $('changeForm');
const accountRole = params.get('accountRole') || '';
const oneTime = sessionStorage.getItem('bfl.oneTime') || '';
sessionStorage.removeItem('bfl.oneTime');

function say(text, state = 'error') {
  message.textContent = text;
  message.dataset.state = state;
  message.hidden = !text;
}

// The temporary password typed at sign-in is carried over; after a reload it is asked for again.
if (!oneTime) { $('currentRow').hidden = false; $('currentRow').classList.remove('hidden'); }

for (const b of document.querySelectorAll('.password-toggle')) {
  b.addEventListener('click', () => {
    const input = $(b.dataset.show);
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    b.setAttribute('aria-pressed', String(show));
  });
}

form.addEventListener('input', () => say(''));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = oneTime || $('pCurrent').value;
  if (!current) { say('Enter your temporary password.'); return; }
  if (!$('pNew').value) { say('Choose a new password.'); return; }
  if ($('pNew').value !== $('pNew2').value) { say('The two passwords are not the same.'); return; }
  const button = $('pSubmit');
  button.disabled = true;
  try {
    const url = `/api/auth/staff/password${accountRole ? `?accountRole=${encodeURIComponent(accountRole)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ current, next: $('pNew').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `That did not work (${res.status}).`);
    say('Password saved. Opening your workspace…', 'success');
    const destination = new URL(data.home || '/index.html', location.origin);
    if (data.role) destination.searchParams.set('role', data.role);
    location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
  } catch (err) {
    say(err.message);
    button.disabled = false;
  }
});

(async () => {
  try {
    const me = await (await fetch(`/api/auth/me${accountRole ? `?accountRole=${encodeURIComponent(accountRole)}` : ''}`)).json();
    if (me.staff && !me.staff.mustChangePassword) {
      const destination = new URL(me.staff.home || '/index.html', location.origin);
      destination.searchParams.set('role', me.staff.role);
      location.assign(`${destination.pathname}${destination.search}`);
    } else if (!me.staff) {
      location.assign('/');
    } else {
      $('pNew').focus({ preventScroll: true });
    }
  } catch { /* the form still works */ }
})();
