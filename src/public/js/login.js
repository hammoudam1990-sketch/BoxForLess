// Customer sign-in. Accounts live in this browser's localStorage for now (see
// lib/local-accounts.js); nothing is sent to the server until Phase 2 accounts exist.
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

// Where to go after signing in: ?next= when it is a path on this site, else the catalogue.
function nextPath() {
  const next = new URLSearchParams(location.search).get('next') || '';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/catalog';
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
  showMessage('Google sign-in is not connected yet. Sign in with your email or phone number instead.');
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearMessage();
  if (!requireValue(identifier, 'email address or phone number')) return;
  if (!requireValue(password, 'password')) return;

  const result = store.signIn(identifier.value, password.value, rememberMe.checked);
  if (!result.ok) {
    showMessage(result.error, result.pending ? 'info' : 'error');
    if (!result.pending) {
      password.setAttribute('aria-invalid', 'true');
      password.select();
    }
    return;
  }
  loginButton.disabled = true;
  showMessage(`Signed in as ${result.account.company}. Opening the catalogue…`, 'success');
  location.assign(nextPath());
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
