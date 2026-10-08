window.__bflBooted = true; // tells js/boot-guard.js the page started

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
    // only ever a path on this site; the default is the staff app (/ is the front door)
    const next = new URLSearchParams(location.search).get('next') || '/index.html';
    location.assign(next.startsWith('/') && !next.startsWith('//') ? next : '/index.html');
  } catch (e) {
    error.textContent = e.message;
    error.classList.remove('hidden');
    button.disabled = false;
  }
});
