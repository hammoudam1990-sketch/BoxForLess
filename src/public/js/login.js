// One sign-in form detects customer accounts in the browser and team roles on the server.
import { accounts, DEMO_LOGINS } from './lib/local-accounts.js';

const store = accounts();
const form = document.getElementById('generalLoginForm');
const identifier = document.getElementById('identifier');
const password = document.getElementById('password');
const rememberMe = document.getElementById('rememberMe');
const togglePassword = document.getElementById('togglePassword');
const forgotPassword = document.getElementById('forgotPassword');
const googleSignIn = document.getElementById('googleSignIn');
const loginButton = document.getElementById('loginButton');
const message = document.getElementById('loginMessage');
const demoList = document.getElementById('demoAccounts');
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
    const customer = store.signIn(identifier.value, password.value, rememberMe.checked);
    if (customer.ok) {
      const logout = await fetch('/api/auth/logout', { method: 'POST' });
      if (!logout.ok) throw new Error('Could not clear another signed-in team account. Please try again.');
      showMessage(`Signed in as ${customer.account.company}. Opening your catalogue…`, 'success');
      const destination = nextPath('customer');
      navigating = true;
      location.assign(destination);
      return;
    }
    if (customer.pending) {
      showMessage(customer.error, 'info');
      return;
    }

    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: identifier.value.trim(), password: password.value }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Sign in failed (${response.status}).`);
    const roleNames = { admin: 'staff dashboard', sales: 'Sales Manager dashboard', rep: 'Sales Rep app' };
    showMessage(`Signed in. Opening your ${roleNames[result.role] || 'workspace'}…`, 'success');
    const destination = nextPath(result.role);
    store.signOut();
    navigating = true;
    location.assign(destination);
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

// Demo accounts: tapping one fills the form, so the screens can be tried quickly.
if (demoList) {
  const labels = { credit: 'Credit customer', cash: 'Cash customer' };
  for (const demo of DEMO_LOGINS) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'demo-account';
    const role = demo.status === 'pending' ? 'Waiting for approval' : labels[demo.type];
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = role;
    button.querySelector('span').textContent = `${demo.email} · ${demo.password}`;
    button.addEventListener('click', () => {
      identifier.value = demo.email;
      password.value = demo.password;
      clearMessage();
      loginButton.focus();
    });
    li.append(button);
    demoList.append(li);
  }
}

// Already signed in: say so, and offer the way on.
const signedIn = store.currentAccount();
if (signedIn) showMessage(`You are signed in as ${signedIn.company}. Sign in again to switch account, or go to the catalogue.`);

const registered = new URLSearchParams(location.search).get('registered');
if (registered && !signedIn) {
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
