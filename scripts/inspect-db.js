import { openDatabase } from '../src/db/connection.js';
const db = openDatabase();
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
console.log('--- DATABASE TABLES & COUNTS ---');
for (const t of tables) {
  const count = db.prepare('SELECT COUNT(*) as c FROM ' + t.name).get().c;
  console.log(`${t.name.padEnd(30)}: ${count}`);
}
