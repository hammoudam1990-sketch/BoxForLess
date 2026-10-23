// The demo: a SEPARATE copy of the platform for presenting to the team, on its own port and its own database
// (data/demo.db). It uses the real product catalogue but none of the real customers, and it is rebuilt from
// scratch every time this script runs, so a presentation always starts from the same clean place.
//
//   npm run demo            rebuild the demo data and start the demo server (http://<this computer>:3001)
//   npm run demo -- --keep  start the demo server on the data as it is (continue a demo)
//
// Everything in it is SAMPLE data: no Odoo is connected, the "Sample Odoo" screen plays Odoo's part. The sign-ins
// are written to data/demo-accounts.txt (never committed). Nothing here touches the live database except to READ
// the product catalogue from it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DB = path.join(ROOT, 'data', 'demo.db');
const LIVE_DB = path.join(ROOT, 'data', 'product_master.db');
const ACCOUNTS = path.join(ROOT, 'data', 'demo-accounts.txt');
const PORT = Number(process.env.DEMO_PORT || 3001);
const keep = process.argv.includes('--keep') && fs.existsSync(DEMO_DB) && fs.existsSync(ACCOUNTS);

const word = () => crypto.randomBytes(3).toString('hex');
const password = () => `${word()}-${word()}-${word()}`;

async function build() {
  // the demo must never reach the live database's files, and the live one must exist to read the catalogue from
  if (!fs.existsSync(LIVE_DB)) throw new Error('The product catalogue (data/product_master.db) is needed to build the demo.');
  for (const f of [DEMO_DB, `${DEMO_DB}-wal`, `${DEMO_DB}-shm`]) fs.rmSync(f, { force: true });
  process.env.BFL_DB_PATH = DEMO_DB;   // the modules below read the path when imported

  const { openDatabase } = await import('../src/db/connection.js');
  const { createStaffUser, changeStaffPassword } = await import('../src/domain/staff-accounts.js');
  const { issueAccessCode } = await import('../src/domain/access-codes.js');
  const { activateCustomer } = await import('../src/domain/customer-auth.js');
  const { assignCustomer } = await import('../src/domain/reps.js');
  const { setCreditLimit } = await import('../src/domain/sample-odoo.js');
  const { seedHistory } = await import('../src/domain/sample-history.js');
  const { setSchedule } = await import('../src/domain/payments.js');

  const db = openDatabase(DEMO_DB);
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  // 1. the catalogue, copied (read-only) from the live database: categories, products and their photos
  db.exec(`ATTACH DATABASE '${LIVE_DB.replace(/'/g, "''")}' AS live`);
  const common = (table) => {
    const mine = new Set(db.prepare(`PRAGMA main.table_info(${table})`).all().map((c) => c.name));
    return db.prepare(`PRAGMA live.table_info(${table})`).all().map((c) => c.name).filter((n) => mine.has(n));
  };
  db.exec('PRAGMA foreign_keys = OFF');   // products and their photos point at each other; copied together, then checked
  db.exec('BEGIN');
  for (const t of ['categories', 'products', 'product_images']) {
    const cols = common(t).join(', ');
    db.exec(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM live.${t}`);
  }
  // the live import batches are not copied, so the products' links to them are cleared
  db.exec('UPDATE products SET last_import_id = NULL, last_seen_import_id = NULL');
  // stock counts as fresh (so customers can order), and stays fresh for a month of demos
  db.prepare("INSERT INTO import_batches (filename, status, imported_at, confirmed_at, completed_at) VALUES ('demo','COMPLETED',?,?,?)").run(now, now, now);
  db.exec('COMMIT');
  db.exec('DETACH DATABASE live');
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('The copied catalogue does not hold together.');
  db.exec('PRAGMA foreign_keys = ON');

  // 2. the customers: three credit customers (the history needs three), one of them the star of the demo
  const insCustomer = db.prepare(`INSERT INTO customers (name, odoo_customer_ref, phone, email, delivery_address, customer_type, pricelist, is_active, created_at, updated_at)
                                  VALUES (?,?,?,?,?, 'CREDIT', ?, 1, ?, ?)`);
  const people = [
    ['Demo Mini Mart', '7001', '0244000111', 'minimart@demo.bfl.test', 'Shop 4, Madina Market, Accra', 'CLASS A (GHS)'],
    ['Demo Supermarket', '7002', '0244000222', 'supermarket@demo.bfl.test', 'Spintex Road, Accra', 'SHOPRITE (GHS)'],
    ['Demo Wholesale', '7003', '0244000333', 'wholesale@demo.bfl.test', 'Tema Industrial Area', 'CLASS C (GHS)'],
  ];
  const custIds = people.map((p) => Number(insCustomer.run(...p, now, now).lastInsertRowid));

  // 3. fourteen months of made-up history, so the reports have something to compare with
  seedHistory(db, today);

  // 4. the team: a Sales Manager, a rep, a warehouse person, each with a password they already chose
  const accounts = [];
  const admin = { name: 'Demo Administrator', login: 'demo-admin', pw: password(), role: 'Administrator' };
  const team = [
    { name: 'Demo Sales Manager', email: 'manager@demo.bfl.test', role: 'SALES_MANAGER', label: 'Sales Manager' },
    { name: 'Rita Rep', email: 'rep@demo.bfl.test', role: 'SALES_REP', label: 'Sales rep' },
    { name: 'Wanda Warehouse', email: 'warehouse@demo.bfl.test', role: 'WAREHOUSE', label: 'Warehouse' },
  ];
  let repId = null;
  for (const t of team) {
    const made = createStaffUser(db, { name: t.name, email: t.email, role: t.role }, 'ADMIN', 'Demo setup');
    const pw = password();
    changeStaffPassword(db, made.user.id, made.temporaryPassword, pw);
    if (t.role === 'SALES_REP') repId = made.user.repId;
    accounts.push({ label: t.label, who: t.name, login: t.email, pw });
  }

  // 5. the rep owns the star customer and three sample shops; the credit limit and payment day are set
  assignCustomer(db, { kind: 'BFL', id: custIds[0], repId }, 'Demo setup');
  for (const shop of [4101, 4102, 4103]) assignCustomer(db, { kind: 'SHOP', id: shop, repId }, 'Demo setup');
  // the star customer has room for a big order (the history leaves them owing most of 25,000); the others keep 25,000
  custIds.forEach((id, i) => setCreditLimit(db, id, i === 0 ? 60000 : 25000));
  setSchedule(db, custIds[0], { kind: 'DUE_DATE' }, 'Demo setup');

  // 6. customers sign in with their Odoo ID and a password
  for (const [i, p] of people.entries()) {
    const pw = password();
    activateCustomer(db, p[1], issueAccessCode(db, custIds[i]), pw);
    accounts.push({ label: i === 0 ? 'Customer (the one to order with)' : 'Customer', who: p[0], login: `Odoo ID ${p[1]}`, pw });
  }
  db.close();

  const lines = [
    'BOX FOR LESS - DEMO SIGN-INS (sample data; this file is never committed)',
    `Written ${now}. Rebuilt every time you run: npm run demo`,
    '',
    `Demo link on this computer:   http://localhost:${PORT}`,
    `Staff sign-in page:           http://localhost:${PORT}/   (Staff tab)`,
    `Customer catalogue:           http://localhost:${PORT}/catalog`,
    '',
    `${'Role'.padEnd(34)}${'Name'.padEnd(22)}${'Sign in with'.padEnd(34)}Password`,
    `${admin.role.padEnd(34)}${admin.name.padEnd(22)}${admin.login.padEnd(34)}${admin.pw}`,
    ...accounts.map((a) => `${a.label.padEnd(34)}${a.who.padEnd(22)}${a.login.padEnd(34)}${a.pw}`),
    '',
    'Customers sign in on the first tab ("Customer"): Odoo ID + password.',
    'Staff sign in on the second tab ("Staff"): email + password.',
  ];
  fs.writeFileSync(ACCOUNTS, `${lines.join('\n')}\n`);
  (await import('./demo-launchpad.js')).writeLaunchpad();   // data/demo-launchpad.html: the four pages and their sign-ins on one page
  return admin;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return null;
}

let admin;
if (keep) {
  const txt = fs.readFileSync(ACCOUNTS, 'utf8');
  const m = /demo-admin\s+(\S+)/.exec(txt);
  admin = { login: 'demo-admin', pw: m ? m[1] : password() };
} else {
  console.log('Building the demo data ...');
  admin = await build();
  console.log('Demo data ready.');
}

const lan = lanAddress();
console.log(`\nDemo server starting on port ${PORT}`);
console.log(`  On this computer:  http://localhost:${PORT}`);
if (lan) console.log(`  On the LAN:        http://${lan}:${PORT}`);
console.log(`  Sign-ins:          ${path.relative(ROOT, ACCOUNTS)}\n`);

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server', 'index.js')], {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: String(PORT),
    BFL_HTTPS_PORT: String(PORT + 443),
    BFL_DB_PATH: DEMO_DB,
    BFL_STAFF_USERNAME: admin.login,
    BFL_STAFF_PASSWORD: admin.pw,
    BFL_SESSION_SECRET: process.env.BFL_SESSION_SECRET || crypto.randomBytes(24).toString('hex'),
    BFL_CUSTOMER_SESSION_SECRET: process.env.BFL_CUSTOMER_SESSION_SECRET || crypto.randomBytes(24).toString('hex'),
    BFL_STOCK_FRESHNESS_HOURS: process.env.BFL_STOCK_FRESHNESS_HOURS || '720',
    BFL_ODOO_URL: '', BFL_ODOO_SYNC: 'off',   // the demo never talks to Odoo
  },
});
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
