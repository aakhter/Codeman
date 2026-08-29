/**
 * @fileoverview Web tabs: saved dashboard URLs rendered as tabs beside agent
 * sessions, so Codeman is one mission control instead of Codeman plus a pile of
 * browser tabs.
 *
 * Each open dashboard is an <iframe> inside #webviewLayer, which covers the
 * terminal while a web tab is active. Frames stay MOUNTED while hidden, because a
 * dashboard that reloads and re-authenticates on every tab switch is worse than
 * the browser tab it replaced. `maxLiveFrames` (from the server) bounds that with
 * least-recently-viewed eviction.
 *
 * Sandboxing: a proxied dashboard is served from Codeman's own origin, so the
 * iframe deliberately omits `allow-same-origin` unless the dashboard is marked
 * trusted. Without that omission the page could read this document and call the
 * API that spawns agents.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js, api-client.js, constants.js (escapeHtml)
 * @loadorder 12.5 of 16, after session-ui.js (needs the tab strip), before api-client.js
 */

Object.assign(CodemanApp.prototype, {
  // ── State ─────────────────────────────────────────────────────────────────

  /** Load the saved list and restore which tabs were open. */
  async initWebviews() {
    this.webviews = this.webviews || new Map();
    this.webviewOrder = this.webviewOrder || [];
    this.activeWebviewId = this.activeWebviewId || null;
    this._webviewMaxFrames = this._webviewMaxFrames || 6;
    this._webviewFrameLru = this._webviewFrameLru || [];
    this._webviewNavigationGeneration = this._webviewNavigationGeneration || 0;
    this._webviewNavigationId = this._webviewNavigationId || null;
    this._webviewOpenGenerations = this._webviewOpenGenerations || new Map();
    this._webviewOpenStateLoaded = this._webviewOpenStateLoaded === true;
    this._webviewInitRetryTimer = this._webviewInitRetryTimer || null;
    this._webviewInitRetryScheduled = this._webviewInitRetryScheduled === true;
    this._webviewListRefreshGeneration = this._webviewListRefreshGeneration || 0;
    this._webviewListAppliedGeneration = this._webviewListAppliedGeneration || 0;
    this._webviewDeletedIds = this._webviewDeletedIds || new Set();

    const acquired = await this.refreshWebviews();
    if (!acquired) this._scheduleWebviewInitRetry();
  },

  /** One bounded recovery read for a transient failure during the sole shipping init call. */
  _scheduleWebviewInitRetry() {
    if (this._webviewOpenStateLoaded || this._webviewInitRetryScheduled || this._webviewInitRetryTimer !== null) return;
    this._webviewInitRetryScheduled = true;
    this._webviewInitRetryTimer = setTimeout(async () => {
      this._webviewInitRetryTimer = null;
      await this.refreshWebviews();
    }, 2000);
    if (!this._webviewInitPagehideHandler) {
      this._webviewInitPagehideHandler = (event) => {
        if (event.persisted) return;
        this._clearWebviewInitRetry();
      };
      window.addEventListener('pagehide', this._webviewInitPagehideHandler);
    }
  },

  _clearWebviewInitRetry() {
    if (this._webviewInitRetryTimer !== null) clearTimeout(this._webviewInitRetryTimer);
    this._webviewInitRetryTimer = null;
    if (this._webviewInitPagehideHandler) {
      window.removeEventListener('pagehide', this._webviewInitPagehideHandler);
      this._webviewInitPagehideHandler = null;
    }
  },

  async refreshWebviews() {
    const generation = (this._webviewListRefreshGeneration || 0) + 1;
    this._webviewListRefreshGeneration = generation;
    let data;
    try {
      data = await this._apiJson('/api/webviews');
    } catch {
      return false;
    }
    if (!data || !Array.isArray(data.webviews)) return false;
    // Order successful applications, not request starts: a valid earlier response
    // may recover state while a newer overlapping request is still pending or
    // fails. A newer success still wins, and deletion tombstones filter even a
    // response whose request began before the trusted deletion event.
    if (generation < (this._webviewListAppliedGeneration || 0)) return false;
    this._webviewListAppliedGeneration = generation;
    const deletedIds = this._webviewDeletedIds || new Set();
    this.webviews = new Map(data.webviews.filter((w) => !deletedIds.has(w.id)).map((w) => [w.id, w]));
    if (typeof data.maxLiveFrames === 'number') this._webviewMaxFrames = data.maxLiveFrames;
    this.renderWebviewMenuItems();
    if (!this._webviewOpenStateLoaded) {
      // Restore the device-local OPEN SET only after the authoritative saved list
      // exists. Any later successful retry or SSE refresh may be the first success.
      this._loadWebviewOpenState();
      this._webviewOpenStateLoaded = true;
      this._clearWebviewInitRetry();
      this.renderSessionTabs();
    }
    return true;
  },

  /** SSE: the saved list changed (possibly on another device). */
  async _onWebviewChanged(data) {
    const deletedId = data?.action === 'deleted' && data.id ? data.id : null;
    if (deletedId) {
      this._webviewDeletedIds = this._webviewDeletedIds || new Set();
      this._webviewDeletedIds.add(deletedId);
    }
    const deletionSnapshot = deletedId
      ? (this._refreshTabProjection?.()?.completeRefs || []).map((ref) => ({ kind: ref.kind, id: ref.id }))
      : null;
    const deletionNavigation = deletedId
      ? { generation: this._webviewNavigationGeneration || 0, id: this._webviewNavigationId || null }
      : null;
    const acquired = await this.refreshWebviews();
    if (deletedId) {
      // Owner-routed deletion is authoritative even if the follow-up list read
      // fails. Remove every local identity and use the pre-refresh ordering for
      // active fallback because a successful read already omits this ref.
      this.webviews?.delete(deletedId);
      this.renderWebviewMenuItems();
      const allowFallback =
        (this._webviewNavigationGeneration || 0) === deletionNavigation.generation &&
        (this._webviewNavigationId || null) === deletionNavigation.id;
      this._removeWebviewTab(deletedId, deletionSnapshot, allowFallback);
    } else if (!acquired) {
      return;
    }
    this.renderSessionTabs();
  },

  _normalizeWebviewOpenIds(value) {
    if (!Array.isArray(value)) return [];
    const requested = new Set(value.filter((id) => typeof id === 'string'));
    // Canonicalize membership against the authoritative saved-list snapshot so
    // neither legacy order nor close/open chronology survives as index authority.
    return [...(this.webviews?.keys() || [])].filter((id) => requested.has(id));
  },

  /** Migrate legacy local ordering once, retaining only set membership. */
  _loadWebviewOpenState() {
    const current = this._normalizeWebviewOpenIds(this.webviewOrder);
    let storage;
    let stored;
    try {
      storage = localStorage;
      stored = storage.getItem('codeman-webview-open');
    } catch {
      this.webviewOrder = current;
      return;
    }

    if (stored !== null) {
      let parsed;
      try {
        parsed = JSON.parse(stored);
      } catch {
        parsed = [];
      }
      this.webviewOrder = this._normalizeWebviewOpenIds(parsed);
      const normalized = JSON.stringify(this.webviewOrder);
      if (stored !== normalized) {
        try {
          storage.setItem('codeman-webview-open', normalized);
        } catch {
          /* normalized openness remains usable in memory */
        }
      }
      return;
    }

    let legacy;
    try {
      legacy = JSON.parse(storage.getItem('codeman-webview-order') || '[]');
    } catch {
      legacy = [];
    }
    this.webviewOrder = this._normalizeWebviewOpenIds(legacy);
    try {
      // Even [] is a migration marker: a stale legacy value must never be
      // reimported after the user has closed every dashboard.
      storage.setItem('codeman-webview-open', JSON.stringify(this.webviewOrder));
    } catch {
      /* migrated openness remains usable in memory */
    }
  },

  _persistWebviewOpenState() {
    this.webviewOrder = this._normalizeWebviewOpenIds(this.webviewOrder);
    try {
      localStorage.setItem('codeman-webview-open', JSON.stringify(this.webviewOrder));
    } catch {
      /* private mode / quota: openness remains usable in memory */
    }
  },

  /** Compatibility name; the value is set-like openness, never tab order. */
  _persistWebviewOrder() {
    this._persistWebviewOpenState();
  },

  // ── Tab strip ─────────────────────────────────────────────────────────────

  /** Legacy flat renderer retained for callers outside the unified rail. */
  renderWebviewTabs(startIndex) {
    if (!this.webviewOrder || this.webviewOrder.length === 0) return '';
    const parts = [];
    let idx = startIndex;

    for (const id of this.webviewOrder) {
      const html = this.renderWebviewTab(id, idx);
      if (html) parts.push(html);
      if (html) idx++;
    }
    return parts.join('');
  },

  /** One open webview tab at its position in the interleaved visible ref list. */
  renderWebviewTab(id, index) {
    const webview = this.webviews?.get(id);
    if (!webview) return '';
    const isActive = id === this.activeWebviewId;
    const jsonId = escapeHtml(JSON.stringify(id));
    const icon = webview.icon ? escapeHtml(webview.icon) : '';
    const focusMarker = this._tabRefFocused?.({ kind: 'webview', id })
      ? '<span class="tab-focus-marker" title="In Focus" aria-label="In Focus">&#x2605;</span>'
      : '';
    return `<div class="session-tab session-tab--web ${isActive ? 'active' : ''}" data-webview-id="${escapeHtml(id)}"
        onclick="app.handleWebviewTabClick(event, ${jsonId})"
        tabindex="0" role="tab" aria-selected="${isActive ? 'true' : 'false'}"
        aria-label="${escapeHtml(webview.name)} web tab" title="${escapeHtml(webview.url)}">
        <button type="button" class="tab-ref-drag-handle" data-tab-ref-drag tabindex="-1" onclick="event.preventDefault(); event.stopPropagation()" title="Drag to reorder" aria-label="Move ${escapeHtml(webview.name)} web tab"></button>
        ${index < 9 ? '<span class="tab-number">' + (index + 1) + '</span>' : ''}
        <span class="tab-web-icon" aria-hidden="true">${icon || this._webviewGlobeIcon()}</span>
        <span class="tab-info">
          <span class="tab-name-row">
            <span class="tab-name">${escapeHtml(webview.name)}</span>
          </span>
        </span>
        ${focusMarker}
        <span class="tab-actions"><span class="tab-gear" onclick="event.stopPropagation(); app.showWebviewModal(${jsonId})" title="URL settings" aria-label="URL settings" tabindex="0">&#x2699;</span><span class="tab-close" onclick="event.stopPropagation(); app.closeWebviewTab(${jsonId})" title="Close tab" aria-label="Close web tab" tabindex="0">&times;</span><button type="button" class="tab-more" onclick="event.stopPropagation(); app.openTabRefMoveMenu(event, { kind: 'webview', id: ${jsonId} })" title="Move web tab" aria-label="Move web tab">&#x22EF;</button></span>
      </div>`;
  },

  _webviewGlobeIcon() {
    return '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/></svg>';
  },

  handleWebviewTabClick(event, id) {
    event?.preventDefault?.();
    return this.openWebview(id);
  },

  /** Mark exactly one tab active across BOTH tab kinds. */
  _updateActiveWebviewTab() {
    const container = this.$('sessionTabs');
    if (!container) return;
    for (const tab of container.querySelectorAll('.session-tab[data-webview-id]')) {
      const active = tab.dataset.webviewId === this.activeWebviewId;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (this.activeWebviewId) {
      // A web tab is active, so no session tab may also look active.
      for (const tab of container.querySelectorAll('.session-tab[data-id]')) {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
      }
    }
    for (const tab of container.querySelectorAll('.session-tab[data-focus-webview-id]')) {
      tab.classList.remove('active');
      tab.removeAttribute('aria-selected');
      tab.setAttribute('aria-current', tab.dataset.focusWebviewId === this.activeWebviewId ? 'page' : 'false');
    }
    for (const tab of container.querySelectorAll('.session-tab[data-focus-session-id]')) {
      tab.classList.remove('active');
      tab.removeAttribute('aria-selected');
      tab.setAttribute('aria-current', 'false');
    }
  },

  // ── Opening / closing ─────────────────────────────────────────────────────

  _beginWebviewOpenIntent(id) {
    this._webviewNavigationGeneration = (this._webviewNavigationGeneration || 0) + 1;
    this._webviewNavigationId = id;
    this._webviewOpenGenerations = this._webviewOpenGenerations || new Map();
    const idGeneration = (this._webviewOpenGenerations.get(id) || 0) + 1;
    this._webviewOpenGenerations.set(id, idGeneration);
    return { navigationGeneration: this._webviewNavigationGeneration, idGeneration };
  },

  _cancelPendingWebviewNavigation() {
    this._webviewNavigationGeneration = (this._webviewNavigationGeneration || 0) + 1;
    this._webviewNavigationId = null;
  },

  _cancelPendingWebviewOpen(id) {
    this._webviewOpenGenerations = this._webviewOpenGenerations || new Map();
    this._webviewOpenGenerations.set(id, (this._webviewOpenGenerations.get(id) || 0) + 1);
    if (this._webviewNavigationId === id) this._cancelPendingWebviewNavigation();
  },

  /**
   * Open (or focus) a dashboard tab. Mints a fresh capability every time: they are
   * memory-only and expire, so a tab reopened after a server restart must not reuse
   * the dead URL from the previous run.
   */
  async openWebview(id) {
    const webview = this.webviews.get(id);
    if (!webview) return;
    const intent = this._beginWebviewOpenIntent(id);

    const data = await this._apiJson(`/api/webviews/${encodeURIComponent(id)}/open`, { method: 'POST' });
    if (!data) {
      if (
        this._webviewOpenGenerations.get(id) === intent.idGeneration &&
        this._webviewNavigationGeneration === intent.navigationGeneration
      ) {
        this._webviewNavigationId = null;
        this.showToast?.('Could not open URL', 'error');
      }
      return;
    }
    if (this._webviewOpenGenerations.get(id) !== intent.idGeneration) return;
    if (data.webview) this.webviews.set(id, data.webview);
    if (!this.webviewOrder.includes(id)) {
      this.webviewOrder.push(id);
      this._persistWebviewOrder();
    }
    if (this._webviewNavigationGeneration !== intent.navigationGeneration) {
      this.renderSessionTabs();
      return;
    }
    this._webviewNavigationId = null;

    const src = data.embedUrl || data.webview?.url || webview.url;
    this._mountWebviewFrame(id, src, data.webview || webview);
    this.activeWebviewId = id;
    this.hideWelcome?.();
    document.querySelector('.main')?.classList.add('webview-active');
    this.renderSessionTabs();
    this._updateActiveWebviewTab();
    // Web tabs live in the same list as sessions, so picking one from the
    // handheld session drawer has to dismiss it too (no-op elsewhere).
    this.closeSessionSidebarOnHandheld?.();
  },

  /** Create the frame if absent, then reveal it and hide its siblings. */
  _mountWebviewFrame(id, src, webview) {
    const layer = document.getElementById('webviewLayer');
    if (!layer) return;

    let wrap = layer.querySelector(`.webview-frame[data-webview-id="${CSS.escape(id)}"]`);
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'webview-frame';
      wrap.dataset.webviewId = id;

      const frame = document.createElement('iframe');
      frame.className = 'webview-iframe';
      frame.setAttribute('title', webview.name);
      // No allow-same-origin unless explicitly trusted: a proxied page is served
      // from THIS origin, so granting it would let the dashboard read this document
      // and drive the Codeman API.
      const sandbox = ['allow-scripts', 'allow-forms', 'allow-popups', 'allow-downloads', 'allow-modals'];
      if (webview.trusted) sandbox.push('allow-same-origin');
      frame.setAttribute('sandbox', sandbox.join(' '));
      frame.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
      frame.src = src;

      const failure = document.createElement('div');
      failure.className = 'webview-failure';
      failure.innerHTML = this._webviewFailureHtml(id);

      wrap.appendChild(frame);
      wrap.appendChild(failure);
      layer.appendChild(wrap);

      // A frame that never fires `load` is the normal symptom of a refused embed or
      // an unreachable host. Show an actionable panel instead of a blank rectangle.
      const timer = setTimeout(() => wrap.classList.add('webview-frame--failed'), 8000);
      frame.addEventListener('load', () => {
        clearTimeout(timer);
        wrap.classList.remove('webview-frame--failed');
      });
    }

    this._touchWebviewFrame(id);
    for (const other of layer.querySelectorAll('.webview-frame')) {
      other.classList.toggle('active', other.dataset.webviewId === id);
    }
    // Chart libraries measure on resize; a frame revealed from display:none needs the nudge.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  },

  _webviewFailureHtml(id) {
    const jsonId = escapeHtml(JSON.stringify(id));
    return `<div class="webview-failure-inner">
        <h3>This URL did not load</h3>
        <p>It may be unreachable from the Codeman server, or it may refuse to be embedded.</p>
        <div class="webview-failure-actions">
          <button class="btn-secondary" onclick="app.reloadWebview(${jsonId})">Reload</button>
          <button class="btn-secondary" onclick="app.openWebviewExternal(${jsonId})">Open in new tab</button>
          <button class="btn-secondary" onclick="app.showWebviewModal(${jsonId})">Edit</button>
        </div>
      </div>`;
  },

  /** Least-recently-viewed eviction so N open dashboards cannot pin N live pages. */
  _touchWebviewFrame(id) {
    this._webviewFrameLru = (this._webviewFrameLru || []).filter((x) => x !== id);
    this._webviewFrameLru.push(id);
    const layer = document.getElementById('webviewLayer');
    if (!layer) return;
    while (this._webviewFrameLru.length > this._webviewMaxFrames) {
      const evict = this._webviewFrameLru.shift();
      if (evict === this.activeWebviewId) continue;
      layer.querySelector(`.webview-frame[data-webview-id="${CSS.escape(evict)}"]`)?.remove();
    }
  },

  reloadWebview(id) {
    const target = id || this.activeWebviewId;
    if (!target) return;
    document
      .getElementById('webviewLayer')
      ?.querySelector(`.webview-frame[data-webview-id="${CSS.escape(target)}"]`)
      ?.remove();
    this._webviewFrameLru = (this._webviewFrameLru || []).filter((x) => x !== target);
    return this.openWebview(target);
  },

  openWebviewExternal(id) {
    const webview = this.webviews.get(id || this.activeWebviewId);
    if (webview) window.open(webview.url, '_blank', 'noopener');
  },

  closeWebviewTab(id) {
    this._removeWebviewTab(id);
    this.renderSessionTabs();
  },

  _removeWebviewTab(id, completeSnapshot, allowFallback = true) {
    const before = completeSnapshot === undefined ? this._refreshTabProjection?.()?.completeRefs : completeSnapshot;
    const completeBefore = Array.isArray(before) ? before : [];
    this._cancelPendingWebviewOpen(id);
    this.webviewOrder = (this.webviewOrder || []).filter((x) => x !== id);
    this._webviewFrameLru = (this._webviewFrameLru || []).filter((x) => x !== id);
    this._persistWebviewOrder();
    document
      .getElementById('webviewLayer')
      ?.querySelector(`.webview-frame[data-webview-id="${CSS.escape(id)}"]`)
      ?.remove();

    if (this.activeWebviewId === id) {
      this.activeWebviewId = null;
      this._hideWebviewLayer();
      if (!allowFallback) return;
      const targetIndex = completeBefore.findIndex((ref) => ref.kind === 'webview' && ref.id === id);
      const isRenderable = (ref) =>
        ref.kind === 'session'
          ? this.sessions?.has(ref.id)
          : this.webviewOrder.includes(ref.id) && this.webviews?.has(ref.id);
      const next =
        completeBefore.slice(targetIndex + 1).find(isRenderable) ||
        completeBefore.slice(0, Math.max(0, targetIndex)).reverse().find(isRenderable);
      if (next?.kind === 'session') this.selectSession?.(next.id);
      else if (next?.kind === 'webview') this.openWebview(next.id);
      else if (this.activeSessionId) this._updateActiveTabImmediate(this.activeSessionId);
      else this.showWelcome?.();
    }
  },

  /** Called by selectSession(): a session tab takes the stage back from a web tab. */
  _hideWebviewLayer() {
    if (!this.activeWebviewId && !document.querySelector('.main.webview-active')) return;
    this.activeWebviewId = null;
    document.querySelector('.main')?.classList.remove('webview-active');
    for (const frame of document.querySelectorAll('#webviewLayer .webview-frame')) {
      frame.classList.remove('active');
    }
    this._updateActiveWebviewTab();
  },

  // ── Run-menu entries ──────────────────────────────────────────────────────

  /**
   * Saved dashboards listed inside the Run dropdown, under "Web / URL".
   *
   * Each row carries its own edit and delete buttons. Without them the only way to
   * change or remove a saved URL was to open it as a tab first and go through the
   * tab's gear, which is a dead end for a URL you no longer want open at all.
   */
  renderWebviewMenuItems() {
    const container = document.getElementById('runModeWebviews');
    if (!container) return;
    // Managed records are maintained by their own menu entry (the DeepSeek web
    // UI shortcut), so listing them here showed one dashboard twice: the
    // shortcut that starts it, and the row it wrote on the previous click.
    const list = [...(this.webviews?.values() || [])].filter((w) => !w.managed);
    if (list.length === 0) {
      container.innerHTML = '<div class="run-mode-empty">No URLs yet</div>';
      return;
    }
    container.innerHTML = list
      .map((w) => {
        const jsonId = escapeHtml(JSON.stringify(w.id));
        const name = escapeHtml(w.name);
        const icon = w.icon ? escapeHtml(w.icon) : '<span class="run-mode-dot web"></span>';
        return `<div class="run-mode-row run-mode-row--web">
          <button class="run-mode-option run-mode-option--web" onclick="app.openWebviewFromMenu(${jsonId})" title="${escapeHtml(w.url)}">
            <span class="run-mode-menu-icon">${icon}</span><span class="run-mode-web-name">${name}</span>
          </button>
          <button class="run-mode-row-btn run-mode-webview-edit" onclick="event.stopPropagation(); app.showWebviewModal(${jsonId})"
            title="Edit URL" aria-label="Edit ${name}">&#x2699;</button>
          <button class="run-mode-row-btn run-mode-webview-delete" onclick="event.stopPropagation(); app.deleteWebviewById(${jsonId})"
            title="Delete URL" aria-label="Delete ${name}">&times;</button>
        </div>`;
      })
      .join('');
  },

  openWebviewFromMenu(id) {
    document.getElementById('runModeMenu')?.classList.remove('active');
    return this.openWebview(id);
  },

  // ── Icon picker ───────────────────────────────────────────────────────────

  /** Common dashboard/service glyphs. The text field stays open for anything else. */
  _webviewIconChoices() {
    return ['📊', '📈', '🖥️', '🎛️', '📡', '🐳', '🗄️', '🔒', '🌐', '📁', '🧪', '🧬', '⚡', '🔔', '📝', '🎧'];
  },

  _renderWebviewIconPicker(selected) {
    const picker = document.getElementById('webviewIconPicker');
    if (!picker) return;
    picker.innerHTML = this._webviewIconChoices()
      .map(
        (icon) =>
          `<button type="button" class="webview-icon-choice${icon === selected ? ' selected' : ''}"
             onclick="app.pickWebviewIcon(${escapeHtml(JSON.stringify(icon))})"
             aria-label="Use ${escapeHtml(icon)} as the icon">${escapeHtml(icon)}</button>`
      )
      .join('');
  },

  /** Clicking the selected icon again clears it, so there is a way back to no icon. */
  pickWebviewIcon(icon) {
    const field = document.getElementById('webviewIcon');
    if (!field) return;
    field.value = field.value === icon ? '' : icon;
    this._renderWebviewIconPicker(field.value);
  },

  // ── Editor modal ──────────────────────────────────────────────────────────

  showWebviewModal(id) {
    const modal = document.getElementById('webviewModal');
    if (!modal) return;
    const webview = id ? this.webviews.get(id) : null;
    this._editingWebviewId = webview ? webview.id : null;

    document.getElementById('webviewModalTitle').textContent = webview ? 'Edit URL' : 'Add URL';
    this._renderWebviewIconPicker(webview?.icon || '');
    document.getElementById('webviewName').value = webview?.name || '';
    document.getElementById('webviewUrl').value = webview?.url || '';
    document.getElementById('webviewIcon').value = webview?.icon || '';
    document.getElementById('webviewSandboxed').checked = !webview?.trusted;
    document.getElementById('webviewProbeResult').textContent = '';
    document.getElementById('webviewDeleteBtn').style.display = webview ? '' : 'none';

    document.getElementById('runModeMenu')?.classList.remove('active');
    modal.classList.add('active');
    document.getElementById('webviewName').focus();
  },

  closeWebviewModal() {
    document.getElementById('webviewModal')?.classList.remove('active');
    this._editingWebviewId = null;
  },

  /** Server-side probe: it runs from the network position the proxy will use. */
  async testWebviewUrl() {
    const url = document.getElementById('webviewUrl').value.trim();
    const out = document.getElementById('webviewProbeResult');
    if (!url) {
      out.textContent = 'Enter a URL first.';
      return;
    }
    out.textContent = 'Testing...';
    const probe = await this._apiJson('/api/webviews/probe', { method: 'POST', body: { url } });
    if (!probe) {
      out.textContent = 'Test failed (invalid URL?).';
      return;
    }
    // #238: the probe runs server-to-upstream; say so, or a passing Test reads as
    // "the embedded page will work" when the browser sandbox / a cookie-auth
    // reverse proxy in front of Codeman can still break it.
    out.textContent = probe.reachable
      ? `Reachable (HTTP ${probe.status}) from the Codeman server. ${probe.reason} ` +
        `(Tests server-to-upstream reachability only, not how the page behaves in a sandboxed frame.)`
      : `Not reachable from the Codeman server. ${probe.reason}`;
    out.className = 'form-hint webview-probe-result ' + (probe.reachable ? 'ok' : 'bad');
  },

  async saveWebview() {
    const name = document.getElementById('webviewName').value.trim();
    const url = document.getElementById('webviewUrl').value.trim();
    const icon = document.getElementById('webviewIcon').value.trim();
    const trusted = !document.getElementById('webviewSandboxed').checked;
    if (!name || !url) {
      this.showToast?.('Name and URL are required', 'error');
      return;
    }

    // `icon: undefined` rather than null, the schema uses .optional(), which
    // rejects an explicit null on the wire.
    const body = { name, url, icon: icon || undefined, trusted };
    const editing = this._editingWebviewId;
    const data = editing
      ? await this._apiJson(`/api/webviews/${encodeURIComponent(editing)}`, { method: 'PATCH', body })
      : await this._apiJson('/api/webviews', { method: 'POST', body });

    if (!data) {
      this.showToast?.('Could not save (check the URL)', 'error');
      return;
    }

    await this.refreshWebviews();
    this.closeWebviewModal();
    if (editing) {
      // The capability was revoked server-side by the edit, so a mounted frame is
      // now pointing at a dead URL. Remount it.
      if (this.webviewOrder.includes(editing)) this.reloadWebview(editing);
    } else {
      this.openWebview(data.id);
    }
  },

  async deleteWebview() {
    const id = this._editingWebviewId;
    if (!id) return;
    if (await this._confirmAndDeleteWebview(id)) this.closeWebviewModal();
  },

  /**
   * Delete straight from a Run-dropdown row, without opening the editor first.
   *
   * The dropdown's outside-click handler closes the menu when the click target is
   * not inside it, and by the time the delete resolves this row is gone, so the
   * menu is re-asserted open: deleting one of several saved URLs should leave you
   * looking at the rest of the list.
   */
  async deleteWebviewById(id) {
    if (!id) return;
    if (!(await this._confirmAndDeleteWebview(id))) return;
    document.getElementById('runModeMenu')?.classList.add('active');
  },

  /** Shared by the row button and the editor modal. @returns true when deleted. */
  async _confirmAndDeleteWebview(id) {
    const webview = this.webviews.get(id);
    if (!confirm(`Delete "${webview?.name || id}"?`)) return false;
    const res = await this._apiDelete(`/api/webviews/${encodeURIComponent(id)}`);
    if (!res || !res.ok) {
      this.showToast?.('Could not delete URL', 'error');
      return false;
    }
    this._webviewDeletedIds = this._webviewDeletedIds || new Set();
    this._webviewDeletedIds.add(id);
    this._removeWebviewTab(id);
    this.webviews.delete(id);
    this.renderWebviewMenuItems();
    this.renderSessionTabs();
    return true;
  },
});
