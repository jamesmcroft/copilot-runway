const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Override HOME before any module that resolves paths is loaded.
// paths.js reads HOME/USERPROFILE at require time and pins the
// session-store DB and ~/.runway locations under it.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-sessions-list-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const copilotDir = path.join(tmpHome, '.copilot');
const sessionStateDir = path.join(copilotDir, 'session-state');
fs.mkdirSync(sessionStateDir, { recursive: true });

const dbPath = path.join(copilotDir, 'session-store.db');

// Seed the session-store DB with the minimal schema the list route reads.
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

const longText = 'A'.repeat(200);
const messyText = 'first line\nsecond  line\twith\ttabs   and   spaces';

const insertSession = seedDb.prepare(`
  INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertTurn = seedDb.prepare(`
  INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
  VALUES (?, ?, ?, ?, ?)
`);
const insertRef = seedDb.prepare(`
  INSERT INTO session_refs (session_id, ref_type, ref_value, created_at) VALUES (?, ?, ?, ?)
`);

// populated: has turns, has pr+issue+commit refs, and a session-agent record.
insertSession.run('populated', '/tmp/repo', 'octo/repo', 'main', 'Populated session',
  '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z', 'cli');
insertTurn.run('populated', 0, 'hi', 'short answer', '2025-01-01T00:00:00Z');
insertTurn.run('populated', 1, 'more', messyText, '2025-01-01T00:01:00Z');
insertRef.run('populated', 'pr', '42', '2025-01-01T00:02:00Z');
insertRef.run('populated', 'issue', '7', '2025-01-01T00:03:00Z');
insertRef.run('populated', 'commit', 'deadbeef', '2025-01-01T00:04:00Z');

// long: most recent assistant response exceeds the 120 char preview budget.
insertSession.run('long', '/tmp/repo', 'octo/repo', 'main', 'Long session',
  '2025-01-01T00:00:00Z', '2025-01-01T05:00:00Z', 'cli');
insertTurn.run('long', 0, 'hi', longText, '2025-01-01T00:00:00Z');

// empty: no turns, no refs, no recorded agent.
insertSession.run('empty', '/tmp/repo', 'octo/repo', 'main', 'Empty session',
  '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z', 'cli');

// many-refs: 6 PR refs to verify the server sends all of them so the
// client can render an accurate "+N more" overflow count.
insertSession.run('many-refs', '/tmp/repo', 'octo/repo', 'main', 'Many refs session',
  '2025-01-01T00:00:00Z', '2025-01-01T02:00:00Z', 'cli');
for (let i = 1; i <= 6; i++) {
  insertRef.run('many-refs', 'pr', String(100 + i), `2025-01-01T00:0${i}:00Z`);
}

seedDb.close();

// Seed the session-agent JSON only for the populated session so we cover
// both "agent present" and "agent null" rendering paths.
const { SESSION_AGENTS_FILE } = require('../lib/paths');
fs.writeFileSync(SESSION_AGENTS_FILE, JSON.stringify({ populated: 'planner' }));

// Build a tiny express app mounting just the sessions router.
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
  await new Promise(resolve => server.close(resolve));
});

async function fetchList() {
  const res = await fetch(`${baseUrl}/api/sessions`);
  assert.equal(res.status, 200);
  return res.json();
}

test('list payload exposes agent, last_assistant_preview, refs for a populated session', async () => {
  const list = await fetchList();
  const populated = list.find(s => s.id === 'populated');
  assert.ok(populated, 'populated session present');
  assert.equal(populated.agent, 'planner');
  assert.equal(populated.turn_count, 2);
  // collapsed whitespace: tabs and runs of spaces become single spaces,
  // newlines are joined into the single-line preview.
  assert.equal(
    populated.last_assistant_preview,
    'first line second line with tabs and spaces'
  );
});

test('refs filter excludes commit refs and preserve {ref_type, ref_value} shape', async () => {
  const list = await fetchList();
  const populated = list.find(s => s.id === 'populated');
  const types = populated.refs.map(r => r.ref_type);
  assert.ok(!types.includes('commit'), 'commit refs are excluded');
  assert.deepEqual(types.sort(), ['issue', 'pr']);
  for (const r of populated.refs) {
    assert.ok(typeof r.ref_value === 'string' && r.ref_value.length > 0);
  }
});

test('last_assistant_preview truncates at 120 chars and appends a single ellipsis', async () => {
  const list = await fetchList();
  const long = list.find(s => s.id === 'long');
  assert.ok(long.last_assistant_preview.endsWith('\u2026'));
  // 120 characters + one ellipsis char = 121 code units.
  assert.equal(long.last_assistant_preview.length, 121);
  assert.equal(long.last_assistant_preview.slice(0, 120), 'A'.repeat(120));
});

test('empty session degrades gracefully: null agent, null preview, empty refs', async () => {
  const list = await fetchList();
  const empty = list.find(s => s.id === 'empty');
  assert.ok(empty, 'empty session present');
  assert.equal(empty.agent, null);
  assert.equal(empty.last_assistant_preview, null);
  assert.deepEqual(empty.refs, []);
  assert.equal(empty.turn_count, 0);
  assert.equal(empty.has_refs, false);
});

test('refs are not capped server-side so the client +N more count is truthful', async () => {
  const list = await fetchList();
  const many = list.find(s => s.id === 'many-refs');
  assert.ok(many, 'many-refs session present');
  assert.equal(many.refs.length, 6);
  // Sanity: all entries are PRs and carry the expected ref_value shape.
  assert.ok(many.refs.every(r => r.ref_type === 'pr'));
  const values = many.refs.map(r => r.ref_value).sort();
  assert.deepEqual(values, ['101', '102', '103', '104', '105', '106']);
});
