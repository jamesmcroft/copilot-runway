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

    // Settings endpoints. Mirrors the route shape in lib/routes/settings.js.
    // Read paths return the parsed JSON document directly so callers can
    // treat them as plain data. Write paths return either { values } on
    // success (HTTP 200) or { error, errors } on validation failure.
    async function getSettings() {
      const res = await boundFetch('/api/settings');
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    async function patchSettings(patch) {
      const res = await boundFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    async function putSettings(doc) {
      const res = await boundFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc || {}),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    async function getProjectSettings(projectKey) {
      const res = await boundFetch(`/api/settings/projects/${encodeURIComponent(projectKey)}`);
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    async function patchProjectSettings(projectKey, patch) {
      const res = await boundFetch(`/api/settings/projects/${encodeURIComponent(projectKey)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch || {}),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    async function putProjectSettings(projectKey, doc) {
      const res = await boundFetch(`/api/settings/projects/${encodeURIComponent(projectKey)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc || {}),
      });
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    async function getSettingsSchema() {
      const res = await boundFetch('/api/settings/schema');
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    }

    // Resolved view of every setting for the optional project context.
    // Returns the parsed `{ values }` document directly so callers can
    // read `resolved.defaults.agent` without status-checking on the
    // happy path. On any error the function returns an empty values
    // object so dropdown defaults degrade gracefully.
    async function getResolvedSettings(projectKey) {
      const qs = projectKey ? `?project=${encodeURIComponent(projectKey)}` : '';
      try {
        const res = await boundFetch(`/api/settings/resolved${qs}`);
        if (!res.ok) return { values: {} };
        const body = await res.json().catch(() => ({}));
        return (body && typeof body === 'object') ? body : { values: {} };
      } catch {
        return { values: {} };
      }
    }

    return {
      apiFetch,
      apiJson,
      searchSessions,
      searchStatus,
      getSettings,
      patchSettings,
      putSettings,
      getProjectSettings,
      patchProjectSettings,
      putProjectSettings,
      getSettingsSchema,
      getResolvedSettings,
    };
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
    getSettings: defaultClient ? defaultClient.getSettings : null,
    patchSettings: defaultClient ? defaultClient.patchSettings : null,
    putSettings: defaultClient ? defaultClient.putSettings : null,
    getProjectSettings: defaultClient ? defaultClient.getProjectSettings : null,
    patchProjectSettings: defaultClient ? defaultClient.patchProjectSettings : null,
    putProjectSettings: defaultClient ? defaultClient.putProjectSettings : null,
    getSettingsSchema: defaultClient ? defaultClient.getSettingsSchema : null,
    getResolvedSettings: defaultClient ? defaultClient.getResolvedSettings : null,
  };
});
