// Shared pieces for the end-to-end journey test: a running app with REAL sign-in, people in every role,
// and thin wrappers over the HTTP API, so the journey reads like a demo script.
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';

export const ADMIN_USER = 'owner';
export const ADMIN_PASS = 'owner-secret-passphrase';
export const PW = 'correct horse battery';

/** Switch real staff authentication on for this test file (the test-runner bypass off). Call before importing the app. */
export function realAuth() {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  process.env.BFL_STAFF_USERNAME = ADMIN_USER;
  process.env.BFL_STAFF_PASSWORD = ADMIN_PASS;
  process.env.BFL_SESSION_SECRET = crypto.randomBytes(24).toString('hex');
  return () => { if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved; };
}

export async function startApp(createApp, db) {
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const cookiesOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');

/** A person using the API: remembers their cookie, and says what each call returned. */
export class Person {
  constructor(base, label) { this.base = base; this.label = label; this.cookie = ''; }

  async call(path, { method = 'GET', body } = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'Content-Type': 'application/json', origin: this.base, ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON (a CSV, say) */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  /** Call and require success: the message says who did what, so a failure reads like a story. */
  async ok(path, opts = {}, expect = 200) {
    const r = await this.call(path, opts);
    assert.equal(r.status, expect, `${this.label}: ${opts.method || 'GET'} ${path} -> ${r.status} ${r.text.slice(0, 200)}`);
    return r.json;
  }

  async staffLogin(identifier, password) {
    const res = await fetch(`${this.base}/api/staff/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', origin: this.base }, body: JSON.stringify({ identifier, password }),
    });
    assert.equal(res.status, 200, `${this.label}: staff sign-in`);
    this.cookie = cookiesOf(res);
    return res.json();
  }

  async customerLogin(id, password) {
    const res = await fetch(`${this.base}/api/auth/customer/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', origin: this.base }, body: JSON.stringify({ id, password }),
    });
    assert.equal(res.status, 200, `${this.label}: customer sign-in`);
    this.cookie = cookiesOf(res);
    return res.json();
  }
}

export const money = (n) => Math.round(n * 100) / 100;
export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const find = (section, pred) => section.rows.find(pred);
export const sectionOf = (report, id) => {
  const s = report.sections.find((x) => x.id === id);
  assert.ok(s, `the report has a "${id}" section`);
  return s;
};
