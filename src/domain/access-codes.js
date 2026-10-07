// Per-customer access codes.
//
// WHY THIS EXISTS
// The catalog is public so a customer can look at products without a login. The
// CUSTOMER MASTER is not public: before this module, choosing your company meant
// searching a public endpoint over all 355 real customers, so anyone holding the
// catalog link could enumerate the customer book by typing letters. The code
// replaces that search entirely — it IDENTIFIES the customer, so there is nothing
// left to search and nothing to enumerate.
//
// THREAT MODEL — read before changing the alphabet or length.
// A code is a shared secret sent to one company over WhatsApp or email. It is not
// a password: it is not per-person, it is not secret from that company's staff,
// and it protects ordering, not money. 31^8 ≈ 8.5e11 combinations, paired with
// per-IP rate limiting in `customer-access.js`, is the defence. Guessing is
// infeasible; forwarding is the real risk, which is why a code can be reissued.
//
// Codes are stored IN PLAIN TEXT, deliberately. Staff must be able to read a
// customer's code back in order to send it, so a one-way hash would make the
// feature impossible. This is the same trade a door code makes. It is why a code
// must never be reused as a password anywhere.
import crypto from 'node:crypto';

/**
 * Deliberately excludes 0/O/1/I/L — the characters people confuse when copying a
 * code off a phone screen. 31 symbols; nothing ambiguous survives generation, so
 * a mistyped lookalike simply fails and is retried rather than silently matching
 * a DIFFERENT customer's code.
 */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 8;

/** Generate one code. Uses rejection sampling so every symbol is equally likely. */
export function generateAccessCode(length = CODE_LENGTH) {
  const n = CODE_ALPHABET.length;
  // 256 % 31 !== 0, so taking a raw byte modulo the alphabet would favour the
  // first few symbols. Discard bytes in the biased tail instead.
  const limit = Math.floor(256 / n) * n;
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= limit) continue;
      out += CODE_ALPHABET[byte % n];
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Normalise what a customer typed. Case-insensitive, and separators, spaces and
 * any character outside the alphabet are dropped — so "7k2m-9xqr", "7K2M 9XQR"
 * and "7K2M9XQR" are the same code. Nothing is substituted: a typed `O` or `1`
 * is not silently mapped onto another symbol.
 */
export function normalizeAccessCode(input) {
  return String(input ?? '').toUpperCase().split('').filter((c) => CODE_ALPHABET.includes(c)).join('');
}

/** How a code is shown to staff and sent to a customer: 7K2M-9XQR. */
export function formatAccessCode(code) {
  const c = normalizeAccessCode(code);
  if (c.length !== CODE_LENGTH) return c;
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

/** Constant-time compare, so a wrong code cannot be narrowed down by timing. */
export function codesMatch(left, right) {
  const a = crypto.createHash('sha256').update(String(left ?? '')).digest();
  const b = crypto.createHash('sha256').update(String(right ?? '')).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Give a customer a code, generating one that is not already taken.
 * Reissuing REPLACES the old code, which is how a leaked or forwarded code is
 * revoked: the previous one stops working immediately.
 */
export function issueAccessCode(db, customerId, now = new Date()) {
  const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(customerId));
  if (!customer) return null;

  let code = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = generateAccessCode();
    const taken = db.prepare('SELECT 1 FROM customers WHERE access_code = ?').get(candidate);
    if (!taken) { code = candidate; break; }
  }
  if (!code) throw new Error('Could not generate a unique access code.');

  db.prepare('UPDATE customers SET access_code = ?, access_code_issued_at = ?, updated_at = ? WHERE id = ?')
    .run(code, now.toISOString(), now.toISOString(), Number(customerId));
  return code;
}

/** Give a code to every active customer that has none. Returns how many. */
export function backfillAccessCodes(db, now = new Date()) {
  const rows = db.prepare('SELECT id FROM customers WHERE is_active = 1 AND (access_code IS NULL OR access_code = \'\')').all();
  for (const row of rows) issueAccessCode(db, row.id, now);
  return rows.length;
}

/**
 * Resolve a typed code to its customer.
 *
 * Compares in constant time against every candidate rather than looking the code
 * up in an index, so the database cannot leak a near-miss through timing. At a few
 * hundred customers this is far too fast to matter.
 *
 * An INACTIVE customer never resolves: deactivating a customer revokes access.
 */
export function resolveAccessCode(db, input) {
  const code = normalizeAccessCode(input);
  if (code.length !== CODE_LENGTH) return null;
  const rows = db.prepare(
    'SELECT id, name, access_code, delivery_address FROM customers WHERE is_active = 1 AND access_code IS NOT NULL'
  ).all();
  for (const row of rows) {
    // delivery_address travels with the match so the sign-in reply can pre-fill
    // it; the caller decides what reaches the browser.
    if (codesMatch(row.access_code, code)) {
      return { id: row.id, name: row.name, delivery_address: row.delivery_address || null };
    }
  }
  return null;
}

/** Staff view: who holds which code. Internal only — never customer-facing. */
export function listCustomerCodes(db, { q = '', limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const term = `%${String(q ?? '').trim()}%`;
  const total = db.prepare('SELECT COUNT(*) n FROM customers WHERE name LIKE ?').get(term).n;
  const items = db.prepare(
    `SELECT id, name, access_code, access_code_issued_at, is_active, phone, email
       FROM customers WHERE name LIKE ?
      ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`
  ).all(term, lim, off);
  return {
    total,
    limit: lim,
    offset: off,
    items: items.map((c) => ({ ...c, access_code_display: c.access_code ? formatAccessCode(c.access_code) : null })),
  };
}

export default {
  generateAccessCode, normalizeAccessCode, formatAccessCode,
  issueAccessCode, backfillAccessCodes, resolveAccessCode, listCustomerCodes,
};
