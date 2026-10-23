// Step 2: turn each kept screenshot into a finished 1920x1080 video frame: the screen in a frame, who is acting,
// a short title, and the narration as a caption. Title, overview and closing frames are drawn here too.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, sleep } from './cdp.mjs';

const WORK = new URL('./work/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SLIDES = path.join(WORK, 'slides');
fs.rmSync(SLIDES, { recursive: true, force: true });
fs.mkdirSync(SLIDES, { recursive: true });
const shots = JSON.parse(fs.readFileSync(path.join(WORK, 'shots.json'), 'utf8'));

const COLOUR = { Customer: '#e4571a', 'Sales rep': '#1a5fd0', 'Sales Manager': '#2f7d4f', Warehouse: '#7b3fb0' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

const CSS = `
  * { box-sizing: border-box; margin: 0; }
  body { width: 1920px; height: 1080px; background: #14110e; color: #f6f4f0; font-family: "Segoe UI", Arial, sans-serif; position: relative; overflow: hidden; }
  .brand { position: absolute; left: 56px; top: 34px; font-size: 30px; font-weight: 700; letter-spacing: .02em; }
  .brand b { background: #e4571a; color: #fff; border-radius: 8px; padding: 2px 10px; margin-right: 12px; }
  .chip { position: absolute; right: 56px; top: 30px; padding: 8px 22px; border-radius: 999px; font-size: 26px; font-weight: 700; color: #fff; }
  .title { position: absolute; left: 0; right: 0; top: 18px; text-align: center; font-size: 30px; font-weight: 600; color: #d9d3c8; line-height: 1.25; }
  .title small { display: block; font-size: 23px; font-weight: 700; color: #e4571a; letter-spacing: .03em; }
  .chap { font-size: 28px; font-weight: 700; color: #e4571a; margin-bottom: 14px; letter-spacing: .02em; }
  .steps { list-style: none; margin: 46px 0 0; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 16px 40px; width: 1500px; text-align: left; }
  .steps li { display: flex; align-items: center; gap: 22px; background: #211d18; border-radius: 18px; padding: 18px 26px; font-size: 33px; }
  .steps b { flex: none; width: 58px; height: 58px; border-radius: 50%; background: #e4571a; color: #fff; display: grid; place-items: center; font-size: 32px; }
  .screen { position: absolute; border-radius: 14px; box-shadow: 0 18px 60px rgba(0,0,0,.55); background: #fff; overflow: hidden; }
  .screen img { display: block; width: 100%; height: 100%; }
  .caption { position: absolute; left: 240px; right: 240px; bottom: 28px; font-size: 29px; line-height: 1.38; color: #f6f4f0; text-align: center; }
  .side { position: absolute; left: 840px; right: 100px; top: 190px; }
  .side h2 { font-size: 54px; line-height: 1.12; margin-bottom: 30px; }
  .side p { font-size: 36px; line-height: 1.45; color: #e7e1d6; }
  .centre { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 0 160px; }
  .centre h1 { font-size: 92px; line-height: 1.05; margin-bottom: 34px; }
  .centre h1 span { color: #e4571a; }
  .centre p { font-size: 40px; line-height: 1.4; color: #d9d3c8; max-width: 1400px; }
  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 28px; margin-top: 50px; width: 1640px; }
  .card { background: #211d18; border-radius: 22px; padding: 30px 28px; text-align: left; border-top: 10px solid; min-height: 330px; }
  .card h3 { font-size: 38px; margin-bottom: 14px; }
  .card li { font-size: 27px; line-height: 1.4; color: #e7e1d6; margin: 0 0 8px 24px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 34px; margin-top: 44px; width: 1640px; text-align: left; }
  .col { background: #211d18; border-radius: 22px; padding: 28px 30px; }
  .col h3 { font-size: 36px; margin-bottom: 14px; color: #e4571a; }
  .col li { font-size: 27px; line-height: 1.4; color: #e7e1d6; margin: 0 0 8px 24px; }
`;

const page = (body) => `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>${body}</body>`;
const header = (s) => `<div class="brand"><b>BFL</b>Box for Less</div><div class="chip" style="background:${COLOUR[s.role] || '#555'}">${esc(s.role)}</div>`;

function html(s) {
  if (s.type === 'slide' && s.template === 'title') {
    return page(`<div class="centre"><h1>Box for Less<br><span>from the phone to the report</span></h1><p>One order, four roles, and every number connected. A walk through the whole workflow on sample data.</p></div>`);
  }
  if (s.type === 'slide' && s.template === 'story') {
    const steps = ['Set up the team', 'Discount stock close to expiry', 'The customer orders', 'Odoo handles the order', 'A rep visits a shop', 'Goods come back', 'The reports'];
    return page(`<div class="centre"><h1 style="font-size:64px;margin-bottom:0">One order, seven steps</h1><ol class="steps">${steps.map((t, i) => `<li><b>${i + 1}</b>${t}</li>`).join('')}</ol></div>`);
  }
  if (s.type === 'slide' && s.template === 'roles') {
    const card = (name, items) => `<div class="card" style="border-color:${COLOUR[name]}"><h3>${name}</h3><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`;
    return page(`<div class="centre"><h1 style="font-size:64px;margin-bottom:0">Four roles, one platform</h1><div class="cards">
      ${card('Customer', ['Signs in with the Odoo ID and a password', 'Sees own prices and discounted stock', 'Orders from the phone, follows every step', 'Sees own balance and invoices'])}
      ${card('Sales rep', ['Sees only own customers and shops', 'Visits shelves close to expiry', 'Offers the discount the manager set', 'Sees own month, nothing company-wide'])}
      ${card('Sales Manager', ['Sets customers, reps and credit limits', 'Puts discounts on near-expiry stock', 'Approves in Odoo, reads every report', 'Gets told when an agreement is broken'])}
      ${card('Warehouse', ['Watches stock and the expiry list', 'Records decisions on close-dated lots', 'Gives the reason for every return', 'Reads the warehouse report'])}
    </div></div>`);
  }
  if (s.type === 'slide' && s.template === 'closing') {
    return page(`<div class="centre"><h1 style="font-size:64px;margin-bottom:0">What is real, and what comes next</h1><div class="cols">
      <div class="col"><h3>Working now</h3><ul><li>Sign-in and roles, enforced on the server</li><li>Catalogue, prices and discounted offers</li><li>Orders, credit check, quotations</li><li>Shop visits, discounts, returns</li><li>Every monthly report</li></ul></div>
      <div class="col"><h3>Stand-in until Odoo</h3><ul><li>Stock, prices and customers are sample data</li><li>Sample Odoo plays approve, deliver, invoice, pay</li><li>Nothing is sent to any Odoo, or emailed</li></ul></div>
      <div class="col"><h3>Next</h3><ul><li>Connect Odoo: staging first, then live</li><li>An automatic test already walks this whole journey</li><li>Report emails, password recovery</li></ul></div>
    </div></div>`);
  }
  if (s.device === 'phone') {
    const h = 900; const w = Math.round(h * 390 / 844);
    return page(`${header(s)}<div class="screen" style="left:200px;top:150px;height:${h}px;width:${w}px;border-radius:44px;border:10px solid #2b2620"><img src="../raw/${s.file}"></div>
      <div class="side"><div class="chap">${esc(s.chapter || '')}</div><h2>${esc(s.title)}</h2><p>${esc(s.say)}</p></div>`);
  }
  return page(`${header(s)}<div class="title"><small>${esc(s.chapter || '')}</small>${esc(s.title)}</div><div class="screen" style="left:240px;top:96px;width:1440px;height:810px"><img src="../raw/${s.file}"></div><div class="caption">${esc(s.say)}</div>`);
}

const p = await launch(9334);
try {
  await p.init();
  await p.view(1920, 1080);
  for (const s of shots) {
    const f = path.join(SLIDES, `${String(s.id).padStart(2, '0')}.html`);
    fs.writeFileSync(f, html(s));
    await p.goto(pathToFileURL(f).href, 300);
    await p.waitFor(`[...document.images].every((i) => i.complete)`);
    await sleep(150);
    fs.writeFileSync(f.replace('.html', '.png'), await p.shot());
  }
} finally { await p.close(); }
console.log(`${shots.length} frames in demo-video/work/slides`);
