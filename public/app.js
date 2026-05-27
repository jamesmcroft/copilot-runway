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

// Markdown setup
marked.setOptions({ breaks: true, gfm: true });

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

// Persistence
const STORAGE_PREFIX = 'runway:';
const STORAGE_KEYS = {
  search: STORAGE_PREFIX + 'filter:search',
  project: STORAGE_PREFIX + 'filter:project',
  status: STORAGE_PREFIX + 'filter:status',
  hasRef: STORAGE_PREFIX + 'filter:hasRef',
  sort: STORAGE_PREFIX + 'sort',
};

function loadFiltersFromStorage() {
  try {
    appState.filters.search = localStorage.getItem(STORAGE_KEYS.search) ?? FILTER_DEFAULTS.search;
    const project = localStorage.getItem(STORAGE_KEYS.project);
    appState.filters.project = project && project !== 'null' ? project : FILTER_DEFAULTS.project;
    appState.filters.status = localStorage.getItem(STORAGE_KEYS.status) ?? FILTER_DEFAULTS.status;
    appState.filters.hasRef = (localStorage.getItem(STORAGE_KEYS.hasRef) ?? (FILTER_DEFAULTS.hasRef ? '1' : '0')) === '1';
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
    localStorage.setItem(STORAGE_KEYS.sort, appState.sort);
  } catch {}
}

// Fetch helper
async function api(path, options = {}) {
  const res = await fetch(path, { ...options });
  return res;
}

async function apiJson(path) {
  const res = await api(path);
  return res.json();
}

// Init
async function init() {
  loadFiltersFromStorage();
  applyFiltersToControls();
  await Promise.all([loadStats(), loadProjects(), loadSessions(), loadAgents()]);
  // Recover from a stale persisted project filter: if the saved cwd no
  // longer matches any known project, drop it so the user is not stuck
  // staring at an empty list with no obvious cause.
  if (appState.filters.project && !projects.find(p => p.main_repo_path === appState.filters.project)) {
    appState.filters.project = null;
    persistFilters();
    updateMainTitle();
    renderSessions();
  }
  startEventStream();
}

function applyFiltersToControls() {
  const searchInput = document.getElementById('session-search');
  if (searchInput) searchInput.value = appState.filters.search || '';
  const sortSelect = document.getElementById('session-sort');
  if (sortSelect) sortSelect.value = appState.sort;
  const hasRefBox = document.getElementById('filter-has-ref');
  if (hasRefBox) hasRefBox.checked = !!appState.filters.hasRef;
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
  refreshInFlight = (async () => {
    try {
      const detail = await apiJson(`/api/sessions/${requestedSessionId}`);
      // Stale-result guard: discard if the user switched sessions while we were fetching.
      if (appState.selectedSessionId !== requestedSessionId) return;
      renderDetail(detail);
    } catch {}
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

function applyFiltersAndSort(rawSessions) {
  const { search, project, status, hasRef } = appState.filters;
  const searchLower = (search || '').trim().toLowerCase();

  let list = rawSessions.filter(s => {
    if (searchLower) {
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

function renderSessions() {
  const container = document.getElementById('session-list');
  const visible = applyFiltersAndSort(appState.sessions);
  if (visible.length === 0) {
    const desc = describeActiveFilters();
    const msg = desc
      ? `No sessions match: ${esc(desc)}`
      : 'No sessions found';
    container.innerHTML = `<div class="detail-empty">${msg}</div>`;
    return;
  }

  container.innerHTML = visible.map(s => `
    <div class="session-card ${appState.selectedSessionId === s.id ? 'selected' : ''}" 
         onclick="selectSession('${s.id}')">
      <div class="session-card-header">
        <div class="session-status-dot ${s.status}"></div>
        <div class="session-title">${esc(s.name || s.summary || s.id.substring(0, 8))}</div>
        <div class="session-time">${timeAgo(s.updated_at)}</div>
      </div>
      <div class="session-meta">
        ${s.cwd ? `<span class="session-meta-item" title="${esc(s.cwd)}">&#x1F4C1; ${esc(shortenPath(s.cwd))}</span>` : ''}
        ${s.branch ? `<span class="session-meta-item">&#x1F33F; ${esc(s.branch)}</span>` : ''}
        ${s.repository ? `<span class="session-meta-item">&#x1F4E6; ${esc(s.repository)}</span>` : ''}
      </div>
    </div>
  `).join('');
}

// Session detail
async function selectSession(id) {
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

  try {
    const detail = await apiJson(`/api/sessions/${id}`);
    renderDetail(detail);
    // Pre-select the last-known agent for this session
    const chatAgent = document.getElementById('chat-agent');
    if (chatAgent) {
      chatAgent.value = detail.agent || '';
    }
  } catch {}
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
        <button class="action-btn primary" onclick="resumeInTerminal('${detail.id}')">Open in Terminal</button>
      </div>
    </div>
  `;

  // Conversation
  if (detail.turns && detail.turns.length > 0) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Conversation (${detail.turns.length} turns)</div>
        <div class="conversation">
    `;
    for (const turn of detail.turns) {
      if (turn.user_message) {
        html += `
          <div class="turn">
            <div class="turn-label user">You</div>
            <div class="turn-user">${esc(truncate(stripSystemTags(turn.user_message), 500))}</div>
          </div>
        `;
      }
      if (turn.assistant_response) {
        const rendered = renderMarkdown(truncate(turn.assistant_response, 3000));
        html += `
          <div class="turn">
            <div class="turn-label assistant">Copilot</div>
            <div class="turn-assistant"><div class="md-content">${rendered}</div></div>
          </div>
        `;
      }
    }
    html += '</div></div>';
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

  // Files
  if (detail.files && detail.files.length > 0) {
    html += `
      <div class="detail-section">
        <div class="detail-section-title">Files Modified (${detail.files.length})</div>
        <ul class="file-list">
    `;
    for (const f of detail.files) {
      html += `
        <li class="file-item">
          <span class="badge ${f.tool_name}">${f.tool_name}</span>
          ${esc(shortenFilePath(f.file_path))}
        </li>
      `;
    }
    html += '</ul></div>';
  }

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

// Search input (debounced)
let searchDebounceTimer = null;
function handleSearchInput(value) {
  appState.filters.search = value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    persistFilters();
    renderSessions();
  }, 250);
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
