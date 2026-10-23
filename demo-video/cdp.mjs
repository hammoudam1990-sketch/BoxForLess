// A tiny Chrome DevTools driver (no packages): start a headless Chrome, open one page, and give it the few
// verbs the demo video needs — go to a page, run script in it, click, type, wait, and take a PNG.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

export async function launch(port = 9333) {
  if (!CHROME) throw new Error('No Chrome or Edge found.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bfl-video-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run',
    '--disable-gpu', '--force-color-profile=srgb', '--font-render-hinting=none', 'about:blank',
  ], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 60 && !target; i += 1) {
    await sleep(250);
    try { target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json(); } catch { /* not up yet */ }
  }
  if (!target) throw new Error('Chrome did not start.');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return new Page(ws, proc, profile);
}

class Page {
  constructor(ws, proc, profile) {
    this.ws = ws; this.proc = proc; this.profile = profile; this.id = 0; this.waiting = new Map(); this.events = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.waiting.has(msg.id)) { const { res, rej } = this.waiting.get(msg.id); this.waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
      else if (msg.method) this.events.push(msg.method);
    };
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => { this.waiting.set(id, { res, rej }); });
  }

  async init() {
    await this.send('Page.enable'); await this.send('Runtime.enable');
  }

  /** Screen size. mobile = a phone (touch, mobile layout). */
  async view(width, height, { mobile = false, scale = 1 } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile });
  }

  async goto(url, settle = 900) {
    this.events.length = 0;
    await this.send('Page.navigate', { url });
    for (let i = 0; i < 80 && !this.events.includes('Page.loadEventFired'); i += 1) await sleep(100);
    await sleep(settle);
  }

  /** Run script in the page; the value comes back (promises are awaited). */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text}: ${r.exceptionDetails.exception?.description || ''}`.slice(0, 400));
    return r.result.value;
  }

  async waitFor(expression, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await this.eval(`Boolean(${expression})`).catch(() => false)) return true; await sleep(150); }
    throw new Error(`Timed out waiting for: ${expression}`);
  }

  /** Click the first VISIBLE element matching `selector` whose text contains `text` (if given). */
  async click(selector, text = '') {
    const ok = await this.eval(`(() => {
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => vis(e) && (!${JSON.stringify(text)} || e.innerText.includes(${JSON.stringify(text)})));
      if (!el) return false; el.scrollIntoView({ behavior: 'instant', block: 'center' }); el.click(); return true; })()`);
    if (!ok) throw new Error(`Nothing to click: ${selector} ${text}`);
    await sleep(350);
  }

  /** Put text in a field the way typing does (the page sees input events). */
  async type(selector, value) {
    const ok = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false;
      el.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    if (!ok) throw new Error(`No field: ${selector}`);
  }

  /** An orange outline around what the viewer should look at (removed by unmark). */
  async mark(selector, text = '') {
    await this.eval(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => !${JSON.stringify(text)} || e.innerText.includes(${JSON.stringify(text)}));
      if (!el) return false; el.scrollIntoView({ behavior: 'instant', block: 'center' }); el.setAttribute('data-marked', '1');
      el.style.outline = '4px solid #e4571a'; el.style.outlineOffset = '4px'; el.style.borderRadius = '10px'; return true; })()`);
    await sleep(250);
  }

  async unmark() {
    await this.eval(`document.querySelectorAll('[data-marked]').forEach((e) => { e.style.outline = ''; e.style.outlineOffset = ''; e.removeAttribute('data-marked'); })`);
  }

  async shot() {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    return Buffer.from(r.data, 'base64');
  }

  async close() {
    try { this.ws.close(); } catch { /* already closed */ }
    this.proc.kill();
    await sleep(500);
    try { fs.rmSync(this.profile, { recursive: true, force: true }); } catch { /* chrome still releasing it */ }
  }
}
