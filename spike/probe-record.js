// Probe: connect to the Copilot CLI WS and log every inbound frame as NDJSON.
//
// Usage:
//   node spike/probe-record.js                  # stdout only
//   node spike/probe-record.js out.ndjson       # also tee to file
//
// Throwaway spike code for WI-S (#16). Not for production import.

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const RUN_DIR = path.join(os.homedir(), '.copilot', 'run');
const port = fs.readFileSync(path.join(RUN_DIR, 'ws.port'), 'utf8').trim();
const token = fs.readFileSync(path.join(RUN_DIR, 'ws.token'), 'utf8').trim();
const url = `ws://127.0.0.1:${port}`;

const outFile = process.argv[2];
const out = outFile ? fs.createWriteStream(outFile, { flags: 'a' }) : null;

function emit(record) {
  const line = JSON.stringify(record);
  process.stdout.write(line + '\n');
  if (out) out.write(line + '\n');
}

function connect() {
  // probe-connect.js established that the token is accepted as a subprotocol.
  const ws = new WebSocket(url, [token]);
  ws.on('open', () => emit({ ts: new Date().toISOString(), dir: 'meta', event: 'open' }));
  ws.on('message', (data, isBinary) => {
    const ts = new Date().toISOString();
    if (isBinary) {
      emit({ ts, dir: 'in', binary: true, bytes: data.length });
      return;
    }
    const text = data.toString('utf8');
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    emit({ ts, dir: 'in', text: parsed ? undefined : text, json: parsed || undefined });
  });
  ws.on('close', (code, reason) => {
    emit({ ts: new Date().toISOString(), dir: 'meta', event: 'close', code, reason: reason && reason.toString('utf8') });
  });
  ws.on('error', (err) => {
    emit({ ts: new Date().toISOString(), dir: 'meta', event: 'error', message: err.message });
  });
  return ws;
}

const ws = connect();
process.on('SIGINT', () => { try { ws.close(); } catch {} process.exit(0); });
