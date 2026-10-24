// Preloaded by the dev launch entry (node --import) to give the dev server its own administrator, so the dev server does not use the owner's real admin
// account from .env.local. The account is made once and kept in data/dev-admin.txt (never committed). Delete that file
// to get a new one. It only sets the environment; the normal server then starts as usual.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dev-admin.txt');
const chunk = () => crypto.randomBytes(3).toString('hex');

if (!fs.existsSync(file)) {
  const made = { username: 'dev-admin', password: `${chunk()}-${chunk()}-${chunk()}` };
  fs.writeFileSync(file, `Dev server administrator (local only, not committed)\nUsername: ${made.username}\nPassword: ${made.password}\n`);
}
const text = fs.readFileSync(file, 'utf8');
process.env.BFL_STAFF_USERNAME = /^Username:\s*(\S+)/m.exec(text)[1];
process.env.BFL_STAFF_PASSWORD = /^Password:\s*(\S+)/m.exec(text)[1];
