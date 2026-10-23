// Look at what is on a demo page (visible buttons, links, headings) so the video script can aim at them.
import { launch } from './cdp.mjs';
import { ACCOUNTS, BASE } from './accounts.mjs';

const [, , role, url, w = '1600', h = '900', mobile = ''] = process.argv;
const p = await launch();
try {
  await p.init();
  await p.view(Number(w), Number(h), { mobile: Boolean(mobile), scale: mobile ? 2 : 1 });
  await p.goto(`${BASE}/signin.html`);
  const a = ACCOUNTS[role];
  const isCustomer = role === 'customer';
  await p.eval(`fetch(${JSON.stringify(isCustomer ? '/api/auth/customer/login' : '/api/staff/login')}, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(isCustomer ? { id: a.login, password: a.password } : { identifier: a.login, password: a.password })}) }).then((r) => r.status)`);
  await p.goto(BASE + url, 1500);
  const out = await p.eval(`(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const pick = (sel) => [...document.querySelectorAll(sel)].filter(vis).map((e) => (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 60)).filter(Boolean);
    return { h1: pick('h1, h2').slice(0, 14), buttons: pick('button').slice(0, 40), links: pick('a').slice(0, 30), tabs: pick('[role=tab]') };
  })()`);
  console.log(JSON.stringify(out, null, 1));
} finally { await p.close(); }
