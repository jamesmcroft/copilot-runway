const { spawnCopilot } = require('./spawn');

// Cache for available agents
let cachedAgents = null;
let agentsCacheTime = 0;
const AGENTS_CACHE_TTL = 300000; // 5 minutes

// List available custom agents by invoking the CLI with a sentinel agent name
// and parsing the "available: a, b, c" hint from stderr. Resolves with the
// cached list on error.
function listAgents() {
  return new Promise((resolve) => {
    const now = Date.now();
    if (cachedAgents && (now - agentsCacheTime) < AGENTS_CACHE_TTL) {
      return resolve(cachedAgents);
    }

    try {
      const child = spawnCopilot(['--agent', '__list__', '-p', 'x', '-s']);

      let stderr = '';
      child.stderr.on('data', d => stderr += d.toString());
      child.stdout.on('data', () => {}); // drain

      child.on('close', () => {
        // Parse "No such agent: __list__, available: agent1, agent2, ..."
        const match = stderr.match(/available:\s*(.+)/i);
        const agents = match
          ? match[1].split(',').map(a => a.trim()).filter(Boolean)
          : [];
        cachedAgents = agents;
        agentsCacheTime = Date.now();
        resolve(agents);
      });

      child.on('error', () => {
        resolve(cachedAgents || []);
      });
    } catch {
      resolve(cachedAgents || []);
    }
  });
}

module.exports = { listAgents };
