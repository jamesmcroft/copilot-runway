const express = require('express');
const path = require('path');
const { EventEmitter } = require('events');
const { exec } = require('child_process');

// Trigger ~/.runway directory creation as a side effect of importing paths
require('./lib/paths');

const projectsRouter = require('./lib/routes/projects');
const sessionsRouter = require('./lib/routes/sessions');
const searchRouter = require('./lib/routes/search');
const sendRouter = require('./lib/routes/send');
const agentsRouter = require('./lib/routes/agents');
const statsRouter = require('./lib/routes/stats');
const pinsRouter = require('./lib/routes/pins');
const settingsRouter = require('./lib/routes/settings');
const createEventsRouter = require('./lib/routes/events');
const { createLaunchRouter } = require('./lib/launch');
const { openSessionStoreDb } = require('./lib/store/db');
const { readWorkspaceYaml, getSessionStatus } = require('./lib/store/sessions');
const { createLifecycleWatcher } = require('./lib/watchers/lifecycle');
const { createDbWatcher } = require('./lib/watchers/db');

// Shared event bus: lifecycle and DB watchers publish here, the SSE
// router fans events out to connected dashboard clients.
const runwayEvents = new EventEmitter();
runwayEvents.setMaxListeners(0);
const lifecycle = createLifecycleWatcher(runwayEvents);
lifecycle.start();
createDbWatcher(runwayEvents).start();

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

// Resolve marked via require.resolve so it works regardless of npm hoisting
// (when installed via npx, dependencies hoist to a sibling node_modules folder).
const markedLibDir = path.join(path.dirname(require.resolve('marked/package.json')), 'lib');
app.use('/vendor', express.static(markedLibDir));

// Prism is mounted the same way: resolve via require.resolve so it
// survives npm hoisting under npx, and serve the package root so both
// prism.js and the components/ folder are reachable from index.html.
const prismRoot = path.dirname(require.resolve('prismjs/package.json'));
app.use('/vendor/prism', express.static(prismRoot));

// API routes
app.use('/api/projects', projectsRouter);
app.use('/api/sessions', sendRouter);
// Search router must mount before sessionsRouter so /search is not
// captured by the /:id route in sessionsRouter.
app.use('/api/sessions', searchRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/stats', statsRouter);
app.use('/api/pins', pinsRouter);
app.use('/api/settings', settingsRouter);
// Serve the standalone settings page (loaded by app.js for topbar +
// theme bootstrap, then settings.js for the schema-driven form).
app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});
app.use('/api/events', createEventsRouter(runwayEvents, { snapshot: lifecycle.snapshot }));

// Launch endpoints (Open in VS Code / Open in Terminal). The DB-backed
// getSession is injected so tests can stub it without touching disk.
app.use('/api/sessions', createLaunchRouter({
  getSession: (id) => {
    try {
      const db = openSessionStoreDb();
      const row = db.prepare('SELECT id, cwd FROM sessions WHERE id = ?').get(id);
      db.close();
      if (!row) return null;
      const workspace = readWorkspaceYaml(row.id);
      return { id: row.id, cwd: (workspace && workspace.cwd) || row.cwd };
    } catch {
      return null;
    }
  },
  // Source of truth for the active CLI pid: the inuse.<pid>.lock file
  // under ~/.copilot/session-state/<id>/. getSessionStatus already does
  // the alive probe; we surface the pid only when the session is active.
  getSessionPid: (id) => {
    const { pid } = getSessionStatus(id);
    return pid || null;
  },
}));

const url = `http://127.0.0.1:${PORT}`;

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Copilot Runway running at ${url}\n`);

  // Auto-open in the user's default browser
  const openCmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(openCmd, () => {}); // fire-and-forget
});
