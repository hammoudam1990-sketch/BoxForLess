// One sign-in form detects customer accounts and team roles on the server.
const form = document.getElementById('generalLoginForm');
const identifier = document.getElementById('identifier');
const password = document.getElementById('password');
const togglePassword = document.getElementById('togglePassword');
const loginButton = document.getElementById('loginButton');
const message = document.getElementById('loginMessage');

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
  if (role === 'database-rep') {
    return pathname === '/rep.html' ? next : '/rep.html';
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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessage();
  if (!requireValue(identifier, 'Customer ID or work email')) return;
  if (!requireValue(password, 'password')) return;

  loginButton.disabled = true;
  loginButton.setAttribute('aria-busy', 'true');
  const submitLabel = loginButton.querySelector('.submit-label');
  submitLabel.textContent = 'Signing in…';
  let navigating = false;

  try {
    const value = identifier.value.trim();

    // Customers authenticate by ID; staff authentication remains server-resolved.
    const customerRes = await fetch('/api/auth/customer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: value, password: password.value }),
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

    const staffRes = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: value, password: password.value }),
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

    const accountRes = await fetch('/api/staff/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: value, password: password.value }),
    });

    if (accountRes.ok) {
      const account = await accountRes.json();
      if (account.mustChangePassword) {
        showMessage('Sign-in successful. Choose a new password to continue…', 'success');
        navigating = true;
        location.assign('/signin.html?role=staff');
        return;
      }

      showMessage('Signed in. Opening your workspace…', 'success');
      navigating = true;
      location.assign(nextPath(account.role === 'SALES_REP' ? 'database-rep' : 'admin'));
      return;
    }

    if (accountRes.status === 429) {
      throw new Error('Too many sign-in attempts. Please wait 15 minutes and try again.');
    }

    const accountData = await accountRes.json().catch(() => ({}));
    throw new Error(accountData.error || 'The Customer ID, work email or password is not correct.');
  } catch (error) {
    showMessage(error instanceof TypeError
      ? 'Could not reach the sign-in service. Check your connection and try again.'
      : error.message || 'Sign in failed. Please try again.', 'error');
    password.setAttribute('aria-invalid', 'true');
    password.select();
  } finally {
    if (!navigating) {
      loginButton.disabled = false;
      loginButton.removeAttribute('aria-busy');
      submitLabel.textContent = 'Sign in securely';
    }
  }
});

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
    // The form remains usable if session status is unavailable.
  }
}
checkCurrentSession();

const registered = new URLSearchParams(location.search).get('registered');
if (registered) {
  showMessage('Your registration was received. You can sign in once the Sales Manager has approved it.');
  identifier.value = registered;
}
