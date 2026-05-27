const fs = require('fs');
const { SESSION_AGENTS_FILE } = require('../paths');

// Session agent tracking (which custom agent was last used for a session)
function loadSessionAgents() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_AGENTS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveSessionAgent(sessionId, agent) {
  const agents = loadSessionAgents();
  if (agent) {
    agents[sessionId] = agent;
  } else {
    delete agents[sessionId];
  }
  fs.writeFileSync(SESSION_AGENTS_FILE, JSON.stringify(agents, null, 2));
}

function getSessionAgent(sessionId) {
  return loadSessionAgents()[sessionId] || null;
}

module.exports = { loadSessionAgents, saveSessionAgent, getSessionAgent };
