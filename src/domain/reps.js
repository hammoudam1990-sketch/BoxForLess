// Sales reps and which customers are theirs.
//
// A rep is a staff account with the Sales rep role. The two sample reps in fixtures/shelf-sample.json
// (Kwame Asante, Efua Owusu) stand in for Odoo's salespeople and own the sample shops; any other rep
// account gets its own id (`rep-u<account id>`) and starts with no customers.
//
// Two kinds of customer can be given to a rep:
//   SHOP  a sample shop on the shelf-expiry list (Odoo ID 4101...) -> table shop_reps
//   BFL   a customer registered or imported in BFL                 -> customers.salesperson (the rep's name)
// Until Odoo is connected the Sales Manager sets this on the "Rep customers" screen. Once Odoo is
// connected the salesperson comes from Odoo (the sync overwrites it) and is set there.
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';

export class RepError extends Error {
  constructor(message, status = 400) { super(message); this.name = 'RepError'; this.status = status; }
}

const FIXTURE = path.join(config.root, 'fixtures', 'shelf-sample.json');
const sample = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

/** The id a new rep account gets. */
export const repIdForAccount = (accountId) => `rep-u${accountId}`;

/** Sample reps plus every active rep account that is not one of them. */
export function allReps(db) {
  const reps = sample().reps.map((r) => ({ id: r.id, name: r.name, sample: true }));
  const known = new Set(reps.map((r) => r.id));
  for (const u of db.prepare("SELECT name, rep_id FROM staff_users WHERE role = 'SALES_REP' AND is_active = 1 AND rep_id IS NOT NULL ORDER BY name").all()) {
    if (!known.has(u.rep_id)) { reps.push({ id: u.rep_id, name: u.name, sample: false }); known.add(u.rep_id); }
  }
  return reps;
}

/** A shelf (from loadShelf) with every rep and the assignment of its shops applied. */
export function overlayShelf(db, shelf) {
  const given = new Map(db.prepare('SELECT customer_id, rep_id FROM shop_reps').all().map((r) => [r.customer_id, r.rep_id]));
  return {
    ...shelf,
    reps: allReps(db),
    customers: shelf.customers.map((c) => (given.has(c.id) ? { ...c, repId: given.get(c.id) } : c)),
  };
}

/** Everything the "Rep customers" screen shows. */
export function assignments(db) {
  const reps = allReps(db);
  const nameToId = new Map(reps.map((r) => [r.name, r.id]));
  const shelf = overlayShelf(db, { customers: sample().customers.map((c) => ({ id: c.id, odooId: c.id, name: c.name, repId: c.repId })) });
  const shops = shelf.customers.map((c) => ({ kind: 'SHOP', id: c.id, name: c.name, odooId: String(c.odooId), repId: c.repId || null }));
  const customers = db.prepare('SELECT id, name, odoo_customer_ref, salesperson, customer_type FROM customers WHERE is_active = 1 ORDER BY name').all()
    .map((c) => ({
      kind: 'BFL', id: c.id, name: c.name, odooId: c.odoo_customer_ref || '', customerType: c.customer_type,
      repId: nameToId.get(c.salesperson) ?? null, repName: c.salesperson || null,
    }));
  return { reps, shops, customers };
}

/** Give one customer to a rep (or to nobody, repId null). */
export function assignCustomer(db, { kind, id, repId }, by = null, now = new Date()) {
  const rep = repId ? allReps(db).find((r) => r.id === String(repId)) : null;
  if (repId && !rep) throw new RepError('Choose one of the sales reps from the list.');
  if (kind === 'SHOP') {
    if (!sample().customers.some((c) => c.id === Number(id))) throw new RepError('That shop does not exist.', 404);
    // "nobody" is stored as '' (not deleted) so that it beats the sample's own rep
    db.prepare(`INSERT INTO shop_reps (customer_id, rep_id, set_by, set_at) VALUES (?,?,?,?)
                ON CONFLICT(customer_id) DO UPDATE SET rep_id = excluded.rep_id, set_by = excluded.set_by, set_at = excluded.set_at`)
      .run(Number(id), rep ? rep.id : '', by, now.toISOString());
    return { kind, id: Number(id), repId: rep ? rep.id : null };
  }
  if (kind === 'BFL') {
    const r = db.prepare('UPDATE customers SET salesperson = ?, updated_at = ? WHERE id = ? AND is_active = 1').run(rep ? rep.name : null, now.toISOString(), Number(id));
    if (!r.changes) throw new RepError('That customer does not exist.', 404);
    return { kind, id: Number(id), repId: rep ? rep.id : null };
  }
  throw new RepError('Unknown kind of customer.');
}
