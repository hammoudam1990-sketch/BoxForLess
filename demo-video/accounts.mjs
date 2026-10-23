// The demo sign-ins, read from data/demo-accounts.txt (written by `npm run demo`). Never printed or committed.
import fs from 'node:fs';

const FILE = new URL('../data/demo-accounts.txt', import.meta.url);
const txt = fs.readFileSync(FILE, 'utf8');
const pw = (login) => {
  const m = new RegExp(`${login.replace(/[.@]/g, '\\$&')}\\s+(\\S+)`).exec(txt);
  if (!m) throw new Error(`No demo password for ${login}. Run: npm run demo`);
  return m[1];
};

export const BASE = process.env.DEMO_BASE || 'http://127.0.0.1:3001';
export const ACCOUNTS = {
  manager: { login: 'manager@demo.bfl.test', password: pw('manager@demo.bfl.test'), name: 'Demo Sales Manager' },
  rep: { login: 'rep@demo.bfl.test', password: pw('rep@demo.bfl.test'), name: 'Rita Rep' },
  warehouse: { login: 'warehouse@demo.bfl.test', password: pw('warehouse@demo.bfl.test'), name: 'Wanda Warehouse' },
  customer: { login: '7001', password: pw('Odoo ID 7001'), name: 'Demo Mini Mart' },
};
