// Network helpers: discover LAN IPv4 addresses and print friendly URLs.
import os from 'node:os';

/** @returns {{iface:string, address:string}[]} non-internal IPv4 interfaces. */
export function lanAddresses() {
  const out = [];
  const nics = os.networkInterfaces();
  for (const [iface, addrs] of Object.entries(nics)) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ iface, address: a.address });
    }
  }
  return out;
}

/** Print access URLs for a started server. */
export function printUrls({ scheme, port, host }) {
  const lines = [];
  lines.push(`  • On this computer:  ${scheme}://localhost:${port}`);
  if (host === '0.0.0.0' || host === '::') {
    for (const { iface, address } of lanAddresses()) {
      lines.push(`  • On the LAN (${iface}):  ${scheme}://${address}:${port}   ← open this on your phone`);
    }
  }
  return lines.join('\n');
}
