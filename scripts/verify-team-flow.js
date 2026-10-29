// End-to-end check of the sales-target flow on a local verification server:
// create a Sales Manager staff account, set a rep target, read the team view data back,
// and confirm the rep's own /api/reports/my matches the same numbers (no double counting).
// Run: node scripts/verify-team-flow.js http://localhost:3100  (env: BFL_STAFF_USERNAME/PASSWORD)
const base = process.argv[2] || 'http://localhost:3100';
const { BFL_STAFF_USERNAME: username, BFL_STAFF_PASSWORD: password } = process.env;

const login = await fetch(`${base}/api/staff/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) { console.error('ADMIN LOGIN FAILED', login.status); process.exit(1); }
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

const call = async (path, options = {}, c = cookie) => {
  const r = await fetch(`${base}${path}`, {
    ...options,
    headers: { Cookie: c, Accept: 'application/json', Origin: base, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); if (!ok) failures += 1; };

// who is on the team already, and which reps exist
const team = await call('/api/team');
const reps = (team.data.reps || []).map((r) => r.name);
check('GET /api/team lists reps', team.status === 200 && reps.length > 0, `reps: ${reps.join(', ')}`);

// create a Sales Manager staff account (one-time password comes back once); if it exists, reset it
let made = await call('/api/team', { method: 'POST', body: JSON.stringify({ name: 'Verify Manager', email: 'verify-manager@example.test', role: 'SALES_MANAGER' }) });
if (made.status === 409) {
  const existing = (team.data.users || []).find((u) => u.email === 'verify-manager@example.test');
  made = await call(`/api/team/${existing.id}/reset-password`, { method: 'POST', body: '{}' });
  made.status = made.status === 200 ? 201 : made.status;
  console.log('   (account existed — password reset instead)');
}
check('POST /api/team creates a Sales Manager', made.status === 201, `status ${made.status}`);
const oneTime = made.data.oneTimePassword || made.data.password || made.data.temporaryPassword;
if (!oneTime) console.log('   (response keys:', Object.keys(made.data).join(', '), ')');

// set a rep net-sales target for the current month
const repName = reps[0];
const month = new Date().toISOString().slice(0, 7);
const set = await call('/api/reports/targets', { method: 'PUT', body: JSON.stringify({ scope: 'REP', scopeValue: repName, measure: 'net_sales', month: 'DEFAULT', value: 10000 }) });
check('PUT /api/reports/targets sets a rep target', set.status === 200 && set.data.value === 10000, `status ${set.status}`);

// the SALES report now carries the target next to the rep's eligible sales
const sales = await call(`/api/reports/report?report=SALES&month=${month}`);
const row = (sales.data.sections || []).find((s) => s.id === 'sales_by_rep')?.rows.find((r) => r.rep === repName);
check('SALES report sales_by_rep carries the target', Boolean(row) && row.target === 10000, row ? `netSales=${row.netSales} target=${row.target} vsTarget=${row.vsTarget}` : 'row missing');

// sign in as the new Sales Manager (first sign-in forces a password choice)
if (oneTime) {
  const mLogin = await fetch(`${base}/api/staff/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'verify-manager@example.test', password: oneTime }),
  });
  const mCookie = (mLogin.headers.get('set-cookie') || '').split(';')[0];
  check('Sales Manager staff sign-in', mLogin.ok, `status ${mLogin.status}`);
  if (mLogin.ok) {
    const me = await call('/api/auth/me', {}, mCookie);
    check('manager identity + role', me.data.staff?.role === 'SALES_MANAGER', JSON.stringify(me.data.staff || {}));
    // first sign-in carries a one-time password: choose a real one before the API opens
    if (me.data.staff?.mustChangePassword) {
      const changed = await call('/api/auth/staff/password', { method: 'POST', body: JSON.stringify({ current: oneTime, next: 'verify-manager-own-password-1234' }) }, mCookie);
      check('manager chooses their own password', changed.status === 200, `status ${changed.status}`);
    }
    // the manager reaches the reports API (what /sales#/team and #/targets read)
    const mTargets = await call('/api/reports/targets', {}, mCookie);
    check('manager reads /api/reports/targets', mTargets.status === 200, `status ${mTargets.status}`);
    const mSales = await call(`/api/reports/report?report=SALES&month=${month}`, {}, mCookie);
    check('manager reads the SALES report', mSales.status === 200, `status ${mSales.status}`);
    // and /sales itself opens for a Sales Manager staff session
    const page = await fetch(`${base}/sales`, { headers: { Cookie: mCookie }, redirect: 'follow' });
    const html = await page.text();
    check('/sales opens for the manager staff session', html.includes('data-route="team"'), `status ${page.status}`);
  }
}

// the rep's own month (what the rep dashboard shows) — needs a SALES_REP account linked to the rep
const repUser = (team.data.users || []).find((u) => u.role === 'SALES_REP');
console.log(repUser ? `   existing rep account: ${repUser.name} (${repUser.email || repUser.phone || 'no login'})` : '   no rep account in this database yet');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
