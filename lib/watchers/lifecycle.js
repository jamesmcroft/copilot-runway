const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { SESSION_STATE_DIR } = require('../paths');
const { getSessionStatus } = require('../store/sessions');

// Tracks lifecycle of sessions under ~/.copilot/session-state/ by watching
// directory creation/removal and inuse.<pid>.lock file appearance/disappearance.
//
// Emits on the returned EventEmitter:
//   session.created  { sessionId, at }
//   session.active   { sessionId, pid, at }
//   session.inactive { sessionId, at }
//   session.ended    { sessionId, at }
function createLifecycleWatcher(emitter = new EventEmitter()) {
  // Track which session IDs we currently know about, and whether each is active.
  const known = new Map(); // sessionId -> { active: boolean, pid: number|null }

  function now() {
    return new Date().toISOString();
  }

  // Seed initial state from disk so we don't fire spurious "created" events on startup.
  function seed() {
    if (!fs.existsSync(SESSION_STATE_DIR)) return;
    let entries;
    try {
      entries = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const { status, pid } = getSessionStatus(entry.name);
      known.set(entry.name, { active: status === 'active', pid: status === 'active' ? pid : null });
    }
  }

  function reconcileSession(sessionId) {
    const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
    const exists = fs.existsSync(sessionDir);
    const prev = known.get(sessionId);

    if (!exists) {
      if (prev) {
        if (prev.active) {
          emitter.emit('session.inactive', { sessionId, at: now() });
        }
        emitter.emit('session.ended', { sessionId, at: now() });
        known.delete(sessionId);
      }
      return;
    }

    if (!prev) {
      known.set(sessionId, { active: false, pid: null });
      emitter.emit('session.created', { sessionId, at: now() });
    }

    const { status, pid } = getSessionStatus(sessionId);
    const cur = known.get(sessionId);
    const isActive = status === 'active';

    if (isActive && !cur.active) {
      cur.active = true;
      cur.pid = pid;
      emitter.emit('session.active', { sessionId, pid, at: now() });
    } else if (!isActive && cur.active) {
      cur.active = false;
      cur.pid = null;
      emitter.emit('session.inactive', { sessionId, at: now() });
    }
  }

  // Periodic liveness sweep: catches the case where a CLI process dies
  // without removing its lock file. process.kill(pid, 0) is cheap.
  function livenessSweep() {
    for (const [sessionId, state] of known.entries()) {
      if (!state.active) continue;
      const { status } = getSessionStatus(sessionId);
      if (status !== 'active') {
        state.active = false;
        state.pid = null;
        emitter.emit('session.inactive', { sessionId, at: now() });
      }
    }
  }

  let watcher = null;
  let sweepTimer = null;

  function start() {
    seed();

    if (!fs.existsSync(SESSION_STATE_DIR)) {
      try {
        fs.mkdirSync(SESSION_STATE_DIR, { recursive: true });
      } catch {
        return;
      }
    }

    try {
      watcher = fs.watch(SESSION_STATE_DIR, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        // filename may be "<sessionId>" or "<sessionId>/<inner>" (or backslash on Windows).
        const segments = String(filename).split(/[\\/]/);
        const sessionId = segments[0];
        if (!sessionId) return;

        // If the top-level entry no longer exists, treat as removal.
        try {
          const stat = fs.statSync(path.join(SESSION_STATE_DIR, sessionId));
          if (!stat.isDirectory()) return;
        } catch {
          reconcileSession(sessionId);
          return;
        }

        reconcileSession(sessionId);
      });
      watcher.on('error', () => {});
    } catch {
      // If recursive watch is unsupported, the liveness sweep still provides coverage.
    }

    sweepTimer = setInterval(livenessSweep, 5000);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  function stop() {
    if (watcher) {
      try { watcher.close(); } catch {}
      watcher = null;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  return { emitter, start, stop };
}

module.exports = { createLifecycleWatcher };
