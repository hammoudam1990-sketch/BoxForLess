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
