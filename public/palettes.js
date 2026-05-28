// Runway palette manifest (issue #53).
//
// One entry per palette CSS file under public/palettes/. The settings
// page renders a dropdown driven by this list; app.js loads the named
// stylesheet on demand when the user picks a palette so the page only
// pays for the palettes it actually displays.
//
// Default Dark and Default Light are sentinel ids that map to the base
// stylesheet (styles.css). Selecting them only updates data-theme; no
// additional CSS file is loaded.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RunwayPalettes = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const PALETTES = [
    { id: 'default-dark',       label: 'Default Dark',         theme: 'dark',  file: null },
    { id: 'default-light',      label: 'Default Light',        theme: 'light', file: null },
    { id: 'solarized-dark',     label: 'Solarized Dark',       theme: 'dark',  file: 'palettes/solarized-dark.css' },
    { id: 'solarized-light',    label: 'Solarized Light',      theme: 'light', file: 'palettes/solarized-light.css' },
    { id: 'monokai-inspired',   label: 'Monokai-inspired',     theme: 'dark',  file: 'palettes/monokai-inspired.css' },
    { id: 'high-contrast-dark', label: 'High Contrast Dark',   theme: 'dark',  file: 'palettes/high-contrast-dark.css' },
    { id: 'high-contrast-light',label: 'High Contrast Light',  theme: 'light', file: 'palettes/high-contrast-light.css' },
    { id: 'material',           label: 'Material',             theme: 'dark',  file: 'palettes/material.css' },
    { id: 'tokyo-night',        label: 'Tokyo Night',          theme: 'dark',  file: 'palettes/tokyo-night.css' },
    { id: 'catppuccin',         label: 'Catppuccin',           theme: 'dark',  file: 'palettes/catppuccin.css' },
    { id: 'rose-pine',          label: 'Rose Pine',            theme: 'dark',  file: 'palettes/rose-pine.css' },
  ];
  const DEFAULT_PALETTE = 'default-dark';
  const STORAGE_KEY = 'runway:theme:palette';

  function getById(id) {
    return PALETTES.find(p => p.id === id) || null;
  }

  // Apply a palette by id. Idempotent: re-applying the same palette is a
  // no-op. Loading a palette CSS file is deferred to the first time it
  // is selected; subsequent selections reuse the already-injected link
  // element. Returns the resolved palette entry.
  function applyPalette(id, opts) {
    const options = opts || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    const entry = getById(id) || getById(DEFAULT_PALETTE);
    doc.body.setAttribute('data-palette', entry.id);
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

  function readStoredPalette(storage) {
    const store = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!store) return DEFAULT_PALETTE;
    try {
      return store.getItem(STORAGE_KEY) || DEFAULT_PALETTE;
    } catch {
      return DEFAULT_PALETTE;
    }
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
    getById,
    applyPalette,
    readStoredPalette,
    storePalette,
  };
});
