// Look at the merged app in a real browser: the customer catalogue (their new design with our server data), the account
// pages, the staff app, and the two team dashboards. Pictures go to demo-video/work/merge/.
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';
import { ACCOUNTS, BASE } from './accounts.mjs';

const OUT = path.join(new URL('./work/merge/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const p = await launch(9339);
const log = [];
const errors = [];
const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), await p.shot());
async function login(kind, who) {
  await p.goto(`${BASE}/signin.html?switch=1`, 300);
  const a = ACCOUNTS[who];
  const url = kind === 'customer' ? '/api/auth/customer/login' : '/api/staff/login';
  const body = kind === 'customer' ? { id: a.login, password: a.password } : { identifier: a.login, password: a.password };
  const st = await p.eval(`fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then((r) => r.status)`);
  log.push(`${who} sign-in: ${st}`);
}
try {
  await p.init();
  await p.send('Runtime.enable');
  await p.view(1440, 900);

  // a visitor sees the shell but no prices
  await p.goto(`${BASE}/catalog`, 2500);
  log.push(`visitor catalogue title: ${await p.eval('document.title')}`);
  log.push(`visitor sees a price: ${await p.eval(`Boolean(document.querySelector('.p-price:not(.hidden)'))`)} | offers section: ${await p.eval(`Boolean(document.querySelector('.c-offers:not(.hidden)'))`)}`);
  await shot('01-visitor-home');

  // the Sales Manager sets a discount so there is an offer to see
  await login('staff', 'manager');
  const lot = await p.eval(`fetch('/api/expiry').then((r) => r.json()).then((d) => d.rows.find((x) => x.lotName === 'SAMPLE-0022').key)`);
  log.push(`discount set: ${await p.eval(`fetch('/api/expiry/lots/' + encodeURIComponent(${JSON.stringify(lot)}) + '/discount', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pct: 30 }) }).then((r) => r.status)`)}`);

  // the customer
  await login('customer', 'customer');
  await p.goto(`${BASE}/catalog`, 3000);
  log.push(`customer home: header says "${await p.eval(`document.querySelector('.p-user-name')?.innerText`)}"`);
  log.push(`offers section visible: ${await p.eval(`Boolean(document.querySelector('.c-offers:not(.hidden)'))`)} | offer cards: ${await p.eval(`document.querySelectorAll('.c-offer-card').length`)}`);
  log.push(`account column: ${await p.eval(`document.querySelector('.p-account')?.innerText.replace(/\\s+/g, ' ').slice(0, 160)`)}`);
  await shot('02-customer-home');
  await p.goto(`${BASE}/catalog?p=products`, 3500);
  log.push(`products: price lines ${await p.eval(`document.querySelectorAll('.p-price:not(.hidden)').length`)}, offer lines ${await p.eval(`document.querySelectorAll('.c-offer:not(.hidden)').length`)}`);
  await shot('03-customer-products');
  for (const pg of ['orders', 'balance', 'invoices', 'settings']) {
    await p.goto(`${BASE}/catalog?p=${pg}`, 2500);
    log.push(`${pg}: "${await p.eval(`document.querySelector('h1')?.innerText`)}" rows=${await p.eval(`document.querySelectorAll('tbody tr').length`)}`);
    await shot(`04-customer-${pg}`);
  }
  // an order from the drawer, then the Orders page
  await p.goto(`${BASE}/catalog?p=products`, 3000);

  // staff app as the Sales Manager
  await login('staff', 'manager');
  await p.goto(`${BASE}/index.html#/expiry`, 2500);
  log.push(`staff app title: ${await p.eval('document.title')} | user: ${await p.eval(`document.getElementById('staffName')?.innerText`)}`);
  log.push(`visible nav: ${await p.eval(`[...document.querySelectorAll('[data-nav]:not(.hidden)')].map((a) => a.dataset.nav).join(',')`)}`);
  log.push(`visible headings: ${await p.eval(`[...document.querySelectorAll('.adm-label:not(.hidden)')].map((a) => a.innerText).join(' | ')`)}`);
  await shot('05-staff-manager-expiry');
  await p.goto(`${BASE}/sales`, 2500);
  log.push(`/sales as manager: ${await p.eval('location.pathname')} "${await p.eval(`document.querySelector('h1')?.innerText`)}"`);
  await shot('06-sales-dashboard');

  // admin cannot open /sales, rep opens /rep
  await login('staff', 'rep');
  await p.goto(`${BASE}/rep`, 2500);
  log.push(`/rep as rep: ${await p.eval('location.pathname')} "${await p.eval(`document.title`)}"`);
  await shot('07-rep-app-theirs');
  await p.goto(`${BASE}/rep.html`, 2500);
  log.push(`/rep.html as rep: ${await p.eval('location.pathname')} "${await p.eval(`document.title`)}"`);
  await shot('08-rep-page-ours');
} catch (e) { log.push(`FAILED: ${e.message}`); } finally {
  console.log(log.join('\n'));
  await p.close();
}
