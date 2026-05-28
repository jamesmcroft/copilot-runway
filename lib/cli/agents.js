const { spawnCopilot } = require('./spawn');
const { parseAgentsFromStderr } = require('./agents-parser');

// Cache for available agents. Only successful enumerations are cached so
// transient failures do not pin an empty list for the full TTL.
let cachedAgents = null;
let agentsCacheTime = 0;
const AGENTS_CACHE_TTL = 300000; // 5 minutes

function resetAgentsCache() {
  cachedAgents = null;
  agentsCacheTime = 0;
}

// List available custom agents by invoking the CLI with a sentinel agent name
// and parsing the "available: a, b, c" hint from stderr. Returns [] on any
// failure (parse miss, spawn error, throw); failures are logged loudly via
// console.error with the `[runway]` prefix so operators can spot CLI drift.
//
// `spawn` is injectable for testing; defaults to `spawnCopilot`.
function listAgents({ spawn = spawnCopilot } = {}) {
  return new Promise((resolve) => {
    const now = Date.now();
    if (cachedAgents && (now - agentsCacheTime) < AGENTS_CACHE_TTL) {
      return resolve(cachedAgents);
    }

    let child;
    try {
      child = spawn(['--agent', '__list__', '-p', 'x', '-s']);
    } catch (err) {
      console.error('[runway] agent enumeration: copilot CLI invocation failed: ' + err.message);
      return resolve([]);
    }

    let stderr = '';
    child.stderr.on('data', d => stderr += d.toString());
    child.stdout.on('data', () => {}); // drain

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.on('close', () => {
      const agents = parseAgentsFromStderr(stderr);
      if (agents.length === 0) {
        console.error(
          '[runway] agent enumeration: unrecognised copilot CLI stderr shape; returning empty list. Raw stderr (first 500 chars): '
            + stderr.slice(0, 500)
        );
        return settle([]);
      }
      cachedAgents = agents;
      agentsCacheTime = Date.now();
      settle(agents);
    });

    child.on('error', (err) => {
      console.error('[runway] agent enumeration: copilot CLI invocation failed: ' + err.message);
      settle([]);
    });
  });
}

module.exports = { listAgents, resetAgentsCache };
