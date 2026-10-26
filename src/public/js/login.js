// One sign-in form detects customer accounts and team roles on the server.
const form = document.getElementById('generalLoginForm');
const identifier = document.getElementById('identifier');
const password = document.getElementById('password');
const rememberMe = document.getElementById('rememberMe');
const togglePassword = document.getElementById('togglePassword');
const forgotPassword = document.getElementById('forgotPassword');
const googleSignIn = document.getElementById('googleSignIn');
const loginButton = document.getElementById('loginButton');
const message = document.getElementById('loginMessage');
const brandPanel = document.querySelector('.brand-panel');

function showMessage(text, state = 'info') {
  message.textContent = text;
  message.dataset.state = state;
  message.hidden = false;
}

function clearMessage() {
  message.textContent = '';
  message.hidden = true;
  delete message.dataset.state;
  identifier.removeAttribute('aria-invalid');
  password.removeAttribute('aria-invalid');
}

function requireValue(input, label) {
  if (input.value.trim()) return true;
  input.setAttribute('aria-invalid', 'true');
  showMessage(`Enter your ${label} to continue.`, 'error');
  input.focus();
  return false;
}

function requestedPath() {
  const next = new URLSearchParams(location.search).get('next') || '';
  if (!next.startsWith('/') || next.startsWith('//')) return '';
  try {
    const url = new URL(next, location.origin);
    return url.origin === location.origin ? `${url.pathname}${url.search}${url.hash}` : '';
  } catch {
    return '';
  }
}

function nextPath(role) {
  const next = requestedPath();
  const pathname = next ? new URL(next, location.origin).pathname : '';
  if (role === 'customer') {
    return pathname === '/catalog' || pathname.startsWith('/catalog/')
      ? next : '/catalog';
  }
  if (role === 'admin') {
    return ['/index.html', '/scan.html'].includes(pathname) ? next : '/index.html';
  }
  if (role === 'sales') return pathname === '/sales' ? next : '/sales';
  if (role === 'rep') return pathname === '/rep' ? next : '/rep';
  throw new Error('This account role is not recognized.');
}

togglePassword.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  togglePassword.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  togglePassword.setAttribute('aria-pressed', String(show));
  password.focus({ preventScroll: true });
});

form.addEventListener('input', (event) => {
  if (event.target === identifier || event.target === password) clearMessage();
});

forgotPassword.addEventListener('click', () => {
  showMessage('Password recovery is not connected yet. Please contact Box for Less to reset your password.');
});

googleSignIn.addEventListener('click', () => {
  showMessage('Google sign-in is not connected yet. Use your email, phone number or team username instead.');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage();
  if (!requireValue(identifier, 'email address, phone number or username')) return;
  if (!requireValue(password, 'password')) return;

  loginButton.disabled = true;
  const submitLabel = loginButton.querySelector('.submit-label');
  submitLabel.textContent = 'Signing in…';
  let navigating = false;

  try {
    const creds = { id: identifier.value.trim(), username: identifier.value.trim(), password: password.value };

    // 1. Check customer authentication against the database
    const customerRes = await fetch('/api/auth/customer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: creds.id, password: creds.password }),
    });

    if (customerRes.ok) {
      const data = await customerRes.json();
      showMessage(`Signed in as ${data.customer?.name || 'Customer'}. Opening your catalogue…`, 'success');
      navigating = true;
      location.assign(nextPath('customer'));
      return;
    }

    if (customerRes.status === 429) {
      throw new Error('Too many sign-in attempts. Please wait 15 minutes and try again.');
    }

    // 2. Check team role authentication on the server (Admin, Sales Manager, Sales Rep)
    const staffRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    });

    if (staffRes.ok) {
      const result = await staffRes.json();
      const roleNames = { admin: 'staff dashboard', sales: 'Sales Manager dashboard', rep: 'Sales Rep app' };
      showMessage(`Signed in. Opening your ${roleNames[result.role] || 'workspace'}…`, 'success');
      navigating = true;
      location.assign(nextPath(result.role));
      return;
    }

    if (staffRes.status === 429) {
      throw new Error('Too many sign-in attempts. Please wait 15 minutes and try again.');
    }

    const staffData = await staffRes.json().catch(() => ({}));
    throw new Error(staffData.error || 'The email, phone number, customer ID or password is not correct.');
  } catch (error) {
    showMessage(error instanceof TypeError
      ? 'Could not reach the sign-in service. Check your connection and try again.'
      : error.message || 'Sign in failed. Please try again.', 'error');
    password.setAttribute('aria-invalid', 'true');
    password.select();
  } finally {
    if (!navigating) {
      loginButton.disabled = false;
      submitLabel.textContent = 'Sign In';
    }
  }
});

// Check whether already signed in on the server
async function checkCurrentSession() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return;
    const me = await res.json();
    if (me.customer) {
      showMessage(`You are currently signed in as ${me.customer.name}. Sign in again to switch account, or go to the catalogue.`);
    } else if (me.staff) {
      showMessage(`You are currently signed in as ${me.staff.name} (${me.staff.roleLabel}). Sign in again to switch account, or go to your dashboard.`);
    }
  } catch {
    // Offline or connection failed
  }
}
checkCurrentSession();

const registered = new URLSearchParams(location.search).get('registered');
if (registered) {
  showMessage('Your registration was received. You can sign in once the Sales Manager has approved it.');
  identifier.value = registered;
}

if (
  brandPanel &&
  window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
  !window.matchMedia('(prefers-reduced-motion: reduce)').matches
) {
  brandPanel.addEventListener('pointermove', (event) => {
    const bounds = brandPanel.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width - 0.5;
    const y = (event.clientY - bounds.top) / bounds.height - 0.5;
    brandPanel.style.setProperty('--parallax-x', `${x * -10}px`);
    brandPanel.style.setProperty('--parallax-y', `${y * -8}px`);
  });

  brandPanel.addEventListener('pointerleave', () => {
    brandPanel.style.removeProperty('--parallax-x');
    brandPanel.style.removeProperty('--parallax-y');
  });
}
