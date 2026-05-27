const express = require('express');
const path = require('path');
const fs = require('fs');

const { openSessionStoreDb, openDataDb } = require('../store/db');
const { loadCustomProjects, saveCustomProjects } = require('../runway/projects');

const router = express.Router();

// GET /api/projects - list projects from data.db + custom
router.get('/', (req, res) => {
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
router.post('/add', (req, res) => {
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

module.exports = router;
