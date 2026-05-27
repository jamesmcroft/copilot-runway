const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Map of cwd -> canonical repo key (string) or null when git is unavailable
// or the cwd is not a working tree. Computed lazily on first lookup and
// cached for the lifetime of the process so we do not shell out to git on
// every session list render.
const cache = new Map();

function projectKeyForCwd(cwd) {
  if (!cwd) return null;
  if (cache.has(cwd)) return cache.get(cwd);

  let key = null;
  try {
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) {
      // --git-common-dir resolves to the main repo's .git directory even
      // when called from a linked worktree, so sibling worktrees share a
      // single key. --path-format=absolute requires Git 2.31+; older
      // versions fall through to the catch and key stays null.
      const out = execFileSync(
        'git',
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 2000,
          windowsHide: true,
        }
      ).trim();

      if (out) {
        let resolved = path.resolve(out);
        // The common dir is usually the ".git" folder of the main repo.
        // Walk up one level so the key matches the working tree root, not
        // the .git metadata folder.
        if (path.basename(resolved).toLowerCase() === '.git') {
          resolved = path.dirname(resolved);
        }
        key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      }
    }
  } catch {
    key = null;
  }

  cache.set(cwd, key);
  return key;
}

function clearWorktreeCache() {
  cache.clear();
}

module.exports = { projectKeyForCwd, clearWorktreeCache };
