const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const express = require('express');

// Isolate HOME so paths.js does not touch the real ~/.runway.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'runway-launch-test-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

const { createLaunchRouter } = require('../lib/launch');

// Fake child returned by stub spawn. Behaviour controlled by `mode`:
//   'ok'      - never emits 'error'; settles via setImmediate (success path).
//   'enoent'  - emits 'error' with code ENOENT on next tick.
//   'fail'    - emits 'error' with a generic error on next tick.
function makeChild(mode) {
  const ee = new EventEmitter();
  ee.unref = () => { ee._unrefCalled = true; };
  if (mode === 'enoent') {
    setImmediate(() => ee.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' })));
  } else if (mode === 'fail') {
    setImmediate(() => ee.emit('error', Object.assign(new Error('boom'), { code: 'EACCES' })));
  }
  return ee;
}

// Build a stub spawn that returns a queue of children. Records every call.
function makeSpawn(modes) {
  const calls = [];
  let i = 0;
  function spawn(bin, args, opts) {
    calls.push({ bin, args, opts });
    const mode = modes[Math.min(i, modes.length - 1)];
    i++;
    return makeChild(mode);
  }
  return { spawn, calls };
}

function makeApp(opts) {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', createLaunchRouter(opts));
  return app;
}

async function start(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function stop(server) {
  return new Promise(resolve => server.close(resolve));
}

// Default getSession factory: returns a session with the given cwd.
function sessionStub(id = 'sess-1', cwd = '/tmp/repo') {
  return (sid) => (sid === id ? { id, cwd } : null);
}

// Silence the expected console.warn from the malformed-config test.
const originalWarn = console.warn;
test.before(() => { console.warn = () => {}; });
test.after(() => { console.warn = originalWarn; });

test('vscode happy path (linux): spawn called with code [cwd] shell:false, unref invoked, ok:true', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', '/work/repo'),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/vscode`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual(body, { ok: true, bin: 'code' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'code');
    assert.deepEqual(calls[0].args, ['/work/repo']);
    assert.deepEqual(calls[0].opts, { detached: true, stdio: 'ignore', shell: false });
  } finally { await stop(server); }
});

test('vscode happy path (win32): shell flag is true', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'win32',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', 'C:/work/repo'),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/vscode`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(calls[0].opts.shell, true);
  } finally { await stop(server); }
});

test('vscode ENOENT returns structured vscode-not-on-path hint', async () => {
  const { spawn } = makeSpawn(['enoent']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub(),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/launch/vscode`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'vscode-not-on-path');
    assert.ok(body.hint && body.hint.includes('Install code command in PATH'));
  } finally { await stop(server); }
});

test('vscode binary override via launchers.json (allowlisted)', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({ vscode: 'cursor' }),
    fsAccess: async () => {},
    getSession: sessionStub(),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/launch/vscode`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.bin, 'cursor');
    assert.equal(calls[0].bin, 'cursor');
  } finally { await stop(server); }
});

test('vscode override outside allowlist falls back to code', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({ vscode: '/etc/passwd; rm -rf /' }),
    fsAccess: async () => {},
    getSession: sessionStub(),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/launch/vscode`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(calls[0].bin, 'code');
  } finally { await stop(server); }
});

test('vscode launchers.json malformed: reader throws, route still works with default', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => { throw new Error('parse error'); },
    fsAccess: async () => {},
    getSession: sessionStub(),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/launch/vscode`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(calls[0].bin, 'code');
  } finally { await stop(server); }
});

test('vscode launchers.json returns null: falls back to code, no throw', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => null,
    fsAccess: async () => {},
    getSession: sessionStub(),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/launch/vscode`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(calls[0].bin, 'code');
  } finally { await stop(server); }
});

test('terminal Windows: spawns wt -d <cwd> copilot --resume <id>', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'win32',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('abc123', 'C:/work/repo'),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/abc123/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'wt');
    // With shell:true Node joins argv with spaces; cwd and id must be
    // pre-quoted to survive paths-with-spaces or shell metachars.
    assert.deepEqual(calls[0].args, ['-d', '"C:/work/repo"', 'copilot', '--resume', '"abc123"']);
    assert.equal(calls[0].opts.shell, true);
    assert.equal(calls[0].opts.detached, true);
  } finally { await stop(server); }
});

test('terminal Windows: wt-missing falls back to cmd /k with cd /d and copilot --resume=<id>', async () => {
  const { spawn, calls } = makeSpawn(['enoent', 'ok']);
  const app = makeApp({
    spawn,
    platform: 'win32',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('abc123', 'C:/work/repo'),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/abc123/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].bin, 'cmd');
    assert.equal(calls[1].args[0], '/k');
    assert.ok(calls[1].args[1].includes('cd /d "C:/work/repo"'));
    assert.ok(calls[1].args[1].includes('copilot --resume="abc123"'));
  } finally { await stop(server); }
});

test('terminal macOS: osascript script contains cd <cwd> and copilot --resume=<id>', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'darwin',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('xyz', '/Users/me/repo'),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/xyz/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(calls[0].bin, 'osascript');
    assert.equal(calls[0].args[0], '-e');
    // shell:true is unnecessary here (osascript at /usr/bin); using it
    // would expose shell metachars in cwd. Assert the route does NOT
    // enable a shell on the macOS path.
    assert.notEqual(calls[0].opts.shell, true);
    const script = calls[0].args[1];
    assert.ok(script.includes('cd \\"/Users/me/repo\\"'), `script was: ${script}`);
    assert.ok(script.includes('copilot --resume=xyz'));
  } finally { await stop(server); }
});

test('terminal Linux honours RUNWAY_TERMINAL override', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('lid', '/home/me/repo'),
    env: { RUNWAY_TERMINAL: 'xterm' },
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/lid/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, 'xterm');
    assert.equal(calls[0].args[0], '-e');
    assert.ok(calls[0].args[1].includes('copilot --resume=lid'));
  } finally { await stop(server); }
});

test('terminal Linux tries fallback chain in order and picks the first available', async () => {
  // x-terminal-emulator missing, gnome-terminal missing, konsole ok.
  const { spawn, calls } = makeSpawn(['enoent', 'enoent', 'ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('lid', '/home/me/repo'),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/lid/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.bin, 'konsole');
    assert.deepEqual(calls.map(c => c.bin), ['x-terminal-emulator', 'gnome-terminal', 'konsole']);
  } finally { await stop(server); }
});

test('terminal Linux: no terminal found returns structured error', async () => {
  const { spawn } = makeSpawn(['enoent', 'enoent', 'enoent']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('lid', '/home/me/repo'),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/lid/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'no-terminal-found');
    assert.ok(body.hint && body.hint.includes('RUNWAY_TERMINAL'));
  } finally { await stop(server); }
});

test('404 when session id is unknown (vscode) returns ok:false envelope', async () => {
  const { spawn } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: () => null,
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/nope/launch/vscode`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'session-not-found');
    assert.ok(body.hint);
  } finally { await stop(server); }
});

test('404 when session id is unknown (terminal) returns ok:false envelope', async () => {
  const { spawn } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: () => null,
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/nope/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 404);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'session-not-found');
  } finally { await stop(server); }
});

test('400 when session has no cwd returns ok:false envelope', async () => {
  const { spawn } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: () => ({ id: 'sess-1', cwd: null }),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/launch/vscode`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'session-missing-cwd');
  } finally { await stop(server); }
});

test('400 when cwd does not exist on disk returns ok:false envelope', async () => {
  const { spawn } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); },
    getSession: sessionStub('sess-1', '/does/not/exist'),
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sess-1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'cwd-not-accessible');
    assert.ok(body.hint && body.hint.includes('/does/not/exist'));
  } finally { await stop(server); }
});
