// FTS5-backed conversation content search.
//
// The session-store.db ships a `search_index` virtual table populated by
// the Copilot CLI. We scope queries to `source_type = 'turn'` so the
// dashboard surfaces conversation content only (checkpoint surfaces are
// a follow-up). The schema is owned by the CLI; we never create or
// migrate the FTS index from this app.

const crypto = require('crypto');

// Detect whether the session store carries the FTS5 `search_index`
// virtual table. Older session stores predate the feature; in that case
// the search endpoint returns 503 and the UI hides the toggle.
function hasSearchIndex(db) {
  try {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='search_index'")
      .get();
    return !!(row && row.ok);
  } catch {
    return false;
  }
}

// Wrap user input as an FTS5 phrase so operators like NEAR(), column
// filters, `*`, and `^` are neutralized. Inside a phrase FTS5 treats
// punctuation as tokenizer separators, so `"^hello"` matches the token
// "hello". Internal double quotes are doubled per the FTS5 phrase
// escape rule.
function escapeFtsPhrase(q) {
  return '"' + String(q).replace(/"/g, '""') + '"';
}

// Minimal HTML escape for snippet content. The snippet body is the only
// place we inject server-sourced strings via innerHTML on the client, so
// this is the load-bearing XSS guard.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Build per-request open/close sentinels that cannot appear in user
// content. The CLI never writes \u0001 into turn text, and the UUID
// suffix randomizes the token so even a maliciously crafted message
// containing the literal string `<mark>` cannot pre-seed the snippet
// with attacker-controlled markup.
function buildMarkSentinels() {
  const id = crypto.randomUUID();
  return {
    open: `\u0001RUNWAY_MARK_OPEN_${id}\u0001`,
    close: `\u0001RUNWAY_MARK_CLOSE_${id}\u0001`,
  };
}

// Render a snippet body as safe HTML: escape everything, then swap the
// sentinel tokens for real <mark> wrappers. The sentinels do not contain
// any HTML metacharacters so the escape pass does not mangle them.
function renderSnippetHtml(raw, sentinels) {
  const escaped = escapeHtml(raw);
  return escaped
    .split(sentinels.open).join('<mark>')
    .split(sentinels.close).join('</mark>');
}

// Run an FTS5 match against turn content and return ranked rows with
// rendered (already HTML-safe) snippets. Caller is responsible for
// downstream dedupe and projection.
function searchTurns(db, q, limit) {
  const sentinels = buildMarkSentinels();
  const phrase = escapeFtsPhrase(q);
  const rows = db.prepare(`
    SELECT session_id,
           snippet(search_index, 0, ?, ?, '\u2026', 12) AS snippet_raw,
           bm25(search_index) AS rank
      FROM search_index
     WHERE search_index MATCH ?
       AND source_type = 'turn'
  ORDER BY rank
     LIMIT ?
  `).all(sentinels.open, sentinels.close, phrase, limit);
  return rows.map(r => ({
    session_id: r.session_id,
    snippet: renderSnippetHtml(r.snippet_raw, sentinels),
    rank: r.rank,
  }));
}

module.exports = {
  hasSearchIndex,
  escapeFtsPhrase,
  escapeHtml,
  renderSnippetHtml,
  buildMarkSentinels,
  searchTurns,
};
