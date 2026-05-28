// Settings page controller (issue #53).
//
// Schema-driven: every field in the global and per-project forms is
// rendered from the descriptor list returned by GET /api/settings/schema.
// Adding a new setting requires no changes here.
//
// Save model: explicit "Save" buttons per section. Inline per-field
// errors AND a top-of-page summary on failed save (issue #53 acceptance
// criterion). Successful save shows a green confirmation.
//
// Per-project section:
//   * project dropdown populated from /api/projects
//   * each per-project-overridable field has an "override" checkbox
//     that toggles the underlying input. Unchecked = inherits from
//     global.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getByPath(obj, key) {
    if (obj == null || typeof obj !== 'object') return undefined;
    let cur = obj;
    for (const seg of key.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  function setByPath(obj, key, value) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (cur[seg] == null || typeof cur[seg] !== 'object') cur[seg] = {};
      cur = cur[seg];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function deleteByPath(obj, key) {
    const parts = key.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (cur[seg] == null || typeof cur[seg] !== 'object') return;
      cur = cur[seg];
    }
    delete cur[parts[parts.length - 1]];
  }

  function summary(node, message, kind, errors) {
    if (!message) {
      node.innerHTML = '';
      return;
    }
    const cls = kind === 'success' ? 'settings-summary success' : 'settings-summary';
    let html = `<div class="${cls}">${escapeHtml(message)}`;
    if (Array.isArray(errors) && errors.length) {
      html += '<ul>';
      for (const e of errors) {
        html += `<li><strong>${escapeHtml(e.key || '(document)')}</strong>: ${escapeHtml(e.message)}</li>`;
      }
      html += '</ul>';
    }
    html += '</div>';
    node.innerHTML = html;
  }

  function fieldInput(descriptor, value, idPrefix) {
    const id = `${idPrefix}-${descriptor.key.replace(/\./g, '-')}`;
    // Default agent gets a typeahead combobox backed by /api/agents.
    // The host div is mounted after render; collectGlobalPatch /
    // collectProjectOverrides keep working because the inner input
    // still carries data-key.
    if (descriptor.key === 'defaults.agent') {
      return `<div class="agent-picker-host"
        data-agent-host-key="${escapeHtml(descriptor.key)}"
        data-agent-host-id="${id}"
        data-agent-host-value="${escapeHtml(value == null ? '' : value)}"></div>`;
    }
    if (descriptor.type === 'enum' && Array.isArray(descriptor.enum)) {
      const opts = descriptor.enum.map(o =>
        `<option value="${escapeHtml(o)}"${o === value ? ' selected' : ''}>${escapeHtml(o)}</option>`
      ).join('');
      return `<select id="${id}" data-key="${escapeHtml(descriptor.key)}">${opts}</select>`;
    }
    // string / path: a plain text input
    return `<input id="${id}" type="text" data-key="${escapeHtml(descriptor.key)}" value="${escapeHtml(value == null ? '' : value)}">`;
  }

  // Walk newly-rendered fields and mount an agent picker into every
  // .agent-picker-host placeholder. Shares the cached agent list so
  // we only hit /api/agents once per page load. Synchronous so callers
  // that rely on data-key lookups (override toggles) see the input
  // element immediately. boot() pre-warms the cache before rendering.
  let cachedAgents = null;
  async function ensureAgentsLoaded() {
    if (Array.isArray(cachedAgents)) return cachedAgents;
    try {
      const res = await fetch('/api/agents');
      cachedAgents = res.ok ? await res.json() : [];
    } catch {
      cachedAgents = [];
    }
    return cachedAgents;
  }

  function mountAgentPickers(scope) {
    const hosts = (scope || document).querySelectorAll('.agent-picker-host');
    if (!hosts.length || !window.RunwayAgentPicker) return;
    const agents = Array.isArray(cachedAgents) ? cachedAgents : [];
    hosts.forEach(host => {
      if (host.dataset.mounted === '1') return;
      const key = host.getAttribute('data-agent-host-key');
      const id = host.getAttribute('data-agent-host-id');
      const initial = host.getAttribute('data-agent-host-value') || '';
      window.RunwayAgentPicker.create({
        host,
        initialValue: initial,
        agents,
        inputAttrs: { id, 'data-key': key },
      });
      host.dataset.mounted = '1';
    });
  }

  function renderGlobalForm(schema, doc) {
    const root = $('#global-fields');
    root.innerHTML = '';
    for (const d of schema.descriptors) {
      const value = getByPath(doc.values || {}, d.key);
      const wrap = document.createElement('div');
      wrap.className = 'settings-field';
      wrap.innerHTML = `
        <div class="settings-field-label">${escapeHtml(d.label)}</div>
        <div class="settings-field-help">${escapeHtml(d.help || '')}</div>
        ${fieldInput(d, value == null ? d.default : value, 'global')}
        <div class="field-error" data-key-error="${escapeHtml(d.key)}"></div>
      `;
      root.appendChild(wrap);
    }
    mountAgentPickers(root);
  }

  function renderProjectForm(schema, globalDoc, overrides) {
    const root = $('#project-fields');
    root.innerHTML = '';
    for (const d of schema.descriptors) {
      if (d.scope === 'global') continue;
      const overridden = getByPath(overrides || {}, d.key) !== undefined;
      const value = overridden ? getByPath(overrides, d.key) : getByPath(globalDoc.values || {}, d.key);
      const wrap = document.createElement('div');
      wrap.className = 'settings-field';
      const fieldId = `proj-${d.key.replace(/\./g, '-')}`;
      wrap.innerHTML = `
        <div class="settings-field-label">
          <span>${escapeHtml(d.label)}</span>
          <label style="display:inline-flex;align-items:center;gap:4px;font-weight:400;font-size:12px;">
            <input type="checkbox" data-override-toggle="${escapeHtml(d.key)}" ${overridden ? 'checked' : ''}>
            Override
          </label>
          <span class="${overridden ? 'override-pill' : 'inherits-pill'}" data-pill-key="${escapeHtml(d.key)}">${overridden ? 'overridden' : 'inherits global'}</span>
        </div>
        <div class="settings-field-help">${escapeHtml(d.help || '')}</div>
        ${fieldInput(d, value == null ? d.default : value, 'proj')}
        <div class="field-error" data-key-error="${escapeHtml(d.key)}"></div>
      `;
      root.appendChild(wrap);
    }
    // Mount any agent picker hosts BEFORE wiring override toggles so
    // the toggle handler's [data-key="..."] lookup finds the inner
    // input element rendered by the picker.
    mountAgentPickers(root);
    // Bind enable/disable based on override checkbox state.
    root.querySelectorAll('[data-override-toggle]').forEach(cb => {
      const key = cb.getAttribute('data-override-toggle');
      const input = root.querySelector(`[data-key="${key}"]`);
      const pill = root.querySelector(`[data-pill-key="${key}"]`);
      function apply() {
        if (input) input.disabled = !cb.checked;
        pill.className = cb.checked ? 'override-pill' : 'inherits-pill';
        pill.textContent = cb.checked ? 'overridden' : 'inherits global';
      }
      cb.addEventListener('change', apply);
      apply();
    });
  }

  function clearFieldErrors(prefix) {
    $$(`.settings-field [data-key-error]`).forEach(node => {
      if (node.closest(`#${prefix}-fields`)) node.textContent = '';
    });
  }

  function showFieldErrors(prefix, errors) {
    if (!Array.isArray(errors)) return;
    for (const e of errors) {
      const node = document.querySelector(`#${prefix}-fields [data-key-error="${e.key}"]`);
      if (node) node.textContent = e.message;
    }
  }

  // Collect a patch from a section, only including keys whose input
  // currently differs from the descriptor default. The PATCH endpoint
  // accepts wholesale fields anyway, but limiting the payload to
  // user-visible changes keeps the on-disk document tidy.
  function collectGlobalPatch(schema) {
    const out = {};
    for (const d of schema.descriptors) {
      const input = document.querySelector(`#global-fields [data-key="${d.key}"]`);
      if (!input) continue;
      let val = input.value;
      if (d.type === 'enum') val = String(val);
      setByPath(out, d.key, val);
    }
    return out;
  }

  function collectProjectOverrides(schema) {
    const out = {};
    for (const d of schema.descriptors) {
      if (d.scope === 'global') continue;
      const cb = document.querySelector(`#project-fields [data-override-toggle="${d.key}"]`);
      if (!cb || !cb.checked) continue;
      const input = document.querySelector(`#project-fields [data-key="${d.key}"]`);
      if (!input) continue;
      setByPath(out, d.key, input.value);
    }
    return out;
  }

  // ---------- Appearance (theme + palette) ----------
  const THEME_KEY = 'copilot-dashboard-theme';

  function applyThemeMode(pref) {
    let resolved = pref;
    if (pref === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    if (document.body) {
      document.body.setAttribute('data-theme', resolved);
    }
  }

  function initAppearance() {
    const palettes = window.RunwayPalettes;
    const themeSel = $('#theme-mode-select');
    const paletteSel = $('#palette-select');

    const currentTheme = localStorage.getItem(THEME_KEY) || 'system';
    themeSel.value = currentTheme;
    themeSel.addEventListener('change', () => {
      localStorage.setItem(THEME_KEY, themeSel.value);
      applyThemeMode(themeSel.value);
    });

    paletteSel.innerHTML = palettes.PALETTES.map(p =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`
    ).join('');
    const currentPalette = palettes.readStoredPalette();
    paletteSel.value = currentPalette;
    palettes.applyPalette(currentPalette);
    paletteSel.addEventListener('change', () => {
      palettes.storePalette(paletteSel.value);
      palettes.applyPalette(paletteSel.value);
    });
  }

  // ---------- Boot ----------
  let schema = null;
  let globalDoc = null;
  let projects = [];
  let currentProjectKey = '';

  async function boot() {
    initAppearance();

    // One-time migration: if a previous build wrote launchers.vscode to
    // localStorage (it never has in shipped code, but the migration
    // table needs an entry for future-proofing), fold it into the
    // server document and remove the localStorage copy. Idempotent.
    try {
      const legacy = localStorage.getItem('runway:launchers:vscode');
      if (legacy) {
        await ApiClient.patchSettings({ launchers: { vscode: legacy } });
        localStorage.removeItem('runway:launchers:vscode');
      }
    } catch {}

    const summaryNode = $('#settings-summary');

    const schemaRes = await ApiClient.getSettingsSchema();
    if (schemaRes.status !== 200) {
      summary(summaryNode, 'Failed to load settings schema. Reload the page to retry.');
      return;
    }
    schema = schemaRes.body;

    const globalRes = await ApiClient.getSettings();
    if (globalRes.status !== 200) {
      summary(summaryNode, 'Failed to load global settings. Reload to retry.');
      return;
    }
    globalDoc = globalRes.body;

    // Pre-warm the agent list before the first render so the agent
    // picker mounts synchronously with options already populated.
    await ensureAgentsLoaded();

    renderGlobalForm(schema, globalDoc);

    // Load projects for the per-project picker.
    try {
      const res = await fetch('/api/projects');
      projects = res.ok ? await res.json() : [];
    } catch {
      projects = [];
    }
    const projectSel = $('#project-select');
    projectSel.innerHTML = '<option value="">(select a project)</option>' +
      projects.map(p => `<option value="${escapeHtml(p.main_repo_path)}">${escapeHtml(p.name)}</option>`).join('');

    projectSel.addEventListener('change', async () => {
      currentProjectKey = projectSel.value;
      $('#save-project').disabled = !currentProjectKey;
      $('#clear-project').disabled = !currentProjectKey;
      if (!currentProjectKey) {
        $('#project-fields').innerHTML = '';
        return;
      }
      const r = await ApiClient.getProjectSettings(currentProjectKey);
      const overrides = (r.body && r.body.overrides) || {};
      renderProjectForm(schema, globalDoc, overrides);
    });

    // Deep-link: ?project=<absolute-path> pre-selects the matching
    // project so the "Project settings" action button on the session
    // detail panel lands the user on the relevant override section.
    try {
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('project');
      if (requested) {
        const match = projects.find(p => p.main_repo_path === requested);
        if (match) {
          projectSel.value = requested;
          projectSel.dispatchEvent(new Event('change'));
          const section = projectSel.closest('.settings-section');
          if (section && section.scrollIntoView) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        } else {
          summary(summaryNode,
            `No project matches ?project=${requested}. Pick one from the list to edit overrides.`);
        }
      }
    } catch { /* malformed URL: ignore */ }

    $('#save-global').addEventListener('click', async () => {
      clearFieldErrors('global');
      summary(summaryNode, '');
      const patch = collectGlobalPatch(schema);
      const res = await ApiClient.patchSettings(patch);
      if (res.status === 200) {
        globalDoc = res.body;
        summary(summaryNode, 'Global settings saved.', 'success');
      } else if (res.status === 400 && res.body && res.body.errors) {
        showFieldErrors('global', res.body.errors);
        summary(summaryNode, 'Could not save: validation failed.', 'error', res.body.errors);
      } else {
        summary(summaryNode, (res.body && res.body.message) || 'Save failed.');
      }
    });

    $('#save-project').addEventListener('click', async () => {
      if (!currentProjectKey) return;
      clearFieldErrors('project');
      summary(summaryNode, '');
      const overrides = collectProjectOverrides(schema);
      const res = await ApiClient.putProjectSettings(currentProjectKey, {
        schema_version: schema.schema_version,
        overrides,
      });
      if (res.status === 200) {
        summary(summaryNode, 'Project overrides saved.', 'success');
      } else if (res.status === 400 && res.body && res.body.errors) {
        showFieldErrors('project', res.body.errors);
        summary(summaryNode, 'Could not save project overrides: validation failed.', 'error', res.body.errors);
      } else {
        summary(summaryNode, (res.body && res.body.message) || 'Save failed.');
      }
    });

    $('#clear-project').addEventListener('click', async () => {
      if (!currentProjectKey) return;
      const res = await ApiClient.putProjectSettings(currentProjectKey, {
        schema_version: schema.schema_version,
        overrides: {},
      });
      if (res.status === 200) {
        renderProjectForm(schema, globalDoc, {});
        summary(summaryNode, 'Project overrides cleared.', 'success');
      } else {
        summary(summaryNode, (res.body && res.body.message) || 'Clear failed.');
      }
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  return { boot, renderGlobalForm, renderProjectForm, collectGlobalPatch, collectProjectOverrides };
});
