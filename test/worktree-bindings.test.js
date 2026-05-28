const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the bindings file under a temp HOME. paths.js resolves HOME at
// require time, so this must happen before any module load that uses it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-wt-bindings-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const bindings = require('../lib/runway/worktree-bindings');

function reset() {
  try { fs.unlinkSync(bindings.BINDINGS_FILE); } catch {}
  bindings.invalidateCache();
}

const originalWarn = console.warn;
test.before(() => { console.warn = () => {}; });
test.after(() => { console.warn = originalWarn; });

test('load returns empty document when file missing', () => {
  reset();
  const doc = bindings.load();
  assert.deepEqual(doc.bindings, {});
});

test('set persists and getByPath / getBySessionId read it back', () => {
  reset();
  const entry = bindings.set({
    worktreePath: '/tmp/a/abc12345',
    sessionId: 'abc12345-xxx',
    projectKey: '/abs/sample-project',
    branchName: 'runway/abc12345',
  });
  assert.equal(entry.sessionId, 'abc12345-xxx');
  assert.ok(entry.createdAt);
  bindings.invalidateCache();
  assert.equal(bindings.getByPath('/tmp/a/abc12345').sessionId, 'abc12345-xxx');
  assert.equal(bindings.getBySessionId('abc12345-xxx').worktreePath, '/tmp/a/abc12345');
});

test('remove deletes the entry and persists', () => {
  reset();
  bindings.set({ worktreePath: '/tmp/p/one', sessionId: 's1', projectKey: '/p', branchName: 'runway/s1' });
  assert.equal(bindings.remove({ worktreePath: '/tmp/p/one' }), true);
  bindings.invalidateCache();
  assert.equal(bindings.getByPath('/tmp/p/one'), null);
  assert.equal(bindings.remove({ worktreePath: '/tmp/p/none' }), false);
});

test('list returns every entry', () => {
  reset();
  bindings.set({ worktreePath: '/tmp/p/one', sessionId: 's1', projectKey: '/p', branchName: 'runway/s1' });
  bindings.set({ worktreePath: '/tmp/p/two', sessionId: 's2', projectKey: '/p', branchName: 'runway/s2' });
  const all = bindings.list().map(x => x.sessionId).sort();
  assert.deepEqual(all, ['s1', 's2']);
});

test('malformed JSON does not crash; returns empty bindings', () => {
  reset();
  fs.writeFileSync(bindings.BINDINGS_FILE, '{ not json');
  bindings.invalidateCache();
  assert.deepEqual(bindings.load().bindings, {});
});

test('non object root does not crash; returns empty bindings', () => {
  reset();
  fs.writeFileSync(bindings.BINDINGS_FILE, JSON.stringify(['a', 'b']));
  bindings.invalidateCache();
  assert.deepEqual(bindings.load().bindings, {});
});

test('corrupt individual row is dropped silently', () => {
  reset();
  fs.writeFileSync(bindings.BINDINGS_FILE, JSON.stringify({
    schema_version: 1,
    bindings: {
      '/good': { sessionId: 'g', branchName: 'runway/g', projectKey: '/p', createdAt: '2024-01-01' },
      '/bad-shape': 'oops',
      '/missing-fields': { sessionId: 'x' },
    },
  }));
  bindings.invalidateCache();
  const doc = bindings.load();
  assert.deepEqual(Object.keys(doc.bindings), ['/good']);
});

test('writes are atomic (no leftover tmp file)', () => {
  reset();
  bindings.set({ worktreePath: '/tmp/x', sessionId: 's', projectKey: '/p', branchName: 'runway/s' });
  const dir = path.dirname(bindings.BINDINGS_FILE);
  const leftover = fs.readdirSync(dir).filter(f => f.startsWith('worktree-bindings.json.') && f.endsWith('.tmp'));
  assert.deepEqual(leftover, []);
});

test('set requires worktreePath, sessionId, branchName', () => {
  reset();
  assert.throws(() => bindings.set({ sessionId: 's', branchName: 'b' }));
  assert.throws(() => bindings.set({ worktreePath: '/p', branchName: 'b' }));
  assert.throws(() => bindings.set({ worktreePath: '/p', sessionId: 's' }));
});
