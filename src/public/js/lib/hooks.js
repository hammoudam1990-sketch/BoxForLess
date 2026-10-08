// Small hooks shared by the staff, scanner and catalogue apps.
import { useEffect, useRef, useState, useCallback } from './react.js';

/**
 * Run an async loader and track its result.
 *
 * `load` is re-run whenever a value in `deps` changes. A response that arrives
 * after the inputs have already changed again is DISCARDED, so a slow reply to an
 * old search can never overwrite the reply to the current one.
 *
 * @returns {{data:any, error:Error|null, loading:boolean, reload:Function}}
 */
export function useAsync(load, deps) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, error: null, loading: true }));
    Promise.resolve()
      .then(() => loadRef.current())
      .then(
        (data) => { if (current) setState({ data, error: null, loading: false }); },
        (error) => { if (current) setState({ data: null, error, loading: false }); },
      );
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

/** A value that only follows `value` once it has stopped changing for `ms`. */
export function useDebounced(value, ms) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** Re-render on the browser's hashchange; returns the current hash. */
export function useHash() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

/**
 * Reveal-on-scroll. Returns [ref, className]: put both on an element and it fades and
 * rises into place the first time it scrolls into view.
 *
 * Nothing is hidden unless JavaScript runs, IntersectionObserver exists and the person
 * has not asked for reduced motion; in every other case the element is simply shown.
 */
export function useReveal() {
  const ref = useRef(null);
  const canAnimate = typeof window !== 'undefined'
    && 'IntersectionObserver' in window
    && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [seen, setSeen] = useState(!canAnimate);

  useEffect(() => {
    const el = ref.current;
    if (seen || !el) return undefined;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  return [ref, canAnimate ? `c-reveal${seen ? ' c-in' : ''}` : ''];
}

/**
 * A number that eases up to `target` (and between targets) instead of jumping.
 * Returns the number to display. With reduced motion, a hidden tab or no target it
 * simply returns the target.
 */
export function useCountUp(target, ms = 520) {
  const [shown, setShown] = useState(target);
  const from = useRef(0);
  useEffect(() => {
    if (target === null || target === undefined) { setShown(target); return undefined; }
    const still = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      || document.visibilityState === 'hidden';
    if (still) { from.current = target; setShown(target); return undefined; }
    const start = performance.now();
    const origin = from.current;
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);                 // ease-out
      const v = Math.round(origin + (target - origin) * eased);
      from.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return shown;
}

/**
 * True while the page is being scrolled DOWN past the top — so a sticky header can slip
 * away and give a phone its screen back — and false the moment the person scrolls up
 * or is near the top. Throttled to one check per animation frame.
 */
export function useHideOnScroll({ after = 140, delta = 10 } = {}) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    let ticking = false;
    const check = () => {
      ticking = false;
      const y = window.scrollY;
      if (Math.abs(y - last) < delta) return;
      setHidden(y > last && y > after);
      last = y;
    };
    const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(check); } };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [after, delta]);
  return hidden;
}
