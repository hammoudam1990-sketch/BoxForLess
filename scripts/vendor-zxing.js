// Refresh the vendored ZXing browser bundle from node_modules.
// Run after updating @zxing/library:  node scripts/vendor-zxing.js
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config.js';

const src = path.join(config.root, 'node_modules', '@zxing', 'library', 'umd', 'index.min.js');
const dest = path.join(config.root, 'src', 'public', 'vendor', 'zxing.min.js');

if (!fs.existsSync(src)) {
  console.error(`Not found: ${src}\nRun "npm install @zxing/library" first.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.copyFileSync(src, dest);
console.log(`Vendored ZXing bundle -> ${dest} (${fs.statSync(dest).size} bytes)`);
