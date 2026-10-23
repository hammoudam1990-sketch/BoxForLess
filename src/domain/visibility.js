// Product visibility rules (screen S02).
//
// The Sales Manager can HIDE products from a customer, from a whole price class, or from everyone, by
// category, by brand or one product at a time. A hidden product does not exist as far as that
// customer can tell: it is missing from every list, search, count and category chip, its page and
// image answer "not found", it has no price, and a request or order line naming it is refused. All of
// that is enforced here, on the server, from ONE function (`hiddenClause`), so the preview a manager
// sees is exactly the rule the catalogue applies.
//
// A rule only ever hides; nothing is deleted. Removing a rule switches it off and is logged, like
// adding one.
//
// BRAND: Odoo's Brand field is not filled in on products yet, so a brand rule matches the product
// NAME — a name that is the brand, or starts with it as a whole word ("ABIDO" hides "ABIDO ALL SPICE
// 500G"). When the Brand field is filled in Odoo this becomes an exact match on it.
import { isPriceClass, priceClassOf } from './prices.js';

export const ScopeType = Object.freeze({ ALL: 'ALL', PRICE_CLASS: 'PRICE_CLASS', CUSTOMER: 'CUSTOMER' });
export const TargetType = Object.freeze({ CATEGORY: 'CATEGORY', PRODUCT: 'PRODUCT', BRAND: 'BRAND' });

export class VisibilityError extends Error {
  constructor(message, status = 400, code = 'VISIBILITY_INVALID') { super(message); this.name = 'VisibilityError'; this.status = status; this.code = code; }
}

const likeEscape = (v) => String(v).replace(/[\\%_]/g, (c) => `\\${c}`);
const clean = (v, max) => String(v ?? '').trim().slice(0, max);

/**
 * The SQL that keeps only what this viewer may see, or null when nothing is hidden from them.
 * @param {object|null} viewer  { customerId } for a signed-in customer; null for a visitor
 * @param {string} alias  the products table alias in the caller's query
 * @returns {{sql:string, params:any[]}|null}
 */
export function hiddenClause(db, viewer, alias = 'p') {
  const customerId = viewer?.customerId ?? null;
  const cls = customerId ? priceClassOf(db, customerId) : null;
  const rules = db.prepare(`SELECT target_type, target_value FROM visibility_rules
                             WHERE is_active = 1 AND (scope_type = 'ALL'
                                OR (scope_type = 'CUSTOMER' AND scope_value = ?)
                                OR (scope_type = 'PRICE_CLASS' AND scope_value = ?))`).all(customerId === null ? '' : String(customerId), cls || '');
  if (!rules.length) return null;
  const parts = [];
  const params = [];
  const products = rules.filter((r) => r.target_type === TargetType.PRODUCT).map((r) => r.target_value);
  if (products.length) { parts.push(`${alias}.barcode NOT IN (${products.map(() => '?').join(',')})`); params.push(...products); }
  for (const r of rules) {
    if (r.target_type === TargetType.CATEGORY) {
      // COALESCE: a product with no category must stay visible, not vanish because NULL poisons NOT(...)
      parts.push(`NOT (COALESCE(${alias}.odoo_category_path, '') = ? OR COALESCE(${alias}.odoo_category_path, '') LIKE ? ESCAPE '\\')`);
      params.push(r.target_value, `${likeEscape(r.target_value)} / %`);
    } else if (r.target_type === TargetType.BRAND) {
      parts.push(`NOT (UPPER(${alias}.name) = UPPER(?) OR UPPER(${alias}.name) LIKE UPPER(?) ESCAPE '\\')`);
      params.push(r.target_value, `${likeEscape(r.target_value)} %`);
    }
  }
  return { sql: parts.map((p) => `(${p})`).join(' AND '), params };
}

/** Of these barcodes, the ones this viewer may see (others are hidden or do not exist). */
export function visibleBarcodes(db, viewer, barcodes) {
  const list = [...new Set((Array.isArray(barcodes) ? barcodes : []).map(String))];
  if (!list.length) return new Set();
  const clause = hiddenClause(db, viewer);
  const rows = db.prepare(`SELECT p.barcode FROM products p WHERE p.barcode IN (${list.map(() => '?').join(',')}) ${clause ? `AND ${clause.sql}` : ''}`)
    .all(...list, ...(clause ? clause.params : []));
  return new Set(rows.map((r) => r.barcode));
}

const scopeLabel = (db, r) => {
  if (r.scope_type === ScopeType.ALL) return 'Everyone (including visitors)';
  if (r.scope_type === ScopeType.PRICE_CLASS) return `Price class ${r.scope_value}`;
  return db.prepare('SELECT name FROM customers WHERE id = ?').get(Number(r.scope_value))?.name || `Customer ${r.scope_value}`;
};
const targetLabel = (db, r) => {
  if (r.target_type === TargetType.CATEGORY) return `Category ${r.target_value}`;
  if (r.target_type === TargetType.BRAND) return `Brand ${r.target_value}`;
  return db.prepare('SELECT name FROM products WHERE barcode = ?').get(r.target_value)?.name || `Product ${r.target_value}`;
};

const shape = (db, r) => ({
  id: r.id, scopeType: r.scope_type, scopeValue: r.scope_value, targetType: r.target_type, targetValue: r.target_value,
  who: scopeLabel(db, r), hides: targetLabel(db, r), active: Boolean(r.is_active),
  createdBy: r.created_by, createdAt: r.created_at, removedBy: r.removed_by, removedAt: r.removed_at,
});

function log(db, ruleId, action, by, detail, now) {
  db.prepare('INSERT INTO visibility_log (rule_id, action, by, at, detail) VALUES (?,?,?,?,?)').run(ruleId, action, by, now.toISOString(), detail);
}

/** Add a rule. Every field is checked against what actually exists, so a typo cannot silently do nothing. */
export function addRule(db, input = {}, by = null, now = new Date()) {
  const scopeType = String(input.scopeType || '');
  const targetType = String(input.targetType || '');
  if (!Object.values(ScopeType).includes(scopeType)) throw new VisibilityError('Choose who this applies to.');
  if (!Object.values(TargetType).includes(targetType)) throw new VisibilityError('Choose what to hide.');

  let scopeValue = null;
  if (scopeType === ScopeType.PRICE_CLASS) {
    scopeValue = clean(input.scopeValue, 80);
    if (!isPriceClass(scopeValue)) throw new VisibilityError('Choose one of the price classes from the list.');
  } else if (scopeType === ScopeType.CUSTOMER) {
    const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(input.scopeValue));
    if (!c) throw new VisibilityError('That customer does not exist.', 404);
    scopeValue = String(c.id);
  }

  let targetValue = clean(input.targetValue, 200);
  if (!targetValue) throw new VisibilityError('Say what to hide.');
  if (targetType === TargetType.PRODUCT) {
    const p = db.prepare('SELECT barcode FROM products WHERE barcode = ?').get(targetValue);
    if (!p) throw new VisibilityError('That product does not exist.', 404);
    targetValue = p.barcode;
  } else if (targetType === TargetType.CATEGORY) {
    const exists = db.prepare("SELECT 1 FROM products WHERE odoo_category_path = ? OR odoo_category_path LIKE ? ESCAPE '\\' LIMIT 1").get(targetValue, `${likeEscape(targetValue)} / %`);
    if (!exists) throw new VisibilityError('No product is in that category.', 404);
  } else {
    if (targetValue.length < 2) throw new VisibilityError('A brand is at least two letters.');
    if (!db.prepare("SELECT 1 FROM products WHERE UPPER(name) = UPPER(?) OR UPPER(name) LIKE UPPER(?) ESCAPE '\\' LIMIT 1").get(targetValue, `${likeEscape(targetValue)} %`)) {
      throw new VisibilityError('No product name starts with that brand.', 404);
    }
  }

  if (db.prepare(`SELECT 1 FROM visibility_rules WHERE is_active = 1 AND scope_type = ? AND COALESCE(scope_value,'') = ? AND target_type = ? AND target_value = ?`)
    .get(scopeType, scopeValue ?? '', targetType, targetValue)) {
    throw new VisibilityError('That rule is already in force.', 409, 'DUPLICATE_RULE');
  }

  const id = Number(db.prepare(`INSERT INTO visibility_rules (scope_type, scope_value, target_type, target_value, is_active, created_by, created_at)
                                VALUES (?,?,?,?,1,?,?)`).run(scopeType, scopeValue, targetType, targetValue, by, now.toISOString()).lastInsertRowid);
  const rule = shape(db, db.prepare('SELECT * FROM visibility_rules WHERE id = ?').get(id));
  log(db, id, 'ADDED', by, `${rule.who}: hide ${rule.hides}`, now);
  return rule;
}

/** Switch a rule off. The rule and its history are kept. */
export function removeRule(db, id, by = null, now = new Date()) {
  const r = db.prepare('SELECT * FROM visibility_rules WHERE id = ?').get(Number(id));
  if (!r) throw new VisibilityError('That rule does not exist.', 404);
  if (!r.is_active) throw new VisibilityError('That rule is already off.', 409);
  db.prepare('UPDATE visibility_rules SET is_active = 0, removed_by = ?, removed_at = ? WHERE id = ?').run(by, now.toISOString(), r.id);
  const rule = shape(db, { ...r, is_active: 0 });
  log(db, r.id, 'REMOVED', by, `${rule.who}: show ${rule.hides} again`, now);
  return rule;
}

export function listRules(db) {
  return db.prepare('SELECT * FROM visibility_rules ORDER BY is_active DESC, id DESC LIMIT 300').all().map((r) => shape(db, r));
}

export function listLog(db, limit = 40) {
  return db.prepare('SELECT id, rule_id AS ruleId, action, by, at, detail FROM visibility_log ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 40, 200));
}

/**
 * What a viewer would see: how many active products are visible and hidden, and some of the hidden ones.
 * Uses the same clause the catalogue uses.
 */
export function preview(db, viewer, sample = 40) {
  const total = db.prepare('SELECT COUNT(*) n FROM products WHERE is_active = 1').get().n;
  const clause = hiddenClause(db, viewer);
  if (!clause) return { total, visible: total, hidden: 0, hiddenSample: [] };
  const visible = db.prepare(`SELECT COUNT(*) n FROM products p WHERE p.is_active = 1 AND ${clause.sql}`).get(...clause.params).n;
  const hiddenSample = db.prepare(`SELECT p.name, p.barcode FROM products p WHERE p.is_active = 1 AND NOT (${clause.sql}) ORDER BY p.name LIMIT ?`)
    .all(...clause.params, Math.min(Number(sample) || 40, 200));
  return { total, visible, hidden: total - visible, hiddenSample };
}

/** The category paths a manager can choose from, with counts. */
export function categoryChoices(db) {
  return db.prepare(`SELECT odoo_category_path AS path, COUNT(*) AS n FROM products WHERE is_active = 1 AND odoo_category_path IS NOT NULL GROUP BY odoo_category_path ORDER BY odoo_category_path`).all();
}
