// Probe: attempt to send an inbound user message into the running CLI session
// via the local WS. Tries several plausible frame shapes since the Copilot CLI
// protocol is not publicly documented.
//
// Usage:
//   node spike/probe-write.js
//
// Throwaway spike code for WI-S (#16). Not for production import. Sends only
// innocuous test prompts.

const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const RUN_DIR = path.join(os.homedir(), '.copilot', 'run');
const port = fs.readFileSync(path.join(RUN_DIR, 'ws.port'), 'utf8').trim();
const token = fs.readFileSync(path.join(RUN_DIR, 'ws.token'), 'utf8').trim();
const url = `ws://127.0.0.1:${port}`;

const TEST_TEXT = 'echo: spike test (safe to ignore)';

function candidates() {
  return [
    { name: 'user.message.simple', body: { type: 'user.message', content: TEST_TEXT } },
    { name: 'message.send', body: { type: 'message.send', message: { role: 'user', content: TEST_TEXT } } },
    { name: 'input.text', body: { type: 'input', text: TEST_TEXT } },
    { name: 'prompt', body: { type: 'prompt', prompt: TEST_TEXT } },
    { name: 'turn.create', body: { type: 'turn.create', input: TEST_TEXT } },
    { name: 'send', body: { type: 'send', content: TEST_TEXT } },
    { name: 'chat.send', body: { type: 'chat.send', message: TEST_TEXT } },
    { name: 'jsonrpc.sendMessage', body: { jsonrpc: '2.0', id: 1, method: 'sendMessage', params: { content: TEST_TEXT } } },
    { name: 'jsonrpc.user.message', body: { jsonrpc: '2.0', id: 2, method: 'user.message', params: { content: TEST_TEXT } } },
    { name: 'plain.string', raw: TEST_TEXT },
  ];
}

function trial(candidate) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, [token]);
    const result = {
      name: candidate.name,
      sent: candidate.raw || JSON.stringify(candidate.body),
      opened: false,
      received: [],
      closeCode: null,
      closeReason: null,
      error: null,
    };

    const finalize = () => { try { ws.close(); } catch {} resolve(result); };
    const settleTimer = setTimeout(finalize, 4000);

    ws.on('open', () => {
      result.opened = true;
      // Wait a beat for any unsolicited greeting frames to land first, then send.
      setTimeout(() => {
        try {
          ws.send(candidate.raw || JSON.stringify(candidate.body));
        } catch (e) {
          result.error = 'send failed: ' + e.message;
          clearTimeout(settleTimer);
          finalize();
        }
      }, 300);
    });

    ws.on('message', (data, isBinary) => {
      const text = isBinary ? `<binary ${data.length}b>` : data.toString('utf8');
      result.received.push(text.length > 400 ? text.slice(0, 400) + '...<truncated>' : text);
    });

    ws.on('close', (code, reason) => {
      result.closeCode = code;
      result.closeReason = reason && reason.toString('utf8');
      clearTimeout(settleTimer);
      resolve(result);
    });
    ws.on('error', (err) => {
      if (!result.error) result.error = err.message;
    });
  });
}

(async () => {
  console.log(`probe-write: ${url}, token len=${token.length}, test text="${TEST_TEXT}"`);
  for (const c of candidates()) {
    const r = await trial(c);
    console.log('---');
    console.log(JSON.stringify(r, null, 2));
  }
})();
