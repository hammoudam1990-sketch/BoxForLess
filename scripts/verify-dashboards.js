// Local verification for the dashboard redesign: signs in as the dev administrator and checks
// every API the new Sales Manager / Rep / Warehouse screens read. Prints shapes, never secrets.
// Run: node scripts/verify-dashboards.js [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.argv[2] || 'http://localhost:3002';
let username = process.env.BFL_STAFF_USERNAME;
let password = process.env.BFL_STAFF_PASSWORD;
if (!username || !password) {
  const credsFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dev-admin.txt');
  const text = fs.readFileSync(credsFile, 'utf8');
  username = /^Username:\s*(\S+)/m.exec(text)[1];
  password = /^Password:\s*(\S+)/m.exec(text)[1];
}

const login = await fetch(`${base}/api/staff/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base },
  body: JSON.stringify({ username, password }),
});
if (!login.ok) { console.error('LOGIN FAILED', login.status, await login.text()); process.exit(1); }
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
console.log('login: OK (cookie length', cookie.length, ')');

const get = async (path) => {
  const r = await fetch(`${base}${path}`, { headers: { Cookie: cookie, Accept: 'application/json' } });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// reports start (months, reports, canSetTargets)
const start = await get('/api/reports');
check('GET /api/reports', start.status === 200 && Array.isArray(start.data.months), `status ${start.status}, months: ${(start.data.months || []).length}, reports: ${(start.data.reports || []).map((r) => r.key).join('/') || 'none'}, canSetTargets: ${start.data.canSetTargets}`);
const month = start.data.current;

// SALES report with the sales_by_rep section
const sales = await get(`/api/reports/report?report=SALES&month=${month}`);
const byRep = (sales.data.sections || []).find((s) => s.id === 'sales_by_rep');
check('GET /api/reports/report?report=SALES', sales.status === 200 && Boolean(byRep), `status ${sales.status}, sales_by_rep rows: ${byRep ? byRep.rows.length : 'missing'}`);
if (byRep?.rows?.length) console.log('   first row keys:', Object.keys(byRep.rows[0]).join(', '));

// CEO report measures (dashboard target panel)
const ceo = await get(`/api/reports/report?report=CEO&month=${month}`);
const netSales = (ceo.data.measures || []).find((m) => m.key === 'net_sales');
check('GET /api/reports/report?report=CEO', ceo.status === 200 && Boolean(netSales), `status ${ceo.status}, net_sales: thisMonth=${netSales?.thisMonth} target=${netSales?.target}`);

// targets list
const targets = await get('/api/reports/targets');
check('GET /api/reports/targets', targets.status === 200 && Array.isArray(targets.data.targets), `status ${targets.status}, targets: ${(targets.data.targets || []).length}, reps: ${(targets.data.reps || []).length}`);

// warehouse home counts
for (const [label, q] of [['active', ''], ['in stock', '&stock=in'], ['limited', '&stock=limited'], ['out', '&stock=out']]) {
  const r = await get(`/api/products?filter=active&limit=1${q}`);
  check(`GET /api/products (${label})`, r.status === 200 && Number.isFinite(r.data.total), `status ${r.status}, total=${r.data.total}`);
}
const expiry = await get('/api/expiry');
check('GET /api/expiry', expiry.status === 200 && Boolean(expiry.data.summary), `status ${expiry.status}, lots=${expiry.data.summary?.lots}, counts=${JSON.stringify(expiry.data.summary?.counts || {})}`);
const returns = await get('/api/returns');
check('GET /api/returns', returns.status === 200 && Boolean(returns.data.counts), `status ${returns.status}, unclassified=${returns.data.counts?.unclassified}`);
const imports = await get('/api/imports');
check('GET /api/imports', imports.status === 200 && Array.isArray(imports.data.items), `status ${imports.status}, items=${(imports.data.items || []).length}`);

// the pages carry the new design system and navigation
const page = async (p) => (await fetch(`${base}${p}`, { headers: { Cookie: cookie }, redirect: 'follow' })).text();
const salesHtml = await page('/sales');
check('/sales refuses the administrator (by design)', !salesHtml.includes('data-route="team"'));
const indexHtml = await page('/index.html');
check('/index.html loads dashboard-pro.css', indexHtml.includes('dashboard-pro.css'));
check('/index.html has Warehouse Home nav', indexHtml.includes('data-nav="warehouse"'));
check('/index.html has role element', indexHtml.includes('id="staffRole"'));
const repHtml = await page('/rep.html');
check('/rep.html loads dashboard-pro.css', repHtml.includes('dashboard-pro.css'));

// /sales needs the Sales Manager sign-in (the administrator's session does not open it, by design)
if (process.env.BFL_SALES_USERNAME) {
  const salesLogin = await fetch(`${base}/api/sales/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: process.env.BFL_SALES_USERNAME, password: process.env.BFL_SALES_PASSWORD }),
  });
  const salesCookie = (salesLogin.headers.get('set-cookie') || '').split(';')[0];
  check('POST /api/sales/login', salesLogin.ok, `status ${salesLogin.status}`);
  const salesPage = await (await fetch(`${base}/sales`, { headers: { Cookie: salesCookie }, redirect: 'follow' })).text();
  check('/sales loads dashboard-pro.css', salesPage.includes('dashboard-pro.css'));
  check('/sales has Team Performance nav', salesPage.includes('data-route="team"'));
  check('/sales has Sales Targets nav', salesPage.includes('data-route="targets"'));
} else {
  console.log('SKIP /sales page checks (no BFL_SALES_USERNAME set)');
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exitCode = failures ? 1 : 0;
