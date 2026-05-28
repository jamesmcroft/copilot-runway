// Conversation content search endpoint (issue #9).
//
// Mirrors the HOME-override + sqlite seed pattern from
// session-detail.test.js so the route can be exercised without touching
// the real ~/.copilot directory. Adds the FTS5 search_index virtual
// table that the production Copilot CLI populates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-search-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const copilotDir = path.join(tmpHome, '.copilot');
fs.mkdirSync(path.join(copilotDir, 'session-state'), { recursive: true });
const dbPath = path.join(copilotDir, 'session-store.db');

const Database = require('better-sqlite3');
const seedDb = new Database(dbPath);

// Schema mirrors the production session-store layout for the columns
// the search route actually reads.
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
  CREATE VIRTUAL TABLE search_index USING fts5(
    content,
    session_id    UNINDEXED,
    source_type   UNINDEXED,
    source_id     UNINDEXED
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
const insertSearchRow = seedDb.prepare(`
  INSERT INTO search_index (content, session_id, source_type, source_id)
  VALUES (?, ?, ?, ?)
`);

// Synthetic sessions. Names, repos, branches, and turn content are all
// lorem-ipsum style so no real identifiers leak into the test fixture.
function seedSession(id, summary) {
  insertSession.run(
    id,
    '/tmp/repo/' + id,
    'octo/' + id,
    'main',
    summary,
    '2025-01-01T00:00:00Z',
    '2025-01-01T00:00:00Z',
    'cli',
  );
}

seedSession('alpha-session', 'Alpha summary');
seedSession('bravo-session', 'Bravo summary');
seedSession('charlie-session', 'Charlie summary');
seedSession('delta-session', 'Delta summary');
seedSession('echo-session', 'Echo summary');
seedSession('foxtrot-session', 'Foxtrot summary');

// Each turn gets a paired search_index row scoped to source_type='turn'.
const turnSeed = [
  ['alpha-session', 0, 'how about lorem ipsum dolor sit amet'],
  ['alpha-session', 1, 'the quick brown fox jumps over the lazy dog'],
  ['alpha-session', 2, 'another alpha bravo charlie phrase here'],
  ['bravo-session', 0, 'the quick brown fox runs through bravo town'],
  ['bravo-session', 1, 'unrelated wibble wobble content'],
  ['charlie-session', 0, 'pangram sample: jackdaws love my big sphinx of quartz'],
  ['delta-session', 0, 'delta turn with embedded <script>alert(1)</script> content'],
  ['echo-session', 0, 'echo turn mentioning alpha but only this once'],
  ['foxtrot-session', 0, 'foxtrot has nothing matching the canary keyword set'],
];
for (const [sid, idx, body] of turnSeed) {
  insertTurn.run(sid, idx, 'user message ' + idx, body, '2025-01-01T00:00:00Z');
  insertSearchRow.run(body, sid, 'turn', `${sid}:${idx}`);
}

// Checkpoint content for the same session. The route must NOT surface
// these because the MVP is scoped to source_type='turn'.
insertSearchRow.run(
  'checkpoint overview mentions the quick brown fox prominently',
  'charlie-session',
  'checkpoint_overview',
  'charlie-session:cp1',
);

// Two turns in the same session that both match a query, to exercise
// per-session dedupe (best-ranked snippet wins).
insertTurn.run('echo-session', 1, 'second echo turn', 'dedupe-keyword landing once here', '2025-01-01T00:00:00Z');
insertSearchRow.run('dedupe-keyword landing once here', 'echo-session', 'turn', 'echo-session:1');
insertTurn.run('echo-session', 2, 'third echo turn', 'dedupe-keyword again in another turn', '2025-01-01T00:00:00Z');
insertSearchRow.run('dedupe-keyword again in another turn', 'echo-session', 'turn', 'echo-session:2');

seedDb.close();

// Build the app the same way server.js does: search router mounted
// before the main sessions router so /search is not captured by /:id.
const express = require('express');
const searchRouter = require('../lib/routes/search');
const sessionsRouter = require('../lib/routes/sessions');

const app = express();
app.use(express.json());
app.use('/api/sessions', searchRouter);
app.use('/api/sessions', sessionsRouter);

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

async function search(q, extra = '') {
  const res = await fetch(`${baseUrl}/api/sessions/search?q=${encodeURIComponent(q)}${extra}`);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test('status endpoint reports availability when search_index exists', async () => {
  const res = await fetch(`${baseUrl}/api/sessions/search/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true);
});

test('simple single-term match returns the expected session', async () => {
  const { status, body } = await search('jackdaws');
  assert.equal(status, 200);
  assert.ok(Array.isArray(body.results));
  assert.equal(body.results.length, 1);
  assert.equal(body.results[0].id, 'charlie-session');
  assert.equal(body.results[0].matched_field, 'content');
  assert.match(body.results[0].snippet, /<mark>jackdaws<\/mark>/i);
});

test('multi-term phrase match returns sessions that contain the exact phrase', async () => {
  const { status, body } = await search('the quick brown fox');
  assert.equal(status, 200);
  const ids = body.results.map(r => r.id).sort();
  // Charlie has 'the quick brown fox' only in a checkpoint, which the
  // turn-only filter must exclude. So expect alpha + bravo.
  assert.deepEqual(ids, ['alpha-session', 'bravo-session']);
});

test('no match returns an empty result set', async () => {
  const { status, body } = await search('zzz_nothing_matches_zzz');
  assert.equal(status, 200);
  assert.deepEqual(body.results, []);
});

test('per-session dedupe keeps a single hit per session', async () => {
  const { status, body } = await search('dedupe-keyword');
  assert.equal(status, 200);
  // Echo session has two matching turns; the response must collapse to one.
  const echoHits = body.results.filter(r => r.id === 'echo-session');
  assert.equal(echoHits.length, 1);
  assert.match(echoHits[0].snippet, /<mark>dedupe-keyword<\/mark>/i);
});

test('checkpoint-only sources are excluded from results', async () => {
  // The phrase 'the quick brown fox' appears in a charlie checkpoint
  // surface but charlie has no turn containing it. Charlie must not
  // appear in the results.
  const { body } = await search('the quick brown fox');
  assert.equal(body.results.some(r => r.id === 'charlie-session'), false);
});

test('snippet HTML escapes user content while preserving the <mark> wrappers', async () => {
  const { status, body } = await search('script');
  assert.equal(status, 200);
  const delta = body.results.find(r => r.id === 'delta-session');
  assert.ok(delta, 'expected delta session in results');
  // The literal <script> tag from user content must be escaped: the
  // angle brackets must come through as &lt; / &gt; so the browser does
  // not parse them as markup.
  assert.ok(!delta.snippet.includes('<script>'), 'raw <script> must not survive');
  assert.ok(delta.snippet.includes('&lt;'), 'angle brackets must be escaped');
  assert.ok(delta.snippet.includes('&gt;'), 'angle brackets must be escaped');
  // The <mark> wrappers around the matched token must survive intact.
  assert.match(delta.snippet, /<mark>script<\/mark>/i);
});

test('empty query returns 400', async () => {
  const res = await fetch(`${baseUrl}/api/sessions/search?q=`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'q_required');
});

test('whitespace-only query returns 400', async () => {
  const res = await fetch(`${baseUrl}/api/sessions/search?q=%20%20%20`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'q_required');
});

test('oversized query (>200 chars) returns 400', async () => {
  const huge = 'a'.repeat(201);
  const res = await fetch(`${baseUrl}/api/sessions/search?q=${huge}`);
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'q_too_long');
});

test('limit is clamped to the 100 maximum', async () => {
  const { status, body } = await search('alpha', '&limit=500');
  assert.equal(status, 200);
  assert.equal(body.limit, 100);
});

test('limit defaults to 50 when missing or invalid', async () => {
  const { body: a } = await search('alpha');
  assert.equal(a.limit, 50);
  const { body: b } = await search('alpha', '&limit=notanumber');
  assert.equal(b.limit, 50);
});

test('FTS5 operators in user input are neutralized via phrase quoting', async () => {
  // None of these are valid bare FTS5 syntax. The phrase wrapper turns
  // them into literal token sequences, so the request must succeed with
  // no results rather than throw.
  const samples = ['NEAR(foo bar)', 'content:foo', 'foo*', '^foo'];
  for (const s of samples) {
    const { status } = await search(s);
    assert.equal(status, 200, `query ${JSON.stringify(s)} should not 500`);
  }
});

test('projection includes the fields the client uses to render cards', async () => {
  const { body } = await search('jackdaws');
  const row = body.results[0];
  // Core identity + card metadata.
  assert.equal(typeof row.id, 'string');
  assert.equal(typeof row.name, 'string');
  assert.equal(typeof row.updated_at, 'string');
  assert.ok('repository' in row);
  assert.ok('branch' in row);
  assert.ok('status' in row);
  assert.ok('has_refs' in row);
  assert.ok('project_key' in row);
  assert.ok(Array.isArray(row.refs));
  // Search-specific fields.
  assert.equal(row.matched_field, 'content');
  assert.equal(typeof row.snippet, 'string');
});
