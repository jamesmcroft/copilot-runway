// Project removal sweep (issue #54).
//
// Hard-purge a project from every Runway-owned state file under
// ~/.runway/. The sweep is implemented as a dynamic registry of
// per-project stores so future stores can join with one
// registerStore() call and no route changes.
//
// Each store declares two callbacks:
//
//   summarize(projectKey, ctx) -> number
//       Count entries that would be removed for the given project key.
//       Used by GET /api/projects/:projectKey/summary to render the
//       "this will remove X pins, Y overrides" line in the confirmation
//       modal. Must not mutate state.
//
//   purge(projectKey, ctx) -> { removed: number, details?: any }
//       Remove all matching entries atomically. Resilient to partial
//       state: a missing or malformed file is treated as "nothing to
//       remove" rather than a fatal error.
//
// `ctx` is a context object the caller provides. The default stores
// use the following keys:
//   ctx.getSessionIdsForProject(projectKey) -> string[]
//       Session ids whose cwd is within the project. Used by stores
//       that key by session id (pins, session-agents). Optional;
//       defaults to () => [] when not provided.
//
// All writes go through tempfile + rename so a mid-write crash cannot
// leave a half-written JSON document on disk. Read errors are logged
// and treated as "store is empty for this key".
//
// Path comparison is platform-aware: Windows is case-insensitive and
// tolerates mixed slash styles via the shared isPathWithinProject
// helper. Linux and macOS use exact string match.

const fs = require('fs');
const path = require('path');
const {
  CUSTOM_PROJECTS_FILE,
  PROJECT_SETTINGS_FILE,
  PINS_FILE,
  SESSION_AGENTS_FILE,
} = require('../paths');
const bindings = require('./worktree-bindings');
const { isPathWithinProject } = require('../../public/path-match');

const stores = [];

function registerStore(store) {
  if (!store || typeof store.name !== 'string'
    || typeof store.summarize !== 'function'
    || typeof store.purge !== 'function') {
    throw new Error('registerStore requires { name, summarize, purge }');
  }
  stores.push(store);
}

function listStores() {
  return stores.slice();
}

function clearStores() {
  stores.length = 0;
}

function summarizeProject(projectKey, ctx) {
  const out = {};
  for (const s of stores) {
    try {
      out[s.name] = Number(s.summarize(projectKey, ctx || {})) || 0;
    } catch (err) {
      console.warn(`[runway] project-purge summarize(${s.name}) failed: ${err.message}`);
      out[s.name] = 0;
    }
  }
  return out;
}

function purgeProject(projectKey, ctx) {
  const out = {};
  for (const s of stores) {
    try {
      const result = s.purge(projectKey, ctx || {});
      out[s.name] = result && typeof result === 'object'
        ? { removed: Number(result.removed) || 0, ...(result.details ? { details: result.details } : {}) }
        : { removed: 0 };
    } catch (err) {
      console.warn(`[runway] project-purge purge(${s.name}) failed: ${err.message}`);
      out[s.name] = { removed: 0, error: err.message };
    }
  }
  return out;
}

// Has any registered store got entries for this project key? Used by
// the route layer to decide between 204 (purged something) and 404
// (nothing to purge / idempotent re-delete).
function hasAnyState(projectKey, ctx) {
  const counts = summarizeProject(projectKey, ctx);
  return Object.values(counts).some(n => n > 0);
}

// -------- platform-aware key comparison --------

function sameKey(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// -------- shared JSON helpers --------

function safeReadJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    console.warn(`[runway] project-purge read ${file} failed: ${err.message}`);
    return null;
  }
}

function atomicWriteJson(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// -------- default stores --------

// projects.json: array of custom project records keyed by main_repo_path.
function projectsStore() {
  return {
    name: 'projects',
    summarize(projectKey) {
      const data = safeReadJson(CUSTOM_PROJECTS_FILE);
      if (!Array.isArray(data)) return 0;
      return data.filter(p => p && sameKey(p.main_repo_path, projectKey)).length;
    },
    purge(projectKey) {
      const data = safeReadJson(CUSTOM_PROJECTS_FILE);
      if (!Array.isArray(data)) return { removed: 0 };
      const next = data.filter(p => !(p && sameKey(p.main_repo_path, projectKey)));
      const removed = data.length - next.length;
      if (removed > 0) atomicWriteJson(CUSTOM_PROJECTS_FILE, next);
      return { removed };
    },
  };
}

// project-settings.json: { schema_version, projects: { <key>: {...} } }.
// Match is exact-string against the projects map key (mirrors the
// settings resolver which keys by the literal absolute path), with a
// Windows case-insensitive fallback so users typing a different case
// can still purge their entries.
function projectSettingsStore() {
  return {
    name: 'projectSettings',
    summarize(projectKey) {
      const data = safeReadJson(PROJECT_SETTINGS_FILE);
      if (!data || typeof data !== 'object' || !data.projects || typeof data.projects !== 'object') return 0;
      return Object.keys(data.projects).filter(k => sameKey(k, projectKey)).length;
    },
    purge(projectKey) {
      const data = safeReadJson(PROJECT_SETTINGS_FILE);
      if (!data || typeof data !== 'object' || !data.projects || typeof data.projects !== 'object') {
        return { removed: 0 };
      }
      const keys = Object.keys(data.projects).filter(k => sameKey(k, projectKey));
      if (keys.length === 0) return { removed: 0 };
      const nextProjects = { ...data.projects };
      for (const k of keys) delete nextProjects[k];
      const next = { ...data, projects: nextProjects };
      atomicWriteJson(PROJECT_SETTINGS_FILE, next);
      // Invalidate the settings module cache if loaded. Lazy require to
      // avoid a circular module load at file evaluation time.
      try { require('./settings').invalidateCache(); } catch {}
      return { removed: keys.length };
    },
  };
}

// worktree-bindings.json: keyed by worktree path, each entry carries a
// projectKey. Match by projectKey using sameKey().
function worktreeBindingsStore() {
  return {
    name: 'worktreeBindings',
    summarize(projectKey) {
      const list = bindings.list();
      return list.filter(b => sameKey(b.projectKey, projectKey)).length;
    },
    purge(projectKey) {
      const list = bindings.list();
      const matches = list.filter(b => sameKey(b.projectKey, projectKey));
      let removed = 0;
      const worktreePaths = [];
      for (const b of matches) {
        if (bindings.remove({ worktreePath: b.worktreePath })) {
          removed += 1;
          worktreePaths.push({
            worktreePath: b.worktreePath,
            branchName: b.branchName,
            sessionId: b.sessionId,
          });
        }
      }
      return { removed, details: { worktrees: worktreePaths } };
    },
  };
}

// pins.json: { sessions: ["<session-id>", ...] }. Sweep sessions that
// belong to this project, as reported by ctx.getSessionIdsForProject.
function pinsStore() {
  return {
    name: 'pins',
    summarize(projectKey, ctx) {
      const ids = sessionIdSet(ctx, projectKey);
      if (ids.size === 0) return 0;
      const data = safeReadJson(PINS_FILE);
      if (!data || !Array.isArray(data.sessions)) return 0;
      return data.sessions.filter(id => ids.has(id)).length;
    },
    purge(projectKey, ctx) {
      const ids = sessionIdSet(ctx, projectKey);
      if (ids.size === 0) return { removed: 0 };
      const data = safeReadJson(PINS_FILE);
      if (!data || !Array.isArray(data.sessions)) return { removed: 0 };
      const kept = data.sessions.filter(id => !ids.has(id));
      const removed = data.sessions.length - kept.length;
      if (removed > 0) atomicWriteJson(PINS_FILE, { ...data, sessions: kept });
      return { removed };
    },
  };
}

// session-agents.json: { "<session-id>": "<agent>", ... }. Sweep keys
// that belong to this project.
function sessionAgentsStore() {
  return {
    name: 'sessionAgents',
    summarize(projectKey, ctx) {
      const ids = sessionIdSet(ctx, projectKey);
      if (ids.size === 0) return 0;
      const data = safeReadJson(SESSION_AGENTS_FILE);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return 0;
      return Object.keys(data).filter(id => ids.has(id)).length;
    },
    purge(projectKey, ctx) {
      const ids = sessionIdSet(ctx, projectKey);
      if (ids.size === 0) return { removed: 0 };
      const data = safeReadJson(SESSION_AGENTS_FILE);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { removed: 0 };
      const next = {};
      let removed = 0;
      for (const k of Object.keys(data)) {
        if (ids.has(k)) { removed += 1; continue; }
        next[k] = data[k];
      }
      if (removed > 0) atomicWriteJson(SESSION_AGENTS_FILE, next);
      return { removed };
    },
  };
}

function sessionIdSet(ctx, projectKey) {
  if (!ctx || typeof ctx.getSessionIdsForProject !== 'function') return new Set();
  try {
    const ids = ctx.getSessionIdsForProject(projectKey);
    return new Set(Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function registerDefaults() {
  clearStores();
  registerStore(projectsStore());
  registerStore(projectSettingsStore());
  registerStore(worktreeBindingsStore());
  registerStore(pinsStore());
  registerStore(sessionAgentsStore());
}

// Register on first require. Tests that want to reset the registry
// (for example to inject a fake store) can call clearStores() then
// registerDefaults() or registerStore() to rebuild it.
registerDefaults();

module.exports = {
  registerStore,
  listStores,
  clearStores,
  registerDefaults,
  summarizeProject,
  purgeProject,
  hasAnyState,
  // Test hooks: exposed so the route layer can use a single shared
  // comparison and so tests can construct a stub store using the same
  // path semantics.
  sameKey,
  isPathWithinProject,
};
