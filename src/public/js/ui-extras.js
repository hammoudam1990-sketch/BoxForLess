// Small features every page shares, in plain JavaScript:
//   - a thin scroll-progress bar at the top
//   - a loading bar (driven by the fetch wrapper in theme-init.js)
//   - a dark-mode toggle and a scroll-to-top button, floating at the bottom right
//   - a simple cookie notice
// They are injected into <body>, so no page needs its own markup for them.
const $ = (tag, attrs = {}, html = '') => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.innerHTML = html;
  return el;
};
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked: the choice lasts this visit */ } },
};

const MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
const SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const UP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

// ---- theme ----
const root = document.documentElement;
const isDark = () => root.getAttribute('data-theme') === 'dark';
function setTheme(dark) {
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
  storage.set('bfl.theme', dark ? 'dark' : 'light');
  syncThemeButton();
  window.dispatchEvent(new CustomEvent('bfl:theme', { detail: { dark } }));
}
/** Other scripts (the mobile menu) switch the theme through this. */
window.bflTheme = { toggle: () => setTheme(!isDark()), isDark };

const themeBtn = $('button', { class: 'bfl-fab bfl-theme', type: 'button' });
function syncThemeButton() {
  themeBtn.innerHTML = isDark() ? SUN : MOON;
  themeBtn.setAttribute('aria-label', isDark() ? 'Switch to light mode' : 'Switch to dark mode');
  themeBtn.setAttribute('aria-pressed', String(isDark()));
  themeBtn.title = themeBtn.getAttribute('aria-label');
}
themeBtn.addEventListener('click', () => window.bflTheme.toggle());

// ---- scroll to top ----
const topBtn = $('button', { class: 'bfl-fab bfl-top', type: 'button', 'aria-label': 'Scroll to top', title: 'Scroll to top' }, UP);
topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

// ---- progress bar ----
const progress = $('div', { class: 'bfl-progress', 'aria-hidden': 'true' }, '<i></i>');
const loadbar = $('div', { class: 'bfl-loadbar', 'aria-hidden': 'true' }, '<i></i>');
const bar = progress.firstChild;
let ticking = false;
function onScroll() {
  ticking = false;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  const y = window.scrollY;
  bar.style.transform = `scaleX(${max > 0 ? Math.min(1, y / max) : 0})`;
  topBtn.classList.toggle('show', y > 600);
}
window.addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
window.addEventListener('resize', onScroll);

// ---- cookie notice ----
// The site sets only the cookies it needs: staff sign-in, a customer's access-code session. It
// stores the request cart and this theme choice in the browser. There is no tracking or advertising.
function cookieNotice() {
  if (storage.get('bfl.cookies') === 'ok') return null;
  const box = $('div', { class: 'bfl-cookie', role: 'region', 'aria-label': 'Cookies' },
    '<p>We use only the cookies this site needs: to keep you signed in and to remember your request and your theme. No tracking, no advertising.</p>');
  const ok = $('button', { type: 'button' }, 'OK, got it');
  ok.addEventListener('click', () => { storage.set('bfl.cookies', 'ok'); box.remove(); });
  box.appendChild(ok);
  return box;
}

function start() {
  syncThemeButton();
  const fabs = $('div', { class: 'bfl-fabs' });
  fabs.append(topBtn, themeBtn);
  document.body.append(progress, loadbar, fabs);
  const notice = cookieNotice();
  if (notice) document.body.appendChild(notice);
  onScroll();
}
if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
