const express = require('express');

const { openSessionStoreDb } = require('../store/db');
const { readWorkspaceYaml, getSessionStatus } = require('../store/sessions');
const { getSessionAgent, loadSessionAgents } = require('../runway/session-agents');
const { projectKeyForCwd } = require('../runway/worktrees');
const { getActiveBranch } = require('../runway/branch');

const router = express.Router();

// Single-line preview length for last_assistant_preview. Server-side trim
// keeps payloads small; client renders raw (CSS handles overflow guard).
const PREVIEW_MAX = 120;

function buildPreview(raw) {
  if (raw == null) return null;
  // Collapse all whitespace (CRLF/LF/tabs/runs of spaces) into single
  // spaces so the card stays a single readable line.
  const collapsed = String(raw).replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length <= PREVIEW_MAX) return collapsed;
  return collapsed.slice(0, PREVIEW_MAX) + '\u2026';
}

// GET /api/sessions - list sessions, optionally filtered
router.get('/', (req, res) => {
  try {
    const db = openSessionStoreDb();
    const { cwd, limit = 50, offset = 0, active_only } = req.query;

    let query = `SELECT s.id, s.cwd, s.repository, s.branch, s.summary, s.created_at, s.updated_at, s.host_type,
       (SELECT COUNT(*) FROM turns WHERE session_id = s.id) AS turn_count,
       (SELECT COUNT(*) FROM session_refs WHERE session_id = s.id) AS ref_count,
       (SELECT assistant_response FROM turns WHERE session_id = s.id ORDER BY turn_index DESC LIMIT 1) AS last_assistant_response
FROM sessions s`;
    const params = [];

    if (cwd) {
      query += ` WHERE s.cwd LIKE ?`;
      params.push(cwd + '%');
    }

    query += ` ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const sessions = db.prepare(query).all(...params);

    // Per-session refs lookup. Filtered to pr/issue (the only kinds the
    // card renders); commit refs would clutter the sidebar. No cap here:
    // the client renders the first 3 and shows a truthful "+N more" pill
    // for the remainder, which only works if we send the full list.
    const refsStmt = db.prepare(`
      SELECT ref_type, ref_value FROM session_refs
      WHERE session_id = ? AND ref_type IN ('pr', 'issue')
      ORDER BY created_at DESC
    `);

    // Load the session-agents map once per request. getSessionAgent
    // reads and parses the JSON file on every call, which would be N
    // file reads per list response without this hoist.
    const agentsBySession = loadSessionAgents();

    // Enrich with live status and workspace metadata
    const enriched = sessions.map(s => {
      const status = getSessionStatus(s.id);
      const workspace = readWorkspaceYaml(s.id);
      const { ref_count, last_assistant_response, ...rest } = s;
      const effectiveCwd = workspace?.cwd || s.cwd;
      const refs = refsStmt.all(s.id);
      // workspace.yaml only captures the branch at session start. For an
      // active session we look up the live branch via git so a mid-session
      // checkout is reflected in the UI; inactive/stale/unknown sessions
      // skip the spawn and keep the recorded value.
      const liveBranch = status.status === 'active' ? getActiveBranch(effectiveCwd) : null;
      return {
        ...rest,
        ...status,
        name: workspace?.name || s.summary || s.id.substring(0, 8),
        branch: liveBranch || workspace?.branch || s.branch,
        cwd: effectiveCwd,
        project_key: projectKeyForCwd(effectiveCwd),
        has_refs: ref_count > 0,
        turn_count: s.turn_count,
        agent: agentsBySession[s.id] || null,
        last_assistant_preview: buildPreview(last_assistant_response),
        refs,
      };
    });

    db.close();

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
router.get('/active', (req, res) => {
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
        const effectiveCwd = workspace?.cwd || s.cwd;
        // Active by construction here, so always attempt the live lookup.
        const liveBranch = getActiveBranch(effectiveCwd);
        return {
          ...s,
          ...status,
          name: workspace?.name || s.summary || s.id.substring(0, 8),
          branch: liveBranch || workspace?.branch || s.branch,
          cwd: effectiveCwd,
          project_key: projectKeyForCwd(effectiveCwd),
        };
      })
      .filter(Boolean);

    res.json(active);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Default page size for the chronology endpoint. Capped server-side so a
// client cannot ask for an unbounded payload on a multi-thousand-turn
// session.
const CHRONOLOGY_DEFAULT_LIMIT = 50;
const CHRONOLOGY_MAX_LIMIT = 200;

// Build the merged chronology for one page of turns.
//
// Strategy (per docs/adr or issue #35):
//   - Forward cursor pagination by `turn_index > cursor`. The planner
//     chose this over offset so a live session adding turns mid-page
//     does not shift earlier rows.
//   - Fetch limit+1 turns to cheaply detect `has_more`.
//   - Fetch file rows whose turn_index lies inside this page's window
//     [cursor+1 .. lastTurnIndex]. Files attributed to an earlier page
//     stay with that page; files in the future stay with theirs.
//   - On the final page (has_more=false) also include file rows with
//     NULL turn_index, appended at the end as an "unattributed" tail.
//     Older sessions can have these where the file event was recorded
//     before the producing turn landed in the store.
//   - Merge in JS: for each turn, append any file rows with
//     turn_index <= turn.turn_index that have not been emitted yet.
//     File rows whose turn_index has no matching turn in this page
//     (orphan / file recorded before turn row) still appear at their
//     chronological position.
function buildChronologyPage(db, sessionId, cursor, limit) {
  const effectiveCursor = (cursor == null || Number.isNaN(cursor)) ? -1 : cursor;

  const turnsBatch = db.prepare(`
    SELECT turn_index, user_message, assistant_response, timestamp
    FROM turns
    WHERE session_id = ? AND turn_index > ?
    ORDER BY turn_index ASC
    LIMIT ?
  `).all(sessionId, effectiveCursor, limit + 1);

  const hasMore = turnsBatch.length > limit;
  const turns = hasMore ? turnsBatch.slice(0, limit) : turnsBatch;
  const lastTurnIndex = turns.length > 0
    ? turns[turns.length - 1].turn_index
    : effectiveCursor;

  let fileRows;
  if (hasMore) {
    fileRows = db.prepare(`
      SELECT file_path, tool_name, turn_index, first_seen_at
      FROM session_files
      WHERE session_id = ? AND turn_index > ? AND turn_index <= ?
      ORDER BY turn_index ASC, first_seen_at ASC, file_path ASC
    `).all(sessionId, effectiveCursor, lastTurnIndex);
  } else {
    // Final page: also collect files with NULL turn_index. The ORDER BY
    // pushes those to the end of the array so the merge loop appends
    // them after all attributed rows.
    fileRows = db.prepare(`
      SELECT file_path, tool_name, turn_index, first_seen_at
      FROM session_files
      WHERE session_id = ? AND (turn_index > ? OR turn_index IS NULL)
      ORDER BY
        CASE WHEN turn_index IS NULL THEN 1 ELSE 0 END ASC,
        turn_index ASC,
        first_seen_at ASC,
        file_path ASC
    `).all(sessionId, effectiveCursor);
  }

  const chronology = [];
  let fi = 0;
  for (const t of turns) {
    chronology.push({
      kind: 'turn',
      turn_index: t.turn_index,
      user_message: t.user_message,
      assistant_response: t.assistant_response,
      timestamp: t.timestamp,
    });
    while (
      fi < fileRows.length
      && fileRows[fi].turn_index != null
      && fileRows[fi].turn_index <= t.turn_index
    ) {
      chronology.push({ kind: 'file', ...fileRows[fi] });
      fi++;
    }
  }
  // Tail: orphan attributed files past the last returned turn (rare; can
  // happen if file rows reference a turn_index that has not landed yet)
  // plus, on the final page, the NULL-turn_index group.
  while (fi < fileRows.length) {
    chronology.push({ kind: 'file', ...fileRows[fi] });
    fi++;
  }

  return {
    chronology,
    has_more: hasMore,
    next_cursor: hasMore ? lastTurnIndex : null,
  };
}

// GET /api/sessions/:id - get session detail with chronology page
//
// Query params:
//   cursor (optional) - integer turn_index; returns turns with index > cursor.
//   limit  (optional) - page size, default 50, capped at 200.
//
// The chronology endpoint is the sole conversation feed. The previously
// returned `turns` and `files` arrays were unbounded SELECTs over the
// entire session history; for a long Copilot CLI session those would
// block the Node event loop for tens of seconds and queue every later
// request behind them (issue #49). They have been removed in favor of
// the cursor-paged chronology, which is bounded by CHRONOLOGY_MAX_LIMIT.
// `checkpoints` is kept because the table is small per session and the
// renderer still consumes it.
router.get('/:id', (req, res) => {
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

    const rawLimit = parseInt(req.query.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, CHRONOLOGY_MAX_LIMIT)
      : CHRONOLOGY_DEFAULT_LIMIT;
    const rawCursor = req.query.cursor != null ? parseInt(req.query.cursor) : null;
    const cursor = Number.isFinite(rawCursor) ? rawCursor : null;

    const page = buildChronologyPage(db, req.params.id, cursor, limit);

    const checkpoints = db.prepare(`
      SELECT checkpoint_number, title, overview, created_at
      FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number
    `).all(req.params.id);

    db.close();

    const status = getSessionStatus(session.id);
    const workspace = readWorkspaceYaml(session.id);
    const effectiveCwd = workspace?.cwd || session.cwd;
    const liveBranch = status.status === 'active' ? getActiveBranch(effectiveCwd) : null;

    res.json({
      ...session,
      ...status,
      name: workspace?.name || session.summary || session.id.substring(0, 8),
      branch: liveBranch || workspace?.branch || session.branch,
      cwd: effectiveCwd,
      agent: getSessionAgent(session.id),
      chronology: page.chronology,
      has_more: page.has_more,
      next_cursor: page.next_cursor,
      checkpoints,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
