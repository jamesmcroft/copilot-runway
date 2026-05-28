const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

// Isolate HOME before any module load that resolves paths.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-wt-routes-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const settings = require('../lib/runway/settings');
const bindings = require('../lib/runway/worktree-bindings');
const manager = require('../lib/runway/worktree-manager');
const { createWorktreesRouter } = require('../lib/routes/worktrees');

function git(args, cwd) {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-wt-routes-repo-'));
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

function buildServer(sessions) {
  const app = express();
  app.use(express.json());
  app.use('/api', createWorktreesRouter({
    getSession: (id) => sessions[id] || null,
  }));
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, method, urlPath, body) {
  const addr = server.address();
  const payload = body !== undefined ? JSON.stringify(body) : null;
  const opts = {
    hostname: addr.address,
    port: addr.port,
    path: urlPath,
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (payload != null) {
    // Express body parser is happier with an explicit length than a
    // chunked DELETE body; on Windows we have seen the connection get
    // reset between consecutive DELETEs without it.
    opts.headers['Content-Length'] = Buffer.byteLength(payload);
  }
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
    if (payload != null) req.write(payload);
    req.end();
  });
}

const originalError = console.error;
const originalWarn = console.warn;
test.before(() => { console.error = () => {}; console.warn = () => {}; });
test.after(() => { console.error = originalError; console.warn = originalWarn; });

test('GET /api/sessions/:id/worktree returns { bound: false } when not bound', async () => {
  resetState();
  const server = await buildServer({});
  try {
    const res = await request(server, 'GET', '/api/sessions/unbound1/worktree');
    assert.equal(res.status, 200);
    assert.equal(res.body.bound, false);
  } finally { server.close(); }
});

test('POST /api/sessions/:id/worktree creates and returns 201', async () => {
  resetState();
  const repo = makeRepo();
  const server = await buildServer({ 'route1234-rest': { id: 'route1234-rest', cwd: repo } });
  try {
    const res = await request(server, 'POST', '/api/sessions/route1234-rest/worktree');
    assert.equal(res.status, 201);
    assert.equal(res.body.branchName, 'runway/route123');
    assert.ok(fs.existsSync(res.body.worktreePath));
    // GET round-trip now reports bound: true.
    const get = await request(server, 'GET', '/api/sessions/route1234-rest/worktree');
    assert.equal(get.body.bound, true);
    assert.equal(get.body.dirty, false);
  } finally { server.close(); }
});

test('POST for an unknown session returns 404', async () => {
  resetState();
  const server = await buildServer({});
  try {
    const res = await request(server, 'POST', '/api/sessions/ghost123-x/worktree');
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('POST when already bound to same session returns 200 with alreadyBound=true', async () => {
  resetState();
  const repo = makeRepo();
  const server = await buildServer({ 'samebnd1-rest': { id: 'samebnd1-rest', cwd: repo } });
  try {
    let res = await request(server, 'POST', '/api/sessions/samebnd1-rest/worktree');
    assert.equal(res.status, 201);
    res = await request(server, 'POST', '/api/sessions/samebnd1-rest/worktree');
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyBound, true);
  } finally { server.close(); }
});

test('POST returns 409 when path already bound to another session', async () => {
  resetState();
  const repo = makeRepo();
  // Pre-populate a binding at the path that the second session would
  // resolve to. The path depends on slug + id-short; create the first
  // session via the route and then point a synthetic second session at
  // the same short id by colliding the first 8 chars.
  const server = await buildServer({
    'collide1-first': { id: 'collide1-first', cwd: repo },
    'collide1-second': { id: 'collide1-second', cwd: repo },
  });
  try {
    let res = await request(server, 'POST', '/api/sessions/collide1-first/worktree');
    assert.equal(res.status, 201);
    res = await request(server, 'POST', '/api/sessions/collide1-second/worktree');
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'already-bound');
    assert.equal(res.body.boundSessionId, 'collide1-first');
  } finally { server.close(); }
});

test('DELETE removes the worktree and clears the binding', async () => {
  resetState();
  const repo = makeRepo();
  const server = await buildServer({ 'delr1234-rest': { id: 'delr1234-rest', cwd: repo } });
  try {
    const created = await request(server, 'POST', '/api/sessions/delr1234-rest/worktree');
    const wt = created.body.worktreePath;
    const del = await request(server, 'DELETE', '/api/sessions/delr1234-rest/worktree', {});
    assert.equal(del.status, 200);
    assert.equal(del.body.removed, true);
    assert.equal(fs.existsSync(wt), false);
  } finally { server.close(); }
});

test('DELETE refuses dirty worktree without force (409)', async () => {
  resetState();
  const repo = makeRepo();
  const server = await buildServer({ 'drty1234-rest': { id: 'drty1234-rest', cwd: repo } });
  try {
    const created = await request(server, 'POST', '/api/sessions/drty1234-rest/worktree');
    fs.writeFileSync(path.join(created.body.worktreePath, 'change.txt'), 'x');
    let res = await request(server, 'DELETE', '/api/sessions/drty1234-rest/worktree', {});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'dirty');
    res = await request(server, 'DELETE', '/api/sessions/drty1234-rest/worktree', { force: true });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

test('DELETE for unbound session returns 404', async () => {
  resetState();
  const server = await buildServer({});
  try {
    const res = await request(server, 'DELETE', '/api/sessions/missing1/worktree', {});
    assert.equal(res.status, 404);
  } finally { server.close(); }
});

test('GET /api/projects/:projectKey/worktrees lists bound worktrees', async () => {
  resetState();
  const repo = makeRepo();
  const server = await buildServer({ 'list1234-rest': { id: 'list1234-rest', cwd: repo } });
  try {
    await request(server, 'POST', '/api/sessions/list1234-rest/worktree');
    const key = encodeURIComponent(repo);
    const res = await request(server, 'GET', `/api/projects/${key}/worktrees`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const bound = res.body.find(x => x.sessionId === 'list1234-rest');
    assert.ok(bound, `expected to find bound session in ${JSON.stringify(res.body)}`);
  } finally { server.close(); }
});
