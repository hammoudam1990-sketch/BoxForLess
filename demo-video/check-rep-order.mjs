// Walk the rep's "New order" screens in a real browser on a phone-sized window: pick a customer, add products,
// review, place, then look at the order from the customer's side. Pictures go to demo-video/work/rep-order/.
// Run against a server with the demo data:  DEMO_BASE=http://127.0.0.1:3003 node demo-video/check-rep-order.mjs
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';
import { ACCOUNTS, BASE } from './accounts.mjs';

const OUT = path.join(new URL('./work/rep-order/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const p = await launch(9341);
const log = [];
const shot = async (name) => fs.writeFileSync(path.join(OUT, `${name}.png`), await p.shot());
const post = (url, body) => p.eval(`fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then((r) => r.status)`);
try {
  await p.init();
  await p.send('Runtime.enable');
  await p.view(390, 844, { mobile: true });

  await p.goto(`${BASE}/signin.html?switch=1`, 300);
  log.push(`rep sign-in: ${await post('/api/staff/login', { identifier: ACCOUNTS.rep.login, password: ACCOUNTS.rep.password })}`);
  await p.goto(`${BASE}/rep.html`, 1800);
  log.push(`tabs visible: ${await p.eval(`!document.querySelector('.rep-tabs').classList.contains('hidden')`)}`);
  await shot('01-visits-with-tabs');

  await p.click('.rep-tab', 'New order');
  await sleep(900);
  log.push(`customers: ${await p.eval(`[...document.querySelectorAll('.rep-shop-name')].map((e) => e.textContent).join(' | ')`)}`);
  await shot('02-customers');

  await p.click('.rep-shop');
  await sleep(1500);
  log.push(`order screen for: ${await p.eval(`document.querySelector('[aria-label=Order] h1').textContent`)}; products listed: ${await p.eval(`document.querySelectorAll('.rep-product').length`)}; offers: ${await p.eval(`document.querySelectorAll('.rep-offer').length`)}`);
  await shot('03-products');

  // add the first two products that can be ordered (3 cartons of the first)
  await p.eval(`(() => { const rows = [...document.querySelectorAll('.rep-product')].filter((r) => r.querySelector('.rep-add')); const q = rows[0].querySelector('input'); q.value = '3'; rows[0].querySelector('.rep-add').click(); rows[1].querySelector('.rep-add').click(); })()`);
  await sleep(400);
  log.push(`cart: ${await p.eval(`document.querySelector('.rep-cart').innerText.replace(/\\s+/g, ' ')`)}`);
  await shot('04-cart');

  await p.click('.rep-save', 'Review order');
  await sleep(1200);
  log.push(`review: ${await p.eval(`document.querySelector('[aria-label="Review order"]').innerText.replace(/\\s+/g, ' ').slice(0, 420)`)}`);
  await shot('05-review');

  await p.click('.rep-save', 'Place order');
  await sleep(1500);
  log.push(`placed: ${await p.eval(`document.querySelector('[aria-label="Order placed"]').innerText.replace(/\\s+/g, ' ')`)}`);
  await shot('06-done');

  await p.click('.rep-link', 'Back to my visits');
  await sleep(500);
  await p.click('.rep-tab', 'New order');
  await sleep(500);
  await p.click('.rep-link', 'Orders I have placed');
  await sleep(900);
  log.push(`my orders: ${await p.eval(`document.querySelector('[aria-label="Orders I placed"]').innerText.replace(/\\s+/g, ' ').slice(0, 200)`)}`);
  await shot('07-my-orders');

  // the customer's side
  await p.goto(`${BASE}/signin.html?switch=1`, 300);
  log.push(`customer sign-in: ${await post('/api/auth/customer/login', { id: ACCOUNTS.customer.login, password: ACCOUNTS.customer.password })}`);
  await p.view(1200, 800);
  await p.goto(`${BASE}/catalog?p=orders`, 2800);
  log.push(`customer orders page: ${await p.eval(`document.querySelectorAll('tbody tr').length`)} rows; first: ${await p.eval(`document.querySelector('tbody tr')?.innerText.replace(/\\s+/g, ' ').slice(0, 120)`)}`);
  await shot('08-customer-orders');
} catch (e) { log.push(`FAILED: ${e.message}`); } finally {
  console.log(log.join('\n'));
  await p.close();
}
