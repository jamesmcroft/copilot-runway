const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');

// Isolate HOME before requiring any module that touches paths.js.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-settings-routes-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { SETTINGS_FILE, PROJECT_SETTINGS_FILE } = require('../lib/paths');
const settings = require('../lib/runway/settings');
const settingsRouter = require('../lib/routes/settings');

function reset() {
  for (const f of [SETTINGS_FILE, PROJECT_SETTINGS_FILE]) {
    try { fs.unlinkSync(f); } catch {}
  }
  settings.invalidateCache();
}

function buildServer() {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRouter);
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(server, method, urlPath, body) {
  const addr = server.address();
  const opts = {
    hostname: addr.address,
    port: addr.port,
    path: urlPath,
    method,
    headers: { 'Content-Type': 'application/json' },
  };
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
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const originalWarn = console.warn;
const originalError = console.error;
test.before(() => { console.warn = () => {}; console.error = () => {}; });
test.after(() => { console.warn = originalWarn; console.error = originalError; });

test('GET /api/settings returns defaults on first run', async () => {
  reset();
  const server = await buildServer();
  try {
    const res = await request(server, 'GET', '/api/settings');
    assert.equal(res.status, 200);
    assert.equal(res.body.values.launchers.vscode, 'code');
    assert.equal(res.body.values.defaults.agent, '');
  } finally {
    server.close();
  }
});

test('GET /api/settings/schema returns descriptors', async () => {
  reset();
  const server = await buildServer();
  try {
    const res = await request(server, 'GET', '/api/settings/schema');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.descriptors));
    const launchers = res.body.descriptors.find(d => d.key === 'launchers.vscode');
    assert.deepEqual(launchers.enum, ['code', 'code-insiders', 'cursor', 'codium']);
  } finally {
    server.close();
  }
});

test('PATCH /api/settings merges partial keys', async () => {
  reset();
  const server = await buildServer();
  try {
    let res = await request(server, 'PATCH', '/api/settings', { launchers: { vscode: 'cursor' } });
    assert.equal(res.status, 200);
    res = await request(server, 'PATCH', '/api/settings', { defaults: { agent: 'demo-agent' } });
    assert.equal(res.status, 200);
    res = await request(server, 'GET', '/api/settings');
    // PATCH 2 must not have wiped PATCH 1
    assert.equal(res.body.values.launchers.vscode, 'cursor');
    assert.equal(res.body.values.defaults.agent, 'demo-agent');
  } finally {
    server.close();
  }
});

test('PATCH rejects invalid values with 400 and structured errors', async () => {
  reset();
  const server = await buildServer();
  try {
    const res = await request(server, 'PATCH', '/api/settings', { launchers: { vscode: 'sublime' } });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'validation');
    assert.ok(res.body.errors.some(e => e.key === 'launchers.vscode'));
  } finally {
    server.close();
  }
});

test('PUT replaces wholesale', async () => {
  reset();
  const server = await buildServer();
  try {
    await request(server, 'PATCH', '/api/settings', { defaults: { agent: 'alpha' } });
    const res = await request(server, 'PUT', '/api/settings', {
      schema_version: 1,
      values: { launchers: { vscode: 'code-insiders' } },
    });
    assert.equal(res.status, 200);
    // The values map is backfilled with defaults but anything explicitly
    // sent at PUT time wins.
    assert.equal(res.body.values.launchers.vscode, 'code-insiders');
    assert.equal(res.body.values.defaults.agent, '');
  } finally {
    server.close();
  }
});

test('PATCH wrapped body ({ values: ... }) is accepted', async () => {
  // Round-trips a GET response without unwrapping.
  reset();
  const server = await buildServer();
  try {
    const res = await request(server, 'PATCH', '/api/settings', {
      values: { launchers: { vscode: 'codium' } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.values.launchers.vscode, 'codium');
  } finally {
    server.close();
  }
});

test('per-project PATCH stores override; GET reads it back', async () => {
  reset();
  const server = await buildServer();
  try {
    const key = encodeURIComponent('/abs/path/sample-project');
    let res = await request(server, 'PATCH', `/api/settings/projects/${key}`, {
      defaults: { agent: 'beta' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.overrides.defaults.agent, 'beta');
    res = await request(server, 'GET', `/api/settings/projects/${key}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.overrides.defaults.agent, 'beta');
  } finally {
    server.close();
  }
});

test('per-project rejects global-only keys with 400', async () => {
  reset();
  const server = await buildServer();
  try {
    const key = encodeURIComponent('/abs/p');
    const res = await request(server, 'PATCH', `/api/settings/projects/${key}`, {
      worktrees: { root: '/tmp/elsewhere' },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.errors.some(e => e.key === 'worktrees.root'));
  } finally {
    server.close();
  }
});

test('GET on unknown project returns empty overrides, not 404', async () => {
  reset();
  const server = await buildServer();
  try {
    const key = encodeURIComponent('/nope');
    const res = await request(server, 'GET', `/api/settings/projects/${key}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.overrides, {});
  } finally {
    server.close();
  }
});

test('newer schema_version produces 409 on PATCH (read-only mode)', async () => {
  reset();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    schema_version: 999,
    values: { launchers: { vscode: 'code' } },
  }));
  settings.invalidateCache();
  const server = await buildServer();
  try {
    const res = await request(server, 'PATCH', '/api/settings', { launchers: { vscode: 'cursor' } });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'read-only');
  } finally {
    server.close();
  }
});
