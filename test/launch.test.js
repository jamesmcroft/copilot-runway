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

const { createLaunchRouter, defaultReadLaunchers, LAUNCHERS_FILE } = require('../lib/launch');

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

// ---------------------------------------------------------------------------
// defaultReadLaunchers: direct file reader (no HTTP).
// Uses the LAUNCHERS_FILE under the test-scoped tmpHome.
// ---------------------------------------------------------------------------

function clearLaunchersFile() {
  try { fs.unlinkSync(LAUNCHERS_FILE); } catch {}
}

test('defaultReadLaunchers returns {} when file is missing', () => {
  clearLaunchersFile();
  assert.deepEqual(defaultReadLaunchers(), {});
});

test('defaultReadLaunchers returns {} and warns when JSON is malformed', () => {
  clearLaunchersFile();
  fs.writeFileSync(LAUNCHERS_FILE, '{ not json');
  let warned = false;
  const orig = console.warn;
  console.warn = () => { warned = true; };
  try {
    assert.deepEqual(defaultReadLaunchers(), {});
    assert.equal(warned, true);
  } finally { console.warn = orig; }
});

test('defaultReadLaunchers returns {} and warns when top-level JSON is an array', () => {
  clearLaunchersFile();
  fs.writeFileSync(LAUNCHERS_FILE, JSON.stringify(['code', 'cursor']));
  let warned = false;
  const orig = console.warn;
  console.warn = () => { warned = true; };
  try {
    assert.deepEqual(defaultReadLaunchers(), {});
    assert.equal(warned, true);
  } finally { console.warn = orig; }
});

// ---------------------------------------------------------------------------
// Regression tests for shell-special cwds. These would have caught the
// Windows shell:true quoting bug and the macOS osascript shell-evaluation
// of metachars in cwd.
// ---------------------------------------------------------------------------

test('Windows wt: cwd with spaces is double-quoted so cmd.exe does not split it', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'win32',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('sid1', 'C:/Program Files/My Repo'),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/sid1/launch/terminal`, { method: 'POST' });
    assert.equal((await res.json()).ok, true);
    // wt is invoked via shell:true, so Node will join argv with spaces.
    // The joined string must contain the quoted cwd as a single token.
    const joined = calls[0].args.join(' ');
    assert.ok(joined.includes('"C:/Program Files/My Repo"'), `joined: ${joined}`);
  } finally { await stop(server); }
});

test('Windows cmd fallback: cwd with spaces and session id both end up quoted in the cmd string', async () => {
  const { spawn, calls } = makeSpawn(['enoent', 'ok']);
  const app = makeApp({
    spawn,
    platform: 'win32',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('has space id', 'C:/Program Files/My Repo'),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/has space id/launch/terminal`, { method: 'POST' });
    assert.equal((await res.json()).ok, true);
    const cmdString = calls[1].args[1];
    assert.ok(cmdString.includes('cd /d "C:/Program Files/My Repo"'), `cmd: ${cmdString}`);
    assert.ok(cmdString.includes('copilot --resume="has space id"'), `cmd: ${cmdString}`);
  } finally { await stop(server); }
});

test('macOS osascript: cwd with quotes and $ is escaped, shell flag is NOT set', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const cwd = '/tmp/has "quote" and $dollar';
  const app = makeApp({
    spawn,
    platform: 'darwin',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('mid1', cwd),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/mid1/launch/terminal`, { method: 'POST' });
    assert.equal((await res.json()).ok, true);
    // The whole point: NO shell:true on macOS, so $dollar is never expanded.
    assert.notEqual(calls[0].opts.shell, true);
    const script = calls[0].args[1];
    // Embedded " becomes \" inside the AppleScript double-quoted string,
    // then the outer JS template adds another level of escaping for the
    // `cd \"<cwd>\"` wrapping. We assert the literal substring as it is
    // passed to osascript (argv element, not shell-interpreted).
    assert.ok(script.includes('has \\"quote\\" and $dollar'), `script: ${script}`);
  } finally { await stop(server); }
});

test('Linux x-terminal-emulator: cwd with single and double quotes survives POSIX escaping', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const cwd = "/tmp/has 'single' and \"double\"";
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('lid1', cwd),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/lid1/launch/terminal`, { method: 'POST' });
    assert.equal((await res.json()).ok, true);
    assert.equal(calls[0].bin, 'x-terminal-emulator');
    const shellArg = calls[0].args[1];
    // The outer wrapper is `bash -c '<cmd>'`, so single quotes inside the
    // inner command are escaped using the POSIX `'\''` close-reopen idiom.
    // Inside the double-quoted cd, the path's own " must be backslashed.
    assert.ok(shellArg.startsWith("bash -c '"), `shellArg: ${shellArg}`);
    assert.ok(shellArg.includes("cd \"/tmp/has '\\''single'\\'' and \\\"double\\\"\""),
              `shellArg: ${shellArg}`);
    assert.ok(shellArg.includes('copilot --resume=lid1'));
  } finally { await stop(server); }
});

// ---------------------------------------------------------------------------
// Focus-existing-terminal behaviour. Default getSessionPid returns null, so
// the existing tests above remain unchanged. These tests stub getSessionPid
// and isPidAlive to exercise the focus branch.
// ---------------------------------------------------------------------------

const { focusExisting } = require('../lib/launch');

test('terminal: pid alive + focus succeeds skips spawn and reports focused:true', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  let focusCalledWith = null;
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', '/work/repo'),
    getSessionPid: () => 4242,
    isPidAlive: () => true,
    focusWindow: async (pid, plat) => { focusCalledWith = { pid, plat }; return { focused: true }; },
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.focused, true);
    assert.equal(body.pid, 4242);
    assert.equal(calls.length, 0, 'no spawn when focus succeeds');
    assert.deepEqual(focusCalledWith, { pid: 4242, plat: 'linux' });
  } finally { await stop(server); }
});

test('terminal: linux focus-fails with reason no-wm-tool surfaces install-tools hint', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', '/work/repo'),
    getSessionPid: () => 4242,
    isPidAlive: () => true,
    focusWindow: async () => ({ focused: false, reason: 'no-wm-tool' }),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.focused, false);
    assert.equal(body.reason, 'no-wm-tool');
    assert.ok(body.hint && body.hint.includes('wmctrl'), `hint: ${body.hint}`);
    assert.ok(body.hint.includes('xdotool'), `hint: ${body.hint}`);
    assert.equal(calls.length, 1, 'spawn happens when focus fails');
  } finally { await stop(server); }
});

test('terminal: macOS focus-fails surfaces Accessibility-permission hint', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'darwin',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', '/Users/me/repo'),
    getSessionPid: () => 4242,
    isPidAlive: () => true,
    focusWindow: async () => ({ focused: false, reason: 'osascript-failed' }),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.focused, false);
    assert.ok(body.hint && body.hint.includes('Accessibility'), `hint: ${body.hint}`);
    assert.equal(calls.length, 1);
  } finally { await stop(server); }
});

test('terminal: linux focus-fails with a non-no-wm-tool reason gets the generic hint', async () => {
  const { spawn } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', '/work/repo'),
    getSessionPid: () => 4242,
    isPidAlive: () => true,
    focusWindow: async () => ({ focused: false, reason: 'focus-failed' }),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.focused, false);
    assert.ok(body.hint && body.hint.includes('not supported on this platform'), `hint: ${body.hint}`);
  } finally { await stop(server); }
});

test('terminal: Windows focus-fails with no-window-handle gets the locate hint', async () => {
  const { spawn } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'win32',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', 'C:/work/repo'),
    getSessionPid: () => 4242,
    isPidAlive: () => true,
    focusWindow: async () => ({ focused: false, reason: 'no-window-handle' }),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.focused, false);
    assert.equal(body.reason, 'no-window-handle');
    assert.ok(body.hint && body.hint.includes('Could not locate the existing terminal window'),
              `hint: ${body.hint}`);
  } finally { await stop(server); }
});

test('terminal: Windows focus-fails with foreground-blocked surfaces blocked-by-Windows hint', async () => {
  const { spawn } = makeSpawn(['ok']);
  const app = makeApp({
    spawn,
    platform: 'win32',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', 'C:/work/repo'),
    getSessionPid: () => 4242,
    isPidAlive: () => true,
    focusWindow: async () => ({ focused: false, reason: 'foreground-blocked' }),
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.focused, false);
    assert.equal(body.reason, 'foreground-blocked');
    assert.ok(body.hint && body.hint.includes('Windows blocked focus from the background'),
              `hint: ${body.hint}`);
  } finally { await stop(server); }
});

test('terminal: pid recorded but dead spawns as normal, no focus attempt', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  let focusCalled = false;
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', '/work/repo'),
    getSessionPid: () => 9999,
    isPidAlive: () => false,
    focusWindow: async () => { focusCalled = true; return { focused: true }; },
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.focused, undefined, 'focused absent on plain spawn path');
    assert.equal(calls.length, 1);
    assert.equal(focusCalled, false, 'focus must not be attempted for a dead pid');
  } finally { await stop(server); }
});

test('terminal: no pid recorded behaves exactly like the pre-focus path', async () => {
  const { spawn, calls } = makeSpawn(['ok']);
  let focusCalled = false;
  const app = makeApp({
    spawn,
    platform: 'linux',
    readLaunchers: () => ({}),
    fsAccess: async () => {},
    getSession: sessionStub('s1', '/work/repo'),
    getSessionPid: () => null,
    isPidAlive: () => true, // would be true if asked, but it should not be asked
    focusWindow: async () => { focusCalled = true; return { focused: true }; },
    env: {},
  });
  const { server, baseUrl } = await start(app);
  try {
    const res = await fetch(`${baseUrl}/api/sessions/s1/launch/terminal`, { method: 'POST' });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.focused, undefined);
    assert.equal(calls.length, 1);
    assert.equal(focusCalled, false);
  } finally { await stop(server); }
});

// ---------------------------------------------------------------------------
// Per-OS focusExisting branches via a stubbed runFocusCommand. No real
// processes are spawned. Each test asserts the bin/args we would actually
// run and the boolean returned from the helper.
// ---------------------------------------------------------------------------

function makeFocusRunner(scripted) {
  const calls = [];
  let i = 0;
  async function run(bin, args) {
    calls.push({ bin, args });
    const r = scripted[Math.min(i, scripted.length - 1)];
    i++;
    return r;
  }
  return { run, calls };
}

test('focusExisting Windows: invokes powershell with bound TargetPid in a script block', async () => {
  // Regression: previously the route appended ['-TargetPid', '1234']
  // AFTER the -Command string, which PowerShell consumes as its own
  // process args (not script args). $TargetPid was always 0 and the
  // helper always failed. The script must wrap the body in `& { ... } -TargetPid <n>`
  // inside a single -Command argument.
  const { run, calls } = makeFocusRunner([{ code: 0, stdout: 'OK\r\n', stderr: '' }]);
  const r = await focusExisting(1234, 'win32', run);
  assert.deepEqual(r, { focused: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'powershell');
  assert.deepEqual(calls[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.equal(calls[0].args.length, 4, 'no extra tokens after the -Command script');
  const script = calls[0].args[3];
  assert.ok(script.startsWith('& {'), `script must open with script block: ${script.slice(0, 40)}`);
  assert.ok(script.includes('param([int]$TargetPid)'));
  assert.ok(script.includes('AttachThreadInput'));
  assert.ok(script.includes('BringWindowToTop'));
  assert.ok(script.includes('SetForegroundWindow'));
  assert.ok(/} -TargetPid 1234$/.test(script), `script must end with } -TargetPid 1234: ${script.slice(-40)}`);
});

test('focusExisting Windows: powershell exit code 1 -> reason no-window-handle', async () => {
  const { run } = makeFocusRunner([{ code: 1, stdout: '', stderr: '' }]);
  const r = await focusExisting(1234, 'win32', run);
  assert.equal(r.focused, false);
  assert.equal(r.reason, 'no-window-handle');
});

test('focusExisting Windows: powershell exit code 2 -> reason foreground-blocked', async () => {
  const { run } = makeFocusRunner([{ code: 2, stdout: '', stderr: '' }]);
  const r = await focusExisting(1234, 'win32', run);
  assert.equal(r.focused, false);
  assert.equal(r.reason, 'foreground-blocked');
});

test('focusExisting macOS: invokes osascript with System Events frontmost script', async () => {
  const { run, calls } = makeFocusRunner([{ code: 0, stdout: '', stderr: '' }]);
  const r = await focusExisting(777, 'darwin', run);
  assert.deepEqual(r, { focused: true });
  assert.equal(calls[0].bin, 'osascript');
  assert.equal(calls[0].args[0], '-e');
  assert.ok(calls[0].args[1].includes('unix id is 777'));
  assert.ok(calls[0].args[1].includes('frontmost'));
});

test('focusExisting macOS: osascript permission denied -> focused:false', async () => {
  const { run } = makeFocusRunner([{ code: 1, stdout: '', stderr: 'not allowed' }]);
  const r = await focusExisting(777, 'darwin', run);
  assert.equal(r.focused, false);
});

test('focusExisting Linux: wmctrl succeeds on first try', async () => {
  const { run, calls } = makeFocusRunner([{ code: 0, stdout: '', stderr: '' }]);
  const r = await focusExisting(555, 'linux', run);
  assert.equal(r.focused, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, 'sh');
  assert.ok(calls[0].args[1].includes('wmctrl'));
  assert.ok(calls[0].args[1].includes('555'));
});

test('focusExisting Linux: wmctrl fails, xdotool succeeds', async () => {
  const { run, calls } = makeFocusRunner([
    { code: 1, stdout: '', stderr: '' },
    { code: 0, stdout: '', stderr: '' },
  ]);
  const r = await focusExisting(555, 'linux', run);
  assert.equal(r.focused, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].bin, 'xdotool');
  assert.deepEqual(calls[1].args, ['search', '--pid', '555', 'windowactivate']);
});

test('focusExisting Linux: both wmctrl and xdotool missing -> focused:false with reason', async () => {
  const { run } = makeFocusRunner([
    { code: 1, stdout: '', stderr: '' },
    { code: -1, stdout: '', stderr: 'ENOENT' },
  ]);
  const r = await focusExisting(555, 'linux', run);
  assert.equal(r.focused, false);
  assert.equal(r.reason, 'no-wm-tool');
});

test('focusExisting unknown platform -> focused:false with reason', async () => {
  const { run } = makeFocusRunner([{ code: 0, stdout: '', stderr: '' }]);
  const r = await focusExisting(1, 'freebsd', run);
  assert.equal(r.focused, false);
  assert.equal(r.reason, 'unsupported-platform');
});

test('focusExisting bails out when pid is null without invoking runner', async () => {
  let called = false;
  const r = await focusExisting(null, 'linux', async () => { called = true; return { code: 0 }; });
  assert.equal(r.focused, false);
  assert.equal(called, false);
});
