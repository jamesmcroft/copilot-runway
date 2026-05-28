const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Isolate HOME so ~/.runway and the worktrees root land under a sandbox.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-wt-mgr-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const settings = require('../lib/runway/settings');
const bindings = require('../lib/runway/worktree-bindings');
const manager = require('../lib/runway/worktree-manager');

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

// Build a minimal one-commit git repo in a fresh temp dir. Sets local
// user identity so commits succeed even when the host has no global git
// config (CI runners often do not).
// On macOS `os.tmpdir()` returns `/var/folders/...` while git and
// fs.realpath canonicalize through the `/private` symlink. On Windows
// `os.tmpdir()` may surface 8.3 short names like `RUNNER~1`. The
// manager normalizes both to the long, symlink-resolved form, so tests
// that compare against constructed paths must do the same. Mirror the
// helper from worktree-manager.js so the assertions match real output.
function canon(p) {
  if (typeof p !== 'string' || !p) return p;
  const real = (fs.realpathSync && fs.realpathSync.native) || fs.realpathSync;
  try { return real(p); } catch { return path.resolve(p); }
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-wt-repo-'));
  git(['init', '--initial-branch=main'], dir);
  git(['config', 'user.email', 'tester@example.com'], dir);
  git(['config', 'user.name', 'Runway Tester'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# sample\n');
  git(['add', '.'], dir);
  git(['commit', '-m', 'initial'], dir);
  return dir;
}

function resetState() {
  try { fs.unlinkSync(bindings.BINDINGS_FILE); } catch {}
  bindings.invalidateCache();
  settings.invalidateCache();
}

const originalWarn = console.warn;
test.before(() => { console.warn = () => {}; });
test.after(() => { console.warn = originalWarn; });

test('sanitizeProjectSlug normalizes and trims', () => {
  assert.equal(manager.sanitizeProjectSlug('/abs/path/Sample Project!'), 'sample-project');
  assert.equal(manager.sanitizeProjectSlug('---weird___NAME---'), 'weird-name');
  assert.equal(manager.sanitizeProjectSlug('/'), 'project');
  assert.equal(manager.sanitizeProjectSlug(''), 'project');
  // No traversal: basename strips parent segments, ".." collapses.
  assert.equal(manager.sanitizeProjectSlug('/foo/..'), 'project');
  // Max length 64.
  const long = manager.sanitizeProjectSlug('/abs/' + 'a'.repeat(120));
  assert.ok(long.length <= 64);
});

test('shortSessionId returns first 8 alphanumeric chars', () => {
  assert.equal(manager.shortSessionId('abcdef1234567890'), 'abcdef12');
  assert.equal(manager.shortSessionId('ab-cd-ef-12-34'), 'abcdef12');
  assert.throws(() => manager.shortSessionId(123));
  assert.throws(() => manager.shortSessionId('----'));
});

test('create makes a worktree, creates branch, persists binding', () => {
  resetState();
  const repo = makeRepo();
  const result = manager.create({ sessionId: 'abc12345-rest', projectPath: repo });
  assert.equal(result.branchName, 'runway/abc12345');
  assert.ok(fs.existsSync(result.worktreePath), 'worktree dir should exist');
  // Branch exists in source repo.
  assert.equal(manager.branchExists(repo, 'runway/abc12345'), true);
  // Binding persisted.
  const b = bindings.getByPath(result.worktreePath);
  assert.equal(b.sessionId, 'abc12345-rest');
  assert.equal(b.branchName, 'runway/abc12345');
  // Path layout: <root>/<slug>/<id-short>; both sides canonicalized so
  // the macOS /private prefix and Windows short names do not skew the
  // comparison.
  const root = settings.getWorktreesRoot();
  const expectedSlug = manager.sanitizeProjectSlug(repo);
  assert.equal(result.worktreePath, canon(path.join(root, expectedSlug, 'abc12345')));
});

test('create produces worktrees root on demand if missing', () => {
  resetState();
  const repo = makeRepo();
  // Point worktrees.root at a brand new directory.
  const customRoot = path.join(tmpHome, 'custom-roots', 'fresh-' + Date.now());
  settings.patchGlobalSettings({ worktrees: { root: customRoot } });
  const result = manager.create({ sessionId: 'fresh001-rest', projectPath: repo });
  assert.ok(fs.existsSync(result.worktreePath));
  // result.worktreePath is canonicalized by manager.create; the raw
  // customRoot may still carry the macOS /var prefix or a Windows short
  // name, so compare against the canonical form.
  assert.ok(result.worktreePath.startsWith(canon(customRoot)));
  // Reset back so other tests use the default location.
  settings.patchGlobalSettings({ worktrees: { root: path.join(tmpHome, '.runway', 'worktrees') } });
  settings.invalidateCache();
});

test('create refuses when target branch already exists', () => {
  resetState();
  const repo = makeRepo();
  git(['branch', 'runway/dup12345'], repo);
  assert.throws(
    () => manager.create({ sessionId: 'dup12345-rest', projectPath: repo }),
    err => err.code === 'BRANCH_EXISTS'
  );
  // No filesystem mutation: worktree path must not exist.
  const root = settings.getWorktreesRoot();
  const slug = manager.sanitizeProjectSlug(repo);
  assert.equal(fs.existsSync(path.join(root, slug, 'dup12345')), false);
});

test('create twice for same session id throws WorktreeAlreadyBoundError', () => {
  resetState();
  const repo = makeRepo();
  const first = manager.create({ sessionId: 'conc1234-rest', projectPath: repo });
  // Force a second attempt that targets the same path: simulate a
  // different session binding to the existing slot by manually rebinding
  // first to a different session, then trying to bind a new session that
  // would resolve to the same path. Easier: same session id retried, the
  // bindings check fires first.
  assert.throws(
    () => manager.create({ sessionId: 'conc1234-rest', projectPath: repo }),
    err => err instanceof manager.WorktreeAlreadyBoundError && err.sessionId === 'conc1234-rest'
  );
  // Cleanup so this test does not leak state into a later test if the
  // suite is run with --test-concurrency=1.
  manager.remove({ worktreePath: first.worktreePath, force: true, deleteBranch: true });
});

test('remove on a clean worktree succeeds and clears the binding', () => {
  resetState();
  const repo = makeRepo();
  const { worktreePath } = manager.create({ sessionId: 'clean123-rest', projectPath: repo });
  const result = manager.remove({ worktreePath });
  assert.equal(result.removed, true);
  assert.equal(fs.existsSync(worktreePath), false);
  assert.equal(bindings.getByPath(worktreePath), null);
});

test('remove on dirty worktree without force throws DIRTY', () => {
  resetState();
  const repo = makeRepo();
  const { worktreePath } = manager.create({ sessionId: 'dirty123-rest', projectPath: repo });
  fs.writeFileSync(path.join(worktreePath, 'new-file.txt'), 'change');
  assert.equal(manager.isDirty({ worktreePath }), true);
  assert.throws(
    () => manager.remove({ worktreePath }),
    err => err.code === 'DIRTY'
  );
  // Force succeeds.
  const result = manager.remove({ worktreePath, force: true });
  assert.equal(result.removed, true);
});

test('canDeleteBranch is true for an untouched branch and false after a commit', () => {
  resetState();
  const repo = makeRepo();
  const { worktreePath, branchName } = manager.create({ sessionId: 'gate1234-rest', projectPath: repo });
  // Fresh branch: same tip as HEAD, so canDeleteBranch is true.
  assert.equal(manager.canDeleteBranch({ branchName, projectPath: repo }), true);
  // Commit something on the branch (inside the worktree).
  git(['config', 'user.email', 'tester@example.com'], worktreePath);
  git(['config', 'user.name', 'Runway Tester'], worktreePath);
  fs.writeFileSync(path.join(worktreePath, 'new-feature.txt'), 'work');
  git(['add', '.'], worktreePath);
  git(['commit', '-m', 'work on branch'], worktreePath);
  assert.equal(manager.canDeleteBranch({ branchName, projectPath: repo }), false);
  manager.remove({ worktreePath, force: true });
});

test('remove with deleteBranch=true honors the gate', () => {
  resetState();
  const repo = makeRepo();
  // Path A: clean branch, deletion happens.
  const a = manager.create({ sessionId: 'delok123-rest', projectPath: repo });
  let result = manager.remove({ worktreePath: a.worktreePath, deleteBranch: true });
  assert.equal(result.branchDeleted, true);
  assert.equal(manager.branchExists(repo, a.branchName), false);

  // Path B: branch has unique commits, deletion is refused.
  const b = manager.create({ sessionId: 'delno123-rest', projectPath: repo });
  git(['config', 'user.email', 't@e.com'], b.worktreePath);
  git(['config', 'user.name', 'T'], b.worktreePath);
  fs.writeFileSync(path.join(b.worktreePath, 'x.txt'), 'x');
  git(['add', '.'], b.worktreePath);
  git(['commit', '-m', 'wip'], b.worktreePath);
  result = manager.remove({ worktreePath: b.worktreePath, force: true, deleteBranch: true });
  assert.equal(result.branchDeleted, false);
  assert.equal(manager.branchExists(repo, b.branchName), true);
});

test('list reports worktrees enriched with bound session', () => {
  resetState();
  const repo = makeRepo();
  const wt = manager.create({ sessionId: 'list1234-rest', projectPath: repo });
  const items = manager.list({ projectPath: repo });
  const found = items.find(i => i.worktreePath === wt.worktreePath
    || path.resolve(i.worktreePath) === path.resolve(wt.worktreePath));
  assert.ok(found, `expected to find created worktree in list; got ${JSON.stringify(items)}`);
  assert.equal(found.sessionId, 'list1234-rest');
  manager.remove({ worktreePath: wt.worktreePath, force: true });
});

test('getWorktreesRoot expands a leading ~', () => {
  resetState();
  // ~/... is not an absolute path so the validator rejects PATCH; write
  // directly to the on-disk doc and invalidate the cache to exercise the
  // expansion path.
  const { SETTINGS_FILE } = require('../lib/paths');
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    schema_version: 1,
    values: { worktrees: { root: '~/expanded-worktrees' } },
  }));
  settings.invalidateCache();
  const root = settings.getWorktreesRoot();
  assert.equal(root, path.join(os.homedir(), 'expanded-worktrees'));
  // Restore.
  try { fs.unlinkSync(SETTINGS_FILE); } catch {}
  settings.invalidateCache();
});
