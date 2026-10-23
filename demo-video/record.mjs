// Step 1 of the demo video: drive the DEMO copy through the whole workflow in a headless browser and keep a
// screenshot of every moment worth showing, with the words that go over it. Writes demo-video/work/shots.json
// and demo-video/work/raw/*.png. Run the demo first (npm run demo); it is rebuilt clean by demo-video/reset-demo.ps1.
//
// The story has seven chapters, each shown as a step number on screen so a viewer always knows where they are:
//   1 Set up the team   2 Discount stock close to expiry   3 The customer orders   4 Odoo handles the order
//   5 A rep visits a shop   6 Goods come back   7 The reports
import fs from 'node:fs';
import path from 'node:path';
import { launch, sleep } from './cdp.mjs';
import { ACCOUNTS, BASE } from './accounts.mjs';

const WORK = new URL('./work/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const RAW = path.join(WORK, 'raw');
fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(RAW, { recursive: true });

const DESKTOP = [1600, 900];
const PHONE = [390, 844];
const LOT = 'SAMPLE-0022';          // UNICCA CHOCOLAT DARK 18G*24: near expiry, on a shelf at Baah & Sons
const PRODUCT = 'CHOCOLAT DARK';
const NORMAL = 'CLOVE POWDER';      // an ordinary product with no discount (ABIDO CLOVE POWDER 50G * 10)
const shots = [];
let n = 0;
let chapter = '';

const p = await launch();
let device = null;

async function setDevice(kind) {
  if (device === kind) return;
  device = kind;
  if (kind === 'phone') await p.view(PHONE[0], PHONE[1], { mobile: true, scale: 2 });
  else await p.view(DESKTOP[0], DESKTOP[1]);
}
const setChapter = (num, name) => { chapter = `Step ${num} of 7 · ${name}`; };

/** Dismiss the cookie notice if it is showing. */
const settle = async () => { await p.eval(`(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === 'OK, got it'); if (b) b.click(); })()`).catch(() => {}); await sleep(250); };

/** Keep a picture: who it is, a short title, and what the narrator says over it. */
async function keep({ role, title, say, kind = device }) {
  await settle();
  n += 1;
  const file = `${String(n).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(RAW, file), await p.shot());
  shots.push({ id: n, type: 'shot', device: kind, role, chapter, title, say, file });
  console.log(`  ${file}  ${role}: ${title}`);
}
function slide(template, say, extra = {}) {
  n += 1;
  shots.push({ id: n, type: 'slide', template, say, ...extra });
  console.log(`  ${String(n).padStart(2, '0')}      slide: ${template}`);
}

// Signing in is rate-limited (a few attempts per address, as it should be), so each person really signs in ONCE;
// the next time the video "is" that person, their saved session is put back.
const sessions = {};
const jar = async () => (await p.send('Network.getCookies', { urls: [BASE] })).cookies;
async function signInVia(who, submit) {
  if (sessions[who]) { await p.send('Network.setCookies', { cookies: sessions[who] }); return; }
  const before = new Map((await jar()).map((c) => [c.name, c.value]));
  await submit();
  sessions[who] = (await jar()).filter((c) => before.get(c.name) !== c.value)
    .map(({ name, value, domain, path: cp, httpOnly, secure, sameSite }) => ({ name, value, domain, path: cp, httpOnly, secure, sameSite }));
}

async function staffSignIn(who, { show = true, role }) {
  await setDevice('desktop');
  if (!show && sessions[who]) { await p.send('Network.setCookies', { cookies: sessions[who] }); return; }
  await p.goto(`${BASE}/signin.html?switch=1`);
  await p.click('#tabStaff');
  await p.type('#sId', ACCOUNTS[who].login);
  await p.type('#sPassword', ACCOUNTS[who].password);
  if (show) await keep({ role, title: 'Signing in', say: show });
  await signInVia(who, async () => {
    await p.click('#sSubmit');
    await p.waitFor(`location.pathname !== '/signin.html'`);
    await sleep(1200);
  });
}
async function customerSignIn(say) {
  await setDevice('phone');
  await p.goto(`${BASE}/signin.html?switch=1`);
  await p.type('#cId', ACCOUNTS.customer.login);
  await p.type('#cPassword', ACCOUNTS.customer.password);
  if (say) await keep({ role: 'Customer', title: 'Signing in with the Odoo ID', say });
  await p.click('#cSubmit');
  await p.waitFor(`location.pathname !== '/signin.html'`);
  await sleep(1200);
}
const staffPage = async (hash, wait) => {
  // a blank page first: going from one #/screen to another is not a reload, and the screen must be built for THIS person
  await p.goto('about:blank', 50);
  await p.goto(`${BASE}/index.html#/${hash}`, 1200);
  if (wait) await p.waitFor(wait);
  await sleep(500);
  if (process.env.DEBUG) console.log('   [as]', await p.eval(`fetch('/api/auth/me').then((r) => r.json()).then((j) => j.staff && j.staff.role)`), hash);
};
const rowOf = (text) => `[...document.querySelectorAll('tbody tr')].find((r) => r.innerText.includes(${JSON.stringify(text)}))`;
const setQty = (sel, qty) => p.eval(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); i.value = ${JSON.stringify(String(qty))}; i.dispatchEvent(new Event('blur')); })()`);

/** On Sample Odoo: choose what comes back, mark the form, keep a picture, then receive it and let Finance credit it. */
async function receiveReturn(text, { say, title }) {
  await staffPage('sample-odoo', `document.querySelector('select[aria-label="What is being returned"]')`);
  await p.eval(`(() => { const s = document.querySelector('select[aria-label="What is being returned"]'); const o = [...s.options].find((x) => x.textContent.includes('Demo Mini Mart') && x.textContent.includes(${JSON.stringify(text)})); s.value = o.value; s.dispatchEvent(new Event('change')); })()`);
  await p.mark('.controls', 'Receive return');
  await keep({ role: 'Sales Manager', title, say });
  await p.unmark();
  await p.click('button', 'Receive return into quarantine');
  await sleep(1200);
  await p.click('button', 'Issue credit note');
  await sleep(1200);
}
/** The warehouse says why it came back. */
async function classify(reason, { say, title } = {}) {
  await staffSignIn('warehouse', { role: 'Warehouse', show: false });
  await staffPage('returns', `document.querySelector('.ret-card')`);
  if (say) { await p.mark('.ret-card'); await keep({ role: 'Warehouse', title, say }); await p.unmark(); }
  await p.eval(`(() => { const s = document.querySelector('select[aria-label^="Reason for"]'); s.value = ${JSON.stringify(reason)}; s.dispatchEvent(new Event('change')); })()`);
  await p.click('.ret-card button', 'Save reason');
  await sleep(1200);
}

try {
  await p.init();

  // ------------------------------------------------------------------ opening
  slide('title', 'This is Box for Less. It takes a customer order from the customer’s phone all the way to the monthly report. The Sales Manager, the sales rep and the warehouse each work in their own screens. Everything you will see is sample data. Odoo is not connected yet, so a screen called Sample Odoo plays its part.');
  slide('roles', 'Four kinds of people use it. Customers order from their phone. The Sales Manager runs sales, discounts and approvals. Sales reps visit shops. And the warehouse watches stock and expiry dates. Each person sees only their own screens.');
  slide('story', 'We will follow one order in seven steps. First we set up the team. Then we put a discount on stock that is close to its expiry date. The customer orders it. Odoo handles the order. A rep visits a shop. Some goods come back. And at the end, it all appears in the reports.');

  // ------------------------------------------------------------------ 1 set up the team
  setChapter(1, 'Set up the team');
  await staffSignIn('manager', { role: 'Sales Manager', show: 'Everyone signs in with an email and a password. Let’s start as the Sales Manager.' });
  await staffPage('team', `document.querySelector('table')`);
  await keep({ role: 'Sales Manager', title: 'The team', say: 'The Sales Manager looks after the team. Here are the sales rep and the warehouse person. A manager can add reps. Only the administrator can add other managers.' });
  await staffPage('rep-customers', `document.querySelector('tbody tr')`);
  await p.eval(`(() => { const s = document.querySelectorAll('select')[1]; if (s) { s.value = [...s.options].find((o) => o.textContent === 'Rita Rep')?.value ?? s.value; s.dispatchEvent(new Event('change')); } })()`);
  await sleep(500);
  await keep({ role: 'Sales Manager', title: 'Each customer belongs to a rep', say: 'Every customer is given to one sales rep. Rita owns Demo Mini Mart and three shops. She will see only those, and nobody else’s.' });

  // ------------------------------------------------------------------ 2 discount stock close to expiry
  setChapter(2, 'Discount stock close to expiry');
  await staffSignIn('warehouse', { role: 'Warehouse', show: 'Now the warehouse person signs in.' });
  await staffPage('expiry', `document.querySelector('.exp-table tbody tr')`);
  await keep({ role: 'Warehouse', title: 'The expiry list', say: 'The warehouse sees every lot with its expiry date, how many days are left, and what it is worth. Lots that are close to their date need a decision.' });
  await p.mark('.exp-table tbody tr', LOT);
  await keep({ role: 'Warehouse', title: 'A lot close to expiry', say: 'This chocolate lot expires in about eighteen days. The warehouse can record what to do with it. But the customer discount is decided by the Sales Manager.' });
  await p.unmark();

  await staffSignIn('manager', { role: 'Sales Manager', show: false });
  await staffPage('expiry', `document.querySelector('.exp-table tbody tr')`);
  // for these two pictures only: hide the middle columns so the product, the lot and the discount fit side by side
  await p.eval(`(() => { const st = document.createElement('style'); st.textContent = '.exp-table th:nth-child(n+7):nth-child(-n+12), .exp-table td:nth-child(n+7):nth-child(-n+12) { display: none }'; document.head.appendChild(st); })()`);
  await p.eval(`(() => { const r = ${rowOf(LOT)}; const i = r.querySelector('.exp-disc-in'); i.scrollIntoView({ behavior: 'instant', block: 'center' }); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '30'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.mark('.exp-table tbody tr', LOT);
  await keep({ role: 'Sales Manager', title: 'Putting a discount on the lot', say: 'The Sales Manager types thirty percent for this lot, and presses Set. Only the Sales Manager can do this, and never more than ninety percent.' });
  await p.eval(`${rowOf(LOT)}.querySelector('.exp-disc button').click()`);
  await sleep(1200);
  await keep({ role: 'Sales Manager', title: 'The lot is on offer', say: 'It is saved, and the row now says it is on offer to customers. Let’s see what a customer sees.' });
  await p.unmark();

  // ------------------------------------------------------------------ 3 the customer orders
  setChapter(3, 'The customer orders');
  await customerSignIn('Customers sign in on their phone, with their Odoo customer I D and a password. This is Demo Mini Mart.');
  await p.goto(`${BASE}/catalog`, 1500);
  await p.waitFor(`document.querySelector('.c-offers:not(.hidden)')`, 12000);
  await keep({ role: 'Customer', title: 'The catalogue', say: 'The customer sees the catalogue with their own prices. At the top is a new section for discounted stock that is close to its date.' });
  await p.mark('.c-offer-card');
  await keep({ role: 'Customer', title: 'A discounted offer', say: 'Thirty percent off. They see the best before date, their normal price crossed out, how many cartons are on offer, and a clear note: discounted cartons cannot be returned. People who are not signed in see no prices and no offers.' });
  await p.unmark();
  await p.click('.c-offer-card .c-add');
  await sleep(500);
  await setQty('.c-offer-card .c-qty-input', 12);
  await sleep(700);
  await keep({ role: 'Customer', title: 'Twelve discounted cartons', say: 'They add twelve cartons of the discounted chocolate.' });
  await p.type('.c-search input', 'clove powder');
  await sleep(2200);
  await p.click('.c-card .c-add');
  await sleep(500);
  await setQty('.c-card .c-qty-input', 3);
  await sleep(700);
  await p.mark('.c-card', NORMAL);
  await keep({ role: 'Customer', title: 'An ordinary product too', say: 'They also search for an ordinary product, clove powder, and add three cartons at the normal price. We will come back to this one later.' });
  await p.unmark();
  await p.click('.c-tabbar .c-tab', 'My request');
  await p.waitFor(`document.querySelectorAll('.c-line-price').length >= 2 && [...document.querySelectorAll('.c-line-price')].every((e) => e.innerText.length > 4)`);
  await sleep(800);
  await keep({ role: 'Customer', title: 'My request', say: 'The request shows each line, the discounted price on the chocolate, and the total. When they send it, the server checks the stock and the credit limit again.' });
  await p.click('.c-drawer-actions .c-btn.primary', 'Submit');
  await p.waitFor(`document.querySelector('.c-okbox') && document.querySelector('.c-okbox').getBoundingClientRect().height > 0`, 12000);
  await sleep(600);
  await keep({ role: 'Customer', title: 'Request sent', say: 'The request is sent, and it gets a reference. Behind the scenes, a draft quotation with no price is queued for Odoo. Odoo works out the price, and a person approves it.' });
  await p.click('.c-okbox .c-btn', 'Follow my order');
  await sleep(1200);
  await keep({ role: 'Customer', title: 'My orders', say: 'My orders shows where the order is. It starts at Received.' });

  // ------------------------------------------------------------------ 4 Odoo handles the order
  setChapter(4, 'Odoo handles the order');
  await staffSignIn('manager', { role: 'Sales Manager', show: false });
  await staffPage('sample-odoo', `document.querySelector('table tbody tr')`);
  const orderBtn = async (label) => {
    await p.eval(`(() => { const r = [...document.querySelectorAll('tbody tr')].find((x) => x.innerText.includes('Demo Mini Mart') && [...x.querySelectorAll('button')].some((b) => b.innerText.includes(${JSON.stringify(label)}))); r.scrollIntoView({ behavior: 'instant', block: 'center' }); [...r.querySelectorAll('button')].find((b) => b.innerText.includes(${JSON.stringify(label)})).click(); })()`);
    await sleep(1100);
  };
  await p.eval(`(() => { const r = [...document.querySelectorAll('tbody tr')].find((x) => x.innerText.includes('Demo Mini Mart') && x.innerText.includes('Send quotation')); r?.scrollIntoView({ behavior: 'instant', block: 'center' }); })()`);
  await p.mark('tbody tr', 'Send quotation');
  await keep({ role: 'Sales Manager', title: 'The order arrives', say: 'On the Sample Odoo screen, the order is waiting. In the real system, these steps happen in Odoo, done by the person named on each button.' });
  await p.unmark();
  await orderBtn('Send quotation');
  await orderBtn('Confirm quotation');
  await p.mark('tbody tr', 'Validate delivery');
  await keep({ role: 'Sales Manager', title: 'Quotation sent and approved', say: 'The quotation goes to Odoo as a draft, and gets Odoo’s own number. Then the Sales Manager approves it. The discounted cartons are their own line, with the discount and the lot written on it.' });
  await p.unmark();
  await orderBtn('Validate delivery');
  await orderBtn('Post invoice');
  await p.mark('tbody tr', 'Record payment');
  await keep({ role: 'Sales Manager', title: 'Delivered and invoiced', say: 'The warehouse validates the delivery after loading the truck. Then Finance posts the invoice, with the discount on it.' });
  await p.unmark();

  await customerSignIn(false);
  await p.goto(`${BASE}/catalog`, 1500);
  await p.click('button', 'My orders');
  await sleep(1200);
  await keep({ role: 'Customer', title: 'The order moved on', say: 'Back on the customer’s phone. The order now says Invoiced, with Odoo’s number. Every change in Odoo shows up here by itself.' });
  await p.goto(`${BASE}/catalog`, 1200);
  await p.click('button', 'My balance');
  await sleep(1200);
  await keep({ role: 'Customer', title: 'My balance', say: 'My balance shows what the customer owes, their credit limit, and the invoice with its pay-by day. Reminders go out before that day.' });

  // ------------------------------------------------------------------ 5 a rep visits a shop
  setChapter(5, 'A rep visits a shop');
  await staffSignIn('manager', { role: 'Sales Manager', show: false });
  await staffPage('approvals', `document.querySelector('.exp-table tbody tr')`);
  await p.eval(`(() => { const r = ${rowOf(LOT)}; const i = r.querySelector('.exp-disc-in'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, '20'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await p.mark('.exp-table tbody tr', LOT);
  await keep({ role: 'Sales Manager', title: 'A discount for stock on a shop shelf', say: 'Some of this chocolate is already on a shop shelf. The Sales Manager puts twenty percent on it, so the rep can offer it at the next visit.' });
  await p.eval(`${rowOf(LOT)}.querySelector('.exp-disc button').click()`);
  await sleep(1000);
  await p.unmark();

  await setDevice('phone');
  await p.goto(`${BASE}/signin.html?switch=1`);
  await p.click('#tabStaff');
  await p.type('#sId', ACCOUNTS.rep.login);
  await p.type('#sPassword', ACCOUNTS.rep.password);
  await keep({ role: 'Sales rep', title: 'The rep signs in', say: 'The sales rep signs in on a phone, and lands on a page made for visiting shops.' });
  await signInVia('rep', async () => { await p.click('#sSubmit'); await p.waitFor(`location.pathname === '/rep.html'`); });
  await p.goto(`${BASE}/rep.html`, 1500);
  await keep({ role: 'Sales rep', title: 'My visits', say: 'Rita sees only her own shops, with the lots that are close to their expiry date. Below that is her own month, and never company figures.' });
  await p.click('.rep-shop', 'Baah');
  await sleep(1200);
  await p.mark('.rep-lot', 'CHOCOLAT');
  await keep({ role: 'Sales rep', title: 'At the shop', say: 'At this shop, the chocolate shows the twenty percent that the Sales Manager set. The rep checks the shelf and records what she finds.' });
  await p.unmark();
  await p.eval(`(() => { const a = [...document.querySelectorAll('.rep-lot')].find((x) => x.innerText.includes('CHOCOLAT')); a.querySelector('input[value=DISCOUNT_AGREED]').click(); })()`);
  await sleep(500);
  await p.eval(`(() => { const a = [...document.querySelectorAll('.rep-lot')].find((x) => x.innerText.includes('CHOCOLAT')); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const c = a.querySelector('input[id^=cn-]'); set.call(c, 'Ama Mensah'); c.dispatchEvent(new Event('input', { bubbles: true })); a.querySelector('input[id^=ag-]').click(); a.scrollIntoView({ behavior: 'instant', block: 'start' }); })()`);
  await sleep(500);
  await p.mark('.rep-lot', 'CHOCOLAT');
  await keep({ role: 'Sales rep', title: 'The customer agrees', say: 'The shop’s contact agrees to the discount, and confirms the lot will not be returned. Twenty percent is already filled in, so the rep types nothing else.' });
  await p.unmark();
  await p.click('.rep-save');
  await sleep(1200);
  await keep({ role: 'Sales rep', title: 'Visit saved', say: 'Saved. It is within what the Sales Manager already offered, so it is approved at once. If the rep offered more, it would wait for the Sales Manager.' });

  await staffSignIn('manager', { role: 'Sales Manager', show: false });
  await staffPage('approvals', `document.querySelector('.appr-item')`);
  await p.mark('.appr-item');
  await keep({ role: 'Sales Manager', title: 'A credit note for Finance', say: 'The approved discount becomes a task for Finance. Finance issues the credit note in Odoo, and the number is recorded here to close the alert.' });
  await p.unmark();
  await p.type('.appr-item input', 'CN/DEMO/1');
  await p.click('.appr-item button', 'Credit note issued');
  await sleep(1200);
  await keep({ role: 'Sales Manager', title: 'Alert closed', say: 'The credit note is recorded, and the alert is closed.' });

  // ------------------------------------------------------------------ 6 goods come back
  setChapter(6, 'Goods come back');
  await receiveReturn(NORMAL, {
    title: 'An ordinary return',
    say: 'Now some goods come back. First, one carton of the ordinary clove powder, which the customer bought at the normal price. The warehouse receives it into quarantine in Odoo.',
  });
  await classify('DAMAGED', {
    title: 'The warehouse gives the reason',
    say: 'The warehouse has to say why it came back, within three days. Damaged, expired, or another reason. Here it is damaged.',
  });
  await staffSignIn('manager', { role: 'Sales Manager', show: false });
  await staffPage('returns', `document.querySelector('.exp-tile')`);
  await p.mark('.exp-tiles');
  await keep({ role: 'Sales Manager', title: 'Nothing is wrong', say: 'This is a normal return. Agreements broken stays at zero, because the customer was free to return an ordinary product.' });
  await p.unmark();
  await receiveReturn(PRODUCT, {
    title: 'A discounted carton comes back',
    say: 'Now something that should not happen. One carton of the discounted chocolate comes back. The customer was told that discounted cartons cannot be returned.',
  });
  await classify('EXPIRED');
  await staffSignIn('manager', { role: 'Sales Manager', show: false });
  await staffPage('returns', `document.querySelector('.exp-tile')`);
  await p.mark('.card', 'Agreements broken');
  await keep({ role: 'Sales Manager', title: 'Agreement broken', say: 'The Sales Manager is told at once. The return is flagged as a broken agreement, with the discount, the lot, and the credit note that was already given.' });
  await p.unmark();

  // ------------------------------------------------------------------ 7 the reports
  setChapter(7, 'The reports');
  await staffPage('reports', `document.querySelector('[role=tab]')`);
  await p.eval(`(() => { const s = document.querySelector('select[aria-label="Month"]'); const o = [...s.options].find((x) => x.textContent.includes('so far')); s.value = o.value; s.dispatchEvent(new Event('change')); })()`);
  await sleep(1800);
  await keep({ role: 'Sales Manager', title: 'The CEO summary', say: 'Everything now lands in the monthly reports. The CEO summary has twelve measures, like net sales, money collected, money owed, and expiry loss. Each one is compared with last month and last year. The figures match the ledger exactly.' });
  await p.click('[role=tab]', 'Sales Manager report');
  await sleep(1800);
  await keep({ role: 'Sales Manager', title: 'Sales by rep', say: 'The Sales Manager report has lists to act on. Sales by rep shows Rita’s net sales, after the credit notes on her customer and her shops, and her shop visits.' });
  await p.eval(`(() => { const h = [...document.querySelectorAll('h2, h3')].find((x) => /Price classes/.test(x.innerText)); h?.scrollIntoView({ behavior: 'instant', block: 'start' }); })()`);
  await sleep(700);
  await keep({ role: 'Sales Manager', title: 'Discounts given', say: 'Further down, you can see the discounts given. The thirty percent on the chocolate is counted here, and in the expiry loss on the summary.' });
  await p.click('[role=tab]', 'Warehouse report');
  await sleep(1800);
  await p.eval(`(() => { const h = [...document.querySelectorAll('h2, h3')].find((x) => /Clearance results/.test(x.innerText)); h?.scrollIntoView({ behavior: 'instant', block: 'start' }); })()`);
  await sleep(700);
  await keep({ role: 'Sales Manager', title: 'Clearance results', say: 'The warehouse report shows the discounted lot: the discount, how many cartons sold at that price, and the discount given. Further down are shop visits, returns, and fulfilment.' });

  await setDevice('phone');
  await p.send('Network.setCookies', { cookies: sessions.rep });
  await p.goto(`${BASE}/rep.html`, 1500);
  await p.eval(`(() => { const h = [...document.querySelectorAll('h1, h2')].find((x) => /My month/.test(x.innerText)); h?.scrollIntoView({ behavior: 'instant', block: 'start' }); })()`);
  await sleep(700);
  await keep({ role: 'Sales rep', title: 'The rep’s own month', say: 'And the rep sees her own month: her sales, her customers, and customers who have gone quiet. It agrees with the Sales Manager’s report, and shows nothing about anyone else.' });

  slide('closing', 'That is the whole workflow, from the customer’s phone to the monthly report, and every figure agrees along the way. An automatic test walks this same journey and checks every number. What is left is to connect the real Odoo. Then the sample data is replaced with the real thing.');
} finally {
  fs.writeFileSync(path.join(WORK, 'shots.json'), JSON.stringify(shots, null, 1));
  await p.close();
}
console.log(`\n${shots.length} scenes kept.`);
