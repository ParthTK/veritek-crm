import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker, useSearchParams } from 'react-router-dom';
import { api, newKey, authedBlobUrl } from '../api.js';

/** Fetch JSON; keeps previous data while reloading. Pass null as path to skip. */
export function useApi(path, query) {
  const key = path ? `${path}?${JSON.stringify(query || {})}` : null;
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(path) });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return Promise.resolve();
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    return api.get(path, query).then(
      (data) => {
        if (id === seq.current) setState({ data, error: null, loading: false });
        return data;
      },
      (error) => {
        if (id === seq.current) setState((s) => ({ ...s, error, loading: false }));
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

/** Filters stored in the URL so views are shareable, survive refresh and drill-downs keep their filters. */
export function useUrlFilters(defaults = {}) {
  const [params, setParams] = useSearchParams();
  const filters = { ...defaults };
  for (const [k, v] of params.entries()) filters[k] = v;
  const setFilter = useCallback((updates) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(updates)) {
        if (v === undefined || v === null || v === '' || v === defaults[k]) next.delete(k);
        else next.set(k, v);
      }
      if (!('page' in updates)) next.delete('page');
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setParams]);
  return [filters, setFilter];
}

export function useDebounced(value, delay = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/**
 * Save state for a form: busy flag, field errors next to inputs, last saved time and a retry that reuses
 * the same idempotency key (so a retried save can never create a duplicate).
 */
export function useSave() {
  const [state, setState] = useState({ saving: false, error: null, fields: {}, savedAt: null, conflict: null });
  const keyRef = useRef(newKey());
  const lastFn = useRef(null);
  const run = useCallback(async (fn) => {
    lastFn.current = fn;
    setState((s) => ({ ...s, saving: true, error: null, fields: {}, conflict: null }));
    try {
      const out = await fn(keyRef.current);
      keyRef.current = newKey();
      setState({ saving: false, error: null, fields: {}, savedAt: new Date(), conflict: null });
      return out;
    } catch (err) {
      setState((s) => ({
        ...s, saving: false, error: err, fields: err.fields || {},
        conflict: err.status === 409 && ['version_conflict', 'stale_report'].includes(err.code) ? err : null,
      }));
      return undefined;
    }
  }, []);
  const retry = useCallback(() => (lastFn.current ? run(lastFn.current) : undefined), [run]);
  const reset = useCallback(() => setState({ saving: false, error: null, fields: {}, savedAt: null, conflict: null }), []);
  return { ...state, run, retry, reset, key: keyRef };
}

/** Warns before leaving a page (or closing the tab) with unsaved edits. */
export function useUnsavedGuard(dirty, message = 'You have unsaved changes. Leave without saving?') {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      // eslint-disable-next-line no-alert
      if (window.confirm(message)) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker, message]);
  useEffect(() => {
    if (!dirty) return undefined;
    const onBefore = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);
}

/** Loads an authenticated image (QR / barcode) as a blob URL; the session token never goes in a URL. */
export function useBlobUrl(path) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!path) return undefined;
    let alive = true;
    let made = null;
    authedBlobUrl(path).then((u) => { made = u; if (alive) setUrl(u); }).catch(() => alive && setUrl(null));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [path]);
  return url;
}

/** Width of an element, updated on resize (charts size themselves to their card). */
export function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

/** Runs a one-off action with a busy flag; failures go to a toast, success optionally too. */
export function useAction(toast) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, successMessage) => {
    setBusy(true);
    try {
      const out = await fn();
      if (successMessage) toast?.success(successMessage);
      return out;
    } catch (err) {
      toast?.error(err.message);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [busy, run];
}

export function useMediaQuery(q) {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [q]);
  return match;
}
