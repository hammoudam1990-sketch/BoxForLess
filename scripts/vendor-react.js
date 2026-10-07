// Refresh the vendored React bundles from node_modules.
// Run after updating react, react-dom or htm:  node scripts/vendor-react.js
//
// The front end loads these from /vendor — never from a CDN — so a phone on an
// unfamiliar network, or one with no internet at all, still gets a working app.
// There is no build step: the pages are plain ES modules that read React from the
// globals these files define (see src/public/js/lib/react.js).
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config.js';

const FILES = [
  ['react', 'umd', 'react.production.min.js', 'react.min.js'],
  ['react-dom', 'umd', 'react-dom.production.min.js', 'react-dom.min.js'],
  ['htm', 'dist', 'htm.umd.js', 'htm.min.js'],
];

const destDir = path.join(config.root, 'src', 'public', 'vendor');
fs.mkdirSync(destDir, { recursive: true });

let failed = false;
for (const [pkg, dir, file, out] of FILES) {
  const src = path.join(config.root, 'node_modules', pkg, dir, file);
  if (!fs.existsSync(src)) {
    console.error(`Not found: ${src}\nRun "npm install ${pkg}" first.`);
    failed = true;
    continue;
  }
  const dest = path.join(destDir, out);
  fs.copyFileSync(src, dest);
  console.log(`Vendored ${pkg} -> ${dest} (${fs.statSync(dest).size} bytes)`);
}
if (failed) process.exit(1);
