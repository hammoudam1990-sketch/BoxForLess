// Generate a self-signed TLS certificate for LOCAL DEVELOPMENT ONLY.
// The phone camera / barcode scanner requires HTTPS (a secure context).
// The cert includes localhost + every detected LAN IP in its SAN list so the
// same cert works from the dev machine and the phone.
//   node scripts/gen-cert.js
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config.js';
import { lanAddresses } from '../src/server/net.js';

function main() {
  const dir = path.dirname(config.tlsCertPath);
  fs.mkdirSync(dir, { recursive: true });

  const ips = lanAddresses().map((a) => a.address);
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');

  console.log('Generating self-signed dev certificate…');
  console.log('SAN:', san);

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', config.tlsKeyPath,
      '-out', config.tlsCertPath,
      '-days', '825',
      '-subj', '/CN=Box for Less Dev',
      '-addext', `subjectAltName=${san}`,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error('openssl failed:', e.stderr ? e.stderr.toString() : e.message);
    console.error('Install OpenSSL or ensure it is on PATH, then retry.');
    process.exit(1);
  }

  console.log(`\nWrote:\n  ${config.tlsKeyPath}\n  ${config.tlsCertPath}`);
  console.log(`\nRestart the server (npm start). HTTPS will start on port ${config.httpsPort}.`);
  console.log('On the phone, open the https:// URL and accept the one-time security warning.');
}

main();
