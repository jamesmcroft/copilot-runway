// REST endpoints for the per-session git worktree feature (issue #44).
//
//   GET    /api/sessions/:id/worktree
//   POST   /api/sessions/:id/worktree
//   DELETE /api/sessions/:id/worktree
//   GET    /api/projects/:projectKey/worktrees
//
// Opt-in only: GET returns { bound: false } for sessions with no
// worktree, and POST is the only way to create one. Concurrency rejects
// a second bind to the same path with HTTP 409 plus the bound session id
// so the UI can offer a "Focus the bound session" CTA without a second
// round trip.

const express = require('express');
const manager = require('../runway/worktree-manager');
const bindings = require('../runway/worktree-bindings');

// Factory: the resolver lets tests stub session lookup without touching
// the SQLite store. In production, server.js wires it to the same DB
// reader used by /api/sessions.
function createWorktreesRouter({ getSession } = {}) {
  if (typeof getSession !== 'function') {
    throw new Error('[runway] createWorktreesRouter requires a getSession function');
  }

  const router = express.Router();

  // GET /api/sessions/:id/worktree
  router.get('/sessions/:id/worktree', (req, res) => {
    try {
      const binding = bindings.getBySessionId(req.params.id);
      if (!binding) {
        return res.json({ bound: false });
      }
      return res.json({
        bound: true,
        worktreePath: binding.worktreePath,
        branchName: binding.branchName,
        projectKey: binding.projectKey,
        createdAt: binding.createdAt,
        dirty: manager.isDirty({ worktreePath: binding.worktreePath }),
        canDeleteBranch: manager.canDeleteBranch({
          branchName: binding.branchName,
          projectPath: binding.projectKey,
        }),
      });
    } catch (err) {
      console.error(`[runway] worktree GET failed: ${err.message}`);
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  });

  // POST /api/sessions/:id/worktree
  router.post('/sessions/:id/worktree', (req, res) => {
    try {
      const id = req.params.id;
      // If the session is already bound, return the current binding as
      // 200 rather than creating a duplicate. The client treats both 200
      // and 201 as "you have a worktree now".
      const existing = bindings.getBySessionId(id);
      if (existing) {
        return res.status(200).json({
          worktreePath: existing.worktreePath,
          branchName: existing.branchName,
          alreadyBound: true,
        });
      }
      const session = getSession(id);
      if (!session || !session.cwd) {
        return res.status(404).json({ error: 'session-not-found' });
      }
      const result = manager.create({ sessionId: id, projectPath: session.cwd });
      return res.status(201).json({
        worktreePath: result.worktreePath,
        branchName: result.branchName,
      });
    } catch (err) {
      if (err instanceof manager.WorktreeAlreadyBoundError) {
        return res.status(409).json({
          error: 'already-bound',
          message: err.message,
          boundSessionId: err.sessionId,
        });
      }
      if (err && err.code === 'BRANCH_EXISTS') {
        return res.status(409).json({ error: 'branch-exists', message: err.message });
      }
      if (err && err.code === 'INVALID_PROJECT') {
        return res.status(400).json({ error: 'invalid-project', message: err.message });
      }
      console.error(`[runway] worktree POST failed: ${err.message}`);
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  });

  // DELETE /api/sessions/:id/worktree
  router.delete('/sessions/:id/worktree', (req, res) => {
    try {
      const binding = bindings.getBySessionId(req.params.id);
      if (!binding) {
        return res.status(404).json({ error: 'not-bound' });
      }
      const body = req.body || {};
      const result = manager.remove({
        worktreePath: binding.worktreePath,
        force: !!body.force,
        deleteBranch: !!body.deleteBranch,
      });
      return res.json({
        removed: result.removed,
        branchDeleted: result.branchDeleted,
      });
    } catch (err) {
      if (err && err.code === 'DIRTY') {
        return res.status(409).json({ error: 'dirty', message: err.message });
      }
      console.error(`[runway] worktree DELETE failed: ${err.message}`);
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  });

  // GET /api/projects/:projectKey/worktrees
  // projectKey is URL encoded by the client (mirrors the per-project
  // settings route convention).
  router.get('/projects/:projectKey/worktrees', (req, res) => {
    try {
      const items = manager.list({ projectPath: req.params.projectKey });
      return res.json(items);
    } catch (err) {
      console.error(`[runway] worktree list failed: ${err.message}`);
      return res.status(500).json({ error: 'internal', message: err.message });
    }
  });

  return router;
}

module.exports = { createWorktreesRouter };
