const express = require('express');

const { runningProcesses, spawnCopilot } = require('../cli/spawn');
const { findNewSessionId } = require('../store/sessions');
const { saveSessionAgent } = require('../runway/session-agents');

const router = express.Router();

// POST /api/sessions/send - send a prompt (new or resume) and stream SSE
router.post('/send', (req, res) => {
  const { prompt, sessionId, cwd, name, agent } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const args = [
    '-p', prompt,
    '--allow-all',
    '-s',
    '--output-format', 'json',
    '--disable-builtin-mcps',
  ];

  if (sessionId) {
    args.push('--resume=' + sessionId);
  } else {
    if (cwd) args.push('-C', cwd);
    if (name) args.push('-n', name);
  }

  if (agent) {
    args.push('--agent', agent);
  }

  const child = spawnCopilot(args);

  const processId = sessionId || `new-${Date.now()}`;
  runningProcesses.set(processId, child);

  child.on('error', (err) => {
    res.write(`data: ${JSON.stringify({ type: 'error', data: { message: `Failed to start copilot: ${err.message}` } })}\n\n`);
    res.end();
    runningProcesses.delete(processId);
  });

  let buffer = '';

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // skip non-JSON lines
      }
    }
  });

  child.stderr.on('data', (data) => {
    res.write(`data: ${JSON.stringify({ type: 'error', data: { message: data.toString() } })}\n\n`);
  });

  let ended = false;

  child.on('close', (code) => {
    runningProcesses.delete(processId);
    // Persist agent selection for this session
    if (agent) {
      const sid = sessionId || findNewSessionId(cwd, name);
      if (sid) saveSessionAgent(sid, agent);
    }
    res.write(`data: ${JSON.stringify({ type: 'process.exit', data: { code } })}\n\n`);
    ended = true;
    res.end();
  });

  // Use res 'close' (not req) because req 'close' fires after body is consumed,
  // killing the child prematurely
  res.on('close', () => {
    if (!ended && !child.killed) child.kill();
    runningProcesses.delete(processId);
  });
});

module.exports = router;
