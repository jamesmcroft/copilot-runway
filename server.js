const express = require('express');
const path = require('path');
const { exec } = require('child_process');

// Trigger ~/.runway directory creation as a side effect of importing paths
require('./lib/paths');

const projectsRouter = require('./lib/routes/projects');
const sessionsRouter = require('./lib/routes/sessions');
const sendRouter = require('./lib/routes/send');
const agentsRouter = require('./lib/routes/agents');
const statsRouter = require('./lib/routes/stats');

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

// API routes
app.use('/api/projects', projectsRouter);
app.use('/api/sessions', sendRouter);
app.use('/api/sessions', sessionsRouter);
app.use('/api/agents', agentsRouter);
app.use('/api/stats', statsRouter);

const url = `http://127.0.0.1:${PORT}`;

app.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Copilot Runway running at ${url}\n`);

  // Auto-open in the user's default browser
  const openCmd = process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(openCmd, () => {}); // fire-and-forget
});
