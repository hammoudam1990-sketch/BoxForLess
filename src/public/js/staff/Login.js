import { html, useState } from '../lib/react.js';
import { api } from '../api.js';

/** Where to go after signing in — only ever a path on this site. */
export function safeNext(search) {
  const next = new URLSearchParams(search).get('next') || '/';
  return next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function Login() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    // Read the fields from the form rather than from state: a password manager can
    // fill them without firing a change event, and the form always has the truth.
    const form = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      await api.staffLogin(form.get('username'), form.get('password'));
      window.location.assign(safeNext(window.location.search));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  };

  return html`
    <main class="staff-login-wrap">
      <form class="card staff-login-card" onSubmit=${submit}>
        <div class="logo staff-login-logo">BFL</div>
        <h1>Staff sign in</h1>
        <p class="muted">Sign in to manage products and customer requests.</p>
        <label for="username">Username</label>
        <input id="username" name="username" type="text" autoComplete="username" required />
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        ${error ? html`<p class="errbox" role="alert">${error}</p>` : null}
        <button type="submit" disabled=${busy}>Sign in</button>
      </form>
    </main>`;
}
