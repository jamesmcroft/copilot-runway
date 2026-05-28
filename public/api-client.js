// Tiny fetch helper for the dashboard UI. Works in browser and Node so the
// same module is used client-side and from tests. The key contract is that
// callers can pass an `AbortSignal` via `options.signal`, which is forwarded
// to the underlying fetch so in-flight requests can be cancelled (issue #49).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ApiClient = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function createClient(fetchImpl) {
    const fetchFn = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) {
      throw new Error('[runway] ApiClient requires a fetch implementation');
    }

    // Bind once so callers in either environment get a sane `this`.
    const boundFetch = typeof fetchImpl === 'function'
      ? fetchImpl
      : fetchFn.bind(typeof self !== 'undefined' ? self : globalThis);

    async function apiFetch(path, options) {
      const opts = options || {};
      // Spread to a fresh object so callers do not mutate the original. The
      // `signal` (when provided) flows through unchanged; callers rely on
      // this for AbortController-based cancellation.
      return boundFetch(path, { ...opts });
    }

    async function apiJson(path, options) {
      const res = await apiFetch(path, options);
      return res.json();
    }

    async function searchSessions(q, options) {
      const opts = options || {};
      const params = new URLSearchParams();
      params.set('q', q);
      if (opts.limit != null) params.set('limit', String(opts.limit));
      if (opts.cursor != null) params.set('cursor', String(opts.cursor));
      const fetchOpts = {};
      if (opts.signal) fetchOpts.signal = opts.signal;
      const res = await boundFetch(`/api/sessions/search?${params.toString()}`, fetchOpts);
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    async function searchStatus(options) {
      const opts = options || {};
      const fetchOpts = {};
      if (opts.signal) fetchOpts.signal = opts.signal;
      try {
        const res = await boundFetch('/api/sessions/search/status', fetchOpts);
        if (!res.ok) return { available: false };
        const body = await res.json();
        return { available: !!body.available };
      } catch {
        return { available: false };
      }
    }

    return { apiFetch, apiJson, searchSessions, searchStatus };
  }

  // Default instance uses the ambient fetch. Tests can call createClient with
  // a stub instead.
  const defaultClient = (typeof fetch !== 'undefined') ? createClient() : null;

  return {
    createClient,
    apiFetch: defaultClient ? defaultClient.apiFetch : null,
    apiJson: defaultClient ? defaultClient.apiJson : null,
    searchSessions: defaultClient ? defaultClient.searchSessions : null,
    searchStatus: defaultClient ? defaultClient.searchStatus : null,
  };
});
