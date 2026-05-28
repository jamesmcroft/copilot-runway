const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Override HOME before any module that resolves paths is loaded so the
// session-store DB and ~/.runway locations land under a sandbox.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-branch-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const copilotDir = path.join(tmpHome, '.copilot');
const sessionStateDir = path.join(copilotDir, 'session-state');
fs.mkdirSync(sessionStateDir, { recursive: true });

const dbPath = path.join(copilotDir, 'session-store.db');

const Database = require('better-sqlite3');
const seedDb = new Database(dbPath);
seedDb.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    cwd TEXT,
    repository TEXT,
    branch TEXT,
    summary TEXT,
    created_at TEXT,
    updated_at TEXT,
    host_type TEXT
  );
  CREATE TABLE turns (
    session_id TEXT,
    turn_index INTEGER,
    user_message TEXT,
    assistant_response TEXT,
    timestamp TEXT
  );
  CREATE TABLE session_refs (
    session_id TEXT,
    ref_type TEXT,
    ref_value TEXT,
    created_at TEXT
  );
`);

// Create a real on-disk git repo so the helper exercises actual git output
// rather than a mock. Mirrors the "integration over mocks" preference.
const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-branch-repo-'));
function git(...args) {
  execFileSync('git', args, { cwd: repoDir, stdio: ['ignore', 'pipe', 'ignore'] });
}
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'Test');
git('commit', '--allow-empty', '-q', '-m', 'init');

// One session per scenario. All point at the real repo so the live lookup
// has something to report.
const insertSession = seedDb.prepare(`
  INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
insertSession.run('active-session', repoDir, 'octo/repo', 'recorded-branch', 'Active',
  '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', 'cli');
insertSession.run('inactive-session', repoDir, 'octo/repo', 'recorded-branch', 'Inactive',
  '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', 'cli');
insertSession.run('bad-cwd-session', path.join(tmpHome, 'definitely-not-a-repo'),
  'octo/repo', 'recorded-branch', 'BadCwd',
  '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', 'cli');

seedDb.close();

// Mark "active-session" and "bad-cwd-session" as active by dropping an
// inuse lock file pointing at this test process (which is, by definition,
// alive while these tests run).
for (const id of ['active-session', 'bad-cwd-session']) {
  const dir = path.join(sessionStateDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `inuse.${process.pid}.lock`), String(process.pid));
}

const branchMod = require('../lib/runway/branch');
const { getActiveBranch, clearBranchCache, __setNowForTests } = branchMod;

const express = require('express');
const sessionsRouter = require('../lib/routes/sessions');
const app = express();
app.use('/api/sessions', sessionsRouter);

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  __setNowForTests(null);
  await new Promise(resolve => server.close(resolve));
});

test.beforeEach(() => {
  clearBranchCache();
  __setNowForTests(null);
});

test('getActiveBranch returns the current branch from a real repo', () => {
  assert.equal(getActiveBranch(repoDir), 'main');
});

test('getActiveBranch reflects a mid-session checkout (workspace.yaml would not)', () => {
  git('checkout', '-q', '-b', 'feature/x');
  try {
    assert.equal(getActiveBranch(repoDir), 'feature/x');
  } finally {
    git('checkout', '-q', 'main');
  }
});

test('cache hit avoids a second git spawn within the TTL window', () => {
  // Prime the cache, then rename the on-disk branch out from under us. A
  // cache hit must still return the original value; a cache miss would
  // pick up the rename.
  assert.equal(getActiveBranch(repoDir), 'main');
  git('branch', '-m', 'main', 'renamed');
  try {
    assert.equal(getActiveBranch(repoDir), 'main', 'cached value used');
  } finally {
    git('branch', '-m', 'renamed', 'main');
  }
});

test('TTL expiry triggers a fresh lookup', () => {
  let clock = 1_000_000;
  __setNowForTests(() => clock);
  assert.equal(getActiveBranch(repoDir), 'main');

  git('checkout', '-q', '-b', 'feature/ttl');
  try {
    // Still inside the 30s window: cached value returned.
    clock += 29_000;
    assert.equal(getActiveBranch(repoDir), 'main');
    // Cross the TTL boundary: fresh spawn picks up the new branch.
    clock += 2_000;
    assert.equal(getActiveBranch(repoDir), 'feature/ttl');
  } finally {
    git('checkout', '-q', 'main');
    git('branch', '-D', '-q', 'feature/ttl');
  }
});

test('git error returns null and is cached for the TTL window', () => {
  const bogus = path.join(tmpHome, 'definitely-not-a-repo');
  assert.equal(getActiveBranch(bogus), null);
  // The cache entry exists and holds null; the second call is a hit, not
  // a fresh spawn (verified indirectly: the helper never throws and
  // returns the same null synchronously even if git would have failed
  // again).
  assert.equal(getActiveBranch(bogus), null);
});

test('GET /api/sessions: active session shows live branch; inactive shows recorded branch', async () => {
  const res = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(res.status, 200);
  const list = await res.json();

  const active = list.find(s => s.id === 'active-session');
  const inactive = list.find(s => s.id === 'inactive-session');
  assert.ok(active && inactive);

  assert.equal(active.status, 'active');
  assert.equal(active.branch, 'main', 'live git branch wins for active session');

  assert.notEqual(inactive.status, 'active');
  assert.equal(inactive.branch, 'recorded-branch',
    'inactive session falls back to workspace/db branch (no git spawn)');
});

test('GET /api/sessions: active session with broken cwd falls back to recorded branch', async () => {
  clearBranchCache();
  const res = await fetch(`${baseUrl}/api/sessions`);
  const list = await res.json();
  const bad = list.find(s => s.id === 'bad-cwd-session');
  assert.ok(bad);
  assert.equal(bad.status, 'active');
  assert.equal(bad.branch, 'recorded-branch',
    'git failure on bad cwd falls through to workspace/db branch');
});
