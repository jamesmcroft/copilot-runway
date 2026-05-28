// Persistent store mapping worktree paths to the session that owns them.
//
// File: ~/.runway/worktree-bindings.json
// Shape (forward compatible, additional top level keys are tolerated):
//   {
//     "schema_version": 1,
//     "bindings": {
//       "<absolute worktree path>": {
//         "sessionId": "<session id>",
//         "projectKey": "<absolute project path>",
//         "branchName": "runway/<id short>",
//         "createdAt": "<ISO 8601>"
//       },
//       ...
//     }
//   }
//
// Read errors and malformed JSON are never fatal: we log a [runway]
// warning, fall back to an empty in memory set, and never crash. Writes
// go through tempfile plus rename so a mid write crash cannot corrupt
// the file. The in memory cache is dropped via invalidateCache() (test
// hook); production callers always go through the cached path.

const fs = require('fs');
const path = require('path');
const { RUNWAY_DIR } = require('../paths');

const BINDINGS_FILE = path.join(RUNWAY_DIR, 'worktree-bindings.json');
const SCHEMA_VERSION = 1;

let cache = null;

function ensureRunwayDir() {
  if (!fs.existsSync(RUNWAY_DIR)) fs.mkdirSync(RUNWAY_DIR, { recursive: true });
}

function emptyDocument() {
  return { schema_version: SCHEMA_VERSION, bindings: {} };
}

function load() {
  if (cache) return cache;
  let raw;
  try {
    raw = fs.readFileSync(BINDINGS_FILE, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      console.warn(`[runway] failed to read ${BINDINGS_FILE}: ${err.message}; using empty bindings`);
    }
    cache = emptyDocument();
    return cache;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(`[runway] worktree-bindings.json is not valid JSON: ${err.message}; using empty bindings`);
    cache = emptyDocument();
    return cache;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[runway] worktree-bindings.json is not a JSON object; using empty bindings`);
    cache = emptyDocument();
    return cache;
  }
  const bindings = (parsed.bindings && typeof parsed.bindings === 'object' && !Array.isArray(parsed.bindings))
    ? parsed.bindings : {};
  // Drop corrupt rows (non object or missing required fields). Better to
  // silently ignore a bad row than crash the server.
  const clean = {};
  for (const k of Object.keys(bindings)) {
    const v = bindings[k];
    if (v && typeof v === 'object' && !Array.isArray(v)
      && typeof v.sessionId === 'string'
      && typeof v.branchName === 'string') {
      clean[k] = {
        sessionId: v.sessionId,
        projectKey: typeof v.projectKey === 'string' ? v.projectKey : '',
        branchName: v.branchName,
        createdAt: typeof v.createdAt === 'string' ? v.createdAt : '',
      };
    }
  }
  cache = {
    schema_version: typeof parsed.schema_version === 'number' ? parsed.schema_version : SCHEMA_VERSION,
    bindings: clean,
  };
  return cache;
}

function save(doc) {
  ensureRunwayDir();
  const tmp = `${BINDINGS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, BINDINGS_FILE);
  cache = doc;
}

function getByPath(worktreePath) {
  if (!worktreePath) return null;
  const doc = load();
  const entry = doc.bindings[worktreePath];
  return entry ? { worktreePath, ...entry } : null;
}

function getBySessionId(sessionId) {
  if (!sessionId) return null;
  const doc = load();
  for (const k of Object.keys(doc.bindings)) {
    if (doc.bindings[k].sessionId === sessionId) {
      return { worktreePath: k, ...doc.bindings[k] };
    }
  }
  return null;
}

function set({ worktreePath, sessionId, projectKey, branchName }) {
  if (!worktreePath || typeof worktreePath !== 'string') {
    throw new Error('worktreePath is required');
  }
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }
  if (!branchName || typeof branchName !== 'string') {
    throw new Error('branchName is required');
  }
  const doc = load();
  const next = {
    schema_version: SCHEMA_VERSION,
    bindings: {
      ...doc.bindings,
      [worktreePath]: {
        sessionId,
        projectKey: typeof projectKey === 'string' ? projectKey : '',
        branchName,
        createdAt: new Date().toISOString(),
      },
    },
  };
  save(next);
  return { worktreePath, ...next.bindings[worktreePath] };
}

function remove({ worktreePath }) {
  if (!worktreePath) return false;
  const doc = load();
  if (!doc.bindings[worktreePath]) return false;
  const nextBindings = { ...doc.bindings };
  delete nextBindings[worktreePath];
  save({ schema_version: SCHEMA_VERSION, bindings: nextBindings });
  return true;
}

function list() {
  const doc = load();
  return Object.keys(doc.bindings).map(k => ({ worktreePath: k, ...doc.bindings[k] }));
}

function invalidateCache() {
  cache = null;
}

module.exports = {
  BINDINGS_FILE,
  load,
  getByPath,
  getBySessionId,
  set,
  remove,
  list,
  invalidateCache,
};
