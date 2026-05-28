// Read/write layer for Runway settings (issue #53).
//
// Two on-disk documents:
//   ~/.runway/settings.json         -> { schema_version, values }
//   ~/.runway/project-settings.json -> { schema_version, projects: { <abs path>: { ...overrides } } }
//
// Both are read on demand, cached in memory, and written atomically via
// a tempfile + rename. Malformed input is never fatal: we log and fall
// back to defaults so the server keeps booting.
//
// Resolution order (issue #53 lists per-session as a future hook):
//   hardcoded default -> global value -> per-project override
//
// Per-project overrides for projects we have no record of are silently
// preserved on disk but contribute nothing to resolution. The orphan
// sweep is tracked separately at #54.

const fs = require('fs');
const {
  RUNWAY_DIR,
  SETTINGS_FILE,
  PROJECT_SETTINGS_FILE,
  LAUNCHERS_FILE,
} = require('../paths');
const {
  CURRENT_SCHEMA_VERSION,
  VSCODE_BINARIES,
  defaultGlobalDocument,
  defaultProjectDocument,
  defaultGlobalValues,
  getDescriptors,
  getDescriptor,
  validateValues,
  getByPath,
  setByPath,
} = require('./settings-schema');
const { migrateDocument } = require('./settings-migrations');

let globalCache = null;
let projectCache = null;
let launchersDeprecationLogged = false;

function ensureRunwayDir() {
  if (!fs.existsSync(RUNWAY_DIR)) fs.mkdirSync(RUNWAY_DIR, { recursive: true });
}

function atomicWriteJson(file, obj) {
  ensureRunwayDir();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// Deep-merge `patch` into `target`. Plain-object children are merged
// recursively; everything else (primitives, arrays) replaces wholesale.
// Returns a new object; inputs are not mutated.
function deepMerge(target, patch) {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = (target && typeof target === 'object' && !Array.isArray(target)) ? { ...target } : {};
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    if (pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[k] = deepMerge(out[k], pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

function safeReadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn(`[runway] settings file ${file} is not a JSON object; using defaults`);
      return null;
    }
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    console.warn(`[runway] failed to read settings file ${file}: ${err.message}; using defaults`);
    return null;
  }
}

// Load the global document, migrating if necessary. On any unrecoverable
// error returns the defaults so the server stays up. If the on-disk
// version is newer than we know about, we run in read-only mode and log.
function loadGlobalDocument() {
  if (globalCache) return globalCache;

  const onDisk = safeReadJson(SETTINGS_FILE);
  if (onDisk == null) {
    const fresh = defaultGlobalDocument();
    // First boot: also fold any pre-existing launchers.json into the
    // new model so users upgrading do not lose their override.
    const folded = foldLaunchersJson(fresh);
    if (folded.changed) {
      try {
        atomicWriteJson(SETTINGS_FILE, folded.document);
      } catch (err) {
        console.warn(`[runway] failed to persist folded launchers.json: ${err.message}`);
      }
    }
    globalCache = { document: folded.document, readOnly: false };
    return globalCache;
  }

  const migrated = migrateDocument(onDisk);
  if (migrated.readOnly) {
    console.warn(
      `[runway] settings.json schema_version=${migrated.fromVersion} is newer than this Runway build ` +
      `(known up to ${CURRENT_SCHEMA_VERSION}); running in read-only mode for global settings`
    );
    globalCache = { document: ensureGlobalShape(migrated.document), readOnly: true };
    return globalCache;
  }

  let document = ensureGlobalShape(migrated.document);
  if (migrated.migrated) {
    try {
      atomicWriteJson(SETTINGS_FILE, document);
    } catch (err) {
      console.warn(`[runway] failed to persist migrated settings.json: ${err.message}`);
    }
  }
  globalCache = { document, readOnly: false };
  return globalCache;
}

function loadProjectDocument() {
  if (projectCache) return projectCache;

  const onDisk = safeReadJson(PROJECT_SETTINGS_FILE);
  if (onDisk == null) {
    projectCache = { document: defaultProjectDocument(), readOnly: false };
    return projectCache;
  }

  const migrated = migrateDocument(onDisk);
  if (migrated.readOnly) {
    console.warn(
      `[runway] project-settings.json schema_version=${migrated.fromVersion} is newer than this Runway build ` +
      `(known up to ${CURRENT_SCHEMA_VERSION}); running in read-only mode for project overrides`
    );
    projectCache = { document: ensureProjectShape(migrated.document), readOnly: true };
    return projectCache;
  }

  let document = ensureProjectShape(migrated.document);
  if (migrated.migrated) {
    try {
      atomicWriteJson(PROJECT_SETTINGS_FILE, document);
    } catch (err) {
      console.warn(`[runway] failed to persist migrated project-settings.json: ${err.message}`);
    }
  }
  projectCache = { document, readOnly: false };
  return projectCache;
}

function ensureGlobalShape(doc) {
  const base = defaultGlobalDocument();
  return {
    schema_version: typeof doc.schema_version === 'number' ? doc.schema_version : base.schema_version,
    values: deepMerge(base.values, (doc.values && typeof doc.values === 'object') ? doc.values : {}),
  };
}

function ensureProjectShape(doc) {
  const base = defaultProjectDocument();
  const projects = (doc.projects && typeof doc.projects === 'object' && !Array.isArray(doc.projects)) ? doc.projects : {};
  // Drop entries that are not plain objects (corrupt rows).
  const clean = {};
  for (const k of Object.keys(projects)) {
    const v = projects[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) clean[k] = v;
  }
  return {
    schema_version: typeof doc.schema_version === 'number' ? doc.schema_version : base.schema_version,
    projects: clean,
  };
}

// Fold the legacy ~/.runway/launchers.json file into a fresh global
// document. Returns { document, changed }. Logs the deprecation once.
function foldLaunchersJson(doc) {
  let raw;
  try {
    raw = fs.readFileSync(LAUNCHERS_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { document: doc, changed: false };
    console.warn(`[runway] failed to read legacy launchers.json: ${err.message}`);
    return { document: doc, changed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[runway] legacy launchers.json is not valid JSON: ${err.message}; ignoring`);
    return { document: doc, changed: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { document: doc, changed: false };
  }
  if (!launchersDeprecationLogged) {
    console.warn(
      `[runway] ${LAUNCHERS_FILE} is deprecated; its values have been folded into settings.json. ` +
      `The file is preserved for one release and will be removed in a future version.`
    );
    launchersDeprecationLogged = true;
  }
  const requested = typeof parsed.vscode === 'string' ? parsed.vscode.trim() : '';
  if (requested && VSCODE_BINARIES.includes(requested)) {
    const next = { ...doc, values: deepMerge(doc.values, { launchers: { vscode: requested } }) };
    return { document: next, changed: true };
  }
  return { document: doc, changed: false };
}

function getGlobalSettings() {
  return loadGlobalDocument().document;
}

function getProjectSettings(projectKey) {
  const doc = loadProjectDocument().document;
  const entry = doc.projects[projectKey];
  return {
    schema_version: doc.schema_version,
    overrides: (entry && typeof entry === 'object') ? entry : {},
  };
}

// Resolve a single key, applying global then per-project override.
// projectKey may be null/undefined; orphan keys (no matching project)
// are silently ignored at the resolver layer.
function resolveSetting(key, projectKey) {
  const descriptor = getDescriptor(key);
  if (!descriptor) return undefined;
  const globalDoc = getGlobalSettings();
  let value = getByPath(globalDoc.values, key);
  if (value === undefined) value = descriptor.default;

  if (projectKey && descriptor.scope === 'both') {
    const projDoc = loadProjectDocument().document;
    const entry = projDoc.projects[projectKey];
    if (entry && typeof entry === 'object') {
      const override = getByPath(entry, key);
      if (override !== undefined) value = override;
    }
  }
  return value;
}

// Resolve every known setting into a single document by applying the
// global value (or hardcoded default) and, when a project key is given,
// any per-project override. Returns { values } with the same nested
// shape callers see from GET /api/settings, so the client can read e.g.
// resolved.values.defaults.agent without branching on scope.
function getResolvedValues(projectKey) {
  const out = {};
  for (const descriptor of getDescriptors()) {
    const value = resolveSetting(descriptor.key, projectKey || null);
    if (value === undefined) continue;
    setByPath(out, descriptor.key, value);
  }
  return { values: out };
}

// PATCH: deep-merge supplied keys into the current document, validate
// post-merge, write atomically. Returns the persisted document on
// success or throws on validation failure / read-only mode.
function patchGlobalSettings(patch) {
  const state = loadGlobalDocument();
  if (state.readOnly) {
    throw Object.assign(new Error('settings.json is in read-only mode (schema_version newer than this build)'), { code: 'READ_ONLY' });
  }
  const merged = deepMerge(state.document.values, (patch && typeof patch === 'object') ? patch : {});
  const validation = validateValues(merged, { scope: 'global' });
  if (!validation.ok) {
    const err = new Error('validation failed');
    err.code = 'VALIDATION';
    err.errors = validation.errors;
    throw err;
  }
  const next = {
    schema_version: CURRENT_SCHEMA_VERSION,
    values: merged,
  };
  atomicWriteJson(SETTINGS_FILE, next);
  globalCache = { document: next, readOnly: false };
  return next;
}

// PUT: replace the whole document after validation. Unknown top-level
// keys are preserved verbatim.
function putGlobalSettings(document) {
  const state = loadGlobalDocument();
  if (state.readOnly) {
    throw Object.assign(new Error('settings.json is in read-only mode'), { code: 'READ_ONLY' });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    const err = new Error('document must be an object'); err.code = 'VALIDATION'; err.errors = [{ key: '', message: 'expected an object' }];
    throw err;
  }
  const values = (document.values && typeof document.values === 'object') ? document.values : {};
  const validation = validateValues(values, { scope: 'global' });
  if (!validation.ok) {
    const err = new Error('validation failed');
    err.code = 'VALIDATION';
    err.errors = validation.errors;
    throw err;
  }
  const next = {
    ...document,
    schema_version: CURRENT_SCHEMA_VERSION,
    values: deepMerge(defaultGlobalValues(), values),
  };
  atomicWriteJson(SETTINGS_FILE, next);
  globalCache = { document: next, readOnly: false };
  return next;
}

function patchProjectSettings(projectKey, patch) {
  if (!projectKey || typeof projectKey !== 'string') {
    const err = new Error('projectKey is required'); err.code = 'VALIDATION';
    err.errors = [{ key: '', message: 'projectKey required' }];
    throw err;
  }
  const state = loadProjectDocument();
  if (state.readOnly) {
    throw Object.assign(new Error('project-settings.json is in read-only mode'), { code: 'READ_ONLY' });
  }
  const current = state.document.projects[projectKey] || {};
  const merged = deepMerge(current, (patch && typeof patch === 'object') ? patch : {});
  const validation = validateValues(merged, { scope: 'project' });
  if (!validation.ok) {
    const err = new Error('validation failed');
    err.code = 'VALIDATION';
    err.errors = validation.errors;
    throw err;
  }
  const nextDoc = {
    ...state.document,
    schema_version: CURRENT_SCHEMA_VERSION,
    projects: { ...state.document.projects, [projectKey]: merged },
  };
  atomicWriteJson(PROJECT_SETTINGS_FILE, nextDoc);
  projectCache = { document: nextDoc, readOnly: false };
  return { schema_version: nextDoc.schema_version, overrides: merged };
}

function putProjectSettings(projectKey, document) {
  if (!projectKey || typeof projectKey !== 'string') {
    const err = new Error('projectKey is required'); err.code = 'VALIDATION';
    err.errors = [{ key: '', message: 'projectKey required' }];
    throw err;
  }
  const state = loadProjectDocument();
  if (state.readOnly) {
    throw Object.assign(new Error('project-settings.json is in read-only mode'), { code: 'READ_ONLY' });
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    const err = new Error('document must be an object'); err.code = 'VALIDATION';
    err.errors = [{ key: '', message: 'expected an object' }];
    throw err;
  }
  const overrides = (document.overrides && typeof document.overrides === 'object') ? document.overrides : {};
  const validation = validateValues(overrides, { scope: 'project' });
  if (!validation.ok) {
    const err = new Error('validation failed');
    err.code = 'VALIDATION';
    err.errors = validation.errors;
    throw err;
  }
  const nextDoc = {
    ...state.document,
    schema_version: CURRENT_SCHEMA_VERSION,
    projects: { ...state.document.projects, [projectKey]: overrides },
  };
  atomicWriteJson(PROJECT_SETTINGS_FILE, nextDoc);
  projectCache = { document: nextDoc, readOnly: false };
  return { schema_version: nextDoc.schema_version, overrides };
}

// Descriptors serialized for the wire. validate is dropped (server-side
// only); enum is included where present.
function getSchemaDescriptors() {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    descriptors: getDescriptors().map(d => {
      const out = {
        key: d.key,
        type: d.type,
        default: d.default,
        scope: d.scope,
        label: d.label,
        help: d.help,
      };
      if (d.enum) out.enum = d.enum.slice();
      return out;
    }),
  };
}

// Test hook: drop the in-memory cache so a re-read sees the on-disk
// state. Also exposed for the rare integration that wants to force a
// re-read after editing a file by hand.
function invalidateCache() {
  globalCache = null;
  projectCache = null;
  launchersDeprecationLogged = false;
}

module.exports = {
  getGlobalSettings,
  getProjectSettings,
  resolveSetting,
  getResolvedValues,
  patchGlobalSettings,
  putGlobalSettings,
  patchProjectSettings,
  putProjectSettings,
  getSchemaDescriptors,
  invalidateCache,
};
