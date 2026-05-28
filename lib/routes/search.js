// Conversation content search endpoint (issue #9).
//
// Backed by the FTS5 `search_index` virtual table populated by the
// Copilot CLI. Scoped to `source_type = 'turn'` for the MVP; checkpoint
// surfaces are a follow-up.
//
// Behaviour:
//   - GET /api/sessions/search?q=...&limit=...
//     200 with results + per-session projection that matches the list
//     route's card shape, so the client can render identical cards with
//     an inline highlighted snippet underneath.
//     400 on empty / oversized q, or invalid limit.
//     503 with { code: 'fts_unavailable' } when search_index is absent.
//     503 with { code: 'fts_timeout' } when the underlying query exceeds
//          the timing guard.
//   - GET /api/sessions/search/status
//     Lightweight probe used by the client at boot to decide whether to
//     show the "Search conversation content" toggle.

const express = require('express');

const { openSessionStoreDb } = require('../store/db');
const { hasSearchIndex, searchTurns } = require('../store/search');
const { readWorkspaceYaml, getSessionStatus } = require('../store/sessions');
const { getActiveBranch } = require('../runway/branch');
const { projectKeyForCwd } = require('../runway/worktrees');
const { loadSessionAgents } = require('../runway/session-agents');

const router = express.Router();

const Q_MIN_LEN = 1;
const Q_MAX_LEN = 200;
const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 100;
const TIMING_BUDGET_MS = 750;

// Lightweight feature probe. The client uses this at boot to decide
// whether to show the "Search conversation content" toggle.
router.get('/search/status', (req, res) => {
  let db;
  try {
    db = openSessionStoreDb();
    const available = hasSearchIndex(db);
    res.json({ available });
  } catch {
    res.json({ available: false });
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
});

// Main content-search endpoint. Mounted under /api/sessions/search.
router.get('/search', (req, res) => {
  const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (rawQ.length < Q_MIN_LEN) {
    return res.status(400).json({ error: 'query required', code: 'q_required' });
  }
  if (rawQ.length > Q_MAX_LEN) {
    return res.status(400).json({ error: 'query too long', code: 'q_too_long' });
  }

  const rawLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, LIMIT_MAX)
    : LIMIT_DEFAULT;

  let db;
  const startedAt = process.hrtime.bigint();
  try {
    db = openSessionStoreDb();

    if (!hasSearchIndex(db)) {
      console.log(`[runway] search unavailable: search_index missing`);
      return res.status(503).json({ error: 'search index unavailable', code: 'fts_unavailable' });
    }

    const rows = searchTurns(db, rawQ, limit);

    // Dedupe by session_id keeping the best-ranked snippet (rows are
    // already ordered by bm25 ascending so the first sighting wins).
    const bySession = new Map();
    for (const row of rows) {
      if (!bySession.has(row.session_id)) {
        bySession.set(row.session_id, row);
      }
    }
    const sessionIds = [...bySession.keys()];

    // Project the matching sessions through the same shape the
    // list route emits so the client can render identical cards.
    let projected = [];
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => '?').join(',');
      const sessionRows = db.prepare(`
        SELECT s.id, s.cwd, s.repository, s.branch, s.summary,
               s.created_at, s.updated_at, s.host_type,
               (SELECT COUNT(*) FROM turns WHERE session_id = s.id) AS turn_count,
               (SELECT COUNT(*) FROM session_refs WHERE session_id = s.id) AS ref_count
          FROM sessions s
         WHERE s.id IN (${placeholders})
      `).all(...sessionIds);

      const refsStmt = db.prepare(`
        SELECT ref_type, ref_value FROM session_refs
         WHERE session_id = ? AND ref_type IN ('pr', 'issue')
         ORDER BY created_at DESC
      `);

      const agentsBySession = loadSessionAgents();

      // Index session rows for O(1) lookup so we can iterate in match
      // (bm25) order rather than SQL natural order.
      const sessionRowById = new Map(sessionRows.map(s => [s.id, s]));

      projected = sessionIds
        .map(id => {
          const s = sessionRowById.get(id);
          if (!s) return null;
          const status = getSessionStatus(s.id);
          const workspace = readWorkspaceYaml(s.id);
          const effectiveCwd = (workspace && workspace.cwd) || s.cwd;
          const liveBranch = status.status === 'active' ? getActiveBranch(effectiveCwd) : null;
          const { ref_count, ...rest } = s;
          const refs = refsStmt.all(s.id);
          const match = bySession.get(id);
          return {
            ...rest,
            ...status,
            name: (workspace && workspace.name) || s.summary || s.id.substring(0, 8),
            branch: liveBranch || (workspace && workspace.branch) || s.branch,
            cwd: effectiveCwd,
            project_key: projectKeyForCwd(effectiveCwd),
            has_refs: ref_count > 0,
            agent: agentsBySession[s.id] || null,
            refs,
            matched_field: 'content',
            snippet: match.snippet,
          };
        })
        .filter(Boolean);
    }

    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (elapsedMs > TIMING_BUDGET_MS) {
      console.log(
        `[runway] search slow: ${elapsedMs.toFixed(0)}ms q.length=${rawQ.length} limit=${limit} results=${projected.length}`,
      );
      return res.status(503).json({ error: 'search timed out', code: 'fts_timeout' });
    }

    console.log(
      `[runway] search ok: ${elapsedMs.toFixed(0)}ms q.length=${rawQ.length} limit=${limit} results=${projected.length}`,
    );

    res.json({
      query_length: rawQ.length,
      limit,
      next_cursor: null,
      results: projected,
    });
  } catch (err) {
    console.log(`[runway] search error: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    if (db) {
      try { db.close(); } catch {}
    }
  }
});

module.exports = router;
