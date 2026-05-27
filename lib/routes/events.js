const express = require('express');

// SSE endpoint exposing session lifecycle and DB activity events.
// Usage: app.use('/api/events', createEventsRouter(emitter));
//
// Frames are written as `event: <type>\ndata: <json>\n\n`. A heartbeat
// comment is sent every 25s to keep proxies and idle connections alive;
// EventSource clients ignore comment lines and do not fire events for them.
function createEventsRouter(emitter, { heartbeatMs = 25000 } = {}) {
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

    clients.add(res);

    // Send a ready frame so the client can clear any reconnect backoff.
    writeEvent(res, 'ready', { at: new Date().toISOString() });

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {}
    }, heartbeatMs);
    if (heartbeat.unref) heartbeat.unref();

    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
      try { res.end(); } catch {}
    });
  });

  return router;
}

module.exports = createEventsRouter;
