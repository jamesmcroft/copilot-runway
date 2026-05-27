const { spawn } = require('child_process');

// Track running CLI processes by a caller-supplied key (session ID or new-* token)
const runningProcesses = new Map();

// Spawn the `copilot` binary with stdout/stderr piped. windowsHide keeps no
// console window on Windows. Callers own all stream handling.
function spawnCopilot(args) {
  return spawn('copilot', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

module.exports = { runningProcesses, spawnCopilot };
