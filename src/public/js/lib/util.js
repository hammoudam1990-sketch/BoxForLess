// Small utilities shared by the catalogue modules.

/** Run `fn` once `ms` after the LAST call. `.cancel()` drops a pending run. */
export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  return wrapped;
}

/**
 * A bag of clean-up functions. A view adds an unsubscribe for everything it listens to;
 * `dispose()` runs them all when the view is thrown away, so nothing keeps firing for
 * elements that are no longer on the page.
 */
export function createScope() {
  const fns = [];
  return {
    add(fn) { fns.push(fn); return fn; },
    dispose() { while (fns.length) { try { fns.pop()(); } catch { /* keep disposing */ } } },
  };
}

/**
 * Guards an async load against its own staleness: call `const mine = latest.next()` before
 * fetching and `if (!latest.is(mine)) return` after, so a slow reply to an old query can
 * never overwrite the reply to the current one.
 */
export function createLatest() {
  let n = 0;
  return { next: () => ++n, is: (mine) => mine === n };
}

export const prefersReducedMotion = () =>
  Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

let revealObserver = null;
/**
 * Reveal-on-scroll: `el` fades and rises into place the first time it scrolls into view.
 * Nothing is hidden unless JavaScript runs, IntersectionObserver exists and the person has
 * not asked for reduced motion; in every other case the element is simply shown.
 */
export function reveal(el) {
  if (!('IntersectionObserver' in window) || prefersReducedMotion()) return;
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('c-in');
        revealObserver.unobserve(e.target);
      }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  }
  el.classList.add('c-reveal');
  revealObserver.observe(el);
}

/** Ease a number up (or down) to `to`, writing each step with `write(value)`. */
export function tween(from, to, write, ms = 520) {
  let raf = 0;
  const still = prefersReducedMotion() || document.visibilityState === 'hidden' || from === to;
  if (still) { write(to); return () => {}; }
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / ms);
    write(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));   // ease-out
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/**
 * Slip `header` away while the page is scrolled DOWN past the top, and bring it back the
 * moment the person scrolls up. One check per animation frame.
 */
export function hideHeaderOnScroll(header, { after = 140, delta = 10 } = {}) {
  let last = window.scrollY;
  let ticking = false;
  const check = () => {
    ticking = false;
    const y = window.scrollY;
    if (Math.abs(y - last) < delta) return;
    header.classList.toggle('c-header-hidden', y > last && y > after);
    last = y;
  };
  window.addEventListener('scroll', () => {
    if (!ticking) { ticking = true; requestAnimationFrame(check); }
  }, { passive: true });
}
