// Run this before showing the app to anyone, especially on a NEW network.
//
//   node scripts/preflight.js
//
// Checks the four things that have actually broken a demo before:
//   1. the network is classified Private — on Public, Windows Firewall silently
//      drops the phone's connection and nothing explains why
//   2. the firewall rules exist
//   3. the TLS certificate covers the CURRENT address — it is pinned to whatever
//      IP it was generated for, so moving Wi-Fi breaks HTTPS and the scanner
//   4. stock is fresh enough that a request can still be submitted
//
// It changes nothing. It prints what is wrong and the exact command to fix it.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import openDatabase from '../src/db/connection.js';
import config from '../src/config.js';
import { lanAddresses } from '../src/server/net.js';
import { getStockSource } from '../src/domain/stock-source.js';

const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); problems += 1; };
const warn = (m) => console.log(`  ! ${m}`);
let problems = 0;

const ps = (cmd) => {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' }).trim();
  } catch { return ''; }
};

console.log('\n============================================================');
console.log('  PRE-FLIGHT');
console.log('============================================================\n');

// ---------------------------------------------------------------- 1. network
console.log('NETWORK');
const ips = lanAddresses();
if (!ips.length) {
  bad('No network address found — is Wi-Fi connected?');
} else {
  for (const { iface, address } of ips) ok(`${address}  (${iface})`);
}
const current = ips[0]?.address || null;

const profiles = ps('Get-NetConnectionProfile | ForEach-Object { "$($_.Name)=$($_.NetworkCategory)" }');
for (const line of profiles.split(/\r?\n/).filter(Boolean)) {
  const [name, category] = line.split('=');
  if (category === 'Private' || category === 'DomainAuthenticated') ok(`"${name}" is ${category}`);
  else {
    bad(`"${name}" is ${category} — phones will be BLOCKED by Windows Firewall`);
    console.log(`      Fix (as Administrator):`);
    console.log(`        Set-NetConnectionProfile -Name "${name}" -NetworkCategory Private`);
  }
}

const rules = ps('(Get-NetFirewallRule -DisplayName "*Box for Less*" -ErrorAction SilentlyContinue | Where-Object Enabled -eq $true).Count');
if (Number(rules) > 0) ok(`${rules} firewall rule(s) allowing the app`);
else {
  bad('No enabled firewall rule for this app — phones cannot connect');
  console.log('      Fix (as Administrator):');
  console.log('        New-NetFirewallRule -DisplayName "Box for Less (LAN)" -Direction Inbound `');
  console.log('          -Action Allow -Protocol TCP -LocalPort 3000,3443 -RemoteAddress LocalSubnet');
}

// ------------------------------------------------------------ 2. certificate
console.log('\nHTTPS CERTIFICATE  (needed only for the barcode scanner)');
if (!fs.existsSync(config.tlsCertPath)) {
  warn('No certificate. HTTP still works; the scanner will not.');
} else {
  let san = '';
  try {
    san = execFileSync('openssl', ['x509', '-in', config.tlsCertPath, '-noout', '-text'], { encoding: 'utf8' });
  } catch { san = ''; }
  if (!san) warn('Could not read the certificate (openssl not available) — skipping.');
  else if (current && san.includes(current)) ok(`covers ${current}`);
  else {
    bad(`does NOT cover ${current} — HTTPS and the scanner will fail on this network`);
    console.log('      Fix:  npm run gen-cert     then restart the server');
  }
}

// ------------------------------------------------------------------ 3. stock
console.log('\nSTOCK');
const db = openDatabase(config.dbPath);
const stock = getStockSource().getStockStatus(db);
if (stock.hasData && stock.fresh) {
  const expires = new Date(Date.parse(stock.asOf) + config.stock.freshnessHours * 3600_000);
  ok(`fresh — customers can submit requests`);
  console.log(`      imported ${new Date(stock.asOf).toLocaleString()}`);
  console.log(`      BLOCKS AT ${expires.toLocaleString()}`);
  if (expires.getTime() - Date.now() < 4 * 3600_000) {
    warn('Less than 4 hours left. Re-import before you present:');
    console.log('        node scripts/daily-update.js --confirm');
  }
} else {
  bad('STALE or missing — customers CANNOT submit requests');
  console.log('      Fix:  node scripts/daily-update.js --confirm');
}

// -------------------------------------------------------------- 4. what data
console.log('\nWHAT WILL BE ON SCREEN');
const n = (sql, ...a) => db.prepare(sql).get(...a).n;
console.log(`  products        : ${n('SELECT COUNT(*) n FROM products WHERE is_active = 1')} (${n('SELECT COUNT(*) n FROM products WHERE is_active = 1 AND free_to_use > 0')} available now)`);
console.log(`  customers       : ${n('SELECT COUNT(*) n FROM customers')}, of which ${n('SELECT COUNT(*) n FROM customers WHERE access_code IS NOT NULL')} hold a code`);
console.log(`  active requests : ${n("SELECT COUNT(*) n FROM requests WHERE status IS NULL OR status != 'DELETED'")}`);
console.log(`  withdrawn       : ${n("SELECT COUNT(*) n FROM requests WHERE status = 'DELETED'")}`);
console.log(`  access requests : ${n("SELECT COUNT(*) n FROM access_requests WHERE status = 'PENDING'")} waiting`);
console.log(`  pending reviews : ${n("SELECT COUNT(*) n FROM import_changes WHERE review_status = 'PENDING'")}`);

// ------------------------------------------------------------------- 5. links
console.log('\nLINKS  (everyone must be on the SAME Wi-Fi as this computer)');
if (current) {
  console.log(`  Front door     : http://${current}:${config.port}/   (links to everything)`);
  console.log(`  Catalogue      : http://${current}:${config.port}/catalog`);
  console.log(`  Staff / scanner: https://${current}:${config.httpsPort}/`);
  console.log(`  On this laptop : http://localhost:${config.port}/`);
} else {
  console.log('  No address — connect to Wi-Fi first.');
}

console.log('\n============================================================');
console.log(problems === 0
  ? '  READY — nothing blocking.'
  : `  ${problems} PROBLEM(S) ABOVE — fix before presenting.`);
console.log('============================================================\n');
db.close();
process.exit(problems === 0 ? 0 : 1);
