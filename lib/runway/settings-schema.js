// Schema descriptors for Runway settings (issue #53).
//
// Single source of truth for behavioral defaults. Each descriptor lives
// in one place so the validator, the resolver, the REST schema endpoint,
// and the frontend form all agree on the shape, default, and validation
// rules for a given key.
//
// Descriptor shape:
//   {
//     key:      dot-separated string used in the on-disk document
//     type:     'string' | 'enum' | 'path'
//     default:  the hardcoded default (lowest precedence in the resolver)
//     scope:    'global'        => only valid at the global level
//               'both'          => valid both globally and per-project
//     validate: (value) => null | string   // returns error message or null
//     label:    short human label for the UI
//     help:     longer hint text rendered next to the field
//     enum?:    array of allowed values when type === 'enum'
//   }
//
// Defaults that already live as constants elsewhere should be imported
// from those modules. Where no constant exists yet (the v1 case for the
// new keys), the descriptor itself is the constant.

const path = require('path');
const { RUNWAY_DIR } = require('../paths');

// VS Code binary allowlist. Mirrored from lib/launch.js so descriptors
// stay declarative; lib/launch.js re-exports this list for the launcher
// resolver (single source of truth).
const VSCODE_BINARIES = ['code', 'code-insiders', 'cursor', 'codium'];

// Default location for git worktrees created by future #44 work. We
// expose this as a path string in the document; the resolver returns it
// verbatim so callers can re-anchor against their own HOME if needed.
const DEFAULT_WORKTREES_ROOT = path.join(RUNWAY_DIR, 'worktrees');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePath(value) {
  if (!isNonEmptyString(value)) return 'must be a non-empty string';
  // We do not require the path to exist (it may be created on first use).
  // We do require it to be absolute so resolution is unambiguous.
  if (!path.isAbsolute(value)) return 'must be an absolute path';
  return null;
}

function validateAgentId(value) {
  // Empty string means "no default selected" and is allowed; the resolver
  // surfaces null in that case and callers fall back to the CLI default.
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string') return 'must be a string';
  if (value.length > 200) return 'too long';
  return null;
}

function validateEnum(allowed) {
  return value => {
    if (!allowed.includes(value)) {
      return `must be one of: ${allowed.join(', ')}`;
    }
    return null;
  };
}

const DESCRIPTORS = [
  {
    key: 'worktrees.root',
    type: 'path',
    default: DEFAULT_WORKTREES_ROOT,
    scope: 'global',
    validate: validatePath,
    label: 'Worktrees root',
    help: 'Directory where per-session git worktrees will be created. Global only.',
  },
  {
    key: 'defaults.agent',
    type: 'string',
    default: '',
    scope: 'both',
    validate: validateAgentId,
    label: 'Default agent',
    help: 'Agent id applied to new sessions when none is chosen. Leave empty for the CLI default.',
  },
  {
    key: 'launchers.vscode',
    type: 'enum',
    enum: VSCODE_BINARIES,
    default: 'code',
    scope: 'both',
    validate: validateEnum(VSCODE_BINARIES),
    label: 'VS Code binary',
    help: 'Editor binary spawned by the "Open in VS Code" action.',
  },
];

const DESCRIPTORS_BY_KEY = Object.freeze(
  DESCRIPTORS.reduce((acc, d) => { acc[d.key] = d; return acc; }, {})
);

const CURRENT_SCHEMA_VERSION = 1;

function getDescriptors() {
  return DESCRIPTORS.slice();
}

function getDescriptor(key) {
  return DESCRIPTORS_BY_KEY[key] || null;
}

// Default global document. Generated from descriptors so adding a key in
// one place is enough.
function defaultGlobalValues() {
  const out = {};
  for (const d of DESCRIPTORS) {
    setByPath(out, d.key, d.default);
  }
  return out;
}

function defaultGlobalDocument() {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    values: defaultGlobalValues(),
  };
}

function defaultProjectDocument() {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    projects: {},
  };
}

// Dot-path helpers. Settings keys are always dot-separated and never
// contain literal dots in any segment.
function setByPath(obj, dotKey, value) {
  const parts = dotKey.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (cur[seg] == null || typeof cur[seg] !== 'object' || Array.isArray(cur[seg])) {
      cur[seg] = {};
    }
    cur = cur[seg];
  }
  cur[parts[parts.length - 1]] = value;
}

function getByPath(obj, dotKey) {
  if (obj == null || typeof obj !== 'object') return undefined;
  const parts = dotKey.split('.');
  let cur = obj;
  for (const seg of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[seg];
  }
  return cur;
}

// Validate a partial document. Returns { ok, errors } where errors is a
// list of { key, message } entries. Unknown keys are tolerated (forward
// compatibility) but values for known keys must pass the descriptor
// validator. scope must match: scope='global' descriptors cannot appear
// in a project override.
function validateValues(values, opts) {
  const options = opts || {};
  const scope = options.scope === 'project' ? 'project' : 'global';
  const errors = [];

  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, errors: [{ key: '', message: 'expected an object' }] };
  }

  for (const d of DESCRIPTORS) {
    const v = getByPath(values, d.key);
    if (v === undefined) continue;
    if (scope === 'project' && d.scope === 'global') {
      errors.push({ key: d.key, message: 'not overridable per project' });
      continue;
    }
    const err = d.validate(v);
    if (err) errors.push({ key: d.key, message: err });
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  CURRENT_SCHEMA_VERSION,
  VSCODE_BINARIES,
  DEFAULT_WORKTREES_ROOT,
  getDescriptors,
  getDescriptor,
  defaultGlobalValues,
  defaultGlobalDocument,
  defaultProjectDocument,
  validateValues,
  setByPath,
  getByPath,
};
