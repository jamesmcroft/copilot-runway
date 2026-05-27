const express = require('express');

// SSE endpoint exposing session lifecycle and DB activity events.
// Usage: app.use('/api/events', createEventsRouter(emitter, { snapshot }));
//
// Frames are written as `event: <type>\ndata: <json>\n\n`. A heartbeat
// comment is sent every 25s to keep proxies and idle connections alive;
// EventSource clients ignore comment lines and do not fire events for them.
//
// On connect each client receives, in order:
//   1. `ready`             - signals headers flushed; clients clear backoff.
//   2. N x session.*       - one frame per known session (snapshot), so the
//                            subscriber can build full state without a parallel
//                            REST call. Snapshot frames are sent ONLY to the
//                            new client's response stream, never broadcast.
//   3. `state.snapshot.end` - `{ count, at }` marker; count matches N above.
//   4. Live deltas         - normal fan-out via the shared EventEmitter.
//
// To eliminate the race between reading the snapshot and subscribing to
// live events, the new connection attaches per-connection buffer listeners
// BEFORE the snapshot is read, captures any events fired during the snapshot
// window, drains them after `state.snapshot.end`, and then atomically swaps
// from the buffer to the shared fan-out set.
function createEventsRouter(emitter, { heartbeatMs = 25000, snapshot } = {}) {
  const router = express.Router();
  const clients = new Set();

  const EVENT_TYPES = [
    'session.created',
    'session.active',
    'session.inactive',
    'session.ended',
    'db.activity',
  ];

  function writeEvent(res, type, data) {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  // Fan out emitter events to all connected clients.
  for (const type of EVENT_TYPES) {
    emitter.on(type, (data) => {
      for (const res of clients) {
        try {
          writeEvent(res, type, data);
        } catch {
          // Best-effort; broken sockets get cleaned up on res 'close'.
        }
      }
    });
  }

  router.get('/', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Send a ready frame so the client can clear any reconnect backoff.
    writeEvent(res, 'ready', { at: new Date().toISOString() });

    // Subscribe-first: capture any live events that fire while we're
    // assembling the snapshot, so they aren't dropped on the floor.
    const buffer = [];
    const bufferListeners = {};
    let bufferAttached = true;
    for (const type of EVENT_TYPES) {
      const listener = (data) => buffer.push({ type, data });
      bufferListeners[type] = listener;
      emitter.on(type, listener);
    }

    function detachBuffer() {
      if (!bufferAttached) return;
      bufferAttached = false;
      for (const type of EVENT_TYPES) {
        try { emitter.off(type, bufferListeners[type]); } catch {}
      }
    }

    // Take the snapshot and write one frame per entry directly to this
    // client's response. These frames must not be broadcast.
    let snapEntries = [];
    if (typeof snapshot === 'function') {
      try { snapEntries = snapshot() || []; } catch { snapEntries = []; }
    }
    for (const entry of snapEntries) {
      try {
        writeEvent(res, entry.type, entry.data);
      } catch {
        // Socket may have closed mid-snapshot; stop writing and let the
        // close handler clean up.
        break;
      }
    }

    writeEvent(res, 'state.snapshot.end', {
      count: snapEntries.length,
      at: new Date().toISOString(),
    });

    // Drain anything the watcher emitted during the snapshot read.
    for (const ev of buffer) {
      try {
        writeEvent(res, ev.type, ev.data);
      } catch {
        break;
      }
    }
    buffer.length = 0;

    // Atomic handover: detach buffer listeners and join the shared fan-out
    // set in the same synchronous tick. EventEmitter.emit is synchronous,
    // so no live event can interleave between these two statements.
    detachBuffer();
    clients.add(res);

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {}
    }, heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      // Defensive: if the connection dropped mid-snapshot before the buffer
      // listeners were detached, remove them now so we don't leak listeners.
      detachBuffer();
      clients.delete(res);
      try { res.end(); } catch {}
    });
  });

  return router;
}

module.exports = createEventsRouter;
