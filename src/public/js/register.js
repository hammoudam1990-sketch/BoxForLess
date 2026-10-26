// C02 Register. Submits the registration to the backend database (/api/requests/access-requests)
// for Sales Manager approval.
const form = document.getElementById('registerForm');
const message = document.getElementById('registerMessage');
const button = document.getElementById('registerButton');
const togglePassword = document.getElementById('togglePassword');
const registerStep = document.getElementById('registerStep');
const doneStep = document.getElementById('doneStep');
const FIELDS = ['company', 'contact', 'phone', 'email', 'address', 'password', 'confirm'];

function showError(text, fieldName) {
  message.textContent = text;
  message.dataset.state = 'error';
  message.hidden = false;
  const input = fieldName && form.elements[fieldName];
  if (input) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }
}

function clearError() {
  message.textContent = '';
  message.hidden = true;
  delete message.dataset.state;
  for (const name of FIELDS) form.elements[name].removeAttribute('aria-invalid');
}

// One eye button shows or hides both password fields.
togglePassword.addEventListener('click', () => {
  const show = form.elements.password.type === 'password';
  for (const name of ['password', 'confirm']) form.elements[name].type = show ? 'text' : 'password';
  togglePassword.setAttribute('aria-label', show ? 'Hide passwords' : 'Show passwords');
  togglePassword.setAttribute('aria-pressed', String(show));
});

form.addEventListener('input', (event) => {
  if (event.target.getAttribute('aria-invalid')) clearError();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearError();
  const fields = Object.fromEntries(FIELDS.map((name) => [name, form.elements[name].value]));
  for (const name of FIELDS.slice(0, 5)) {
    if (!fields[name].trim()) {
      const label = form.querySelector(`label[for="${name}"]`).textContent.toLowerCase();
      return showError(`Enter your ${label} to continue.`, name);
    }
  }

  button.disabled = true;
  button.textContent = 'Submitting…';

  try {
    const res = await fetch('/api/catalog/access-requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company: fields.company.trim(),
        contact: fields.contact.trim(),
        phone: fields.phone.trim(),
        email: fields.email.trim(),
        address: fields.address.trim(),
      }),
    });

    const result = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(result.error || `Could not submit registration (${res.status}).`);
    }

    document.getElementById('doneCompany').textContent = fields.company;
    document.getElementById('donePhone').textContent = fields.phone;
    document.getElementById('doneSignIn').href = `/login.html?registered=${encodeURIComponent(fields.email || fields.phone)}`;
    registerStep.hidden = true;
    doneStep.hidden = false;
    document.title = 'Waiting for approval — Box for Less';
    window.scrollTo({ top: 0 });
    doneStep.focus();
  } catch (err) {
    showError(err.message || 'Registration failed. Please check your connection.');
  } finally {
    button.disabled = false;
    button.textContent = 'Create Account';
  }
});
