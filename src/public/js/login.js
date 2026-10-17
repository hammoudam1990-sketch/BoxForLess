const form = document.getElementById('generalLoginForm');
const identifier = document.getElementById('identifier');
const password = document.getElementById('password');
const togglePassword = document.getElementById('togglePassword');
const forgotPassword = document.getElementById('forgotPassword');
const contactSales = document.getElementById('contactSales');
const googleSignIn = document.getElementById('googleSignIn');
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
  showMessage('Password recovery is not connected yet. No reset email has been sent.');
});

contactSales.addEventListener('click', () => {
  showMessage('Sales contact is not configured in this preview. No message has been sent.');
});

googleSignIn.addEventListener('click', () => {
  showMessage('Google sign-in is not connected yet. No account has been authenticated.');
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  clearMessage();
  if (!requireValue(identifier, 'email address or phone number')) return;
  if (!requireValue(password, 'password')) return;
  showMessage('Sign-in is not connected yet. Your information has not been sent.');
});

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
