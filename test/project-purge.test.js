// Unit tests for the project purge sweep (issue #54).
//
// Exercises the dynamic store registry, the default stores, and the
// resilient-to-partial-state contract. The HTTP route layer has its
// own suite in project-removal-routes.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate HOME under a temp dir BEFORE any module load that resolves
// ~/.runway/<file> at require time.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-purge-test-'));
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

// Synthetic, OS-agnostic project keys. The tests never touch real
// filesystem locations; they only exercise JSON state manipulation.
const PROJECT_A = process.platform === 'win32'
  ? 'C:\\dev\\sample-project'
  : '/home/dev/sample-project';
const PROJECT_B = process.platform === 'win32'
  ? 'C:\\dev\\other-project'
  : '/home/dev/other-project';
const PROJECT_A_SESSION_CWD = process.platform === 'win32'
  ? 'C:\\dev\\sample-project\\sub'
  : '/home/dev/sample-project/sub';

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function tryUnlink(file) {
  try { fs.unlinkSync(file); } catch {}
}

function resetAll() {
  for (const f of [CUSTOM_PROJECTS_FILE, PROJECT_SETTINGS_FILE, PINS_FILE, SESSION_AGENTS_FILE, bindings.BINDINGS_FILE]) {
    tryUnlink(f);
  }
  bindings.invalidateCache();
  settings.invalidateCache();
  // Restore default registry in case a prior test cleared it.
  purge.clearStores();
  purge.registerDefaults();
}

const originalWarn = console.warn;
test.before(() => { console.warn = () => {}; });
test.after(() => { console.warn = originalWarn; });

test('summarizeProject returns zero counts when nothing on disk', () => {
  resetAll();
  const counts = purge.summarizeProject(PROJECT_A, {});
  for (const v of Object.values(counts)) assert.equal(v, 0);
});

test('hasAnyState is false for an unknown project key', () => {
  resetAll();
  assert.equal(purge.hasAnyState(PROJECT_A, {}), false);
});

test('full sweep happy path purges every default store', () => {
  resetAll();
  // Seed every project-scoped store.
  writeJson(CUSTOM_PROJECTS_FILE, [
    { id: 'custom-1', name: 'sample-project', main_repo_path: PROJECT_A },
    { id: 'custom-2', name: 'other-project', main_repo_path: PROJECT_B },
  ]);
  writeJson(PROJECT_SETTINGS_FILE, {
    schema_version: 1,
    projects: {
      [PROJECT_A]: { defaults: { agent: 'sample-agent' } },
      [PROJECT_B]: { defaults: { agent: 'other-agent' } },
    },
  });
  writeJson(PINS_FILE, { sessions: ['sess-a', 'sess-b', 'sess-x'] });
  writeJson(SESSION_AGENTS_FILE, {
    'sess-a': 'agent-1',
    'sess-b': 'agent-2',
    'sess-x': 'agent-3',
  });
  bindings.set({
    worktreePath: process.platform === 'win32'
      ? 'C:\\dev\\worktrees\\sample-project\\abcdef12'
      : '/home/dev/worktrees/sample-project/abcdef12',
    sessionId: 'sess-a',
    projectKey: PROJECT_A,
    branchName: 'runway/abcdef12',
  });
  bindings.set({
    worktreePath: process.platform === 'win32'
      ? 'C:\\dev\\worktrees\\other-project\\12345678'
      : '/home/dev/worktrees/other-project/12345678',
    sessionId: 'sess-x',
    projectKey: PROJECT_B,
    branchName: 'runway/12345678',
  });

  const ctx = {
    getSessionIdsForProject: (key) => purge.sameKey(key, PROJECT_A) ? ['sess-a', 'sess-b'] : [],
  };

  // Confirm summary picks up the right counts before mutation.
  const before = purge.summarizeProject(PROJECT_A, ctx);
  assert.equal(before.projects, 1);
  assert.equal(before.projectSettings, 1);
  assert.equal(before.pins, 2);
  assert.equal(before.sessionAgents, 2);
  assert.equal(before.worktreeBindings, 1);

  const result = purge.purgeProject(PROJECT_A, ctx);
  assert.equal(result.projects.removed, 1);
  assert.equal(result.projectSettings.removed, 1);
  assert.equal(result.pins.removed, 2);
  assert.equal(result.sessionAgents.removed, 2);
  assert.equal(result.worktreeBindings.removed, 1);

  // Project B entries are untouched in every store.
  const customLeft = JSON.parse(fs.readFileSync(CUSTOM_PROJECTS_FILE, 'utf8'));
  assert.equal(customLeft.length, 1);
  assert.equal(customLeft[0].main_repo_path, PROJECT_B);

  const psLeft = JSON.parse(fs.readFileSync(PROJECT_SETTINGS_FILE, 'utf8'));
  assert.deepEqual(Object.keys(psLeft.projects), [PROJECT_B]);

  const pinsLeft = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'));
  assert.deepEqual(pinsLeft.sessions, ['sess-x']);

  const agentsLeft = JSON.parse(fs.readFileSync(SESSION_AGENTS_FILE, 'utf8'));
  assert.deepEqual(Object.keys(agentsLeft), ['sess-x']);

  const bindingsLeft = bindings.list();
  assert.equal(bindingsLeft.length, 1);
  assert.equal(bindingsLeft[0].sessionId, 'sess-x');

  // Re-running the sweep on the same key is a no-op (idempotent).
  assert.equal(purge.hasAnyState(PROJECT_A, ctx), false);
});

test('sweep is resilient to missing and malformed files', () => {
  resetAll();
  // Only one of the four files exists, and one of them is corrupt.
  fs.writeFileSync(CUSTOM_PROJECTS_FILE, '{ not valid json');
  writeJson(PINS_FILE, { sessions: ['sess-a'] });

  const ctx = { getSessionIdsForProject: () => ['sess-a'] };
  // Should not throw despite the corrupt projects file and the
  // missing project-settings / session-agents / bindings files.
  const result = purge.purgeProject(PROJECT_A, ctx);
  // pins.json still got swept cleanly.
  assert.equal(result.pins.removed, 1);
});

test('registerStore picks up a brand new store with no route changes', () => {
  resetAll();
  let called = 0;
  purge.registerStore({
    name: 'futureStore',
    summarize() { called += 1; return 7; },
    purge() { called += 1; return { removed: 7 }; },
  });
  const summary = purge.summarizeProject(PROJECT_A, {});
  assert.equal(summary.futureStore, 7);
  assert.equal(purge.hasAnyState(PROJECT_A, {}), true);
  const result = purge.purgeProject(PROJECT_A, {});
  assert.equal(result.futureStore.removed, 7);
  assert.ok(called >= 2);
});

test('Windows project key match is case-insensitive', { skip: process.platform !== 'win32' }, () => {
  resetAll();
  writeJson(CUSTOM_PROJECTS_FILE, [
    { id: 'c', name: 'sample', main_repo_path: 'C:\\Dev\\Sample-Project' },
  ]);
  const counts = purge.summarizeProject('c:\\dev\\sample-project', {});
  assert.equal(counts.projects, 1);
});

test('settings resolver returns global defaults for removed project keys', () => {
  resetAll();
  // Seed a global default and a per-project override, then purge.
  settings.patchGlobalSettings({ defaults: { agent: 'global-agent' } });
  settings.patchProjectSettings(PROJECT_A, { defaults: { agent: 'project-agent' } });

  // Resolver respects the override before the purge.
  assert.equal(settings.resolveSetting('defaults.agent', PROJECT_A), 'project-agent');

  const result = purge.purgeProject(PROJECT_A, { getSessionIdsForProject: () => [] });
  assert.equal(result.projectSettings.removed, 1);

  // After purge: resolver falls back to the global default for the
  // now-removed project key. This is the #53 interaction the issue
  // calls out as regression coverage.
  assert.equal(settings.resolveSetting('defaults.agent', PROJECT_A), 'global-agent');
  const resolved = settings.getResolvedValues(PROJECT_A);
  assert.equal(resolved.values.defaults.agent, 'global-agent');
});

// Touch the synthetic constant so lint does not complain about the
// unused identifier when a future test adds project-A session work.
void PROJECT_A_SESSION_CWD;
