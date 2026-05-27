const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { SESSION_STATE_DIR } = require('../paths');
const { openSessionStoreDb } = require('./db');

// Read workspace.yaml for a session
function readWorkspaceYaml(sessionId) {
  const yamlPath = path.join(SESSION_STATE_DIR, sessionId, 'workspace.yaml');
  try {
    const content = fs.readFileSync(yamlPath, 'utf8');
    return yaml.load(content);
  } catch {
    return null;
  }
}

// Check if a session is active by looking for lock files and verifying PID
function getSessionStatus(sessionId) {
  const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
  try {
    const files = fs.readdirSync(sessionDir);
    const lockFiles = files.filter(f => f.match(/^inuse\.\d+\.lock$/));
    if (lockFiles.length === 0) return { status: 'inactive', pid: null };

    for (const lockFile of lockFiles) {
      const pidStr = fs.readFileSync(path.join(sessionDir, lockFile), 'utf8').trim();
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) continue;

      try {
        process.kill(pid, 0); // check if alive
        return { status: 'active', pid };
      } catch {
        return { status: 'stale', pid };
      }
    }
    return { status: 'inactive', pid: null };
  } catch {
    return { status: 'unknown', pid: null };
  }
}

// Find the session ID for a newly created session (not available in JSONL output)
function findNewSessionId(targetCwd, targetName) {
  // Try DB first (fast, indexed)
  try {
    const db = openSessionStoreDb();
    const row = db.prepare(`
      SELECT id FROM sessions
      WHERE lower(cwd) = lower(?)
      AND created_at > datetime('now', '-2 minutes')
      ORDER BY created_at DESC LIMIT 1
    `).get(targetCwd);
    db.close();
    if (row) return row.id;
  } catch {}

  // Fallback: scan recent workspace.yaml files for matching name/cwd
  try {
    const cutoff = Date.now() - 120000; // 2 minutes ago
    const dirs = fs.readdirSync(SESSION_STATE_DIR);
    let bestId = null;
    let bestTime = 0;
    for (const dir of dirs) {
      const wsPath = path.join(SESSION_STATE_DIR, dir, 'workspace.yaml');
      try {
        const stat = fs.statSync(wsPath);
        if (stat.mtimeMs < cutoff || stat.mtimeMs <= bestTime) continue;
        const ws = yaml.load(fs.readFileSync(wsPath, 'utf8'));
        const nameMatch = targetName && ws.name === targetName;
        const cwdMatch = targetCwd && ws.cwd &&
          path.resolve(ws.cwd).toLowerCase() === path.resolve(targetCwd).toLowerCase();
        if (nameMatch || cwdMatch) {
          bestId = ws.id;
          bestTime = stat.mtimeMs;
        }
      } catch {}
    }
    if (bestId) return bestId;
  } catch {}

  return null;
}

module.exports = { readWorkspaceYaml, getSessionStatus, findNewSessionId };
