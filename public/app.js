// Theme management
const THEME_KEY = 'copilot-dashboard-theme';

function getThemePreference() {
  return localStorage.getItem(THEME_KEY) || 'system';
}

function resolveTheme(pref) {
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return pref;
}

function applyTheme(pref) {
  const resolved = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', resolved);

  // Update switcher button states
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === pref);
  });
}

function setTheme(pref) {
  localStorage.setItem(THEME_KEY, pref);
  applyTheme(pref);
}

// Listen for system theme changes when "system" is selected
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (getThemePreference() === 'system') {
    applyTheme('system');
  }
});

// Apply saved theme on load
applyTheme(getThemePreference());

// Palette bootstrap (issue #53). Read the user's stored palette and
// inject the palette stylesheet on demand. RunwayPalettes is a UMD
// module loaded via palettes.js in index.html; it is safe to skip when
// the module is absent (defensive against script-order changes).
if (typeof RunwayPalettes !== 'undefined') {
  try {
    const storedPalette = RunwayPalettes.readStoredPalette();
    RunwayPalettes.applyPalette(storedPalette);
  } catch {}
}

// Ctrl+, / Cmd+, opens the settings page. Standard shortcut on macOS
// and an emerging convention on other platforms. We avoid hijacking the
// shortcut while the user is composing text in an input element other
// than the chat textarea so plain typing keeps working.
window.addEventListener('keydown', (e) => {
  const isAccel = e.metaKey || e.ctrlKey;
  if (isAccel && e.key === ',') {
    e.preventDefault();
    window.location.href = '/settings';
  }
});

// Markdown setup
marked.setOptions({ breaks: true, gfm: true });

// Syntax highlighting for fenced code blocks. Prism is loaded eagerly
// in index.html (core + the language list documented in the README).
// Unknown languages and blocks larger than 100k chars fall through to
// HTML-escaped plaintext, so the renderer is safe even with no Prism
// available.
if (typeof MarkdownHighlight !== 'undefined') {
  MarkdownHighlight.attachMarkedHighlighter(marked);
}

// Detail panel resize
const DETAIL_WIDTH_KEY = 'copilot-dashboard-detail-width';
let detailWidth = parseInt(localStorage.getItem(DETAIL_WIDTH_KEY)) || 480;
let detailCollapsed = false;
let savedDetailWidth = detailWidth;

function applyDetailWidth() {
  const app = document.querySelector('.app');
  const panel = document.getElementById('detail-panel');
  if (detailCollapsed) {
    app.style.gridTemplateColumns = '280px 1fr 6px';
    panel.classList.add('collapsed');
  } else {
    app.style.gridTemplateColumns = `280px 1fr ${detailWidth}px`;
    panel.classList.remove('collapsed');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyDetailWidth();

  const handle = document.getElementById('resize-handle');
  if (!handle) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const newWidth = window.innerWidth - e.clientX;
      detailWidth = Math.max(240, Math.min(900, newWidth));
      detailCollapsed = false;
      applyDetailWidth();
    }

    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      localStorage.setItem(DETAIL_WIDTH_KEY, detailWidth);
      savedDetailWidth = detailWidth;
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  handle.addEventListener('dblclick', () => {
    detailCollapsed = !detailCollapsed;
    if (!detailCollapsed) {
      detailWidth = savedDetailWidth || 480;
    }
    applyDetailWidth();
  });
});

// State
const FILTER_DEFAULTS = {
  search: '',
  project: null,
  status: 'all',
  hasRef: false,
  contentSearch: false,
};
const SORT_DEFAULT = 'updated';

const appState = {
  filters: { ...FILTER_DEFAULTS },
  sort: SORT_DEFAULT,
  sessions: [],
  selectedSessionId: null,
};

let projects = [];
let isStreaming = false;
// Server-driven set of pinned session ids. Populated on boot from
// /api/pins and kept in sync as the user toggles pins. Using a Set so
// pin/unpin and membership checks stay O(1) during re-renders triggered
// by SSE events.
let pinnedSessionIds = new Set();
// Session ids with a pin/unpin request currently in flight. Used to
// reject rapid repeat clicks so two simultaneous requests can not race
// and leave the UI out of sync with the server.
const pinTogglesInFlight = new Set();

// Persistence
const STORAGE_PREFIX = 'runway:';
const STORAGE_KEYS = {
  search: STORAGE_PREFIX + 'filter:search',
  project: STORAGE_PREFIX + 'filter:project',
  status: STORAGE_PREFIX + 'filter:status',
  hasRef: STORAGE_PREFIX + 'filter:hasRef',
  contentSearch: STORAGE_PREFIX + 'filter:contentSearch',
  sort: STORAGE_PREFIX + 'sort',
};

function loadFiltersFromStorage() {
  try {
    appState.filters.search = localStorage.getItem(STORAGE_KEYS.search) ?? FILTER_DEFAULTS.search;
    const project = localStorage.getItem(STORAGE_KEYS.project);
    appState.filters.project = project && project !== 'null' ? project : FILTER_DEFAULTS.project;
    appState.filters.status = localStorage.getItem(STORAGE_KEYS.status) ?? FILTER_DEFAULTS.status;
    appState.filters.hasRef = (localStorage.getItem(STORAGE_KEYS.hasRef) ?? (FILTER_DEFAULTS.hasRef ? '1' : '0')) === '1';
    appState.filters.contentSearch = (localStorage.getItem(STORAGE_KEYS.contentSearch) ?? (FILTER_DEFAULTS.contentSearch ? '1' : '0')) === '1';
    appState.sort = localStorage.getItem(STORAGE_KEYS.sort) ?? SORT_DEFAULT;
  } catch {
    // Corrupted storage should never block boot.
    appState.filters = { ...FILTER_DEFAULTS };
    appState.sort = SORT_DEFAULT;
  }
}

function persistFilters() {
  try {
    localStorage.setItem(STORAGE_KEYS.search, appState.filters.search || '');
    if (appState.filters.project) {
      localStorage.setItem(STORAGE_KEYS.project, appState.filters.project);
    } else {
      localStorage.removeItem(STORAGE_KEYS.project);
    }
    localStorage.setItem(STORAGE_KEYS.status, appState.filters.status);
    localStorage.setItem(STORAGE_KEYS.hasRef, appState.filters.hasRef ? '1' : '0');
    localStorage.setItem(STORAGE_KEYS.contentSearch, appState.filters.contentSearch ? '1' : '0');
    localStorage.setItem(STORAGE_KEYS.sort, appState.sort);
  } catch {}
}

// Fetch helpers come from the shared UMD client (public/api-client.js) so the
// same `signal`-forwarding contract is used in both browser and tests.
const api = ApiClient.apiFetch;
const apiJson = ApiClient.apiJson;

// In-flight detail fetches share a single AbortController so a session switch
// cancels any pending work for the previously-selected session (issue #49).
// Without this, a slow `/api/sessions/:id` response can land after the user
// has moved on and overwrite the detail panel with stale content.
let inFlightDetail = null;

function abortInFlightDetail() {
  if (inFlightDetail) {
    inFlightDetail.abort();
    inFlightDetail = null;
  }
}

function ensureDetailController() {
  if (!inFlightDetail) {
    inFlightDetail = new AbortController();
  }
  return inFlightDetail;
}

function isAbortError(err) {
  return err && (err.name === 'AbortError' || err.code === 20);
}

// Conversation content search state (issue #9). The toggle is hidden
// unless the server reports the FTS5 index is available. When the toggle
// is on and the query is non-empty, `results` holds the server-returned
// hits keyed by session id (with an attached `snippet` field) and the
// renderer reads from this list instead of `appState.sessions`. A
// per-request AbortController cancels any in-flight search on every
// keystroke, mirroring the `inFlightDetail` pattern from issue #49.
const contentSearchState = {
  available: false,
  status: 'idle', // 'idle' | 'searching' | 'ready' | 'error' | 'unavailable'
  results: [],
  error: null,
  lastQuery: '',
};
let inFlightContentSearch = null;

function abortInFlightContentSearch() {
  if (inFlightContentSearch) {
    inFlightContentSearch.abort();
    inFlightContentSearch = null;
  }
}

// Init
async function init() {
  loadFiltersFromStorage();
  applyFiltersToControls();
  await Promise.all([loadStats(), loadProjects(), loadSessions(), loadAgents(), loadPins(), probeContentSearch()]);
  // Recover from a stale persisted project filter: if the saved cwd no
  // longer matches any known project, drop it so the user is not stuck
  // staring at an empty list with no obvious cause.
  if (appState.filters.project && !projects.find(p => p.main_repo_path === appState.filters.project)) {
    appState.filters.project = null;
    persistFilters();
    updateMainTitle();
    renderSessions();
  }
  // If content search is persisted-on and we already have a query, kick
  // off a server search on boot so the user sees the same view as their
  // last session.
  if (appState.filters.contentSearch && contentSearchState.available && (appState.filters.search || '').trim()) {
    runContentSearch();
  }
  startEventStream();
}

async function probeContentSearch() {
  if (!ApiClient.searchStatus) return;
  try {
    const { available } = await ApiClient.searchStatus();
    contentSearchState.available = !!available;
  } catch {
    contentSearchState.available = false;
  }
  // If the feature is unavailable, force the persisted toggle off so we
  // never run server searches against an index that does not exist.
  if (!contentSearchState.available && appState.filters.contentSearch) {
    appState.filters.contentSearch = false;
    persistFilters();
  }
  applyContentSearchControl();
}

function applyContentSearchControl() {
  const wrap = document.getElementById('session-search-content-wrap');
  const box = document.getElementById('session-search-content-toggle');
  if (!wrap || !box) return;
  if (contentSearchState.available) {
    wrap.removeAttribute('hidden');
    box.checked = !!appState.filters.contentSearch;
    box.disabled = false;
    wrap.title = '';
  } else {
    wrap.setAttribute('hidden', '');
    box.checked = false;
    box.disabled = true;
    wrap.title = 'Conversation index not available on this machine.';
  }
}

function applyFiltersToControls() {
  const searchInput = document.getElementById('session-search');
  if (searchInput) searchInput.value = appState.filters.search || '';
  const sortSelect = document.getElementById('session-sort');
  if (sortSelect) sortSelect.value = appState.sort;
  const hasRefBox = document.getElementById('filter-has-ref');
  if (hasRefBox) hasRefBox.checked = !!appState.filters.hasRef;
  const contentBox = document.getElementById('session-search-content-toggle');
  if (contentBox) contentBox.checked = !!appState.filters.contentSearch;
  document.querySelectorAll('.status-filter-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.status === appState.filters.status);
  });
  updateMainTitle();
}

function updateMainTitle() {
  const title = document.getElementById('main-title');
  if (!title) return;
  const { project, status } = appState.filters;
  const projectName = project
    ? (projects.find(p => p.main_repo_path === project)?.name ?? 'Sessions')
    : null;
  const statusLabel = status === 'active' ? 'Active'
    : status === 'inactive' ? 'Inactive'
    : status === 'stale' ? 'Stale'
    : null;
  if (projectName && statusLabel) {
    title.textContent = `${projectName} (${statusLabel})`;
  } else if (projectName) {
    title.textContent = projectName;
  } else if (statusLabel) {
    title.textContent = `${statusLabel} Sessions`;
  } else {
    title.textContent = 'All Sessions';
  }
}

// Live event stream: subscribes to /api/events for push updates and
// falls back to polling if the SSE connection fails repeatedly or the
// browser does not support EventSource.
let eventSource = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let fallbackPollTimer = null;
const FALLBACK_POLL_MS = 30000;

function startEventStream() {
  if (typeof EventSource === 'undefined') {
    startFallbackPoll();
    return;
  }

  try {
    eventSource = new EventSource('/api/events');
  } catch {
    startFallbackPoll();
    return;
  }

  eventSource.addEventListener('ready', () => {
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopFallbackPoll();
    // Re-sync after any reconnect so we don't miss events that fired while disconnected.
    loadStats();
    loadSessions();
  });

  eventSource.addEventListener('session.created', (e) => {
    handleSessionCreated(parsePayload(e));
  });
  eventSource.addEventListener('session.active', (e) => {
    handleSessionStatusChange(parsePayload(e), 'active');
  });
  eventSource.addEventListener('session.inactive', (e) => {
    handleSessionStatusChange(parsePayload(e), 'inactive');
  });
  eventSource.addEventListener('session.ended', (e) => {
    handleSessionEnded(parsePayload(e));
  });
  eventSource.addEventListener('db.activity', () => {
    handleDbActivity();
  });

  eventSource.onerror = () => {
    if (eventSource) {
      try { eventSource.close(); } catch {}
      eventSource = null;
    }
    reconnectAttempts++;
    if (reconnectAttempts >= 3) {
      startFallbackPoll();
    }
    const backoffMs = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts - 1));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      startEventStream();
    }, backoffMs);
  };
}

function parsePayload(e) {
  try { return JSON.parse(e.data); } catch { return {}; }
}

function handleSessionCreated() {
  // A new session id only becomes useful once workspace.yaml is written.
  // Re-fetch the session list to pick it up with full metadata.
  loadSessions();
  loadStats();
}

function handleSessionStatusChange({ sessionId, pid }, status) {
  if (!sessionId) return;
  const idx = appState.sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) {
    appState.sessions[idx] = {
      ...appState.sessions[idx],
      status,
      pid: status === 'active' ? (pid || null) : null,
    };
    renderSessions();
  } else if (status === 'active') {
    // Session became active that we hadn't seen yet (e.g. just created).
    loadSessions();
  }
  loadStats();
  if (appState.selectedSessionId === sessionId) {
    refreshSelectedSession();
  }
}

function handleSessionEnded({ sessionId }) {
  if (!sessionId) return;
  const before = appState.sessions.length;
  appState.sessions = appState.sessions.filter(s => s.id !== sessionId);
  if (appState.sessions.length !== before) renderSessions();
  loadStats();
}

let dbActivityCoalesce = null;
let refreshInFlight = null;
let refreshPending = false;
function handleDbActivity() {
  // Coalesce bursts of activity into one round trip.
  if (dbActivityCoalesce) return;
  dbActivityCoalesce = setTimeout(() => {
    dbActivityCoalesce = null;
    loadStats();
    if (appState.selectedSessionId) refreshSelectedSession();
  }, 500);
}

async function refreshSelectedSession() {
  if (!appState.selectedSessionId || isStreaming) return;
  // In-flight de-dup: at most one fetch in flight and one queued.
  if (refreshInFlight) {
    refreshPending = true;
    return;
  }
  const requestedSessionId = appState.selectedSessionId;
  // Reuse the shared detail controller so a session switch aborts this
  // refresh too (not just the initial selectSession fetch).
  const controller = ensureDetailController();
  refreshInFlight = (async () => {
    try {
      const detail = await apiJson(`/api/sessions/${requestedSessionId}`, { signal: controller.signal });
      // Stale-result guard: discard if the user switched sessions while we were fetching.
      if (appState.selectedSessionId !== requestedSessionId) return;
      renderDetail(detail);
    } catch (err) {
      if (isAbortError(err)) return;
      console.error('[runway] Failed to refresh session detail:', err);
    }
  })();
  try {
    await refreshInFlight;
  } finally {
    refreshInFlight = null;
    if (refreshPending) {
      refreshPending = false;
      // Kick off the next refresh to capture any activity that arrived mid-fetch.
      refreshSelectedSession();
    }
  }
}

function startFallbackPoll() {
  if (fallbackPollTimer) return;
  fallbackPollTimer = setInterval(() => {
    loadStats();
    loadSessions();
  }, FALLBACK_POLL_MS);
}

function stopFallbackPoll() {
  if (fallbackPollTimer) {
    clearInterval(fallbackPollTimer);
    fallbackPollTimer = null;
  }
}

// Stats
async function loadStats() {
  try {
    const stats = await apiJson('/api/stats');
    document.getElementById('stat-active').textContent = stats.activeSessions;
    document.getElementById('stat-recent').textContent = stats.recentSessions;
    document.getElementById('stat-total').textContent = stats.totalSessions;
  } catch {}
}

// Agents
let availableAgents = [];

async function loadAgents() {
  try {
    availableAgents = await apiJson('/api/agents');
    populateAgentSelects();
  } catch {}
}

function populateAgentSelects() {
  const selects = [
    document.getElementById('new-session-agent'),
    document.getElementById('chat-agent'),
  ];
  for (const sel of selects) {
    if (!sel) continue;
    const current = sel.value;
    sel.innerHTML = '<option value="">Default agent</option>';
    for (const agent of availableAgents) {
      const opt = document.createElement('option');
      opt.value = agent;
      opt.textContent = agent;
      sel.appendChild(opt);
    }
    sel.value = current;
  }
}

// Projects
async function loadProjects() {
  try {
    projects = await apiJson('/api/projects');
    renderProjects();
  } catch {}
}

function renderProjects() {
  const container = document.getElementById('project-list');
  container.innerHTML = projects.map((p, i) => `
    <div class="project-item ${appState.filters.project === p.main_repo_path ? 'active' : ''}" 
         data-project-index="${i}" onclick="selectProjectByIndex(${i})">
      <div class="project-name">${esc(p.name)}</div>
      <div class="project-path">${esc(shortenPath(p.main_repo_path))}</div>
    </div>
  `).join('');
  // Project names may not have been loaded when init() ran updateMainTitle.
  updateMainTitle();
}

// Sessions
async function loadSessions() {
  try {
    appState.sessions = await apiJson('/api/sessions?limit=200');
    renderSessions();
  } catch {}
}

// Pins
async function loadPins() {
  try {
    const pins = await apiJson('/api/pins');
    pinnedSessionIds = new Set(Array.isArray(pins?.sessions) ? pins.sessions : []);
  } catch {
    pinnedSessionIds = new Set();
  }
}

async function togglePin(sessionId, event) {
  // Stop the click bubbling so the session card under the button is
  // not also selected when the user just wants to pin or unpin.
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  // In-flight guard: ignore the click entirely if a request for this
  // session is already pending. Two simultaneous requests could race and
  // leave the UI showing the opposite of the server's last write.
  if (pinTogglesInFlight.has(sessionId)) return;

  const wasPinned = pinnedSessionIds.has(sessionId);
  // Optimistic UI: flip locally so the user gets immediate feedback,
  // then reconcile from the server's response (or revert on failure).
  if (wasPinned) pinnedSessionIds.delete(sessionId);
  else pinnedSessionIds.add(sessionId);
  pinTogglesInFlight.add(sessionId);
  renderSessions();
  try {
    const res = await api(`/api/pins/sessions/${encodeURIComponent(sessionId)}`, {
      method: wasPinned ? 'DELETE' : 'POST',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pins = await res.json();
    pinnedSessionIds = new Set(Array.isArray(pins?.sessions) ? pins.sessions : []);
  } catch {
    // Revert on failure so client state matches the server.
    if (wasPinned) pinnedSessionIds.add(sessionId);
    else pinnedSessionIds.delete(sessionId);
  } finally {
    pinTogglesInFlight.delete(sessionId);
    renderSessions();
  }
}

function applyFiltersAndSort(rawSessions, { skipSearch = false } = {}) {
  const { search, project, status, hasRef } = appState.filters;
  const searchLower = (search || '').trim().toLowerCase();

  let list = rawSessions.filter(s => {
    if (!skipSearch && searchLower) {
      const haystack = [s.name, s.repository, s.branch, s.summary]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(searchLower)) return false;
    }
    if (project) {
      // Match either via shared canonical repo (worktrees) when the
      // server resolved a project_key for both sides, or via the
      // segment-boundary path helper. This avoids the legacy bug where
      // raw startsWith() let "foo" capture sessions under "foo-bar"
      // (issue #32).
      const projectMeta = projects.find(p => p.main_repo_path === project);
      const projectKey = projectMeta && projectMeta.project_key;
      let matched = false;
      if (projectKey && s.project_key && projectKey === s.project_key) {
        matched = true;
      } else if (PathMatch.isPathWithinProject(s.cwd, project)) {
        matched = true;
      }
      if (!matched) return false;
    }
    if (status && status !== 'all') {
      if (s.status !== status) return false;
    }
    if (hasRef) {
      if (!s.has_refs) return false;
    }
    return true;
  });

  const sort = appState.sort;
  const ts = (v) => (v ? new Date(v).getTime() : 0);
  if (sort === 'created') {
    list.sort((a, b) => ts(b.created_at) - ts(a.created_at));
  } else if (sort === 'turns') {
    list.sort((a, b) => (b.turn_count || 0) - (a.turn_count || 0));
  } else if (sort === 'stalled') {
    const activeList = list.filter(s => s.status === 'active')
      .sort((a, b) => ts(a.updated_at) - ts(b.updated_at));
    const otherList = list.filter(s => s.status !== 'active')
      .sort((a, b) => ts(b.updated_at) - ts(a.updated_at));
    list = activeList.concat(otherList);
  } else {
    list.sort((a, b) => ts(b.updated_at) - ts(a.updated_at));
  }

  return list;
}

function describeActiveFilters() {
  const parts = [];
  const { search, project, status, hasRef } = appState.filters;
  if (search) parts.push(`search "${search}"`);
  if (project) {
    const proj = projects.find(p => p.main_repo_path === project);
    parts.push(`project "${proj ? proj.name : shortenPath(project)}"`);
  }
  if (status && status !== 'all') parts.push(`status ${status}`);
  if (hasRef) parts.push('has linked PR/issue');
  return parts.join(' + ');
}

// Cap on rendered ref badges. Anything beyond this collapses into a
// non-link "+N more" pill so the sidebar card stays compact.
const SESSION_CARD_REF_LIMIT = 3;

function renderSessionRefBadges(s) {
  const refs = Array.isArray(s.refs) ? s.refs : [];
  if (refs.length === 0) return '';
  const repo = s.repository;
  // Without a repo we have no host context to build a working link, so
  // older / terminal-started sessions just render nothing here.
  if (!repo) return '';
  const visible = refs.slice(0, SESSION_CARD_REF_LIMIT);
  const overflow = refs.length - visible.length;
  const pills = visible.map(r => {
    // GitHub redirects /issues/<n> to /pull/<n> automatically for PR
    // numbers, so a single URL shape works for both ref types.
    const url = `https://github.com/${encodeURIComponent(repo).replace(/%2F/gi, '/')}/issues/${encodeURIComponent(r.ref_value)}`;
    const label = `#${esc(String(r.ref_value))}`;
    const title = r.ref_type === 'pr' ? `Pull request #${esc(String(r.ref_value))}` : `Issue #${esc(String(r.ref_value))}`;
    return `<a class="session-badge ref" href="${url}" target="_blank" rel="noopener" title="${title}" onclick="event.stopPropagation()">${label}</a>`;
  }).join('');
  const more = overflow > 0
    ? `<span class="session-badge ref-more" title="${overflow} more linked ref${overflow === 1 ? '' : 's'}">+${overflow} more</span>`
    : '';
  return pills + more;
}

function renderSessionCard(s) {
  const pinned = pinnedSessionIds.has(s.id);
  const inFlight = pinTogglesInFlight.has(s.id);
  const pinTitle = pinned ? 'Unpin session' : 'Pin session';
  const pinClass = pinned ? 'pin-btn pinned' : 'pin-btn';
  const busyAttrs = inFlight ? ' disabled aria-busy="true"' : '';
  const agentBadge = s.agent
    ? `<span class="session-badge agent" title="Last agent">${esc(s.agent)}</span>`
    : '';
  const turnsBadge = s.turn_count
    ? `<span class="session-badge turns" title="Conversation turns">${s.turn_count} ${s.turn_count === 1 ? 'turn' : 'turns'}</span>`
    : '';
  const refBadges = renderSessionRefBadges(s);
  const cardMeta = (agentBadge || turnsBadge || refBadges)
    ? `<div class="session-card-meta">${agentBadge}${turnsBadge}${refBadges}</div>`
    : '';
  const preview = s.last_assistant_preview
    ? `<div class="session-last-msg" title="${esc(s.last_assistant_preview)}">${esc(s.last_assistant_preview)}</div>`
    : '';
  // Snippet is server-rendered: the body is HTML-escaped and only the
  // <mark> wrappers around matched tokens are real HTML. innerHTML is
  // safe here because that escape pass runs in the route.
  const snippet = s.snippet
    ? `<div class="session-content-snippet">${s.snippet}</div>`
    : '';
  return `
    <div class="session-card ${appState.selectedSessionId === s.id ? 'selected' : ''}"
         onclick="selectSession('${s.id}')">
      <div class="session-card-header">
        <div class="session-status-dot ${s.status}"></div>
        <div class="session-title">${esc(s.name || s.summary || s.id.substring(0, 8))}</div>
        <button class="${pinClass}" title="${pinTitle}" aria-label="${pinTitle}"
                aria-pressed="${pinned ? 'true' : 'false'}"${busyAttrs}
                onclick="togglePin('${s.id}', event)">&#x1F4CC;</button>
        <div class="session-time">${timeAgo(s.updated_at)}</div>
      </div>
      <div class="session-meta">
        ${s.cwd ? `<span class="session-meta-item" title="${esc(s.cwd)}">&#x1F4C1; ${esc(shortenPath(s.cwd))}</span>` : ''}
        ${s.branch ? `<span class="session-meta-item">&#x1F33F; ${esc(s.branch)}</span>` : ''}
        ${s.repository ? `<span class="session-meta-item">&#x1F4E6; ${esc(s.repository)}</span>` : ''}
      </div>
      ${snippet}
      ${preview}
      ${cardMeta}
    </div>
  `;
}

function renderSessions() {
  const container = document.getElementById('session-list');

  // Content-search path: when the toggle is on and a query is active,
  // render server FTS hits as the primary list. Status / project /
  // hasRef still compose on top so the user can narrow further.
  const usingContentSearch =
    appState.filters.contentSearch &&
    contentSearchState.available &&
    (appState.filters.search || '').trim().length > 0;

  if (usingContentSearch) {
    if (contentSearchState.status === 'searching') {
      container.innerHTML = `<div class="detail-empty">Searching conversations&#x2026;</div>`;
      return;
    }
    if (contentSearchState.status === 'error') {
      const msg = esc(contentSearchState.error || 'Search failed. Try again.');
      container.innerHTML = `<div class="detail-empty">${msg}</div>`;
      return;
    }
    // Compose: apply non-search client filters (project / status /
    // hasRef) on top of the server result set so the same toolbar still
    // works while content search is active.
    const composed = applyFiltersAndSort(contentSearchState.results, { skipSearch: true });
    if (composed.length === 0) {
      const totalHits = contentSearchState.results.length;
      const msg = totalHits > 0
        ? `No content matches with the current filters. ${totalHits} hit${totalHits === 1 ? '' : 's'} hidden by filters.`
        : 'No conversations match this query.';
      container.innerHTML = `<div class="detail-empty">${esc(msg)}</div>`;
      return;
    }
    container.innerHTML = composed.map(renderSessionCard).join('');
    return;
  }

  const visible = applyFiltersAndSort(appState.sessions);
  if (visible.length === 0) {
    const desc = describeActiveFilters();
    const msg = desc
      ? `No sessions match: ${esc(desc)}`
      : 'No sessions found';
    container.innerHTML = `<div class="detail-empty">${msg}</div>`;
    return;
  }

  // Split into pinned and unpinned groups while preserving the order
  // produced by applyFiltersAndSort within each group. Pinned sessions
  // render first under a small header so they stay visible regardless of
  // sort or recent activity.
  const pinned = [];
  const rest = [];
  for (const s of visible) {
    if (pinnedSessionIds.has(s.id)) pinned.push(s);
    else rest.push(s);
  }

  let html = '';
  if (pinned.length > 0) {
    html += `<div class="session-group-header">Pinned</div>`;
    html += pinned.map(renderSessionCard).join('');
    if (rest.length > 0) {
      html += `<div class="session-group-header">Other</div>`;
    }
  }
  html += rest.map(renderSessionCard).join('');
  container.innerHTML = html;
}

// Session detail
async function selectSession(id) {
  // Invalidate any in-flight work for the previously-selected session so a
  // late response cannot overwrite the panel after the user has moved on.
  abortInFlightDetail();

  appState.selectedSessionId = id;
  renderSessions();

  // Auto-expand detail panel if collapsed (desktop)
  const panel = document.querySelector('.detail-panel');
  if (panel && panel.classList.contains('collapsed')) {
    panel.classList.remove('collapsed');
    const saved = localStorage.getItem('copilot-dashboard-detail-width');
    const width = saved ? parseInt(saved, 10) : 480;
    document.querySelector('.app').style.gridTemplateColumns = `280px 1fr ${width}px`;
  }

  // On tablet, show detail overlay; on mobile, switch to detail tab
  if (window.innerWidth <= 1100) {
    panel.classList.add('mobile-open');
    if (window.innerWidth <= 768) {
      showMobilePanel('detail');
    }
  }

  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const agentBar = document.getElementById('agent-bar');
  chatInput.disabled = false;
  sendBtn.disabled = false;
  chatInput.placeholder = `Send a prompt to this session...`;
  if (agentBar && availableAgents.length > 0) agentBar.style.display = 'flex';

  // Synchronous loading placeholder. Without this the panel keeps showing the
  // previously-rendered session while the fetch is in flight, which looks
  // identical to the "stuck on previous session" bug we are fixing.
  const detailContainer = document.getElementById('detail-content');
  if (detailContainer && detailContainer.dataset.sessionId !== id) {
    detailContainer.dataset.sessionId = id;
    detailContainer.innerHTML = '<div class="detail-empty">Loading session...</div>';
  }

  const controller = ensureDetailController();
  try {
    const detail = await apiJson(`/api/sessions/${id}`, { signal: controller.signal });
    // Belt-and-braces guard: even when the abort fires, a response that was
    // already on its way through the microtask queue can still resolve here.
    if (id !== appState.selectedSessionId) return;
    renderDetail(detail);
    // Pre-select the last-known agent for this session
    const chatAgent = document.getElementById('chat-agent');
    if (chatAgent) {
      chatAgent.value = detail.agent || '';
    }
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[runway] Failed to load session detail:', err);
  } finally {
    if (inFlightDetail === controller) {
      inFlightDetail = null;
    }
  }
}

function renderDetail(detail) {
  const container = document.getElementById('detail-content');
  // A re-render of the same session preserves the user's scroll position;
  // a switch to a different session lands on the latest turn instead.
  const isSameSession = container.dataset.sessionId === detail.id;

  let html = '';

  // Session info
  html += `
    <div class="detail-section">
      <div class="detail-section-title">Session Info</div>
      <div class="detail-field">
        <div class="detail-field-label">Name</div>
        <div class="detail-field-value">${esc(detail.name)}</div>
      </div>
      <div class="detail-field">
        <div class="detail-field-label">Status</div>
        <div class="detail-field-value">
          <span class="session-status-dot ${detail.status}" style="display:inline-block;vertical-align:middle;margin-right:6px;"></span>
          ${detail.status}${detail.pid ? ` (PID: ${detail.pid})` : ''}
        </div>
      </div>
      <div class="detail-field">
        <div class="detail-field-label">ID</div>
        <div class="detail-field-value mono">${esc(detail.id)}</div>
      </div>
      ${detail.cwd ? `
      <div class="detail-field">
        <div class="detail-field-label">Working Directory</div>
        <div class="detail-field-value mono">${esc(detail.cwd)}</div>
      </div>` : ''}
      ${detail.branch ? `
      <div class="detail-field">
        <div class="detail-field-label">Branch</div>
        <div class="detail-field-value">${esc(detail.branch)}</div>
      </div>` : ''}
      ${detail.repository ? `
      <div class="detail-field">
        <div class="detail-field-label">Repository</div>
        <div class="detail-field-value">${esc(detail.repository)}</div>
      </div>` : ''}
      ${detail.agent ? `
      <div class="detail-field">
        <div class="detail-field-label">Agent</div>
        <div class="detail-field-value">${esc(detail.agent)}</div>
      </div>` : ''}
      <div class="detail-field">
        <div class="detail-field-label">Created</div>
        <div class="detail-field-value">${formatDate(detail.created_at)}</div>
      </div>
      <div class="detail-field">
        <div class="detail-field-label">Last Updated</div>
        <div class="detail-field-value">${formatDate(detail.updated_at)}</div>
      </div>
    </div>
  `;

  // Actions
  html += `
    <div class="detail-section">
      <div class="detail-section-title">Actions</div>
      <div class="session-actions">
        <button class="action-btn primary" onclick="launchVSCode('${detail.id}')">Open in VS Code</button>
        <button class="action-btn primary" onclick="launchTerminal('${detail.id}')">Open in Terminal</button>
        <button class="action-btn" onclick="resumeInTerminal('${detail.id}')">Copy command</button>
      </div>
      ${detail.cwd ? `
      <div class="project-settings-mini" id="project-settings-mini" data-project-key="${esc(detail.cwd)}">
        <div class="mini-row"><label>Loading project settings...</label></div>
      </div>` : ''}
    </div>
  `;

  // Conversation: render the merged chronology (turns + file events). A
  // file event appears as a small indented row immediately after the
  // assistant turn that produced it. File events with no producing turn
  // (NULL turn_index in the store) tail the very last page as an
  // "unattributed" group. See issue #35.
  if (detail.chronology && detail.chronology.length > 0) {
    const turnCount = detail.chronology.filter(i => i.kind === 'turn').length;
    const headerSuffix = detail.has_more ? `${turnCount}+ turns` : `${turnCount} turns`;
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Conversation (${headerSuffix})</div>
        <div class="conversation" id="conversation-list">
    `;
    html += renderChronologyItems(detail.id, detail.chronology, detail.cwd);
    html += '</div>';
    if (detail.has_more && detail.next_cursor != null) {
      html += `
        <div class="chronology-load-more">
          <button class="action-btn" id="chronology-load-more-btn"
            onclick="loadMoreChronology('${detail.id}', ${detail.next_cursor})">
            Load older turns
          </button>
        </div>
      `;
    }
    html += '</div>';
  }

  // Checkpoints
  if (detail.checkpoints && detail.checkpoints.length > 0) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Checkpoints</div>
    `;
    for (const cp of detail.checkpoints) {
      html += `
        <div class="checkpoint">
          <div class="checkpoint-title">${esc(cp.title)}</div>
          ${cp.overview ? `<div class="checkpoint-overview">${esc(truncate(cp.overview, 200))}</div>` : ''}
        </div>
      `;
    }
    html += '</div>';
  }

  // Files modified summary previously rendered here as a flat list at the
  // bottom of the detail panel. After issue #35 the chronology renderer
  // shows file events inline with their producing turns, so this summary
  // duplicated information already on screen. Removed in #49 along with
  // the unbounded `files` query that backed it.

  // Preserve scroll position across live re-renders so the user is not
  // bounced to the top while reading earlier history. If the user was at
  // (or very near) the bottom, follow live by scrolling to the new bottom.
  // Only applies on a same-session re-render: a session switch lands on
  // the latest turn so the user sees current activity, not the previous
  // session's scroll offset applied to unrelated content.
  const SCROLL_BOTTOM_THRESHOLD_PX = 50;
  const prevScrollTop = container.scrollTop;
  const wasAtBottom = isSameSession &&
    container.scrollHeight - prevScrollTop - container.clientHeight < SCROLL_BOTTOM_THRESHOLD_PX;

  container.innerHTML = html;
  container.dataset.sessionId = detail.id;

  // Hydrate the inline per-project settings section (issue #53) once the
  // panel HTML is on the page. Fetch is async and tolerant of failures:
  // a network or schema hiccup leaves the placeholder in place rather
  // than blocking the rest of the detail render.
  if (detail.cwd) {
    hydrateProjectSettingsMini(detail.cwd).catch(() => {});
  }

  if (!isSameSession) {
    container.scrollTop = container.scrollHeight;
  } else if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollTop = prevScrollTop;
  }
}

// Filters
function selectFilter(status) {
  appState.filters.status = status;
  persistFilters();
  document.querySelectorAll('.status-filter-btn').forEach(el => {
    el.classList.toggle('active', el.dataset.status === status);
  });
  updateMainTitle();
  renderSessions();
}

// Per-project mini settings section in the session detail panel
// (issue #53). Fetches the global schema + per-project overrides for
// the session's cwd and renders quick-edit inputs for the most-used
// overridable keys (defaults.agent, launchers.vscode). Fields outside
// that minimal set link out to /settings via the "More settings"
// anchor; the full picker-driven view lives on the dedicated page.
//
// All work is best-effort: any network or shape failure leaves the
// existing placeholder in place. The detail panel never blocks on
// settings.
const MINI_KEYS = ['defaults.agent', 'launchers.vscode'];
let miniSchemaCache = null;
async function hydrateProjectSettingsMini(projectKey) {
  const node = document.getElementById('project-settings-mini');
  if (!node || node.dataset.projectKey !== projectKey) return;
  if (!ApiClient || !ApiClient.getSettingsSchema) return;

  if (!miniSchemaCache) {
    const s = await ApiClient.getSettingsSchema();
    if (s.status !== 200) return;
    miniSchemaCache = s.body;
  }
  const [globalRes, projRes] = await Promise.all([
    ApiClient.getSettings(),
    ApiClient.getProjectSettings(projectKey),
  ]);
  if (globalRes.status !== 200) return;
  const globalDoc = globalRes.body;
  const overrides = (projRes.body && projRes.body.overrides) || {};

  function getByPath(obj, key) {
    let cur = obj;
    for (const seg of key.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  let html = '';
  for (const key of MINI_KEYS) {
    const d = miniSchemaCache.descriptors.find(x => x.key === key);
    if (!d) continue;
    const overridden = getByPath(overrides, key) !== undefined;
    const value = overridden ? getByPath(overrides, key) : getByPath(globalDoc.values, key);
    let input;
    if (d.type === 'enum' && Array.isArray(d.enum)) {
      input = `<select data-mini-key="${esc(key)}">` + d.enum.map(opt =>
        `<option value="${esc(opt)}"${opt === value ? ' selected' : ''}>${esc(opt)}</option>`
      ).join('') + '</select>';
    } else {
      input = `<input type="text" data-mini-key="${esc(key)}" value="${esc(value == null ? '' : value)}">`;
    }
    html += `
      <div class="mini-row">
        <label>${esc(d.label)}</label>
        ${input}
        <span style="font-size:11px;color:var(--text-muted);">${overridden ? '(override)' : '(inherits)'}</span>
      </div>
    `;
  }
  html += '<div class="mini-row"><a class="mini-link" href="/settings">More settings &rarr;</a></div>';
  node.innerHTML = html;

  node.querySelectorAll('[data-mini-key]').forEach(input => {
    input.addEventListener('change', async () => {
      const key = input.getAttribute('data-mini-key');
      const value = input.value;
      const patch = {};
      // Build a nested patch from the dot-key
      const parts = key.split('.');
      let cur = patch;
      for (let i = 0; i < parts.length - 1; i++) { cur[parts[i]] = {}; cur = cur[parts[i]]; }
      cur[parts[parts.length - 1]] = value;
      const res = await ApiClient.patchProjectSettings(projectKey, patch);
      if (res.status !== 200) {
        console.warn('[runway] failed to save project setting:', res.body);
        return;
      }
      // Re-render to refresh the (override) / (inherits) tag.
      hydrateProjectSettingsMini(projectKey).catch(() => {});
    });
  });
}

function selectProjectByIndex(index) {
  const project = projects[index];
  if (!project) return;
  selectProject(project.main_repo_path);
}

function selectProject(path) {
  appState.filters.project = path;
  persistFilters();

  document.querySelectorAll('.project-item').forEach(el => {
    const idx = parseInt(el.dataset.projectIndex);
    el.classList.toggle('active', projects[idx]?.main_repo_path === path);
  });

  updateMainTitle();
  renderSessions();

  if (window.innerWidth <= 768) {
    showMobilePanel('main');
  }
}

function clearProjectFilter() {
  appState.filters.project = null;
  persistFilters();
  document.querySelectorAll('.project-item').forEach(el => el.classList.remove('active'));
  updateMainTitle();
  renderSessions();
}

// Search input (debounced). When the content-search toggle is on, we
// kick off a server FTS query; otherwise the existing client-side
// substring filter handles things.
let searchDebounceTimer = null;
function handleSearchInput(value) {
  appState.filters.search = value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    persistFilters();
    if (appState.filters.contentSearch && contentSearchState.available) {
      runContentSearch();
    } else {
      renderSessions();
    }
  }, 250);
}

function handleContentSearchToggle(checked) {
  appState.filters.contentSearch = !!checked;
  persistFilters();
  if (appState.filters.contentSearch) {
    if (!contentSearchState.available) {
      // Defensive: the control should be disabled in this case, but if
      // the user somehow flipped it we re-probe and reset.
      probeContentSearch().then(() => {
        if (contentSearchState.available) runContentSearch();
        else renderSessions();
      });
      return;
    }
    if ((appState.filters.search || '').trim()) {
      runContentSearch();
    } else {
      contentSearchState.status = 'idle';
      contentSearchState.results = [];
      renderSessions();
    }
  } else {
    abortInFlightContentSearch();
    contentSearchState.status = 'idle';
    contentSearchState.results = [];
    contentSearchState.error = null;
    renderSessions();
  }
}

// Debounce + AbortController for the server-backed content search.
// Mirrors the inFlightDetail pattern from issue #49 so a fast typist
// only ever has one in-flight request.
async function runContentSearch() {
  const q = (appState.filters.search || '').trim();
  if (!q) {
    contentSearchState.status = 'idle';
    contentSearchState.results = [];
    contentSearchState.error = null;
    renderSessions();
    return;
  }
  if (q.length > 200) {
    contentSearchState.status = 'error';
    contentSearchState.error = 'Query is too long. Shorten it to 200 characters or fewer.';
    renderSessions();
    return;
  }
  abortInFlightContentSearch();
  const controller = new AbortController();
  inFlightContentSearch = controller;
  contentSearchState.status = 'searching';
  contentSearchState.error = null;
  contentSearchState.lastQuery = q;
  renderSessions();
  try {
    const { status, body } = await ApiClient.searchSessions(q, { limit: 50, signal: controller.signal });
    if (controller.signal.aborted) return;
    if (status === 200) {
      contentSearchState.status = 'ready';
      contentSearchState.results = Array.isArray(body.results) ? body.results : [];
    } else if (status === 503 && body && body.code === 'fts_unavailable') {
      contentSearchState.status = 'unavailable';
      contentSearchState.available = false;
      contentSearchState.results = [];
      appState.filters.contentSearch = false;
      persistFilters();
      applyContentSearchControl();
    } else if (status === 503 && body && body.code === 'fts_timeout') {
      contentSearchState.status = 'error';
      contentSearchState.error = 'Search timed out. Try a more specific query.';
      contentSearchState.results = [];
    } else if (status === 400) {
      contentSearchState.status = 'error';
      contentSearchState.error = (body && body.error) || 'Invalid search query.';
      contentSearchState.results = [];
    } else {
      contentSearchState.status = 'error';
      contentSearchState.error = 'Search failed. Try again.';
      contentSearchState.results = [];
    }
  } catch (err) {
    if (isAbortError(err)) return;
    console.error('[runway] content search failed:', err);
    contentSearchState.status = 'error';
    contentSearchState.error = 'Search failed. Try again.';
    contentSearchState.results = [];
  } finally {
    if (inFlightContentSearch === controller) {
      inFlightContentSearch = null;
    }
    renderSessions();
  }
}

function handleSortChange(value) {
  appState.sort = value;
  persistFilters();
  renderSessions();
}

function handleHasRefToggle(checked) {
  appState.filters.hasRef = !!checked;
  persistFilters();
  renderSessions();
}

// New session
function toggleNewSession() {
  const bar = document.getElementById('new-session-bar');
  bar.classList.toggle('visible');
  if (bar.classList.contains('visible')) {
    const cwdInput = document.getElementById('new-session-cwd');
    if (appState.filters.project) cwdInput.value = appState.filters.project;
    document.getElementById('new-session-name').focus();
  }
}

async function createNewSession() {
  const cwd = document.getElementById('new-session-cwd').value.trim();
  const name = document.getElementById('new-session-name').value.trim();
  const agent = document.getElementById('new-session-agent').value;

  if (!cwd) return alert('Please enter a project folder');

  toggleNewSession();
  sendPrompt('Hello, starting a new session.', null, cwd, name || undefined, agent || undefined);
}

// Send message
function sendMessage() {
  const input = document.getElementById('chat-input');
  const prompt = input.value.trim();
  if (!prompt || isStreaming) return;

  const agent = document.getElementById('chat-agent')?.value || undefined;
  input.value = '';
  autoResizeTextarea(input);
  sendPrompt(prompt, appState.selectedSessionId, undefined, undefined, agent);
}

async function sendPrompt(prompt, sessionId, cwd, name, agent) {
  isStreaming = true;
  document.getElementById('send-btn').disabled = true;

  // Show streaming indicator in session list
  const listContainer = document.getElementById('session-list');
  const indicator = document.createElement('div');
  indicator.className = 'streaming-indicator';
  indicator.innerHTML = '<div class="streaming-dot"></div> Processing...';
  listContainer.prepend(indicator);

  // Build SSE request
  const body = JSON.stringify({ prompt, sessionId, cwd, name, agent });

  try {
    const res = await api('/api/sessions/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let responseText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.substring(6));

          if (event.type === 'assistant.message_delta') {
            responseText += event.data.deltaContent || '';
            indicator.innerHTML = `<div class="streaming-dot"></div> ${truncate(responseText, 80)}`;
          }

          if (event.type === 'assistant.message') {
            responseText = event.data.content || responseText;
          }

          if (event.type === 'process.exit') {
            indicator.innerHTML = `&#x2705; Complete: ${truncate(responseText, 100)}`;
            indicator.style.background = 'var(--green-subtle)';
            indicator.style.color = 'var(--green)';
          }
        } catch {}
      }
    }
  } catch (err) {
    indicator.innerHTML = `&#x274C; Error: ${err.message}`;
    indicator.style.background = 'var(--red-subtle)';
    indicator.style.color = 'var(--red)';
  }

  isStreaming = false;
  document.getElementById('send-btn').disabled = false;

  // Refresh sessions after a moment
  setTimeout(() => {
    loadSessions();
    if (appState.selectedSessionId) selectSession(appState.selectedSessionId);
  }, 2000);
}

// Open session in terminal
function resumeInTerminal(sessionId) {
  const cmd = `copilot --resume=${sessionId}`;
  navigator.clipboard.writeText(cmd).then(() => {
    alert(`Copied to clipboard:\n\n${cmd}\n\nPaste this in your terminal to resume the session.`);
  }).catch(() => {
    prompt('Run this in your terminal:', cmd);
  });
}

// Launch VS Code at the session's cwd via the server-side spawn endpoint.
async function launchVSCode(sessionId) {
  return launchVSCodeAtPath(sessionId, null);
}

// Launch VS Code at a specific file inside the session's cwd. `targetPath`
// can be absolute or relative to cwd; the server validates it stays
// inside the session working directory before spawning.
async function launchVSCodeAtPath(sessionId, targetPath) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/launch/vscode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(targetPath ? { path: targetPath } : {}),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(body.hint || body.error || `Failed to launch VS Code (HTTP ${res.status})`);
      return;
    }
    if (body && body.ok === false) {
      alert(body.hint || body.error || 'Failed to launch VS Code');
    }
  } catch (err) {
    alert(`Failed to launch VS Code: ${err.message}`);
  }
}

// Render one page of chronology items. Returns the inner HTML; the
// caller wraps it in a `.conversation` container.
function renderChronologyItems(sessionId, items, sessionCwd) {
  let html = '';
  for (const item of items) {
    if (item.kind === 'turn') {
      if (item.user_message) {
        html += `
          <div class="turn">
            <div class="turn-label user">You</div>
            <div class="turn-user">${esc(truncate(stripSystemTags(item.user_message), 500))}</div>
          </div>
        `;
      }
      if (item.assistant_response) {
        const rendered = renderMarkdown(truncate(item.assistant_response, 3000));
        html += `
          <div class="turn">
            <div class="turn-label assistant">Copilot</div>
            <div class="turn-assistant"><div class="md-content">${rendered}</div></div>
          </div>
        `;
      }
    } else if (item.kind === 'file') {
      const tool = item.tool_name === 'create' ? 'create' : 'edit';
      const unattributed = item.turn_index == null;
      const pathAttr = (item.file_path || '').replace(/"/g, '&quot;');
      const safeSessionId = String(sessionId).replace(/'/g, "\\'");
      const safePath = (item.file_path || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const openable = !!(sessionCwd && item.file_path);
      html += `
        <div class="chronology-file${unattributed ? ' unattributed' : ''}">
          <span class="badge ${tool}">${tool}</span>
          ${openable
            ? `<a class="chronology-file-path" href="#"
                  title="${pathAttr}"
                  onclick="event.preventDefault(); launchVSCodeAtPath('${safeSessionId}', '${safePath}')">${esc(shortenFilePath(item.file_path))}</a>`
            : `<span class="chronology-file-path" title="${pathAttr}">${esc(shortenFilePath(item.file_path))}</span>`}
        </div>
      `;
    }
  }
  return html;
}

// "Load older turns" click handler. Appends the next chronology page
// without resetting scroll position. Avoids the snap-to-bottom logic in
// renderDetail by mutating the existing DOM in place.
//
// Shares the inFlightDetail AbortController with selectSession so that a
// session switch (or a rapid second click on the button) aborts any
// pending load-more fetch. A post-await guard catches the microtask race
// where a response slips through after the abort has fired (issue #49).
async function loadMoreChronology(sessionId, cursor) {
  const btn = document.getElementById('chronology-load-more-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
  const controller = ensureDetailController();
  try {
    const page = await apiJson(
      `/api/sessions/${sessionId}?cursor=${encodeURIComponent(cursor)}`,
      { signal: controller.signal },
    );
    // Belt-and-braces guard against the abort microtask race: a response
    // that already resolved can still land here after the session switch.
    if (sessionId !== appState.selectedSessionId) return;
    const list = document.getElementById('conversation-list');
    const wrapper = btn ? btn.parentElement : null;
    if (!list || !page.chronology) return;
    const cwd = page.cwd || '';
    const newHtml = renderChronologyItems(sessionId, page.chronology, cwd);
    list.insertAdjacentHTML('beforeend', newHtml);
    if (wrapper) {
      if (page.has_more && page.next_cursor != null) {
        wrapper.innerHTML = `
          <button class="action-btn" id="chronology-load-more-btn"
            onclick="loadMoreChronology('${sessionId}', ${page.next_cursor})">
            Load older turns
          </button>
        `;
      } else {
        wrapper.remove();
      }
    }
  } catch (err) {
    if (isAbortError(err)) return;
    if (btn) { btn.disabled = false; btn.textContent = 'Load older turns'; }
    console.error('[runway] Failed to load more turns:', err);
    alert(`Failed to load more turns: ${err.message}`);
  } finally {
    if (inFlightDetail === controller) {
      inFlightDetail = null;
    }
  }
}

// Launch a new terminal that auto-runs `copilot --resume=<id>` at the
// session's cwd, via the server-side spawn endpoint. If the session is
// still attached to a live CLI, the server may focus the existing
// terminal window instead of spawning a new one.
async function launchTerminal(sessionId) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/launch/terminal`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(body.hint || body.error || `Failed to launch terminal (HTTP ${res.status})`);
      return;
    }
    if (body && body.ok === false) {
      alert(body.hint || body.error || 'Failed to launch terminal');
      return;
    }
    if (body && body.focused === true) {
      // Existing window was brought to the foreground; the user already
      // sees it. Silent success would be confusing, so confirm briefly.
      // Console-only would be invisible; an alert is jarring but matches
      // the v1 toast model used by resumeInTerminal.
      console.info(`[runway] focused existing terminal (pid ${body.pid}) for session ${sessionId}`);
      return;
    }
    if (body && body.focused === false && body.hint) {
      alert(body.hint);
    }
  } catch (err) {
    alert(`Failed to launch terminal: ${err.message}`);
  }
}

// Chat input handling
function handleChatKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
  // Auto-resize
  setTimeout(() => autoResizeTextarea(event.target), 0);
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// Refresh
function refreshSessions() {
  loadStats();
  loadSessions();
}

// Markdown rendering
function renderMarkdown(text) {
  if (!text) return '';
  try {
    return marked.parse(text);
  } catch {
    return esc(text);
  }
}

// Add project
function toggleAddProject() {
  const form = document.getElementById('add-project-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) {
    document.getElementById('add-project-path').focus();
  }
}

async function addProject() {
  const folderPath = document.getElementById('add-project-path').value.trim();
  const name = document.getElementById('add-project-name').value.trim();

  if (!folderPath) return;

  try {
    const res = await api('/api/projects/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folderPath, name: name || undefined }),
    });

    if (!res.ok) {
      const err = await res.json();
      alert(err.error || 'Failed to add project');
      return;
    }

    document.getElementById('add-project-path').value = '';
    document.getElementById('add-project-name').value = '';
    toggleAddProject();
    await loadProjects();
  } catch (err) {
    alert('Error adding project: ' + err.message);
  }
}

// Helpers
function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function shortenPath(p) {
  if (!p) return '';
  // Windows: C:\Users\<name>\... → ~\...
  p = p.replace(/^[A-Z]:\\Users\\[^\\]+\\?/i, '~\\');
  // Unix: /home/<name>/... or /Users/<name>/... → ~/...
  p = p.replace(/^\/(home|Users)\/[^/]+\/?/, '~/');
  return p;
}

function shortenFilePath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.length <= 3) return parts.join('/');
  return '.../' + parts.slice(-3).join('/');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.substring(0, max) + '...' : str;
}

function stripSystemTags(str) {
  if (!str) return '';
  return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr);
  const diff = (now - date) / 1000;

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString();
}

// Mobile panel switching
function showMobilePanel(panel) {
  const sidebar = document.querySelector('.sidebar');
  const main = document.querySelector('.main');
  const detail = document.querySelector('.detail-panel');

  sidebar.classList.remove('mobile-open');
  main.classList.remove('mobile-open');
  detail.classList.remove('mobile-open');

  if (panel === 'sidebar') sidebar.classList.add('mobile-open');
  else if (panel === 'main') main.classList.add('mobile-open');
  else if (panel === 'detail') detail.classList.add('mobile-open');

  // Update nav button states
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === panel);
  });
}

function closeMobilePanel() {
  // On tablet, close detail overlay; on mobile, go back to sessions
  const detail = document.querySelector('.detail-panel');
  detail.classList.remove('mobile-open');

  if (window.innerWidth <= 768) {
    showMobilePanel('main');
  }
}

// On mobile, set initial panel visibility
function initMobileLayout() {
  if (window.innerWidth <= 768) {
    const main = document.querySelector('.main');
    main.classList.add('mobile-open');
  }
}

// Start
initMobileLayout();
init();
