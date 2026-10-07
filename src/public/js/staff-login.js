const form = document.getElementById('staffLoginForm');
const button = document.getElementById('loginButton');
const error = document.getElementById('loginError');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.classList.add('hidden');
  button.disabled = true;
  try {
    const response = await fetch('/api/staff/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: form.elements.username.value,
        password: form.elements.password.value,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Sign in failed (${response.status}).`);
    const next = new URLSearchParams(location.search).get('next') || '/';
    location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/');
  } catch (e) {
    error.textContent = e.message;
    error.classList.remove('hidden');
    button.disabled = false;
  }
});
