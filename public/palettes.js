// Runway palette manifest (issue #53).
//
// Palette is now a single concept (family name); light/dark mode is a
// separate user preference applied via data-theme on the body. Each
// palette CSS file declares both [data-theme="dark"] and
// [data-theme="light"] variants and is loaded on demand the first
// time the user picks the palette.
//
// `default` is a sentinel that maps back to the base stylesheet
// (styles.css [data-theme]) with no extra CSS file. The other entries
// each ship one CSS file with both theme variants inside.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RunwayPalettes = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const PALETTES = [
    { id: 'default',          label: 'Default',          file: null },
    { id: 'solarized',        label: 'Solarized',        file: 'palettes/solarized.css' },
    { id: 'monokai-inspired', label: 'Monokai-inspired', file: 'palettes/monokai-inspired.css' },
    { id: 'high-contrast',    label: 'High Contrast',    file: 'palettes/high-contrast.css' },
    { id: 'material',         label: 'Material',         file: 'palettes/material.css' },
    { id: 'tokyo-night',      label: 'Tokyo Night',      file: 'palettes/tokyo-night.css' },
    { id: 'catppuccin',       label: 'Catppuccin',       file: 'palettes/catppuccin.css' },
    { id: 'rose-pine',        label: 'Rose Pine',        file: 'palettes/rose-pine.css' },
  ];
  const DEFAULT_PALETTE = 'default';
  const STORAGE_KEY = 'runway:theme:palette';
  const THEME_STORAGE_KEY = 'copilot-dashboard-theme';

  // Migration map: previous releases shipped palette ids that bundled
  // the light/dark variant into the palette name. Normalize on read so
  // existing localStorage entries map to the new family ids without
  // changing the user's light/dark preference.
  const LEGACY_PALETTE_MAP = {
    'default-dark': 'default',
    'default-light': 'default',
    'solarized-dark': 'solarized',
    'solarized-light': 'solarized',
    'high-contrast-dark': 'high-contrast',
    'high-contrast-light': 'high-contrast',
  };

  function getById(id) {
    return PALETTES.find(p => p.id === id) || null;
  }

  // Resolve the active light/dark theme. Mirrors the inline bootstrap
  // in index.html / settings.html so any caller can derive the same
  // value without reading the DOM.
  function resolveTheme(opts) {
    const options = opts || {};
    const store = options.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    let pref = 'system';
    if (store) {
      try { pref = store.getItem(THEME_STORAGE_KEY) || 'system'; } catch { pref = 'system'; }
    }
    if (pref !== 'system') return pref;
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  }

  // Apply a palette by id. Idempotent: re-applying the same palette is
  // a no-op. Loading a palette CSS file is deferred to the first time
  // it is selected; subsequent selections reuse the already-injected
  // link element. Always re-asserts data-theme on the body so the
  // palette selectors (body[data-palette][data-theme]) match. Returns
  // the resolved palette entry.
  function applyPalette(id, opts) {
    const options = opts || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body) return null;
    const entry = getById(id) || getById(DEFAULT_PALETTE);
    doc.body.setAttribute('data-palette', entry.id);
    const theme = options.theme || resolveTheme(options);
    doc.body.setAttribute('data-theme', theme);
    if (entry.file) {
      const linkId = `palette-${entry.id}`;
      if (!doc.getElementById(linkId)) {
        const link = doc.createElement('link');
        link.id = linkId;
        link.rel = 'stylesheet';
        link.href = entry.file;
        doc.head.appendChild(link);
      }
    }
    return entry;
  }

  // Re-apply just the theme attribute on the body, leaving the palette
  // alone. Used when the user flips light/dark independently.
  function applyTheme(theme, opts) {
    const options = opts || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body) return;
    doc.body.setAttribute('data-theme', theme);
  }

  function readStoredPalette(storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return DEFAULT_PALETTE;
    let raw;
    try { raw = store.getItem(STORAGE_KEY) || DEFAULT_PALETTE; } catch { return DEFAULT_PALETTE; }
    const migrated = LEGACY_PALETTE_MAP[raw] || raw;
    if (migrated !== raw) {
      try { store.setItem(STORAGE_KEY, migrated); } catch {}
    }
    return getById(migrated) ? migrated : DEFAULT_PALETTE;
  }

  function storePalette(id, storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return;
    try {
      store.setItem(STORAGE_KEY, id);
    } catch {
      // Quota or sandbox: persistence is best-effort. The data-palette
      // attribute already reflects the user's choice for this session.
    }
  }

  return {
    PALETTES,
    DEFAULT_PALETTE,
    STORAGE_KEY,
    THEME_STORAGE_KEY,
    LEGACY_PALETTE_MAP,
    getById,
    resolveTheme,
    applyPalette,
    applyTheme,
    readStoredPalette,
    storePalette,
  };
});
