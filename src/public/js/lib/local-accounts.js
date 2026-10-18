// Customer accounts kept in the browser's localStorage — a front-end stand-in until the
// Phase 2 server accounts exist. Nothing here reaches the server, and nothing here is
// security: anyone with the device can read localStorage. It exists so the sign-in,
// register and "Signed in as" screens can be built and tried end to end.
//
// When the real accounts arrive, replace this module's functions with API calls; the
// pages only use the exported functions, never the storage keys.

const ACCOUNTS_KEY = 'bfl.local.accounts.v1';
const SESSION_KEY = 'bfl.local.session.v1';
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;   // "Remember me" ticked
const SHORT_MS = 12 * 60 * 60 * 1000;           // not ticked
export const MIN_PASSWORD = 8;

// Demo accounts, created once per browser so there is always something to sign in with.
const DEMO_PASSWORD = 'Demo1234';
const DEMO_ACCOUNTS = [
  { company: 'Demo Credit Shop Ltd', contact: 'Ama Mensah', phone: '0200000001', email: 'credit@demo.bfl',
    address: 'Shop 4, Demo Market Road, Accra', type: 'credit', status: 'approved' },
  { company: 'Demo Cash Buyer', contact: 'Kofi Boateng', phone: '0200000002', email: 'cash@demo.bfl',
    address: 'House 12, Demo Street, Kumasi', type: 'cash', status: 'approved' },
  { company: 'Demo Pending Traders', contact: 'Esi Owusu', phone: '0200000003', email: 'pending@demo.bfl',
    address: 'Unit 7, Demo Close, Tema', type: null, status: 'pending' },
];
export const DEMO_LOGINS = DEMO_ACCOUNTS.map(({ email, status, type }) => ({ email, password: DEMO_PASSWORD, status, type }));

// ------------------------------------------------------------------ SHA-256
// Plain JavaScript, because crypto.subtle is missing on plain-http LAN addresses (phones).
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const hash = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0; hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0; hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0; hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0; hash[7] = (hash[7] + h) >>> 0;
  }
  return hash.map((x) => x.toString(16).padStart(8, '0')).join('');
}

// ------------------------------------------------------------------ helpers
/** Phone numbers compare by digits; +233 24… and 024… are the same Ghana number. */
export function phoneKey(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('233') && digits.length === 12) return `0${digits.slice(3)}`;
  return digits;
}
const emailKey = (email) => String(email || '').trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function randomId(prefix) {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
const hashPassword = (salt, password) => sha256(`${salt}:${password}`);

/** What a page may show: the account without its password hash and salt. */
function publicView(account) {
  if (!account) return null;
  const { passwordHash, salt, ...rest } = account;
  return rest;
}

// ------------------------------------------------------------------ the store
/**
 * An account store over any Storage-like object (localStorage in the browser, a fake in tests).
 * Every read and write is wrapped: a private window or blocked storage just means "no accounts".
 */
export function createAccountStore(storage, now = () => Date.now()) {
  function read(key, fallback) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  function write(key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  const accounts = () => read(ACCOUNTS_KEY, []);
  const saveAccounts = (list) => write(ACCOUNTS_KEY, list);

  function makeAccount(fields, password, extra = {}) {
    const salt = randomId('');
    return {
      id: randomId('acc_'),
      company: fields.company.trim(),
      contact: fields.contact.trim(),
      phone: fields.phone.trim(),
      email: emailKey(fields.email),
      address: fields.address.trim(),
      type: null,              // credit or cash: the Sales Manager decides on approval
      status: 'pending',
      salt,
      passwordHash: hashPassword(salt, password),
      createdAt: new Date(now()).toISOString(),
      ...extra,
    };
  }

  function seedDemo() {
    const list = accounts();
    let changed = false;
    for (const demo of DEMO_ACCOUNTS) {
      if (list.some((a) => a.email === demo.email)) continue;
      list.push(makeAccount(demo, DEMO_PASSWORD, { type: demo.type, status: demo.status, demo: true }));
      changed = true;
    }
    if (changed) saveAccounts(list);
  }

  function findByIdentifier(identifier) {
    const value = String(identifier || '').trim();
    if (!value) return null;
    const list = accounts();
    if (value.includes('@')) return list.find((a) => a.email === emailKey(value)) || null;
    const key = phoneKey(value);
    return (key && list.find((a) => phoneKey(a.phone) === key)) || null;
  }

  /** Check a registration; returns { field, error } for the first problem, or null. */
  function validateRegistration(fields) {
    const f = (name) => String(fields[name] || '').trim();
    if (!f('company')) return { field: 'company', error: 'Enter your company or shop name.' };
    if (!f('contact')) return { field: 'contact', error: 'Enter the name of the contact person.' };
    if (phoneKey(f('phone')).length < 9) return { field: 'phone', error: 'Enter a phone number with at least 9 digits.' };
    if (!EMAIL_RE.test(f('email'))) return { field: 'email', error: 'Enter an email address such as name@company.com.' };
    if (!f('address')) return { field: 'address', error: 'Enter the delivery address.' };
    const password = String(fields.password || '');
    if (password.length < MIN_PASSWORD) return { field: 'password', error: `Use at least ${MIN_PASSWORD} characters for the password.` };
    if (password !== String(fields.confirm || '')) return { field: 'confirm', error: 'The two passwords do not match.' };
    const list = accounts();
    if (list.some((a) => a.email === emailKey(f('email')))) {
      return { field: 'email', error: 'An account with this email already exists. Sign in instead.' };
    }
    if (list.some((a) => phoneKey(a.phone) === phoneKey(f('phone')))) {
      return { field: 'phone', error: 'An account with this phone number already exists. Sign in instead.' };
    }
    return null;
  }

  function register(fields) {
    const problem = validateRegistration(fields);
    if (problem) return { ok: false, ...problem };
    const account = makeAccount(fields, String(fields.password));
    const list = accounts();
    list.push(account);
    if (!saveAccounts(list)) return { ok: false, error: 'This browser is not letting the page save. Turn off private browsing and try again.' };
    return { ok: true, account: publicView(account) };
  }

  function signIn(identifier, password, remember = true) {
    const account = findByIdentifier(identifier);
    // one message for "no such account" and "wrong password", as a real sign-in would
    if (!account || account.passwordHash !== hashPassword(account.salt, String(password || ''))) {
      return { ok: false, error: 'The email, phone number or password is not correct.' };
    }
    if (account.status === 'pending') {
      return { ok: false, pending: true, error: `Your account for ${account.company} is waiting for approval. We will contact you once the Sales Manager has approved it.` };
    }
    if (account.status !== 'approved') {
      return { ok: false, error: 'This account cannot sign in. Please contact Box for Less.' };
    }
    const signedInAt = now();
    write(SESSION_KEY, { accountId: account.id, signedInAt, expiresAt: signedInAt + (remember ? REMEMBER_MS : SHORT_MS) });
    return { ok: true, account: publicView(account) };
  }

  function currentAccount() {
    const session = read(SESSION_KEY, null);
    if (!session || !session.accountId || !(session.expiresAt > now())) return null;
    const account = accounts().find((a) => a.id === session.accountId);
    return account && account.status === 'approved' ? publicView(account) : null;
  }

  function signOut() {
    try { storage.removeItem(SESSION_KEY); } catch { /* nothing to clear */ }
  }

  return { seedDemo, findByIdentifier, validateRegistration, register, signIn, currentAccount, signOut };
}

// The browser's store. localStorage itself can throw (blocked site data), so fall back to memory.
function browserStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem(ACCOUNTS_KEY);
    return s;
  } catch {
    const memory = new Map();
    return {
      getItem: (k) => (memory.has(k) ? memory.get(k) : null),
      setItem: (k, v) => { memory.set(k, String(v)); },
      removeItem: (k) => { memory.delete(k); },
    };
  }
}

let shared = null;
/** The page-wide account store, with the demo accounts in place. */
export function accounts() {
  if (!shared) {
    shared = createAccountStore(browserStorage());
    shared.seedDemo();
  }
  return shared;
}
