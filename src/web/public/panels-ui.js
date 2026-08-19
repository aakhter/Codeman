/**
 * @fileoverview Subagent panel (discovery, detail view, kill), subagent parent tracking,
 * agent teams (tasks panel, teammate badges, terminals), project insights (bash tool tracking),
 * file browser (directory tree, preview), log viewer (floating file streamers),
 * image popups (auto-popup for screenshots), mux sessions, monitor panel,
 * token statistics, toast notifications, and system stats.
 * Includes 19 SSE handlers for tasks, mux, bash tools, subagents, and images.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.subagents, this.subagentWindows, this.sessions)
 * @dependency constants.js (escapeHtml, ZINDEX_* constants)
 * @dependency subagent-windows.js (openSubagentWindow, closeSubagentWindow)
 * @loadorder 11 of 15 — loaded after settings-ui.js, before session-ui.js
 */

const AWAY_DIGEST_LAST_VIEWED_KEY = 'codeman-away-digest-last-viewed';
const FILE_BROWSER_SHOW_HIDDEN_KEY = 'codeman:fileBrowserShowHidden';
// Bounds for the by-id text preview, mirroring what the workspace text preview
// already does server-side (500 lines). The byte cap rides a Range request, so
// a huge log is a partial read rather than a download the viewer throws away.
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
const TEXT_PREVIEW_MAX_LINES = 500;
const AWAY_DIGEST_SECTIONS = [
  ['needsAttention', 'Needs Attention'],
  ['completed', 'Completed'],
  ['stillRunning', 'Still Running'],
  ['idle', 'Idle'],
  ['informational', 'Informational'],
];

Object.assign(CodemanApp.prototype, {
  _addActivityEntry(agentId, entry, maxSize = 50) {
    const activity = this.subagentActivity.get(agentId) || [];
    activity.push(entry);
    if (activity.length > maxSize) activity.shift();
    this.subagentActivity.set(agentId, activity);
  },

  // Tasks
  _onTaskCreated(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskCompleted(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskFailed(data) {
    this.renderSessionTabs();
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  _onTaskUpdated(data) {
    if (data.sessionId === this.activeSessionId) {
      this.renderTaskPanel();
    }
  },

  // Mux (tmux)
  _onMuxCreated(data) {
    this.muxSessions.push(data);
    this.renderMuxSessions();
  },

  _onMuxKilled(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
  },

  _onMuxDied(data) {
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== data.sessionId);
    this.renderMuxSessions();
    this.showToast('Mux session died: ' + this.getShortId(data.sessionId), 'warning');
  },

  _onMuxStatsUpdated(data) {
    this.muxSessions = data;
    if (document.getElementById('monitorPanel').classList.contains('open')) {
      this.renderMuxSessions();
    }
  },

  // Remote auto-reconnect (COD-108)
  _onRemoteSessionReconnected(data) {
    const id = this.getShortId(data.sessionId);
    this.showToast(`Remote session ${id} reconnected`, 'success');
  },

  _onRemoteReconnectExhausted(data) {
    const sessionId = data.sessionId;
    const id = this.getShortId(sessionId);
    // Auto-reconnect gave up after the bounded backoff. Surface a manual
    // "Reconnect" affordance that re-triggers the attach path (force-reload the
    // session, which re-runs the create/attach flow against the durable remote).
    this.showToast(`Remote session ${id} dropped — auto-reconnect gave up`, 'error', {
      duration: 15000,
      action: {
        label: 'Reconnect',
        onClick: () => {
          if (this.sessions && this.sessions.has(sessionId)) {
            this.selectSession(sessionId, { forceReload: true });
          } else {
            this.showToast('Session no longer available', 'warning');
          }
        },
      },
    });
  },


  // Bash tools
  _onBashToolStart(data) {
    this.handleBashToolStart(data.sessionId, data.tool);
  },

  _onBashToolEnd(data) {
    this.handleBashToolEnd(data.sessionId, data.tool);
  },

  _onBashToolsUpdate(data) {
    this.handleBashToolsUpdate(data.sessionId, data.tools);
  },


  // Subagents (Claude Code background agents)
  _onSubagentDiscovered(data) {
    // Clear all old data for this agentId (in case of ID reuse)
    this.subagents.set(data.agentId, data);
    this.subagentActivity.set(data.agentId, []);
    this.subagentToolResults.delete(data.agentId);
    // Close any existing window for this agentId (will be reopened fresh)
    if (this.subagentWindows.has(data.agentId)) {
      this.forceCloseSubagentWindow(data.agentId);
    }
    this.renderSubagentPanel();

    // Find which Codeman session owns this subagent (direct claudeSessionId match only)
    this.findParentSessionForSubagent(data.agentId);

    // Subagent windows are no longer auto-opened on discovery.
    // Users can open them manually from the monitor panel or via openAllActiveSubagentWindows().

    // Ensure connection lines are updated after window is created and DOM settles
    requestAnimationFrame(() => {
      this.updateConnectionLines();
    });

    // Notify about new subagent discovery
    const parentId = this.subagentParentMap.get(data.agentId);
    this._notifySession(parentId || data.sessionId, 'info', 'subagent-spawn', 'Subagent Spawned', data.description || 'New background agent started');
  },

  _onSubagentUpdated(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      // Merge updated fields (especially description)
      Object.assign(existing, data);
      this.subagents.set(data.agentId, existing);
    } else {
      this.subagents.set(data.agentId, data);
    }
    this.renderSubagentPanel();
    // Update floating window if open (content + header/title)
    if (this.subagentWindows.has(data.agentId)) {
      this.renderSubagentWindowContent(data.agentId);
      this.updateSubagentWindowHeader(data.agentId);
    }
  },

  _onSubagentToolCall(data) {
    this._addActivityEntry(data.agentId, { type: 'tool', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    this.renderSubagentPanel();
    // Update floating window (debounced — tool_call events fire rapidly)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentProgress(data) {
    this._addActivityEntry(data.agentId, { type: 'progress', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentMessage(data) {
    this._addActivityEntry(data.agentId, { type: 'message', ...data });
    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  _onSubagentToolResult(data) {
    // Store tool result by toolUseId for later lookup (cap at 50 per agent)
    if (!this.subagentToolResults.has(data.agentId)) {
      this.subagentToolResults.set(data.agentId, new Map());
    }
    const resultsMap = this.subagentToolResults.get(data.agentId);
    resultsMap.set(data.toolUseId, data);
    if (resultsMap.size > 50) {
      const oldest = resultsMap.keys().next().value;
      resultsMap.delete(oldest);
    }

    // Add to activity stream
    this._addActivityEntry(data.agentId, { type: 'tool_result', ...data });

    if (this.activeSubagentId === data.agentId) {
      this.renderSubagentDetail();
    }
    // Update floating window (debounced)
    if (this.subagentWindows.has(data.agentId)) {
      this.scheduleSubagentWindowRender(data.agentId);
    }
  },

  async _onSubagentCompleted(data) {
    const existing = this.subagents.get(data.agentId);
    if (existing) {
      existing.status = 'completed';
      this.subagents.set(data.agentId, existing);
    }
    this.renderSubagentPanel();
    this.updateSubagentWindows();

    // Auto-minimize completed subagent windows
    if (this.subagentWindows.has(data.agentId)) {
      const windowData = this.subagentWindows.get(data.agentId);
      if (windowData && !windowData.minimized) {
        await this.closeSubagentWindow(data.agentId); // This minimizes to tab
        this.saveSubagentWindowStates(); // Persist the minimized state
      }
    }

    // Notify about subagent completion
    const parentId = this.subagentParentMap.get(data.agentId);
    this._notifySession(parentId || existing?.sessionId || data.sessionId, 'info', 'subagent-complete', 'Subagent Completed', existing?.description || data.description || 'Background agent finished');

    // Clean up activity/tool data for completed agents after 5 minutes
    // This prevents memory leaks from long-running sessions with many subagents
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      // Only clean up if agent is still completed (not restarted)
      if (agent?.status === 'completed') {
        this.subagentActivity.delete(data.agentId);
        this.subagentToolResults.delete(data.agentId);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Prune stale completed agents from main maps after 30 minutes
    // Keeps subagents/subagentParentMap from growing unbounded in 24h sessions
    setTimeout(() => {
      const agent = this.subagents.get(data.agentId);
      if (agent?.status === 'completed' && !this.subagentWindows.has(data.agentId)) {
        this.subagents.delete(data.agentId);
        this.subagentParentMap.delete(data.agentId);
      }
    }, 30 * 60 * 1000); // 30 minutes
  },

  // Images
  _onImageDetected(data) {
    console.log('[Image Detected]', data);
    this.openImagePopup(data);
  },

  _onAttachmentDetected(data) {
    console.log('[Attachment Detected]', data);
    this.addAttachmentCard(data);
    if (data.sessionId) {
      const current = this.attachmentHistoryCounts.get(data.sessionId)
        ?? this.sessions.get(data.sessionId)?.attachmentHistory?.length
        ?? 0;
      this.attachmentHistoryCounts.set(data.sessionId, Math.min(current + 1, 100));
      if (data.sessionId === this.activeSessionId) {
        this.updateAttachmentHistoryBadge();
        if (this.attachmentHistoryDrawerOpen) {
          this._debouncedCall('attachmentHistoryRefresh', () => this.loadAttachmentHistory(data.sessionId), 250);
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Sources Modal (COD-65)
  // ═══════════════════════════════════════════════════════════════

  openSources() {
    const modal = document.getElementById('sourcesModal');
    if (modal) modal.classList.add('active');
    this._wireSourcesFilePicker();
    this.updateSourceFormFields();
    this.loadSources();
  },

  closeSources() {
    const modal = document.getElementById('sourcesModal');
    if (modal) modal.classList.remove('active');
  },

  _wireSourcesFilePicker() {
    if (this._sourcesPickerWired) return;
    const picker = document.getElementById('sourcesFilePicker');
    const titleEl = document.getElementById('sourcesTitle');
    if (!picker) return;
    this._sourcesPickerWired = true;
    picker.addEventListener('change', () => {
      this._onSourcesFilePicked();
      this.updateSourceFormFields();
    });
    if (titleEl) {
      if (!titleEl.dataset) titleEl.dataset = {};
      titleEl.addEventListener('input', () => {
        const ds = titleEl.dataset;
        if (!ds) return;
        if (ds.autoFilled === '1') {
          const cur = titleEl.value;
          const expected = ds.autoFilledValue || '';
          if (cur !== expected) {
            delete ds.autoFilled;
            delete ds.autoFilledValue;
          }
          if (cur.trim() === '') {
            delete ds.autoFilled;
            delete ds.autoFilledValue;
          }
        }
      });
    }
  },

  _onSourcesFilePicked() {
    const picker = document.getElementById('sourcesFilePicker');
    const titleEl = document.getElementById('sourcesTitle');
    if (!picker || !titleEl) return;
    if (!titleEl.dataset) titleEl.dataset = {};
    const file = picker.files && picker.files[0];
    if (!file || !file.name) {
      if (titleEl.dataset.autoFilled === '1') {
        titleEl.value = '';
        delete titleEl.dataset.autoFilled;
        delete titleEl.dataset.autoFilledValue;
      }
      return;
    }
    const segments = file.name.split(/[/\\]/);
    let base = '';
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].trim();
      if (seg && seg !== '.' && seg !== '..') {
        base = seg;
        break;
      }
    }
    // Strip control chars and lingering separators, mirror sanitizeUploadFilename client-side
    base = base.replace(/[\x00-\x1f\x7f/\\]/g, '').trim();
    if (!base) base = 'file';
    if (base.length > 500) base = base.slice(0, 500);
    const cur = titleEl.value.trim();
    const isAuto = titleEl.dataset.autoFilled === '1';
    if (cur === '' || isAuto) {
      titleEl.value = base;
      titleEl.dataset.autoFilled = '1';
      titleEl.dataset.autoFilledValue = base;
    }
  },

  updateSourceFormFields() {
    const type = document.getElementById('sourcesTypeSelect')?.value || 'url';
    const urlRow = document.getElementById('sourcesUrlRow');
    const pathRow = document.getElementById('sourcesPathRow');
    const uploadRow = document.getElementById('sourcesUploadRow');
    const contentRow = document.getElementById('sourcesContentRow');
    if (urlRow) urlRow.classList.toggle('sources-field-row--hidden', type !== 'url');
    if (pathRow) pathRow.classList.toggle('sources-field-row--hidden', type !== 'file');
    if (uploadRow) uploadRow.classList.toggle('sources-field-row--hidden', type !== 'file');
    if (contentRow) contentRow.classList.toggle('sources-field-row--hidden', type !== 'highlight');
    const titleEl = document.getElementById('sourcesTitle');
    const picker = document.getElementById('sourcesFilePicker');
    if (titleEl) {
      const hasFile = type === 'file' && !!(picker && picker.files && picker.files.length > 0);
      titleEl.required = !hasFile;
    }
  },

  async loadSources() {
    const container = document.getElementById('sourcesList');
    if (!container) return;
    const sessionId = this.activeSessionId;
    if (!sessionId) {
      container.innerHTML = '<p class="empty-message sources-empty">No active session.</p>';
      return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/sources`);
      const json = await res.json();
      if (json.success) {
        this.renderSources(json.data.sources);
      } else {
        container.innerHTML = '<p class="empty-message sources-empty">Failed to load sources.</p>';
      }
    } catch {
      container.innerHTML = '<p class="empty-message sources-empty">Error loading sources.</p>';
    }
  },

  renderSources(sources) {
    const container = document.getElementById('sourcesList');
    if (!container) return;
    if (!sources.length) {
      container.innerHTML =
        '<p class="empty-message sources-empty">No sources yet. Add a URL, file path, or highlight above.</p>';
      return;
    }
    container.innerHTML = sources.map((s) => this.renderSourceCard(s)).join('');
  },

  renderSourceCard(src) {
    const icons = { url: '\u{1F517}', file: '\u{1F4C4}', highlight: '\u{1F4AC}' };
    const icon = icons[src.type] || '\u{1F4CB}';
    const title = escapeHtml(src.title);
    let detail = '';
    if (src.url) detail = escapeHtml(src.url);
    else if (src.relativePath) detail = escapeHtml(src.relativePath);
    else if (src.content) detail = escapeHtml(src.content.slice(0, 100));
    return `<div class="sources-card" data-source-id="${escapeHtml(src.id)}">
      <span class="sources-card-icon" aria-hidden="true">${icon}</span>
      <div class="sources-card-body">
        <span class="sources-card-title">${title}</span>
        ${detail ? `<span class="sources-card-detail">${detail}</span>` : ''}
      </div>
      <button class="sources-card-delete" onclick="app.deleteSource('${escapeHtml(src.id)}')" aria-label="Remove source" title="Remove">&times;</button>
    </div>`;
  },

  async handleSourceUpload() {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const fileInput = document.getElementById('sourcesFilePicker');
    const file = fileInput?.files?.[0];
    if (!file) return;

    const form = new FormData();
    form.append('file', file);
    const title = document.getElementById('sourcesTitle')?.value?.trim();
    if (title) form.append('title', title);

    const btn = document.getElementById('sourcesUploadBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Uploading...';
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/sources/upload`, {
        method: 'POST',
        body: form,
      });
      const json = await res.json();
      if (json.success) {
        if (fileInput) fileInput.value = '';
        const tEl = document.getElementById('sourcesTitle');
        if (tEl) {
          tEl.value = '';
          if (tEl.dataset) {
            delete tEl.dataset.autoFilled;
            delete tEl.dataset.autoFilledValue;
          }
        }
        if (typeof this.updateSourceFormFields === 'function') this.updateSourceFormFields();
        if (typeof this.loadSources === 'function') this.loadSources();
      }
    } catch {
      // silent — network error
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Upload';
      }
    }
  },

  async handleAddSource(event) {
    event.preventDefault();
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    const type = document.getElementById('sourcesTypeSelect')?.value || 'url';
    const title = document.getElementById('sourcesTitle')?.value?.trim() || '';
    if (!title) return;
    const body = { type, title };
    if (type === 'url') body.url = document.getElementById('sourcesUrl')?.value?.trim() || undefined;
    else if (type === 'file')
      body.relativePath = document.getElementById('sourcesPath')?.value?.trim() || undefined;
    else if (type === 'highlight')
      body.content = document.getElementById('sourcesContent')?.value?.trim() || undefined;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.success) {
        const tEl2 = document.getElementById('sourcesTitle');
        if (tEl2) {
          tEl2.value = '';
          if (tEl2.dataset) {
            delete tEl2.dataset.autoFilled;
            delete tEl2.dataset.autoFilledValue;
          }
        }
        const urlEl = document.getElementById('sourcesUrl');
        if (urlEl) urlEl.value = '';
        const pathEl = document.getElementById('sourcesPath');
        if (pathEl) pathEl.value = '';
        const content = document.getElementById('sourcesContent');
        if (content) content.value = '';
        const picker2 = document.getElementById('sourcesFilePicker');
        if (picker2) picker2.value = '';
        if (typeof this.updateSourceFormFields === 'function') this.updateSourceFormFields();
        if (typeof this.loadSources === 'function') this.loadSources();
      }
    } catch {
      // silent — network error
    }
  },

  async deleteSource(sourceId) {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    try {
      await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/sources/${encodeURIComponent(sourceId)}`,
        { method: 'DELETE' }
      );
      this.loadSources();
    } catch {
      // silent
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Library Modal (COD-63)
  // ═══════════════════════════════════════════════════════════════

  openLibrary() {
    const modal = document.getElementById('libraryModal');
    if (modal) modal.classList.add('active');
    this._wireLibrarySearch();
    this.loadLibrary();
  },

  closeLibrary() {
    const modal = document.getElementById('libraryModal');
    if (modal) modal.classList.remove('active');
  },

  _wireLibrarySearch() {
    if (this._librarySearchWired) return;
    this._librarySearchWired = true;
    const input = document.getElementById('librarySearchInput');
    if (!input) return;
    input.addEventListener('input', (e) => {
      const q = e.target.value;
      this._debouncedCall('librarySearch', () => this.loadLibrary(q), 300);
    });
  },

  async loadLibrary(query = '') {
    const container = document.getElementById('libraryDocuments');
    if (!container) return;
    try {
      const res = await fetch(`/api/library?q=${encodeURIComponent(query)}&limit=100`);
      const json = await res.json();
      if (json.success) {
        this.renderLibrary(json.data.documents);
      } else {
        container.innerHTML = '<p class="empty-message">Failed to load library.</p>';
      }
    } catch {
      container.innerHTML = '<p class="empty-message">Error loading library.</p>';
    }
  },

  renderLibrary(docs) {
    const container = document.getElementById('libraryDocuments');
    if (!container) return;
    if (!docs.length) {
      container.innerHTML = '<p class="empty-message library-empty">No documents found.</p>';
      return;
    }
    container.innerHTML = docs.map((doc) => this.renderLibraryCard(doc)).join('');
  },

  renderLibraryCard(doc) {
    const icon = this.getFileIcon?.(doc.extension) || '\u{1F4C4}';
    const name = escapeHtml(doc.fileName);
    const session = escapeHtml(doc.sessionName);
    const path = doc.relativePath
      ? `<span class="library-card-path">${escapeHtml(doc.relativePath)}</span>`
      : '';
    const date = escapeHtml(new Date(doc.addedAt).toLocaleString());
    return `<div class="library-document-card">
      <span class="library-card-icon" aria-hidden="true">${icon}</span>
      <div class="library-card-body">
        <span class="library-card-name">${name}</span>
        ${path}
        <span class="library-card-meta">${session} &middot; ${date}</span>
      </div>
    </div>`;
  },

  // ═══════════════════════════════════════════════════════════════
  // Away Digest Modal
  // ═══════════════════════════════════════════════════════════════

  async openAwayDigest(range = 'since-last-visit') {
    const settings = this.loadAppSettingsFromStorage?.() || {};
    const defaults = this.getDefaultSettings?.() || {};
    if ((settings.showAwayDigest ?? defaults.showAwayDigest ?? false) !== true) {
      this.showToast?.('Away Digest is disabled in App Settings', 'info');
      return;
    }
    this.awayDigestRange = range;
    this._awayDigestLoadedSuccessfully = false;
    this._awayDigestSinceLastVisitGeneratedAt = undefined;
    const modal = document.getElementById('awayDigestModal');
    if (modal) modal.classList.add('active');
    this.updateAwayDigestRangeControls();
    await this.loadAwayDigest();
  },

  closeAwayDigest() {
    const modal = document.getElementById('awayDigestModal');
    const generatedAt = this._awayDigestSinceLastVisitGeneratedAt;
    if (Number.isFinite(generatedAt)) {
      try {
        localStorage.setItem(AWAY_DIGEST_LAST_VIEWED_KEY, String(generatedAt));
      } catch (err) {
        console.warn('Failed to save away digest last-viewed marker:', err);
      }
    }
    if (modal) modal.classList.remove('active');
  },

  // ═══════════════════════════════════════════════════════════════
  // Command Palette (COD-153)
  // Fast Cmd/Ctrl+K switcher for currently open sessions, plus launch-new.
  // ═══════════════════════════════════════════════════════════════

  shouldOpenCommandPaletteFromShortcut(e) {
    if (!e) return false;
    // Every palette chord requires Ctrl/Cmd/Alt (capture enforces the same for
    // rebinds), so plain typing exits before any registry work — this runs on
    // the document AND xterm keydown hot paths.
    if (!e.ctrlKey && !e.metaKey && !e.altKey) return false;

    // Registry-aware chord check (COD-157): honors a rebound or disabled
    // palette shortcut. Falls back to the default Ctrl/Cmd/Alt+K chord when the
    // registry isn't available (isolated test harnesses).
    const registryAvailable =
      typeof this.getShortcutRegistry === 'function' && typeof this.matchesShortcutEvent === 'function';
    const palette = registryAvailable
      ? this.getShortcutRegistry().find((shortcut) => shortcut.id === 'command-palette')
      : null;
    if (palette) {
      if (palette.disabled || !this.matchesShortcutEvent(e, palette)) return false;
    } else {
      const key = (e.key || '').toLowerCase();
      if (key !== 'k' && e.code !== 'KeyK') return false;
      if (e.shiftKey) return false;
    }

    const target = e.target;
    if (!target) return true;
    const tagName = (target.tagName || '').toUpperCase();
    const className = typeof target.className === 'string' ? target.className : '';
    const isXtermHelper =
      target.classList?.contains?.('xterm-helper-textarea') || className.includes('xterm-helper-textarea');
    if (isXtermHelper) return true;
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return false;
    if (target.isContentEditable) return false;
    if (typeof target.closest === 'function' && target.closest('[contenteditable="true"]')) return false;
    return true;
  },

  openCommandPalette() {
    const modal = document.getElementById('commandPaletteModal');
    const search = document.getElementById('commandPaletteSearch');
    if (!modal || !search) return;

    this.closeMobileHeaderUtilities?.();
    this.commandPaletteActiveIndex = 0;
    search.value = '';
    modal.classList.add('active');

    this._wireCommandPalette();
    this.renderCommandPalette();

    search.focus();
    search.select?.();
  },

  closeCommandPalette() {
    const modal = document.getElementById('commandPaletteModal');
    if (modal) modal.classList.remove('active');
  },

  _wireCommandPalette() {
    if (this._commandPaletteWired) return;
    this._commandPaletteWired = true;

    const modal = document.getElementById('commandPaletteModal');
    const search = document.getElementById('commandPaletteSearch');
    const list = document.getElementById('commandPaletteList');

    search?.addEventListener('input', () => {
      this.commandPaletteActiveIndex = 0;
      this.renderCommandPalette();
    });

    search?.addEventListener('keydown', async (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveCommandPaletteSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveCommandPaletteSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        await this.activateCommandPaletteItem();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeCommandPalette();
      }
    });

    modal?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeCommandPalette();
      }
    });

    list?.addEventListener?.('click', (e) => {
      const row = e.target?.closest?.('[data-command-index]');
      if (!row) return;
      this.commandPaletteActiveIndex = Number(row.dataset.commandIndex) || 0;
      void this.activateCommandPaletteItem();
    });
  },

  buildCommandPaletteItems(query = '') {
    const needle = query.trim().toLowerCase();
    const orderedIds = this._tabLayoutFirstPaintPending
      ? []
      : [
          ...(Array.isArray(this.sessionOrder) ? this.sessionOrder : []),
          ...Array.from(this.sessions?.keys?.() || []).filter((id) => !this.sessionOrder?.includes?.(id)),
        ];
    const seen = new Set();
    const sessionItems = [];

    for (const sessionId of orderedIds) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      const session = this.sessions?.get?.(sessionId);
      if (!session) continue;
      const title = this.getSessionName?.(session) || session.name || session.title || sessionId.slice(0, 8);
      const subtitleParts = [session.workingDir, session.mode, session.status].filter(Boolean);
      const haystack = [title, session.workingDir, session.mode, session.status, sessionId].filter(Boolean).join(' ').toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      sessionItems.push({
        id: `session:${sessionId}`,
        type: 'session',
        sessionId,
        title,
        subtitle: subtitleParts.join(' · '),
      });
    }

    sessionItems.push(this._buildCommandPaletteNewSessionItem(query));
    sessionItems.push({ id: 'browse-sessions', type: 'browse-sessions', title: 'Browse all sessions…', subtitle: 'Open Session Manager' });
    return sessionItems;
  },

  _buildCommandPaletteNewSessionItem(query = '') {
    const mode = this.runMode || this._runMode || 'claude';
    const labels = { claude: 'Claude', opencode: 'OpenCode', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', pi: 'Pi' };
    const caseName = this._findCommandPaletteCaseMatch(query) || document.getElementById('quickStartCase')?.value || 'testcase';
    return {
      id: 'new-session',
      type: 'new-session',
      caseName,
      title: 'New session',
      subtitle: `Run ${labels[mode] || mode} in ${caseName}`,
    };
  },

  _findCommandPaletteCaseMatch(query = '') {
    const needle = query.trim().toLowerCase();
    if (!needle || !Array.isArray(this.cases)) return null;

    const scoreCase = (caseItem) => {
      const name = String(caseItem?.name || '').trim();
      if (!name) return 0;
      const haystack = [
        name,
        caseItem?.path,
        caseItem?.casePath,
        caseItem?.workingDir,
        caseItem?.remote?.path,
        caseItem?.remote?.hostId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      const lowerName = name.toLowerCase();
      if (lowerName === needle) return 100;
      if (lowerName.startsWith(needle)) return 90;
      if (lowerName.includes(needle)) return 80;
      if (haystack.includes(needle)) return 60;
      return 0;
    };

    let best = null;
    let bestScore = 0;
    for (const caseItem of this.cases) {
      const score = scoreCase(caseItem);
      if (score > bestScore) {
        best = caseItem;
        bestScore = score;
      }
    }
    return best?.name || null;
  },

  renderCommandPalette() {
    const search = document.getElementById('commandPaletteSearch');
    const list = document.getElementById('commandPaletteList');
    if (!list) return;

    const query = search?.value || '';
    const items = this.buildCommandPaletteItems(query);
    this.commandPaletteItems = items;
    this.commandPaletteActiveIndex = Math.max(0, Math.min(this.commandPaletteActiveIndex || 0, items.length - 1));

    list.innerHTML = items
      .map((item, index) => {
        const active = index === this.commandPaletteActiveIndex ? ' active' : '';
        const icon = item.type === 'new-session' ? '+' : item.type === 'browse-sessions' ? '≡' : '›';
        const browse = item.type === 'browse-sessions' ? ' command-palette-item--browse' : '';
        return `
          <button class="command-palette-item${active}${browse}" type="button" data-command-index="${index}">
            <span class="command-palette-icon" aria-hidden="true">${icon}</span>
            <span class="command-palette-text">
              <span class="command-palette-title">${escapeHtml(item.title)}</span>
              <span class="command-palette-subtitle">${escapeHtml(item.subtitle || '')}</span>
            </span>
          </button>
        `;
      })
      .join('');
  },

  _refreshCommandPaletteIfOpen() {
    const modal = document.getElementById('commandPaletteModal');
    if (!modal?.classList.contains('active')) return;
    this.renderCommandPalette();
  },

  moveCommandPaletteSelection(delta) {
    const items = this.commandPaletteItems || this.buildCommandPaletteItems(document.getElementById('commandPaletteSearch')?.value || '');
    if (!items.length) return;
    this.commandPaletteActiveIndex = (this.commandPaletteActiveIndex + delta + items.length) % items.length;
    this.renderCommandPalette();
  },

  async activateCommandPaletteItem(index = this.commandPaletteActiveIndex || 0) {
    const item = (this.commandPaletteItems || [])[index];
    if (!item) return;

    this.closeCommandPalette();
    if (item.type === 'session' && item.sessionId) {
      await this.selectSession(item.sessionId);
      return;
    }
    if (item.type === 'browse-sessions') {
      this.openSessionManager();
      return;
    }
    if (item.type === 'new-session') {
      const caseSelect = document.getElementById('quickStartCase');
      if (caseSelect && item.caseName) {
        if (
          caseSelect.tagName === 'SELECT' &&
          typeof caseSelect.appendChild === 'function' &&
          !Array.from(caseSelect.options || []).some((option) => option.value === item.caseName)
        ) {
          const option = document.createElement('option');
          option.value = item.caseName;
          option.textContent = item.caseName;
          caseSelect.appendChild(option);
        }
        // Keep the searchable combobox, directory display, and persisted
        // last-used case in sync when its mixin is loaded.
        if (typeof this.selectQuickStartCase === 'function') {
          this.selectQuickStartCase(item.caseName);
        } else {
          caseSelect.value = item.caseName;
        }
      }
      await this.run();
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Session Manager Modal (COD-121)
  // Persistent, header-reachable session list (GET /api/sessions/unified)
  // reachable mid-session, with a server-side search box. Reuses the
  // unit-2 history item renderer so clicking resumes/switches sessions.
  // ═══════════════════════════════════════════════════════════════

  async openSessionManager() {
    const modal = document.getElementById('sessionManagerModal');
    if (modal) {
      modal.classList.add('active');
      // Escape closes the modal even while focus is in the search input. A
      // modal-scoped listener is robust regardless of the global Escape chain
      // (which runs other close handlers first and can short-circuit). Wire once.
      if (!this._sessionManagerEscWired) {
        this._sessionManagerEscWired = true;
        modal.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this.closeSessionManager();
          }
        });
      }
    }

    // Ensure cases are loaded so item subtitles can show "#caseName" labels.
    // Mirror loadHistorySessions(): prefer already-loaded this.cases.
    if (!Array.isArray(this.cases) || this.cases.length === 0) {
      try {
        const r = await fetch('/api/cases');
        const d = r.ok ? await r.json() : null;
        this.cases = d?.data || [];
      } catch {
        this.cases = this.cases || [];
      }
    }

    const search = document.getElementById('sessionManagerSearch');
    if (search) {
      // Wire the debounced search input once (lazy — the element exists by
      // the time the modal is first opened, and mixin methods are bound).
      if (!this._sessionManagerSearchWired) {
        this._sessionManagerSearchWired = true;
        search.addEventListener('input', () => {
          const value = search.value.trim();
          this._debouncedCall('sessionManagerSearch', () => this._loadSessionManagerList(value), 200);
        });
      }
      search.value = '';
      search.focus();
    }
    await this._loadSessionManagerList('');
  },

  closeSessionManager() {
    const modal = document.getElementById('sessionManagerModal');
    if (modal) modal.classList.remove('active');
  },

  _setSessionManagerMessage(list, message) {
    list.replaceChildren();
    const line = document.createElement('p');
    line.className = 'empty-message';
    line.textContent = message;
    list.appendChild(line);
  },

  async _loadSessionManagerList(q = '') {
    this._sessionManagerQuery = q;
    const list = document.getElementById('sessionManagerList');
    if (!list) return;
    try {
      const url = '/api/sessions/unified?limit=200' + (q ? '&q=' + encodeURIComponent(q) : '');
      const res = await fetch(url);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.success === false || !data.data) {
        this._setSessionManagerMessage(list, data?.error || `Failed to load sessions (HTTP ${res.status})`);
        return;
      }
      const sessions = data.data.sessions || [];
      list.replaceChildren();
      if (sessions.length === 0) {
        this._setSessionManagerMessage(list, q ? 'No sessions match your search' : 'No sessions found');
        return;
      }
      for (const s of sessions) {
        const record = {
          sessionId: s.sessionId,
          workingDir: s.workingDir || '',
          sizeBytes: s.sizeBytes ?? 0,
          lastModified: new Date(s.lastActivityAt ?? s.createdAt ?? Date.now()).toISOString(),
          firstPrompt: s.firstPrompt || s.name || '',
          // COD-124: status/mode drive the Parked badge, idle-duration flag,
          // and the Park/Resume menu items in _buildHistoryItem/_openSessionRowMenu.
          status: s.status,
          mode: s.mode,
          name: s.name,
          claudeSessionId: s.claudeSessionId,
          pinned: s.pinned,
          pinnedAt: s.pinnedAt,
          // Must be carried explicitly: this record is a re-projection, so any
          // field omitted here silently vanishes from the Cmd+K list (#266).
          gitBranch: s.gitBranch,
          worktreeName: s.worktreeName,
          worktreeRepo: s.worktreeRepo,
        };
        const isLive = !!this.sessions?.has?.(s.sessionId);
        if (isLive) {
          // Enrich from the richer live-session cache — these fields aren't
          // part of UnifiedSessionItem (COD-124: resume-fidelity + obligation markers).
          const live = this.sessions.get(s.sessionId);
          record.nativeResumeId = live?.nativeResumeId;
          record.autoResumeAt = live?.autoResumeAt;
          record.autoResumeEnabled = live?.autoResumeEnabled;
          record.ralphEnabled = live?.ralphEnabled;
        }
        const item = this._buildHistoryItem(record, this.cases, {
          showViewAll: false,
          onActivate: () => {
            this.closeSessionManager();
            if (isLive) {
              void this.selectSession(s.sessionId);
            } else if (record.workingDir) {
              void this.resumeHistorySession(s.claudeSessionId || s.sessionId, record.workingDir);
            }
          },
        });
        list.appendChild(item);
      }
    } catch (err) {
      console.error('[_loadSessionManagerList]', err);
      this._setSessionManagerMessage(list, 'Failed to load sessions');
    }
  },

  setAwayDigestRange(range) {
    this.awayDigestRange = range;
    this._awayDigestLoadedSuccessfully = false;
    this.updateAwayDigestRangeControls();
    this.loadAwayDigest();
  },

  updateAwayDigestRangeControls() {
    const range = this.awayDigestRange || 'since-last-visit';
    document.querySelectorAll('[data-away-range]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.awayRange === range);
    });
    const customRange = document.getElementById('awayDigestCustomRange');
    if (customRange) customRange.classList.toggle('active', range === 'custom');
    if (range === 'custom') this.ensureAwayDigestCustomDefaults();
  },

  ensureAwayDigestCustomDefaults() {
    const sinceInput = document.getElementById('awayDigestCustomSince');
    const untilInput = document.getElementById('awayDigestCustomUntil');
    if (!sinceInput || !untilInput) return;

    const now = new Date();
    if (!untilInput.value) untilInput.value = this.formatAwayDigestDateTimeLocal(now);
    if (!sinceInput.value) {
      const since = new Date(now.getTime() - 60 * 60 * 1000);
      sinceInput.value = this.formatAwayDigestDateTimeLocal(since);
    }
  },

  formatAwayDigestDateTimeLocal(date) {
    const pad = value => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  },

  async loadAwayDigest() {
    const summaryEl = document.getElementById('awayDigestSummary');
    const freshnessEl = document.getElementById('awayDigestFreshness');
    const sectionsEl = document.getElementById('awayDigestSections');
    if (summaryEl) summaryEl.innerHTML = '<div class="away-digest-loading">Loading digest...</div>';
    if (freshnessEl) freshnessEl.textContent = '';
    if (sectionsEl) sectionsEl.innerHTML = '';

    try {
      const range = this.awayDigestRange || 'since-last-visit';
      const params = new URLSearchParams({ range });

      if (range === 'since-last-visit') {
        const lastViewed = this.readAwayDigestLastViewed();
        if (Number.isFinite(lastViewed)) params.set('lastViewed', String(lastViewed));
      }

      if (range === 'custom') {
        this.ensureAwayDigestCustomDefaults();
        const since = this.readAwayDigestDateTimeInput('awayDigestCustomSince');
        const until = this.readAwayDigestDateTimeInput('awayDigestCustomUntil');
        if (!Number.isFinite(since)) {
          throw new Error('Choose a custom start time');
        }
        params.set('since', String(since));
        if (Number.isFinite(until)) params.set('until', String(until));
      }

      const response = await fetch(`/api/away-digest?${params.toString()}`);
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to load away digest');
      }

      this._awayDigestLoadedSuccessfully = true;
      this._awayDigestGeneratedAt = data.digest.generatedAt;
      if (range === 'since-last-visit') {
        this._awayDigestSinceLastVisitGeneratedAt = data.digest.generatedAt;
      }
      this.renderAwayDigest(data.digest);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load away digest';
      console.error('Failed to fetch away digest:', err);
      if (summaryEl) summaryEl.innerHTML = '<div class="away-digest-load-error">Failed to load away digest</div>';
      if (sectionsEl) {
        sectionsEl.innerHTML = `<div class="empty-message">${escapeHtml(message)}</div>`;
      }
      this.showToast(message, 'error');
    }
  },

  readAwayDigestLastViewed() {
    try {
      const value = localStorage.getItem(AWAY_DIGEST_LAST_VIEWED_KEY);
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  },

  readAwayDigestDateTimeInput(id) {
    const input = document.getElementById(id);
    if (!input || !input.value) return undefined;
    const parsed = Date.parse(input.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  },

  renderAwayDigest(digest) {
    const summaryEl = document.getElementById('awayDigestSummary');
    const freshnessEl = document.getElementById('awayDigestFreshness');
    const sectionsEl = document.getElementById('awayDigestSections');
    if (!summaryEl || !freshnessEl || !sectionsEl) return;

    const inputTokens = digest.totals.inputTokens || 0;
    const outputTokens = digest.totals.outputTokens || 0;
    const estimatedCost = digest.totals.estimatedCost || 0;
    summaryEl.innerHTML = `
      <div class="away-digest-card">
        <span class="away-digest-card-label">Needs Attention</span>
        <span class="away-digest-card-value">${digest.totals.needsAttention}</span>
      </div>
      <div class="away-digest-card">
        <span class="away-digest-card-label">Completed</span>
        <span class="away-digest-card-value">${digest.totals.completed}</span>
      </div>
      <div class="away-digest-card">
        <span class="away-digest-card-label">Active Sessions</span>
        <span class="away-digest-card-value">${digest.totals.activeSessions}</span>
      </div>
      <div class="away-digest-card">
        <span class="away-digest-card-label">Tokens</span>
        <span class="away-digest-card-value">${this.formatTokens(inputTokens + outputTokens)}</span>
        <span class="away-digest-card-cost">~$${estimatedCost.toFixed(2)}</span>
      </div>
    `;

    const freshnessNotes = [];
    if (digest.dataFreshness.runSummariesLiveOnly || digest.dataFreshness.subagentsLiveOnly) {
      freshnessNotes.push('Run summaries and subagent completions use recent live state; lifecycle and token stats are persisted.');
    }
    if (digest.totals.tokenWindowPrecision === 'day') {
      freshnessNotes.push('Token totals are aggregated at day precision.');
    }
    freshnessEl.textContent = freshnessNotes.join(' ');

    sectionsEl.innerHTML = AWAY_DIGEST_SECTIONS
      .map(([key, title]) => this.renderAwayDigestSection(title, digest.sections[key] || []))
      .join('');
    this.attachAwayDigestActions();
  },

  renderAwayDigestSection(title, items) {
    const count = items.length;
    const body = count
      ? items.map(item => this.renderAwayDigestItem(item)).join('')
      : '<div class="away-digest-empty">No items</div>';
    return `
      <section class="away-digest-section">
        <div class="away-digest-section-title">
          <h4>${escapeHtml(title)}</h4>
          <span>${count}</span>
        </div>
        ${body}
      </section>
    `;
  },

  renderAwayDigestItem(item) {
    const sourceLabel = this.formatAwayDigestSource(item.source);
    const sessionLabel = item.sessionName || item.sessionId || '';
    const detail = item.detail ? `<div class="away-digest-item-detail">${escapeHtml(item.detail)}</div>` : '';
    const action = item.link ? `
      <button class="away-digest-action"
              data-away-link-type="${escapeHtml(item.link.type)}"
              data-away-session-id="${escapeHtml(item.link.sessionId || '')}">
        Open
      </button>
    ` : '';
    return `
      <article class="away-digest-item away-digest-${escapeHtml(item.severity)}">
        <div class="away-digest-item-main">
          <div class="away-digest-item-meta">
            <span>${escapeHtml(this.formatAwayDigestTimestamp(item.timestamp))}</span>
            <span>${escapeHtml(sourceLabel)}</span>
            ${sessionLabel ? `<span>${escapeHtml(sessionLabel)}</span>` : ''}
          </div>
          <div class="away-digest-item-title">${escapeHtml(item.title)}</div>
          ${detail}
        </div>
        ${action}
      </article>
    `;
  },

  attachAwayDigestActions() {
    const sectionsEl = document.getElementById('awayDigestSections');
    if (!sectionsEl) return;
    sectionsEl.querySelectorAll('[data-away-link-type]').forEach(button => {
      button.addEventListener('click', () => {
        this.openAwayDigestItem(button.dataset.awayLinkType, button.dataset.awaySessionId || undefined);
      });
    });
  },

  async openAwayDigestItem(type, sessionId) {
    if (type === 'session' && sessionId) {
      await this.selectSession(sessionId);
      this.closeAwayDigest();
      return;
    }
    if (type === 'run_summary' && sessionId) {
      await this.openRunSummary(sessionId);
      this.closeAwayDigest();
      return;
    }
    if (type === 'lifecycle') {
      this.openLifecycleLog();
      this.closeAwayDigest();
    }
  },

  formatAwayDigestTimestamp(timestamp) {
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  },

  formatAwayDigestSource(source) {
    const labels = {
      lifecycle: 'Lifecycle',
      run_summary: 'Run Summary',
      status: 'Status',
      token_stats: 'Token Stats',
      subagent: 'Subagent',
    };
    return labels[source] || source;
  },

  /**
   * COD-121: live-refresh the unified session list when sessions change
   * (created/updated/deleted via SSE). Only touches surfaces that are currently
   * showing — the open Session Manager modal and/or the visible welcome list —
   * and is debounced so an event burst collapses into one re-fetch. The current
   * search query is preserved.
   */
  _onSessionListMaybeChanged() {
    const modal = document.getElementById('sessionManagerModal');
    if (modal && modal.classList.contains('active')) {
      this._debouncedCall(
        'sessionManagerRefresh',
        () => this._loadSessionManagerList(this._sessionManagerQuery || ''),
        400
      );
    }
    const welcome = document.getElementById('welcomeOverlay');
    if (welcome && welcome.classList.contains('visible')) {
      this._debouncedCall('welcomeHistoryRefresh', () => this.loadHistorySessions(), 600);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Token Statistics Modal
  // ═══════════════════════════════════════════════════════════════

  async openTokenStats() {
    try {
      const response = await fetch('/api/token-stats');
      const data = await response.json();
      if (data.success) {
        this.renderTokenStats(data.data);
        document.getElementById('tokenStatsModal').classList.add('active');
      } else {
        this.showToast('Failed to load token stats', 'error');
      }
    } catch (err) {
      console.error('Failed to fetch token stats:', err);
      this.showToast('Failed to load token stats', 'error');
    }
  },

  renderTokenStats(data) {
    const { daily, totals } = data;

    // Calculate period totals
    const today = new Date().toISOString().split('T')[0];
    const todayData = daily.find(d => d.date === today) || { inputTokens: 0, outputTokens: 0, estimatedCost: 0 };

    // Last 7 days totals (for summary card)
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const last7Days = daily.filter(d => new Date(d.date) >= sevenDaysAgo);
    const weekInput = last7Days.reduce((sum, d) => sum + d.inputTokens, 0);
    const weekOutput = last7Days.reduce((sum, d) => sum + d.outputTokens, 0);
    const weekCost = this.estimateCost(weekInput, weekOutput);

    // Lifetime totals (from aggregate stats)
    const lifetimeInput = totals.totalInputTokens;
    const lifetimeOutput = totals.totalOutputTokens;
    const lifetimeCost = this.estimateCost(lifetimeInput, lifetimeOutput);

    // Render summary cards
    const summaryEl = document.getElementById('statsSummary');
    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-card-label">Today</span>
        <span class="stat-card-value">${this.formatTokens(todayData.inputTokens + todayData.outputTokens)}</span>
        <span class="stat-card-cost">~$${todayData.estimatedCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">7 Days</span>
        <span class="stat-card-value">${this.formatTokens(weekInput + weekOutput)}</span>
        <span class="stat-card-cost">~$${weekCost.toFixed(2)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-card-label">Lifetime</span>
        <span class="stat-card-value">${this.formatTokens(lifetimeInput + lifetimeOutput)}</span>
        <span class="stat-card-cost">~$${lifetimeCost.toFixed(2)}</span>
      </div>
    `;

    // Render bar chart (last 7 days)
    const chartEl = document.getElementById('statsChart');
    const daysEl = document.getElementById('statsChartDays');

    // Get last 7 days (fill gaps with empty data)
    const chartData = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const dayData = daily.find(d => d.date === dateStr);
      chartData.push({
        date: dateStr,
        dayName: date.toLocaleDateString('en-US', { weekday: 'short' }),
        tokens: dayData ? dayData.inputTokens + dayData.outputTokens : 0,
        cost: dayData ? dayData.estimatedCost : 0,
      });
    }

    // Find max for scaling
    const maxTokens = Math.max(...chartData.map(d => d.tokens), 1);

    chartEl.innerHTML = chartData.map(d => {
      const height = Math.max((d.tokens / maxTokens) * 100, 3);
      const tooltip = `${d.dayName}: ${this.formatTokens(d.tokens)} (~$${d.cost.toFixed(2)})`;
      return `<div class="bar" style="height: ${height}%" data-tooltip="${tooltip}"></div>`;
    }).join('');

    daysEl.innerHTML = chartData.map(d => `<span>${d.dayName}</span>`).join('');

    // Render table (last 14 days with data)
    const tableEl = document.getElementById('statsTable');
    const tableData = daily.slice(0, 14);

    if (tableData.length === 0) {
      tableEl.innerHTML = '<div class="stats-no-data">No usage data recorded yet</div>';
    } else {
      tableEl.innerHTML = `
        <div class="stats-table-header">
          <span>Date</span>
          <span>Input</span>
          <span>Output</span>
          <span>Cost</span>
        </div>
        ${tableData.map(d => {
          const dateObj = new Date(d.date + 'T00:00:00');
          const dateStr = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          return `
            <div class="stats-table-row">
              <span class="cell cell-date">${dateStr}</span>
              <span class="cell">${this.formatTokens(d.inputTokens)}</span>
              <span class="cell">${this.formatTokens(d.outputTokens)}</span>
              <span class="cell cell-cost">$${d.estimatedCost.toFixed(2)}</span>
            </div>
          `;
        }).join('')}
      `;
    }
  },

  closeTokenStats() {
    const modal = document.getElementById('tokenStatsModal');
    if (modal) {
      modal.classList.remove('active');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel (combined Mux Sessions + Background Tasks)
  // ═══════════════════════════════════════════════════════════════

  async toggleMonitorPanel() {
    const panel = document.getElementById('monitorPanel');
    const toggleBtn = document.getElementById('monitorToggleBtn');
    panel.classList.toggle('open');

    if (panel.classList.contains('open')) {
      // applyMonitorVisibility() sets inline display:none when the "Show Monitor"
      // setting is off — clear it so transient opens (session-tab task badge) work
      panel.style.display = '';
      // Load screens and start stats collection
      await this.loadMuxSessions();
      await fetch('/api/mux-sessions/stats/start', { method: 'POST' });
      this.renderTaskPanel();
      if (toggleBtn) toggleBtn.innerHTML = '&#x25BC;'; // Down arrow when open
    } else {
      // Stop stats collection when panel is closed
      await fetch('/api/mux-sessions/stats/stop', { method: 'POST' });
      if (toggleBtn) toggleBtn.innerHTML = '&#x25B2;'; // Up arrow when closed
    }
  },

  // Legacy alias for task panel toggle (used by session tab badge)
  toggleTaskPanel() {
    this.toggleMonitorPanel();
  },

  // ═══════════════════════════════════════════════════════════════
  // Monitor Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

  toggleMonitorDetach() {
    const panel = document.getElementById('monitorPanel');
    const detachBtn = document.getElementById('monitorDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon (two overlapping squares)
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon (squared plus - dock back)
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupMonitorDrag();
    }
  },

  setupMonitorDrag() {
    const panel = document.getElementById('monitorPanel');
    const header = document.getElementById('monitorPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  },

  // ═══════════════════════════════════════════════════════════════
  // Subagents Panel Detach & Drag
  // ═══════════════════════════════════════════════════════════════

  toggleSubagentsDetach() {
    const panel = document.getElementById('subagentsPanel');
    const detachBtn = document.getElementById('subagentsDetachBtn');

    if (panel.classList.contains('detached')) {
      // Re-attach to bottom
      panel.classList.remove('detached');
      panel.style.top = '';
      panel.style.left = '';
      panel.style.width = '';
      panel.style.height = '';
      if (detachBtn) {
        detachBtn.innerHTML = '&#x29C9;'; // Detach icon
        detachBtn.title = 'Detach panel';
      }
    } else {
      // Detach as floating window
      panel.classList.add('detached');
      panel.classList.add('open'); // Ensure it's visible
      if (detachBtn) {
        detachBtn.innerHTML = '&#x229E;'; // Attach icon
        detachBtn.title = 'Attach panel';
      }
      // Setup drag functionality
      this.setupSubagentsDrag();
    }
  },

  setupSubagentsDrag() {
    const panel = document.getElementById('subagentsPanel');
    const header = document.getElementById('subagentsPanelHeader');

    if (!panel || !header) return;

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onStart = (e) => {
      // Only drag from header, not from buttons
      if (e.target.closest('button')) return;
      if (!panel.classList.contains('detached')) return;

      isDragging = true;
      const coords = getEventCoords(e);
      startX = coords.clientX;
      startY = coords.clientY;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onEnd);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend', onEnd);
      e.preventDefault();
    };

    const onMove = (e) => {
      if (!isDragging) return;

      const coords = getEventCoords(e);
      const dx = coords.clientX - startX;
      const dy = coords.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // Keep within viewport bounds
      const rect = panel.getBoundingClientRect();
      newLeft = Math.max(0, Math.min(window.innerWidth - rect.width, newLeft));
      newTop = Math.max(0, Math.min(window.innerHeight - rect.height, newTop));

      panel.style.left = newLeft + 'px';
      panel.style.top = newTop + 'px';
    };

    const onEnd = () => {
      isDragging = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
    };

    // Remove existing listeners before adding new ones
    header.removeEventListener('mousedown', header._dragHandler);
    header.removeEventListener('touchstart', header._touchDragHandler);
    header._dragHandler = onStart;
    header._touchDragHandler = onStart;
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });
  },

  renderTaskPanel() {
    this._debouncedCall('taskPanel', this._renderTaskPanelImmediate);
  },

  _renderTaskPanelImmediate() {
    const session = this.sessions.get(this.activeSessionId);
    const body = document.getElementById('backgroundTasksBody');
    const stats = document.getElementById('taskPanelStats');
    const section = document.getElementById('backgroundTasksSection');

    if (!session || !session.taskTree || session.taskTree.length === 0) {
      // Hide the entire section when there are no background tasks
      if (section) section.style.display = 'none';
      body.innerHTML = '';
      stats.textContent = '0 tasks';
      return;
    }

    // Show the section when there are tasks
    if (section) section.style.display = '';

    const taskStats = session.taskStats || { running: 0, completed: 0, failed: 0, total: 0 };
    stats.textContent = `${taskStats.running} running, ${taskStats.completed} done`;

    // Render task tree recursively
    const renderTask = (task, allTasks) => {
      const statusIcon = task.status === 'running' ? '' :
                        task.status === 'completed' ? '&#x2713;' : '&#x2717;';
      const duration = task.endTime
        ? `${((task.endTime - task.startTime) / 1000).toFixed(1)}s`
        : `${((Date.now() - task.startTime) / 1000).toFixed(0)}s...`;

      let childrenHtml = '';
      if (task.children && task.children.length > 0) {
        childrenHtml = '<div class="task-children">';
        for (const childId of task.children) {
          // Find child task in allTasks map
          const childTask = allTasks.find(t => t.id === childId);
          if (childTask) {
            childrenHtml += `<div class="task-node">${renderTask(childTask, allTasks)}</div>`;
          }
        }
        childrenHtml += '</div>';
      }

      return `
        <div class="task-item">
          <span class="task-status-icon ${task.status}">${statusIcon}</span>
          <div class="task-info">
            <div class="task-description">${escapeHtml(task.description)}</div>
            <div class="task-meta">
              <span class="task-type">${task.subagentType}</span>
              <span>${duration}</span>
            </div>
          </div>
        </div>
        ${childrenHtml}
      `;
    };

    // Flatten all tasks for lookup
    const allTasks = this.flattenTaskTree(session.taskTree);

    // Render only root tasks (those without parents or with null parentId)
    let html = '<div class="task-tree">';
    for (const task of session.taskTree) {
      html += `<div class="task-node">${renderTask(task, allTasks)}</div>`;
    }
    html += '</div>';

    body.innerHTML = html;
  },

  flattenTaskTree(tasks, result = []) {
    for (const task of tasks) {
      result.push(task);
      // Children are stored as IDs, not nested objects in taskTree
      // The task tree from server already has the structure we need
    }
    return result;
  },


  // ═══════════════════════════════════════════════════════════════
  // Subagent Panel (Claude Code Background Agents)
  // ═══════════════════════════════════════════════════════════════

  // Legacy alias
  toggleSubagentPanel() {
    this.toggleSubagentsPanel();
  },

  updateSubagentBadge() {
    const badge = this.$('subagentCountBadge');
    const activeCount = Array.from(this.subagents.values()).filter(s => s.status === 'active' || s.status === 'idle').length;

    // Update badge with active count
    if (badge) {
      badge.textContent = activeCount > 0 ? activeCount : '';
    }
  },

  renderSubagentPanel() {
    // Debounce renders at 150ms to prevent excessive DOM updates from rapid subagent events
    if (this._subagentPanelRenderTimeout) {
      clearTimeout(this._subagentPanelRenderTimeout);
    }
    this._subagentPanelRenderTimeout = setTimeout(() => {
      scheduleBackground(() => this._renderSubagentPanelImmediate());
    }, 150);
  },

  _renderSubagentPanelImmediate() {
    const list = this.$('subagentList');
    if (!list) return;

    // Always update badge count
    this.updateSubagentBadge();

    // Always update monitor panel (even if subagent panel is hidden)
    this.renderMonitorSubagents();

    // If panel is not visible, don't render content
    if (!this.subagentPanelVisible) {
      return;
    }

    // Render subagent list
    if (this.subagents.size === 0) {
      list.innerHTML = '<div class="subagent-empty">No background agents detected</div>';
      return;
    }

    const html = [];
    const sorted = Array.from(this.subagents.values()).sort((a, b) => {
      // Active first, then by last activity
      if (a.status === 'active' && b.status !== 'active') return -1;
      if (b.status === 'active' && a.status !== 'active') return 1;
      return (b.lastActivityAt || 0) - (a.lastActivityAt || 0);
    });

    for (const agent of sorted) {
      const isActive = this.activeSubagentId === agent.agentId;
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const activity = this.subagentActivity.get(agent.agentId) || [];
      const lastActivity = activity[activity.length - 1];
      const lastTool = lastActivity?.type === 'tool' ? lastActivity.tool : null;
      const hasWindow = this.subagentWindows.has(agent.agentId);
      const canKill = agent.status === 'active' || agent.status === 'idle';
      const modelBadge = agent.modelShort
        ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
        : '';

      const teammateInfo = this.getTeammateInfo(agent);
      const displayName = teammateInfo ? teammateInfo.name : (agent.description || agent.agentId.substring(0, 7));
      const teammateBadge = this.getTeammateBadgeHtml(agent);
      const agentIcon = teammateInfo ? `<span class="subagent-icon teammate-dot teammate-color-${teammateInfo.color}">●</span>` : '<span class="subagent-icon">🤖</span>';
      html.push(`
        <div class="subagent-item ${statusClass} ${isActive ? 'selected' : ''}${teammateInfo ? ' is-teammate' : ''}"
             onclick="app.selectSubagent(${escapeHtml(JSON.stringify(agent.agentId))})"
             ondblclick="app.openSubagentWindow(${escapeHtml(JSON.stringify(agent.agentId))})"
             title="Double-click to open tracking window">
          <div class="subagent-header">
            ${agentIcon}
            <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(displayName.length > 40 ? displayName.substring(0, 40) + '...' : displayName)}</span>
            ${teammateBadge}
            ${modelBadge}
            <span class="subagent-status ${statusClass}">${agent.status}</span>
            ${canKill ? `<button class="subagent-kill-btn" onclick="event.stopPropagation(); app.killSubagent(${escapeHtml(JSON.stringify(agent.agentId))})" title="Kill agent">&#x2715;</button>` : ''}
            <button class="subagent-window-btn" onclick="event.stopPropagation(); app.${hasWindow ? 'closeSubagentWindow' : 'openSubagentWindow'}(${escapeHtml(JSON.stringify(agent.agentId))})" title="${hasWindow ? 'Close window' : 'Open in window'}">
              ${hasWindow ? '✕' : '⧉'}
            </button>
          </div>
          <div class="subagent-meta">
            <span class="subagent-tools">${agent.toolCallCount} tools</span>
            ${lastTool ? `<span class="subagent-last-tool">${this.getToolIcon(lastTool)} ${lastTool}</span>` : ''}
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  },

  selectSubagent(agentId) {
    this.activeSubagentId = agentId;
    this.renderSubagentPanel();
    this.renderSubagentDetail();
  },

  renderSubagentDetail() {
    const detail = this.$('subagentDetail');
    if (!detail) return;

    if (!this.activeSubagentId) {
      detail.innerHTML = '<div class="subagent-empty">Select an agent to view details</div>';
      return;
    }

    const agent = this.subagents.get(this.activeSubagentId);
    const activity = this.subagentActivity.get(this.activeSubagentId) || [];

    if (!agent) {
      detail.innerHTML = '<div class="subagent-empty">Agent not found</div>';
      return;
    }

    const activityHtml = activity.slice(-30).map(a => {
      const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
      if (a.type === 'tool') {
        const toolDetail = this.getToolDetailExpanded(a.tool, a.input, a.fullInput, a.toolUseId);
        return `<div class="subagent-activity tool" data-tool-use-id="${escapeHtml(a.toolUseId || '')}">
          <span class="time">${time}</span>
          <span class="icon">${this.getToolIcon(a.tool)}</span>
          <span class="name">${escapeHtml(a.tool)}</span>
          <span class="detail">${escapeHtml(toolDetail.primary)}</span>
          ${toolDetail.hasMore ? `<button class="tool-expand-btn" onclick="app.toggleToolParams(${escapeHtml(JSON.stringify(a.toolUseId))})">▶</button>` : ''}
          ${toolDetail.hasMore ? `<div class="tool-params-expanded" id="tool-params-${escapeHtml(a.toolUseId)}" style="display:none;"><pre>${escapeHtml(JSON.stringify(a.fullInput || a.input, null, 2))}</pre></div>` : ''}
        </div>`;
      } else if (a.type === 'tool_result') {
        const icon = a.isError ? '❌' : '📄';
        const statusClass = a.isError ? 'error' : '';
        const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
        const preview = a.preview.length > 80 ? a.preview.substring(0, 80) + '...' : a.preview;
        return `<div class="subagent-activity tool-result ${statusClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="name">${escapeHtml(a.tool || 'result')}</span>
          <span class="detail">${escapeHtml(preview)}${sizeInfo}</span>
        </div>`;
      } else if (a.type === 'progress') {
        // Check for hook events
        const isHook = a.hookEvent || a.hookName;
        const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
        const hookClass = isHook ? ' hook' : '';
        const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
        return `<div class="subagent-activity progress${hookClass}">
          <span class="time">${time}</span>
          <span class="icon">${icon}</span>
          <span class="detail">${escapeHtml(displayText)}</span>
        </div>`;
      } else if (a.type === 'message') {
        const preview = a.text.length > 100 ? a.text.substring(0, 100) + '...' : a.text;
        return `<div class="subagent-activity message">
          <span class="time">${time}</span>
          <span class="icon">💬</span>
          <span class="detail">${escapeHtml(preview)}</span>
        </div>`;
      }
      return '';
    }).join('');

    const detailTitle = agent.description || `Agent ${agent.agentId}`;
    const modelBadge = agent.modelShort
      ? `<span class="subagent-model-badge ${escapeHtml(agent.modelShort)}">${escapeHtml(agent.modelShort)}</span>`
      : '';
    const tokenStats = (agent.totalInputTokens || agent.totalOutputTokens)
      ? `<span>Tokens: ${this.formatTokenCount(agent.totalInputTokens || 0)}↓ ${this.formatTokenCount(agent.totalOutputTokens || 0)}↑</span>`
      : '';

    detail.innerHTML = `
      <div class="subagent-detail-header">
        <span class="subagent-id" title="${escapeHtml(agent.description || agent.agentId)}">${escapeHtml(detailTitle.length > 60 ? detailTitle.substring(0, 60) + '...' : detailTitle)}</span>
        ${modelBadge}
        <span class="subagent-status ${agent.status}">${agent.status}</span>
        <button class="subagent-transcript-btn" onclick="app.viewSubagentTranscript(${escapeHtml(JSON.stringify(agent.agentId))})">
          View Full Transcript
        </button>
      </div>
      <div class="subagent-detail-stats">
        <span>Tools: ${agent.toolCallCount}</span>
        <span>Entries: ${agent.entryCount}</span>
        <span>Size: ${(agent.fileSize / 1024).toFixed(1)}KB</span>
        ${tokenStats}
      </div>
      <div class="subagent-activity-log">
        ${activityHtml || '<div class="subagent-empty">No activity yet</div>'}
      </div>
    `;
  },

  toggleToolParams(toolUseId) {
    const el = document.getElementById(`tool-params-${toolUseId}`);
    if (!el) return;
    const btn = el.previousElementSibling;
    if (el.style.display === 'none') {
      el.style.display = 'block';
      if (btn) btn.textContent = '▼';
    } else {
      el.style.display = 'none';
      if (btn) btn.textContent = '▶';
    }
  },

  formatTokenCount(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
    if (count >= 1000) return (count / 1000).toFixed(1) + 'k';
    return count.toString();
  },

  formatBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + 'KB';
    return bytes + 'B';
  },

  getToolIcon(tool) {
    const icons = {
      WebSearch: '🔍',
      WebFetch: '🌐',
      Read: '📖',
      Write: '📝',
      Edit: '✏️',
      Bash: '💻',
      Glob: '📁',
      Grep: '🔎',
      Task: '🤖',
    };
    return icons[tool] || '🔧';
  },

  getToolDetail(tool, input) {
    if (!input) return '';
    if (tool === 'WebSearch' && input.query) return `"${input.query}"`;
    if (tool === 'WebFetch' && input.url) return input.url;
    if (tool === 'Read' && input.file_path) return input.file_path;
    if ((tool === 'Write' || tool === 'Edit') && input.file_path) return input.file_path;
    if (tool === 'Bash' && input.command) {
      const cmd = input.command;
      return cmd.length > 40 ? cmd.substring(0, 40) + '...' : cmd;
    }
    if (tool === 'Glob' && input.pattern) return input.pattern;
    if (tool === 'Grep' && input.pattern) return input.pattern;
    return '';
  },

  getToolDetailExpanded(tool, input, fullInput, toolUseId) {
    const primary = this.getToolDetail(tool, input);
    // Check if there are additional params beyond the primary one
    const primaryKeys = ['query', 'url', 'file_path', 'command', 'pattern'];
    const inputKeys = Object.keys(fullInput || input || {});
    const extraKeys = inputKeys.filter(k => !primaryKeys.includes(k));
    const hasMore = extraKeys.length > 0 || (fullInput && JSON.stringify(fullInput).length > 100);
    return { primary, hasMore, fullInput: fullInput || input };
  },

  async killSubagent(agentId) {
    try {
      const res = await this._apiDelete(`/api/subagents/${agentId}`);
      const data = await res?.json();
      if (data?.success) {
        // Update local state
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.status = 'completed';
          this.subagents.set(agentId, agent);
        }
        this.renderSubagentPanel();
        this.renderSubagentDetail();
        this.updateSubagentWindows();
        this.showToast(`Subagent ${agentId.substring(0, 7)} killed`, 'success');
      } else {
        this.showToast(data.error || 'Failed to kill subagent', 'error');
      }
    } catch (err) {
      console.error('Failed to kill subagent:', err);
      this.showToast('Failed to kill subagent: ' + err.message, 'error');
    }
  },

  async viewSubagentTranscript(agentId) {
    try {
      const res = await fetch(`/api/subagents/${agentId}/transcript?format=formatted`);
      const data = await res.json();

      if (!data.success) {
        alert('Failed to load transcript');
        return;
      }

      // Show in a modal or new window
      const content = data.data.formatted.join('\n');
      const win = window.open('', '_blank', 'width=800,height=600');
      win.document.write(`
        <html>
          <head>
            <title>Subagent ${escapeHtml(agentId)} Transcript</title>
            <style>
              body { background: #1a1a2e; color: #eee; font-family: monospace; padding: 20px; }
              pre { white-space: pre-wrap; word-wrap: break-word; }
            </style>
          </head>
          <body>
            <h2>Subagent ${escapeHtml(agentId)} Transcript (${data.data.entryCount} entries)</h2>
            <pre>${escapeHtml(content)}</pre>
          </body>
        </html>
      `);
    } catch (err) {
      console.error('Failed to load transcript:', err);
      alert('Failed to load transcript: ' + err.message);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Subagent Parent TAB Tracking
  // ═══════════════════════════════════════════════════════════════
  //
  // CRITICAL: This system tracks which TAB an agent window connects to.
  // The association is stored in `subagentParentMap` (agentId -> sessionId).
  // The sessionId IS the tab identifier (tabs have data-id="${sessionId}").
  // Once set, this association is PERMANENT and persisted across restarts.

  /**
   * Find and assign the parent TAB for a subagent.
   *
   * Matching strategy (in order):
   * 1. Use existing stored association from subagentParentMap (permanent)
   * 2. Match via claudeSessionId (agent.sessionId === session.claudeSessionId)
   * 3. FALLBACK: Use the currently active session (since that's where the user typed the command)
   *
   * Once found, the association is stored PERMANENTLY in subagentParentMap.
   */
  findParentSessionForSubagent(agentId) {
    // Check if we already have a permanent association
    if (this.subagentParentMap.has(agentId)) {
      // Already have a parent - update agent object from stored value
      const storedSessionId = this.subagentParentMap.get(agentId);
      // Verify the session still exists
      if (this.sessions.has(storedSessionId)) {
        const agent = this.subagents.get(agentId);
        if (agent && !agent.parentSessionId) {
          agent.parentSessionId = storedSessionId;
          const session = this.sessions.get(storedSessionId);
          if (session) {
            agent.parentSessionName = this.getSessionName(session);
          }
          this.subagents.set(agentId, agent);
          this.updateSubagentWindowParent(agentId);
        }
        return;
      }
      // Stored session no longer exists - clear and re-discover
      this.subagentParentMap.delete(agentId);
    }

    const agent = this.subagents.get(agentId);
    if (!agent) return;

    // Strategy 1: Match via claudeSessionId (most accurate)
    if (agent.sessionId) {
      for (const [sessionId, session] of this.sessions) {
        if (session.claudeSessionId === agent.sessionId) {
          // FOUND! Store this association PERMANENTLY
          this.setAgentParentSessionId(agentId, sessionId);
          this.updateSubagentWindowParent(agentId);
          this.updateSubagentWindowVisibility();
          this.updateConnectionLines();
          return;
        }
      }
    }

    // Strategy 2: FALLBACK - Use the currently active session
    // This works because agents spawn from where the user typed the command
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      this.setAgentParentSessionId(agentId, this.activeSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
      return;
    }

    // Strategy 3: If no active session, use the first session
    if (this.sessions.size > 0) {
      const firstSessionId = this.sessions.keys().next().value;
      this.setAgentParentSessionId(agentId, firstSessionId);
      this.updateSubagentWindowParent(agentId);
      this.updateSubagentWindowVisibility();
      this.updateConnectionLines();
    }
  },

  /**
   * Re-check all orphan subagents (those without a parent TAB) when a session updates.
   * Called when session:updated fires with claudeSessionId.
   *
   * Also re-validates existing associations when claudeSessionId becomes available,
   * in case the fallback association was wrong.
   */
  recheckOrphanSubagents() {
    let anyChanged = false;
    for (const [agentId, agent] of this.subagents) {
      // Check if this agent has no parent in the persistent map
      if (!this.subagentParentMap.has(agentId)) {
        this.findParentSessionForSubagent(agentId);
        if (this.subagentParentMap.has(agentId)) {
          anyChanged = true;
        }
      } else if (agent.sessionId) {
        // Agent has a stored parent, but check if we can now do a proper claudeSessionId match
        // This handles the case where fallback was used but now the real parent is known
        const storedParent = this.subagentParentMap.get(agentId);
        const storedSession = this.sessions.get(storedParent);

        // If the stored session doesn't have a matching claudeSessionId, try to find the real match
        if (storedSession && storedSession.claudeSessionId !== agent.sessionId) {
          for (const [sessionId, session] of this.sessions) {
            if (session.claudeSessionId === agent.sessionId) {
              // Found the real parent - update the association
              this.subagentParentMap.set(agentId, sessionId);
              agent.parentSessionId = sessionId;
              agent.parentSessionName = this.getSessionName(session);
              this.subagents.set(agentId, agent);
              this.updateSubagentWindowParent(agentId);
              anyChanged = true;
              break;
            }
          }
        }
      }
    }
    if (anyChanged) {
      this.saveSubagentParentMap();
      this.updateConnectionLines();
    }
  },

  /**
   * Update parentSessionName for all subagents belonging to a TAB.
   * Called when a session is renamed to keep cached names fresh.
   */
  updateSubagentParentNames(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const newName = this.getSessionName(session);

    // Skip iteration if name hasn't changed (avoids O(n) loop on every session:updated)
    const cachedName = this._parentNameCache?.get(sessionId);
    if (cachedName === newName) return;
    if (!this._parentNameCache) this._parentNameCache = new Map();
    this._parentNameCache.set(sessionId, newName);

    for (const [agentId, storedSessionId] of this.subagentParentMap) {
      if (storedSessionId === sessionId) {
        const agent = this.subagents.get(agentId);
        if (agent) {
          agent.parentSessionName = newName;
          this.subagents.set(agentId, agent);

          // Update the window header if open
          const windowData = this.subagentWindows.get(agentId);
          if (windowData) {
            const parentNameEl = windowData.element.querySelector('.subagent-window-parent .parent-name');
            if (parentNameEl) {
              parentNameEl.textContent = newName;
            }
          }
        }
      }
    }
  },

  /**
   * Add parent header to an agent window, showing which TAB it belongs to.
   */
  updateSubagentWindowParent(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (!windowData) return;

    // Get parent from persistent map (THE source of truth)
    const parentSessionId = this.subagentParentMap.get(agentId);
    if (!parentSessionId) return;

    const session = this.sessions.get(parentSessionId);
    const parentName = session ? this.getSessionName(session) : 'Unknown';

    // Check if parent header already exists
    const win = windowData.element;
    const existingParent = win.querySelector('.subagent-window-parent');
    if (existingParent) {
      // Update existing
      existingParent.dataset.parentSession = parentSessionId;
      const nameEl = existingParent.querySelector('.parent-name');
      if (nameEl) {
        nameEl.textContent = parentName;
        nameEl.onclick = () => this.selectSession(parentSessionId);
      }
      return;
    }

    // Insert new parent header after the main header
    const header = win.querySelector('.subagent-window-header');
    if (header) {
      const parentDiv = document.createElement('div');
      parentDiv.className = 'subagent-window-parent';
      parentDiv.dataset.parentSession = parentSessionId;
      parentDiv.innerHTML = `
        <span class="parent-label">from</span>
        <span class="parent-name" onclick="app.selectSession(${escapeHtml(JSON.stringify(parentSessionId))})">${escapeHtml(parentName)}</span>
      `;
      header.insertAdjacentElement('afterend', parentDiv);
    }
  },


  /**
   * Show/hide subagent windows based on active session.
   * Behavior controlled by "Subagents for Active Tab Only" setting.
   * Uses the PERSISTENT subagentParentMap for accurate tab-based visibility.
   */
  updateSubagentWindowVisibility() {
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;

    for (const [agentId, windowInfo] of this.subagentWindows) {
      // Get parent from PERSISTENT map (THE source of truth)
      const storedParent = this.subagentParentMap.get(agentId);
      const agent = this.subagents.get(agentId);
      const parentSessionId = storedParent || agent?.parentSessionId;

      // Determine visibility based on setting
      let shouldShow;
      if (activeTabOnly) {
        // Show if: no parent known yet, or parent matches active session
        const hasKnownParent = !!parentSessionId;
        shouldShow = !hasKnownParent || parentSessionId === this.activeSessionId;
      } else {
        // Show all windows (original behavior)
        shouldShow = true;
      }

      if (shouldShow) {
        // Show window (unless it was minimized by user)
        if (!windowInfo.minimized) {
          windowInfo.element.style.display = 'flex';
          // Lazily re-create teammate terminal if it was disposed when hidden
          if (windowInfo._lazyTerminal) {
            this._restoreTeammateTerminalFromLazy(agentId);
          }
        }
        windowInfo.hidden = false;
      } else {
        // Hide window (but don't close it)
        // Dispose teammate terminal to free memory while hidden on inactive tab
        this._disposeTeammateTerminalForMinimize(agentId);
        windowInfo.element.style.display = 'none';
        windowInfo.hidden = true;
      }
    }
    // Update connection lines after visibility changes
    this.updateConnectionLines();
    // Restack mobile windows after visibility changes
    this.relayoutMobileSubagentWindows();
  },


  // Close all subagent windows for a session (fully removes them, not minimize)
  // If cleanupData is true, also remove activity and toolResults data to prevent memory leaks
  closeSessionSubagentWindows(sessionId, cleanupData = false) {
    const toClose = [];
    for (const [agentId, _windowData] of this.subagentWindows) {
      const agent = this.subagents.get(agentId);
      // Check both subagent parentSessionId and subagentParentMap
      // (standalone pane windows use subagentParentMap, not subagents map)
      const parentFromMap = this.subagentParentMap.get(agentId);
      if (agent?.parentSessionId === sessionId || parentFromMap === sessionId) {
        toClose.push(agentId);
      }
    }
    for (const agentId of toClose) {
      this.forceCloseSubagentWindow(agentId);
      // Clean up activity and tool results data if requested (prevents memory leaks)
      if (cleanupData) {
        this.subagents.delete(agentId);
        this.subagentActivity.delete(agentId);
        this.subagentToolResults.delete(agentId);
        this.subagentParentMap.delete(agentId);
      }
    }
    // Also clean up minimized agents for this session
    this.minimizedSubagents.delete(sessionId);
    this.renderSessionTabs();
  },

  // Fully close a subagent window (removes from DOM, not minimize)
  forceCloseSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Clean up resize observer
      if (windowData.resizeObserver) {
        windowData.resizeObserver.disconnect();
      }
      // Clean up drag event listeners (both document-level and handle-level)
      if (windowData.dragListeners) {
        document.removeEventListener('mousemove', windowData.dragListeners.move);
        document.removeEventListener('mouseup', windowData.dragListeners.up);
        if (windowData.dragListeners.touchMove) {
          document.removeEventListener('touchmove', windowData.dragListeners.touchMove);
          document.removeEventListener('touchend', windowData.dragListeners.up);
          document.removeEventListener('touchcancel', windowData.dragListeners.up);
        }
        // Remove handle-level listeners before DOM removal
        if (windowData.dragListeners.handle) {
          windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
          windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
        }
      }
      windowData.element.remove();
      this.subagentWindows.delete(agentId);
    }
    // Clean up teammate terminal if present
    const termData = this.teammateTerminals.get(agentId);
    if (termData) {
      if (termData.resizeObserver) {
        termData.resizeObserver.disconnect();
      }
      if (termData.terminal) {
        try { termData.terminal.dispose(); } catch {}
      }
      this.teammateTerminals.delete(agentId);
    }
  },


  minimizeSubagentWindow(agentId) {
    const windowData = this.subagentWindows.get(agentId);
    if (windowData) {
      // Dispose teammate terminal on minimize to free DOM/memory (lazy re-creation on restore)
      this._disposeTeammateTerminalForMinimize(agentId);
      windowData.element.style.display = 'none';
      windowData.minimized = true;
      this.updateConnectionLines();
    }
  },


  // Debounced wrapper — coalesces rapid subagent events (tool_call, progress,
  // message) into a single DOM update per 100ms per agent window.
  scheduleSubagentWindowRender(agentId) {
    // Skip DOM updates for windows with lazy (disposed) terminals — they're minimized
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?.minimized) return;

    if (!this._subagentWindowRenderTimeouts) this._subagentWindowRenderTimeouts = new Map();
    if (this._subagentWindowRenderTimeouts.has(agentId)) {
      clearTimeout(this._subagentWindowRenderTimeouts.get(agentId));
    }
    this._subagentWindowRenderTimeouts.set(agentId, setTimeout(() => {
      this._subagentWindowRenderTimeouts.delete(agentId);
      scheduleBackground(() => this.renderSubagentWindowContent(agentId));
    }, 100));
  },

  renderSubagentWindowContent(agentId) {
    // Skip if this window has a live terminal (don't overwrite xterm with activity HTML)
    if (this.teammateTerminals.has(agentId)) return;
    // Skip if this window has a lazy (disposed) terminal — it will be re-created on restore
    const windowData = this.subagentWindows.get(agentId);
    if (windowData?._lazyTerminal) return;

    const body = document.getElementById(`subagent-window-body-${agentId}`);
    if (!body) return;

    const activity = this.subagentActivity.get(agentId) || [];

    if (activity.length === 0) {
      body.innerHTML = '<div class="subagent-empty">No activity yet</div>';
      return;
    }

    // Incremental rendering: track how many items are already rendered
    const renderedCount = body.dataset.renderedCount ? parseInt(body.dataset.renderedCount, 10) : 0;
    const maxItems = 100;
    const visibleActivity = activity.slice(-maxItems);

    // If activity was trimmed or this is a fresh render, do full rebuild
    if (renderedCount === 0 || renderedCount > visibleActivity.length || body.children.length === 0 ||
        (body.children.length === 1 && body.querySelector('.subagent-empty'))) {
      // Full rebuild
      const html = visibleActivity.map(a => this._renderActivityItem(a)).join('');
      body.innerHTML = html;
      body.dataset.renderedCount = String(visibleActivity.length);
    } else {
      // Incremental: only append new items
      const newItems = visibleActivity.slice(renderedCount);
      if (newItems.length > 0) {
        const newHtml = newItems.map(a => this._renderActivityItem(a)).join('');
        body.insertAdjacentHTML('beforeend', newHtml);
        body.dataset.renderedCount = String(visibleActivity.length);

        // Trim excess children from the front if over maxItems
        while (body.children.length > maxItems) {
          body.removeChild(body.firstChild);
        }
      }
    }

    body.scrollTop = body.scrollHeight;
  },

  _renderActivityItem(a) {
    const time = new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false });
    if (a.type === 'tool') {
      return `<div class="activity-line">
        <span class="time">${time}</span>
        <span class="tool-icon">${this.getToolIcon(a.tool)}</span>
        <span class="tool-name">${escapeHtml(a.tool)}</span>
        <span class="tool-detail">${escapeHtml(this.getToolDetail(a.tool, a.input))}</span>
      </div>`;
    } else if (a.type === 'tool_result') {
      const icon = a.isError ? '❌' : '📄';
      const statusClass = a.isError ? ' error' : '';
      const sizeInfo = a.contentLength > 500 ? ` (${this.formatBytes(a.contentLength)})` : '';
      const preview = a.preview.length > 60 ? a.preview.substring(0, 60) + '...' : a.preview;
      return `<div class="activity-line result-line${statusClass}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-name">${escapeHtml(a.tool || '→')}</span>
        <span class="tool-detail">${escapeHtml(preview)}${sizeInfo}</span>
      </div>`;
    } else if (a.type === 'progress') {
      const isHook = a.hookEvent || a.hookName;
      const icon = isHook ? '🪝' : (a.progressType === 'query_update' ? '⟳' : '✓');
      const displayText = isHook ? (a.hookName || a.hookEvent) : (a.query || a.progressType);
      return `<div class="activity-line progress-line${isHook ? ' hook-line' : ''}">
        <span class="time">${time}</span>
        <span class="tool-icon">${icon}</span>
        <span class="tool-detail">${escapeHtml(displayText)}</span>
      </div>`;
    } else if (a.type === 'message') {
      const preview = a.text.length > 150 ? a.text.substring(0, 150) + '...' : a.text;
      return `<div class="message-line">
        <span class="time">${time}</span> 💬 ${escapeHtml(preview)}
      </div>`;
    }
    return '';
  },

  // Update all open subagent windows
  updateSubagentWindows() {
    for (const agentId of this.subagentWindows.keys()) {
      this.renderSubagentWindowContent(agentId);
      this.updateSubagentWindowHeader(agentId);
    }
  },

  // Update subagent window header (title and status)
  updateSubagentWindowHeader(agentId) {
    const agent = this.subagents.get(agentId);
    if (!agent) return;

    const win = document.getElementById(`subagent-window-${agentId}`);
    if (!win) return;

    // Update title/id element with description if available
    const idEl = win.querySelector('.subagent-window-title .id');
    if (idEl) {
      const teammateInfo = this.getTeammateInfo(agent);
      const windowTitle = teammateInfo ? teammateInfo.name : (agent.description || agentId.substring(0, 7));
      const truncatedTitle = windowTitle.length > 50 ? windowTitle.substring(0, 50) + '...' : windowTitle;
      idEl.textContent = truncatedTitle;
    }

    // Add or update teammate badge
    let tmBadge = win.querySelector('.teammate-badge');
    const teammateInfo = this.getTeammateInfo(agent);
    if (teammateInfo && !tmBadge) {
      const titleContainer = win.querySelector('.subagent-window-title');
      if (titleContainer) {
        const badge = document.createElement('span');
        badge.className = `teammate-badge teammate-color-${teammateInfo.color}`;
        badge.title = `Team: ${teammateInfo.teamName}`;
        badge.textContent = `@${teammateInfo.name}`;
        const statusEl = titleContainer.querySelector('.status');
        if (statusEl) statusEl.insertAdjacentElement('beforebegin', badge);
      }
    }

    // Update full tooltip
    const titleContainer = win.querySelector('.subagent-window-title');
    if (titleContainer) {
      titleContainer.title = agent.description || agentId;
    }

    // Update or add model badge
    let modelBadge = win.querySelector('.subagent-window-title .subagent-model-badge');
    if (agent.modelShort) {
      if (!modelBadge) {
        modelBadge = document.createElement('span');
        modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
        const statusEl = win.querySelector('.subagent-window-title .status');
        if (statusEl) {
          statusEl.insertAdjacentElement('beforebegin', modelBadge);
        }
      }
      modelBadge.className = `subagent-model-badge ${agent.modelShort}`;
      modelBadge.textContent = agent.modelShort;
    }

    // Update status
    const statusEl = win.querySelector('.subagent-window-title .status');
    if (statusEl) {
      statusEl.className = `status ${agent.status}`;
      statusEl.textContent = agent.status;
    }
  },

  // Open windows for all active subagents
  openAllActiveSubagentWindows() {
    for (const [agentId, agent] of this.subagents) {
      if (agent.status === 'active' && !this.subagentWindows.has(agentId)) {
        this.openSubagentWindow(agentId);
      }
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Agent Teams
  // ═══════════════════════════════════════════════════════════════

  /** Initialize an xterm.js terminal for a teammate's tmux pane */
  initTeammateTerminal(agentId, paneInfo, windowElement) {
    const body = windowElement.querySelector('.subagent-window-body');
    if (!body) return;

    // Clear the activity log content
    body.innerHTML = '';
    body.classList.add('teammate-terminal-body');
    windowElement.classList.add('has-terminal');

    const sessionId = paneInfo.sessionId;

    // Buffer incoming terminal data until xterm is ready
    const pendingData = [];
    this.teammateTerminals.set(agentId, {
      terminal: null,
      fitAddon: null,
      paneTarget: paneInfo.paneTarget,
      sessionId,
      resizeObserver: null,
      pendingData,
    });

    // Defer terminal creation to next frame so the body element has computed dimensions
    requestAnimationFrame(() => {
      // Safety: if window was closed before we got here, bail out
      if (!document.contains(body)) {
        this.teammateTerminals.delete(agentId);
        return;
      }

      const terminal = new Terminal({
        theme: { ...window.codemanCurrentXtermTheme() },
        minimumContrastRatio: window.codemanCurrentSkinIsLight() ? 4.5 : 1,
        fontFamily: '"Fira Code", "Cascadia Code", "JetBrains Mono", "SF Mono", Monaco, monospace',
        fontSize: 12,
        lineHeight: 1.2,
        cursorBlink: true,
        cursorStyle: 'block',
        scrollback: DEFAULT_SCROLLBACK,
        allowTransparency: true,
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);

      if (typeof Unicode11Addon !== 'undefined') {
        try {
          const unicode11Addon = new Unicode11Addon.Unicode11Addon();
          terminal.loadAddon(unicode11Addon);
          terminal.unicode.activeVersion = '11';
        } catch (_e) { /* Unicode11 addon failed */ }
      }

      try {
        terminal.open(body);
      } catch (err) {
        console.warn('[TeammateTerminal] Failed to open terminal:', err);
        this.teammateTerminals.delete(agentId);
        return;
      }

      // Wait for terminal renderer to fully initialize before any writes.
      // xterm.js needs a few frames after open() before write() is safe.
      setTimeout(() => {
        try { fitAddon.fit(); } catch {}

        // Fetch initial pane buffer
        fetch(`/api/sessions/${sessionId}/teammate-pane-buffer/${encodeURIComponent(paneInfo.paneTarget)}`)
          .then(r => r.json())
          .then(resp => {
            if (resp.success && resp.data?.buffer) {
              try { terminal.write(resp.data.buffer); } catch {}
            }
          })
          .catch(err => console.error('[TeammateTerminal] Failed to fetch buffer:', err));

        // Flush any data that arrived while terminal was initializing
        for (const chunk of pendingData) {
          try { terminal.write(chunk); } catch {}
        }
        pendingData.length = 0;
      }, 100);

      // Forward keyboard input to the teammate's pane
      terminal.onData((data) => {
        fetch(`/api/sessions/${sessionId}/teammate-pane-input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paneTarget: paneInfo.paneTarget, input: data }),
        }).catch(err => console.error('[TeammateTerminal] Failed to send input:', err));
      });

      // Resize observer to refit terminal when window is resized
      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });
      });
      resizeObserver.observe(body);

      // Update the stored entry with the real terminal
      const entry = this.teammateTerminals.get(agentId);
      if (entry) {
        entry.terminal = terminal;
        entry.fitAddon = fitAddon;
        entry.resizeObserver = resizeObserver;
      }
    });
  },

  /** Open a standalone terminal window for a tmux-pane teammate (no subagent entry needed) */
  openTeammateTerminalWindow(paneData) {
    // Only open if the session has a tab in Codeman
    if (!this.sessions.has(paneData.sessionId)) return;

    // Use pane target as the unique ID for this window
    const windowId = `pane-${paneData.paneTarget}`;

    // If window already exists, focus it
    if (this.subagentWindows.has(windowId)) {
      const existing = this.subagentWindows.get(windowId);
      if (existing.hidden) {
        existing.element.style.display = 'flex';
        existing.hidden = false;
      }
      existing.element.style.zIndex = ++this.subagentWindowZIndex;
      if (existing.minimized) {
        this.restoreSubagentWindow(windowId);
      }
      return;
    }

    // Calculate position
    const windowCount = this.subagentWindows.size;
    const windowWidth = 550;
    const windowHeight = 400;
    const gap = 20;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const startX = 50;
    const startY = 120;
    const maxCols = Math.floor((viewportWidth - startX - 50) / (windowWidth + gap)) || 1;
    const maxRows = Math.floor((viewportHeight - startY - 50) / (windowHeight + gap)) || 1;
    const col = windowCount % maxCols;
    const row = Math.floor(windowCount / maxCols) % maxRows;
    let finalX = startX + col * (windowWidth + gap);
    let finalY = startY + row * (windowHeight + gap);
    finalX = Math.max(10, Math.min(finalX, viewportWidth - windowWidth - 10));
    finalY = Math.max(10, Math.min(finalY, viewportHeight - windowHeight - 10));

    // Color badge
    const colorClass = paneData.color || 'blue';

    // Create window element
    const win = document.createElement('div');
    win.className = 'subagent-window has-terminal';
    win.id = `subagent-window-${windowId}`;
    win.style.zIndex = ++this.subagentWindowZIndex;
    win.style.left = `${finalX}px`;
    win.style.top = `${finalY}px`;
    win.style.width = `${windowWidth}px`;
    win.style.height = `${windowHeight}px`;
    win.innerHTML = `
      <div class="subagent-window-header">
        <div class="subagent-window-title" title="Teammate terminal: ${escapeHtml(paneData.teammateName)} (pane ${paneData.paneTarget})">
          <span class="icon" style="color: var(--team-color-${colorClass}, #339af0)">⬤</span>
          <span class="id">${escapeHtml(paneData.teammateName)}</span>
          <span class="status running">terminal</span>
        </div>
        <div class="subagent-window-actions">
          <button onclick="app.closeSubagentWindow(${escapeHtml(JSON.stringify(windowId))})" title="Minimize to tab">─</button>
        </div>
      </div>
      <div class="subagent-window-body teammate-terminal-body" id="subagent-window-body-${windowId}">
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.subagent-window-header'));

    // Make resizable if method exists
    if (typeof this.makeWindowResizable === 'function') {
      this.makeWindowResizable(win);
    }

    // Check visibility based on active session
    const settings = this.loadAppSettingsFromStorage();
    const activeTabOnly = settings.subagentActiveTabOnly ?? true;
    const shouldHide = activeTabOnly && paneData.sessionId !== this.activeSessionId;

    // Store reference
    this.subagentWindows.set(windowId, {
      element: win,
      minimized: false,
      hidden: shouldHide,
      dragListeners,
      description: `Teammate: ${paneData.teammateName}`,
    });

    // Also add to subagentParentMap for tab-based visibility
    this.subagentParentMap.set(windowId, paneData.sessionId);

    if (shouldHide) {
      win.style.display = 'none';
    }

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.subagentWindowZIndex;
    });

    // Resize observer for connection lines
    const resizeObserver = new ResizeObserver(() => {
      this.updateConnectionLines();
    });
    resizeObserver.observe(win);
    this.subagentWindows.get(windowId).resizeObserver = resizeObserver;

    // Init the xterm.js terminal (lazy if hidden)
    if (shouldHide) {
      // Window starts hidden — defer terminal creation until visible (lazy init)
      const windowEntry = this.subagentWindows.get(windowId);
      if (windowEntry) {
        windowEntry._lazyTerminal = true;
        windowEntry._lazyPaneTarget = paneData.paneTarget;
        windowEntry._lazySessionId = paneData.sessionId;
      }
    } else {
      this.initTeammateTerminal(windowId, paneData, win);
    }

    // Animate in
    requestAnimationFrame(() => {
      win.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
      win.style.transform = 'scale(1)';
      win.style.opacity = '1';
    });
  },

  /** Rebuild the teammate lookup map from all team configs */
  rebuildTeammateMap() {
    this.teammateMap.clear();
    for (const [teamName, team] of this.teams) {
      for (const member of team.members) {
        if (member.agentType !== 'team-lead') {
          // Use name as key prefix for matching subagent descriptions
          this.teammateMap.set(member.name, {
            name: member.name,
            color: member.color || 'blue',
            teamName,
            agentId: member.agentId,
          });
        }
      }
    }
  },

  /** Check if a subagent is a teammate and return its info */
  getTeammateInfo(agent) {
    if (!agent?.description) return null;
    // Teammate descriptions start with <teammate-message teammate_id=
    const match = agent.description.match(/<teammate-message\s+teammate_id="?([^">\s]+)/);
    if (!match) return null;
    const teammateId = match[1];
    // Extract name from teammate_id (format: name@teamName)
    const name = teammateId.split('@')[0];
    return this.teammateMap.get(name) || { name, color: 'blue', teamName: 'unknown' };
  },

  /** Get teammate badge HTML for a subagent */
  getTeammateBadgeHtml(agent) {
    const info = this.getTeammateInfo(agent);
    if (!info) return '';
    return `<span class="teammate-badge teammate-color-${info.color}" title="Team: ${escapeHtml(info.teamName)}">@${escapeHtml(info.name)}</span>`;
  },

  /** Render the team tasks panel */
  renderTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (!panel) return;

    // Find team for active session
    let activeTeam = null;
    let activeTeamName = null;
    if (this.activeSessionId) {
      for (const [name, team] of this.teams) {
        if (team.leadSessionId === this.activeSessionId) {
          activeTeam = team;
          activeTeamName = name;
          break;
        }
      }
    }

    if (!activeTeam) {
      panel.style.display = 'none';
      return;
    }

    // Set initial position and make draggable on first show
    const wasHidden = panel.style.display === 'none';
    panel.style.display = 'flex';

    if (wasHidden && !this.teamTasksDragListeners) {
      // Position bottom-right
      const panelWidth = 360;
      const panelHeight = 300;
      panel.style.left = `${Math.max(10, window.innerWidth - panelWidth - 20)}px`;
      panel.style.top = `${Math.max(10, window.innerHeight - panelHeight - 70)}px`;
      // Make draggable
      const header = panel.querySelector('.team-tasks-header');
      if (header) {
        this.teamTasksDragListeners = this.makeWindowDraggable(panel, header);
      }
    }

    const tasks = this.teamTasks.get(activeTeamName) || [];
    const completed = tasks.filter(t => t.status === 'completed').length;
    const total = tasks.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

    const headerEl = panel.querySelector('.team-tasks-header-text');
    if (headerEl) {
      const teammateCount = activeTeam.members.filter(m => m.agentType !== 'team-lead').length;
      headerEl.textContent = `Team Tasks (${teammateCount} teammates)`;
    }

    const progressEl = panel.querySelector('.team-tasks-progress-fill');
    if (progressEl) {
      progressEl.style.width = `${pct}%`;
    }

    const progressText = panel.querySelector('.team-tasks-progress-text');
    if (progressText) {
      progressText.textContent = `${completed}/${total}`;
    }

    const listEl = panel.querySelector('.team-tasks-list');
    if (!listEl) return;

    if (tasks.length === 0) {
      listEl.innerHTML = '<div class="team-task-empty">No tasks yet</div>';
      return;
    }

    const html = tasks.map(task => {
      const statusIcon = task.status === 'completed' ? '✓' : task.status === 'in_progress' ? '◉' : '○';
      const statusClass = task.status.replace('_', '-');
      const ownerBadge = task.owner
        ? `<span class="team-task-owner teammate-color-${this.getTeammateColor(task.owner)}">${escapeHtml(task.owner)}</span>`
        : '';
      return `<div class="team-task-item ${statusClass}">
        <span class="team-task-status">${statusIcon}</span>
        <span class="team-task-subject">${escapeHtml(task.subject)}</span>
        ${ownerBadge}
      </div>`;
    }).join('');

    listEl.innerHTML = html;
  },

  /** Hide team tasks panel and clean up drag listeners */
  hideTeamTasksPanel() {
    const panel = document.getElementById('teamTasksPanel');
    if (panel) panel.style.display = 'none';
    if (this.teamTasksDragListeners) {
      document.removeEventListener('mousemove', this.teamTasksDragListeners.move);
      document.removeEventListener('mouseup', this.teamTasksDragListeners.up);
      if (this.teamTasksDragListeners.touchMove) {
        document.removeEventListener('touchmove', this.teamTasksDragListeners.touchMove);
        document.removeEventListener('touchend', this.teamTasksDragListeners.up);
        document.removeEventListener('touchcancel', this.teamTasksDragListeners.up);
      }
      if (this.teamTasksDragListeners.handle) {
        this.teamTasksDragListeners.handle.removeEventListener('mousedown', this.teamTasksDragListeners.handleMouseDown);
        this.teamTasksDragListeners.handle.removeEventListener('touchstart', this.teamTasksDragListeners.handleTouchStart);
      }
      this.teamTasksDragListeners = null;
    }
  },

  /** Get teammate color by name */
  getTeammateColor(name) {
    const info = this.teammateMap.get(name);
    return info?.color || 'blue';
  },


  // ═══════════════════════════════════════════════════════════════
  // Project Insights Panel (Bash Tools with Clickable File Paths)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Normalize a file path to its canonical form for comparison.
   * - Expands ~ to home directory approximation
   * - Resolves relative paths against working directory (case folder)
   * - Normalizes . and .. components
   */
  normalizeFilePath(path, workingDir) {
    if (!path) return '';

    let normalized = path.trim();
    const homeDir = '/home/' + (window.USER || 'user'); // Approximation

    // Expand ~ to home directory
    if (normalized.startsWith('~/')) {
      normalized = homeDir + normalized.slice(1);
    } else if (normalized === '~') {
      normalized = homeDir;
    }

    // If not absolute, resolve against working directory (case folder)
    if (!normalized.startsWith('/') && workingDir) {
      normalized = workingDir + '/' + normalized;
    }

    // Normalize path components (resolve . and ..)
    const parts = normalized.split('/');
    const stack = [];

    for (const part of parts) {
      if (part === '' || part === '.') {
        continue;
      } else if (part === '..') {
        if (stack.length > 1) {
          stack.pop();
        }
      } else {
        stack.push(part);
      }
    }

    return '/' + stack.join('/');
  },

  /**
   * Extract just the filename from a path.
   */
  getFilename(path) {
    const parts = path.split('/');
    return parts[parts.length - 1] || '';
  },

  /**
   * Check if a path is a "shallow root path" - an absolute path with only one
   * component after root (e.g., /test.txt, /file.log).
   * These are often typos where the user meant a relative path in the case folder.
   */
  isShallowRootPath(path) {
    if (!path.startsWith('/')) return false;
    const parts = path.split('/').filter(p => p !== '');
    return parts.length === 1;
  },

  /**
   * Check if a path is inside (or is) the working directory (case folder).
   */
  isPathInWorkingDir(path, workingDir) {
    if (!workingDir) return false;
    const normalized = this.normalizeFilePath(path, workingDir);
    return normalized.startsWith(workingDir + '/') || normalized === workingDir;
  },

  /**
   * Smart path equivalence check.
   * Two paths are considered equivalent if:
   * 1. They normalize to the same path (standard case)
   * 2. One is a "shallow root path" (e.g., /test.txt) and the other is the
   *    same filename inside the case folder - the shallow root path
   *    is likely a typo and they probably meant the same file.
   */
  pathsAreEquivalent(path1, path2, workingDir) {
    const norm1 = this.normalizeFilePath(path1, workingDir);
    const norm2 = this.normalizeFilePath(path2, workingDir);

    // Standard check: exact normalized match
    if (norm1 === norm2) return true;

    // Smart check: shallow root path vs case folder path with same filename
    const file1 = this.getFilename(norm1);
    const file2 = this.getFilename(norm2);

    if (file1 !== file2) return false; // Different filenames, can't be equivalent

    const shallow1 = this.isShallowRootPath(path1);
    const shallow2 = this.isShallowRootPath(path2);
    const inWorkDir1 = this.isPathInWorkingDir(norm1, workingDir);
    const inWorkDir2 = this.isPathInWorkingDir(norm2, workingDir);

    // If one is shallow root (e.g., /test.txt) and other is in case folder
    // with same filename, treat as equivalent (user likely made a typo)
    if (shallow1 && inWorkDir2) return true;
    if (shallow2 && inWorkDir1) return true;

    return false;
  },

  /**
   * Pick the "better" of two paths that resolve to the same file.
   * Prefers paths inside the case folder, longer/more explicit paths, and absolute paths.
   */
  pickBetterPath(path1, path2, workingDir) {
    // Prefer paths inside the case folder (working directory)
    if (workingDir) {
      const inWorkDir1 = this.isPathInWorkingDir(path1, workingDir);
      const inWorkDir2 = this.isPathInWorkingDir(path2, workingDir);
      if (inWorkDir1 && !inWorkDir2) return path1;
      if (inWorkDir2 && !inWorkDir1) return path2;
    }

    // Prefer absolute paths
    const abs1 = path1.startsWith('/');
    const abs2 = path2.startsWith('/');
    if (abs1 && !abs2) return path1;
    if (abs2 && !abs1) return path2;

    // Both absolute or both relative - prefer longer (more explicit)
    if (path1.length !== path2.length) {
      return path1.length > path2.length ? path1 : path2;
    }

    // Prefer paths without ~
    if (!path1.includes('~') && path2.includes('~')) return path1;
    if (!path2.includes('~') && path1.includes('~')) return path2;

    return path1;
  },

  /**
   * Deduplicate file paths across all tools, keeping the "best" version.
   * Uses smart equivalence checking:
   * - Standard normalization for relative vs absolute paths
   * - Detects likely typos (e.g., /file.txt when caseFolder/file.txt exists)
   * - Prefers paths inside the case folder (working directory)
   * - Prefers longer, more explicit paths
   * Returns a Map of normalized path -> best raw path.
   */
  deduplicateProjectInsightPaths(tools, workingDir) {
    // Collect all paths with their tool IDs
    const allPaths = [];
    for (const tool of tools) {
      for (const rawPath of tool.filePaths) {
        allPaths.push({ rawPath, toolId: tool.id });
      }
    }

    if (allPaths.length <= 1) {
      const pathMap = new Map();
      for (const p of allPaths) {
        pathMap.set(this.normalizeFilePath(p.rawPath, workingDir), p);
      }
      return pathMap;
    }

    // Sort paths: prefer paths in case folder first, then by length (longer first)
    allPaths.sort((a, b) => {
      const aInWorkDir = this.isPathInWorkingDir(a.rawPath, workingDir);
      const bInWorkDir = this.isPathInWorkingDir(b.rawPath, workingDir);
      if (aInWorkDir && !bInWorkDir) return -1;
      if (bInWorkDir && !aInWorkDir) return 1;
      return b.rawPath.length - a.rawPath.length; // Longer paths first
    });

    const result = new Map(); // normalized -> { rawPath, toolId }
    const seenNormalized = new Set();

    for (const { rawPath, toolId } of allPaths) {
      const normalized = this.normalizeFilePath(rawPath, workingDir);

      // Check if we've already seen an equivalent path
      let isDuplicate = false;
      for (const [, existing] of result) {
        if (this.pathsAreEquivalent(rawPath, existing.rawPath, workingDir)) {
          isDuplicate = true;
          break;
        }
      }

      if (!isDuplicate && !seenNormalized.has(normalized)) {
        result.set(normalized, { rawPath, toolId });
        seenNormalized.add(normalized);
      }
    }

    return result;
  },

  handleBashToolStart(sessionId, tool) {
    let tools = this.projectInsights.get(sessionId) || [];
    // Add new tool
    tools = tools.filter(t => t.id !== tool.id);
    tools.push(tool);
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  },

  handleBashToolEnd(sessionId, tool) {
    const tools = this.projectInsights.get(sessionId) || [];
    const existing = tools.find(t => t.id === tool.id);
    if (existing) {
      existing.status = 'completed';
    }
    this.renderProjectInsightsPanel();
    // Remove after a short delay
    setTimeout(() => {
      const current = this.projectInsights.get(sessionId) || [];
      this.projectInsights.set(sessionId, current.filter(t => t.id !== tool.id));
      this.renderProjectInsightsPanel();
    }, 2000);
  },

  handleBashToolsUpdate(sessionId, tools) {
    this.projectInsights.set(sessionId, tools);
    this.renderProjectInsightsPanel();
  },

  renderProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    const list = this.$('projectInsightsList');
    if (!panel || !list) return;

    // Check if panel is enabled in settings
    const settings = this.loadAppSettingsFromStorage();
    const showProjectInsights = settings.showProjectInsights ?? false;
    if (!showProjectInsights) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    // Get tools for active session only
    const tools = this.projectInsights.get(this.activeSessionId) || [];
    const runningTools = tools.filter(t => t.status === 'running');

    if (runningTools.length === 0) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
      return;
    }

    panel.classList.add('visible');
    this.projectInsightsPanelVisible = true;

    // Get working directory for path normalization
    const session = this.sessions.get(this.activeSessionId);
    const workingDir = session?.workingDir || this.currentSessionWorkingDir;

    // Smart deduplication: collect all unique paths across all tools
    // Paths that resolve to the same file are deduplicated, keeping the most complete version
    const deduplicatedPaths = this.deduplicateProjectInsightPaths(runningTools, workingDir);

    // Build a set of paths to show (only the best version of each unique file)
    const pathsToShow = new Set(Array.from(deduplicatedPaths.values()).map(p => p.rawPath));

    const html = [];
    for (const tool of runningTools) {
      // Filter this tool's paths to only include those that weren't deduplicated away
      const filteredPaths = tool.filePaths.filter(p => pathsToShow.has(p));

      // Skip tools with no paths to show (all were duplicates of better paths elsewhere)
      if (filteredPaths.length === 0) continue;

      const cmdDisplay = tool.command.length > 50
        ? tool.command.substring(0, 50) + '...'
        : tool.command;

      html.push(`
        <div class="project-insight-item" data-tool-id="${tool.id}">
          <div class="project-insight-command">
            <span class="icon">💻</span>
            <span class="cmd" title="${escapeHtml(tool.command)}">${escapeHtml(cmdDisplay)}</span>
            <span class="project-insight-status ${tool.status}">${tool.status}</span>
            ${tool.timeout ? `<span class="project-insight-timeout">${escapeHtml(tool.timeout)}</span>` : ''}
          </div>
          <div class="project-insight-paths">
      `);

      for (const path of filteredPaths) {
        const fileName = path.split('/').pop();
        html.push(`
            <span class="project-insight-filepath"
                  onclick="app.openLogViewerWindow(${escapeHtml(JSON.stringify(path))}, ${escapeHtml(JSON.stringify(tool.sessionId))})"
                  title="${escapeHtml(path)}">${escapeHtml(fileName)}</span>
        `);
      }

      html.push(`
          </div>
        </div>
      `);
    }

    list.innerHTML = html.join('');
  },

  closeProjectInsightsPanel() {
    const panel = this.$('projectInsightsPanel');
    if (panel) {
      panel.classList.remove('visible');
      this.projectInsightsPanelVisible = false;
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // File Browser Panel
  // ═══════════════════════════════════════════════════════════════

  updateFileBrowserHeaderButton() {
    const button = this.$('fileBrowserBtn');
    if (!button) return;

    const panel = this.$('fileBrowserPanel');
    const hasActiveSession = Boolean(this.activeSessionId);
    const isOpen = hasActiveSession && Boolean(panel?.classList.contains('visible'));
    button.disabled = !hasActiveSession;
    button.classList.toggle('active', isOpen);
    button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  },

  toggleFileBrowserPanel() {
    if (!this.activeSessionId) return;
    const panel = this.$('fileBrowserPanel');
    if (!panel) return;

    if (panel.classList.contains('visible')) {
      this.closeFileBrowserPanel();
    } else {
      this.showFileBrowserPanel(this.activeSessionId);
    }
  },

  showConfiguredFileBrowserPanel(sessionId) {
    const settings = this.loadAppSettingsFromStorage();
    const panel = this.$('fileBrowserPanel');
    if (settings.showFileBrowser && !panel?.classList.contains('visible')) {
      this.showFileBrowserPanel(sessionId);
    }
  },

  // Reveal the file browser panel and load the given session's files. This is the
  // ONE canonical reveal path — it does NOT consult the `showFileBrowser` App Setting
  // (that setting only gates whether settings-ui.js calls this on settings apply).
  // An explicit user action (Session Manager → ⋯ → Open folder) always reveals.
  showFileBrowserPanel(sessionId) {
    const panel = this.$('fileBrowserPanel');
    if (!panel) return;
    panel.classList.add('visible');
    this.updateFileBrowserHeaderButton?.();
    // Attach drag listeners if not already attached
    if (!this.fileBrowserDragListeners) {
      const header = panel.querySelector('.file-browser-header');
      if (header) {
        // Convert right-positioned to left/top before drag so makeWindowDraggable works
        const onFirstDrag = () => {
          if (!panel.style.left) {
            const rect = panel.getBoundingClientRect();
            panel.style.left = `${rect.left}px`;
            panel.style.top = `${rect.top}px`;
            panel.style.right = 'auto';
          }
        };
        header.addEventListener('mousedown', onFirstDrag);
        header.addEventListener('touchstart', onFirstDrag, { passive: true });
        this.fileBrowserDragListeners = this.makeWindowDraggable(panel, header);
        this.fileBrowserDragListeners._onFirstDrag = onFirstDrag;
      }
    }
    this._wireFileBrowserDrop?.();
    // Load LAST: panel + #fileBrowserTree now exist, so loadFileBrowser won't early-return.
    this.loadFileBrowser(sessionId);
  },

  // Hidden files/folders (dot-prefixed) are filtered SERVER-side by
  // GET /api/sessions/:id/files, so the toggle re-fetches rather than
  // re-rendering the cached tree (issue #221). The flag is per-device and lives
  // in its own localStorage key instead of the app-settings object: that object
  // is rebuilt from the settings-modal DOM on every save, so a key toggled from
  // outside the modal would be dropped the next time settings are saved.
  _loadFileBrowserShowHidden() {
    try {
      return localStorage.getItem(FILE_BROWSER_SHOW_HIDDEN_KEY) === '1';
    } catch {
      return false;
    }
  },

  _syncFileBrowserHiddenBtn() {
    const btn = this.$('fileBrowserHiddenBtn');
    if (!btn) return;
    const on = this.fileBrowserShowHidden === true;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', String(on));
    const label = on ? 'Hide hidden files and folders' : 'Show hidden files and folders';
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  },

  async toggleFileBrowserHidden() {
    this.fileBrowserShowHidden = !this.fileBrowserShowHidden;
    try {
      localStorage.setItem(FILE_BROWSER_SHOW_HIDDEN_KEY, this.fileBrowserShowHidden ? '1' : '0');
    } catch {}
    this._syncFileBrowserHiddenBtn();
    // Expanded-directory state is deliberately preserved so toggling does not
    // collapse the tree the user just navigated.
    if (this.activeSessionId) await this.loadFileBrowser(this.activeSessionId);
  },

  async loadFileBrowser(sessionId) {
    if (!sessionId) return;

    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    // Optional-call for the same reason as updateFileBrowserHeaderButton?.() above:
    // the COD-231 ownership tests drive this method on partial host objects.
    this._syncFileBrowserHiddenBtn?.();
    if (!treeEl) return;

    const loadGeneration = ++this.fileBrowserLoadGeneration;

    // A fresh tree load supersedes any in-flight search state (COD-236).
    this.fileBrowserSearchMode = false;
    this.fileBrowserMatches = null;

    // Show loading state
    treeEl.innerHTML = '<div class="file-browser-loading">Loading files...</div>';

    try {
      const showHidden = this.fileBrowserShowHidden === true;
      const res = await fetch(`/api/sessions/${sessionId}/files?depth=5&showHidden=${showHidden}`);
      if (!res.ok) throw new Error('Failed to load files');

      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load files');
      if (loadGeneration !== this.fileBrowserLoadGeneration) return;

      // Keep the rendered tree bound to the session that produced it. The active
      // terminal tab can change independently while this panel remains open.
      const isNewSession = this.fileBrowserSessionId !== sessionId;
      this.fileBrowserSessionId = sessionId;
      this.fileBrowserData = result.data;
      this.fileBrowserLoadedDirs = new Set();
      if (isNewSession) this.fileBrowserCurrentDir = '';
      this.renderFileBrowserTree();

      // Update status — include current dir if set
      if (statusEl) {
        const { totalFiles, totalDirectories, truncated } = result.data;
        const base = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
        const dir = this.fileBrowserCurrentDir || '';
        statusEl.textContent = dir ? `${base} · in ${dir}${showHidden ? ' · hidden shown' : ''}` : `${base}${showHidden ? ' · hidden shown' : ''}`;
      }
    } catch (err) {
      if (loadGeneration !== this.fileBrowserLoadGeneration) return;
      console.error('Failed to load file browser:', err);
      treeEl.innerHTML = `<div class="file-browser-empty">Failed to load files: ${escapeHtml(err.message)}</div>`;
    }
  },

  renderFileBrowserTree() {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !this.fileBrowserData || !this.fileBrowserSessionId) return;

    const { tree } = this.fileBrowserData;
    const fileBrowserSessionId = this.fileBrowserSessionId;
    if (!tree || tree.length === 0) {
      treeEl.innerHTML = '<div class="file-browser-empty">No files found</div>';
      return;
    }

    const html = [];
    const filter = this.fileBrowserFilter.toLowerCase();

    const renderNode = (node, depth) => {
      const isDir = node.type === 'directory';
      const isExpanded = this.fileBrowserExpandedDirs.has(node.path);
      const matchesFilter = !filter || node.name.toLowerCase().includes(filter);

      // For directories, check if any children match
      let hasMatchingChildren = false;
      if (isDir && filter && node.children) {
        hasMatchingChildren = this.hasMatchingChild(node, filter);
      }

      const shouldShow = matchesFilter || hasMatchingChildren;
      const hiddenClass = !shouldShow && filter ? ' hidden-by-filter' : '';

      const icon = isDir
        ? (isExpanded ? '\uD83D\uDCC2' : '\uD83D\uDCC1')
        : this.getFileIcon(node.extension);

      const expandIcon = isDir
        ? `<span class="file-tree-expand${isExpanded ? ' expanded' : ''}">\u25B6</span>`
        : '<span class="file-tree-expand"></span>';

      const sizeStr = !isDir && node.size !== undefined
        ? `<span class="file-tree-size">${this.formatFileSize(node.size)}</span>`
        : '';

      const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';

      // COD-233: keep a real href for graceful fallback (middle-click / new tab),
      // but the click is intercepted below and routed through a guarded fetch so a
      // server error surfaces as a toast instead of navigating the SPA to the raw
      // JSON error body. data-path drives the interceptor.
      const downloadBtn = !isDir
        ? `<a class="file-tree-download" href="/api/sessions/${encodeURIComponent(fileBrowserSessionId)}/file-raw?path=${encodeURIComponent(node.path)}&download=true" data-path="${escapeHtml(node.path)}" title="Download" role="button">&#x2B07;</a>`
        : '';
      const renameBtn = `<button class="file-tree-rename" data-path="${escapeHtml(node.path)}" title="Rename" aria-label="Rename">✎</button>`;
      const deleteBtn = `<button class="file-tree-delete" data-path="${escapeHtml(node.path)}" title="Delete" aria-label="Delete">🗑</button>`;

      html.push(`
        <div class="file-tree-item${hiddenClass}" data-path="${escapeHtml(node.path)}" data-type="${node.type}" data-depth="${depth}">
          ${expandIcon}
          <span class="file-tree-icon">${icon}</span>
          <span class="${nameClass}">${escapeHtml(node.name)}</span>
          ${sizeStr}
          ${downloadBtn}${renameBtn}${deleteBtn}
        </div>
      `);

      // Render children if directory is expanded
      if (isDir && isExpanded && node.children) {
        for (const child of node.children) {
          renderNode(child, depth + 1);
        }
      }
    };

    for (const node of tree) {
      renderNode(node, 0);
    }

    treeEl.innerHTML = html.join('');

    // Add click handlers
    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', (e) => {
        // Ignore clicks on action buttons
        if (e.target && e.target.closest && e.target.closest('.file-tree-rename, .file-tree-delete, .file-tree-download')) return;
        const path = item.dataset.path;
        const type = item.dataset.type;

        if (type === 'directory') {
          this.toggleFileBrowserFolder(path);
        } else {
          this.openFilePreview(path, fileBrowserSessionId);
        }
      });
    });

    // COD-233: intercept download clicks so a server error (a JSON ApiResponse
    // envelope, not a file) surfaces as a toast instead of navigating the SPA to
    // the raw endpoint and rendering JSON over the terminal.
    treeEl.querySelectorAll('.file-tree-download').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.downloadWorkspaceFile(fileBrowserSessionId, btn.dataset.path);
      });
    });
    treeEl.querySelectorAll('.file-tree-rename').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.renameFileBrowserEntry(btn.dataset.path);
      });
    });
    treeEl.querySelectorAll('.file-tree-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.deleteFileBrowserEntry(btn.dataset.path);
      });
    });
  },

  /**
   * COD-233: download a workspace file via fetch so a non-2xx response (which
   * file-raw returns as a JSON error envelope, not a file) surfaces as a toast
   * instead of a top-level navigation that replaces the terminal with raw JSON.
   * On success the blob is saved through a temporary download anchor.
   */
  async downloadWorkspaceFile(sessionId, path) {
    if (!sessionId || !path) return;
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/file-raw?path=${encodeURIComponent(path)}&download=true`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        let message = `Download failed (${res.status})`;
        try {
          const body = await res.json();
          if (body && body.error) message = body.error;
        } catch {
          // Non-JSON error body; keep the status-based message.
        }
        this.showToast(message, 'error');
        return;
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = path.split('/').pop() || 'download';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      this.showToast(`Download failed: ${err && err.message ? err.message : err}`, 'error');
    }
  },

  // ──────────────────────────────────────────────────────────────────
  // File Browser Upload (COD-317)
  // ──────────────────────────────────────────────────────────────────
  _maxBatchFileUploads: 10,
  _fileBrowserUploadConcurrency: 3,

  triggerFileBrowserUpload(targetDir = '') {
    if (!this.activeSessionId && !this.fileBrowserSessionId) {
      this.showToast('No active session', 'error');
      return;
    }
    // Default to current folder when no explicit target (e.g. header button)
    const effectiveDir =
      typeof targetDir === 'string' && targetDir !== '' ? targetDir : this.fileBrowserCurrentDir || '';
    this._ensureFileBrowserUploadInput(effectiveDir);
    if (this._fileBrowserUploadInput) {
      this._fileBrowserUploadTargetDir = effectiveDir;
      this._fileBrowserUploadInput.click();
    }
  },

  _ensureFileBrowserUploadInput(initialDir = '') {
    if (this._fileBrowserUploadInput) {
      this._fileBrowserUploadTargetDir = initialDir;
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.display = 'none';
    // No accept filter — File Manager is open (any file except blocked/sensitive guard)
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      const targetDir = this._fileBrowserUploadTargetDir || '';
      input.value = '';
      if (files.length) this._uploadFilesToFileBrowser(files, targetDir);
    });
    document.body.appendChild(input);
    this._fileBrowserUploadInput = input;
    this._fileBrowserUploadTargetDir = initialDir;
  },

  async _uploadFilesToFileBrowser(fileList, targetDir = '') {
    const sessionId = this.fileBrowserSessionId || this.activeSessionId;
    if (!sessionId) {
      this.showToast('No active session', 'error');
      return;
    }
    let files = Array.from(fileList || []);
    if (files.length === 0) return;
    let capped = false;
    if (files.length > this._maxBatchFileUploads) {
      files = files.slice(0, this._maxBatchFileUploads);
      capped = true;
    }
    const total = files.length;
    let done = 0;
    let failed = 0;
    const results = new Array(total);
    const progress = () => this.showToast(`Uploading ${Math.min(done + 1, total)}/${total} file${total > 1 ? 's' : ''}…`, 'info');
    progress();
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        try {
          results[i] = await this._uploadFileToWorkspace(sessionId, files[i], targetDir);
        } catch (err) {
          failed++;
          console.warn('File upload failed:', err);
          results[i] = null;
        } finally {
          done++;
          if (done < total) progress();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this._fileBrowserUploadConcurrency, total) }, () => worker())
    );
    const succeeded = results.filter(Boolean).length;
    // Refresh tree preserves expanded state; loadFileBrowser already does that
    try {
      await this.loadFileBrowser(sessionId);
      if (succeeded > 0 && targetDir) {
        // Ensure uploaded-to folder is visible after reload
        this.fileBrowserExpandedDirs.add(targetDir);
        // Walk up to ensure parents are expanded as well
        let p = targetDir;
        while (p.includes('/')) {
          p = p.split('/').slice(0, -1).join('/');
          if (p) this.fileBrowserExpandedDirs.add(p);
        }
        this.fileBrowserCurrentDir = targetDir;
        this.renderFileBrowserTree();
        this._updateFileBrowserStatus?.();
      }
    } catch {}
    const parts = [];
    if (succeeded > 0) parts.push(`${succeeded} file${succeeded > 1 ? 's' : ''} uploaded`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (capped) parts.push(`max ${this._maxBatchFileUploads} per batch`);
    const tone = succeeded > 0 ? (failed > 0 || capped ? 'info' : 'success') : 'error';
    this.showToast(parts.join(' · ') || 'No files uploaded', tone);
  },

  async _uploadFileToWorkspace(sessionId, file, targetDir = '') {
    const form = new FormData();
    form.append('file', file);
    const query = targetDir ? `?path=${encodeURIComponent(targetDir)}` : '';
    const url = `/api/sessions/${encodeURIComponent(sessionId)}/files/upload${query}`;
    const resp = await fetch(url, { method: 'POST', body: form });
    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        if (data && data.error) msg = data.error;
      } catch {}
      throw new Error(msg);
    }
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'Upload failed');
    return data.data && data.data.path;
  },

  _wireFileBrowserDrop() {
    const treeEl = this.$('fileBrowserTree');
    const panel = this.$('fileBrowserPanel');
    if (!treeEl || !panel || this._fileBrowserDropWired) return;
    this._fileBrowserDropWired = true;
    let dragDepth = 0;
    treeEl.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      if (dragDepth === 0) treeEl.classList.add('file-browser-drag-active');
    });
    treeEl.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth++;
    });
    treeEl.addEventListener('dragleave', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) treeEl.classList.remove('file-browser-drag-active');
      // Also handle leaving panel entirely
      if (!panel.contains(e.relatedTarget)) {
        dragDepth = 0;
        treeEl.classList.remove('file-browser-drag-active');
      }
    });
    treeEl.addEventListener('drop', (e) => {
      dragDepth = 0;
      treeEl.classList.remove('file-browser-drag-active');
      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      let targetDir = '';
      const folderEl = e.target && e.target.closest ? e.target.closest('.file-tree-item[data-type="directory"]') : null;
      if (folderEl && folderEl.dataset && folderEl.dataset.path) targetDir = folderEl.dataset.path;
      this._uploadFilesToFileBrowser(files, targetDir);
    });
  },

  _updateFileBrowserStatus() {
    const statusEl = this.$('fileBrowserStatus');
    if (!statusEl || !this.fileBrowserData) return;
    const { totalFiles, totalDirectories, truncated } = this.fileBrowserData;
    const base = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
    const dir = this.fileBrowserCurrentDir || '';
    const showHidden = this.fileBrowserShowHidden === true ? ' · hidden shown' : '';
    statusEl.textContent = dir ? `${base} · in ${dir}${showHidden}` : `${base}${showHidden}`;
  },

  async createFileBrowserFolder() {
    const sessionId = this.fileBrowserSessionId || this.activeSessionId;
    if (!sessionId) {
      this.showToast('No active session', 'error');
      return;
    }
    const hint = this.fileBrowserCurrentDir ? ` (in ${this.fileBrowserCurrentDir}/)` : '';
    const input = window.prompt(`New folder name${hint} (e.g. myFolder or a/b/c):`);
    if (input == null) return;
    const name = String(input).trim();
    if (!name) return;
    // Allow nested like a/b/c but strip leading/trailing slashes
    const sanitized = name.replace(/^\/+/, '').replace(/\\/g, '/').trim();
    if (!sanitized) {
      this.showToast('Invalid folder name', 'error');
      return;
    }
    const finalPath = this.fileBrowserCurrentDir ? `${this.fileBrowserCurrentDir}/${sanitized}` : sanitized;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/mkdir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: finalPath }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);
      this.showToast(`Folder "${finalPath}" created`, 'success');
      await this.loadFileBrowser(sessionId);
      // Auto-expand current dir and parent so new folder is visible
      if (this.fileBrowserCurrentDir) this.fileBrowserExpandedDirs.add(this.fileBrowserCurrentDir);
      const parent = finalPath.includes('/') ? finalPath.split('/').slice(0, -1).join('/') : null;
      if (parent) this.fileBrowserExpandedDirs.add(parent);
      this.fileBrowserExpandedDirs.add(finalPath);
      this.fileBrowserCurrentDir = finalPath;
      this._updateFileBrowserStatus?.();
      this.renderFileBrowserTree();
    } catch (err) {
      this.showToast(`Create folder failed: ${err && err.message ? err.message : err}`, 'error');
    }
  },

  async renameFileBrowserEntry(oldPath) {
    const sessionId = this.fileBrowserSessionId || this.activeSessionId;
    if (!sessionId || !oldPath) return;
    const base = oldPath.split('/').pop() || oldPath;
    const next = window.prompt(`Rename "${oldPath}" to:`, base);
    if (next == null) return;
    const newBase = String(next).trim();
    if (!newBase || newBase === base) return;
    if (newBase.includes('/') || newBase.includes('\\')) {
      this.showToast('Name must not contain path separators', 'error');
      return;
    }
    const dir = oldPath.includes('/') ? oldPath.split('/').slice(0, -1).join('/') : '';
    const newPath = dir ? `${dir}/${newBase}` : newBase;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: oldPath, to: newPath }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);
      this.showToast(`Renamed to "${newPath}"`, 'success');
      // If renamed directory was expanded, move expanded state
      if (this.fileBrowserExpandedDirs.has(oldPath)) {
        this.fileBrowserExpandedDirs.delete(oldPath);
        this.fileBrowserExpandedDirs.add(newPath);
      }
      // Move current dir if it was the renamed path or a child
      if (this.fileBrowserCurrentDir === oldPath) this.fileBrowserCurrentDir = newPath;
      else if ((this.fileBrowserCurrentDir || '').startsWith(oldPath + '/')) {
        this.fileBrowserCurrentDir = newPath + this.fileBrowserCurrentDir.slice(oldPath.length);
      }
      // Also update loaded dirs
      if (this.fileBrowserLoadedDirs && this.fileBrowserLoadedDirs.has(oldPath)) {
        this.fileBrowserLoadedDirs.delete(oldPath);
      }
      await this.loadFileBrowser(sessionId);
      // Preserve moved current dir across reload (load would otherwise keep old)
      if (this.fileBrowserCurrentDir === newPath || (this.fileBrowserCurrentDir || '').startsWith(newPath + '/')) {
        this._updateFileBrowserStatus?.();
      }
    } catch (err) {
      this.showToast(`Rename failed: ${err && err.message ? err.message : err}`, 'error');
    }
  },

  async deleteFileBrowserEntry(targetPath) {
    const sessionId = this.fileBrowserSessionId || this.activeSessionId;
    if (!sessionId || !targetPath) return;
    const isDir = targetPath && this.fileBrowserData && (() => {
      const find = (nodes) => {
        for (const n of nodes || []) {
          if (n.path === targetPath) return n;
          const c = find(n.children);
          if (c) return c;
        }
        return null;
      };
      const node = find(this.fileBrowserData.tree || []);
      return node ? node.type === 'directory' : false;
    })();
    const label = isDir ? 'folder' : 'file';
    if (!window.confirm(`Delete ${label} "${targetPath}"?${isDir ? ' This will delete its contents.' : ''}`)) return;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(targetPath)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || `Failed (${res.status})`);
      this.showToast(`Deleted "${targetPath}"`, 'success');
      this.fileBrowserExpandedDirs.delete(targetPath);
      // If deleted path was current dir or ancestor, move current up
      if (this.fileBrowserCurrentDir === targetPath || (this.fileBrowserCurrentDir || '').startsWith(targetPath + '/')) {
        const parent = targetPath.includes('/') ? targetPath.split('/').slice(0, -1).join('/') : '';
        this.fileBrowserCurrentDir = parent;
      }
      if (this.fileBrowserLoadedDirs) this.fileBrowserLoadedDirs.delete(targetPath);
      await this.loadFileBrowser(sessionId);
    } catch (err) {
      this.showToast(`Delete failed: ${err && err.message ? err.message : err}`, 'error');
    }
  },

  hasMatchingChild(node, filter) {
    if (!node.children) return false;
    for (const child of node.children) {
      if (child.name.toLowerCase().includes(filter)) return true;
      if (child.type === 'directory' && this.hasMatchingChild(child, filter)) return true;
    }
    return false;
  },

  async toggleFileBrowserFolder(path) {
    if (this.fileBrowserExpandedDirs.has(path)) {
      this.fileBrowserExpandedDirs.delete(path);
      if (this.fileBrowserCurrentDir === path || (this.fileBrowserCurrentDir || '').startsWith(path + '/')) {
        const parent = path.includes('/') ? path.split('/').slice(0, -1).join('/') : '';
        this.fileBrowserCurrentDir = parent;
        this._updateFileBrowserStatus?.();
      }
      this.renderFileBrowserTree();
      return;
    }

    this.fileBrowserExpandedDirs.add(path);
    this.fileBrowserCurrentDir = path;
    this._updateFileBrowserStatus?.();
    const treeData = this.fileBrowserData;
    if (!treeData?.lazy || this.fileBrowserLoadedDirs?.has(path)) {
      this.renderFileBrowserTree();
      return;
    }

    // Remote trees are intentionally one directory deep. Capture both ownership
    // and generation before the request so an old expansion can never graft its
    // children onto a newly selected session's tree.
    const sessionId = this.fileBrowserSessionId;
    const generation = this.fileBrowserLoadGeneration;
    const includeHidden = this.fileBrowserShowHidden === true;
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}&showHidden=${includeHidden}`
      );
      if (!res.ok) throw new Error('Failed to load folder');
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load folder');
      if (
        generation !== this.fileBrowserLoadGeneration ||
        sessionId !== this.fileBrowserSessionId ||
        treeData !== this.fileBrowserData
      ) {
        return;
      }

      const findDirectory = (nodes) => {
        for (const node of nodes || []) {
          if (node.path === path && node.type === 'directory') return node;
          const match = findDirectory(node.children);
          if (match) return match;
        }
        return null;
      };
      const directory = findDirectory(treeData.tree);
      if (!directory) return;
      directory.children = result.data.tree || [];
      (this.fileBrowserLoadedDirs ||= new Set()).add(path);
      this.renderFileBrowserTree();
    } catch (err) {
      if (generation !== this.fileBrowserLoadGeneration || sessionId !== this.fileBrowserSessionId) return;
      this.fileBrowserExpandedDirs.delete(path);
      this.renderFileBrowserTree();
      this.showToast?.(`Failed to load folder: ${err && err.message ? err.message : err}`, 'error');
    }
  },

  // COD-236: server-side search. The filter box now hits the files endpoint with
  // a `q` param (debounced) so a large workspace prunes the walk to matches
  // instead of shipping/rendering the whole tree. An empty query restores the
  // cached tree. The old client-side tree filter (renderFileBrowserTree's
  // filter branch) stays intact for the no-query case.
  filterFileBrowser(value) {
    this.fileBrowserFilter = value;
    if (this._fileBrowserSearchTimer) {
      clearTimeout(this._fileBrowserSearchTimer);
      this._fileBrowserSearchTimer = null;
    }
    this._fileBrowserSearchTimer = setTimeout(() => {
      this._fileBrowserSearchTimer = null;
      const q = (value || '').trim();
      if (!q) {
        // Restore the cached tree.
        this.fileBrowserSearchMode = false;
        this.fileBrowserMatches = null;
        this.renderFileBrowserTree();
        const statusEl = this.$('fileBrowserStatus');
        if (statusEl && this.fileBrowserData) {
          const { totalFiles, totalDirectories, truncated } = this.fileBrowserData;
          statusEl.textContent = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
        }
        return;
      }
      this.searchFileBrowser(q);
    }, 250);
  },

  async searchFileBrowser(q) {
    const sid = this.fileBrowserSessionId;
    if (!sid) return;
    const treeEl = this.$('fileBrowserTree');
    const statusEl = this.$('fileBrowserStatus');
    if (!treeEl) return;

    // Remote SFTP listings are lazy by design. Searching the current directory
    // would look complete while silently omitting nested matches, so filtering is
    // explicitly limited to the folders that have already been expanded.
    if (this.fileBrowserData?.lazy) {
      this.fileBrowserSearchMode = false;
      this.fileBrowserMatches = null;
      this.renderFileBrowserTree();
      if (statusEl) statusEl.textContent = `Filtering loaded folders for '${q}'`;
      return;
    }

    // Generation guard: a slow response must not clobber a newer query.
    const loadGeneration = ++this.fileBrowserLoadGeneration;
    const includeHidden = this.fileBrowserShowHidden === true;

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sid)}/files?depth=5&showHidden=${includeHidden}&q=${encodeURIComponent(q)}`
      );
      if (!res.ok) throw new Error('Search failed');
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Search failed');
      if (loadGeneration !== this.fileBrowserLoadGeneration) return;

      this.fileBrowserSearchMode = true;
      this.fileBrowserMatches = result.data.matches || [];
      this.renderFileBrowserMatches();

      if (statusEl) {
        const truncated = result.data.truncated;
        statusEl.textContent = `${this.fileBrowserMatches.length} matches for '${q}'${truncated ? ' (truncated)' : ''}`;
      }
    } catch (err) {
      if (loadGeneration !== this.fileBrowserLoadGeneration) return;
      console.error('Failed to search file browser:', err);
      treeEl.innerHTML = `<div class="file-browser-empty">Search failed: ${escapeHtml(err.message)}</div>`;
    }
  },

  renderFileBrowserMatches() {
    const treeEl = this.$('fileBrowserTree');
    if (!treeEl || !this.fileBrowserSessionId) return;
    const fileBrowserSessionId = this.fileBrowserSessionId;
    const matches = this.fileBrowserMatches || [];

    if (matches.length === 0) {
      treeEl.innerHTML = '<div class="file-browser-empty">No matches</div>';
      return;
    }

    const html = [];
    for (const node of matches) {
      const isDir = node.type === 'directory';
      const icon = isDir ? '📁' : this.getFileIcon(node.extension);
      const sizeStr =
        !isDir && node.size !== undefined
          ? `<span class="file-tree-size">${this.formatFileSize(node.size)}</span>`
          : '';
      const nameClass = isDir ? 'file-tree-name directory' : 'file-tree-name';

      // COD-233: keep a real href for graceful fallback, but the click is
      // intercepted below and routed through a guarded fetch.
      const downloadBtn = !isDir
        ? `<a class="file-tree-download" href="/api/sessions/${encodeURIComponent(fileBrowserSessionId)}/file-raw?path=${encodeURIComponent(node.path)}&download=true" data-path="${escapeHtml(node.path)}" title="Download" role="button">&#x2B07;</a>`
        : '';
      const renameBtn = `<button class="file-tree-rename" data-path="${escapeHtml(node.path)}" title="Rename" aria-label="Rename">✎</button>`;
      const deleteBtn = `<button class="file-tree-delete" data-path="${escapeHtml(node.path)}" title="Delete" aria-label="Delete">🗑</button>`;

      html.push(`
        <div class="file-tree-item" data-path="${escapeHtml(node.path)}" data-type="${node.type}" data-depth="0">
          <span class="file-tree-expand"></span>
          <span class="file-tree-icon">${icon}</span>
          <span class="${nameClass}">${escapeHtml(node.name)}</span>
          ${sizeStr}
          ${downloadBtn}${renameBtn}${deleteBtn}
        </div>
      `);
    }

    treeEl.innerHTML = html.join('');

    treeEl.querySelectorAll('.file-tree-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.file-tree-rename, .file-tree-delete, .file-tree-download')) return;
        const path = item.dataset.path;
        const type = item.dataset.type;
        if (type === 'directory') {
          // Open the directory in the tree: clear the search, add to the
          // expanded set, and re-render the cached tree.
          this.fileBrowserFilter = '';
          this.fileBrowserSearchMode = false;
          this.fileBrowserMatches = null;
          const searchInput = this.$('fileBrowserSearch');
          if (searchInput) searchInput.value = '';
          this.fileBrowserExpandedDirs.add(path);
          this.renderFileBrowserTree();
          const statusEl = this.$('fileBrowserStatus');
          if (statusEl && this.fileBrowserData) {
            const { totalFiles, totalDirectories, truncated } = this.fileBrowserData;
            statusEl.textContent = `${totalFiles} files, ${totalDirectories} dirs${truncated ? ' (truncated)' : ''}`;
          }
        } else {
          this.openFilePreview(path, fileBrowserSessionId);
        }
      });
    });

    // COD-233: intercept download clicks so a server error surfaces as a toast.
    treeEl.querySelectorAll('.file-tree-download').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.downloadWorkspaceFile(fileBrowserSessionId, btn.dataset.path);
      });
    });
    treeEl.querySelectorAll('.file-tree-rename').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.renameFileBrowserEntry(btn.dataset.path);
      });
    });
    treeEl.querySelectorAll('.file-tree-delete').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.deleteFileBrowserEntry(btn.dataset.path);
      });
    });
  },

  expandAllDirectories(nodes) {
    for (const node of nodes) {
      if (node.type === 'directory') {
        this.fileBrowserExpandedDirs.add(node.path);
        if (node.children) {
          this.expandAllDirectories(node.children);
        }
      }
    }
  },

  collapseAllDirectories() {
    this.fileBrowserExpandedDirs.clear();
  },

  toggleFileBrowserExpand() {
    this.fileBrowserAllExpanded = !this.fileBrowserAllExpanded;
    const btn = this.$('fileBrowserExpandBtn');

    if (this.fileBrowserAllExpanded) {
      this.expandAllDirectories(this.fileBrowserData?.tree || []);
      if (btn) btn.innerHTML = '\u229F'; // Collapse icon
    } else {
      this.collapseAllDirectories();
      if (btn) btn.innerHTML = '\u229E'; // Expand icon
    }
    this.renderFileBrowserTree();
  },

  refreshFileBrowser() {
    if (this.fileBrowserSessionId) {
      if (this._fileBrowserSearchTimer) {
        clearTimeout(this._fileBrowserSearchTimer);
        this._fileBrowserSearchTimer = null;
      }
      this.fileBrowserExpandedDirs.clear();
      this.fileBrowserLoadedDirs?.clear();
      this.fileBrowserFilter = '';
      this.fileBrowserSearchMode = false;
      this.fileBrowserMatches = null;
      this.fileBrowserAllExpanded = false;
      const searchInput = this.$('fileBrowserSearch');
      if (searchInput) searchInput.value = '';
      this.loadFileBrowser(this.fileBrowserSessionId);
    }
  },

  // Header "File Viewer" button (opt-in via App Settings → Header Displays →
  // File Viewer). Toggles the file browser panel open/closed without a trip
  // through settings. Persists via the same `showFileBrowser` flag the Panels
  // section + the panel's own close (X) use, so the three stay in sync.
  toggleFileBrowserButton() {
    const panel = this.$('fileBrowserPanel');
    const isOpen = panel?.classList.contains('visible');
    const btn = document.querySelector('.btn-file-viewer');
    if (isOpen) {
      this.closeFileBrowserPanel();
      if (btn) btn.setAttribute('aria-expanded', 'false');
      return;
    }
    if (!this.activeSessionId) {
      this.showToast('Open a session to browse its files', 'info');
      return;
    }
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = true;
    this.saveAppSettingsToStorage(settings);
    const checkbox = document.getElementById('appSettingsShowFileBrowser');
    if (checkbox) checkbox.checked = true;
    this.applyMonitorVisibility();
    if (btn) btn.setAttribute('aria-expanded', 'true');
  },

  closeFileBrowserPanel() {
    const panel = this.$('fileBrowserPanel');
    if (panel) {
      panel.classList.remove('visible');
      // Reset position so it reopens at default location
      panel.style.left = '';
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.right = '';
    }
    // Clean up drag listeners
    if (this.fileBrowserDragListeners) {
      const dl = this.fileBrowserDragListeners;
      document.removeEventListener('mousemove', dl.move);
      document.removeEventListener('mouseup', dl.up);
      document.removeEventListener('touchmove', dl.touchMove);
      document.removeEventListener('touchend', dl.up);
      document.removeEventListener('touchcancel', dl.up);
      if (dl.handle) {
        dl.handle.removeEventListener('mousedown', dl.handleMouseDown);
        dl.handle.removeEventListener('touchstart', dl.handleTouchStart);
        if (dl._onFirstDrag) {
          dl.handle.removeEventListener('mousedown', dl._onFirstDrag);
          dl.handle.removeEventListener('touchstart', dl._onFirstDrag);
        }
      }
      this.fileBrowserDragListeners = null;
    }
    // Save setting
    const settings = this.loadAppSettingsFromStorage();
    settings.showFileBrowser = false;
    this.saveAppSettingsToStorage(settings);
    const checkbox = document.getElementById('appSettingsShowFileBrowser');
    if (checkbox) checkbox.checked = false;
    // COD-235: TWO header buttons drive this one panel — the session-gated Files
    // button (#fileBrowserBtn) and the opt-in File Viewer button
    // (.btn-file-viewer). Closing used to sync only the latter's aria-expanded,
    // so every non-header close (the panel's X, App Settings) left the Files
    // button stuck `.active` + aria-expanded="true". Derive it from the panel
    // through the canonical updater instead of hand-rolling a partial sync.
    this.updateFileBrowserHeaderButton?.();
    const headerBtn = document.querySelector('.btn-file-viewer');
    if (headerBtn) headerBtn.setAttribute('aria-expanded', 'false');
  },

  async openExternalPathPreview(absolutePath, sessionId) {
    if (!sessionId || !absolutePath) return;

    if (!this._externalPathPreviewRequests) this._externalPathPreviewRequests = new Map();
    const requestKey = `${sessionId}\0${absolutePath}`;
    const existing = this._externalPathPreviewRequests.get(requestKey);
    if (existing && this.filePreviewState === existing.resolverState) return existing.request;
    if (existing) this._externalPathPreviewRequests.delete(requestKey);

    let resolverState;
    const request = (async () => {
      const overlay = this.$('filePreviewOverlay');
      const titleEl = this.$('filePreviewTitle');
      const bodyEl = this.$('filePreviewBody');
      const footerEl = this.$('filePreviewFooter');
      if (!overlay || !bodyEl) return;

      this._stopFilePreviewPolling();
      this._resetFilePreviewExternalAction?.();
      this._resetFilePreviewOriginalDownloadAction?.();

      overlay.classList.add('visible');
      this._restorePreviewSize();
      if (titleEl) titleEl.textContent = absolutePath;
      bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
      if (footerEl) footerEl.textContent = '';
      this._hideFilePreviewNavigation();

      const requestToken = Symbol('external-path-preview');
      resolverState = { sessionId, absolutePath, requestToken, mode: 'external-path-resolver' };
      this.filePreviewState = resolverState;
      const ownsPreview = () => this.filePreviewState === resolverState && resolverState.requestToken === requestToken;
      const renderError = (message) => {
        if (!ownsPreview()) return;
        const safeMessage =
          typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : 'Unable to preview file';
        bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(safeMessage)}</div>`;
      };

      let response;
      try {
        response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: absolutePath }),
        });
      } catch (err) {
        if (!ownsPreview()) return;
        console.error('Failed to register external path preview:', err);
        renderError('Unable to preview file');
        return;
      }
      if (!ownsPreview()) return;

      let payload;
      try {
        payload = await response.json();
      } catch (err) {
        if (!ownsPreview()) return;
        console.error('Failed to parse external path preview response:', err);
        renderError('Unable to preview file');
        return;
      }
      if (!ownsPreview()) return;

      const fileName = payload?.data?.fileName;
      const attachmentId = payload?.data?.attachmentId;
      if (!response.ok || payload?.success !== true) {
        renderError(payload?.error);
        return;
      }
      if (typeof fileName !== 'string' || !fileName || typeof attachmentId !== 'string' || !attachmentId) {
        renderError('Unable to preview file');
        return;
      }

      return this.openFilePreview(fileName, sessionId, attachmentId, { displayPath: absolutePath });
    })();

    const requestEntry = { request, resolverState };
    this._externalPathPreviewRequests.set(requestKey, requestEntry);
    try {
      return await request;
    } finally {
      if (this._externalPathPreviewRequests.get(requestKey) === requestEntry) {
        this._externalPathPreviewRequests.delete(requestKey);
      }
    }
  },

  async openFileUriPreview(fileUri, sessionId) {
    if (!sessionId || !fileUri) return;

    const overlay = this.$('filePreviewOverlay');
    const titleEl = this.$('filePreviewTitle');
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');
    if (!overlay || !bodyEl) return;

    this._stopFilePreviewPolling();
    this._resetFilePreviewExternalAction?.();
    this._resetFilePreviewOriginalDownloadAction?.();

    overlay.classList.add('visible');
    this._restorePreviewSize();
    if (titleEl) titleEl.textContent = fileUri;
    bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
    if (footerEl) footerEl.textContent = '';
    this._hideFilePreviewNavigation();

    const requestToken = Symbol('file-uri-preview');
    const resolverState = { sessionId, fileUri, requestToken, mode: 'file-uri-resolver' };
    this.filePreviewState = resolverState;
    const ownsPreview = () => this.filePreviewState === resolverState && resolverState.requestToken === requestToken;
    const renderError = (message) => {
      if (!ownsPreview()) return;
      const safeMessage = typeof message === 'string' && message.trim() ? message.trim().slice(0, 300) : 'Unable to preview file';
      bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(safeMessage)}</div>`;
    };

    let response;
    try {
      response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/file-uri-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uri: fileUri }),
      });
    } catch (err) {
      if (!ownsPreview()) return;
      console.error('Failed to resolve file URI preview:', err);
      renderError('Unable to preview file');
      return;
    }
    if (!ownsPreview()) return;

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      if (!ownsPreview()) return;
      console.error('Failed to parse file URI preview response:', err);
      renderError('Unable to preview file');
      return;
    }
    if (!ownsPreview()) return;

    const fileName = payload?.data?.fileName;
    const attachmentId = payload?.data?.attachmentId;
    if (!response.ok || payload?.success !== true) {
      renderError(payload?.error);
      return;
    }
    if (typeof fileName !== 'string' || !fileName || typeof attachmentId !== 'string' || !attachmentId) {
      renderError('Unable to preview file');
      return;
    }

    return this.openFilePreview(fileName, sessionId, attachmentId);
  },

  /**
   * Whether a path is absolute and provably OUTSIDE this session's workspace.
   *
   * `file-content` / `file-raw` resolve every path against `workingDir` and
   * refuse anything that escapes it, so an absolute path elsewhere on the host
   * (an agent's `/tmp` scratchpad capture, a screenshot, another checkout) can
   * only ever 404 there — it has to go through the attachment routes instead.
   *
   * A string compare is enough for ROUTING; the real containment decision stays
   * server-side (realpath + guard) on whichever route the request lands on. An
   * unknown workingDir answers false, leaving the historical path untouched.
   *
   * Registration for those paths is openExternalPathPreview()'s job (above):
   * it POSTs to /attachments, then previews the minted id.
   */
  _isExternalPreviewPath(filePath, sessionId) {
    if (typeof filePath !== 'string' || !filePath.startsWith('/')) return false;
    const workingDir = this.sessions.get(sessionId)?.workingDir;
    if (!workingDir) return false;
    const root = workingDir.endsWith('/') ? workingDir : `${workingDir}/`;
    return filePath !== workingDir && !filePath.startsWith(root);
  },

  async openFilePreview(filePath, sessionId = this.activeSessionId, attachmentId = null, options = {}) {
    if (!sessionId || !filePath) return;

    const overlay = this.$('filePreviewOverlay');
    const titleEl = this.$('filePreviewTitle');
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');

    if (!overlay || !bodyEl) return;

    // Stop any previous live-refresh poller before switching documents.
    this._stopFilePreviewPolling();
    this._resetFilePreviewExternalAction?.();
    this._resetFilePreviewOriginalDownloadAction?.();
    // Edit mode is per-document: a (re)open always lands in read mode, and the
    // Edit button stays hidden until the server says this file is editable.
    // `?.` matches the sibling resets above (partial hosts in unit harnesses).
    this._resetFilePreviewEdit?.();
    // Stop whatever the previous preview was playing. Overwriting innerHTML
    // only DETACHES a <video>/<audio>; a detached media element keeps playing.
    this._stopFilePreviewMedia?.();

    // Show overlay with loading state
    overlay.classList.add('visible');
    this._restorePreviewSize();
    const displayPath = typeof options.displayPath === 'string' && options.displayPath ? options.displayPath : filePath;
    titleEl.textContent = displayPath;
    bodyEl.innerHTML = '<div class="binary-message">Loading...</div>';
    footerEl.textContent = '';

    const metadataUrl = attachmentId
      ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}`
      : `/api/sessions/${sessionId}/file-content?path=${encodeURIComponent(filePath)}&lines=500`;
    const previewState = {
      sessionId,
      filePath,
      attachmentId,
      displayPath,
      metadataUrl,
      signature: null,
      docxView: 'pdf',
      mtimeMs: null,
    };
    this.filePreviewState = previewState;
    this._setFilePreviewOriginalDownloadAction?.(previewState);
    this._hideFilePreviewNavigation();
    // Navigation is deliberately independent from the document metadata request:
    // attachment history is the authoritative ordered list, and a slow document
    // conversion must not delay it. The loader checks this exact state identity
    // before it ever reveals controls.
    void this._loadFilePreviewNavigation(previewState);
    this._annotations = [];
    this._closeAnnotationTray();

    try {
      const data = await this._fetchFilePreviewMetadata(metadataUrl);
      // A newer open/close owns the overlay now. Never let this stale response
      // overwrite its body or start a poller for the wrong document.
      if (this.filePreviewState !== previewState) return;
      this._setFilePreviewExternalUrl?.(previewState, data);
      previewState.signature = this._filePreviewSignature(data);
      previewState.mtimeMs = data.mtimeMs ?? null;
      const rendered = await this._renderFilePreviewBody(data, { sessionId, filePath, attachmentId }, previewState);
      if (!rendered || this.filePreviewState !== previewState) return;
      // Auto-refresh the open preview as the agent rewrites the file (COD-58).
      this._startFilePreviewPolling();
    } catch (err) {
      if (this.filePreviewState !== previewState) return;
      console.error('Failed to preview file:', err);
      bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
    }
  },

  /** Clear any approved external URL and keep the header action inert. */
  _resetFilePreviewExternalAction() {
    if (this.filePreviewState) delete this.filePreviewState.externalPreviewUrl;
    const button = this.$('filePreviewOpenNewTab');
    if (button) button.disabled = true;
  },

  /** Reset the identity-only original-source action before replacing or closing a preview. */
  _resetFilePreviewOriginalDownloadAction() {
    const button = this.$('filePreviewDownloadOriginal');
    if (button) button.disabled = true;
  },

  /** Enable original-source download synchronously from the current preview identity. */
  _setFilePreviewOriginalDownloadAction(previewState) {
    const button = this.$('filePreviewDownloadOriginal');
    if (!button) return;
    button.disabled = !this._filePreviewOriginalDownloadUrl(previewState);
  },

  /** Build the raw original route solely from the preview identity, never render metadata. */
  _filePreviewOriginalDownloadUrl(previewState) {
    if (!previewState?.sessionId) return null;
    let url;
    if (previewState.attachmentId) {
      url = `/api/sessions/${encodeURIComponent(previewState.sessionId)}/attachments/${encodeURIComponent(previewState.attachmentId)}/raw`;
    } else if (previewState.filePath) {
      url = `/api/sessions/${encodeURIComponent(previewState.sessionId)}/file-raw?path=${encodeURIComponent(previewState.filePath)}`;
    } else {
      return null;
    }
    const separator = url.includes('?') ? '&' : '?';
    const cacheBust = previewState.mtimeMs != null ? `&_t=${encodeURIComponent(String(previewState.mtimeMs))}` : '';
    return `${url}${separator}download=true${cacheBust}`;
  },

  /** Fetch and save the original file; successful browser downloads intentionally remain toast-free. */
  async downloadFilePreviewOriginal(expectedState = null) {
    const st = this.filePreviewState;
    if (!st || (expectedState && expectedState !== st)) return;
    const url = this._filePreviewOriginalDownloadUrl(st);
    if (!url) return;
    try {
      const res = await fetch(url);
      if (this.filePreviewState !== st) return;
      if (!res.ok) {
        let message = 'Failed to download original file';
        try {
          const body = await res.json();
          if (typeof body?.error === 'string') message = body.error;
        } catch {
          // Use the generic error when the response does not contain an envelope.
        }
        this.showToast?.(message, 'error');
        return;
      }
      const blob = await res.blob();
      if (this.filePreviewState !== st) return;
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = String(st.filePath || 'download').split('/').pop() || 'download';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      if (this.filePreviewState === st) {
        console.error('Failed to download preview source:', err);
        this.showToast?.('Failed to download original file', 'error');
      }
    }
  },

  /**
   * Resolve metadata URLs or the identity-derived raw route into a safe,
   * same-origin browser address. Unsafe candidates are skipped so the next
   * lower-priority representation can still be used.
   */
  _resolveFilePreviewExternalUrl(data, previewState) {
    if (!previewState) return null;

    const candidates = [];
    if (typeof data?.previewUrl === 'string' && data.previewUrl) candidates.push(data.previewUrl);
    if (typeof data?.url === 'string' && data.url) candidates.push(data.url);
    if (previewState.sessionId && previewState.attachmentId) {
      candidates.push(
        `/api/sessions/${encodeURIComponent(previewState.sessionId)}/attachments/${encodeURIComponent(previewState.attachmentId)}/raw`
      );
    } else if (previewState.sessionId && previewState.filePath) {
      candidates.push(
        `/api/sessions/${encodeURIComponent(previewState.sessionId)}/file-raw?path=${encodeURIComponent(previewState.filePath)}`
      );
    }

    for (const candidate of candidates) {
      try {
        const resolved = new URL(candidate, window.location.href);
        if (
          (resolved.protocol === 'http:' || resolved.protocol === 'https:') &&
          resolved.origin === window.location.origin
        ) {
          return `${resolved.pathname}${resolved.search}${resolved.hash}`;
        }
      } catch {
        // Try the next lower-priority candidate.
      }
    }
    return null;
  },

  /** Publish an external URL only while this exact preview still owns the overlay. */
  _setFilePreviewExternalUrl(previewState, data) {
    if (this.filePreviewState !== previewState) return;
    const url = this._resolveFilePreviewExternalUrl(data, previewState);
    if (this.filePreviewState !== previewState) return;
    if (url) previewState.externalPreviewUrl = url;
    else delete previewState.externalPreviewUrl;
    const button = this.$('filePreviewOpenNewTab');
    if (button) button.disabled = !url;
  },

  /** Open only the URL approved for the current preview state. */
  openFilePreviewInNewTab() {
    const url = this.filePreviewState?.externalPreviewUrl;
    if (!url) return;
    const opened = window.open(url, '_blank', 'noopener');
    if (opened) {
      try {
        opened.opener = null;
      } catch {
        // Cross-window hardening is best-effort; noopener remains authoritative.
      }
    }
  },

  _hideFilePreviewNavigation() {
    const navigation = this.$('filePreviewNavigation');
    const previous = this.$('filePreviewPrevious');
    const next = this.$('filePreviewNext');
    const position = this.$('filePreviewPosition');
    if (navigation) navigation.hidden = true;
    if (previous) previous.disabled = true;
    if (next) next.disabled = true;
    if (position) position.textContent = '';
  },

  async _loadFilePreviewNavigation(previewState) {
    this._hideFilePreviewNavigation();
    try {
      const res = await fetch(`/api/sessions/${previewState.sessionId}/attachments`);
      if (!res.ok) throw new Error('Failed to load attachments');
      const result = await res.json();
      if (this.filePreviewState !== previewState) return;
      if (!result?.success || !Array.isArray(result.data?.items)) {
        this._hideFilePreviewNavigation();
        return;
      }

      // Keep the server's endpoint order; it is the attachment-history order.
      // External attachments do not have a workspace-relative path, but their
      // filename remains a valid title when reopening through their attachment ID.
      const items = result.data.items.filter(
        (item) =>
          item &&
          !item.missing &&
          (typeof item.relativePath === 'string' || (typeof item.fileName === 'string' && item.fileName))
      );
      if (items.length < 2) {
        this._hideFilePreviewNavigation();
        return;
      }

      let index = -1;
      if (previewState.attachmentId) {
        index = items.findIndex((item) => item.attachmentId === previewState.attachmentId);
      } else {
        index = items.findIndex((item) => item.relativePath === previewState.filePath);
      }
      if (this.filePreviewState !== previewState) return;
      if (index === -1) {
        this._hideFilePreviewNavigation();
        return;
      }

      previewState.navigationItems = items;
      previewState.navigationIndex = index;
      const navigation = this.$('filePreviewNavigation');
      const previous = this.$('filePreviewPrevious');
      const next = this.$('filePreviewNext');
      const position = this.$('filePreviewPosition');
      if (this.filePreviewState !== previewState) return;
      if (position) position.textContent = `${index + 1} of ${items.length}`;
      if (previous) previous.disabled = index === 0;
      if (next) next.disabled = index === items.length - 1;
      if (navigation) navigation.hidden = false;
    } catch {
      if (this.filePreviewState === previewState) this._hideFilePreviewNavigation();
    }
  },

  navigateFilePreviewAttachment(direction) {
    const state = this.filePreviewState;
    if (!state || (direction !== -1 && direction !== 1) || !state.navigationItems) return;
    const item = state.navigationItems[state.navigationIndex + direction];
    if (!item) return;
    this.openFilePreview(item.relativePath || item.fileName, state.sessionId, item.attachmentId || null);
  },

  async _fetchFilePreviewMetadata(metadataUrl) {
    const res = await fetch(metadataUrl);
    let result;
    try {
      result = await res.json();
    } catch {
      throw new Error('Failed to load file');
    }
    if (!res.ok) {
      throw new Error(typeof result?.error === 'string' && result.error ? result.error : 'Failed to load file');
    }
    if (!result.success) throw new Error(result.error || 'Failed to load file');
    return result.data;
  },

  /** Cheap change signal: file mtime + size. Re-render only when it changes. */
  _filePreviewSignature(data) {
    return `${data?.mtimeMs ?? ''}:${data?.size ?? ''}`;
  },

  /**
   * Keep imported Word comments local to their annotated passage. The generated
   * buttons only carry sanitized IDs; this delegated handler owns all state and
   * deliberately never changes the preview's scroll position.
   */
  _bindDocxCommentInspector(bodyEl) {
    const preview = bodyEl?.querySelector('.document-preview-html');
    if (!preview || preview.dataset.docxCommentInspectorBound) return;
    preview.dataset.docxCommentInspectorBound = '1';

    const buttonForCard = (card) =>
      [...preview.querySelectorAll('.docx-comment-button')].find(
        (button) => button.getAttribute('aria-controls') === card.id
      );
    const setOpen = (card, open, restoreFocus = false) => {
      preview.querySelectorAll('.docx-comment-card').forEach((otherCard) => {
        const otherButton = buttonForCard(otherCard);
        otherCard.hidden = otherCard !== card || !open;
        otherButton?.setAttribute('aria-expanded', otherCard === card && open ? 'true' : 'false');
      });
      if (restoreFocus) buttonForCard(card)?.focus();
    };

    preview.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const closeButton = target?.closest('.docx-comment-close');
      if (closeButton) {
        event.preventDefault();
        const card = closeButton.closest('.docx-comment-card');
        if (card) setOpen(card, false, true);
        return;
      }
      const button = target?.closest('.docx-comment-button');
      if (!button) return;
      event.preventDefault();
      const cardId = button.getAttribute('aria-controls');
      const card = [...preview.querySelectorAll('.docx-comment-card')].find((item) => item.id === cardId);
      if (!card) return;
      setOpen(card, card.hidden);
    });

    preview.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const card = [...preview.querySelectorAll('.docx-comment-card')].find((item) => !item.hidden);
      if (!card) return;
      event.preventDefault();
      setOpen(card, false, true);
    });
  },

  /**
   * Render the preview body for the given metadata. Used both for the initial
   * open and for live-refresh, so it must be idempotent and not assume a loading
   * state. Markdown/plain-text re-fetch raw content; image/pdf get an mtime
   * cache-bust so a rewritten file actually reloads.
   */
  async _renderFilePreviewBody(data, { sessionId, filePath, attachmentId }, expectedState = null) {
    const isCurrentPreview = () => !expectedState || this.filePreviewState === expectedState;
    if (!isCurrentPreview()) return false;
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');
    if (!bodyEl) return false;
    const bust = (url) => (data.mtimeMs ? `${url}${url.includes('?') ? '&' : '?'}_t=${data.mtimeMs}` : url);
    const st = this.filePreviewState;
    this._disposeSpreadsheetPreview?.(expectedState || st);
    if (st) {
      st.previewKind = null;
      st.previewCopyUrl = null;
    }
    this.filePreviewContent = '';
    // Re-decided per render: only the text branch below re-offers Edit, so any
    // other type (image/video/binary/diff) leaves the button hidden.
    this.filePreviewEditTarget = null;
    const editBtnEl = this.$('filePreviewEditBtn');
    if (editBtnEl) editBtnEl.hidden = true;

    if (data.type === 'spreadsheet') {
      const renderer = window.CodemanSpreadsheetPreview;
      if (!renderer?.open) {
        bodyEl.innerHTML = '<div class="binary-message">Spreadsheet preview is unavailable.</div>';
      } else {
        bodyEl.textContent = '';
        const previewState = expectedState || st;
        const previewUrl = data.previewUrl || data.url;
        if (!previewState || !previewUrl) {
          bodyEl.innerHTML = '<div class="binary-message">Spreadsheet preview is unavailable.</div>';
        } else {
          previewState.spreadsheetPreview = renderer.open({
            container: bodyEl,
            url: bust(previewUrl),
            size: data.size,
            isCurrent: () => this.filePreviewState === previewState,
          });
        }
      }
      footerEl.textContent = `${this.formatFileSize(data.size)} • ${window.codemanT?.('Spreadsheet') || 'Spreadsheet'}`;
    } else if (data.type === 'image') {
      this.filePreviewZoom = 1;
      this.filePreviewZoomMode = 'fit';
      const imageUrl = bust(data.previewUrl || data.url);
      if (st) {
        st.previewKind = 'image';
        st.previewCopyUrl = imageUrl;
      }
      bodyEl.innerHTML = `
        <div class="document-preview-toolbar">
          <button class="btn-icon-sm" onclick="app.setFilePreviewZoom('out')" title="Zoom out">-</button>
          <button class="btn-icon-sm" onclick="app.setFilePreviewZoom('fit')" title="Fit">Fit</button>
          <button class="btn-icon-sm" onclick="app.setFilePreviewZoom('in')" title="Zoom in">+</button>
        </div>
        <div class="document-preview-stage">
          <img class="document-preview-image" src="${imageUrl}" alt="${escapeHtml(filePath)}">
        </div>
      `;
      const image = bodyEl.querySelector('.document-preview-image');
      const fitWhenReady = () => {
        if (this.filePreviewZoomMode === 'fit') this._fitFilePreviewImage();
      };
      image?.addEventListener('load', fitWhenReady, { once: true });
      // Cached images may already be complete before the load listener is bound.
      if (image?.complete) requestAnimationFrame(fitWhenReady);
      footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
    } else if (data.type === 'video') {
      // playsinline: iOS otherwise hijacks playback into its fullscreen
      // player, which leaves the overlay behind it and its own close button
      // as the only way back.
      bodyEl.innerHTML = `<video src="${escapeHtml(data.url)}" controls autoplay playsinline preload="metadata"></video>`;
      footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
    } else if (data.type === 'audio') {
      bodyEl.innerHTML = `<audio src="${escapeHtml(data.url)}" controls autoplay preload="metadata"></audio>`;
      footerEl.textContent = `${this.formatFileSize(data.size)} \u2022 ${data.extension}`;
    } else if (data.type === 'pdf' || data.type === 'document' || data.type === 'presentation') {
      const st = this.filePreviewState;
      const sourceExtension = String(data.extension || '')
        .toLowerCase();
      const isOfficePreview =
        (data.type === 'document' && sourceExtension === 'docx') ||
        (data.type === 'presentation' && sourceExtension === 'pptx');
      // .docx supports a view switcher: rendered PDF (default), selectable HTML, and Changes (COD-68).
      const isDocx = data.type === 'document' && !!attachmentId;
      const view = isDocx ? st?.docxView || 'pdf' : 'pdf';
      if (isDocx && view === 'html') {
        let html = '';
        try {
          const r = await fetch(`/api/sessions/${sessionId}/documents/html?${this._documentParams()}`);
          if (r.ok) html = (await r.json()).data?.html || '';
        } catch {
          /* fall through to empty */
        }
        if (!isCurrentPreview()) return false;
        const safe = typeof this._sanitizeHtml === 'function' ? this._sanitizeHtml(html) : escapeHtml(html);
        bodyEl.innerHTML = `<div class="document-preview-html rv-text">${safe}</div>`;
        this._bindDocxCommentInspector(bodyEl);
      } else {
        const previewUrl =
          data.previewUrl || data.url || `/api/sessions/${sessionId}/file-preview?path=${encodeURIComponent(filePath)}`;
        const bustedPreviewUrl = bust(previewUrl);
        // A Files-panel Office preview is a converted PDF, not the source file.
        // Suppress the embedded PDF toolbar so its download icon cannot present
        // that conversion as the primary download; the footer below provides an
        // explicit guarded source download and a separately-labelled PDF export.
        const iframeFragment = isOfficePreview ? '#toolbar=0' : '';
        if (data.type === 'pdf') {
          // Raw PDF: no server-side conversion, so embed it directly.
          bodyEl.innerHTML = `<iframe class="document-preview-frame" src="${bustedPreviewUrl}${iframeFragment}" title="${escapeHtml(filePath)}"></iframe>`;
        } else {
          // docx/pptx (COD-239): the preview endpoint BLOCKS on a soffice→PDF
          // conversion and only returns 200+PDF once it's ready (500 on failure).
          // A bare iframe would sit blank for the whole conversion, so fetch the
          // converted PDF to a blob behind a visible "Rendering…" state and swap
          // in a blob-URL iframe when it lands. Fire-and-forget so the footer and
          // loading state paint immediately; the helper re-checks staleness after
          // every await and stores its promise for polling/tests.
          const renderState = expectedState || this.filePreviewState;
          const renderPromise = this._renderOfficeConversionPreview(
            bodyEl,
            bustedPreviewUrl,
            iframeFragment,
            filePath,
            renderState
          );
          if (renderState) renderState.previewRenderPromise = renderPromise;
        }
      }
      const label = data.type === 'presentation' ? 'slides' : data.type === 'document' ? 'document' : 'pdf';
      const switcher = isDocx
        ? ` <span class="document-view-switch">` +
          `<button class="btn-icon-sm ${view === 'pdf' ? 'active' : ''}" onclick="app.switchDocxView('pdf')">PDF</button>` +
          `<button class="btn-icon-sm ${view === 'html' ? 'active' : ''}" onclick="app.switchDocxView('html')">HTML</button>` +
          `<button class="btn-icon-sm" onclick="app.switchDocxView('changes')">Changes</button>` +
          `</span>`
        : '';
      // Comment is available on the selectable HTML view (COD-68/69).
      const comment =
        isDocx && view === 'html'
          ? ` <button class="btn-icon-sm document-comment-btn" onclick="app.commentOnSelection()">Comment</button>`
          : '';
      // One-click PDF export of the open document (COD-61). docx/pptx reuse the
      // LibreOffice preview-PDF cache server-side; raw PDFs are already PDFs but
      // the control downloads them consistently via the export endpoint.
      const exportPdf = this._renderExportPdfControl();
      footerEl.innerHTML = `${escapeHtml(
        `${this.formatFileSize(data.size)} \u2022 ${label}`
      )}${switcher}${comment}${exportPdf}`;
    } else if (data.type === 'markdown' || data.type === 'text') {
      // Fetch the raw text and render it client-side. Markdown goes through the
      // shared sanitized renderer (_renderMarkdown -> _sanitizeHtml); plain text
      // is HTML-escaped into a <pre> so whitespace is preserved without inline HTML.
      const rawUrl =
        data.url || data.previewUrl || `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`;
      const textRes = await fetch(bust(rawUrl));
      if (!isCurrentPreview()) return false;
      if (!textRes.ok) throw new Error('Failed to load file');
      const text = await textRes.text();
      if (!isCurrentPreview()) return false;
      this.filePreviewContent = text;
      // Edit affordance (issue #212): the server decides — `editable` is its own
      // dry-run of the edit=1 gate (allowlist + sensitive/blocked + .git + size +
      // UTF-8). Attachment previews come from a different endpoint that never sets
      // it, so external documents stay read-only without a special case here.
      if (data.editable === true && !attachmentId) {
        this.filePreviewEditTarget = { sessionId, filePath };
        const editBtn = this.$('filePreviewEditBtn');
        if (editBtn) editBtn.hidden = false;
      }
      // Reset any prior outline scroll-spy before re-rendering (no observer leaks).
      this._teardownOutlineScrollSpy();
      // Restore persisted client-only view prefs (COD-62).
      this.readingViewActive = this._readPreviewPref('codeman.preview.readingView');
      const outlineOpenPref = this._readPreviewPref('codeman.preview.outlineOpen');
      let outlineBtn = '';
      let prose;
      if (data.type === 'markdown') {
        // Render prose first, then build the outline from the SANITIZED DOM and
        // wrap both in a flex layout so the outline sidebar sits beside the prose.
        const proseHtml = `<div class="document-preview-markdown rv-text${
          this.readingViewActive ? ' reading-view' : ''
        }">${this._renderMarkdown(text)}</div>`;
        bodyEl.innerHTML = proseHtml;
        prose = bodyEl.querySelector('.document-preview-markdown');
        const nav = this._buildDocumentOutline(prose);
        const layout = document.createElement('div');
        layout.className = 'document-preview-layout';
        if (nav && outlineOpenPref) layout.classList.add('outline-open');
        if (nav) layout.appendChild(nav);
        layout.appendChild(prose);
        bodyEl.innerHTML = '';
        bodyEl.appendChild(layout);
        this._bindResponseViewerInteractions?.(prose);
        if (nav) {
          this._setupOutlineScrollSpy(nav, prose);
          outlineBtn = ` <button class="btn-icon-sm document-outline-btn${
            outlineOpenPref ? ' active' : ''
          }" onclick="app.toggleDocumentOutline()">Outline</button>`;
        }
      } else {
        bodyEl.innerHTML = `<pre class="document-preview-text${
          this.readingViewActive ? ' reading-view' : ''
        }"><code>${escapeHtml(text)}</code></pre>`;
        prose = bodyEl.querySelector('.document-preview-text');
      }
      // COD-95: re-apply comment highlights onto the freshly-rendered prose. The
      // preview re-renders on poll, destroying any prior spans, so we rebuild them
      // from the persisted per-comment anchors (quote + occurrence).
      this._applyCommentHighlights(prose);
      // Reading-view toggle (constrained measure) for both markdown and text.
      const readingBtn = ` <button class="btn-icon-sm document-reading-btn${
        this.readingViewActive ? ' active' : ''
      }" onclick="app.toggleReadingView()">Reading view</button>`;
      // Word count + reading time from the rendered prose textContent (COD-62).
      const meta = this._formatReadingMeta(this._countWords(prose?.textContent || ''));
      // Revision-history affordance for versioned (attached) documents (COD-59).
      const changes = attachmentId
        ? ` <button class="btn-icon-sm document-changes-btn" onclick="app.showDocumentDiff()">Changes</button>`
        : '';
      // Annotate a selected passage and send it back to the session (COD-60).
      const comment = ` <button class="btn-icon-sm document-comment-btn" onclick="app.commentOnSelection()">Comment</button>`;
      // User-configured one-click authoring actions (COD-64). Only shown when the
      // user has configured at least one action AND there's a session to send to.
      const authoring = this._renderAuthoringControl();
      // One-click PDF export of the open document (COD-61).
      const exportPdf = this._renderExportPdfControl();
      footerEl.innerHTML = `${escapeHtml(
        `${this.formatFileSize(data.size)} \u2022 ${data.extension || data.type} \u2022 ${meta}`
      )}${outlineBtn}${readingBtn}${changes}${comment}${authoring}${exportPdf}`;
    } else if (data.type === 'binary') {
      bodyEl.innerHTML = `
        <div class="binary-message">
          Binary file (${this.formatFileSize(data.size)})<br>
          Cannot preview<br><br>
          <button class="btn-icon-sm" onclick="app.openAttachmentInNewTab(${escapeHtml(JSON.stringify(sessionId))}, ${escapeHtml(JSON.stringify(filePath))}, ${attachmentId ? escapeHtml(JSON.stringify(attachmentId)) : 'null'})">Open</button>
        </div>
      `;
      footerEl.textContent = data.extension || 'binary';
    } else {
      // Text content (workspace file-content path)
      this.filePreviewContent = data.content;
      bodyEl.innerHTML = `<pre><code>${escapeHtml(data.content)}</code></pre>`;
      const truncNote = data.truncated ? ` (showing 500/${data.totalLines} lines)` : '';
      footerEl.textContent = `${data.totalLines} lines \u2022 ${this.formatFileSize(data.size)}${truncNote}`;
    }
    return true;
  },

  /**
   * Render a converted Office (docx/pptx) preview into the body (COD-239). The
   * server's preview endpoint blocks on a soffice→PDF conversion, so a bare
   * iframe pointed straight at it would sit blank for the whole conversion (the
   * reported bug). Instead we paint a visible "Rendering document…" state and
   * fetch the SAME-ORIGIN preview URL purely as a readiness probe (abortable,
   * failure-detecting). On success we render the iframe against that same
   * same-origin URL — it's a warm disk-cache hit (fast) AND allowed by the app's
   * `default-src 'self'` CSP. We deliberately do NOT render a `blob:` URL: the
   * CSP has no `frame-src`, so framing a blob: violates `default-src 'self'` and
   * the browser blocks it (the preview would stay blank). An AbortController on
   * the preview state lets a close/switch cancel the in-flight probe; staleness
   * is re-checked after the await so a late response can't overwrite a newer
   * preview. A failed conversion renders a Retry affordance.
   */
  async _renderOfficeConversionPreview(bodyEl, fetchUrl, iframeFragment, filePath, expectedState) {
    if (!bodyEl) return;
    const isCurrentPreview = () => !expectedState || this.filePreviewState === expectedState;
    // Abort any prior in-flight readiness probe for this state before re-probing
    // (e.g. a poll re-render after the document was rewritten).
    this._teardownOfficePreviewResources(expectedState);
    bodyEl.innerHTML = '<div class="binary-message">Rendering document…</div>';
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (expectedState) expectedState.previewFetchAbort = controller;
    let res;
    try {
      res = await fetch(fetchUrl, controller ? { signal: controller.signal } : undefined);
    } catch (err) {
      if ((err && err.name === 'AbortError') || !isCurrentPreview()) return;
      this._renderOfficePreviewError(bodyEl, null);
      return;
    }
    if (!isCurrentPreview()) return;
    if (!res || !res.ok) {
      let message = null;
      try {
        const errBody = await res.json();
        if (errBody && typeof errBody.error === 'string') message = errBody.error;
      } catch {
        // Non-JSON error body — fall back to a generic message.
      }
      if (!isCurrentPreview()) return;
      this._renderOfficePreviewError(bodyEl, message);
      return;
    }
    // Conversion succeeded and is now warm in the server/disk cache. Free the
    // probe's response body (we never read it) and render the iframe against the
    // same-origin URL — CSP-allowed and a fast cache hit.
    try {
      res.body?.cancel();
    } catch {
      // Body already consumed/unsupported — nothing to release.
    }
    if (!isCurrentPreview()) return;
    bodyEl.innerHTML = `<iframe class="document-preview-frame" src="${fetchUrl}${iframeFragment}" title="${escapeHtml(
      filePath
    )}"></iframe>`;
  },

  /** Render an Office-conversion failure state with a Retry control (COD-239). */
  _renderOfficePreviewError(bodyEl, message) {
    if (!bodyEl) return;
    const text = message || 'Document preview conversion failed';
    bodyEl.innerHTML =
      `<div class="binary-message">${escapeHtml(text)}<br><br>` +
      `<button class="btn-icon-sm" onclick="app.retryFilePreview()">Retry</button></div>`;
  },

  /**
   * Cancel any in-flight Office conversion readiness probe so a close/switch
   * can't let a late response overwrite a newer preview (COD-239). Safe to call
   * repeatedly and on states with nothing set.
   */
  _teardownOfficePreviewResources(state) {
    if (!state) return;
    try {
      state.previewFetchAbort?.abort();
    } catch {
      // Aborting an already-settled controller is a no-op.
    }
    state.previewFetchAbort = null;
  },

  /** Dispose the worker/fetch lifecycle owned by a spreadsheet preview state. */
  _disposeSpreadsheetPreview(state) {
    if (!state?.spreadsheetPreview) return;
    try {
      state.spreadsheetPreview.dispose();
    } catch {
      // Disposal is best-effort; the state identity still prevents stale renders.
    }
    state.spreadsheetPreview = null;
  },

  /** Re-open the current preview from scratch (COD-239 conversion Retry). */
  retryFilePreview() {
    const st = this.filePreviewState;
    if (!st) return;
    if (st.displayPath && st.displayPath !== st.filePath) {
      this.openFilePreview(st.filePath, st.sessionId, st.attachmentId, { displayPath: st.displayPath });
      return;
    }
    this.openFilePreview(st.filePath, st.sessionId, st.attachmentId);
  },

  _startFilePreviewPolling() {
    this._stopFilePreviewPolling(true);
    // Light cadence: a metadata stat every 1.5s while the preview is open and visible.
    this._filePreviewPollTimer = setInterval(() => this._pollFilePreview(), 1500);
  },

  _stopFilePreviewPolling(keepState = false) {
    if (this._filePreviewPollTimer) {
      clearInterval(this._filePreviewPollTimer);
      this._filePreviewPollTimer = null;
    }
    // On close/switch (not a poll-cycle restart) cancel the outgoing preview's
    // in-flight Office conversion readiness probe before dropping its state.
    if (!keepState) {
      this._teardownOfficePreviewResources(this.filePreviewState);
      this._disposeSpreadsheetPreview?.(this.filePreviewState);
      this.filePreviewState = null;
      this._resetFilePreviewOriginalDownloadAction?.();
    }
  },

  async _pollFilePreview() {
    const st = this.filePreviewState;
    const overlay = this.$('filePreviewOverlay');
    if (!st || !overlay || !overlay.classList.contains('visible') || document.hidden) return;
    // Never poll while the editor is open: a change on disk re-renders the body
    // wholesale (_renderFilePreviewBody replaces innerHTML), which would destroy
    // the textarea and every unsaved keystroke in it. The agent writing the file
    // underneath the editor is exactly when this fires, and it is also exactly
    // what the save path's baseHash 409 is there to catch — so the right answer
    // is to stop refreshing, not to merge.
    if (this.filePreviewEdit) return;
    if (this._filePreviewPolling) return; // don't overlap slow fetches
    this._filePreviewPolling = true;
    try {
      const data = await this._fetchFilePreviewMetadata(st.metadataUrl);
      if (this.filePreviewState !== st) return;
      this._setFilePreviewExternalUrl?.(st, data);
      st.mtimeMs = data.mtimeMs ?? null;
      const sig = this._filePreviewSignature(data);
      if (sig === st.signature) return; // unchanged
      st.signature = sig;
      // In revision-review mode, keep the diff live as the agent keeps editing.
      if (st.mode === 'diff') {
        await this.showDocumentDiff(st.diffFrom);
        return;
      }
      const SCROLLERS = '.document-preview-markdown, .document-preview-text, .document-preview-stage, .document-preview-diff';
      const bodyEl = this.$('filePreviewBody');
      const prevTop = bodyEl?.querySelector(SCROLLERS)?.scrollTop || 0;
      const rendered = await this._renderFilePreviewBody(
        data,
        {
          sessionId: st.sessionId,
          filePath: st.filePath,
          attachmentId: st.attachmentId,
        },
        st
      );
      if (!rendered || this.filePreviewState !== st) return;
      const newScroller = this.$('filePreviewBody')?.querySelector(SCROLLERS);
      if (newScroller) newScroller.scrollTop = prevTop;
    } catch {
      // File may be momentarily unavailable mid-write \u2014 keep the last good render.
    } finally {
      this._filePreviewPolling = false;
    }
  },

  /** Query string identifying the previewed document for the /documents endpoints. */
  _documentParams() {
    const st = this.filePreviewState;
    if (!st) return '';
    return st.attachmentId
      ? `attachmentId=${encodeURIComponent(st.attachmentId)}`
      : `path=${encodeURIComponent(st.filePath)}`;
  },

  /**
   * Render the "Export PDF" footer control (COD-61), or '' when the document
   * isn't exportable. Server supports docx/pptx (cached LibreOffice PDF) and
   * md/markdown/txt (HTML→PDF); other types (incl. already-PDF) are skipped.
   */
  _renderExportPdfControl() {
    const st = this.filePreviewState;
    if (!st || (!st.filePath && !st.attachmentId)) return '';
    const ext = (st.filePath || '').split('.').pop()?.toLowerCase() || '';
    const exportable = ['docx', 'pptx', 'md', 'markdown', 'mdown', 'txt', 'text'];
    // attachmentId-only previews (no path) still expose the control; the server
    // resolves the extension from the attachment record and 400s if unsupported.
    if (st.filePath && !exportable.includes(ext)) return '';
    return ` <button class="btn-icon-sm document-export-btn" onclick="app.exportDocumentPdf()" title="Download a PDF of this document">Export PDF</button>`;
  },

  /** Download a PDF of the open document via the export endpoint (COD-61). */
  exportDocumentPdf() {
    const st = this.filePreviewState;
    if (!st || !st.sessionId) {
      this.showToast?.('No document to export', 'error');
      return;
    }
    const params = this._documentParams();
    if (!params) {
      this.showToast?.('No document to export', 'error');
      return;
    }
    const url = `/api/sessions/${st.sessionId}/documents/export?${params}&format=pdf`;
    // Trigger a download via a temporary anchor so a server error (which returns
    // a JSON envelope, not a PDF) doesn't navigate the SPA away.
    const a = document.createElement('a');
    a.href = url;
    a.download = '';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  /** Switch the preview into revision-review mode and render the diff (COD-59). */
  async showDocumentDiff(fromId = null) {
    const st = this.filePreviewState;
    if (!st) return;
    st.mode = 'diff';
    st.diffFrom = fromId;
    const sid = st.sessionId;
    const params = this._documentParams();
    const isCurrentDiff = () => this.filePreviewState === st && st.mode === 'diff';
    try {
      const vres = await fetch(`/api/sessions/${sid}/documents/versions?${params}`);
      if (!isCurrentDiff()) return;
      let versions = [];
      if (vres.ok) {
        const versionBody = await vres.json();
        if (!isCurrentDiff()) return;
        versions = versionBody.data?.versions || [];
      }
      let diff = { ops: [], from: null, to: null };
      if (versions.length >= 2) {
        const to = versions[versions.length - 1].id;
        const from = fromId || versions[versions.length - 2].id;
        const dres = await fetch(
          `/api/sessions/${sid}/documents/diff?${params}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
        );
        if (!isCurrentDiff()) return;
        if (dres.ok) {
          const diffBody = await dres.json();
          if (!isCurrentDiff()) return;
          diff = diffBody.data;
        }
      }
      if (!isCurrentDiff()) return;
      this._renderDocumentDiff(versions, diff);
    } catch (err) {
      if (!isCurrentDiff()) return;
      const bodyEl = this.$('filePreviewBody');
      if (bodyEl) bodyEl.innerHTML = `<div class="binary-message">Error: ${escapeHtml(err.message)}</div>`;
    }
  },

  _renderDocumentDiff(versions, diff) {
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');
    if (!bodyEl) return;
    const latest = versions[versions.length - 1];
    const seqOf = (id) => (versions.find((vv) => vv.id === id) || {}).seq || '';
    const diffHtml = (diff.ops || [])
      .map((op) => {
        const v = escapeHtml(op.value);
        if (op.type === 'insert') return `<ins>${v}</ins>`;
        if (op.type === 'delete') return `<del>${v}</del>`;
        return `<span>${v}</span>`;
      })
      .join('');
    const fromSelect =
      versions.length >= 2
        ? `<label class="document-diff-from">Compare from
            <select onchange="app.showDocumentDiff(this.value)">
              ${versions
                .slice(0, -1)
                .map((vv) => `<option value="${escapeHtml(vv.id)}" ${vv.id === diff.from ? 'selected' : ''}>v${vv.seq}</option>`)
                .join('')}
            </select> \u2192 v${latest ? latest.seq : ''}</label>`
        : '';
    const restoreBtn =
      diff.from && diff.from !== diff.to
        ? `<button class="btn-icon-sm" onclick="app.rollbackDocument(${escapeHtml(JSON.stringify(diff.from))})">Restore v${seqOf(diff.from)}</button>`
        : '';
    const content =
      versions.length < 2
        ? `<div class="binary-message">Only one version captured so far \u2014 keep this preview open while the agent edits to build up revision history.</div>`
        : `<pre class="document-preview-diff">${diffHtml}</pre>`;
    bodyEl.innerHTML = `
      <div class="document-preview-actions">
        <button class="btn-icon-sm" onclick="app.exitDocumentDiff()">\u2190 Back to preview</button>
        ${fromSelect}
        ${restoreBtn}
        <button class="btn-icon-sm document-comment-btn" onclick="app.commentOnSelection()">Comment</button>
      </div>
      ${content}`;
    // COD-100: re-apply comment highlights onto the freshly-rendered diff body, the
    // same way the normal preview does (COD-95). The diff render replaces the
    // annotated DOM, so commented passages would otherwise lose their highlight in
    // the Changes view; COD-68 intended highlight/annotation to work on BOTH views.
    // Anchors that no longer match the diffed text are skipped gracefully.
    this._applyCommentHighlights(bodyEl.querySelector('.document-preview-diff'));
    if (footerEl) {
      footerEl.textContent = `${versions.length} version${versions.length === 1 ? '' : 's'} \u2022 additions and deletions vs the selected version`;
    }
  },

  /** Leave revision-review mode and re-render the live document. */
  async exitDocumentDiff() {
    const st = this.filePreviewState;
    if (!st) return;
    st.mode = 'preview';
    st.diffFrom = null;
    try {
      const data = await this._fetchFilePreviewMetadata(st.metadataUrl);
      if (this.filePreviewState !== st) return;
      st.signature = this._filePreviewSignature(data);
      st.mtimeMs = data.mtimeMs ?? null;
      await this._renderFilePreviewBody(
        data,
        {
          sessionId: st.sessionId,
          filePath: st.filePath,
          attachmentId: st.attachmentId,
        },
        st
      );
    } catch {
      // Leave the diff in place if the document can't be re-read right now.
    }
  },

  /** Restore the document to a prior version, then return to the live preview. */
  async rollbackDocument(versionId) {
    const st = this.filePreviewState;
    if (!st || !versionId) return;
    const body = st.attachmentId ? { attachmentId: st.attachmentId, versionId } : { path: st.filePath, versionId };
    try {
      const res = await fetch(`/api/sessions/${st.sessionId}/documents/rollback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        this.showToast?.('Document rolled back', 'success');
        await this.exitDocumentDiff();
      } else {
        this.showToast?.('Rollback failed', 'error');
      }
    } catch {
      this.showToast?.('Rollback failed', 'error');
    }
  },

  /** Switch the .docx preview between PDF, selectable HTML, and Changes views (COD-68). */
  async switchDocxView(view) {
    const st = this.filePreviewState;
    if (!st) return;
    if (view === 'changes') {
      await this.showDocumentDiff();
      return;
    }
    st.mode = 'preview';
    st.docxView = view;
    try {
      const data = await this._fetchFilePreviewMetadata(st.metadataUrl);
      if (this.filePreviewState !== st) return;
      st.signature = this._filePreviewSignature(data);
      st.mtimeMs = data.mtimeMs ?? null;
      await this._renderFilePreviewBody(
        data,
        {
          sessionId: st.sessionId,
          filePath: st.filePath,
          attachmentId: st.attachmentId,
        },
        st
      );
    } catch {
      /* keep current view on error */
    }
  },

  /** Capture the selected passage in the preview and open the annotation composer (COD-60/69). */
  commentOnSelection() {
    const bodyEl = this.$('filePreviewBody');
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    const text = sel ? String(sel).trim() : '';
    let withinPreview = false;
    if (sel && sel.rangeCount && bodyEl) {
      const node = sel.getRangeAt(0).commonAncestorContainer;
      withinPreview = bodyEl.contains(node.nodeType === 1 ? node : node.parentNode);
    }
    if (!text || !withinPreview) {
      this.showToast?.('Select some text in the document first', 'info');
      return;
    }
    // COD-95: resolve which occurrence of the selected quote this is, so the
    // highlight can be re-applied after the preview re-renders. We anchor on the
    // whitespace-collapsed quote + its 0-based occurrence index within the prose.
    // Compute it BEFORE opening the popover (opening clears any prior pending value),
    // then assign so addAnnotation can read it.
    const occurrence = this._selectionOccurrence(sel, this._previewProseEl());
    this._openAnnotationPopover(text);
    this._annotationPendingOccurrence = occurrence;
  },

  /**
   * The rendered prose container the highlights live in: markdown, plain text, or
   * the diff/Changes body (COD-68). COD-100 adds `.document-preview-diff` so the
   * comment highlight + click-to-edit work while comparing versions, not just in
   * the normal preview.
   */
  _previewProseEl() {
    const bodyEl = this.$('filePreviewBody');
    return bodyEl?.querySelector('.document-preview-markdown, .document-preview-text, .document-preview-diff') || null;
  },

  /** Collapse runs of whitespace to single spaces (matches stored anchor quotes). */
  _normalizeQuote(s) {
    return String(s ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * COD-95: which 0-based occurrence of the selected quote (within `prose`) the
   * current selection represents. Counts collapsed-text matches that start at or
   * before the selection's start offset. Returns 0 when it can't be determined.
   */
  _selectionOccurrence(sel, prose) {
    try {
      if (!sel || !sel.rangeCount || !prose) return 0;
      const quote = this._normalizeQuote(String(sel));
      if (!quote) return 0;
      const range = sel.getRangeAt(0);
      // Text from the prose start up to the selection start, collapsed the same way.
      const pre = range.cloneRange();
      pre.selectNodeContents(prose);
      pre.setEnd(range.startContainer, range.startOffset);
      const before = this._normalizeQuote(pre.toString());
      // Count non-overlapping matches of the quote that fully precede the selection.
      let count = 0;
      let idx = before.indexOf(quote);
      while (idx !== -1) {
        count++;
        idx = before.indexOf(quote, idx + quote.length);
      }
      return count;
    } catch {
      return 0;
    }
  },

  /**
   * COD-95: build a stable anchor for a comment — the normalized quote plus the
   * 0-based occurrence index within `prose`. Returns null when the quote isn't
   * present (so we never persist an un-findable anchor).
   */
  _buildCommentAnchor(quote, prose, occurrence = 0) {
    const q = this._normalizeQuote(quote);
    if (!q) return null;
    const haystack = this._normalizeQuote(prose?.textContent || '');
    if (haystack.indexOf(q) === -1) return null;
    return { quote: q, occurrence: Math.max(0, occurrence | 0) };
  },

  /**
   * COD-95: re-apply every comment highlight onto the freshly-rendered prose. The
   * preview re-renders on poll, so DOM spans are destroyed and must be rebuilt from
   * the persisted anchors. For each anchor we walk the prose text nodes, locate the
   * Nth occurrence of the (whitespace-collapsed) quote across the concatenated text,
   * and wrap exactly that run — splitting text nodes as needed — in a
   * `<span class="comment-highlight" data-comment-id>`. Quotes that can't be re-found
   * (text changed) are skipped silently; nothing throws.
   */
  _applyCommentHighlights(prose) {
    if (!prose) return;
    const anns = (this._annotations || []).filter((a) => a && a.anchor && a.anchor.quote);
    // Bind the delegated click-to-edit handler once per prose container.
    if (!prose.dataset.commentHighlightBound) {
      prose.dataset.commentHighlightBound = '1';
      prose.addEventListener('click', (ev) => {
        const span = ev.target?.closest?.('.comment-highlight');
        if (span) this.editCommentFromHighlight(span.getAttribute('data-comment-id'));
      });
    }
    for (const ann of anns) {
      try {
        this._wrapNthOccurrence(prose, ann.anchor.quote, ann.anchor.occurrence | 0, ann.id);
      } catch {
        /* anchor not re-findable after a content change — skip it gracefully */
      }
    }
  },

  /**
   * Wrap the `occurrence`-th (0-based) match of the whitespace-collapsed `quote`
   * within `root`'s text in highlight spans. Matching is done over the visible text
   * with whitespace collapsed, mapping match positions back to (textNode, offset)
   * pairs so a quote spanning multiple text nodes is wrapped piece by piece. No-op
   * when the occurrence isn't found.
   */
  _wrapNthOccurrence(root, quote, occurrence, commentId) {
    const q = this._normalizeQuote(quote);
    if (!q) return;
    // Collect text nodes (skip ones already inside a highlight to avoid re-wrapping).
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && n.parentElement.closest('.comment-highlight')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const segments = []; // { node, start, end } over the COLLAPSED concatenation
    let collapsed = '';
    let prevWasSpace = true; // leading whitespace is trimmed in the collapsed form
    let node;
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue || '';
      const segStart = collapsed.length;
      // Map each raw char position to its position in the collapsed string.
      const map = []; // map[i] = collapsed index for raw char i (or -1 if dropped)
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (/\s/.test(ch)) {
          if (prevWasSpace) {
            map.push(-1);
          } else {
            map.push(collapsed.length);
            collapsed += ' ';
            prevWasSpace = true;
          }
        } else {
          map.push(collapsed.length);
          collapsed += ch;
          prevWasSpace = false;
        }
      }
      segments.push({ node, raw, map, segStart });
    }
    const collapsedTrimmed = collapsed; // already collapsed; may have a trailing space
    // Find the Nth occurrence start index in the collapsed text.
    let from = 0;
    let foundAt = -1;
    for (let k = 0; k <= occurrence; k++) {
      const at = collapsedTrimmed.indexOf(q, from);
      if (at === -1) return; // not enough occurrences
      foundAt = at;
      from = at + q.length;
    }
    const matchStart = foundAt;
    const matchEnd = foundAt + q.length; // exclusive, in collapsed coords

    // For each text node, wrap the sub-range that falls inside [matchStart, matchEnd).
    for (const seg of segments) {
      // Determine which raw-char offsets in this node map into the match window.
      let rawStart = -1;
      let rawEnd = -1;
      for (let i = 0; i < seg.raw.length; i++) {
        const c = seg.map[i];
        if (c === -1) continue;
        if (c >= matchStart && c < matchEnd) {
          if (rawStart === -1) rawStart = i;
          rawEnd = i + 1;
        }
      }
      if (rawStart === -1) continue; // this node contributes nothing to the match
      this._wrapTextNodeRange(seg.node, rawStart, rawEnd, commentId);
    }
  },

  /** Wrap [start, end) of a single text node in a comment-highlight span. */
  _wrapTextNodeRange(textNode, start, end, commentId) {
    const raw = textNode.nodeValue || '';
    const mid = raw.slice(start, end);
    const after = raw.slice(end);
    const before = raw.slice(0, start);
    const span = document.createElement('span');
    span.className = 'comment-highlight';
    span.setAttribute('data-comment-id', commentId);
    span.setAttribute('title', 'Click to edit this comment');
    span.textContent = mid;
    const parent = textNode.parentNode;
    if (!parent) return;
    if (after) parent.insertBefore(document.createTextNode(after), textNode.nextSibling);
    parent.insertBefore(span, textNode.nextSibling);
    textNode.nodeValue = before;
    if (!before) parent.removeChild(textNode);
  },

  /** COD-95: open the existing comment for the clicked highlight, ready to edit. */
  editCommentFromHighlight(commentId) {
    const ann = (this._annotations || []).find((a) => a.id === commentId);
    if (!ann) return;
    this._annotationPassage = ann.passage || ann.anchor?.quote || '';
    this._openAnnotationPopover(this._annotationPassage, { note: ann.note || '', editingId: commentId });
  },

  _openAnnotationPopover(passage, { note = '', editingId = null } = {}) {
    this._closeAnnotationPopover();
    const shortPassage = passage.length > 240 ? `${passage.slice(0, 240)}…` : passage;
    const editing = !!editingId;
    const pop = document.createElement('div');
    pop.className = 'annotation-popover';
    pop.id = 'annotationPopover';
    pop.innerHTML = `
      <div class="annotation-popover-title">${editing ? 'Edit comment' : 'Add comment on selection'}</div>
      <blockquote class="annotation-quote">${escapeHtml(shortPassage)}</blockquote>
      <textarea class="annotation-note" rows="3" placeholder="e.g. tighten this; make it less formal; add a citation"></textarea>
      <div class="annotation-popover-actions">
        <button type="button" class="btn-icon-sm" onclick="app._closeAnnotationPopover()">Cancel</button>
        <button type="button" class="btn-icon-sm annotation-send" onclick="app.addAnnotation()">${
          editing ? 'Save comment' : 'Add to review'
        }</button>
      </div>`;
    document.body.appendChild(pop);
    this._annotationPassage = passage;
    this._editingCommentId = editingId;
    const ta = pop.querySelector('.annotation-note');
    if (ta) ta.value = note;
    setTimeout(() => ta?.focus(), 0);
  },

  _closeAnnotationPopover() {
    document.getElementById('annotationPopover')?.remove();
    this._annotationPassage = null;
    this._annotationPendingOccurrence = 0;
    this._editingCommentId = null;
  },

  /** Add the composed {passage, note} to the review tray (COD-69), or update an
   * existing comment when editing from a highlight (COD-95). */
  addAnnotation() {
    const pop = document.getElementById('annotationPopover');
    if (!pop) return;
    const note = (pop.querySelector('.annotation-note')?.value || '').trim();
    if (!note) {
      this.showToast?.('Add a note first', 'info');
      return;
    }
    this._annotations = this._annotations || [];
    const editingId = this._editingCommentId;
    if (editingId) {
      // COD-95: edit-in-place from a highlight — keep id + anchor, swap the note.
      const existing = this._annotations.find((a) => a.id === editingId);
      if (existing) existing.note = note;
      this._closeAnnotationPopover();
    } else {
      const passage = this._normalizeQuote(this._annotationPassage || '');
      // COD-95: persist a stable anchor (quote + occurrence) so the selection can
      // be re-highlighted after the preview re-renders.
      const anchor = this._buildCommentAnchor(passage, this._previewProseEl(), this._annotationPendingOccurrence || 0);
      this._annotations.push({ id: this._newCommentId(), passage, note, anchor });
      this._closeAnnotationPopover();
    }
    this._renderAnnotationTray();
    // Re-apply highlights immediately so the new/edited comment is visible.
    this._applyCommentHighlights(this._previewProseEl());
  },

  /** Short, stable id for a comment (crypto.randomUUID with fallback). */
  _newCommentId() {
    try {
      const uuid = globalThis.crypto?.randomUUID?.();
      if (uuid) return `cmt-${uuid.slice(0, 8)}`;
    } catch {
      /* ignore */
    }
    return `cmt-${Math.random().toString(36).slice(2, 10)}`;
  },

  removeAnnotation(index) {
    if (!this._annotations) return;
    this._annotations.splice(index, 1);
    this._renderAnnotationTray();
    this._applyCommentHighlights(this._previewProseEl());
  },

  _closeAnnotationTray() {
    document.getElementById('annotationTray')?.remove();
  },

  clearAnnotations() {
    this._annotations = [];
    this._closeAnnotationTray();
  },

  _renderAnnotationTray() {
    this._closeAnnotationTray();
    const items = this._annotations || [];
    if (!items.length) return;
    const tray = document.createElement('div');
    tray.className = 'annotation-tray';
    tray.id = 'annotationTray';
    const rows = items
      .map((a, i) => {
        const passage = a.passage || a.anchor?.quote || '';
        const snippet = passage.length > 80 ? `${passage.slice(0, 80)}…` : passage;
        return `<li class="annotation-tray-item">
            <button class="annotation-tray-remove" title="Remove" onclick="app.removeAnnotation(${i})">×</button>
            <div class="annotation-tray-passage">“${escapeHtml(snippet)}”</div>
            <div class="annotation-tray-note">${escapeHtml(a.note)}</div>
          </li>`;
      })
      .join('');
    tray.innerHTML = `
      <div class="annotation-tray-title">Review comments (${items.length})</div>
      <ul class="annotation-tray-list">${rows}</ul>
      <div class="annotation-tray-actions">
        <button type="button" class="btn-icon-sm" onclick="app.clearAnnotations()">Clear</button>
        <button type="button" class="btn-icon-sm" onclick="app.saveAnnotationsToReviewFile()">Save to review file</button>
        <button type="button" class="btn-icon-sm annotation-send" onclick="app.sendAnnotationsAsPrompt()">Send as prompt</button>
      </div>`;
    document.body.appendChild(tray);
  },

  _annotationTargetBody() {
    const st = this.filePreviewState;
    return st && st.attachmentId ? { attachmentId: st.attachmentId } : { path: st?.filePath };
  },

  /** Send all collected annotations as one consolidated single-line instruction (COD-69). */
  async sendAnnotationsAsPrompt() {
    const st = this.filePreviewState;
    const items = this._annotations || [];
    if (!st || !items.length) return;
    const fileName = (st.filePath || '').split('/').pop() || 'the document';
    const list = items
      .map((a, i) => {
        const p = a.passage.length > 160 ? `${a.passage.slice(0, 160)}…` : a.passage;
        return `(${i + 1}) "${p}" — ${a.note}`;
      })
      .join('; ');
    const message = `Please apply these edits to ${fileName}: ${list}`.replace(/\s+/g, ' ').trim();
    if (await this._postSessionInput(st.sessionId, message)) {
      this.showToast?.(`Sent ${items.length} comment${items.length === 1 ? '' : 's'} to the session`, 'success');
      this.clearAnnotations();
    }
  },

  /** Write the collected annotations to a review file and ask the agent to apply it (COD-69). */
  async saveAnnotationsToReviewFile() {
    const st = this.filePreviewState;
    const items = this._annotations || [];
    if (!st || !items.length) return;
    try {
      const res = await fetch(`/api/sessions/${st.sessionId}/documents/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...this._annotationTargetBody(), annotations: items }),
      });
      if (!res.ok) {
        this.showToast?.('Failed to write review file', 'error');
        return;
      }
      const reviewPath = (await res.json()).data?.path;
      const fileName = (st.filePath || '').split('/').pop() || 'the document';
      const message = `Please apply the review comments in ${reviewPath} to ${fileName}.`;
      if (await this._postSessionInput(st.sessionId, message)) {
        this.showToast?.(`Saved ${items.length} comments to ${reviewPath} and asked the agent to apply them`, 'success');
        this.clearAnnotations();
        // COD-74: close the preview window and surface the prompt to the user.
        this.closeFilePreview();
        this.terminal?.focus();
      }
    } catch {
      this.showToast?.('Failed to write review file', 'error');
    }
  },

  async _postSessionInput(sessionId, input) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input, useMux: true }),
      });
      if (!res.ok) this.showToast?.('Failed to send to session', 'error');
      return res.ok;
    } catch {
      this.showToast?.('Failed to send to session', 'error');
      return false;
    }
  },

  // ── Authoring actions (COD-64) ───────────────────────────────────────────
  // User-configured one-click actions surfaced in the document preview footer.
  // Each action sends a templated single-line instruction to the open document's
  // agent session. Ships empty — the user authors these in App Settings → Authoring.

  /** Read the user's configured authoring actions from the cached app-settings store. */
  _authoringActions() {
    const list = this.loadAppSettingsFromStorage?.().authoringActions;
    return Array.isArray(list) ? list : [];
  },

  /**
   * Build the instruction sent to the agent: replace every `{path}` in the template
   * with the document path; if the template has no `{path}`, append ` <path>`. Pure;
   * kept single-line (writeViaMux is single-line only).
   */
  buildActionInstruction(template, path) {
    const t = String(template ?? '');
    const p = String(path ?? '');
    const out = t.includes('{path}') ? t.split('{path}').join(p) : `${t} ${p}`;
    return out.replace(/\s+/g, ' ').trim();
  },

  /**
   * Normalize editor rows into the persisted shape: trim label/instruction, drop
   * rows missing either, assign a stable id when absent, and cap at 20. Pure.
   */
  normalizeAuthoringActions(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
      const label = String(row?.label ?? '').trim();
      const instruction = String(row?.instruction ?? '').trim();
      if (!label || !instruction) continue;
      const id = String(row?.id ?? '').trim() || this._newAuthoringActionId();
      out.push({ id, label, instruction });
      if (out.length >= 20) break;
    }
    return out;
  },

  /** Short, stable id for a new authoring action (crypto.randomUUID with fallback). */
  _newAuthoringActionId() {
    try {
      const uuid = globalThis.crypto?.randomUUID?.();
      if (uuid) return `act-${uuid.slice(0, 8)}`;
    } catch {
      /* ignore */
    }
    return `act-${Math.random().toString(36).slice(2, 10)}`;
  },

  /** Footer control: an "Authoring ▾" button revealing the configured actions. */
  _renderAuthoringControl() {
    const actions = this._authoringActions();
    if (!actions.length || !this.filePreviewState?.sessionId) return '';
    const items = actions
      .map(
        (a) =>
          `<button class="authoring-action-item" onclick="app.runAuthoringAction(${escapeHtml(JSON.stringify(a.id))})">${escapeHtml(
            a.label
          )}</button>`
      )
      .join('');
    return (
      ` <span class="document-authoring-wrap">` +
      `<button class="btn-icon-sm document-authoring-btn" onclick="app.toggleAuthoringMenu(event)">Authoring ▾</button>` +
      `<div class="authoring-action-menu" hidden>${items}</div>` +
      `</span>`
    );
  },

  /** Toggle the authoring actions dropdown open/closed. */
  toggleAuthoringMenu(event) {
    event?.stopPropagation?.();
    const wrap = event?.currentTarget?.closest?.('.document-authoring-wrap');
    const menu = wrap?.querySelector('.authoring-action-menu');
    if (!menu) return;
    const open = menu.hasAttribute('hidden');
    if (open) {
      menu.removeAttribute('hidden');
      const close = (e) => {
        if (!wrap.contains(e.target)) {
          menu.setAttribute('hidden', '');
          document.removeEventListener('click', close, true);
        }
      };
      document.addEventListener('click', close, true);
    } else {
      menu.setAttribute('hidden', '');
    }
  },

  /** Look up an action by id, interpolate the path, and send it to the session. */
  async runAuthoringAction(actionId) {
    const st = this.filePreviewState;
    const action = this._authoringActions().find((a) => a.id === actionId);
    if (!action) return;
    if (!st?.sessionId) {
      this.showToast?.('No active session for this document', 'error');
      return;
    }
    const instruction = this.buildActionInstruction(action.instruction, st.filePath || '');
    if (!instruction) return;
    if (await this._postSessionInput(st.sessionId, instruction)) {
      this.showToast?.(`Sent "${action.label}" to the session`, 'success');
    }
  },

  _fitFilePreviewImage() {
    const img = document.querySelector('.document-preview-image');
    const stage = img?.closest('.document-preview-stage');
    if (!img || !stage) return false;
    const body = stage.parentElement;
    const toolbar = body?.querySelector('.document-preview-toolbar');
    const style = getComputedStyle(stage);
    // The stage's auto height can grow to the intrinsic image height. Measure
    // the fixed preview body instead so a tall image is fitted to the visible
    // viewport, not to the overflow area it created itself.
    const containerWidth = body?.clientWidth || stage.clientWidth;
    const containerHeight = body?.clientHeight
      ? body.clientHeight - (toolbar?.offsetHeight || 0)
      : stage.clientHeight;
    const availableWidth = containerWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
    const availableHeight = containerHeight - parseFloat(style.paddingTop || '0') - parseFloat(style.paddingBottom || '0');
    const imageWidth = img.offsetWidth;
    const imageHeight = img.offsetHeight;
    if (availableWidth <= 0 || availableHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) return false;

    this.filePreviewZoom = Math.min(1, availableWidth / imageWidth, availableHeight / imageHeight);
    img.style.transform = `scale(${this.filePreviewZoom})`;
    return true;
  },

  setFilePreviewZoom(action) {
    const img = document.querySelector('.document-preview-image');
    if (!img) return;
    if (action === 'fit') {
      this.filePreviewZoomMode = 'fit';
      this._fitFilePreviewImage();
      return;
    }
    const currentZoom = this.filePreviewZoom || 1;
    const zoomFactor = 1.25;
    if (action === 'in') {
      this.filePreviewZoom = Math.min(4, currentZoom * zoomFactor);
    } else if (action === 'out') {
      this.filePreviewZoom = currentZoom / zoomFactor;
    }
    this.filePreviewZoomMode = 'manual';
    img.style.transform = `scale(${this.filePreviewZoom})`;
  },

  openAttachmentInNewTab(sessionId, filePath, attachmentId = null) {
    const url = attachmentId
      ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/raw`
      : `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`;
    window.open(url, '_blank');
  },

  /** Restore the persisted preview size and keep saving it as the user resizes (COD-67). */
  _restorePreviewSize() {
    const win = this.$('filePreviewOverlay')?.querySelector?.('.file-preview-window');
    if (!win) return;
    try {
      const saved = JSON.parse(localStorage.getItem('codeman.filePreviewSize') || 'null');
      if (saved && saved.w && saved.h) {
        win.style.width = `${saved.w}px`;
        win.style.height = `${saved.h}px`;
      }
    } catch {
      /* ignore corrupt setting */
    }
    if (!this._filePreviewResizeObs && typeof ResizeObserver !== 'undefined') {
      this._filePreviewResizeObs = new ResizeObserver(() => {
        if (this.filePreviewZoomMode === 'fit') this._fitFilePreviewImage();
        clearTimeout(this._filePreviewResizeSaveTimer);
        this._filePreviewResizeSaveTimer = setTimeout(() => {
          try {
            localStorage.setItem(
              'codeman.filePreviewSize',
              JSON.stringify({ w: Math.round(win.offsetWidth), h: Math.round(win.offsetHeight) })
            );
          } catch {
            /* storage full / unavailable */
          }
        }, 300);
      });
      this._filePreviewResizeObs.observe(win);
    }
  },

  closeFilePreview() {
    // Closing with an unsaved edit buffer would discard it silently — the buffer
    // lives only in the textarea. Ask first, and abort the close on Cancel.
    if (this.filePreviewEdit?.dirty && !confirm('Discard unsaved changes?')) return;
    this._resetFilePreviewEdit();
    this._stopFilePreviewPolling();
    this._resetFilePreviewExternalAction?.();
    this._hideFilePreviewNavigation();
    this._teardownOutlineScrollSpy();
    this._closeAnnotationPopover();
    this._closeAnnotationTray();
    const overlay = this.$('filePreviewOverlay');
    if (overlay) {
      overlay.classList.remove('visible');
    }
    // The overlay is hidden with display:none, which stops it being PAINTED and
    // nothing else: a <video>/<audio> inside it keeps playing, keeps its audio
    // audible and keeps streaming from the server. Closing has to stop it.
    this._stopFilePreviewMedia?.();
    this.filePreviewContent = '';
  },

  copyFilePreviewContent() {
    if (this.filePreviewState?.previewKind === 'image') {
      return this._copyFilePreviewImage();
    }
    if (this.filePreviewContent) {
      navigator.clipboard
        .writeText(this.filePreviewContent)
        .then(() => {
          this.showToast('Copied to clipboard', 'success');
        })
        .catch(() => {
          this.showToast('Failed to copy', 'error');
        });
    }
  },

  async _copyFilePreviewImage() {
    const imageUrl = this.filePreviewState?.previewCopyUrl;
    if (!imageUrl) {
      this.showToast('Failed to copy image to clipboard', 'error');
      return false;
    }
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('Image clipboard API unavailable');
      }
      const res = await fetch(imageUrl);
      if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
      let blob = await res.blob();
      const contentType = res.headers?.get?.('content-type') || '';
      if ((!blob.type || blob.type === 'application/octet-stream') && contentType.startsWith('image/')) {
        blob = new Blob([blob], { type: contentType });
      }
      if (!blob.type.startsWith('image/')) {
        throw new Error(`Unexpected clipboard type: ${blob.type || 'unknown'}`);
      }
      const item = new ClipboardItem({ [blob.type]: blob });
      await navigator.clipboard.write([item]);
      this.showToast('Copied image to clipboard', 'success');
      return true;
    } catch (err) {
      console.error('Failed to copy preview image:', err);
      this.showToast('Failed to copy image to clipboard', 'error');
      return false;
    }
  },

  // ───────────────────────── Document preview: outline / reading view / word count (COD-62) ─────────

  /** Collapse whitespace and count words, dropping empties. Pure. */
  _countWords(text) {
    if (!text) return 0;
    return text
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
  },

  /** Format the footer reading meta: "1,234 words · ~6 min read" (200 wpm, min 1 min). Pure. */
  _formatReadingMeta(words) {
    const minutes = Math.max(1, Math.round(words / 200));
    return `${words.toLocaleString()} words · ~${minutes} min read`;
  },

  /** Slugify heading text into a DOM id; dedupe via the provided used-id set. */
  _slugifyHeading(text, used) {
    let base =
      String(text || '')
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'section';
    let id = base;
    let i = 1;
    while (used.has(id)) id = `${base}-${i++}`;
    used.add(id);
    return id;
  },

  /**
   * Build a nested outline <nav> from the already-rendered+sanitized prose container.
   * Assigns stable ids to headings that lack one. Returns null when fewer than 2 headings.
   * Heading text is read via textContent only (never innerHTML).
   */
  _buildDocumentOutline(prose) {
    if (!prose) return null;
    const headings = [...prose.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    if (headings.length < 2) return null;
    const used = new Set();
    headings.forEach((h) => {
      if (h.id) used.add(h.id);
    });
    const nav = document.createElement('nav');
    nav.className = 'document-outline';
    nav.id = 'documentOutline';
    const list = document.createElement('ul');
    list.className = 'document-outline-list';
    headings.forEach((h) => {
      if (!h.id) h.id = this._slugifyHeading(h.textContent, used);
      const level = Number(h.tagName.slice(1)) || 1;
      const li = document.createElement('li');
      li.className = `document-outline-item document-outline-l${level}`;
      const a = document.createElement('a');
      a.className = 'document-outline-link';
      a.href = `#${h.id}`;
      a.dataset.outlineTarget = h.id;
      a.textContent = h.textContent || '';
      li.appendChild(a);
      list.appendChild(li);
    });
    nav.appendChild(list);
    nav.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-outline-target]');
      if (!link) return;
      e.preventDefault();
      const target = prose.querySelector(`#${CSS.escape(link.dataset.outlineTarget)}`);
      if (target) target.scrollIntoView({ block: 'start' });
    });
    return nav;
  },

  /** (Re)create the scroll-spy IntersectionObserver tying headings to nav entries. */
  _setupOutlineScrollSpy(nav, prose) {
    this._teardownOutlineScrollSpy();
    const scroller = this.$('filePreviewBody');
    if (!nav || !prose || !scroller || typeof IntersectionObserver === 'undefined') return;
    const headings = [...prose.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter((h) => h.id);
    const linkFor = (id) => nav.querySelector(`a[data-outline-target="${CSS.escape(id)}"]`);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.find((en) => en.isIntersecting);
        if (!visible) return;
        nav.querySelectorAll('a.active').forEach((a) => a.classList.remove('active'));
        const link = linkFor(visible.target.id);
        if (link) link.classList.add('active');
      },
      { root: scroller, rootMargin: '0px 0px -70% 0px', threshold: 0 }
    );
    headings.forEach((h) => observer.observe(h));
    this._documentOutlineObserver = observer;
  },

  _teardownOutlineScrollSpy() {
    if (this._documentOutlineObserver) {
      this._documentOutlineObserver.disconnect();
      this._documentOutlineObserver = null;
    }
  },

  _readPreviewPref(key) {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  },

  _writePreviewPref(key, on) {
    try {
      localStorage.setItem(key, on ? '1' : '0');
    } catch {
      /* jsdom / private mode */
    }
  },

  /** Toggle the outline sidebar open/closed and persist the preference. */
  toggleDocumentOutline() {
    const layout = this.$('filePreviewBody')?.querySelector('.document-preview-layout');
    const nav = this.$('documentOutline');
    if (!layout || !nav) return;
    const open = !layout.classList.contains('outline-open');
    layout.classList.toggle('outline-open', open);
    const btn = this.$('filePreviewFooter')?.querySelector('.document-outline-btn');
    if (btn) btn.classList.toggle('active', open);
    this._writePreviewPref('codeman.preview.outlineOpen', open);
  },

  /** Toggle reading-view (constrained measure) on the prose container and persist the preference. */
  toggleReadingView() {
    const overlay = this.$('filePreviewOverlay');
    const prose = overlay?.querySelector('.document-preview-markdown, .document-preview-text');
    if (!prose) return;
    const on = !this.readingViewActive;
    this.readingViewActive = on;
    prose.classList.toggle('reading-view', on);
    const btn = this.$('filePreviewFooter')?.querySelector('.document-reading-btn');
    if (btn) btn.classList.toggle('active', on);
    this._writePreviewPref('codeman.preview.readingView', on);
  },

  getFileIcon(ext) {
    if (!ext) return '\uD83D\uDCC4';

    const icons = {
      ts: '\uD83D\uDCD8',
      tsx: '\uD83D\uDCD8',
      js: '\uD83D\uDCD2',
      jsx: '\uD83D\uDCD2',
      mjs: '\uD83D\uDCD2',
      cjs: '\uD83D\uDCD2',
      py: '\uD83D\uDC0D',
      pyx: '\uD83D\uDC0D',
      pyw: '\uD83D\uDC0D',
      rs: '\uD83E\uDD80',
      go: '\uD83D\uDC39',
      c: '\u2699\uFE0F',
      cpp: '\u2699\uFE0F',
      h: '\u2699\uFE0F',
      hpp: '\u2699\uFE0F',
      html: '\uD83C\uDF10',
      htm: '\uD83C\uDF10',
      css: '\uD83C\uDFA8',
      scss: '\uD83C\uDFA8',
      sass: '\uD83C\uDFA8',
      less: '\uD83C\uDFA8',
      json: '\uD83D\uDCCB',
      yaml: '\uD83D\uDCCB',
      yml: '\uD83D\uDCCB',
      xml: '\uD83D\uDCCB',
      toml: '\uD83D\uDCCB',
      csv: '\uD83D\uDCCB',
      md: '\uD83D\uDCDD',
      markdown: '\uD83D\uDCDD',
      txt: '\uD83D\uDCDD',
      rst: '\uD83D\uDCDD',
      png: '\uD83D\uDDBC\uFE0F',
      jpg: '\uD83D\uDDBC\uFE0F',
      jpeg: '\uD83D\uDDBC\uFE0F',
      gif: '\uD83D\uDDBC\uFE0F',
      svg: '\uD83D\uDDBC\uFE0F',
      webp: '\uD83D\uDDBC\uFE0F',
      ico: '\uD83D\uDDBC\uFE0F',
      bmp: '\uD83D\uDDBC\uFE0F',
      mp4: '\uD83C\uDFAC',
      webm: '\uD83C\uDFAC',
      mov: '\uD83C\uDFAC',
      mp3: '\uD83C\uDFB5',
      wav: '\uD83C\uDFB5',
      ogg: '\uD83C\uDFB5',
      sh: '\uD83D\uDCBB',
      bash: '\uD83D\uDCBB',
      zsh: '\uD83D\uDCBB',
      env: '\uD83D\uDD10',
      gitignore: '\uD83D\uDEAB',
      dockerfile: '\uD83D\uDC33',
      lock: '\uD83D\uDD12',
    };

    return icons[ext.toLowerCase()] || '\uD83D\uDCC4';
  },

  formatFileSize(bytes) {
    if (bytes === undefined || bytes === null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  },

  /**
   * Pause and unload every media element in the preview body, then empty it.
   *
   * Removing the element from the DOM is NOT enough — a detached HTMLMediaElement
   * plays on until it is garbage collected, which is why the X button used to
   * leave a video audible. pause() stops playback, dropping src + load() aborts
   * the in-flight network fetch and puts the element back in NETWORK_EMPTY.
   */
  _stopFilePreviewMedia() {
    const bodyEl = this.$('filePreviewBody');
    if (!bodyEl) return;
    // `?? []`: the unit harnesses hand this a partial body stub, matching how the
    // sibling preview resets are called with `?.`.
    for (const media of bodyEl.querySelectorAll?.('video, audio') ?? []) {
      try {
        media.pause();
        media.removeAttribute('src');
        media.load();
      } catch (err) {
        console.warn('Failed to stop preview media:', err);
      }
    }
    bodyEl.innerHTML = '';
  },

  // ═══════════════════════════════════════════════════════════════
  // File Viewer edit mode (issue #212 — docs/file-viewer-edit-plan.md)
  // ═══════════════════════════════════════════════════════════════

  _resetFilePreviewEdit() {
    this.filePreviewEdit = null;
    this.filePreviewEditTarget = null;
    const editBtn = this.$('filePreviewEditBtn');
    if (editBtn) editBtn.hidden = true;
    const editBar = this.$('filePreviewEditBar');
    if (editBar) editBar.hidden = true;
    const dirtyEl = this.$('filePreviewDirty');
    if (dirtyEl) dirtyEl.hidden = true;
    const saveBtn = this.$('filePreviewSaveBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Save';
    }
  },

  async enterFilePreviewEdit() {
    const target = this.filePreviewEditTarget;
    if (!target || this.filePreviewEdit) return;
    const bodyEl = this.$('filePreviewBody');
    const footerEl = this.$('filePreviewFooter');
    if (!bodyEl) return;

    // Always re-fetch with edit=1: the preview buffer may be line-truncated and
    // a truncated buffer must never become an edit buffer. Parse the envelope
    // even on non-ok responses so the specific refusal ("too large to edit
    // here") reaches the toast instead of a generic failure.
    let data;
    try {
      const res = await fetch(
        `/api/sessions/${target.sessionId}/file-content?path=${encodeURIComponent(target.filePath)}&edit=1`
      );
      const result = await res.json().catch(() => null);
      if (!result || result.success !== true) {
        throw new Error(result?.error || `Failed to load file for editing (HTTP ${res.status})`);
      }
      data = result.data;
    } catch (err) {
      this.showToast(err.message, 'error');
      return;
    }

    this.filePreviewEdit = {
      sessionId: target.sessionId,
      filePath: target.filePath,
      baseHash: data.hash,
      eol: data.eol,
      original: data.content,
      dirty: false,
      saving: false,
    };

    const textarea = document.createElement('textarea');
    textarea.className = 'file-preview-editor';
    textarea.spellcheck = false;
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.wrap = 'off';
    textarea.value = data.content;
    textarea.addEventListener('input', () => this._onFilePreviewEditInput());
    bodyEl.innerHTML = '';
    bodyEl.appendChild(textarea);
    // Deliberately no autofocus: on phones that would pop the OS keyboard
    // before the user has scrolled to the line they want to change.

    const editBtn = this.$('filePreviewEditBtn');
    if (editBtn) editBtn.hidden = true;
    const editBar = this.$('filePreviewEditBar');
    if (editBar) editBar.hidden = false;
    if (footerEl) {
      const eolNote = data.eol === 'crlf' ? ' • CRLF' : '';
      footerEl.textContent = `Editing • ${data.totalLines} lines • ${this.formatFileSize(data.size)}${eolNote}`;
    }
  },

  _onFilePreviewEditInput() {
    const edit = this.filePreviewEdit;
    if (!edit) return;
    const textarea = this.$('filePreviewBody')?.querySelector('textarea.file-preview-editor');
    if (!textarea) return;
    edit.dirty = textarea.value !== edit.original;
    const dirtyEl = this.$('filePreviewDirty');
    if (dirtyEl) dirtyEl.hidden = !edit.dirty;
    const saveBtn = this.$('filePreviewSaveBtn');
    if (saveBtn) saveBtn.disabled = !edit.dirty || edit.saving;
  },

  cancelFilePreviewEdit() {
    const edit = this.filePreviewEdit;
    if (!edit) return;
    if (edit.dirty && !confirm('Discard unsaved changes?')) return;
    const { sessionId, filePath } = edit;
    this._resetFilePreviewEdit();
    this.openFilePreview(filePath, sessionId);
  },

  async saveFilePreviewEdit(force = false) {
    const edit = this.filePreviewEdit;
    if (!edit || edit.saving) return;
    const textarea = this.$('filePreviewBody')?.querySelector('textarea.file-preview-editor');
    if (!textarea) return;

    edit.saving = true;
    const saveBtn = this.$('filePreviewSaveBtn');
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
    }
    const restoreSaveState = () => {
      edit.saving = false;
      if (saveBtn) saveBtn.textContent = 'Save';
      this._onFilePreviewEditInput();
    };

    let result = null;
    let status = 0;
    try {
      const res = await fetch(`/api/sessions/${edit.sessionId}/file-content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: edit.filePath,
          content: textarea.value,
          baseHash: edit.baseHash,
          eol: edit.eol ?? undefined, // Zod .optional() rejects null
          force: force || undefined,
        }),
      });
      status = res.status;
      result = await res.json().catch(() => null);
    } catch (err) {
      restoreSaveState();
      this.showToast(`Save failed: ${err.message}`, 'error');
      return;
    }

    if (status === 409 || result?.errorCode === 'CONFLICT') {
      restoreSaveState();
      if (
        confirm(
          'File changed on disk since you loaded it.\nOK overwrites it with your version; Cancel keeps your draft open.'
        )
      ) {
        this.saveFilePreviewEdit(true);
      }
      return;
    }
    if (!result || result.success !== true) {
      restoreSaveState();
      this.showToast(`Save failed: ${result?.error || `HTTP ${status}`}`, 'error');
      return;
    }

    const { sessionId, filePath } = edit;
    this._resetFilePreviewEdit();
    this.showToast('Saved', 'success');
    // Re-open in read mode — re-fetching shows the truth on disk (including the
    // server-side EOL normalization) rather than trusting the local buffer.
    this.openFilePreview(filePath, sessionId);
  },

  // ═══════════════════════════════════════════════════════════════
  // Log Viewer Windows (Floating File Streamers)
  // ═══════════════════════════════════════════════════════════════

  openLogViewerWindow(filePath, sessionId) {
    sessionId = sessionId || this.activeSessionId;
    if (!sessionId) return;

    // Create unique window ID
    const windowId = `${sessionId}-${filePath.replace(/[^a-zA-Z0-9]/g, '_')}`;

    // If window already exists, focus it
    if (this.logViewerWindows.has(windowId)) {
      const existing = this.logViewerWindows.get(windowId);
      existing.element.style.zIndex = ++this.logViewerWindowZIndex;
      return;
    }

    // Calculate position (cascade from top-left)
    const windowCount = this.logViewerWindows.size;
    const offsetX = 100 + (windowCount % 5) * 30;
    const offsetY = 100 + (windowCount % 5) * 30;

    // Get filename for title
    const fileName = filePath.split('/').pop();

    // Create window element
    const win = document.createElement('div');
    win.className = 'log-viewer-window';
    win.id = `log-viewer-window-${windowId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.logViewerWindowZIndex;

    win.innerHTML = `
      <div class="log-viewer-window-header">
        <div class="log-viewer-window-title" title="${escapeHtml(filePath)}">
          <span class="icon">📄</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="status streaming">streaming</span>
        </div>
        <div class="log-viewer-window-actions">
          <button onclick="app.closeLogViewerWindow(${escapeHtml(JSON.stringify(windowId))})" title="Close">×</button>
        </div>
      </div>
      <div class="log-viewer-window-body" id="log-viewer-body-${windowId}">
        <div class="log-info">Connecting to ${escapeHtml(filePath)}...</div>
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable (returns listener refs for cleanup)
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.log-viewer-window-header'));

    // Connect to SSE stream
    const eventSource = new EventSource(
      `/api/sessions/${sessionId}/tail-file?path=${encodeURIComponent(filePath)}&lines=50`
    );

    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      const body = document.getElementById(`log-viewer-body-${windowId}`);
      if (!body) return;

      switch (data.type) {
        case 'connected':
          body.innerHTML = '';
          break;
        case 'data':
          // Append data, auto-scroll
          const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 10;
          const content = escapeHtml(data.content);
          body.innerHTML += content;
          if (wasAtBottom) {
            body.scrollTop = body.scrollHeight;
          }
          // Trim if too large
          if (body.innerHTML.length > 500000) {
            body.innerHTML = body.innerHTML.slice(-400000);
          }
          break;
        case 'end':
          this.updateLogViewerStatus(windowId, 'disconnected', 'ended');
          break;
        case 'error':
          body.innerHTML += `<div class="log-error">${escapeHtml(data.error)}</div>`;
          this.updateLogViewerStatus(windowId, 'error', 'error');
          break;
      }
    };

    eventSource.onerror = () => {
      this.updateLogViewerStatus(windowId, 'disconnected', 'connection error');
    };

    // Store reference (including drag listeners for cleanup)
    this.logViewerWindows.set(windowId, {
      element: win,
      eventSource,
      filePath,
      sessionId,
      dragListeners, // Store for cleanup to prevent memory leaks
    });
  },

  updateLogViewerStatus(windowId, statusClass, statusText) {
    const statusEl = document.querySelector(`#log-viewer-window-${windowId} .status`);
    if (statusEl) {
      statusEl.className = `status ${statusClass}`;
      statusEl.textContent = statusText;
    }
  },

  closeLogViewerWindow(windowId) {
    const windowData = this.logViewerWindows.get(windowId);
    if (!windowData) return;

    // Close SSE connection
    if (windowData.eventSource) {
      windowData.eventSource.close();
    }

    // Clean up drag event listeners (both document-level and handle-level)
    if (windowData.dragListeners) {
      document.removeEventListener('mousemove', windowData.dragListeners.move);
      document.removeEventListener('mouseup', windowData.dragListeners.up);
      if (windowData.dragListeners.handle) {
        windowData.dragListeners.handle.removeEventListener('mousedown', windowData.dragListeners.handleMouseDown);
        windowData.dragListeners.handle.removeEventListener('touchstart', windowData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    windowData.element.remove();

    // Remove from map
    this.logViewerWindows.delete(windowId);
  },

  // Close all log viewer windows for a session
  closeSessionLogViewerWindows(sessionId) {
    const toClose = [];
    for (const [windowId, data] of this.logViewerWindows) {
      if (data.sessionId === sessionId) {
        toClose.push(windowId);
      }
    }
    for (const windowId of toClose) {
      this.closeLogViewerWindow(windowId);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Attachment Cards (detected documents/images)
  // ═══════════════════════════════════════════════════════════════

  updateAttachmentHistoryCountFromSession(session) {
    if (!session?.id) return;
    const count = Array.isArray(session.attachmentHistory) ? session.attachmentHistory.length : 0;
    if (count > 0) {
      this.attachmentHistoryCounts.set(session.id, count);
    } else {
      this.attachmentHistoryCounts.delete(session.id);
    }
    if (session.id === this.activeSessionId) {
      this.updateAttachmentHistoryBadge();
    }
  },

  updateAttachmentHistoryBadge(count = null) {
    const badge = document.getElementById('attachmentHistoryBadge');
    const button = document.getElementById('attachmentsHistoryBtn');
    const sessionId = this.activeSessionId;
    const nextCount = count ?? (sessionId ? this.attachmentHistoryCounts.get(sessionId) || 0 : 0);
    if (badge) {
      badge.textContent = String(Math.min(nextCount, 99));
      badge.style.display = nextCount > 0 ? '' : 'none';
    }
    if (button) {
      button.classList.toggle('active', this.attachmentHistoryDrawerOpen);
      button.setAttribute('aria-expanded', this.attachmentHistoryDrawerOpen ? 'true' : 'false');
    }
  },

  ensureAttachmentHistoryDrawer() {
    let drawer = document.getElementById('attachmentHistoryDrawer');
    if (drawer) return drawer;

    drawer = document.createElement('aside');
    drawer.id = 'attachmentHistoryDrawer';
    drawer.className = 'attachment-history-drawer';
    drawer.setAttribute('aria-label', 'Attachment history');
    drawer.innerHTML = `
      <div class="attachment-history-header">
        <div>
          <div class="attachment-history-title">Attachments</div>
          <div class="attachment-history-subtitle" id="attachmentHistorySubtitle">0 files</div>
        </div>
        <div class="attachment-history-header-actions">
          <button type="button" class="btn-icon-sm" id="attachmentHistoryAddBtn" title="Add files" aria-label="Add files">&#x2795;</button>
          <button type="button" class="btn-icon-sm" id="attachmentHistoryRefreshBtn" title="Refresh" aria-label="Refresh attachments">&#x21BB;</button>
          <button type="button" class="btn-icon-sm" id="attachmentHistoryCloseBtn" title="Close" aria-label="Close attachments">&times;</button>
        </div>
      </div>
      <div class="attachment-history-list" id="attachmentHistoryList"></div>
    `;
    document.body.appendChild(drawer);
    drawer.querySelector('#attachmentHistoryAddBtn')?.addEventListener('click', () => {
      this.pickDocumentsForUpload();
    });
    drawer.querySelector('#attachmentHistoryRefreshBtn')?.addEventListener('click', () => {
      this.loadAttachmentHistory(this.activeSessionId);
    });
    drawer.querySelector('#attachmentHistoryCloseBtn')?.addEventListener('click', () => {
      this.closeAttachmentHistory();
    });
    return drawer;
  },

  async toggleAttachmentHistory() {
    if (this.attachmentHistoryDrawerOpen) {
      this.closeAttachmentHistory();
      return;
    }
    await this.openAttachmentHistory();
  },

  async openAttachmentHistory() {
    const drawer = this.ensureAttachmentHistoryDrawer();
    this.attachmentHistoryDrawerOpen = true;
    drawer.classList.add('open');
    this.updateAttachmentHistoryBadge();
    await this.loadAttachmentHistory(this.activeSessionId);
  },

  closeAttachmentHistory() {
    const drawer = document.getElementById('attachmentHistoryDrawer');
    this.attachmentHistoryDrawerOpen = false;
    drawer?.classList.remove('open');
    this.updateAttachmentHistoryBadge();
  },

  async loadAttachmentHistory(sessionId = this.activeSessionId) {
    const drawer = this.ensureAttachmentHistoryDrawer();
    const list = drawer.querySelector('#attachmentHistoryList');
    const subtitle = drawer.querySelector('#attachmentHistorySubtitle');
    if (!list || !subtitle) return;

    if (!sessionId) {
      this.attachmentHistoryItems = [];
      subtitle.textContent = 'No session';
      list.innerHTML = '<div class="attachment-history-empty">No active session</div>';
      this.updateAttachmentHistoryBadge(0);
      return;
    }

    list.innerHTML = '<div class="attachment-history-empty">Loading...</div>';
    try {
      const res = await fetch(`/api/sessions/${sessionId}/attachments`);
      if (!res.ok) throw new Error('Failed to load attachments');
      const result = await res.json();
      if (!result.success) throw new Error(result.error || 'Failed to load attachments');
      const items = result.data?.items || [];
      this.attachmentHistoryItems = items;
      this.attachmentHistoryCounts.set(sessionId, items.length);
      this.updateAttachmentHistoryBadge(items.length);
      this.renderAttachmentHistory(items);
    } catch (err) {
      console.error('Failed to load attachment history:', err);
      subtitle.textContent = 'Unavailable';
      list.innerHTML = `<div class="attachment-history-empty">Error: ${escapeHtml(err.message)}</div>`;
    }
  },

  renderAttachmentHistory(items = this.attachmentHistoryItems || []) {
    const drawer = this.ensureAttachmentHistoryDrawer();
    const list = drawer.querySelector('#attachmentHistoryList');
    const subtitle = drawer.querySelector('#attachmentHistorySubtitle');
    if (!list || !subtitle) return;

    subtitle.textContent = `${items.length} ${items.length === 1 ? 'file' : 'files'}`;
    if (items.length === 0) {
      // COD-103: reference the Codeman CLI alias actually on PATH (default label
      // 'aicodeman' when status not yet loaded / nothing on PATH), and warn when
      // neither alias resolves so the `attach` instruction isn't silently broken.
      const cli = this.codemanCli || { onPath: true, name: 'aicodeman' };
      const cliName = cli.name || 'aicodeman';
      const warning = cli.onPath
        ? ''
        : `<div class="cli-path-warning">⚠ Codeman CLI not found on PATH — add <code>~/.local/bin</code> to your PATH to use this.</div>`;
      list.innerHTML = `
        <div class="attachment-history-empty">
          <div class="attachment-history-empty-title">No attachments yet</div>
          <div>Show a file here by running:</div>
          <code>${cliName} attach /absolute/path/to/file.pptx</code>
          ${warning}
          <div>Supports .pptx, .docx, .xlsx, .pdf, .png, .md, and .txt.</div>
        </div>
      `;
      return;
    }

    list.innerHTML = items.map((item) => this.renderAttachmentHistoryItem(item)).join('');
    list.querySelectorAll('.attachment-history-thumb-img').forEach((img) => {
      img.onerror = () => {
        img.remove();
        const fallback = img.closest('.attachment-history-thumb')?.querySelector('.attachment-history-thumb-fallback');
        fallback?.classList.add('visible');
      };
    });
    list.querySelectorAll('[data-attachment-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const id = button.getAttribute('data-history-id');
        const action = button.getAttribute('data-attachment-action');
        if (!id || !action) return;
        if (action === 'preview') this.previewAttachmentHistoryItem(id);
        if (action === 'download') this.downloadAttachmentHistoryItem(id);
        if (action === 'open') this.openAttachmentHistoryItem(id);
        if (action === 'reshow') this.reshowAttachmentCard(id);
        if (action === 'remove') {
          const it = this.getAttachmentHistoryItem(id);
          if (it && it.relativePath) this.deleteUploadedAttachment(it.sessionId, it.relativePath);
        }
      });
    });
  },

  renderAttachmentHistoryItem(item) {
    const typeLabel = (item.extension || item.attachmentType || 'file').toUpperCase();
    const meta = [
      item.source === 'external' ? 'published' : 'workspace',
      this.formatFileSize(item.size || 0),
      item.missing ? 'missing' : '',
    ].filter(Boolean).join(' \u2022 ');
    const thumb = item.thumbnailUrl && !item.missing
      ? `<img class="attachment-history-thumb-img" src="${escapeHtml(item.thumbnailUrl)}" alt="">`
      : '';
    const disabled = item.missing ? 'disabled aria-disabled="true"' : '';
    // COD-241 unit 3: only Codeman-uploaded copies (inside .codeman-attachments/)
    // are removable; a detected/external reference to the user's own file is not.
    const isOwnedUpload =
      typeof item.relativePath === 'string' && item.relativePath.startsWith('.codeman-attachments/');
    const removeBtn = isOwnedUpload
      ? `<button type="button" data-attachment-action="remove" data-history-id="${escapeHtml(
          item.id
        )}" title="Remove uploaded file" aria-label="Remove uploaded file ${escapeHtml(item.fileName)}" ${disabled}>Remove</button>`
      : '';
    return `
      <div class="attachment-history-item ${item.missing ? 'missing' : ''}" data-history-item="${escapeHtml(item.id)}">
        <div class="attachment-history-thumb">
          ${thumb}
          <div class="attachment-history-thumb-fallback ${thumb ? '' : 'visible'}">${escapeHtml(typeLabel)}</div>
        </div>
        <div class="attachment-history-item-main">
          <div class="attachment-history-file-name" title="${escapeHtml(item.fileName)}">${escapeHtml(item.fileName)}</div>
          <div class="attachment-history-meta">${escapeHtml(meta)}</div>
          <div class="attachment-history-actions">
            <button type="button" data-attachment-action="preview" data-history-id="${escapeHtml(item.id)}" ${disabled}>Preview</button>
            <button type="button" data-attachment-action="download" data-history-id="${escapeHtml(item.id)}" ${disabled}>Download</button>
            <button type="button" data-attachment-action="open" data-history-id="${escapeHtml(item.id)}" ${disabled}>Open</button>
            <button type="button" data-attachment-action="reshow" data-history-id="${escapeHtml(item.id)}" ${disabled}>Card</button>
            ${removeBtn}
          </div>
        </div>
      </div>
    `;
  },

  getAttachmentHistoryItem(itemId) {
    return (this.attachmentHistoryItems || []).find((item) => item.id === itemId) || null;
  },

  previewAttachmentHistoryItem(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing) return;
    const path = item.relativePath || item.fileName;
    this.openFilePreview(path, item.sessionId, item.attachmentId || null);
    // COD-72: close the drawer so the preview window is unobstructed
    this.closeAttachmentHistory();
  },

  openAttachmentHistoryItem(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing) return;
    if (item.rawUrl || item.url) {
      window.open(item.rawUrl || item.url, '_blank');
      return;
    }
    this.openAttachmentInNewTab(item.sessionId, item.relativePath || item.fileName, item.attachmentId || null);
  },

  downloadAttachmentHistoryItem(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing || !item.downloadUrl) return;
    window.open(item.downloadUrl, '_blank');
  },

  reshowAttachmentCard(itemId) {
    const item = this.getAttachmentHistoryItem(itemId);
    if (!item || item.missing) return;
    this.addAttachmentCard({
      sessionId: item.sessionId,
      relativePath: item.relativePath,
      fileName: item.fileName,
      timestamp: Date.now(),
      size: item.size,
      attachmentType: item.attachmentType,
      extension: item.extension,
      attachmentId: item.attachmentId,
      rawUrl: item.rawUrl,
      previewUrl: item.previewUrl,
      thumbnailUrl: item.thumbnailUrl,
    });
  },

  ensureAttachmentCardStack() {
    let stack = this.attachmentCardStack || document.getElementById('attachmentCardStack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'attachmentCardStack';
      stack.className = 'attachment-card-stack';
      document.body.appendChild(stack);
    }
    this.attachmentCardStack = stack;
    return stack;
  },

  addAttachmentCard(attachmentEvent) {
    const {
      sessionId,
      relativePath,
      fileName,
      timestamp,
      size,
      attachmentType,
      extension,
      attachmentId,
      rawUrl,
      previewUrl,
      thumbnailUrl,
    } = attachmentEvent;
    const filePath = relativePath || fileName;
    const cardId = attachmentId || `${sessionId}-${timestamp}-${fileName}`;

    if (this.attachmentCards.has(cardId)) {
      const existing = this.attachmentCards.get(cardId);
      existing.element.focus?.();
      return;
    }

    const MAX_ATTACHMENT_CARDS = 10;
    if (this.attachmentCards.size >= MAX_ATTACHMENT_CARDS) {
      const oldestId = this.attachmentCards.keys().next().value;
      if (oldestId) this.closeAttachmentCard(oldestId);
    }

    const stack = this.ensureAttachmentCardStack();
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);
    const attachmentRawUrl = rawUrl || (attachmentId
      ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/raw`
      : `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`);
    const attachmentPreviewUrl = previewUrl || (attachmentId
      ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/preview`
      : null);
    const attachmentThumbnailUrl = thumbnailUrl || (attachmentId
      ? `/api/sessions/${sessionId}/attachments/${encodeURIComponent(attachmentId)}/thumbnail`
      : `/api/sessions/${sessionId}/file-thumbnail?path=${encodeURIComponent(filePath)}`);
    const downloadUrl = attachmentId ? `${attachmentRawUrl}?download=true` : `${attachmentRawUrl}&download=true`;
    const typeLabel = (extension || attachmentType || 'file').toUpperCase();

    const card = document.createElement('article');
    card.className = `attachment-card attachment-${escapeHtml(attachmentType || 'file')}`;
    card.tabIndex = 0;
    card.dataset.attachmentId = cardId;
    card.dataset.previewUrl = attachmentPreviewUrl || '';
    card.innerHTML = `
      <div class="attachment-thumbnail">
        ${attachmentThumbnailUrl ? `<img class="attachment-thumbnail-img" src="${escapeHtml(attachmentThumbnailUrl)}" alt="">` : ''}
        <div class="attachment-thumbnail-fallback ${attachmentThumbnailUrl ? '' : 'visible'}">${escapeHtml(typeLabel)}</div>
      </div>
      <div class="attachment-card-main">
        <div class="attachment-file-name" title="${escapeHtml(filePath)}">${escapeHtml(fileName)}</div>
        <div class="attachment-file-meta">
          <span>${escapeHtml(sessionName)}</span>
          <span>${this.formatFileSize(size || 0)}</span>
        </div>
        <div class="attachment-actions">
          <button type="button" class="attachment-preview-btn">Preview</button>
          <a href="${escapeHtml(downloadUrl)}">Download</a>
          <button type="button" class="attachment-open-btn">Open</button>
          <button type="button" class="attachment-go-session-btn" title="Switch to this session">Go to session</button>
        </div>
      </div>
      <button type="button" class="attachment-close-btn" title="Dismiss">&times;</button>
    `;

    const attachmentThumbnailImg = card.querySelector('.attachment-thumbnail-img');
    if (attachmentThumbnailImg) {
      attachmentThumbnailImg.onerror = () => {
        attachmentThumbnailImg.remove();
        card.querySelector('.attachment-thumbnail-fallback')?.classList.add('visible');
      };
    }

    card.querySelector('.attachment-preview-btn')?.addEventListener('click', () => {
      this.openFilePreview(filePath, sessionId, attachmentId || null);
    });
    card.querySelector('.attachment-open-btn')?.addEventListener('click', () => {
      this.openAttachmentInNewTab(sessionId, filePath, attachmentId || null);
    });
    card.querySelector('.attachment-go-session-btn')?.addEventListener('click', () => {
      this.selectSession(sessionId);
    });
    card.querySelector('.attachment-close-btn')?.addEventListener('click', () => {
      this.closeAttachmentCard(cardId);
    });

    stack.prepend(card);
    this.attachmentCards.set(cardId, { element: card, sessionId, filePath });
    this._refreshAttachmentClearAll();
  },

  // Centralized show/hide for the stack's "Clear all" control. Both addAttachmentCard and
  // closeAttachmentCard call this so the control appears on the 2nd card and hides at <=1.
  // The control lives as a header inside #attachmentCardStack; it's created lazily and only
  // ever shown when >=2 cards are present (absent/hidden at 0 and 1 card).
  _refreshAttachmentClearAll() {
    const stack = this.attachmentCardStack;
    if (!stack) return;
    let control = stack.querySelector('.attachment-clear-all');
    if (this.attachmentCards.size < 2) {
      if (control) control.hidden = true;
      return;
    }
    if (!control) {
      control = document.createElement('button');
      control.type = 'button';
      control.className = 'attachment-clear-all';
      control.textContent = 'Clear all';
      control.title = 'Dismiss all attachment cards';
      control.addEventListener('click', () => this.closeAllAttachmentCards());
    }
    stack.prepend(control);
    control.hidden = false;
  },

  closeAttachmentCard(attachmentId) {
    const cardData = this.attachmentCards.get(attachmentId);
    if (!cardData) return;
    cardData.element.remove();
    this.attachmentCards.delete(attachmentId);
    if (this.attachmentCardStack && this.attachmentCards.size === 0) {
      this.attachmentCardStack.remove();
      this.attachmentCardStack = null;
    } else {
      this._refreshAttachmentClearAll();
    }
  },

  // Dismiss every attachment card at once. Reuses the per-card close path so there are no
  // leaked DOM nodes or stale map entries; the per-card teardown drops the #attachmentCardStack
  // container once the map empties (so we don't double-remove it here).
  closeAllAttachmentCards() {
    for (const attachmentId of [...this.attachmentCards.keys()]) {
      this.closeAttachmentCard(attachmentId);
    }
  },

  closeSessionAttachmentCards(sessionId) {
    const toClose = [];
    for (const [attachmentId, data] of this.attachmentCards) {
      if (data.sessionId === sessionId) toClose.push(attachmentId);
    }
    for (const attachmentId of toClose) {
      this.closeAttachmentCard(attachmentId);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Image Popup Windows (Auto-popup for Screenshots)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open a popup window to display a detected image.
   * Called automatically when image:detected SSE event is received.
   */
  openImagePopup(imageEvent) {
    const { sessionId, filePath, relativePath, fileName, timestamp, size } = imageEvent;

    // Create unique window ID
    const imageId = `${sessionId}-${timestamp}`;

    // If window already exists for this image, focus it
    if (this.imagePopups.has(imageId)) {
      const existing = this.imagePopups.get(imageId);
      existing.element.style.zIndex = ++this.imagePopupZIndex;
      return;
    }

    // Cap open popups at 20 — close oldest when at limit
    const MAX_IMAGE_POPUPS = 20;
    if (this.imagePopups.size >= MAX_IMAGE_POPUPS) {
      // Map iteration order is insertion order, so first key is oldest
      const oldestId = this.imagePopups.keys().next().value;
      if (oldestId) this.closeImagePopup(oldestId);
    }

    // Calculate position (cascade from center, with offset for multiple popups)
    const windowCount = this.imagePopups.size;
    const centerX = (window.innerWidth - 600) / 2;
    const centerY = (window.innerHeight - 500) / 2;
    const offsetX = centerX + (windowCount % 5) * 30;
    const offsetY = centerY + (windowCount % 5) * 30;

    // Get session name for display
    const session = this.sessions.get(sessionId);
    const sessionName = session?.name || sessionId.substring(0, 8);

    // Format file size
    const sizeKB = (size / 1024).toFixed(1);

    // Build image URL using the existing file-raw endpoint
    // Use relativePath (path from working dir) instead of fileName (basename) for subdirectory images
    const imageUrl = `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(relativePath || fileName)}`;

    // Create window element
    const win = document.createElement('div');
    win.className = 'image-popup-window';
    win.id = `image-popup-${imageId}`;
    win.style.left = `${offsetX}px`;
    win.style.top = `${offsetY}px`;
    win.style.zIndex = ++this.imagePopupZIndex;

    win.innerHTML = `
      <div class="image-popup-header">
        <div class="image-popup-title" title="${escapeHtml(filePath)}">
          <span class="icon">🖼️</span>
          <span class="filename">${escapeHtml(fileName)}</span>
          <span class="session-badge">${escapeHtml(sessionName)}</span>
          <span class="size-badge">${sizeKB} KB</span>
        </div>
        <div class="image-popup-actions">
          <button onclick="app.openImageInNewTab(${escapeHtml(JSON.stringify(imageUrl))})" title="Open in new tab">↗</button>
          <button onclick="app.closeImagePopup(${escapeHtml(JSON.stringify(imageId))})" title="Close">×</button>
        </div>
      </div>
      <div class="image-popup-body">
        <img src="${imageUrl}" alt="${escapeHtml(fileName)}"
             onerror="this.parentElement.innerHTML='<div class=\\'image-error\\'>Failed to load image</div>'"
             onclick="app.openImageInNewTab(${escapeHtml(JSON.stringify(imageUrl))})" />
      </div>
    `;

    document.body.appendChild(win);

    // Make draggable
    const dragListeners = this.makeWindowDraggable(win, win.querySelector('.image-popup-header'));

    // Focus on click
    win.addEventListener('mousedown', () => {
      win.style.zIndex = ++this.imagePopupZIndex;
    });

    // Store reference
    this.imagePopups.set(imageId, {
      element: win,
      sessionId,
      filePath,
      dragListeners,
    });
  },

  /**
   * Close an image popup window.
   */
  closeImagePopup(imageId) {
    const popupData = this.imagePopups.get(imageId);
    if (!popupData) return;

    // Clean up drag event listeners (both document-level and handle-level)
    if (popupData.dragListeners) {
      document.removeEventListener('mousemove', popupData.dragListeners.move);
      document.removeEventListener('mouseup', popupData.dragListeners.up);
      if (popupData.dragListeners.touchMove) {
        document.removeEventListener('touchmove', popupData.dragListeners.touchMove);
        document.removeEventListener('touchend', popupData.dragListeners.up);
        document.removeEventListener('touchcancel', popupData.dragListeners.up);
      }
      if (popupData.dragListeners.handle) {
        popupData.dragListeners.handle.removeEventListener('mousedown', popupData.dragListeners.handleMouseDown);
        popupData.dragListeners.handle.removeEventListener('touchstart', popupData.dragListeners.handleTouchStart);
      }
    }

    // Remove element
    popupData.element.remove();

    // Remove from map
    this.imagePopups.delete(imageId);
  },

  /**
   * Open image in a new browser tab.
   */
  openImageInNewTab(url) {
    window.open(url, '_blank');
  },

  /**
   * Close all image popups for a session.
   */
  closeSessionImagePopups(sessionId) {
    const toClose = [];
    for (const [imageId, data] of this.imagePopups) {
      if (data.sessionId === sessionId) {
        toClose.push(imageId);
      }
    }
    for (const imageId of toClose) {
      this.closeImagePopup(imageId);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Mux Sessions (in Monitor Panel)
  // ═══════════════════════════════════════════════════════════════

  async loadMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions');
      const data = await res.json();
      this.muxSessions = data.data?.sessions || [];
      this.renderMuxSessions();
    } catch (err) {
      console.error('Failed to load mux sessions:', err);
    }
  },

  killAllMuxSessions() {
    const count = this.muxSessions?.length || 0;
    if (count === 0) {
      alert('No sessions to kill');
      return;
    }

    // Show the kill all modal
    document.getElementById('killAllCount').textContent = count;
    const modal = document.getElementById('killAllModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  closeKillAllModal() {
    document.getElementById('killAllModal').classList.remove('active');

    // Deactivate focus trap and restore focus
    if (this.activeFocusTrap) {
      this.activeFocusTrap.deactivate();
      this.activeFocusTrap = null;
    }
  },

  async confirmKillAll(killMux) {
    this.closeKillAllModal();

    try {
      if (killMux) {
        // Kill everything including tmux sessions
        const res = await fetch('/api/sessions', { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
          this.sessions.clear();
          this.muxSessions = [];
          this.activeSessionId = null;
          try { localStorage.removeItem('codeman-active-session'); } catch {}
          this.renderSessionTabs();
          this.renderMuxSessions();
          this.terminal.clear();
          this.terminal.reset();
          this.toast('All sessions and tmux killed', 'success');
        }
      } else {
        // Just remove tabs, keep mux sessions running
        this.sessions.clear();
        this.activeSessionId = null;
        try { localStorage.removeItem('codeman-active-session'); } catch {}
        this.renderSessionTabs();
        this.terminal.clear();
        this.terminal.reset();
        this.toast('All tabs removed, tmux still running', 'info');
      }
    } catch (err) {
      console.error('Failed to kill sessions:', err);
      this.toast('Failed to kill sessions: ' + err.message, 'error');
    }
  },


  renderMuxSessions() {
    this._debouncedCall('muxSessions', this._renderMuxSessionsImmediate);
  },

  _renderMuxSessionsImmediate() {
    const body = document.getElementById('muxSessionsBody');

    if (!this.muxSessions || this.muxSessions.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No mux sessions</div>';
      return;
    }

    // COD-97: keep the Monitor list in sync with the real open tabs. A mux entry
    // whose sessionId is NOT in this.sessions (orphan / restored-* / already-closed
    // tab) must never be rendered as a normal, clickable tab row — render those
    // separately under a visually-distinct "not open" treatment so they can't be
    // silently mistaken for live sessions.
    const matched = [];
    const orphans = [];
    for (const muxSession of this.muxSessions) {
      if (this.sessions.has(muxSession.sessionId)) {
        matched.push(muxSession);
      } else {
        orphans.push(muxSession);
      }
    }

    // COD-122: render the secondary identifiers (tmux name + agent session id)
    // beneath the primary tab-name label. Each is labelled by kind and truncates
    // independently so the tab name above is never crowded out on narrow widths.
    const kindMeta = {
      tmux: { label: 'tmux', title: 'tmux session name' },
      agent: { label: 'agent', title: 'agent (Claude/Codex) session id' },
    };
    const rowIdsHtml = (secondaries) => {
      if (!secondaries || secondaries.length === 0) return '';
      const ids = secondaries
        .map((s) => {
          const meta = kindMeta[s.kind] || { label: s.kind, title: '' };
          return `<span class="monitor-id monitor-id-${s.kind}" title="${escapeHtml(meta.title)}: ${escapeHtml(s.label)}"><span class="monitor-id-kind">${escapeHtml(meta.label)}</span><span class="monitor-id-val">${escapeHtml(s.label)}</span></span>`;
        })
        .join('');
      return `<div class="monitor-row-ids">${ids}</div>`;
    };

    let html = '';
    for (const muxSession of matched) {
      const stats = muxSession.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };

      // Look up rich session data by sessionId
      const session = this.sessions.get(muxSession.sessionId);
      const status = session ? session.status : 'unknown';
      const isWorking = session ? session.isWorking : false;

      // Status badge
      let statusLabel, statusClass;
      if (status === 'idle' && !isWorking) {
        statusLabel = 'IDLE';
        statusClass = 'status-idle';
      } else if (status === 'busy' || isWorking) {
        statusLabel = 'WORKING';
        statusClass = 'status-working';
      } else if (status === 'stopped') {
        statusLabel = 'STOPPED';
        statusClass = 'status-stopped';
      } else {
        statusLabel = status.toUpperCase();
        statusClass = '';
      }

      // Token and cost info
      const tokens = session && session.tokens ? session.tokens : null;
      const totalCost = session ? session.totalCost : 0;
      const model = session ? (session.cliModel || '') : '';
      const modelShort = model.includes('opus') ? 'opus' : model.includes('sonnet') ? 'sonnet' : model.includes('haiku') ? 'haiku' : '';

      // Ralph/Todo progress
      const todoStats = session ? session.ralphTodoStats : null;
      let todoHtml = '';
      if (todoStats && todoStats.total > 0) {
        const pct = Math.round((todoStats.completed / todoStats.total) * 100);
        todoHtml = `<span class="process-stat todo-progress">${todoStats.completed}/${todoStats.total} (${pct}%)</span>`;
      }

      // Format tokens
      let tokenHtml = '';
      if (tokens && tokens.total > 0) {
        const totalK = (tokens.total / 1000).toFixed(1);
        tokenHtml = `<span class="process-stat tokens">${totalK}k tok</span>`;
      }

      // Format cost
      let costHtml = '';
      if (totalCost > 0) {
        costHtml = `<span class="process-stat cost">$${totalCost.toFixed(2)}</span>`;
      }

      // Model badge
      let modelHtml = '';
      if (modelShort) {
        modelHtml = `<span class="monitor-model-badge ${modelShort}">${modelShort}</span>`;
      }

      // COD-122: tab name is the primary/L1 label; tmux + agent ids are secondary.
      const labels = window.CodemanMonitorLabels.resolveMonitorRowLabels({
        tabName: session && session.name,
        storedName: muxSession.name,
        muxName: muxSession.muxName,
        agentSessionId: session && session.claudeSessionId,
        sessionId: muxSession.sessionId,
      });

      const sid = escapeHtml(JSON.stringify(muxSession.sessionId));
      html += `
        <div class="process-item process-item-clickable" onclick="app.selectSession(${sid})" title="Switch to session">
          <span class="monitor-status-badge ${statusClass}">${statusLabel}</span>
          <div class="process-info">
            <div class="process-name">${modelHtml} <span class="monitor-tab-name">${escapeHtml(labels.primary)}</span></div>
            ${rowIdsHtml(labels.secondaries)}
            <div class="process-meta">
              ${tokenHtml}
              ${costHtml}
              ${todoHtml}
              <span class="process-stat memory">${stats.memoryMB}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent}%</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="event.stopPropagation(); app.killMuxSession(${sid})" title="Kill session">Kill</button>
          </div>
        </div>
      `;
    }

    // COD-97: orphaned mux sessions (no matching open tab) — render distinct,
    // non-clickable rows so they're never confused for live tabs. These can be
    // killed (they're real tmux sessions) but selecting them would do nothing.
    for (const muxSession of orphans) {
      const stats = muxSession.stats || { memoryMB: 0, cpuPercent: 0, childCount: 0 };
      // COD-122: no matching UI session, so there's no tab name / agent id — the
      // persisted mux name (if any) leads, falling back to the tmux name.
      const labels = window.CodemanMonitorLabels.resolveMonitorRowLabels({
        storedName: muxSession.name,
        muxName: muxSession.muxName,
        sessionId: muxSession.sessionId,
      });
      const sid = escapeHtml(muxSession.sessionId);
      html += `
        <div class="process-item process-item-orphan" title="Not an open tab (orphaned tmux session)">
          <span class="monitor-status-badge status-orphan">NOT OPEN</span>
          <div class="process-info">
            <div class="process-name"><span class="monitor-tab-name">${escapeHtml(labels.primary)}</span></div>
            ${rowIdsHtml(labels.secondaries)}
            <div class="process-meta">
              <span class="process-stat memory">${stats.memoryMB || 0}MB</span>
              <span class="process-stat cpu">${stats.cpuPercent || 0}%</span>
            </div>
          </div>
          <div class="process-actions">
            <button class="btn-toolbar btn-sm btn-danger" onclick="app.killMuxSession('${sid}')" title="Kill orphaned session">Kill</button>
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  },

  renderMonitorSubagents() {
    const body = document.getElementById('monitorSubagentsBody');
    const stats = document.getElementById('monitorSubagentStats');
    if (!body) return;

    const subagents = Array.from(this.subagents.values());
    const activeCount = subagents.filter(s => s.status === 'active' || s.status === 'idle').length;

    if (stats) {
      stats.textContent = `${subagents.length} tracked` + (activeCount > 0 ? `, ${activeCount} active` : '');
    }

    if (subagents.length === 0) {
      body.innerHTML = '<div class="monitor-empty">No background agents</div>';
      return;
    }

    let html = '';
    for (const agent of subagents) {
      const statusClass = agent.status === 'active' ? 'active' : agent.status === 'idle' ? 'idle' : 'completed';
      const modelBadge = agent.modelShort ? `<span class="model-badge ${agent.modelShort}">${agent.modelShort}</span>` : '';
      const desc = agent.description ? escapeHtml(agent.description.substring(0, 40)) : agent.agentId;

      html += `
        <div class="process-item">
          <span class="process-mode ${statusClass}">${agent.status}</span>
          <div class="process-info">
            <div class="process-name">${modelBadge} ${desc}</div>
            <div class="process-meta">
              <span>ID: ${agent.agentId}</span>
              <span>${agent.toolCallCount || 0} tools</span>
            </div>
          </div>
          <div class="process-actions">
            ${agent.status !== 'completed' ? `<button class="btn-toolbar btn-sm btn-danger" onclick="app.killSubagent(${escapeHtml(JSON.stringify(agent.agentId))})" title="Kill agent">Kill</button>` : ''}
          </div>
        </div>
      `;
    }

    body.innerHTML = html;
  },

  async killMuxSession(sessionId) {
    if (!confirm('Kill this mux session?')) return;

    try {
      // Use closeSession to properly clean up both the session tab and tmux process
      // (closeSession handles its own toast messaging)
      await this.closeSession(sessionId, true);
    } catch (err) {
      // Fallback: kill mux directly if session cleanup fails
      try { await fetch(`/api/mux-sessions/${sessionId}`, { method: 'DELETE' }); } catch (_ignored) {}
      this.showToast('Tmux session killed', 'success');
    }
    this.muxSessions = this.muxSessions.filter(s => s.sessionId !== sessionId);
    this.renderMuxSessions();
  },

  async reconcileMuxSessions() {
    try {
      const res = await fetch('/api/mux-sessions/reconcile', { method: 'POST' });
      const data = await res.json();

      if (data.data?.dead && data.data.dead.length > 0) {
        this.showToast(`Found ${data.data.dead.length} dead mux session(s)`, 'warning');
        await this.loadMuxSessions();
      } else {
        this.showToast('All mux sessions are alive', 'success');
      }
    } catch (err) {
      this.showToast('Failed to reconcile mux sessions', 'error');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Toast
  // ═══════════════════════════════════════════════════════════════

  toggleNotifications() {
    this.notificationManager?.toggleDrawer();
  },

  // Open a Codeman window stretched across all displays (multi-monitor mode).
  // The server spawns scripts/span-codeman.sh, which launches a fresh, spanning
  // browser --app window so in-page floating panels can cross the monitor seam.
  async launchMultiMonitor() {
    try {
      const res = await fetch('/api/system/span-displays', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        this.showToast('Opening Codeman across all displays…', 'success');
      } else {
        this.showToast(data.error || 'Could not open spanning window', 'error');
      }
    } catch (err) {
      this.showToast('Could not open spanning window: ' + (err?.message || err), 'error');
    }
  },

  // Alias for showToast
  toast(message, type = 'info') {
    return this.showToast(message, type);
  },

  showToast(message, type = 'info', opts = {}) {
    const { duration = 3000, action } = opts;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (action) {
      const btn = document.createElement('button');
      btn.textContent = action.label;
      btn.style.cssText = 'margin-left:12px;padding:2px 10px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);border-radius:3px;color:inherit;cursor:pointer;font-size:12px';
      btn.onclick = (e) => { e.stopPropagation(); action.onClick(); toast.remove(); };
      toast.appendChild(btn);
    }

    // Cache toast container reference
    if (!this._toastContainer) {
      this._toastContainer = document.querySelector('.toast-container');
      if (!this._toastContainer) {
        this._toastContainer = document.createElement('div');
        this._toastContainer.className = 'toast-container';
        document.body.appendChild(this._toastContainer);
      }
    }
    // a11y: the container is a polite live region so toasts (e.g. document-upload
    // progress / failure) are announced to screen readers as they appear. Set
    // once, idempotently, whether the container was just created or adopted.
    if (this._toastContainer.getAttribute('aria-live') !== 'polite') {
      this._toastContainer.setAttribute('role', 'status');
      this._toastContainer.setAttribute('aria-live', 'polite');
      this._toastContainer.setAttribute('aria-atomic', 'false');
    }
    this._toastContainer.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 200);
    }, duration);
  },


  // ═══════════════════════════════════════════════════════════════
  // System Stats
  // ═══════════════════════════════════════════════════════════════

  startSystemStatsPolling() {
    // Clear any existing interval to prevent duplicates
    this.stopSystemStatsPolling();

    // Initial fetch
    this.fetchSystemStats();

    // Poll every 2 seconds
    this.systemStatsInterval = setInterval(() => {
      this.fetchSystemStats();
    }, 2000);
  },

  stopSystemStatsPolling() {
    if (this.systemStatsInterval) {
      clearInterval(this.systemStatsInterval);
      this.systemStatsInterval = null;
    }
  },

  async fetchSystemStats() {
    // Skip polling when system stats display is hidden
    const statsEl = document.getElementById('headerSystemStats');
    if (!statsEl || statsEl.style.display === 'none') return;

    try {
      const res = await fetch('/api/system/stats');
      const stats = await res.json();
      this.updateSystemStatsDisplay(stats.data);
    } catch (err) {
      // Silently fail - system stats are not critical
    }
  },

  updateSystemStatsDisplay(stats) {
    const cpuEl = this.$('statCpu');
    const cpuBar = this.$('statCpuBar');
    const memEl = this.$('statMem');
    const memBar = this.$('statMemBar');

    if (cpuEl && cpuBar) {
      cpuEl.textContent = `${stats.cpu}%`;
      cpuBar.style.width = `${Math.min(100, stats.cpu)}%`;

      // Color classes based on usage
      cpuBar.classList.remove('medium', 'high');
      cpuEl.classList.remove('high');
      if (stats.cpu > 80) {
        cpuBar.classList.add('high');
        cpuEl.classList.add('high');
      } else if (stats.cpu > 50) {
        cpuBar.classList.add('medium');
      }
    }

    if (memEl && memBar) {
      const memGB = (stats.memory.usedMB / 1024).toFixed(1);
      memEl.textContent = `${memGB}G`;
      memBar.style.width = `${Math.min(100, stats.memory.percent)}%`;

      // Color classes based on usage
      memBar.classList.remove('medium', 'high');
      memEl.classList.remove('high');
      if (stats.memory.percent > 80) {
        memBar.classList.add('high');
        memEl.classList.add('high');
      } else if (stats.memory.percent > 50) {
        memBar.classList.add('medium');
      }
    }
  },

  // ─── Clipboard ──────────────────────────────────────────────────────────────

  async _onClipboardWrite(data) {
    const text = data?.text;
    if (typeof text !== 'string') return;
    try {
      await navigator.clipboard.writeText(text);
      this.showToast(`Copied to clipboard (${text.length} chars)`, 'success');
    } catch {
      this._showClipboardFallback(text);
    }
  },

  _showClipboardFallback(text) {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:10000;display:flex;align-items:center;justify-content:center';

    const modal = document.createElement('div');
    modal.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:8px;padding:16px;max-width:600px;width:90%;max-height:60vh;display:flex;flex-direction:column;gap:12px';

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center';
    const title = document.createElement('span');
    title.style.cssText = 'color:#cdd6f4;font-weight:600';
    title.textContent = 'Clipboard (browser blocked auto-copy)';
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'background:none;border:none;color:#cdd6f4;font-size:18px;cursor:pointer';
    closeBtn.textContent = '\u00d7';
    header.appendChild(title);
    header.appendChild(closeBtn);

    const textarea = document.createElement('textarea');
    textarea.readOnly = true;
    textarea.style.cssText = 'background:#181825;color:#cdd6f4;border:1px solid #555;border-radius:4px;padding:8px;font-family:monospace;font-size:13px;resize:none;height:200px;width:100%';
    textarea.value = text;

    const copyBtn = document.createElement('button');
    copyBtn.style.cssText = 'background:#89b4fa;color:#1e1e2e;border:none;border-radius:4px;padding:8px 16px;cursor:pointer;font-weight:600';
    copyBtn.textContent = 'Copy to Clipboard';

    modal.appendChild(header);
    modal.appendChild(textarea);
    modal.appendChild(copyBtn);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        this.showToast('Copied to clipboard', 'success');
        overlay.remove();
      } catch {
        textarea.select();
        document.execCommand('copy');
        this.showToast('Copied (fallback)', 'success');
        overlay.remove();
      }
    };

    const close = () => overlay.remove();
    closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };
  },
});
