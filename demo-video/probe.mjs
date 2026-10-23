// Can three staff members be signed in side by side at three addresses of the same demo?
import { launch } from './cdp.mjs';
import { ACCOUNTS } from './accounts.mjs';

const hosts = { manager: 'http://localhost:3001', warehouse: 'http://127.0.0.1:3001', rep: 'http://192.168.100.8:3001' };
const p = await launch(9336);
try {
  await p.init();
  for (const [who, base] of Object.entries(hosts)) {
    await p.goto(`${base}/signin.html`, 300);
    const st = await p.eval(`fetch('/api/staff/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: ${JSON.stringify(ACCOUNTS[who].login)}, password: ${JSON.stringify(ACCOUNTS[who].password)} }) }).then((r) => r.status)`);
    console.log(who, base, 'login', st);
  }
  for (const [who, base] of Object.entries(hosts)) {
    await p.goto(`${base}/signin.html`, 300);
    console.log(who, base, '->', await p.eval(`fetch('/api/auth/me').then((r) => r.json()).then((j) => j.staff && j.staff.role)`));
  }
} finally { await p.close(); }
