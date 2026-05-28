const express = require('express');
const path = require('path');
const fs = require('fs');

const { openSessionStoreDb, openDataDb } = require('../store/db');
const { loadCustomProjects, saveCustomProjects } = require('../runway/projects');
const { projectKeyForCwd } = require('../runway/worktrees');
const { isPathWithinProject } = require('../../public/path-match');
const purge = require('../runway/project-purge');
const worktreeManager = require('../runway/worktree-manager');
const bindings = require('../runway/worktree-bindings');

// Validate a URL-decoded project key. Express decodes :projectKey for
// us, so we receive the literal absolute path. Reject anything that
// is not a non-empty absolute path string, contains a NUL, or runs
// longer than a generous filesystem path cap.
function validateProjectKey(key) {
  if (typeof key !== 'string' || key.length === 0) return false;
  if (key.length > 4096) return false;
  if (key.indexOf('\0') !== -1) return false;
  if (!path.isAbsolute(key)) return false;
  return true;
}

// Best-effort: list session ids whose cwd lives within the given
// project. Used by the pins / session-agents sweep. Tolerates a
// missing session-store DB (fresh install, test environment) by
// returning an empty list.
function listSessionIdsForProject(projectKey) {
  let rows = [];
  try {
    const db = openSessionStoreDb();
    rows = db.prepare('SELECT id, cwd FROM sessions').all();
    db.close();
  } catch {
    return [];
  }
  const ids = [];
  for (const r of rows) {
    if (!r || !r.cwd) continue;
    if (isPathWithinProject(r.cwd, projectKey)) ids.push(r.id);
  }
  return ids;
}

// Build a router with the active-session detector injected. The
// detector returns the list of active session ids attached to the
// project, used for the 409 active-sessions guard. Defaults to a noop
// so tests that do not exercise the guard can omit it.
function buildRouter({ getActiveSessionsForProject } = {}) {
  const router = express.Router();
  const detector = typeof getActiveSessionsForProject === 'function'
    ? getActiveSessionsForProject
    : () => [];
  registerRoutes(router, detector);
  return router;
}

function registerRoutes(router, getActiveSessionsForProject) {

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
      const allProjects = [...dbProjects, ...custom].map(p => ({
        ...p,
        project_key: projectKeyForCwd(p.main_repo_path),
      }));

      const sessionDb = openSessionStoreDb();
      const cwdRows = sessionDb.prepare(
        `SELECT cwd, MAX(updated_at) as latest FROM sessions GROUP BY cwd`
      ).all();
      sessionDb.close();

      function projectLatest(project) {
        const repoPath = project.main_repo_path;
        if (!repoPath) return '';
        let best = '';
        for (const r of cwdRows) {
          if (!r.cwd) continue;
          let match = false;
          if (project.project_key) {
            const rowKey = projectKeyForCwd(r.cwd);
            if (rowKey && rowKey === project.project_key) match = true;
          }
          if (!match && isPathWithinProject(r.cwd, repoPath)) match = true;
          if (match && r.latest > best) best = r.latest;
        }
        return best;
      }

      allProjects.sort((a, b) => {
        const tA = projectLatest(a) || a.last_opened_at || '';
        const tB = projectLatest(b) || b.last_opened_at || '';
        return tB.localeCompare(tA);
      });
      res.json(allProjects);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/projects/add - add a custom project folder
  router.post('/add', (req, res) => {
    const { folderPath, name } = req.body || {};
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

  // GET /api/projects/:projectKey/summary
  // Counts of Runway-owned state for the project. Drives the
  // confirmation modal summary line ("3 pins, 2 setting overrides, 4
  // worktree directories"). Unknown project keys return zero counts
  // for every store; the route stays 200 so the modal can render a
  // clean "nothing to remove" state.
  router.get('/:projectKey/summary', (req, res) => {
    const key = req.params.projectKey;
    if (!validateProjectKey(key)) {
      return res.status(400).json({ error: 'invalid_project_key' });
    }
    try {
      const counts = purge.summarizeProject(key, {
        getSessionIdsForProject: listSessionIdsForProject,
      });
      const active = getActiveSessionsForProject(key) || [];
      return res.json({ projectKey: key, counts, activeSessionIds: active });
    } catch (err) {
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  });

  // DELETE /api/projects/:projectKey?removeWorktrees=true|false
  //
  // Hard-purge the project from every Runway-owned state file.
  //   * 400 on malformed key
  //   * 409 when any active Copilot CLI session is attached; no state
  //         is mutated on a 409
  //   * 404 on unknown project key (including idempotent re-delete)
  //   * 204 on successful purge
  router.delete('/:projectKey', (req, res) => {
    const key = req.params.projectKey;
    if (!validateProjectKey(key)) {
      return res.status(400).json({ error: 'invalid_project_key' });
    }

    const removeWorktrees = String(req.query.removeWorktrees || '').toLowerCase() !== 'false';

    // 1) Discover blockers BEFORE any mutation so an active session
    //    cannot trigger a partial purge.
    let activeSessionIds = [];
    try {
      const ids = getActiveSessionsForProject(key) || [];
      activeSessionIds = Array.isArray(ids) ? ids.filter(x => typeof x === 'string') : [];
    } catch (err) {
      console.warn(`[runway] project delete: active-session detector failed: ${err.message}`);
      activeSessionIds = [];
    }
    if (activeSessionIds.length > 0) {
      return res.status(409).json({
        error: 'active_sessions',
        sessionIds: activeSessionIds,
      });
    }

    const ctx = { getSessionIdsForProject: listSessionIdsForProject };

    // 2) Idempotent re-delete: if nothing in any store matches this
    //    key, return 404 without writing a thing.
    if (!purge.hasAnyState(key, ctx)) {
      return res.status(404).json({ error: 'not_found' });
    }

    // 3) On-disk worktrees come first when the user opted in. The
    //    worktree manager needs the binding's projectKey to locate
    //    the source repo for `git worktree remove`, so we have to run
    //    the manager BEFORE the binding rows get swept. The manager
    //    also clears the binding entry on success, leaving the sweep
    //    with a no-op for the bindings store. When the user opted
    //    out (?removeWorktrees=false), we skip this step and let the
    //    sweep clear the binding rows while the on-disk directories
    //    survive for manual recovery.
    let worktreeDirsRemoved = 0;
    const matchingBindings = bindings.list().filter(b => purge.sameKey(b.projectKey, key));
    if (removeWorktrees) {
      for (const b of matchingBindings) {
        try {
          // Force removal: the project is being purged so we are
          // explicitly opting in to drop any uncommitted changes.
          const r = worktreeManager.remove({
            worktreePath: b.worktreePath,
            force: true,
            deleteBranch: false,
          });
          if (r && r.removed) worktreeDirsRemoved += 1;
        } catch (err) {
          console.warn(
            `[runway] project delete: worktree-manager.remove(${b.worktreePath}) failed: ${err.message}`
          );
        }
      }
    }

    // 4) Run the sweep across every registered store. Stores that
    //    were already cleared (for example worktree bindings after
    //    the manager call above) report removed: 0 cleanly.
    const result = purge.purgeProject(key, ctx);
    result.worktreeDirsRemoved = { removed: worktreeDirsRemoved, attempted: removeWorktrees };

    // 204 carries no body. The summary endpoint can be polled if a
    // client wants the exact post-removal counts.
    return res.status(204).end();
  });
}

// Default export: a router using the real active-session detector
// (lock-file scan + PID liveness). Server.js mounts this by default;
// tests and any caller that needs a stubbed detector should use
// buildRouter(opts) instead.
const { getSessionStatus } = require('../store/sessions');

function defaultGetActiveSessionsForProject(projectKey) {
  const ids = listSessionIdsForProject(projectKey);
  // Also include sessions bound through worktrees for the project,
  // since a binding directly attaches a session to the project key.
  let bindings;
  try { bindings = require('../runway/worktree-bindings').list(); } catch { bindings = []; }
  for (const b of bindings) {
    if (b && b.projectKey && b.sessionId && purge.sameKey(b.projectKey, projectKey)) {
      if (!ids.includes(b.sessionId)) ids.push(b.sessionId);
    }
  }
  const active = [];
  for (const id of ids) {
    try {
      const { status } = getSessionStatus(id);
      if (status === 'active') active.push(id);
    } catch {}
  }
  return active;
}

const defaultRouter = buildRouter({
  getActiveSessionsForProject: defaultGetActiveSessionsForProject,
});

module.exports = defaultRouter;
module.exports.buildRouter = buildRouter;
module.exports.validateProjectKey = validateProjectKey;
module.exports.listSessionIdsForProject = listSessionIdsForProject;
