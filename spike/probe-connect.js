// Probe: try multiple WS handshake variants against the Copilot CLI's local
// endpoint and report which one is accepted.
//
// Throwaway spike code for WI-S (#16). Not for production import.

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const RUN_DIR = path.join(os.homedir(), '.copilot', 'run');
const port = fs.readFileSync(path.join(RUN_DIR, 'ws.port'), 'utf8').trim();
const token = fs.readFileSync(path.join(RUN_DIR, 'ws.token'), 'utf8').trim();
const base = `ws://127.0.0.1:${port}`;

function tryConnect(label, url, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const ws = new WebSocket(url, options.subprotocols || [], {
      headers: options.headers || {},
    });
    const result = {
      label,
      accepted: false,
      framesReceived: 0,
      firstFrameSample: null,
      closeCode: null,
      closeReason: null,
      error: null,
    };
    const timer = setTimeout(() => {
      result.error = result.error || 'timeout(3s)';
      try { ws.close(); } catch {}
    }, 3000);

    ws.on('open', () => {
      result.accepted = true;
      result.handshakeMs = Date.now() - startedAt;
      setTimeout(() => { try { ws.close(1000, 'probe done'); } catch {} }, 500);
    });
    ws.on('message', (data, isBinary) => {
      result.framesReceived++;
      if (!result.firstFrameSample) {
        const text = isBinary ? `<binary ${data.length} bytes>` : data.toString('utf8');
        result.firstFrameSample = text.slice(0, 400);
      }
    });
    ws.on('unexpected-response', (_req, res) => {
      result.error = `http ${res.statusCode}`;
      clearTimeout(timer);
      resolve(result);
    });
    ws.on('error', (err) => {
      if (!result.error) result.error = err.message;
    });
    ws.on('close', (code, reason) => {
      result.closeCode = code;
      result.closeReason = reason && reason.toString('utf8');
      clearTimeout(timer);
      setTimeout(() => resolve(result), 50);
    });
  });
}

(async () => {
  console.log(`probe-connect: base=${base}, token length=${token.length}`);
  const variants = [
    { label: 'subprotocol', url: base, options: { subprotocols: [token] } },
    { label: 'authorization-bearer', url: base, options: { headers: { Authorization: `Bearer ${token}` } } },
    { label: 'query-param', url: `${base}/?token=${encodeURIComponent(token)}`, options: {} },
    { label: 'path-ws-bearer', url: `${base}/ws`, options: { headers: { Authorization: `Bearer ${token}` } } },
    { label: 'no-auth', url: base, options: {} },
  ];

  for (const v of variants) {
    const r = await tryConnect(v.label, v.url, v.options);
    console.log(JSON.stringify(r));
  }
})();
