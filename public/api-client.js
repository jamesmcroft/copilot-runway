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

    return { apiFetch, apiJson };
  }

  // Default instance uses the ambient fetch. Tests can call createClient with
  // a stub instead.
  const defaultClient = (typeof fetch !== 'undefined') ? createClient() : null;

  return {
    createClient,
    apiFetch: defaultClient ? defaultClient.apiFetch : null,
    apiJson: defaultClient ? defaultClient.apiJson : null,
  };
});
