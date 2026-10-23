// A one-page launch pad for the demo: four cards (customer, sales rep, Sales Manager, warehouse), each with the page to
// open and its sign-in, written to data/demo-launchpad.html from data/demo-accounts.txt. Open that file in a browser.
//
// Why different addresses: the browser keeps ONE staff session per address, so the manager, the warehouse person and the
// rep cannot all be signed in at the same address in one browser. localhost, 127.0.0.1 and this computer's Wi-Fi address are
// three different addresses for the same demo, so three staff members can be signed in side by side. (The customer uses a
// different cookie, so it can share one of them, or be opened on a phone.)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNTS = path.join(ROOT, 'data', 'demo-accounts.txt');
const OUT = path.join(ROOT, 'data', 'demo-launchpad.html');
const PORT = Number(process.env.DEMO_PORT || 3001);

export function writeLaunchpad() {
  if (!fs.existsSync(ACCOUNTS)) throw new Error('Run "npm run demo" first: there are no demo accounts yet.');
  const txt = fs.readFileSync(ACCOUNTS, 'utf8');
  const pw = (login) => { const m = new RegExp(`${login.replace(/[.@]/g, '\\$&')}\\s+(\\S+)`).exec(txt); if (!m) throw new Error(`No demo password for ${login}`); return m[1]; };
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

  const cards = [
    { role: 'Customer', who: 'Demo Mini Mart', open: `http://${lan || 'localhost'}:${PORT}/`, host: lan ? 'Wi-Fi address (or a phone)' : 'localhost', tab: 'Customer tab', label: 'Customer ID', login: '7001', password: pw('Odoo ID 7001'), colour: '#e4571a', note: 'Best on a phone, or a phone-sized window. Sign in on the first tab, "Customer".' },
    { role: 'Sales rep', who: 'Rita Rep', open: `http://${lan || 'localhost'}:${PORT}/`, host: lan ? 'Wi-Fi address (or a phone)' : 'localhost', tab: 'Staff tab', label: 'Email', login: 'rep@demo.bfl.test', password: pw('rep@demo.bfl.test'), colour: '#1a5fd0', note: 'Lands on the shop-visit page. Sign in on the second tab, "Staff".' },
    { role: 'Sales Manager', who: 'Demo Sales Manager', open: `http://localhost:${PORT}/`, host: 'localhost', tab: 'Staff tab', label: 'Email', login: 'manager@demo.bfl.test', password: pw('manager@demo.bfl.test'), colour: '#2f7d4f', note: 'The main staff screens. Sign in on the second tab, "Staff".' },
    { role: 'Warehouse', who: 'Wanda Warehouse', open: `http://127.0.0.1:${PORT}/`, host: '127.0.0.1', tab: 'Staff tab', label: 'Email', login: 'warehouse@demo.bfl.test', password: pw('warehouse@demo.bfl.test'), colour: '#7b3fb0', note: 'Stock, expiry and returns. Sign in on the second tab, "Staff".' },
  ];
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Box for Less demo launch pad</title>
<style>
  body { margin: 0; font: 18px/1.45 "Segoe UI", Arial, sans-serif; background: #f6f4f0; color: #1a1612; }
  main { max-width: 1100px; margin: 0 auto; padding: 28px 16px 60px; }
  h1 { font-size: 30px; margin: 0 0 6px; } .sub { color: #57524b; margin: 0 0 22px; }
  .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); }
  .card { background: #fff; border-radius: 20px; padding: 22px; border-top: 10px solid var(--c); box-shadow: 0 4px 18px rgba(0,0,0,.07); }
  .card h2 { margin: 0; font-size: 26px; } .card .who { color: #57524b; margin-bottom: 12px; }
  .open { display: inline-block; background: var(--c); color: #fff; text-decoration: none; font-weight: 700; padding: 11px 20px; border-radius: 12px; margin: 4px 0 14px; }
  .row { display: flex; align-items: center; gap: 10px; margin: 6px 0; } .row b { width: 110px; flex: none; color: #57524b; font-weight: 600; }
  code { background: #f1eee8; padding: 5px 10px; border-radius: 8px; font-size: 18px; word-break: break-all; }
  button { font: inherit; padding: 5px 12px; border-radius: 9px; border: 1px solid #1a1612; background: #fff; cursor: pointer; }
  .note { color: #57524b; font-size: 16px; margin-top: 10px; }
  .tip { background: #fbefd0; border-radius: 14px; padding: 14px 18px; margin: 0 0 22px; font-size: 17px; }
</style>
<main>
  <h1>Box for Less — demo launch pad</h1>
  <p class="sub">Four pages for the four people in the demo. Sample data only; this file stays on this computer and is never committed.</p>
  <div class="tip"><b>Open each card's link in its own window.</b> The browser keeps one staff sign-in per address, so the cards use different addresses
    (localhost, 127.0.0.1 and the Wi-Fi address). That lets the manager, the warehouse and the rep be signed in side by side. For the customer and rep, a phone on the same Wi-Fi is best.</div>
  <div class="grid">
${cards.map((c) => `    <section class="card" style="--c:${c.colour}">
      <h2>${esc(c.role)}</h2><div class="who">${esc(c.who)}</div>
      <a class="open" href="${esc(c.open)}" target="_blank" rel="noopener">Open ${esc(c.open)}</a>
      <div class="row"><b>${esc(c.label)}</b><code>${esc(c.login)}</code><button type="button" data-copy="${esc(c.login)}">Copy</button></div>
      <div class="row"><b>Password</b><code>${esc(c.password)}</code><button type="button" data-copy="${esc(c.password)}">Copy</button></div>
      <div class="note">Address: ${esc(c.host)}. ${esc(c.note)}</div>
    </section>`).join('\n')}
  </div>
</main>
<script>
  document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
    setTimeout(() => { b.textContent = 'Copy'; }, 1500);
  }));
</script></html>`;
  fs.writeFileSync(OUT, html);
  return OUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Launch pad: ${writeLaunchpad()}`);
