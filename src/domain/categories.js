// Odoo product-category paths: parsing (pure) and hierarchy materialisation.
//
// Odoo is the SOURCE OF TRUTH for categories. A product carries the complete
// path verbatim in products.odoo_category_path; this module also materialises
// that path into the existing `categories` table as a real parent/child tree so
// the catalog can filter and group without re-parsing strings at read time.
//
//   "FOOD / SPICES & SEASONINGS / GROUND SPICES"
//        topLevel = FOOD
//        parent   = SPICES & SEASONINGS
//        name     = GROUND SPICES          (the leaf)
//        path     = the whole string
//
// The hierarchy is NEVER reduced to Food/Non-Food. Every level is preserved.
import { CATEGORY_SEPARATOR } from './constants.js';

// Odoo writes "A / B / C"; be liberal about surrounding whitespace.
const SPLIT = /\s*\/\s*/;

/**
 * Normalize a raw category cell into a canonical path string.
 * Collapses whitespace, drops empty segments, rejoins with " / ".
 * @returns {string|null} null when there is no usable category
 */
export function normalizeCategoryPath(raw) {
  if (raw === null || raw === undefined) return null;
  const segments = String(raw)
    .split(SPLIT)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '');
  return segments.length ? segments.join(CATEGORY_SEPARATOR) : null;
}

/** Segments of a path, outermost first. */
export function categorySegments(path) {
  const p = normalizeCategoryPath(path);
  return p ? p.split(SPLIT) : [];
}

/**
 * Split a path into the parts the customer catalog shows.
 * A 2-level path has no distinct parent; `parent` is then null and the leaf is
 * still the category name — the hierarchy is reported as it really is, never
 * padded out to a fixed depth.
 * @returns {{path:string, segments:string[], topLevel:string, parent:string|null,
 *            name:string, level:number}|null}
 */
export function parseCategoryPath(raw) {
  const segments = categorySegments(raw);
  if (!segments.length) return null;
  return {
    path: segments.join(CATEGORY_SEPARATOR),
    segments,
    topLevel: segments[0],
    parent: segments.length >= 3 ? segments[segments.length - 2] : null,
    name: segments[segments.length - 1],
    level: segments.length,
  };
}

/** Every ancestor path of a path, outermost first, including the path itself. */
export function ancestorPaths(raw) {
  const segments = categorySegments(raw);
  return segments.map((_, i) => segments.slice(0, i + 1).join(CATEGORY_SEPARATOR));
}

/**
 * Ensure every node of a category path exists in `categories`, linked by
 * parent_id, and return the LEAF category id.
 *
 * Idempotent: an already-materialised path performs no writes. Existing nodes
 * are never renamed or re-parented, so a category tree that is already correct
 * is left byte-identical.
 *
 * @param {object} db
 * @param {string} rawPath
 * @param {{now?:string}} [opts]
 * @returns {number|null} leaf category id, or null for an empty path
 */
export function ensureCategoryPath(db, rawPath, opts = {}) {
  const paths = ancestorPaths(rawPath);
  if (!paths.length) return null;
  const now = opts.now || new Date().toISOString();

  const find = db.prepare('SELECT id FROM categories WHERE path = ?');
  const insert = db.prepare(
    `INSERT INTO categories (name, path, level, parent_id, is_active, created_at, updated_at)
     VALUES (?,?,?,?,1,?,?)`
  );

  let parentId = null;
  let leafId = null;
  paths.forEach((path, i) => {
    const existing = find.get(path);
    if (existing) {
      leafId = existing.id;
    } else {
      const segments = path.split(SPLIT);
      const info = insert.run(segments[segments.length - 1], path, i + 1, parentId, now, now);
      leafId = Number(info.lastInsertRowid);
    }
    parentId = leafId;
  });
  return leafId;
}

/** The full category tree, outermost first. Used by the catalog facets. */
export function categoryTree(db) {
  return db.prepare(
    'SELECT id, name, path, level, parent_id FROM categories WHERE is_active = 1 ORDER BY path'
  ).all();
}

export default { normalizeCategoryPath, parseCategoryPath, ensureCategoryPath, ancestorPaths };
