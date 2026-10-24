// Staff sign-in: posts the username and password to /api/staff/login, which sets the
// signed session cookie, then goes on to ?next= (a path on this site only) or the staff app.
const form = document.getElementById('staffLoginForm');
const username = document.getElementById('username');
const password = document.getElementById('password');
const togglePassword = document.getElementById('togglePassword');
const button = document.getElementById('loginButton');
const label = button.querySelector('.submit-label');
const message = document.getElementById('loginMessage');
// The Sales Manager sign-in reuses this script with its own endpoints and landing page.
const loginUrl = form.dataset.login || '/api/staff/login';
const sessionUrl = form.dataset.session || '/api/staff/session';
const home = form.dataset.home || '/index.html';

function showError(text, input) {
  message.textContent = text;
  message.dataset.state = 'error';
  message.hidden = false;
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
}

function clearError() {
  message.textContent = '';
  message.hidden = true;
  delete message.dataset.state;
  username.removeAttribute('aria-invalid');
  password.removeAttribute('aria-invalid');
}

function nextPath() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return next.startsWith('/') && !next.startsWith('//') ? next : home;
}

togglePassword.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  togglePassword.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  togglePassword.setAttribute('aria-pressed', String(show));
  password.focus({ preventScroll: true });
});

form.addEventListener('input', clearError);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  if (!username.value.trim()) return showError('Enter your username to continue.', username);
  if (!password.value) return showError('Enter your password to continue.', password);

  button.disabled = true;
  label.textContent = 'Signing in…';
  try {
    const response = await fetch(loginUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value.trim(), password: password.value }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sign in failed (${response.status}).`);
    location.assign(nextPath());
  } catch (error) {
    const offline = error instanceof TypeError;
    showError(offline ? 'Could not reach the server. Check the connection and try again.' : error.message);
    password.select();
    button.disabled = false;
    label.textContent = 'Sign In';
  }
});

// Already signed in (for example, a bookmarked sign-in page): go straight on.
fetch(sessionUrl)
  .then((response) => (response.ok ? response.json() : null))
  .then((status) => { if (status?.authenticated) location.replace(nextPath()); })
  .catch(() => {});

username.focus();
