const { execFileSync } = require('child_process');

// Per-cwd cache of the live branch name. workspace.yaml only records the
// branch at session start, so a long-running session that switches branches
// mid-run would otherwise show a stale name in the UI. We resolve the
// current branch via `git rev-parse --abbrev-ref HEAD` on demand and cache
// it briefly so a single UI refresh that touches many sessions doesn't
// fan out into one git spawn per render.
//
// Cache shape: Map<cwd, { value: string | null, expiresAt: number }>.
// We cache `null` for the same TTL so a transient git failure (missing
// cwd, repo being rewritten, git not on PATH) doesn't trigger a spawn
// storm while the UI keeps polling.
const cache = new Map();
const TTL_MS = 30_000;

// Indirection so tests can fast-forward the TTL without sleeping.
let nowFn = () => Date.now();

function getActiveBranch(cwd) {
  if (!cwd) return null;

  const now = nowFn();
  const cached = cache.get(cwd);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  let value = null;
  try {
    const out = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
        windowsHide: true,
      }
    ).trim();
    // `--abbrev-ref HEAD` returns the literal string "HEAD" when in a
    // detached state. That is a legitimate, displayable value, so we keep
    // it. Only treat an empty string as "no useful answer" and fall back.
    if (out) value = out;
  } catch {
    value = null;
  }

  cache.set(cwd, { value, expiresAt: now + TTL_MS });
  return value;
}

function clearBranchCache() {
  cache.clear();
}

// Test-only hook to inject a synthetic clock. Pass a function returning
// milliseconds, or `null` to restore the real clock.
function __setNowForTests(fn) {
  nowFn = typeof fn === 'function' ? fn : () => Date.now();
}

module.exports = { getActiveBranch, clearBranchCache, __setNowForTests };
