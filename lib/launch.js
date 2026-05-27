// Launch routes: open a session's working directory in VS Code, or in a
// new terminal that auto-runs `copilot --resume=<id>`.
//
// Config file: ~/.runway/launchers.json
//   Shape:
//     {
//       "vscode": "code"
//     }
//   Supported keys:
//     - vscode: name of the editor binary to spawn. Defaults to `code`.
//       Only values in VSCODE_BINARIES are honoured; any other value falls
//       back to the default and a warning is logged. Parse errors and
//       missing files are non-fatal and fall back to the default.
//
// Security notes:
// - Client never names a binary. The only user-influenced binary string
//   comes from the on-disk launchers.json and is validated against an
//   allowlist before being spawned.
// - `shell: true` is only used where unavoidable (Windows wt/cmd/code.cmd).
//   Where used, server-trusted values (the session's cwd and id, both
//   sourced from the session-store DB) are quoted with the platform's
//   shell quoting rules before interpolation. macOS osascript runs with
//   shell:false so the AppleScript string is passed verbatim as argv.
// - RUNWAY_TERMINAL is intentionally NOT allowlisted: a user-set env var
//   on a 127.0.0.1-bound server already implies arbitrary code execution
//   by that user, so gating it further would add no security and would
//   break legitimate terminal choices (xterm, alacritty, kitty, etc.).

const express = require('express');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const { RUNWAY_DIR } = require('./paths');

// Allowlists. The vscode allowlist gates the launchers.json override.
// The terminal allowlist is informational: terminal binaries are picked
// by the server based on platform and (on Linux) RUNWAY_TERMINAL, never
// from request input.
const VSCODE_BINARIES = ['code', 'code-insiders', 'cursor', 'codium'];
const LINUX_TERMINAL_FALLBACKS = ['x-terminal-emulator', 'gnome-terminal', 'konsole'];

const LAUNCHERS_FILE = path.join(RUNWAY_DIR, 'launchers.json');

function defaultReadLaunchers() {
  try {
    const raw = fs.readFileSync(LAUNCHERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    console.warn(`[launch] ${LAUNCHERS_FILE} is not a JSON object, ignoring`);
    return {};
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    console.warn(`[launch] failed to read ${LAUNCHERS_FILE}: ${err.message}`);
    return {};
  }
}

function resolveVscodeBinary(readLaunchers) {
  let cfg;
  try {
    cfg = readLaunchers() || {};
  } catch (err) {
    console.warn(`[launch] launchers reader threw: ${err.message}, falling back to "code"`);
    cfg = {};
  }
  const requested = typeof cfg.vscode === 'string' ? cfg.vscode.trim() : '';
  if (!requested) return 'code';
  if (VSCODE_BINARIES.includes(requested)) return requested;
  console.warn(`[launch] vscode binary "${requested}" not in allowlist, falling back to "code"`);
  return 'code';
}

// Quote a value for a Windows cmd.exe string.
function quoteCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Quote a single argv element for Node's `shell: true` on Windows.
//
// With shell:true on Windows, Node joins argv with spaces and passes the
// whole thing to `cmd.exe /d /s /c`. Args are NOT quoted for us, so any
// value containing a space (e.g. `C:\Program Files\My Repo`) is split by
// the shell. Wrap in "..." and escape embedded " as "" (cmd.exe rule).
function quoteWinShellArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Escape a value for embedding inside an AppleScript double-quoted string.
function escAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Escape a value for embedding inside a POSIX double-quoted shell string.
function escPosixShell(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

// Attempt a sequence of spawn descriptors. Stops at the first one that
// does not emit a synchronous-or-immediate 'error'. On error other than
// the last attempt, falls through to the next. Returns the last error if
// all attempts fail.
function attemptSpawn(spawn, commands) {
  return new Promise(resolve => {
    let index = 0;

    function tryNext() {
      if (index >= commands.length) {
        return resolve({ ok: false, err: new Error('no-commands-provided') });
      }
      const cmd = commands[index++];
      let settled = false;
      let child;
      try {
        child = spawn(cmd.bin, cmd.args, cmd.opts);
      } catch (err) {
        if (index >= commands.length) return resolve({ ok: false, err, command: cmd });
        return tryNext();
      }
      child.once('error', err => {
        if (settled) return;
        settled = true;
        if (index >= commands.length) return resolve({ ok: false, err, command: cmd });
        tryNext();
      });
      setImmediate(() => {
        if (settled) return;
        settled = true;
        try { child.unref && child.unref(); } catch {}
        resolve({ ok: true, command: cmd });
      });
    }

    tryNext();
  });
}

function buildVscodeCommand(bin, cwd, platform) {
  // On Windows we spawn via the shell so that `code.cmd` (the actual file
  // on PATH) resolves. With shell:true Node does not quote argv, so wrap
  // cwd ourselves to survive paths with spaces.
  const args = platform === 'win32' ? [quoteWinShellArg(cwd)] : [cwd];
  return {
    bin,
    args,
    opts: { detached: true, stdio: 'ignore', shell: platform === 'win32' },
  };
}

function buildTerminalCommands(platform, cwd, sessionId, env) {
  if (platform === 'win32') {
    const qCwd = quoteWinShellArg(cwd);
    const qId = quoteWinShellArg(sessionId);
    const cmdString = `cd /d ${quoteCmd(cwd)} && copilot --resume=${quoteCmd(sessionId)}`;
    return [
      {
        // shell:true on Windows joins argv with spaces, so pre-quote cwd
        // and sessionId. wt strips the surrounding quotes when parsing.
        bin: 'wt',
        args: ['-d', qCwd, 'copilot', '--resume', qId],
        opts: { detached: true, stdio: 'ignore', shell: true },
      },
      {
        bin: 'cmd',
        args: ['/k', cmdString],
        opts: { detached: true, stdio: 'ignore', shell: true },
      },
    ];
  }

  if (platform === 'darwin') {
    // osascript is at a fixed path; no shell needed. With shell:false the
    // -e argv element is passed verbatim and escAppleScript is sufficient.
    const escCwd = escAppleScript(cwd);
    const escId = escAppleScript(sessionId);
    const script = `tell application "Terminal" to do script "cd \\"${escCwd}\\" && copilot --resume=${escId}"`;
    return [
      {
        bin: 'osascript',
        args: ['-e', script],
        opts: { detached: true, stdio: 'ignore' },
      },
    ];
  }

  // Linux (and other POSIX): honour RUNWAY_TERMINAL, then fall back.
  const shellCmd = `cd "${escPosixShell(cwd)}" && copilot --resume=${escPosixShell(sessionId)}; exec $SHELL`;
  const buildLinuxCommand = bin => {
    // Per-binary flag table. gnome-terminal needs `--` before the command,
    // konsole and x-terminal-emulator accept `-e` with a shell string.
    if (bin === 'gnome-terminal') {
      return { bin, args: ['--', 'bash', '-c', shellCmd], opts: { detached: true, stdio: 'ignore' } };
    }
    if (bin === 'konsole') {
      return { bin, args: ['-e', 'bash', '-c', shellCmd], opts: { detached: true, stdio: 'ignore' } };
    }
    // x-terminal-emulator and user-supplied RUNWAY_TERMINAL: use -e with a
    // single shell string. This is the most widely understood form.
    return { bin, args: ['-e', `bash -c '${shellCmd.replace(/'/g, "'\\''")}'`], opts: { detached: true, stdio: 'ignore' } };
  };

  const override = env && typeof env.RUNWAY_TERMINAL === 'string' && env.RUNWAY_TERMINAL.trim();
  if (override) return [buildLinuxCommand(override)];
  return LINUX_TERMINAL_FALLBACKS.map(buildLinuxCommand);
}

function createLaunchRouter(options = {}) {
  const spawn = options.spawn || child_process.spawn;
  const platform = options.platform || process.platform;
  const readLaunchers = options.readLaunchers || defaultReadLaunchers;
  const fsAccess = options.fsAccess || (p => fs.promises.access(p));
  const getSession = options.getSession;
  const env = options.env || process.env;

  if (typeof getSession !== 'function') {
    throw new Error('createLaunchRouter requires a getSession function');
  }

  const router = express.Router();

  async function resolveSession(req, res) {
    const session = await getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: 'session not found' });
      return null;
    }
    if (!session.cwd) {
      res.status(400).json({ error: 'session has no cwd' });
      return null;
    }
    try {
      await fsAccess(session.cwd);
    } catch {
      res.status(400).json({ error: 'session cwd is not accessible', cwd: session.cwd });
      return null;
    }
    return session;
  }

  router.post('/:id/launch/vscode', async (req, res) => {
    const session = await resolveSession(req, res);
    if (!session) return;

    const bin = resolveVscodeBinary(readLaunchers);
    const command = buildVscodeCommand(bin, session.cwd, platform);

    const result = await attemptSpawn(spawn, [command]);
    if (result.ok) return res.json({ ok: true, bin });

    const code = result.err && result.err.code;
    if (code === 'ENOENT') {
      return res.json({
        ok: false,
        error: 'vscode-not-on-path',
        hint: 'Install the VS Code shell command from the Command Palette: Shell Command: Install code command in PATH',
      });
    }
    return res.json({
      ok: false,
      error: code || 'spawn-failed',
      hint: (result.err && result.err.message) || 'Failed to launch VS Code',
    });
  });

  router.post('/:id/launch/terminal', async (req, res) => {
    const session = await resolveSession(req, res);
    if (!session) return;

    const commands = buildTerminalCommands(platform, session.cwd, session.id, env);
    const result = await attemptSpawn(spawn, commands);
    if (result.ok) return res.json({ ok: true, bin: result.command.bin });

    if (platform === 'linux') {
      return res.json({
        ok: false,
        error: 'no-terminal-found',
        hint: 'Set RUNWAY_TERMINAL=<binary> or install x-terminal-emulator.',
      });
    }
    if (platform === 'win32') {
      return res.json({
        ok: false,
        error: 'no-terminal-found',
        hint: 'Install Windows Terminal (wt) or ensure cmd.exe is available on PATH.',
      });
    }
    if (platform === 'darwin') {
      return res.json({
        ok: false,
        error: 'no-terminal-found',
        hint: 'Could not launch Terminal.app via osascript.',
      });
    }
    return res.json({
      ok: false,
      error: (result.err && result.err.code) || 'spawn-failed',
      hint: (result.err && result.err.message) || 'Failed to launch terminal',
    });
  });

  return router;
}

module.exports = {
  createLaunchRouter,
  // Exported for tests and for the default DB-backed getSession in server.js.
  defaultReadLaunchers,
  resolveVscodeBinary,
  buildVscodeCommand,
  buildTerminalCommands,
  attemptSpawn,
  VSCODE_BINARIES,
  LINUX_TERMINAL_FALLBACKS,
  LAUNCHERS_FILE,
};
