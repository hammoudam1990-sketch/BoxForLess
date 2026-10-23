// Staff screen: Team — who can sign in to the staff area, and as what.
//
// The administrator can add any kind of account; a Sales Manager can add sales reps only (the server
// enforces it, this screen just offers what is allowed). A new person gets a ONE-TIME password, shown
// here once; they sign in with their email or phone number and are asked to choose their own.
//
// Built once: the form's fields are created a single time and only the list and the one-time-password
// panel around them change, so nothing being typed is ever rebuilt.
import { api, toast } from './api.js';
import { h, setChildren, toggleHidden } from './lib/dom.js';

const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');

async function copy(text, button) {
  const original = button.textContent;
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); ok = true; }
  } catch { /* fall through */ }
  if (!ok) {
    const ta = h('textarea', { readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  button.textContent = ok ? '✓ Copied' : 'Select it by hand';
  setTimeout(() => { button.textContent = original; }, 1500);
}

export async function renderTeam(view) {
  let data = await api.team();

  // ---- the add form (built once) -------------------------------------------------------------
  const name = h('input', { id: 'tName', type: 'text', autocomplete: 'off', maxlength: '120', placeholder: 'Full name' });
  const email = h('input', { id: 'tEmail', type: 'email', autocomplete: 'off', inputmode: 'email', maxlength: '120', placeholder: 'name@company.com' });
  const phone = h('input', { id: 'tPhone', type: 'tel', autocomplete: 'off', inputmode: 'tel', maxlength: '40', placeholder: '024 123 4567' });
  const role = h('select', { id: 'tRole', 'aria-label': 'Role', onChange: syncRole });
  const rep = h('select', { id: 'tRep', 'aria-label': 'Which sales rep' });
  const repField = h('label', { class: 'team-field' }, h('span', { class: 'muted' }, 'Which sales rep'), rep);
  const addBtn = h('button', { type: 'button', onClick: add }, 'Add person');
  const problem = h('p', { class: 'reg-problem', role: 'status' });

  const field = (label, input, hint) => h('label', { class: 'team-field' }, h('span', { class: 'muted' }, label), input, hint ? h('span', { class: 'muted team-hint' }, hint) : null);
  const form = h('div', { class: 'card' },
    h('h2', null, 'Add a person'),
    h('p', { class: 'muted' }, 'They sign in with an email address or a phone number — give at least one — and a password. You get a one-time password to hand to them; they choose their own the first time.'),
    h('div', { class: 'team-grid' },
      field('Name', name), field('Role', role), repField,
      field('Email', email), field('Phone number', phone)),
    problem,
    h('div', { class: 'controls' }, addBtn));

  const result = h('div', { class: 'hidden' });
  const tbody = h('tbody');
  const empty = h('p', { class: 'muted hidden' }, 'No one has been added yet.');

  setChildren(view,
    h('h1', null, 'Team'),
    form, result,
    h('div', { class: 'card' },
      h('h2', null, 'People'),
      h('div', { class: 'exp-wrap' },
        h('table', null,
          h('thead', null, h('tr', null, ['Name', 'Role', 'Signs in with', 'Last sign-in', 'Status', ''].map((t) => h('th', null, t)))),
          tbody)),
      empty,
      h('p', { class: 'muted' }, 'Switching someone off ends their access at once; everything they did is kept. Your own administrator login is set on the server and is not listed here.')));

  function syncRole() {
    toggleHidden(repField, role.value !== 'SALES_REP');
  }

  function paintOptions() {
    setChildren(role, data.roles.map((r) => h('option', { value: r.role }, r.label)));
    setChildren(rep, [h('option', { value: 'NEW' }, 'A new rep (give them customers afterwards)'), ...data.reps.filter((r) => r.sample).map((r) => h('option', { value: r.id }, r.name))]);
    syncRole();
  }

  function paintList() {
    setChildren(tbody, data.users.map((u) => h('tr', null,
      h('td', null, h('b', null, u.name)),
      h('td', null, u.roleLabel, u.repId ? h('div', { class: 'muted' }, (data.reps.find((r) => r.id === u.repId) || {}).name || '') : null),
      h('td', null, u.email || '—', u.phone ? h('div', { class: 'muted' }, u.phone) : null),
      h('td', { class: 'muted' }, u.mustChangePassword ? 'has not signed in yet' : when(u.lastLoginAt)),
      h('td', null, h('span', { class: 'badge' }, u.active ? 'Active' : 'Switched off')),
      h('td', { class: 'nowrap' },
        u.active ? h('button', { type: 'button', class: 'secondary', onClick: () => reset(u) }, 'Reset password') : null,
        h('button', { type: 'button', class: u.active ? 'danger' : 'secondary', onClick: () => toggle(u) }, u.active ? 'Switch off' : 'Switch on')))));
    toggleHidden(empty, data.users.length > 0);
  }

  async function refresh() {
    data = await api.team();
    paintList();
  }

  function showPassword(user, temporaryPassword, headline) {
    const sentence = `Sign in at ${location.origin}/ on the Staff tab with ${user.email || user.phone}. Your one-time password is ${temporaryPassword} — you will be asked to choose your own.`;
    const copyPw = h('button', { type: 'button', class: 'secondary' }, 'Copy password');
    const copyMsg = h('button', { type: 'button' }, 'Copy message');
    copyPw.addEventListener('click', () => copy(temporaryPassword, copyPw));
    copyMsg.addEventListener('click', () => copy(sentence, copyMsg));
    setChildren(result,
      h('div', { class: 'okbox' }, headline),
      h('p', { class: 'muted' }, `For ${user.name}. This password is shown once — it cannot be looked up later. If it is lost, reset it.`),
      h('p', { class: 'code code-large' }, temporaryPassword),
      h('div', { class: 'controls' }, copyPw, copyMsg,
        h('button', { type: 'button', class: 'ghost', onClick: () => toggleHidden(result, true) }, 'Done')));
    result.className = 'card';
    result.scrollIntoView?.({ block: 'nearest' });
  }

  async function add() {
    problem.textContent = '';
    if (!name.value.trim()) { problem.textContent = 'Please give their name.'; return; }
    if (!email.value.trim() && !phone.value.trim()) { problem.textContent = 'Give an email address or a phone number.'; return; }
    addBtn.disabled = true;
    try {
      const r = await api.createTeamUser({
        name: name.value.trim(), email: email.value.trim(), phone: phone.value.trim(), role: role.value,
        repId: role.value === 'SALES_REP' ? rep.value : undefined,
      });
      name.value = ''; email.value = ''; phone.value = ''; rep.value = 'NEW';
      showPassword(r.user, r.temporaryPassword, `Added ${r.user.name} as ${r.user.roleLabel}`);
      await refresh();
    } catch (e) { problem.textContent = e.message; } finally { addBtn.disabled = false; }
  }

  async function reset(u) {
    if (!window.confirm(`Reset the password for ${u.name}?\n\nTheir current password stops working and they must choose a new one.`)) return;
    try {
      const r = await api.resetTeamPassword(u.id);
      showPassword(r.user, r.temporaryPassword, `New one-time password for ${r.user.name}`);
      await refresh();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function toggle(u) {
    if (u.active && !window.confirm(`Switch off ${u.name}? They are signed out at once and cannot sign in.`)) return;
    try { await api.setTeamActive(u.id, !u.active); await refresh(); } catch (e) { toast(e.message, 'err'); }
  }

  paintOptions();
  paintList();
}
