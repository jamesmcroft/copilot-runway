const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const yaml = require('js-yaml');
const fs = require('fs');
const { spawn, exec } = require('child_process');

const app = express();
app.use(express.json());

const PORT = 3847;
const ALLOWED_ORIGINS = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];

// CORS protection: reject cross-origin API requests
app.use('/api/', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ error: 'Forbidden: cross-origin request' });
  }
  res.setHeader('Access-Control-Allow-Origin', origin || ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'marked', 'lib')));
const HOME_DIR = process.env.HOME || process.env.USERPROFILE;
const COPILOT_DIR = path.join(HOME_DIR, '.copilot');
const RUNWAY_DIR = path.join(HOME_DIR, '.runway');
const SESSION_STORE_DB = path.join(COPILOT_DIR, 'session-store.db');
const DATA_DB = path.join(COPILOT_DIR, 'data.db');
const SESSION_STATE_DIR = path.join(COPILOT_DIR, 'session-state');
const CUSTOM_PROJECTS_FILE = path.join(RUNWAY_DIR, 'projects.json');
const SESSION_AGENTS_FILE = path.join(RUNWAY_DIR, 'session-agents.json');

// Ensure ~/.runway exists
if (!fs.existsSync(RUNWAY_DIR)) {
  fs.mkdirSync(RUNWAY_DIR, { recursive: true });
}

// Custom projects storage
function loadCustomProjects() {
  try {
    return JSON.parse(fs.readFileSync(CUSTOM_PROJECTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveCustomProjects(projects) {
  fs.writeFileSync(CUSTOM_PROJECTS_FILE, JSON.stringify(projects, null, 2));
}

// Session agent tracking
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

// Find the session ID for a newly created session (not available in JSONL output)
function findNewSessionId(targetCwd, targetName) {
  // Try DB first (fast, indexed)
  try {
    const db = openSessionStoreDb();
    const row = db.prepare(`
      SELECT id FROM sessions
      WHERE lower(cwd) = lower(?)
      AND created_at > datetime('now', '-2 minutes')
      ORDER BY created_at DESC LIMIT 1
    `).get(targetCwd);
    db.close();
    if (row) return row.id;
  } catch {}

  // Fallback: scan recent workspace.yaml files for matching name/cwd
  try {
    const cutoff = Date.now() - 120000; // 2 minutes ago
    const dirs = fs.readdirSync(SESSION_STATE_DIR);
    let bestId = null;
    let bestTime = 0;
    for (const dir of dirs) {
      const wsPath = path.join(SESSION_STATE_DIR, dir, 'workspace.yaml');
      try {
        const stat = fs.statSync(wsPath);
        if (stat.mtimeMs < cutoff || stat.mtimeMs <= bestTime) continue;
        const ws = yaml.load(fs.readFileSync(wsPath, 'utf8'));
        const nameMatch = targetName && ws.name === targetName;
        const cwdMatch = targetCwd && ws.cwd &&
          path.resolve(ws.cwd).toLowerCase() === path.resolve(targetCwd).toLowerCase();
        if (nameMatch || cwdMatch) {
          bestId = ws.id;
          bestTime = stat.mtimeMs;
        }
      } catch {}
    }
    if (bestId) return bestId;
  } catch {}

  return null;
}

// Open databases read-only
function openSessionStoreDb() {
  return new Database(SESSION_STORE_DB, { readonly: true, fileMustExist: true });
}

function openDataDb() {
  return new Database(DATA_DB, { readonly: true, fileMustExist: true });
}

// Read workspace.yaml for a session
function readWorkspaceYaml(sessionId) {
  const yamlPath = path.join(SESSION_STATE_DIR, sessionId, 'workspace.yaml');
  try {
    const content = fs.readFileSync(yamlPath, 'utf8');
    return yaml.load(content);
  } catch {
    return null;
  }
}

// Check if a session is active by looking for lock files and verifying PID
function getSessionStatus(sessionId) {
  const sessionDir = path.join(SESSION_STATE_DIR, sessionId);
  try {
    const files = fs.readdirSync(sessionDir);
    const lockFiles = files.filter(f => f.match(/^inuse\.\d+\.lock$/));
    if (lockFiles.length === 0) return { status: 'inactive', pid: null };

    for (const lockFile of lockFiles) {
      const pidStr = fs.readFileSync(path.join(sessionDir, lockFile), 'utf8').trim();
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid)) continue;

      try {
        process.kill(pid, 0); // check if alive
        return { status: 'active', pid };
      } catch {
        return { status: 'stale', pid };
      }
    }
    return { status: 'inactive', pid: null };
  } catch {
    return { status: 'unknown', pid: null };
  }
}

// GET /api/projects - list projects from data.db + custom
app.get('/api/projects', (req, res) => {
  try {
    const db = openDataDb();
    const dbProjects = db.prepare(`
      SELECT id, name, main_repo_path, github_owner, github_repo, 
             created_at, last_opened_at
      FROM projects ORDER BY name
    `).all();
    db.close();

    const custom = loadCustomProjects();
    const allProjects = [...dbProjects, ...custom];

    // Sort by most recent session activity (fall back to last_opened_at, then name)
    const sessionDb = openSessionStoreDb();
    const cwdRows = sessionDb.prepare(
      `SELECT cwd, MAX(updated_at) as latest FROM sessions GROUP BY cwd`
    ).all();
    sessionDb.close();

    function projectLatest(repoPath) {
      if (!repoPath) return '';
      const norm = repoPath.replace(/\//g, '\\').replace(/\\$/, '').toLowerCase();
      let best = '';
      for (const r of cwdRows) {
        if (!r.cwd) continue;
        const sNorm = r.cwd.replace(/\//g, '\\').replace(/\\$/, '').toLowerCase();
        if (sNorm === norm || sNorm.startsWith(norm + '\\')) {
          if (r.latest > best) best = r.latest;
        }
      }
      return best;
    }

    allProjects.sort((a, b) => {
      const tA = projectLatest(a.main_repo_path) || a.last_opened_at || '';
      const tB = projectLatest(b.main_repo_path) || b.last_opened_at || '';
      return tB.localeCompare(tA); // descending (most recent first)
    });
    res.json(allProjects);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/add - add a custom project folder
app.post('/api/projects/add', (req, res) => {
  const { folderPath, name } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: 'folderPath is required' });
  }

  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return res.status(400).json({ error: 'Path does not exist or is not a directory' });
  }

  const custom = loadCustomProjects();
  if (custom.some(p => p.main_repo_path === resolved)) {
    return res.status(409).json({ error: 'Project already exists' });
  }

  const project = {
    id: `custom-${Date.now()}`,
    name: name || path.basename(resolved),
    main_repo_path: resolved,
    source: 'dashboard',
    created_at: new Date().toISOString(),
  };

  custom.push(project);
  saveCustomProjects(custom);
  res.json(project);
});

// GET /api/sessions - list sessions, optionally filtered
app.get('/api/sessions', (req, res) => {
  try {
    const db = openSessionStoreDb();
    const { cwd, limit = 50, offset = 0, active_only } = req.query;

    let query = `SELECT id, cwd, repository, branch, summary, created_at, updated_at, host_type FROM sessions`;
    const params = [];

    if (cwd) {
      query += ` WHERE cwd LIKE ?`;
      params.push(cwd + '%');
    }

    query += ` ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const sessions = db.prepare(query).all(...params);
    db.close();

    // Enrich with live status and workspace metadata
    const enriched = sessions.map(s => {
      const status = getSessionStatus(s.id);
      const workspace = readWorkspaceYaml(s.id);
      return {
        ...s,
        ...status,
        name: workspace?.name || s.summary || s.id.substring(0, 8),
        branch: workspace?.branch || s.branch,
        cwd: workspace?.cwd || s.cwd,
      };
    });

    if (active_only === 'true') {
      res.json(enriched.filter(s => s.status === 'active'));
    } else {
      res.json(enriched);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/active - get all active sessions
app.get('/api/sessions/active', (req, res) => {
  try {
    const db = openSessionStoreDb();
    const allSessions = db.prepare(`
      SELECT id, cwd, repository, branch, summary, created_at, updated_at, host_type
      FROM sessions ORDER BY updated_at DESC
    `).all();
    db.close();

    const active = allSessions
      .map(s => {
        const status = getSessionStatus(s.id);
        if (status.status !== 'active') return null;
        const workspace = readWorkspaceYaml(s.id);
        return {
          ...s,
          ...status,
          name: workspace?.name || s.summary || s.id.substring(0, 8),
          branch: workspace?.branch || s.branch,
          cwd: workspace?.cwd || s.cwd,
        };
      })
      .filter(Boolean);

    res.json(active);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:id - get session detail with turns
app.get('/api/sessions/:id', (req, res) => {
  try {
    const db = openSessionStoreDb();
    const session = db.prepare(`
      SELECT id, cwd, repository, branch, summary, created_at, updated_at, host_type
      FROM sessions WHERE id = ?
    `).get(req.params.id);

    if (!session) {
      db.close();
      return res.status(404).json({ error: 'Session not found' });
    }

    const turns = db.prepare(`
      SELECT turn_index, user_message, assistant_response, timestamp
      FROM turns WHERE session_id = ? ORDER BY turn_index
    `).all(req.params.id);

    const checkpoints = db.prepare(`
      SELECT checkpoint_number, title, overview, created_at
      FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number
    `).all(req.params.id);

    const files = db.prepare(`
      SELECT DISTINCT file_path, tool_name
      FROM session_files WHERE session_id = ?
    `).all(req.params.id);

    db.close();

    const status = getSessionStatus(session.id);
    const workspace = readWorkspaceYaml(session.id);

    res.json({
      ...session,
      ...status,
      name: workspace?.name || session.summary || session.id.substring(0, 8),
      branch: workspace?.branch || session.branch,
      cwd: workspace?.cwd || session.cwd,
      agent: getSessionAgent(session.id),
      turns,
      checkpoints,
      files,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track running CLI processes
const runningProcesses = new Map();

// Cache for available agents
let cachedAgents = null;
let agentsCacheTime = 0;
const AGENTS_CACHE_TTL = 300000; // 5 minutes

// GET /api/agents - list available custom agents
app.get('/api/agents', async (req, res) => {
  const now = Date.now();
  if (cachedAgents && (now - agentsCacheTime) < AGENTS_CACHE_TTL) {
    return res.json(cachedAgents);
  }

  try {
    const child = spawn('copilot', ['--agent', '__list__', '-p', 'x', '-s'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

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
      res.json(agents);
    });

    child.on('error', () => {
      res.json(cachedAgents || []);
    });
  } catch {
    res.json(cachedAgents || []);
  }
});

// POST /api/sessions/send - send a prompt (new or resume)
app.post('/api/sessions/send', (req, res) => {
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

  const child = spawn('copilot', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

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

  // Use res 'close' (not req) — req 'close' fires after body is consumed, killing the child prematurely
  res.on('close', () => {
    if (!ended && !child.killed) child.kill();
    runningProcesses.delete(processId);
  });
});

// GET /api/stats - dashboard stats
app.get('/api/stats', (req, res) => {
  try {
    const db = openSessionStoreDb();
    const totalSessions = db.prepare('SELECT COUNT(*) as count FROM sessions').get().count;
    const totalTurns = db.prepare('SELECT COUNT(*) as count FROM turns').get().count;
    const recentSessions = db.prepare(
      "SELECT COUNT(*) as count FROM sessions WHERE updated_at > datetime('now', '-7 days')"
    ).get().count;
    db.close();

    // Count active sessions
    let activeSessions = 0;
    try {
      const dirs = fs.readdirSync(SESSION_STATE_DIR, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const status = getSessionStatus(dir.name);
        if (status.status === 'active') activeSessions++;
      }
    } catch {}

    res.json({ totalSessions, totalTurns, recentSessions, activeSessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const url = `http://127.0.0.1:${PORT}`;

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Copilot Runway running at ${url}\n`);

  // Auto-open in the user's default browser
  const openCmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(openCmd, () => {}); // fire-and-forget
});
