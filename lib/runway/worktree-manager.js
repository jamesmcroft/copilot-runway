// Worktree provisioner. Shells out to `git` to create, list, and remove
// linked worktrees under the runway worktrees root. Persists the
// path -> session binding via worktree-bindings.js so the UI can answer
// "is this session bound?" and "who owns this path?" without re-reading
// git state.
//
// Naming on disk (issue #44):
//   <worktrees.root>/<sanitized-project-name>/<session-id-short>
// Branch name:
//   runway/<session-id-short>      (session id short = first 8 chars)
//
// Concurrency: a worktree path can be bound to at most one session at a
// time. A second bind attempt to the same path throws
// WorktreeAlreadyBoundError; the caller surfaces the bound session id so
// the UI can offer a "Focus the bound session" CTA.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const bindings = require('./worktree-bindings');
const { getWorktreesRoot } = require('./settings');

class WorktreeAlreadyBoundError extends Error {
  constructor(message, sessionId) {
    super(message);
    this.name = 'WorktreeAlreadyBoundError';
    this.code = 'WORKTREE_ALREADY_BOUND';
    this.sessionId = sessionId;
  }
}

class WorktreeError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'WorktreeError';
    if (code) this.code = code;
  }
}

// Slug rules from issue #44:
//   * basename of the project path
//   * lowercase
//   * non-alphanumeric -> hyphen
//   * collapse repeated hyphens
//   * trim leading / trailing hyphens
//   * max 64 chars
// Returns a non empty string. If the input collapses to empty (e.g. the
// project path is "/" or "."), falls back to "project" so callers always
// get a usable directory name.
function sanitizeProjectSlug(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath) return 'project';
  let base = path.basename(projectPath.replace(/[\\/]+$/, ''));
  if (!base || base === '.' || base === '..') base = 'project';
  let slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) slug = 'project';
  if (slug.length > 64) slug = slug.slice(0, 64).replace(/-+$/, '') || 'project';
  return slug;
}

// Canonicalize a path so binding keys and git's reported worktree paths
// match across platforms. macOS `os.tmpdir()` returns `/var/folders/...`
// but git reports the realpath `/private/var/folders/...`. Windows can
// return 8.3 short names from `os.tmpdir()` while git reports long form.
// We need both sides of the comparison to be in the same form, or the
// `worktree path -> session` lookup will silently miss and the UI will
// show every worktree as unbound.
//
// If the path does not exist yet (e.g. the leaf we are about to create),
// realpath the deepest existing ancestor and re-join the missing tail.
// Falls back to `path.resolve` if even that fails so we never throw from
// a normalizer.
function canonicalizePath(p) {
  if (typeof p !== 'string' || !p) return p;
  try {
    return fs.realpathSync(p);
  } catch {
    // Walk up until we find an existing ancestor, realpath it, then
    // re-attach the missing segments.
    const resolved = path.resolve(p);
    let cursor = resolved;
    const tail = [];
    while (true) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return resolved;
      tail.unshift(path.basename(cursor));
      cursor = parent;
      try {
        const real = fs.realpathSync(cursor);
        return path.join(real, ...tail);
      } catch {
        // keep walking
      }
    }
  }
}

function shortSessionId(sessionId) {
  if (typeof sessionId !== 'string') {
    throw new WorktreeError('sessionId must be a string', 'INVALID_SESSION_ID');
  }
  const cleaned = sessionId.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length < 1) {
    throw new WorktreeError('sessionId has no alphanumeric characters', 'INVALID_SESSION_ID');
  }
  return cleaned.slice(0, 8);
}

function branchNameFor(sessionId) {
  return `runway/${shortSessionId(sessionId)}`;
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (err) {
    // Surface a structured error with the git stderr so the route layer
    // can decide whether to propagate the message verbatim. We keep the
    // original error chained for logs.
    const stderr = (err && err.stderr) ? String(err.stderr).trim() : '';
    const msg = stderr || (err && err.message) || 'git command failed';
    const wrapped = new WorktreeError(`git ${args[0]} failed: ${msg}`, 'GIT_FAILED');
    wrapped.cause = err;
    wrapped.stderr = stderr;
    throw wrapped;
  }
}

function branchExists(projectPath, branchName) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

// True when the branch tip is reachable from the project's current HEAD,
// which means no commits unique to the branch exist. Conservative: if we
// cannot answer, we return false so the UI defaults to "cannot delete".
function canDeleteBranch({ branchName, projectPath }) {
  if (!branchName || !projectPath) return false;
  if (!branchExists(projectPath, branchName)) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', branchName, 'HEAD'], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function isDirty({ worktreePath }) {
  if (!worktreePath || !fs.existsSync(worktreePath)) return false;
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function getBoundSession({ worktreePath }) {
  if (!worktreePath) return null;
  const canonical = canonicalizePath(worktreePath);
  return bindings.getByPath(canonical) || bindings.getByPath(worktreePath);
}

// Create a new linked worktree for the given session and persist the
// binding. Returns { worktreePath, branchName }. Throws:
//   * WorktreeAlreadyBoundError - the target path is already bound
//   * WorktreeError(code: 'BRANCH_EXISTS') - runway/<id> already exists
//   * WorktreeError(code: 'INVALID_PROJECT') - projectPath is missing
//   * WorktreeError(code: 'GIT_FAILED') - git itself failed
function create({ sessionId, projectPath, sourceBranch }) {
  if (!sessionId) throw new WorktreeError('sessionId is required', 'INVALID_SESSION_ID');
  if (!projectPath || !fs.existsSync(projectPath)) {
    throw new WorktreeError(`projectPath does not exist: ${projectPath}`, 'INVALID_PROJECT');
  }
  const idShort = shortSessionId(sessionId);
  const branchName = `runway/${idShort}`;
  const slug = sanitizeProjectSlug(projectPath);
  const root = getWorktreesRoot();
  const projectDir = path.join(root, slug);
  // Ensure the parent directory exists so we can canonicalize it. git
  // worktree add will create the leaf itself but it requires the parent.
  fs.mkdirSync(projectDir, { recursive: true });
  const canonicalProjectDir = canonicalizePath(projectDir);
  const worktreePath = path.join(canonicalProjectDir, idShort);
  const canonicalProjectPath = canonicalizePath(projectPath);

  // Reject the second-bind case BEFORE touching git so we never leave a
  // half created worktree behind. Check both canonical and original
  // forms to tolerate bindings written by older builds.
  const existing = bindings.getByPath(worktreePath)
    || bindings.getByPath(path.join(projectDir, idShort));
  if (existing) {
    throw new WorktreeAlreadyBoundError(
      `worktree path ${worktreePath} is already bound to session ${existing.sessionId}`,
      existing.sessionId
    );
  }

  if (branchExists(projectPath, branchName)) {
    throw new WorktreeError(
      `branch ${branchName} already exists in ${projectPath}`,
      'BRANCH_EXISTS'
    );
  }

  const args = ['worktree', 'add', '-b', branchName, worktreePath];
  if (sourceBranch) args.push(sourceBranch);
  runGit(args, projectPath);

  // Realpath again now that the leaf exists so the stored key matches
  // exactly what `git worktree list --porcelain` will report later.
  const canonicalWorktreePath = canonicalizePath(worktreePath);

  bindings.set({
    worktreePath: canonicalWorktreePath,
    sessionId,
    projectKey: canonicalProjectPath,
    branchName,
  });

  return { worktreePath: canonicalWorktreePath, branchName };
}

// Remove a worktree. Refuses to act on a dirty tree unless `force` is
// set. Optionally deletes the local branch when `deleteBranch` is true
// AND canDeleteBranch returns true (branch tip reachable from HEAD).
//
// Returns: { removed: bool, branchDeleted: bool }
function remove({ worktreePath, force, deleteBranch }) {
  if (!worktreePath) throw new WorktreeError('worktreePath is required', 'INVALID_PATH');
  const canonical = canonicalizePath(worktreePath);
  // Try the canonical form first, then the raw input, so we still find
  // bindings written by older builds that did not canonicalize.
  const binding = bindings.getByPath(canonical) || bindings.getByPath(worktreePath);
  const effectivePath = canonical;
  // We tolerate a missing binding (orphaned worktree on disk) but the
  // worktree path itself must exist for git to act on it.
  const exists = fs.existsSync(effectivePath);
  if (!exists && !binding) {
    return { removed: false, branchDeleted: false };
  }

  if (exists && isDirty({ worktreePath: effectivePath }) && !force) {
    throw new WorktreeError(
      `worktree at ${effectivePath} has uncommitted changes; pass force to remove`,
      'DIRTY'
    );
  }

  // Locate the source repo to run `git worktree remove` against. We
  // prefer the projectKey we stored at bind time; if that is gone, fall
  // back to the worktree's own cwd (still valid: git worktree remove
  // works from any worktree in the same repo).
  const cwd = (binding && binding.projectKey && fs.existsSync(binding.projectKey))
    ? binding.projectKey
    : effectivePath;

  if (exists) {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(effectivePath);
    try {
      runGit(args, cwd);
    } catch (err) {
      // If git refuses but the directory is gone underneath us, prune
      // the bookkeeping and continue. Otherwise, propagate.
      if (fs.existsSync(effectivePath)) throw err;
      try { runGit(['worktree', 'prune'], cwd); } catch {}
    }
  } else {
    // Path is gone but git still tracks it; prune to clean up.
    try { runGit(['worktree', 'prune'], cwd); } catch {}
  }

  let branchDeleted = false;
  if (deleteBranch && binding && binding.branchName) {
    const branch = binding.branchName;
    if (canDeleteBranch({ branchName: branch, projectPath: cwd })) {
      try {
        runGit(['branch', '-d', branch], cwd);
        branchDeleted = true;
      } catch {
        // Defensive: refuse to escalate to -D from this codepath. The
        // user can prune the branch manually if git says no.
        branchDeleted = false;
      }
    }
  }

  // Remove under whichever key actually persisted the binding so the
  // file ends up clean even when the original write used a non
  // canonical path.
  bindings.remove({ worktreePath: canonical });
  if (canonical !== worktreePath) bindings.remove({ worktreePath });
  return { removed: true, branchDeleted };
}

// List worktrees for a given project path by parsing `git worktree list
// --porcelain`. Each record from git is enriched with the bound session
// (if any) so the caller can render "bound to <session>" badges.
function list({ projectPath }) {
  if (!projectPath || !fs.existsSync(projectPath)) return [];
  let raw;
  try {
    raw = runGit(['worktree', 'list', '--porcelain'], projectPath);
  } catch {
    return [];
  }
  const items = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) items.push(current);
      current = { worktreePath: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch ') && current) {
      // "branch refs/heads/<name>"
      const ref = line.slice('branch '.length);
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line === '' && current) {
      items.push(current);
      current = null;
    }
  }
  if (current) items.push(current);

  return items.map(it => {
    // Canonicalize so that git's reported path (which may include macOS
    // /private/var symlink resolution or Windows long-form expansion)
    // matches the canonical key we stored in bindings. Also check
    // path.resolve and the raw value to tolerate older bindings.
    const canonical = canonicalizePath(it.worktreePath);
    const resolved = path.resolve(it.worktreePath);
    const binding = bindings.getByPath(canonical)
      || bindings.getByPath(resolved)
      || bindings.getByPath(it.worktreePath);
    return {
      worktreePath: canonical,
      branchName: it.branch,
      sessionId: binding ? binding.sessionId : null,
    };
  });
}

module.exports = {
  WorktreeAlreadyBoundError,
  WorktreeError,
  sanitizeProjectSlug,
  shortSessionId,
  branchNameFor,
  branchExists,
  canDeleteBranch,
  isDirty,
  getBoundSession,
  create,
  remove,
  list,
};
