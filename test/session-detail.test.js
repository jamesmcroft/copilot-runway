// Session detail endpoint + per-file VS Code launch (issue #35).
//
// Covers the merged turns/session_files chronology, cursor pagination,
// NULL turn_index handling, terminal-discovered (host_type='cli') rows,
// and the new path validation on POST /api/sessions/:id/launch/vscode.
//
// Mirrors the HOME override + sqlite seed pattern from sessions-list.test.js
// so the routes can be exercised without touching the user's real
// ~/.copilot or ~/.runway directories.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-session-detail-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const copilotDir = path.join(tmpHome, '.copilot');
fs.mkdirSync(path.join(copilotDir, 'session-state'), { recursive: true });
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
  CREATE TABLE checkpoints (
    session_id TEXT,
    checkpoint_number INTEGER,
    title TEXT,
    overview TEXT,
    created_at TEXT
  );
  CREATE TABLE session_files (
    session_id TEXT,
    file_path TEXT,
    tool_name TEXT,
    turn_index INTEGER,
    first_seen_at TEXT
  );
`);

const insertSession = seedDb.prepare(`
  INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTurn = seedDb.prepare(`
  INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
  VALUES (?, ?, ?, ?, ?)
`);
const insertFile = seedDb.prepare(`
  INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at)
  VALUES (?, ?, ?, ?, ?)
`);

// All sessions use a synthetic /tmp/repo cwd to keep the tests platform
// neutral. The per-file launch tests also exercise a Windows-style cwd
// via a cross-platform path resolver.
const REPO_CWD = '/tmp/repo';

// a) turns-only: chronology equals turns exactly.
insertSession.run('turns-only', REPO_CWD, 'octo/repo', 'main', 'Turns only',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
insertTurn.run('turns-only', 0, 'hi', 'response zero', '2025-01-01T00:00:00Z');
insertTurn.run('turns-only', 1, 'more', 'response one', '2025-01-01T00:01:00Z');

// b) single-file turn: file appears immediately after its assistant turn.
insertSession.run('single-file', REPO_CWD, 'octo/repo', 'main', 'Single file',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
insertTurn.run('single-file', 0, 'edit something', 'done', '2025-01-01T00:00:00Z');
insertFile.run('single-file', '/tmp/repo/src/a.js', 'edit', 0, '2025-01-01T00:00:30Z');
insertTurn.run('single-file', 1, 'next', 'ok', '2025-01-01T00:01:00Z');

// c) multi-file turn: ordered by first_seen_at then file_path.
insertSession.run('multi-file', REPO_CWD, 'octo/repo', 'main', 'Multi file',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
insertTurn.run('multi-file', 0, 'do many things', 'ok', '2025-01-01T00:00:00Z');
insertFile.run('multi-file', '/tmp/repo/src/c.js', 'create', 0, '2025-01-01T00:00:30Z');
insertFile.run('multi-file', '/tmp/repo/src/a.js', 'edit', 0, '2025-01-01T00:00:10Z');
insertFile.run('multi-file', '/tmp/repo/src/b.js', 'edit', 0, '2025-01-01T00:00:20Z');

// d) tied first_seen_at: deterministic by file_path.
insertSession.run('tied-files', REPO_CWD, 'octo/repo', 'main', 'Tied files',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
insertTurn.run('tied-files', 0, 'go', 'ok', '2025-01-01T00:00:00Z');
insertFile.run('tied-files', '/tmp/repo/z.js', 'edit', 0, '2025-01-01T00:00:30Z');
insertFile.run('tied-files', '/tmp/repo/a.js', 'edit', 0, '2025-01-01T00:00:30Z');
insertFile.run('tied-files', '/tmp/repo/m.js', 'edit', 0, '2025-01-01T00:00:30Z');

// e) terminal-discovered session: host_type='cli', no workspace.yaml.
// Should still merge cleanly. Same shape as sessions seeded above but
// asserted explicitly in its own test for clarity.
insertSession.run('terminal-session', REPO_CWD, 'octo/repo', 'main', 'Terminal',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
insertTurn.run('terminal-session', 0, 'cli prompt', 'cli reply', '2025-01-01T00:00:00Z');
insertFile.run('terminal-session', '/tmp/repo/cli.js', 'create', 0, '2025-01-01T00:00:10Z');

// f) pagination boundary: 75 turns with one file per turn.
insertSession.run('paginated', REPO_CWD, 'octo/repo', 'main', 'Paginated',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
for (let i = 0; i < 75; i++) {
  insertTurn.run('paginated', i, `q${i}`, `a${i}`, '2025-01-01T00:00:00Z');
  insertFile.run('paginated', `/tmp/repo/f${i}.js`, 'edit', i, '2025-01-01T00:00:00Z');
}

// g) NULL turn_index files: land at the end of the final page.
insertSession.run('null-turn', REPO_CWD, 'octo/repo', 'main', 'Null turn idx',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
insertTurn.run('null-turn', 0, 'hi', 'ok', '2025-01-01T00:00:00Z');
insertTurn.run('null-turn', 1, 'more', 'ok', '2025-01-01T00:01:00Z');
insertFile.run('null-turn', '/tmp/repo/attributed.js', 'edit', 0, '2025-01-01T00:00:10Z');
insertFile.run('null-turn', '/tmp/repo/orphan.js', 'edit', null, '2025-01-01T00:00:20Z');

// h) launch-with-path: needs an accessible cwd (the route does fs.access).
const launchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-launch-cwd-'));
fs.writeFileSync(path.join(launchCwd, 'inside.js'), '// ok\n');
insertSession.run('launch-target', launchCwd, 'octo/repo', 'main', 'Launch target',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');

// i) large session: 500 turns with chunky assistant responses + 200 file
// events. Used by the issue #49 regression test to prove that
// GET /api/sessions/:id no longer iterates the full turns table on every
// request. The synthetic responses are 4 KB each so the legacy
// unbounded SELECT would actually feel the difference.
const LARGE_TURN_COUNT = 500;
const LARGE_FILE_COUNT = 200;
const largeBlob = 'x'.repeat(4096);
insertSession.run('large-session', REPO_CWD, 'octo/repo', 'main', 'Large session',
  '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z', 'cli');
const tx = seedDb.transaction(() => {
  for (let i = 0; i < LARGE_TURN_COUNT; i++) {
    insertTurn.run('large-session', i, `q${i}`, `${largeBlob}-${i}`, '2025-01-01T00:00:00Z');
  }
  for (let i = 0; i < LARGE_FILE_COUNT; i++) {
    insertFile.run('large-session', `/tmp/repo/large/f${i}.js`, 'edit', i, '2025-01-01T00:00:00Z');
  }
});
tx();

seedDb.close();

// Build app: mount the sessions router and a launch router with a
// stubbed spawn so the test never actually exec()s VS Code.
const express = require('express');
const sessionsRouter = require('../lib/routes/sessions');
const { createLaunchRouter } = require('../lib/launch');

const spawnCalls = [];
function stubSpawn(bin, args, opts) {
  spawnCalls.push({ bin, args, opts });
  const ee = new EventEmitter();
  ee.unref = () => {};
  return ee;
}

const app = express();
app.use(express.json());
app.use('/api/sessions', sessionsRouter);
app.use('/api/sessions', createLaunchRouter({
  spawn: stubSpawn,
  platform: 'linux',
  readLaunchers: () => ({}),
  fsAccess: async (p) => fs.promises.access(p),
  getSession: (id) => {
    if (id === 'launch-target') return { id, cwd: launchCwd };
    return null;
  },
}));

let server;
let baseUrl;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
});

async function getDetail(id, query = '') {
  const res = await fetch(`${baseUrl}/api/sessions/${id}${query}`);
  assert.equal(res.status, 200, `GET /api/sessions/${id}${query}`);
  return res.json();
}

test('chronology equals turns when no file events exist', async () => {
  const d = await getDetail('turns-only');
  assert.equal(d.has_more, false);
  assert.equal(d.next_cursor, null);
  assert.equal(d.chronology.length, 2);
  assert.deepEqual(d.chronology.map(i => i.kind), ['turn', 'turn']);
  assert.equal(d.chronology[0].assistant_response, 'response zero');
  assert.equal(d.chronology[1].assistant_response, 'response one');
});

test('single file event appears immediately after its producing turn', async () => {
  const d = await getDetail('single-file');
  const kinds = d.chronology.map(i => i.kind);
  assert.deepEqual(kinds, ['turn', 'file', 'turn']);
  assert.equal(d.chronology[1].file_path, '/tmp/repo/src/a.js');
  assert.equal(d.chronology[1].tool_name, 'edit');
  assert.equal(d.chronology[1].turn_index, 0);
});

test('multi-file turn orders file events by first_seen_at ascending', async () => {
  const d = await getDetail('multi-file');
  const files = d.chronology.filter(i => i.kind === 'file').map(i => i.file_path);
  assert.deepEqual(files, [
    '/tmp/repo/src/a.js', // 00:00:10
    '/tmp/repo/src/b.js', // 00:00:20
    '/tmp/repo/src/c.js', // 00:00:30
  ]);
});

test('files with identical first_seen_at sort deterministically by file_path', async () => {
  const d = await getDetail('tied-files');
  const files = d.chronology.filter(i => i.kind === 'file').map(i => i.file_path);
  assert.deepEqual(files, ['/tmp/repo/a.js', '/tmp/repo/m.js', '/tmp/repo/z.js']);
});

test('terminal-discovered (host_type=cli) session merges chronology the same way', async () => {
  const d = await getDetail('terminal-session');
  assert.equal(d.host_type, 'cli');
  const kinds = d.chronology.map(i => i.kind);
  assert.deepEqual(kinds, ['turn', 'file']);
  assert.equal(d.chronology[1].file_path, '/tmp/repo/cli.js');
});

test('pagination boundary: first page returns 50, second returns 25, no dupes', async () => {
  const first = await getDetail('paginated', '?limit=50');
  assert.equal(first.has_more, true);
  assert.equal(first.next_cursor, 49);
  // 50 turns + 50 file events = 100 items.
  assert.equal(first.chronology.length, 100);
  assert.equal(first.chronology[0].kind, 'turn');
  assert.equal(first.chronology[0].turn_index, 0);
  assert.equal(first.chronology[1].kind, 'file');
  assert.equal(first.chronology[1].turn_index, 0);

  const second = await getDetail('paginated', `?limit=50&cursor=${first.next_cursor}`);
  assert.equal(second.has_more, false);
  assert.equal(second.next_cursor, null);
  // Remaining 25 turns + 25 files.
  assert.equal(second.chronology.length, 50);
  const firstTurnIndices = new Set(
    first.chronology.filter(i => i.kind === 'turn').map(i => i.turn_index)
  );
  const secondTurnIndices = second.chronology
    .filter(i => i.kind === 'turn')
    .map(i => i.turn_index);
  // No duplicate turns across pages.
  for (const idx of secondTurnIndices) {
    assert.equal(firstTurnIndices.has(idx), false, `turn ${idx} duplicated`);
  }
  // Pages together cover the full 0..74 range with no gaps.
  const all = [...firstTurnIndices, ...secondTurnIndices].sort((a, b) => a - b);
  assert.equal(all.length, 75);
  assert.equal(all[0], 0);
  assert.equal(all[74], 74);
});

test('NULL turn_index files land at end of final page only', async () => {
  // limit=1 splits into two pages: first page (turn 0 + attributed file)
  // with has_more=true must NOT include the orphan; second page
  // (has_more=false) appends it.
  const first = await getDetail('null-turn', '?limit=1');
  assert.equal(first.has_more, true);
  assert.equal(
    first.chronology.some(i => i.kind === 'file' && i.file_path === '/tmp/repo/orphan.js'),
    false,
    'orphan file must not appear on a non-final page',
  );

  const second = await getDetail('null-turn', `?limit=1&cursor=${first.next_cursor}`);
  assert.equal(second.has_more, false);
  // No more turns on the final page, but the orphan file is appended.
  const fileItems = second.chronology.filter(i => i.kind === 'file');
  assert.equal(fileItems.length, 1);
  assert.equal(fileItems[0].file_path, '/tmp/repo/orphan.js');
  assert.equal(fileItems[0].turn_index, null);

  // Single-page request (default limit) returns everything with the
  // orphan at the very end.
  const single = await getDetail('null-turn');
  assert.equal(single.has_more, false);
  const last = single.chronology[single.chronology.length - 1];
  assert.equal(last.kind, 'file');
  assert.equal(last.file_path, '/tmp/repo/orphan.js');
});

test('legacy turns and files fields are removed from the response (issue #49)', async () => {
  const d = await getDetail('multi-file');
  assert.equal(d.turns, undefined, 'turns array must not be returned');
  assert.equal(d.files, undefined, 'files array must not be returned');
  assert.ok(Array.isArray(d.checkpoints), 'checkpoints stays for the renderer');
  assert.ok(Array.isArray(d.chronology), 'chronology is the sole conversation feed');
  // The chronology still surfaces the same file events inline.
  const fileItems = d.chronology.filter(i => i.kind === 'file');
  assert.equal(fileItems.length, 3);
});

test('large session responds quickly with bounded payload (issue #49)', async () => {
  // HAR evidence on the original bug showed a single /api/sessions/:id
  // call hanging the Node event loop for ~70 seconds because the legacy
  // handler issued an unbounded SELECT over every turn row. With those
  // queries removed, only the cursor-paged chronology runs and the
  // response must come back in well under a second even on a slow CI
  // runner. The threshold below is deliberately generous (still ~35x
  // tighter than the bug) so it catches an order-of-magnitude regression
  // without flaking on Windows.
  const TIME_BUDGET_MS = 2000;
  const start = process.hrtime.bigint();
  const d = await getDetail('large-session', '?limit=50');
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  assert.equal(d.turns, undefined);
  assert.equal(d.files, undefined);
  assert.ok(Array.isArray(d.chronology));
  // Page size cap holds: 50 turns + up to 50 attributed files.
  const turnItems = d.chronology.filter(i => i.kind === 'turn');
  assert.equal(turnItems.length, 50);
  assert.equal(d.has_more, true);
  assert.equal(d.next_cursor, 49);

  assert.ok(
    elapsedMs < TIME_BUDGET_MS,
    `GET /api/sessions/:id took ${elapsedMs.toFixed(0)}ms, expected < ${TIME_BUDGET_MS}ms`,
  );
});

// --- Per-file VS Code launch (Option A) ----------------------------------

test('launch/vscode without a path opens the session cwd', async () => {
  spawnCalls.length = 0;
  const res = await fetch(`${baseUrl}/api/sessions/launch-target/launch/vscode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.path, null);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [launchCwd]);
});

test('launch/vscode with a path inside cwd spawns VS Code with that absolute path', async () => {
  spawnCalls.length = 0;
  const target = path.join(launchCwd, 'inside.js');
  const res = await fetch(`${baseUrl}/api/sessions/launch-target/launch/vscode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: target }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.path, target);
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(spawnCalls[0].args, [launchCwd, target]);
});

test('launch/vscode with a relative path resolves it against cwd', async () => {
  spawnCalls.length = 0;
  const res = await fetch(`${baseUrl}/api/sessions/launch-target/launch/vscode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'inside.js' }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.path, path.resolve(launchCwd, 'inside.js'));
});

test('launch/vscode rejects a path outside the session cwd with 400', async () => {
  spawnCalls.length = 0;
  const res = await fetch(`${baseUrl}/api/sessions/launch-target/launch/vscode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/etc/passwd' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'path-outside-cwd');
  assert.equal(spawnCalls.length, 0, 'must not spawn when validation fails');
});

test('launch/vscode rejects a path that escapes cwd via ..', async () => {
  spawnCalls.length = 0;
  const res = await fetch(`${baseUrl}/api/sessions/launch-target/launch/vscode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '../escape.js' }),
  });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'path-outside-cwd');
  assert.equal(spawnCalls.length, 0);
});
