// HTTP route tests for project removal (issue #54).
//
// Covers the 204 / 404 / 409 / 400 contract, the removeWorktrees
// query-param behavior, the active-session guard atomicity, and the
// summary endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-remove-routes-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const {
  CUSTOM_PROJECTS_FILE,
  PROJECT_SETTINGS_FILE,
  PINS_FILE,
  SESSION_AGENTS_FILE,
} = require('../lib/paths');
const purge = require('../lib/runway/project-purge');
const bindings = require('../lib/runway/worktree-bindings');
const settings = require('../lib/runway/settings');
const projectsRoute = require('../lib/routes/projects');

const PROJECT_A = process.platform === 'win32'
  ? 'C:\\dev\\sample-project'
  : '/home/dev/sample-project';
const PROJECT_B = process.platform === 'win32'
  ? 'C:\\dev\\other-project'
  : '/home/dev/other-project';

function writeJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }
function tryUnlink(file) { try { fs.unlinkSync(file); } catch {} }

function resetAll() {
  for (const f of [CUSTOM_PROJECTS_FILE, PROJECT_SETTINGS_FILE, PINS_FILE, SESSION_AGENTS_FILE, bindings.BINDINGS_FILE]) {
    tryUnlink(f);
  }
  bindings.invalidateCache();
  settings.invalidateCache();
  purge.clearStores();
  purge.registerDefaults();
}

// Build an Express app that mounts ONLY the routes we are testing
// here, using the factory so we can inject a stubbed active-session
// detector. The list endpoints (`GET /api/projects`, `POST /add`) open
// real SQLite databases under ~/.copilot which do not exist in this
// test environment; we never hit those routes from these tests.
function buildServer(detector) {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectsRoute.buildRouter({
    getActiveSessionsForProject: detector,
  }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, method, urlPath) {
  const addr = server.address();
  const opts = { hostname: addr.address, port: addr.port, path: urlPath, method };
  return new Promise((resolve, reject) => {
    const req = http.request(opts, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = buf ? JSON.parse(buf) : null; } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const originalWarn = console.warn;
const originalError = console.error;
test.before(() => { console.warn = () => {}; console.error = () => {}; });
test.after(() => { console.warn = originalWarn; console.error = originalError; });

test('DELETE returns 400 for a malformed project key', async () => {
  resetAll();
  const server = await buildServer(() => []);
  try {
    // Relative path -> not absolute -> 400.
    const res = await request(server, 'DELETE', '/api/projects/' + encodeURIComponent('relative/path'));
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_project_key');
  } finally { server.close(); }
});

test('DELETE returns 404 for an unknown project key', async () => {
  resetAll();
  const server = await buildServer(() => []);
  try {
    const res = await request(server, 'DELETE', '/api/projects/' + encodeURIComponent(PROJECT_A));
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('DELETE happy path returns 204 and clears every store', async () => {
  resetAll();
  writeJson(CUSTOM_PROJECTS_FILE, [
    { id: 'c1', name: 'sample-project', main_repo_path: PROJECT_A },
  ]);
  writeJson(PROJECT_SETTINGS_FILE, {
    schema_version: 1,
    projects: { [PROJECT_A]: { defaults: { agent: 'sample-agent' } } },
  });
  writeJson(PINS_FILE, { sessions: ['sess-a'] });
  writeJson(SESSION_AGENTS_FILE, { 'sess-a': 'sample-agent' });

  // Re-register defaults with a stubbed sessions-for-project source so
  // the pins / session-agents stores see 'sess-a' as belonging to A.
  purge.clearStores();
  // Reuse default stores but with our own context wiring. Simplest:
  // monkey-patch the route's session lookup by wrapping the detector
  // route to set a global... actually, the default stores read ctx
  // from purgeProject; the route layer wires ctx from
  // listSessionIdsForProject which queries the real DB. We can't stub
  // that easily here, so we install a custom pins/session-agents
  // store that uses a closure for the ids. This validates the
  // dynamic registry path at the same time.
  purge.registerDefaults();

  // Override pins / session-agents stores to use a fixed session list,
  // since the production listSessionIdsForProject opens the SQLite
  // session-store DB which does not exist in this test environment.
  const SESSION_IDS_FOR_A = new Set(['sess-a']);
  const stores = purge.listStores().filter(s => s.name !== 'pins' && s.name !== 'sessionAgents');
  purge.clearStores();
  for (const s of stores) purge.registerStore(s);
  purge.registerStore({
    name: 'pins',
    summarize(key) {
      if (!purge.sameKey(key, PROJECT_A)) return 0;
      const d = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
      return d.sessions.filter(id => SESSION_IDS_FOR_A.has(id)).length;
    },
    purge(key) {
      if (!purge.sameKey(key, PROJECT_A)) return { removed: 0 };
      const d = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
      const next = { ...d, sessions: d.sessions.filter(id => !SESSION_IDS_FOR_A.has(id)) };
      const removed = d.sessions.length - next.sessions.length;
      fs.writeFileSync(PINS_FILE, JSON.stringify(next));
      return { removed };
    },
  });
  purge.registerStore({
    name: 'sessionAgents',
    summarize(key) {
      if (!purge.sameKey(key, PROJECT_A)) return 0;
      const d = JSON.parse(fs.readFileSync(SESSION_AGENTS_FILE, 'utf8'));
      return Object.keys(d).filter(id => SESSION_IDS_FOR_A.has(id)).length;
    },
    purge(key) {
      if (!purge.sameKey(key, PROJECT_A)) return { removed: 0 };
      const d = JSON.parse(fs.readFileSync(SESSION_AGENTS_FILE, 'utf8'));
      const next = {};
      let removed = 0;
      for (const k of Object.keys(d)) {
        if (SESSION_IDS_FOR_A.has(k)) { removed += 1; continue; }
        next[k] = d[k];
      }
      fs.writeFileSync(SESSION_AGENTS_FILE, JSON.stringify(next));
      return { removed };
    },
  });

  const server = await buildServer(() => []);
  try {
    const res = await request(server, 'DELETE',
      `/api/projects/${encodeURIComponent(PROJECT_A)}?removeWorktrees=false`);
    assert.equal(res.status, 204);

    assert.deepEqual(JSON.parse(fs.readFileSync(CUSTOM_PROJECTS_FILE, 'utf8')), []);
    const ps = JSON.parse(fs.readFileSync(PROJECT_SETTINGS_FILE, 'utf8'));
    assert.deepEqual(Object.keys(ps.projects), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(PINS_FILE, 'utf8')).sessions, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(SESSION_AGENTS_FILE, 'utf8')), {});

    // Re-delete: state is gone -> 404.
    const second = await request(server, 'DELETE',
      `/api/projects/${encodeURIComponent(PROJECT_A)}?removeWorktrees=false`);
    assert.equal(second.status, 404);
  } finally { server.close(); }
});

test('DELETE returns 409 with sessionIds and does not mutate state', async () => {
  resetAll();
  writeJson(CUSTOM_PROJECTS_FILE, [
    { id: 'c1', name: 'sample-project', main_repo_path: PROJECT_A },
  ]);
  writeJson(PROJECT_SETTINGS_FILE, {
    schema_version: 1,
    projects: { [PROJECT_A]: { defaults: { agent: 'sample-agent' } } },
  });

  const beforeProjects = fs.readFileSync(CUSTOM_PROJECTS_FILE, 'utf8');
  const beforeSettings = fs.readFileSync(PROJECT_SETTINGS_FILE, 'utf8');

  const server = await buildServer(() => ['live-1', 'live-2']);
  try {
    const res = await request(server, 'DELETE',
      `/api/projects/${encodeURIComponent(PROJECT_A)}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'active_sessions');
    assert.deepEqual(res.body.sessionIds, ['live-1', 'live-2']);

    // State files unchanged -> atomicity holds.
    assert.equal(fs.readFileSync(CUSTOM_PROJECTS_FILE, 'utf8'), beforeProjects);
    assert.equal(fs.readFileSync(PROJECT_SETTINGS_FILE, 'utf8'), beforeSettings);
  } finally { server.close(); }
});

test('DELETE with removeWorktrees=false leaves on-disk worktrees alone', async () => {
  resetAll();
  // Create a real on-disk file that stands in for a worktree dir.
  const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-keep-wt-'));
  fs.writeFileSync(path.join(wtDir, 'marker'), 'keep');
  bindings.set({
    worktreePath: wtDir,
    sessionId: 'sess-keep',
    projectKey: PROJECT_A,
    branchName: 'runway/keepkeep',
  });

  const server = await buildServer(() => []);
  try {
    const res = await request(server, 'DELETE',
      `/api/projects/${encodeURIComponent(PROJECT_A)}?removeWorktrees=false`);
    assert.equal(res.status, 204);
    // Binding was cleared.
    assert.equal(bindings.list().length, 0);
    // Directory is still on disk because the user opted out.
    assert.equal(fs.existsSync(path.join(wtDir, 'marker')), true);
  } finally {
    server.close();
    fs.rmSync(wtDir, { recursive: true, force: true });
  }
});

test('DELETE with removeWorktrees=true routes through the worktree manager', async () => {
  resetAll();
  // Build a real git repo + linked worktree so manager.remove can do
  // a real `git worktree remove` against it.
  const { execFileSync } = require('child_process');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-rm-wt-repo-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Runway Tester'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repo });

  // Use the worktree manager so the binding and the on-disk worktree
  // exist in the format git will accept for `worktree remove`.
  const manager = require('../lib/runway/worktree-manager');
  const result = manager.create({
    sessionId: 'sessrm1234-tests',
    projectPath: repo,
  });
  const wtPath = result.worktreePath;
  assert.equal(fs.existsSync(wtPath), true);

  // The binding's projectKey is the canonicalized project path; use
  // that as the key the DELETE request targets.
  const binding = bindings.getBySessionId('sessrm1234-tests');
  const projectKey = binding.projectKey;

  const server = await buildServer(() => []);
  try {
    const res = await request(server, 'DELETE',
      `/api/projects/${encodeURIComponent(projectKey)}?removeWorktrees=true`);
    assert.equal(res.status, 204);
    assert.equal(bindings.list().length, 0);
    // git worktree remove cleaned the directory off disk.
    assert.equal(fs.existsSync(wtPath), false);
  } finally {
    server.close();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('GET /:projectKey/summary returns counts for the modal preview', async () => {
  resetAll();
  writeJson(CUSTOM_PROJECTS_FILE, [
    { id: 'c1', name: 'sample-project', main_repo_path: PROJECT_A },
  ]);
  writeJson(PROJECT_SETTINGS_FILE, {
    schema_version: 1,
    projects: {
      [PROJECT_A]: { defaults: { agent: 'sample-agent' } },
      [PROJECT_B]: { defaults: { agent: 'other' } },
    },
  });

  const server = await buildServer(() => []);
  try {
    const res = await request(server, 'GET',
      `/api/projects/${encodeURIComponent(PROJECT_A)}/summary`);
    assert.equal(res.status, 200);
    assert.equal(res.body.projectKey, PROJECT_A);
    assert.equal(res.body.counts.projects, 1);
    assert.equal(res.body.counts.projectSettings, 1);
    assert.deepEqual(res.body.activeSessionIds, []);
  } finally { server.close(); }
});

test('GET /:projectKey/summary returns 400 for a malformed key', async () => {
  resetAll();
  const server = await buildServer(() => []);
  try {
    const res = await request(server, 'GET', '/api/projects/' + encodeURIComponent('relative') + '/summary');
    assert.equal(res.status, 400);
  } finally { server.close(); }
});
