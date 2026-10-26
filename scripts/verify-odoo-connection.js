// scripts/test-odoo-connection.js
// Tests connectivity to an Odoo instance (staging or production) using the configured credentials.
//
// Usage:
//   node scripts/test-odoo-connection.js
//
// Guaranteed rules:
//   - The API key is NEVER printed, logged, or included in error traces.
//   - Read-only queries only (ping and search_count). Zero writes.
//   - Cost and valuation models are NEVER queried.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { odooConfig, publicOdooConfig, redact } from '../src/odoo/config.js';
import { createOdooClient } from '../src/odoo/client.js';

// Load .env.local if present and not already loaded in process.env
const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const envLocalPath = path.join(rootDir, '.env.local');

if (fs.existsSync(envLocalPath)) {
  try {
    const lines = fs.readFileSync(envLocalPath, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch (err) {
    console.error('Warning: could not read .env.local:', err.message);
  }
}

const config = odooConfig();
const pub = publicOdooConfig(config);

console.log('============================================================');
console.log('  ODOO STAGING / PRODUCTION CONNECTIVITY TEST');
console.log('============================================================\n');

console.log('Configuration Check:');
console.log(`  - URL:         ${pub.url || '[NOT SET]'}`);
console.log(`  - Database:    ${pub.db || '[NOT SET]'}`);
console.log(`  - Login User:  ${pub.login || '[NOT SET]'}`);
console.log(`  - API Key:     ${pub.hasKey ? '[SET - REDACTED]' : '[MISSING]'}`);
console.log(`  - Protocol:    ${pub.protocol}`);
console.log(`  - Timeout:     ${config.timeoutMs} ms`);
console.log(`  - Sync Flag:   ${pub.syncOn ? 'ON' : 'OFF'}\n`);

if (!config.configured) {
  console.log('✗ Odoo is NOT configured.');
  console.log('  Please set BFL_ODOO_URL, BFL_ODOO_DB, BFL_ODOO_LOGIN, and BFL_ODOO_API_KEY in .env.local');
  process.exit(1);
}

const client = createOdooClient({
  ...config,
  onCall: ({ model, method, count, ms, ok, error }) => {
    if (ok) {
      console.log(`  ✓ ${model}.${method}() -> ${count} record(s) [${ms}ms]`);
    } else {
      console.log(`  ✗ ${model}.${method}() failed [${ms}ms]: ${redact(error, config.apiKey)}`);
    }
  },
});

console.log('Starting Connectivity Verification...\n');

try {
  const t0 = Date.now();
  console.log('1. Testing Ping (cheap partner check)...');
  await client.ping();
  const pingMs = Date.now() - t0;
  console.log(`  ✓ Ping succeeded (${pingMs}ms)\n`);

  console.log('2. Verifying Allowed Read Models:');
  const partnerCount = await client.searchCount('res.partner');
  console.log(`  - res.partner total count: ${partnerCount}`);

  const productCount = await client.searchCount('product.product');
  console.log(`  - product.product total count: ${productCount}`);

  const orderCount = await client.searchCount('sale.order');
  console.log(`  - sale.order total count: ${orderCount}`);

  console.log('\n============================================================');
  console.log('  STATUS: CONNECTED & READY');
  console.log('============================================================');
  console.log(`Odoo staging instance is reachable and responding on ${pub.protocol}.\n`);
  process.exit(0);
} catch (err) {
  console.error('\n============================================================');
  console.error('  STATUS: CONNECTION FAILED');
  console.error('============================================================');
  console.error(`Error: ${redact(err.message, config.apiKey)}`);
  if (err.code) console.error(`Error Code: ${err.code}`);
  console.error('\nTroubleshooting Checklist:');
  console.error('  1. Verify the Odoo URL is reachable without redirect.');
  console.error('  2. Verify the database name matches exactly.');
  console.error('  3. Ensure integration user credentials and API key have permission to read res.partner.');
  console.error('  4. If your Odoo instance is v17+ with bearer keys, set BFL_ODOO_PROTOCOL=json2.\n');
  process.exit(1);
}
