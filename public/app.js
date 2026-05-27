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
let sessions = [];
let projects = [];
let selectedSessionId = null;
let selectedFilter = 'all';
let selectedProjectPath = null;
let isStreaming = false;

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
  await Promise.all([loadStats(), loadProjects(), loadSessions(), loadAgents()]);
  startEventStream();
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
  const idx = sessions.findIndex(s => s.id === sessionId);
  if (idx >= 0) {
    sessions[idx] = { ...sessions[idx], status, pid: status === 'active' ? (pid || null) : null };
    if (selectedFilter === 'active' && status !== 'active') {
      sessions.splice(idx, 1);
    }
    renderSessions();
  } else if (status === 'active') {
    // Session became active that we hadn't seen yet (e.g. just created).
    loadSessions();
  }
  loadStats();
  if (selectedSessionId === sessionId) {
    refreshSelectedSession();
  }
}

function handleSessionEnded({ sessionId }) {
  if (!sessionId) return;
  const before = sessions.length;
  sessions = sessions.filter(s => s.id !== sessionId);
  if (sessions.length !== before) renderSessions();
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
    if (selectedSessionId) refreshSelectedSession();
  }, 500);
}

async function refreshSelectedSession() {
  if (!selectedSessionId || isStreaming) return;
  // In-flight de-dup: at most one fetch in flight and one queued.
  if (refreshInFlight) {
    refreshPending = true;
    return;
  }
  const requestedSessionId = selectedSessionId;
  refreshInFlight = (async () => {
    try {
      const detail = await apiJson(`/api/sessions/${requestedSessionId}`);
      // Stale-result guard: discard if the user switched sessions while we were fetching.
      if (selectedSessionId !== requestedSessionId) return;
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
    <div class="project-item ${selectedProjectPath === p.main_repo_path ? 'active' : ''}" 
         data-project-index="${i}" onclick="selectProjectByIndex(${i})">
      <div class="project-name">${esc(p.name)}</div>
      <div class="project-path">${esc(shortenPath(p.main_repo_path))}</div>
    </div>
  `).join('');
}

// Sessions
async function loadSessions() {
  try {
    let url = '/api/sessions?limit=100';
    if (selectedFilter === 'active') {
      url = '/api/sessions/active';
    } else if (selectedProjectPath) {
      url = `/api/sessions?cwd=${encodeURIComponent(selectedProjectPath)}&limit=100`;
    }
    sessions = await apiJson(url);
    renderSessions();
  } catch {}
}

function renderSessions() {
  const container = document.getElementById('session-list');
  if (sessions.length === 0) {
    container.innerHTML = '<div class="detail-empty">No sessions found</div>';
    return;
  }

  container.innerHTML = sessions.map(s => `
    <div class="session-card ${selectedSessionId === s.id ? 'selected' : ''}" 
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
  selectedSessionId = id;
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
  const SCROLL_BOTTOM_THRESHOLD_PX = 50;
  const prevScrollTop = container.scrollTop;
  const wasAtBottom =
    container.scrollHeight - prevScrollTop - container.clientHeight < SCROLL_BOTTOM_THRESHOLD_PX;

  container.innerHTML = html;

  if (wasAtBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollTop = prevScrollTop;
  }
}

// Filters
function selectFilter(filter) {
  selectedFilter = filter;
  selectedProjectPath = null;

  document.querySelectorAll('.filter-item').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === filter);
  });
  document.querySelectorAll('.project-item').forEach(el => el.classList.remove('active'));

  document.getElementById('main-title').textContent =
    filter === 'active' ? 'Active Sessions' : 'All Sessions';

  loadSessions();
}

function selectProjectByIndex(index) {
  const project = projects[index];
  if (!project) return;
  selectProject(project.main_repo_path);
}

function selectProject(path) {
  selectedFilter = null;
  selectedProjectPath = path;

  document.querySelectorAll('.filter-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.project-item').forEach(el => {
    const idx = parseInt(el.dataset.projectIndex);
    el.classList.toggle('active', projects[idx]?.main_repo_path === path);
  });

  const project = projects.find(p => p.main_repo_path === path);
  document.getElementById('main-title').textContent = project ? project.name : 'Sessions';

  loadSessions();

  if (window.innerWidth <= 768) {
    showMobilePanel('main');
  }
}

// New session
function toggleNewSession() {
  const bar = document.getElementById('new-session-bar');
  bar.classList.toggle('visible');
  if (bar.classList.contains('visible')) {
    const cwdInput = document.getElementById('new-session-cwd');
    if (selectedProjectPath) cwdInput.value = selectedProjectPath;
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
  sendPrompt(prompt, selectedSessionId, undefined, undefined, agent);
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
    if (selectedSessionId) selectSession(selectedSessionId);
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
