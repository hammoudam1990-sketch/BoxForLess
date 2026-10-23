// Passwords: hashing, checking, and the few rules worth enforcing.
//
// scrypt (built into Node, memory-hard) with a random salt per password. The stored form is
// "scrypt$N$r$p$salt$hash" so the cost can be raised later without breaking old hashes. A password
// is never stored, logged or returned; only this string is kept.
import crypto from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

// Passwords nobody should be allowed to pick. Short on purpose: length matters more than a list.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyui', 'qwerty123',
  'iloveyou', 'boxforless', 'welcome1', 'abcd1234', '11111111', '00000000', 'letmein1',
]);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

// A real hash of a throwaway password, checked when the account does not exist, so "no such
// account" takes as long as "wrong password" and the difference cannot be timed.
const DUMMY = hashPassword(crypto.randomBytes(12).toString('hex'));

/** True when `password` matches `stored`. Pass a null/garbage `stored` and it still spends the same time and answers false. */
export function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split('$');
  const real = parts.length === 6 && parts[0] === 'scrypt' && stored;
  const [, n, r, p, salt, hash] = real ? parts : DUMMY.split('$');
  try {
    const expected = Buffer.from(hash, 'base64');
    const actual = crypto.scryptSync(String(password ?? ''), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
    return Boolean(real) && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

/**
 * Why this password is not acceptable, in words for the person choosing it, or null when it is.
 * @param {string} password
 * @param {string[]} [mustNotContain] things it may not equal or contain (their ID, phone, email, name)
 */
export function passwordProblem(password, mustNotContain = []) {
  const pw = String(password ?? '');
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > MAX_PASSWORD_LENGTH) return 'That password is too long.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too easy to guess. Choose another.';
  if (/^(.)\1+$/.test(pw)) return 'Do not repeat one character. Choose another password.';
  const lower = pw.toLowerCase();
  for (const bit of mustNotContain) {
    const b = String(bit ?? '').trim().toLowerCase();
    if (b.length >= 4 && lower.includes(b)) return 'Your password must not contain your ID, phone number, email or name.';
  }
  return null;
}

/** A readable one-time password for a new staff account: three groups of letters and digits, no look-alikes. */
export function temporaryPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const group = () => Array.from(crypto.randomBytes(4), (b) => alphabet[b % alphabet.length]).join('');
  return `${group()}-${group()}-${group()}`;
}
