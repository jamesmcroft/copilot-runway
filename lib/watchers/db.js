const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const { SESSION_STORE_DB } = require('../paths');

// Hybrid watcher for ~/.copilot/session-store.db (+ -wal). Uses fs.watch for
// fast change notifications and a periodic fs.stat mtime heartbeat as a
// safety net for filesystems where watch events may be missed (network
// shares, some Windows scenarios). Debounces events so a burst of WAL
// commits from a single CLI turn only produces one db.activity event.
//
// Emits on the returned EventEmitter:
//   db.activity { at }
function createDbWatcher(emitter = new EventEmitter(), { debounceMs = 250, heartbeatMs = 2000 } = {}) {
  const dbDir = path.dirname(SESSION_STORE_DB);
  const dbBase = path.basename(SESSION_STORE_DB);
  const walBase = dbBase + '-wal';

  let debounceTimer = null;
  let lastMtimeMs = 0;
  let lastWalMtimeMs = 0;
  const watchers = [];
  let heartbeatTimer = null;

  function now() {
    return new Date().toISOString();
  }

  function scheduleEmit() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emitter.emit('db.activity', { at: now() });
    }, debounceMs);
    if (debounceTimer.unref) debounceTimer.unref();
  }

  function checkMtimes() {
    try {
      const stat = fs.statSync(SESSION_STORE_DB);
      if (stat.mtimeMs > lastMtimeMs) {
        lastMtimeMs = stat.mtimeMs;
        scheduleEmit();
      }
    } catch {}
    try {
      const walStat = fs.statSync(SESSION_STORE_DB + '-wal');
      if (walStat.mtimeMs > lastWalMtimeMs) {
        lastWalMtimeMs = walStat.mtimeMs;
        scheduleEmit();
      }
    } catch {}
  }

  function start() {
    // Seed mtimes so we don't emit on startup.
    try { lastMtimeMs = fs.statSync(SESSION_STORE_DB).mtimeMs; } catch {}
    try { lastWalMtimeMs = fs.statSync(SESSION_STORE_DB + '-wal').mtimeMs; } catch {}

    // Watch the directory so we pick up both files even if -wal is created later.
    if (fs.existsSync(dbDir)) {
      try {
        const w = fs.watch(dbDir, (eventType, filename) => {
          if (!filename) {
            // Some platforms omit filename; treat as a hint and re-check.
            scheduleEmit();
            return;
          }
          if (filename === dbBase || filename === walBase) {
            scheduleEmit();
          }
        });
        w.on('error', () => {});
        watchers.push(w);
      } catch {
        // Fall back to heartbeat-only.
      }
    }

    // Heartbeat: catches missed watch events on network/virtual filesystems.
    heartbeatTimer = setInterval(checkMtimes, heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  function stop() {
    for (const w of watchers) {
      try { w.close(); } catch {}
    }
    watchers.length = 0;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  return { emitter, start, stop };
}

module.exports = { createDbWatcher };
