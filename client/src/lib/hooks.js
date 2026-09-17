import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

/**
 * Fetch JSON from the API. Keeps the previous data while reloading so screens don't flash.
 * Pass `null` as path to skip.
 */
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

  const setData = useCallback((updater) => setState((s) => ({ ...s, data: typeof updater === 'function' ? updater(s.data) : updater })), []);
  return { ...state, reload: load, setData };
}

/** Filters stored in the URL so views are shareable and survive refresh. */
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
  const clear = useCallback(() => setParams(new URLSearchParams(), { replace: true }), [setParams]);
  return [filters, setFilter, clear];
}

export function useDebounced(value, delay = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

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

/** Run an async action with a busy flag and toast on failure. */
export function useAction(toast) {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn, successMessage) => {
    setBusy(true);
    try {
      const result = await fn();
      if (successMessage) toast?.success(successMessage);
      return result;
    } catch (err) {
      toast?.error(err.message || 'Something went wrong');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return [run, busy];
}
