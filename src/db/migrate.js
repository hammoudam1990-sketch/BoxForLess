// Create / upgrade the database schema. Safe to run repeatedly.
import openDatabase from './connection.js';
import config from '../config.js';

function main() {
  const db = openDatabase(config.dbPath);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((n) => !n.startsWith('sqlite_'));
  console.log(`Database ready at: ${config.dbPath}`);
  console.log(`Tables (${tables.length}): ${tables.join(', ')}`);
  db.close();
}

main();
