// Worktree action buttons + confirmation dialogs for the session detail
// panel (issue #44).
//
// The module is render only: it builds HTML strings (so app.js can keep
// using `innerHTML` for the detail panel) and exposes a small JS API
// the global handlers can call from inline onclick attributes. No DOM
// state is held here; binding state lives in the server and is refetched
// on every interaction.
//
// All path values rendered into inline `onclick` strings are pushed
// through `escapeAttr` (escapes backslashes and single quotes) so a
// Windows path cannot inject JavaScript via its own separators.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WorktreeActions = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function escHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(s) {
    // Same shape as app.js's escapeAttr: escape backslashes first, then
    // single quotes. The result is safe to drop inside a JS string
    // literal delimited by single quotes.
    return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  // Render the worktree section of the session detail panel.
  //   state.bound        - boolean
  //   state.worktreePath - string (only when bound)
  //   state.branchName   - string (only when bound)
  //   state.dirty        - boolean (only when bound)
  //   state.canDeleteBranch - boolean (only when bound)
  //   sessionId          - string
  function renderSection(sessionId, state) {
    const safeId = escAttr(sessionId);
    if (!state || !state.bound) {
      return `
        <div class="detail-section" id="worktree-section">
          <div class="detail-section-title">Worktree</div>
          <p class="detail-hint">This session is not bound to a git worktree. Binding creates a fresh branch (<code>runway/&lt;id&gt;</code>) and a linked worktree on disk so changes stay isolated from your project's main checkout.</p>
          <div class="session-actions">
            <button class="action-btn primary" onclick="bindWorktree('${safeId}')">Bind worktree</button>
          </div>
        </div>
      `;
    }
    const safePath = escAttr(state.worktreePath);
    const dirtyBadge = state.dirty
      ? `<span class="badge dirty" title="Worktree has uncommitted changes">dirty</span>`
      : `<span class="badge clean" title="Worktree is clean">clean</span>`;
    return `
      <div class="detail-section" id="worktree-section">
        <div class="detail-section-title">Worktree ${dirtyBadge}</div>
        <div class="detail-field">
          <div class="detail-field-label">Path</div>
          <div class="detail-field-value mono">${escHtml(state.worktreePath)}</div>
        </div>
        <div class="detail-field">
          <div class="detail-field-label">Branch</div>
          <div class="detail-field-value mono">${escHtml(state.branchName)}</div>
        </div>
        <div class="session-actions">
          <button class="action-btn primary" onclick="launchVSCodeAtWorktree('${safeId}', '${safePath}')">Open worktree in VS Code</button>
          <button class="action-btn" onclick="removeWorktree('${safeId}')">Remove worktree</button>
        </div>
      </div>
    `;
  }

  // Modal helpers. We render a single shared overlay element on demand
  // and tear it down on close so multiple session switches do not leak
  // event listeners.
  function ensureOverlay() {
    let overlay = document.getElementById('worktree-modal-overlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'worktree-modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:9999;';
    document.body.appendChild(overlay);
    return overlay;
  }

  function closeModal() {
    const overlay = document.getElementById('worktree-modal-overlay');
    if (overlay) overlay.remove();
  }

  // Confirmation dialog for "Remove worktree". Renders the path and the
  // dirty state and exposes two opt in checkboxes: --force and "also
  // delete the branch". The latter is disabled when the server reports
  // the branch has commits beyond the branch point.
  function showRemoveModal({ sessionId, worktreePath, dirty, canDeleteBranch }, onConfirm) {
    const overlay = ensureOverlay();
    const dirtyWarn = dirty
      ? `<p class="modal-warn">This worktree has <strong>uncommitted changes</strong>. Removing without force will fail.</p>`
      : '';
    const branchHint = canDeleteBranch
      ? `<label class="modal-checkbox"><input type="checkbox" id="wt-delete-branch"> Also delete the branch (safe: branch has no unique commits)</label>`
      : `<label class="modal-checkbox disabled" title="Branch has commits beyond the branch point; delete manually if you really want to"><input type="checkbox" id="wt-delete-branch" disabled> Also delete the branch <em>(branch has unique commits)</em></label>`;
    const forceCheckbox = dirty
      ? `<label class="modal-checkbox"><input type="checkbox" id="wt-force" checked> Force removal (discards uncommitted changes)</label>`
      : `<label class="modal-checkbox"><input type="checkbox" id="wt-force"> Force removal</label>`;
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="wt-modal-title" style="background:var(--color-surface, #1e1e1e);color:var(--color-text, #fff);padding:24px;border-radius:8px;max-width:560px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <h3 id="wt-modal-title" style="margin-top:0">Remove worktree?</h3>
        <p>The following worktree will be removed:</p>
        <pre class="mono" style="background:rgba(255,255,255,0.05);padding:8px;border-radius:4px;overflow:auto;word-break:break-all;white-space:pre-wrap;">${escHtml(worktreePath)}</pre>
        ${dirtyWarn}
        <div class="modal-options" style="margin:16px 0">
          ${forceCheckbox}
          <br>
          ${branchHint}
        </div>
        <div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end">
          <button class="action-btn" id="wt-cancel">Cancel</button>
          <button class="action-btn primary" id="wt-confirm">Remove</button>
        </div>
      </div>
    `;
    overlay.querySelector('#wt-cancel').onclick = closeModal;
    overlay.querySelector('#wt-confirm').onclick = () => {
      const force = !!overlay.querySelector('#wt-force').checked;
      const deleteBranch = !!overlay.querySelector('#wt-delete-branch').checked;
      closeModal();
      onConfirm({ sessionId, force, deleteBranch });
    };
  }

  // Concurrency block: another session already owns the target worktree
  // path. Offer a "Focus the bound session" CTA that scrolls the
  // dashboard to that session.
  function showConcurrencyModal({ boundSessionId, message }, onFocus) {
    const overlay = ensureOverlay();
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="wt-conc-title" style="background:var(--color-surface, #1e1e1e);color:var(--color-text, #fff);padding:24px;border-radius:8px;max-width:560px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);">
        <h3 id="wt-conc-title" style="margin-top:0">Worktree path already in use</h3>
        <p>${escHtml(message || 'This worktree path is already bound to another session.')}</p>
        <p>Bound session: <code>${escHtml(boundSessionId || 'unknown')}</code></p>
        <div class="modal-actions" style="display:flex;gap:8px;justify-content:flex-end">
          <button class="action-btn" id="wt-conc-cancel">Close</button>
          <button class="action-btn primary" id="wt-conc-focus">Focus the bound session</button>
        </div>
      </div>
    `;
    overlay.querySelector('#wt-conc-cancel').onclick = closeModal;
    overlay.querySelector('#wt-conc-focus').onclick = () => {
      closeModal();
      onFocus(boundSessionId);
    };
  }

  return {
    renderSection,
    showRemoveModal,
    showConcurrencyModal,
    closeModal,
  };
});
