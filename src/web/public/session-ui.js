/**
 * @fileoverview Quick start (case loading, session spawning for Claude/Shell/OpenCode/Codex/Gemini),
 * session options modal (per-session settings, color picker, rename),
 * session options tabs (Ralph config tab), case settings (CRUD, links),
 * create case modal, and mobile case picker.
 *
 * @mixin Extends CodemanApp.prototype via Object.assign
 * @dependency app.js (CodemanApp class, this.sessions, this.cases, this.activeSessionId)
 * @dependency constants.js (escapeHtml)
 * @dependency mobile-handlers.js (MobileDetection)
 * @loadorder 12 of 15 — loaded after panels-ui.js, before ralph-wizard.js
 */

Object.assign(CodemanApp.prototype, {
  /**
   * Build envOverrides payload from case + global settings.
   * Single source of truth for the server-side tmux setenv values.
   * Keys omitted when value is default/falsy — backend treats unset as "no override".
   */
  buildEnvOverrides(caseSettings, globalSettings) {
    const env = {};
    if (caseSettings?.agentTeams || globalSettings?.agentTeamsEnabled) {
      env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';
    }
    // NOTE: thinkingEffort is intentionally NOT emitted as CLAUDE_CODE_EFFORT_LEVEL —
    // the env var hard-locks effort and blocks in-session /effort switching (e.g.,
    // ultracode). It flows as the dedicated `effort` payload field instead, which the
    // backend injects as a `--settings` soft default. See getEffortSetting().
    return env;
  },

  /**
   * Resolve the effort level for new sessions from global settings.
   * Returns a valid effort string or undefined (= no override, CLI default).
   * Sent as the `effort` payload field — backend turns it into `claude --settings ...`.
   */
  getEffortSetting(globalSettings) {
    const effort = globalSettings?.thinkingEffort;
    const valid = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
    return valid.includes(effort) ? effort : undefined;
  },

  // ═══════════════════════════════════════════════════════════════
  // Quick Start
  // ═══════════════════════════════════════════════════════════════

  async loadQuickStartCases(selectCaseName = null, settingsPromise = null) {
    try {
      // Load settings to get lastUsedCase (reuse shared promise if provided)
      let lastUsedCase = null;
      try {
        const settings = settingsPromise ? await settingsPromise : await fetch('/api/settings').then(r => r.ok ? r.json() : null).then(env => env?.data ?? null);
        if (settings) {
          lastUsedCase = settings.lastUsedCase || null;
        }
      } catch {
        // Ignore settings load errors
      }

      const res = await fetch('/api/cases');
      const cases = (await res.json()).data;
      this.cases = cases;
      console.log('[loadQuickStartCases] Loaded cases:', cases.map(c => c.name), 'lastUsedCase:', lastUsedCase);

      const select = document.getElementById('quickStartCase');
      select?.blur?.();

      // Build options - existing cases first, then testcase as fallback if not present
      let options = '';
      const hasTestcase = cases.some(c => c.name === 'testcase');
      const isMobile = MobileDetection.getDeviceType() === 'mobile';
      const maxNameLength = isMobile ? 8 : 20; // Truncate to 8 chars on mobile

      cases.forEach(c => {
        const baseLabel = c.location === 'remote' && c.remote
          ? `${c.name} @ ${c.remote.hostId}`
          : c.name;
        const displayName = baseLabel.length > maxNameLength
          ? baseLabel.substring(0, maxNameLength) + '…'
          : baseLabel;
        options += `<option value="${escapeHtml(c.name)}">${escapeHtml(displayName)}</option>`;
      });

      // Add testcase option if it doesn't exist (will be created on first run)
      if (!hasTestcase) {
        options = `<option value="testcase">testcase</option>` + options;
      }

      select.innerHTML = options;
      console.log('[loadQuickStartCases] Set options:', select.innerHTML.substring(0, 200));

      // If a specific case was requested, select it
      if (selectCaseName) {
        select.value = selectCaseName;
        this.updateDirDisplayForCase(selectCaseName);
        this.updateMobileCaseLabel(selectCaseName);
      } else if (lastUsedCase && cases.some(c => c.name === lastUsedCase)) {
        // Use lastUsedCase if available and exists
        select.value = lastUsedCase;
        this.updateDirDisplayForCase(lastUsedCase);
        this.updateMobileCaseLabel(lastUsedCase);
      } else if (cases.length > 0) {
        // Fallback to testcase or first case
        const firstCase = cases.find(c => c.name === 'testcase') || cases[0];
        select.value = firstCase.name;
        this.updateDirDisplayForCase(firstCase.name);
        this.updateMobileCaseLabel(firstCase.name);
      } else {
        // No cases exist yet - show the default case name as directory
        select.value = 'testcase';
        document.getElementById('dirDisplay').textContent = '~/codeman-cases/testcase';
        this.updateMobileCaseLabel('testcase');
      }

      // Only add event listener once (on first load)
      if (!select.dataset.listenerAdded) {
        select.addEventListener('change', () => {
          this.updateDirDisplayForCase(select.value);
          this.saveLastUsedCase(select.value);
          this.updateMobileCaseLabel(select.value);
        });
        select.dataset.listenerAdded = 'true';
      }
    } catch (err) {
      console.error('Failed to load cases:', err);
    }
  },

  async updateDirDisplayForCase(caseName) {
    try {
      const matchingCase = (this.cases || []).find(c => c.name === caseName);
      if (matchingCase?.path) {
        document.getElementById('dirDisplay').textContent = matchingCase.path;
        document.getElementById('dirInput').value = matchingCase.path;
        return;
      }
      const res = await fetch(`/api/cases/${caseName}`);
      const data = (await res.json()).data;
      if (data.path) {
        document.getElementById('dirDisplay').textContent = data.path;
        document.getElementById('dirInput').value = data.path;
      }
    } catch (err) {
      document.getElementById('dirDisplay').textContent = caseName;
    }
  },

  async saveLastUsedCase(caseName) {
    try {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lastUsedCase: caseName })
      });
    } catch (err) {
      console.error('Failed to save last used case:', err);
    }
  },

  async quickStart() {
    return this.run();
  },

  /** Run using the selected mode (Claude Code, OpenCode, Codex, or Gemini) */
  async run() {
    const mode = this._runMode || 'claude';
    if (mode === 'opencode') {
      return this.runOpenCode();
    }
    if (mode === 'codex') {
      return this.runCodex();
    }
    if (mode === 'gemini') {
      return this.runGemini();
    }
    return this.runClaude();
  },

  /** Get/set the run mode, persisted in localStorage */
  get runMode() { return this._runMode || 'claude'; },

  setRunMode(mode) {
    this._runMode = mode;
    try { localStorage.setItem('codeman_runMode', mode); } catch {}
    this._applyRunMode();
    // Sync to server for cross-device persistence
    this._apiPut('/api/settings', { runMode: mode }).catch(() => {});
    // Close menu
    document.getElementById('runModeMenu')?.classList.remove('active');
  },

  toggleRunModeMenu(e) {
    e?.stopPropagation();
    const menu = document.getElementById('runModeMenu');
    if (!menu) return;
    menu.classList.toggle('active');
    // Update selected state
    menu.querySelectorAll('.run-mode-option').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.mode === this.runMode);
    });
    // Load history sessions when menu opens
    if (menu.classList.contains('active')) {
      this._loadRunModeHistory();
      const close = (ev) => {
        if (!menu.contains(ev.target)) {
          menu.classList.remove('active');
          document.removeEventListener('click', close);
        }
      };
      setTimeout(() => document.addEventListener('click', close), 0);
    }
  },

  async _loadRunModeHistory() {
    const container = document.getElementById('runModeHistory');
    if (!container) return;
    container.innerHTML = '<div class="run-mode-hist-empty">Loading...</div>';

    try {
      const display = await this._fetchHistorySessions(10);
      if (display.length === 0) {
        container.innerHTML = '<div class="run-mode-hist-empty">No history</div>';
        return;
      }

      // Build items using DOM API for reliable mobile touch handling
      container.replaceChildren();
      for (const s of display) {
        const date = new Date(s.lastModified);
        const timeStr = date.toLocaleDateString('en', { month: 'short', day: 'numeric' })
          + ' ' + date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
        const shortDir = s.workingDir.replace(/^\/home\/[^/]+\//, '~/');

        const btn = document.createElement('button');
        btn.className = 'run-mode-option';
        btn.title = s.workingDir;
        btn.dataset.sessionId = s.sessionId;
        btn.dataset.workingDir = s.workingDir;

        const dirSpan = document.createElement('span');
        dirSpan.className = 'hist-dir';
        dirSpan.textContent = shortDir;

        const metaSpan = document.createElement('span');
        metaSpan.className = 'hist-meta';
        metaSpan.textContent = timeStr;

        btn.append(dirSpan, metaSpan);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.resumeHistorySession(s.sessionId, s.workingDir, s.name);
        });
        container.appendChild(btn);
      }
    } catch (err) {
      container.innerHTML = '<div class="run-mode-hist-empty">Failed to load</div>';
    }
  },

  _applyRunMode() {
    const mode = this.runMode;
    const runBtn = document.getElementById('runBtn');
    const gearBtn = runBtn?.nextElementSibling;
    const label = document.getElementById('runBtnLabel');
    if (runBtn) {
      runBtn.className = `btn-toolbar btn-run mode-${mode}`;
    }
    if (gearBtn) {
      gearBtn.className = `btn-toolbar btn-run-gear mode-${mode}`;
    }
    if (label) {
      label.textContent = mode === 'opencode' ? 'Run OC' : mode === 'codex' ? 'Run CX' : mode === 'gemini' ? 'Run GM' : 'Run';
    }
  },

  _initRunMode() {
    try { this._runMode = localStorage.getItem('codeman_runMode') || 'claude'; } catch { this._runMode = 'claude'; }
    this._applyRunMode();
  },

  // Tab count stepper functions
  incrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  },

  decrementTabCount() {
    const input = document.getElementById('tabCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  },

  // Shell count stepper functions
  incrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.min(20, current + 1);
  },

  decrementShellCount() {
    const input = document.getElementById('shellCount');
    const current = parseInt(input.value) || 1;
    input.value = Math.max(1, current - 1);
  },

  async runClaude() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const tabCount = Math.min(20, Math.max(1, parseInt(document.getElementById('tabCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting ${tabCount} Claude session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    // Focus terminal NOW, in the synchronous user-gesture context (button click).
    // iOS Safari ignores programmatic focus() after any await, so this must happen
    // before the first async call. The keyboard opens here and stays open through
    // the session creation flow; selectSession at the end inherits the focus state.
    this.terminal.focus();

    try {
      // Get case path first
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = (await caseRes.json())?.data ?? {};

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
        // API returns { success, data: { case: { name, path } } }
        caseData = createCaseData.data.case;
      }

      const selectedCase = (this.cases || []).find(c => c.name === caseName);
      const isRemoteCase = caseData.location === 'remote' || selectedCase?.location === 'remote';
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');
      let firstSessionId = null;

      // Find the highest existing w-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^w(\d+)-([a-zA-Z0-9_-]+)/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Get global Ralph tracker setting
      const ralphEnabled = this.isRalphTrackerEnabledByDefault();

      // Create all sessions in parallel for speed
      const sessionNames = [];
      for (let i = 0; i < tabCount; i++) {
        sessionNames.push(`w${startNumber + i}-${caseName}`);
      }

      // Build env overrides from global + case settings (case overrides global)
      const caseSettings = this.getCaseSettings(caseName);
      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = this.buildEnvOverrides(caseSettings, globalSettings);
      const hasEnvOverrides = Object.keys(envOverrides).length > 0;
      const effort = this.getEffortSetting(globalSettings);
      const useOpus1m = caseSettings.opusContext1m || globalSettings.opusContext1mEnabled;
      // Explicit Claude Model choice (App Settings) wins over the legacy 1M Opus toggle.
      const modelOverride = globalSettings.claudeModel || (useOpus1m ? 'opus[1m]' : '');

      // Step 1: Create all sessions in parallel
      this.terminal.writeln(`\x1b[90m Creating ${tabCount} session(s)...\x1b[0m`);
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...(isRemoteCase ? { caseName } : { workingDir }),
            name,
            ...(hasEnvOverrides ? { envOverrides } : {}),
            ...(effort ? { effort } : {}),
            ...(modelOverride !== undefined ? { modelOverride } : {}),
            // Plan-usage statusLine exporter (App Settings → Display). The server
            // ADDS our exporter on create when true; when false it intentionally
            // leaves any existing exporter in place (a per-repo settings.local.json
            // is shared by sibling sessions, so create-with-false must not yank it
            // — see the comment in session-routes create). Disabling the setting
            // removes it via the App Settings toggle path (system-routes), not here.
            statusLineTelemetry: globalSettings.showPlanUsageLimits === true,
          })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      // Collect created session IDs
      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.data.session.id);
      }
      firstSessionId = sessionIds[0];

      // Step 2: Configure Ralph for all sessions in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/ralph-config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: ralphEnabled, disableAutoEnable: !ralphEnabled })
        })
      ));

      // Step 3: Start all sessions in parallel (biggest speedup)
      this.terminal.writeln(`\x1b[90m Starting ${tabCount} session(s) in parallel...\x1b[0m`);
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/interactive`, { method: 'POST' })
      ));

      this.terminal.writeln(`\x1b[90m All ${tabCount} sessions ready\x1b[0m`);

      // Auto-switch to the new session using selectSession (does proper refresh)
      if (firstSessionId) {
        await this.selectSession(firstSessionId);
        this.loadQuickStartCases();
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  /** Send Ctrl+C to the active session to stop the current operation.
   *  Requires double-tap: first tap turns button amber, second tap within 2s sends Ctrl+C. */
  stopClaude() {
    if (!this.activeSessionId) return;
    const btn = document.querySelector('.btn-toolbar.btn-stop');
    if (!btn) return;

    if (this._stopConfirmTimer) {
      // Second tap — send Ctrl+C
      clearTimeout(this._stopConfirmTimer);
      this._stopConfirmTimer = null;
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
      btn.classList.remove('confirming');
      fetch(`/api/sessions/${this.activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: '\x03' })
      });
    } else {
      // First tap — enter confirm state
      btn.dataset.origHtml = btn.innerHTML;
      btn.textContent = 'Tap again';
      btn.classList.add('confirming');
      this._stopConfirmTimer = setTimeout(() => {
        this._stopConfirmTimer = null;
        if (btn.dataset.origHtml) {
          btn.innerHTML = btn.dataset.origHtml;
          delete btn.dataset.origHtml;
        }
        btn.classList.remove('confirming');
      }, 2000);
    }
  },

  async runShell() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const shellCount = Math.min(20, Math.max(1, parseInt(document.getElementById('shellCount').value) || 1));

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;33m Starting ${shellCount} Shell session(s) in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');

    try {
      // Get the case path
      const caseRes = await fetch(`/api/cases/${caseName}`);
      let caseData = (await caseRes.json())?.data ?? {};

      // Create the case if it doesn't exist
      if (!caseData.path) {
        const createCaseRes = await fetch('/api/cases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: caseName, description: '' })
        });
        const createCaseData = await createCaseRes.json();
        if (!createCaseData.success) throw new Error(createCaseData.error || 'Failed to create case');
        // API returns { success, data: { case: { name, path } } }
        caseData = createCaseData.data.case;
      }

      const selectedCase = (this.cases || []).find(c => c.name === caseName);
      const isRemoteCase = caseData.location === 'remote' || selectedCase?.location === 'remote';
      const workingDir = caseData.path;
      if (!workingDir) throw new Error('Case path not found');

      // Find the highest existing s-number for THIS case to avoid duplicates
      let startNumber = 1;
      for (const [, session] of this.sessions) {
        const match = session.name && session.name.match(/^s(\d+)-([a-zA-Z0-9_-]+)/);
        if (match && match[2] === caseName) {
          const num = parseInt(match[1]);
          if (num >= startNumber) {
            startNumber = num + 1;
          }
        }
      }

      // Create all shell sessions in parallel
      const sessionNames = [];
      for (let i = 0; i < shellCount; i++) {
        sessionNames.push(`s${startNumber + i}-${caseName}`);
      }

      // Step 1: Create all sessions in parallel
      const createPromises = sessionNames.map(name =>
        fetch('/api/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...(isRemoteCase ? { caseName } : { workingDir }), mode: 'shell', name })
        }).then(r => r.json())
      );
      const createResults = await Promise.all(createPromises);

      const sessionIds = [];
      for (const result of createResults) {
        if (!result.success) throw new Error(result.error);
        sessionIds.push(result.data.session.id);
      }

      // Step 2: Start all shells in parallel
      await Promise.all(sessionIds.map(id =>
        fetch(`/api/sessions/${id}/shell`, { method: 'POST' })
      ));

      // Step 3: Resize all in parallel (with minimum dimension enforcement)
      const dims = this.getTerminalDimensions();
      if (dims) {
        await Promise.all(sessionIds.map(id =>
          fetch(`/api/sessions/${id}/resize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(dims)
          })
        ));
      }

      // Switch to first session
      if (sessionIds.length > 0) {
        this.activeSessionId = sessionIds[0];
        await this.selectSession(sessionIds[0]);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  async runOpenCode() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting OpenCode session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    // Focus in sync gesture context (see runClaude comment)
    this.terminal.focus();

    try {
      // Check if OpenCode is available
      const statusRes = await fetch('/api/opencode/status');
      const status = (await statusRes.json()).data;
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m OpenCode CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install with: curl -fsSL https://opencode.ai/install | bash\x1b[0m');
        return;
      }

      // Quick-start with opencode mode (auto-allow tools by default).
      // No `effort` field — it's Claude-specific (OpenCode has no /effort).
      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'opencode',
          openCodeConfig: { autoAllowTools: true },
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start OpenCode');

      // Switch to the new session (don't pre-set activeSessionId — selectSession
      // early-returns when IDs match, skipping buffer load and sendResize)
      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  async runCodex() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting Codex session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    this.terminal.focus();

    try {
      const statusRes = await fetch('/api/codex/status');
      const status = (await statusRes.json()).data;
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m Codex CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install with: npm install -g @openai/codex\x1b[0m');
        return;
      }

      const globalSettings = this.loadAppSettingsFromStorage();
      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), globalSettings);
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'codex',
          codexConfig: {
            dangerouslyBypassApprovals: globalSettings.codexDangerouslyBypassApprovals ?? false,
            renderMode: 'hybrid',
          },
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Codex');

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  async runGemini() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting Gemini session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    this.terminal.focus();

    try {
      const statusRes = await fetch('/api/gemini/status');
      const status = (await statusRes.json()).data;
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m Gemini CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install with: npm install -g @google/gemini-cli\x1b[0m');
        return;
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'gemini',
          geminiConfig: { approvalMode: 'yolo' },
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Gemini');

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },

  async runGemini() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';

    this.terminal.clear();
    this.terminal.writeln(`\x1b[1;32m Starting Gemini session in ${caseName}...\x1b[0m`);
    this.terminal.writeln('');
    this.terminal.focus();

    try {
      const statusRes = await fetch('/api/gemini/status');
      const status = (await statusRes.json()).data;
      if (!status.available) {
        this.terminal.writeln('\x1b[1;31m Gemini CLI not found.\x1b[0m');
        this.terminal.writeln('\x1b[90m Install with: npm install -g @google/gemini-cli\x1b[0m');
        return;
      }

      const envOverrides = this.buildEnvOverrides(this.getCaseSettings(caseName), this.loadAppSettingsFromStorage());
      const res = await fetch('/api/quick-start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caseName,
          mode: 'gemini',
          geminiConfig: { approvalMode: 'yolo' },
          ...(Object.keys(envOverrides).length > 0 ? { envOverrides } : {}),
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to start Gemini');

      if (data.data.sessionId) {
        await this.selectSession(data.data.sessionId);
      }

      this.terminal.focus();
    } catch (err) {
      this.terminal.writeln(`\x1b[1;31m Error: ${err.message}\x1b[0m`);
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal
  // ═══════════════════════════════════════════════════════════════

  openSessionOptions(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.editingSessionId = sessionId;

    // Reset to an appropriate tab — Summary for external CLIs (Respawn/Ralph are Claude-only)
    const isAltMode = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini';
    this.switchOptionsTab(isAltMode ? 'summary' : 'respawn');

    // Update respawn status display and buttons
    const respawnStatus = document.getElementById('sessionRespawnStatus');
    const enableBtn = document.getElementById('modalEnableRespawnBtn');
    const stopBtn = document.getElementById('modalStopRespawnBtn');

    if (this.respawnStatus[sessionId]) {
      respawnStatus.classList.add('active');
      respawnStatus.querySelector('.respawn-status-text').textContent =
        this.respawnStatus[sessionId].state || 'Active';
      enableBtn.style.display = 'none';
      stopBtn.style.display = '';
    } else {
      respawnStatus.classList.remove('active');
      respawnStatus.querySelector('.respawn-status-text').textContent = 'Not active';
      enableBtn.style.display = '';
      stopBtn.style.display = 'none';
    }

    // Only show respawn section for claude mode sessions with a running process
    const respawnSection = document.getElementById('sessionRespawnSection');
    if (session.mode === 'claude' && session.pid) {
      respawnSection.style.display = '';
    } else {
      respawnSection.style.display = 'none';
    }

    // Hide Claude-specific options for external CLI sessions
    const isExternalCli = session.mode === 'opencode' || session.mode === 'codex' || session.mode === 'gemini';
    const claudeOnlyEls = document.querySelectorAll('[data-claude-only]');
    claudeOnlyEls.forEach(el => { el.style.display = isExternalCli ? 'none' : ''; });

    // Reset duration presets to default (unlimited)
    this.selectDurationPreset('');

    // Populate respawn config from saved state
    this.loadSavedRespawnConfig(sessionId);

    // Populate auto-compact/clear from session state
    document.getElementById('modalAutoCompactEnabled').checked = session.autoCompactEnabled ?? false;
    document.getElementById('modalAutoCompactThreshold').value = session.autoCompactThreshold ?? 110000;
    document.getElementById('modalAutoCompactPrompt').value = session.autoCompactPrompt ?? '';
    document.getElementById('modalAutoClearEnabled').checked = session.autoClearEnabled ?? false;
    document.getElementById('modalAutoClearThreshold').value = session.autoClearThreshold ?? 140000;

    // Populate agent checkpoint (compact-or-clear, then continue). Both modes
    // are allowed by default; an explicit empty set means the operator unticked
    // everything (kept faithfully). Legacy sessions with no `checkpointModes`
    // fall back to both, matching the backend's migration.
    const cpEnabled = session.checkpointEnabled ?? false;
    const cpModes = Array.isArray(session.checkpointModes) ? session.checkpointModes : ['compact', 'clear'];
    document.getElementById('modalCheckpointEnabled').checked = cpEnabled;
    const cpCompact = document.getElementById('modalCheckpointModeCompact');
    const cpClear = document.getElementById('modalCheckpointModeClear');
    cpCompact.checked = cpModes.includes('compact');
    cpClear.checked = cpModes.includes('clear');
    cpCompact.disabled = !cpEnabled;
    cpClear.disabled = !cpEnabled;

    // Populate auto-resume on usage limit (token pause control)
    document.getElementById('modalAutoResumeEnabled').checked = session.autoResumeEnabled ?? false;
    this.updateAutoResumeStatus(sessionId);
    document.getElementById('modalImageWatcherEnabled').checked = session.imageWatcherEnabled ?? true;
    document.getElementById('modalFlickerFilterEnabled').checked = session.flickerFilterEnabled ?? false;

    // Populate session name input with prefix/suffix split
    const _modalParsed = parseSessionPrefix(session.name);
    const _prefixEl = document.getElementById('modalSessionPrefix');
    if (_modalParsed) {
      _prefixEl.textContent = _modalParsed.prefix + ': ';
      _prefixEl.style.display = '';
      document.getElementById('modalSessionName').value = _modalParsed.suffix;
      document.getElementById('modalSessionName').placeholder = 'Add description...';
    } else {
      _prefixEl.style.display = 'none';
      _prefixEl.textContent = '';
      document.getElementById('modalSessionName').value = session.name || '';
      document.getElementById('modalSessionName').placeholder = 'Auto (directory name)';
    }

    // Initialize color picker with current session color
    const currentColor = session.color || 'default';
    const colorPicker = document.getElementById('sessionColorPicker');
    colorPicker?.querySelectorAll('.color-swatch').forEach(s => {
      s.classList.toggle('selected', s.dataset.color === currentColor);
    });

    // Show the tmux session name for this tab (COD-70) so the user can map a
    // Codeman tab -> its tmux session. Prefer the real muxName from the cached
    // /api/mux-sessions list (handles legacy claudeman-/restored- names); fall
    // back to the deterministic codeman-<first8> derivation only if unavailable.
    const _muxEl = document.getElementById('modalMuxName');
    const _muxIdEl = document.getElementById('modalMuxSessionId');
    const _muxCmdEl = document.getElementById('modalMuxAttachCmd');
    if (_muxEl) {
      const cached = (this.muxSessions || []).find(m => m && m.sessionId === sessionId);
      const muxName = (session.muxName || cached?.muxName || `codeman-${String(sessionId).slice(0, 8)}`);
      _muxEl.textContent = muxName;
      _muxEl.title = muxName;
      // Spell out the full attach command with the real session name (copy-pasteable).
      if (_muxCmdEl) _muxCmdEl.textContent = `tmux attach -t ${muxName}`;
    }
    if (_muxIdEl) {
      _muxIdEl.textContent = sessionId;
    }

    // Initialize respawn preset dropdown
    this.renderPresetDropdown();
    document.getElementById('respawnPresetSelect').value = '';
    document.getElementById('presetDescriptionHint').textContent = '';

    // Hide Ralph/Todo tab and Respawn tab for external CLI sessions (not supported)
    const ralphTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="ralph"]');
    const respawnTabBtn = document.querySelector('#sessionOptionsModal .modal-tab-btn[data-tab="respawn"]');
    if (isExternalCli) {
      if (ralphTabBtn) ralphTabBtn.style.display = 'none';
      if (respawnTabBtn) respawnTabBtn.style.display = 'none';
      // Default to Context tab for external CLI sessions since Respawn is hidden
      this.switchOptionsTab('context');
    } else {
      if (ralphTabBtn) ralphTabBtn.style.display = '';
      if (respawnTabBtn) respawnTabBtn.style.display = '';
    }

    // Populate Ralph Wiggum form with current session values (skip for external CLI sessions)
    if (!isExternalCli) {
      const ralphState = this.ralphStates.get(sessionId);
      this.populateRalphForm({
        enabled: ralphState?.loop?.enabled ?? session.ralphLoop?.enabled ?? false,
        completionPhrase: ralphState?.loop?.completionPhrase || session.ralphLoop?.completionPhrase || '',
        maxIterations: ralphState?.loop?.maxIterations || session.ralphLoop?.maxIterations || 0,
        maxTodos: ralphState?.loop?.maxTodos || session.ralphLoop?.maxTodos,
        todoExpirationMinutes: ralphState?.loop?.todoExpirationMinutes || session.ralphLoop?.todoExpirationMinutes,
      });
    }

    const modal = document.getElementById('sessionOptionsModal');
    modal.classList.add('active');

    // Activate focus trap
    this.activeFocusTrap = new FocusTrap(modal);
    this.activeFocusTrap.activate();
  },

  async saveSessionName() {
    if (!this.editingSessionId) return;
    const session = this.sessions.get(this.editingSessionId);
    const parsed = session ? parseSessionPrefix(session.name) : null;
    const inputVal = document.getElementById('modalSessionName').value.trim();
    let name;
    if (parsed) {
      name = parsed.prefix + (inputVal ? ': ' + inputVal : '');
    } else {
      name = inputVal;
    }
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/name`, { name });
    } catch (err) {
      this.showToast('Failed to save session name: ' + err.message, 'error');
    }
  },

  async autoSaveAutoCompact() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-compact`, {
        enabled: document.getElementById('modalAutoCompactEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoCompactThreshold').value) || 110000,
        prompt: document.getElementById('modalAutoCompactPrompt').value.trim() || undefined
      });
    } catch { /* silent */ }
  },

  async autoSaveAutoClear() {
    if (!this.editingSessionId) return;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-clear`, {
        enabled: document.getElementById('modalAutoClearEnabled').checked,
        threshold: parseInt(document.getElementById('modalAutoClearThreshold').value) || 140000
      });
    } catch { /* silent */ }
  },

  async autoSaveCheckpoint() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalCheckpointEnabled').checked;
    const compactEl = document.getElementById('modalCheckpointModeCompact');
    const clearEl = document.getElementById('modalCheckpointModeClear');
    let modes = [...(compactEl.checked ? ['compact'] : []), ...(clearEl.checked ? ['clear'] : [])];
    // Can't enable with zero modes — fall back to both so the agent has something to run.
    if (enabled && modes.length === 0) {
      compactEl.checked = true;
      clearEl.checked = true;
      modes = ['compact', 'clear'];
    }
    // Mode ticks only apply while Agent Checkpoint is enabled.
    compactEl.disabled = !enabled;
    clearEl.disabled = !enabled;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/checkpoint`, { enabled, modes });
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.checkpointEnabled = enabled;
        session.checkpointModes = modes;
      }
      const label = enabled ? `enabled (${modes.join(' + ')})` : 'disabled';
      this.showToast(`Agent checkpoint ${label}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle checkpoint: ' + err.message, 'error');
    }
  },

  async autoSaveAutoResume() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalAutoResumeEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/auto-resume`, { enabled });
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.autoResumeEnabled = enabled;
        if (!enabled) session.autoResumeAt = undefined;
      }
      this.updateAutoResumeStatus(this.editingSessionId);
      this.showToast(`Auto-resume on usage limit ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle auto-resume: ' + err.message, 'error');
    }
  },

  // Show "resumes at HH:MM" in the session options modal while a usage-limit
  // pause is armed for the session being edited
  updateAutoResumeStatus(sessionId) {
    const el = document.getElementById('autoResumeStatus');
    if (!el || this.editingSessionId !== sessionId) return;
    const session = this.sessions.get(sessionId);
    if (session?.autoResumeAt && session.autoResumeAt > Date.now()) {
      const at = new Date(session.autoResumeAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      el.textContent = `Usage limit pause active — resumes at ${at}`;
      el.classList.add('active');
    } else {
      el.textContent = '';
      el.classList.remove('active');
    }
  },

  async toggleSessionImageWatcher() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalImageWatcherEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/image-watcher`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.imageWatcherEnabled = enabled;
      }
      this.showToast(`Image watcher ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle image watcher', 'error');
    }
  },

  async toggleFlickerFilter() {
    if (!this.editingSessionId) return;
    const enabled = document.getElementById('modalFlickerFilterEnabled').checked;
    try {
      await this._apiPost(`/api/sessions/${this.editingSessionId}/flicker-filter`, { enabled });
      // Update local session state
      const session = this.sessions.get(this.editingSessionId);
      if (session) {
        session.flickerFilterEnabled = enabled;
      }
      this.showToast(`Flicker filter ${enabled ? 'enabled' : 'disabled'}`, 'success');
    } catch (err) {
      this.showToast('Failed to toggle flicker filter', 'error');
    }
  },

  async autoSaveRespawnConfig() {
    if (!this.editingSessionId) return;
    const config = {
      updatePrompt: document.getElementById('modalRespawnPrompt').value,
      sendClear: document.getElementById('modalRespawnSendClear').checked,
      sendInit: document.getElementById('modalRespawnSendInit').checked,
      kickstartPrompt: document.getElementById('modalRespawnKickstart').value.trim() || undefined,
      autoAcceptPrompts: document.getElementById('modalRespawnAutoAccept').checked,
    };
    try {
      await this._apiPut(`/api/sessions/${this.editingSessionId}/respawn/config`, config);
    } catch {
      // Silent save - don't interrupt user
    }
  },

  async loadSavedRespawnConfig(sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/respawn/config`);
      const data = await res.json();
      if (data.success && data.data && data.data.config) {
        const c = data.data.config;
        document.getElementById('modalRespawnPrompt').value = c.updatePrompt || 'update all the docs and CLAUDE.md';
        document.getElementById('modalRespawnSendClear').checked = c.sendClear ?? true;
        document.getElementById('modalRespawnSendInit').checked = c.sendInit ?? true;
        document.getElementById('modalRespawnKickstart').value = c.kickstartPrompt || '';
        document.getElementById('modalRespawnAutoAccept').checked = c.autoAcceptPrompts ?? true;
        // Restore duration if set
        if (c.durationMinutes) {
          const presetBtn = document.querySelector(`.duration-preset-btn[data-minutes="${c.durationMinutes}"]`);
          if (presetBtn) {
            this.selectDurationPreset(String(c.durationMinutes));
          } else {
            this.selectDurationPreset('custom');
            document.getElementById('modalRespawnDuration').value = c.durationMinutes;
          }
        }
      }
    } catch {
      // Ignore - use defaults
    }
  },

  // Handle duration preset selection
  selectDurationPreset(value) {
    // Remove active from all buttons
    document.querySelectorAll('.duration-preset-btn').forEach(btn => btn.classList.remove('active'));

    // Find and activate the clicked button
    const btn = document.querySelector(`.duration-preset-btn[data-minutes="${value}"]`);
    if (btn) btn.classList.add('active');

    // Show/hide custom input
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (value === 'custom') {
      customInput.classList.add('visible');
      durationInput.focus();
    } else {
      customInput.classList.remove('visible');
      durationInput.value = ''; // Clear custom value when using preset
    }
  },

  // Get selected duration from preset buttons or custom input
  getSelectedDuration() {
    const customInput = document.querySelector('.duration-custom-input');
    const durationInput = document.getElementById('modalRespawnDuration');

    if (customInput.classList.contains('visible')) {
      // Custom mode - use input value
      return durationInput.value ? parseInt(durationInput.value) : null;
    } else {
      // Preset mode - get from active button
      const activeBtn = document.querySelector('.duration-preset-btn.active');
      const minutes = activeBtn?.dataset.minutes;
      return minutes ? parseInt(minutes) : null;
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Session Options Modal Tabs
  // ═══════════════════════════════════════════════════════════════

  switchOptionsTab(tabName) {
    // Toggle active class on tab buttons
    document.querySelectorAll('#sessionOptionsModal .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    // Toggle hidden class on tab content
    document.getElementById('respawn-tab').classList.toggle('hidden', tabName !== 'respawn');
    document.getElementById('context-tab').classList.toggle('hidden', tabName !== 'context');
    document.getElementById('ralph-tab').classList.toggle('hidden', tabName !== 'ralph');
    document.getElementById('summary-tab').classList.toggle('hidden', tabName !== 'summary');

    // Load run summary data when switching to summary tab
    if (tabName === 'summary' && this.editingSessionId) {
      this.loadRunSummary(this.editingSessionId);
    }
  },

  getRalphConfig() {
    return {
      enabled: document.getElementById('modalRalphEnabled').checked,
      completionPhrase: document.getElementById('modalRalphPhrase').value.trim(),
      maxIterations: parseInt(document.getElementById('modalRalphMaxIterations').value) || 0,
      maxTodos: parseInt(document.getElementById('modalRalphMaxTodos').value) || 50,
      todoExpirationMinutes: parseInt(document.getElementById('modalRalphTodoExpiration').value) || 60
    };
  },

  populateRalphForm(config) {
    document.getElementById('modalRalphEnabled').checked = config?.enabled ?? false;
    document.getElementById('modalRalphPhrase').value = config?.completionPhrase || '';
    document.getElementById('modalRalphMaxIterations').value = config?.maxIterations || 0;
    document.getElementById('modalRalphMaxTodos').value = config?.maxTodos || 50;
    document.getElementById('modalRalphTodoExpiration').value = config?.todoExpirationMinutes || 60;
  },

  async saveRalphConfig() {
    if (!this.editingSessionId) {
      this.showToast('No session selected', 'warning');
      return;
    }

    const config = this.getRalphConfig();

    // If user is enabling Ralph, clear from closed set
    if (config.enabled) {
      this.ralphClosedSessions.delete(this.editingSessionId);
    }

    try {
      const res = await fetch(`/api/sessions/${this.editingSessionId}/ralph-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config)
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      this.showToast('Ralph config saved', 'success');
    } catch (err) {
      this.showToast('Failed to save Ralph config: ' + err.message, 'error');
    }
  },

  // Inline rename on right-click
  startInlineRename(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const tabName = document.querySelector(`.tab-name[data-session-id="${sessionId}"]`);
    if (!tabName) return;

    // Prevent tab re-renders from destroying the input while renaming
    this._inlineRenameActive = true;

    const currentName = this.getSessionName(session);
    const parsed = parseSessionPrefix(session.name);
    const originalContent = tabName.textContent;
    // Clear existing content to make room for the input element
    tabName.textContent = '';
    while (tabName.firstChild) tabName.removeChild(tabName.firstChild);

    // If prefix detected, show it as non-editable label
    if (parsed) {
      const prefixLabel = document.createElement('span');
      prefixLabel.textContent = parsed.prefix + ': ';
      prefixLabel.style.cssText = 'color: var(--text-muted); font-size: 0.75rem; white-space: nowrap;';
      tabName.appendChild(prefixLabel);
    }

    const input = document.createElement('input');
    input.type = 'text';
    input.value = parsed ? parsed.suffix : (session.name || '');
    input.placeholder = parsed ? 'Add description...' : currentName;
    input.className = 'tab-rename-input';
    input.style.cssText = 'width: 80px; font-size: 0.75rem; padding: 2px 4px; background: var(--bg-input); border: 1px solid var(--accent); border-radius: 3px; color: var(--text); outline: none;';

    tabName.appendChild(input);
    input.focus();
    input.select();

    const finishRename = async ({ commit }) => {
      if (!this._inlineRenameActive) return; // prevent double-fire
      this._inlineRenameActive = false;
      this._activeRename = null;

      // Aborted (e.g. the session was deleted mid-rename, or Escape): re-render
      // so any ghost DOM is replaced with the canonical tab list, and skip the
      // API call — a cancel must not fire a stale rename PUT.
      if (!commit) {
        this.renderSessionTabs();
        return;
      }

      const suffix = input.value.trim();
      const fullName = parsed ? parsed.prefix + (suffix ? ': ' + suffix : '') : suffix;
      tabName.textContent = fullName || originalContent;

      // Skip the API call if the session vanished between focus and blur.
      const stillExists = this.sessions.has(sessionId);
      if (stillExists && fullName !== session.name) {
        try {
          await fetch(`/api/sessions/${sessionId}/name`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: fullName })
          });
        } catch (err) {
          tabName.textContent = originalContent;
          this.showToast('Failed to rename', 'error');
        }
      }
      // Re-render tabs to restore full tab structure
      this.renderSessionTabs();
    };

    // Register only after the input is wired so a throw above can't strand state.
    this._activeRename = {
      sessionId,
      cancel: () => finishRename({ commit: false }),
    };

    input.addEventListener('blur', () => finishRename({ commit: true }));
    input.addEventListener('keydown', (e) => {
      // Enter/Escape during IME composition belong to the IME (e.g. confirming
      // a Chinese pinyin candidate). keyCode 229 is the legacy signal for the
      // same condition on browsers that don't set isComposing reliably.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = '';
        input.blur();
      }
    });
  },


  // ═══════════════════════════════════════════════════════════════
  // Case Settings
  // ═══════════════════════════════════════════════════════════════

  toggleCaseSettings() {
    const popover = document.getElementById('caseSettingsPopover');
    if (popover.classList.contains('hidden')) {
      // Load settings for current case
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeams').checked = settings.agentTeams;
      document.getElementById('caseOpusContext1m').checked = settings.opusContext1m;
      popover.classList.remove('hidden');

      // Close on outside click (one-shot listener)
      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      // Defer to avoid catching the current click
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  },

  getCaseSettings(caseName) {
    try {
      const stored = localStorage.getItem('caseSettings_' + caseName);
      if (stored) return JSON.parse(stored);
    } catch { /* ignore */ }
    return { agentTeams: false, opusContext1m: true };
  },

  saveCaseSettings(caseName, settings) {
    localStorage.setItem('caseSettings_' + caseName, JSON.stringify(settings));
  },

  onCaseSettingChanged() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeams').checked;
    settings.opusContext1m = document.getElementById('caseOpusContext1m').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync mobile checkboxes
    const mobileCheckbox = document.getElementById('caseAgentTeamsMobile');
    if (mobileCheckbox) mobileCheckbox.checked = settings.agentTeams;
    const mobileOpusCheckbox = document.getElementById('caseOpusContext1mMobile');
    if (mobileOpusCheckbox) mobileOpusCheckbox.checked = settings.opusContext1m;
  },

  toggleCaseSettingsMobile() {
    const popover = document.getElementById('caseSettingsPopoverMobile');
    if (popover.classList.contains('hidden')) {
      const caseName = document.getElementById('quickStartCase').value || 'testcase';
      const settings = this.getCaseSettings(caseName);
      document.getElementById('caseAgentTeamsMobile').checked = settings.agentTeams;
      document.getElementById('caseOpusContext1mMobile').checked = settings.opusContext1m;
      popover.classList.remove('hidden');

      const closeHandler = (e) => {
        if (!popover.contains(e.target) && !e.target.classList.contains('btn-case-settings-mobile')) {
          popover.classList.add('hidden');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 0);
    } else {
      popover.classList.add('hidden');
    }
  },

  onCaseSettingChangedMobile() {
    const caseName = document.getElementById('quickStartCase').value || 'testcase';
    const settings = this.getCaseSettings(caseName);
    settings.agentTeams = document.getElementById('caseAgentTeamsMobile').checked;
    settings.opusContext1m = document.getElementById('caseOpusContext1mMobile').checked;
    this.saveCaseSettings(caseName, settings);
    // Sync desktop checkboxes
    const desktopCheckbox = document.getElementById('caseAgentTeams');
    if (desktopCheckbox) desktopCheckbox.checked = settings.agentTeams;
    const desktopOpusCheckbox = document.getElementById('caseOpusContext1m');
    if (desktopOpusCheckbox) desktopOpusCheckbox.checked = settings.opusContext1m;
  },

  // ═══════════════════════════════════════════════════════════════
  // Create Case Modal
  // ═══════════════════════════════════════════════════════════════

  resetCaseModalFields() {
    document.getElementById('newCaseName').value = '';
    document.getElementById('newCaseDescription').value = '';
    document.getElementById('linkCaseName').value = '';
    document.getElementById('linkCasePath').value = '';
    const remoteFields = [
      'remoteCaseName',
      'remoteCasePath',
      'remoteCaseCodexCommand',
      'remoteHostId',
      'remoteHostAddress',
      'remoteHostUsername',
      'remoteHostPort',
      'remoteHostIdentityFile',
      'remoteHostSocksProxy',
      'remoteHostJumpHost',
      'remoteHostExtraSshOptions',
    ];
    remoteFields.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const remoteHostId = document.getElementById('remoteHostId');
    if (remoteHostId) remoteHostId.disabled = false;
    const remoteHostSavedSelect = document.getElementById('remoteHostSavedSelect');
    if (remoteHostSavedSelect) remoteHostSavedSelect.value = '';
    const remoteDiscoverSection = document.getElementById('remoteDiscoverSection');
    if (remoteDiscoverSection) remoteDiscoverSection.classList.remove('hidden');
    this.closeCaseDirectoryBrowser();
  },

  resetCaseEditState() {
    this.caseEditOriginalName = null;
    this.caseEditOriginalLocation = null;
    this.caseEditOriginalHostId = null;
    const title = document.getElementById('caseModalTitle');
    if (title) title.textContent = 'Add Case';
    const remoteHostId = document.getElementById('remoteHostId');
    if (remoteHostId) remoteHostId.disabled = false;
    const remoteDiscoverSection = document.getElementById('remoteDiscoverSection');
    if (remoteDiscoverSection) remoteDiscoverSection.classList.remove('hidden');
  },

  showCreateCaseModal() {
    this.resetCaseEditState();
    this.resetCaseModalFields();
    // Reset to first tab
    this.caseModalTab = 'case-create';
    this.switchCaseModalTab('case-create');
    // Wire up tab buttons
    const modal = document.getElementById('createCaseModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchCaseModalTab(btn.dataset.tab);
    });
    // Scroll-into-view on focus for mobile keyboard visibility
    modal.querySelectorAll('input[type="text"]').forEach(input => {
      if (!input._mobileScrollWired) {
        input._mobileScrollWired = true;
        input.addEventListener('focus', () => {
          if (window.innerWidth <= 430) {
            setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
          }
        });
      }
    });
    void this.loadRemoteHostsForCaseModal();
    modal.classList.add('active');
    document.getElementById('newCaseName').focus();
  },

  switchCaseModalTab(tabName) {
    this.caseModalTab = tabName;
    const modal = document.getElementById('createCaseModal');
    const isEditing = Boolean(this.caseEditOriginalName);
    // Toggle active class on tab buttons
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    // Toggle hidden class on tab content
    modal.querySelectorAll('.modal-tab-content').forEach(content => {
      content.classList.toggle('hidden', content.id !== tabName);
    });
    // Update submit button (hide for manage tab)
    const submitBtn = document.getElementById('caseModalSubmit');
    if (tabName === 'case-manage') {
      submitBtn.style.display = 'none';
      this.renderCaseManageList();
    } else {
      submitBtn.style.display = '';
      submitBtn.textContent = isEditing ? 'Save' : tabName === 'case-create' ? 'Create' : tabName === 'case-remote' ? 'Link Remote' : 'Link';
    }
    // Focus appropriate input
    if (tabName === 'case-create') {
      document.getElementById('newCaseName').focus();
    } else if (tabName === 'case-link') {
      document.getElementById('linkCaseName').focus();
    } else if (tabName === 'case-remote') {
      void this.loadRemoteHostsForCaseModal(document.getElementById('remoteHostSavedSelect')?.value || '');
      document.getElementById('remoteCaseName').focus();
    }
  },

  closeCreateCaseModal() {
    document.getElementById('createCaseModal').classList.remove('active');
    this.resetCaseEditState();
  },

  async submitCaseModal() {
    const btn = document.getElementById('caseModalSubmit');
    const originalText = btn.textContent;
    btn.classList.add('loading');
    btn.textContent = this.caseEditOriginalName ? 'Saving...' : this.caseModalTab === 'case-create' ? 'Creating...' : 'Linking...';
    try {
      if (this.caseEditOriginalName) {
        await this.updateCase();
      } else if (this.caseModalTab === 'case-create') {
        await this.createCase();
      } else if (this.caseModalTab === 'case-remote') {
        await this.linkRemoteCase();
      } else {
        await this.linkCase();
      }
    } finally {
      btn.classList.remove('loading');
      btn.textContent = originalText;
    }
  },

  async createCase() {
    const name = document.getElementById('newCaseName').value.trim();
    const description = document.getElementById('newCaseDescription').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" created`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to create case', 'error');
      }
    } catch (err) {
      console.error('Failed to create case:', err);
      this.showToast('Failed to create case: ' + err.message, 'error');
    }
  },

  async linkCase() {
    const name = document.getElementById('linkCaseName').value.trim();
    const path = document.getElementById('linkCasePath').value.trim();

    if (!name) {
      this.showToast('Please enter a case name', 'error');
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }

    if (!path) {
      this.showToast('Please enter a folder path', 'error');
      return;
    }

    try {
      const res = await fetch('/api/cases/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path })
      });

      const data = await res.json();
      if (data.success) {
        this.closeCreateCaseModal();
        this.showToast(`Case "${name}" linked to ${path}`, 'success');
        // Reload cases and select the new one
        await this.loadQuickStartCases(name);
        // Save as last used case
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(data.error || 'Failed to link case', 'error');
      }
    } catch (err) {
      console.error('Failed to link case:', err);
      this.showToast('Failed to link case: ' + err.message, 'error');
    }
  },

  async linkRemoteCase() {
    const name = document.getElementById('remoteCaseName').value.trim();
    const remotePath = document.getElementById('remoteCasePath').value.trim();
    const hostId = document.getElementById('remoteHostId').value.trim()
      || document.getElementById('remoteHostSavedSelect')?.value.trim();
    const host = document.getElementById('remoteHostAddress').value.trim();
    const username = document.getElementById('remoteHostUsername').value.trim();
    const commands = this._readRemoteCaseCommandsFromForm();
    // COD-107 — port + advanced SSH connection options.
    const portRaw = document.getElementById('remoteHostPort').value.trim();
    const identityFile = document.getElementById('remoteHostIdentityFile').value.trim();
    const socksProxy = document.getElementById('remoteHostSocksProxy').value.trim();
    const jumpHost = document.getElementById('remoteHostJumpHost').value.trim();
    const extraSshOptions = document.getElementById('remoteHostExtraSshOptions').value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (!name || !remotePath || !hostId || !host || !username) {
      this.showToast('Please complete all required remote fields', 'error');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || !/^[a-zA-Z0-9_-]+$/.test(hostId)) {
      this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
      return;
    }
    if (!remotePath.startsWith('/')) {
      this.showToast('Remote path must be absolute', 'error');
      return;
    }
    let port;
    if (portRaw) {
      port = Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        this.showToast('SSH port must be a number between 1 and 65535', 'error');
        return;
      }
    }

    try {
      const caseRes = await fetch('/api/cases/remote-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, hostId, remotePath, commands })
      });
      const caseData = await caseRes.json();
      if (caseData.success) {
        this.closeCreateCaseModal();
        this.showToast(`Remote case "${name}" linked`, 'success');
        await this.loadQuickStartCases(name);
        await this.saveLastUsedCase(name);
      } else {
        this.showToast(caseData.error || 'Failed to link remote case', 'error');
      }
    } catch (err) {
      console.error('Failed to link remote case:', err);
      this.showToast('Failed to link remote case: ' + err.message, 'error');
    }
  },

  _caseRemoteHostsFromResponse(data) {
    return Array.isArray(data) ? data : data?.data || [];
  },

  _fillRemoteHostForm(host) {
    if (!host) return;
    document.getElementById('remoteHostId').value = host.id || '';
    document.getElementById('remoteHostAddress').value = host.host || '';
    document.getElementById('remoteHostUsername').value = host.username || '';
    document.getElementById('remoteHostPort').value = host.port ? String(host.port) : '';
    document.getElementById('remoteHostIdentityFile').value = host.identityFile || '';
    document.getElementById('remoteHostSocksProxy').value = host.socksProxy || '';
    document.getElementById('remoteHostJumpHost').value = host.jumpHost || '';
    document.getElementById('remoteHostExtraSshOptions').value = (host.extraSshOptions || []).join('\n');
  },

  async loadRemoteHostsForCaseModal(selectedHostId = '') {
    const select = document.getElementById('remoteHostSavedSelect');

    try {
      const res = await fetch('/api/remote-hosts');
      const data = await res.json();
      const hosts = this._caseRemoteHostsFromResponse(data);
      this.caseRemoteHosts = hosts;
      if (select) {
        select.innerHTML = [
          '<option value="">New host...</option>',
          ...hosts.map(host => {
            const label = host.label || host.id;
            const target = host.username && host.host ? ` (${host.username}@${host.host})` : '';
            return `<option value="${escapeHtml(host.id)}">${escapeHtml(label + target)}</option>`;
          })
        ].join('');
        if (selectedHostId) select.value = selectedHostId;
      }
    } catch (err) {
      console.warn('Failed to load remote hosts for case modal:', err);
      this.caseRemoteHosts = [];
    }
  },

  onRemoteHostSelected() {
    const select = document.getElementById('remoteHostSavedSelect');
    const hostId = select?.value || '';
    if (!hostId) return;
    const host = (this.caseRemoteHosts || []).find(item => item.id === hostId);
    if (host) this._fillRemoteHostForm(host);
  },

  startNewRemoteHostConfig() {
    const select = document.getElementById('remoteHostSavedSelect');
    if (select) select.value = '';
    this.remoteHostConfigMode = 'new';
    this.remoteHostConfigOriginalId = null;
    [
      'remoteHostId',
      'remoteHostAddress',
      'remoteHostUsername',
      'remoteHostPort',
      'remoteHostIdentityFile',
      'remoteHostSocksProxy',
      'remoteHostJumpHost',
      'remoteHostExtraSshOptions',
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const hostId = document.getElementById('remoteHostId');
    if (hostId) {
      hostId.disabled = false;
      hostId.focus?.();
    }
    this.remoteHostVerifiedFingerprint = null;
    this._setRemoteHostVerificationState(false, 'Test SSH access before saving.');
    document.getElementById('remoteHostConfigModal')?.classList.add('active');
    this.closeCaseDirectoryBrowser();
  },

  editSelectedRemoteHostConfig() {
    const select = document.getElementById('remoteHostSavedSelect');
    const hostId = select?.value || '';
    if (!hostId) {
      this.showToast('Select a saved SSH profile to edit', 'error');
      return;
    }
    const host = (this.caseRemoteHosts || []).find(item => item.id === hostId);
    if (!host) {
      this.showToast('Saved SSH profile not found', 'error');
      return;
    }
    this.remoteHostConfigMode = 'edit';
    this.remoteHostConfigOriginalId = host.id;
    this._fillRemoteHostForm(host);
    const hostIdInput = document.getElementById('remoteHostId');
    if (hostIdInput) hostIdInput.disabled = true;
    this.remoteHostVerifiedFingerprint = null;
    this._setRemoteHostVerificationState(false, 'Test SSH access before saving changes.');
    document.getElementById('remoteHostConfigModal')?.classList.add('active');
    this.closeCaseDirectoryBrowser();
  },

  closeRemoteHostConfigModal() {
    document.getElementById('remoteHostConfigModal')?.classList.remove('active');
  },

  _remoteHostFingerprint(hostPayload) {
    return JSON.stringify(hostPayload);
  },

  _setRemoteHostVerificationState(verified, message = '') {
    const saveBtn = document.getElementById('remoteHostSaveBtn');
    const status = document.getElementById('remoteHostVerifyStatus');
    if (saveBtn) saveBtn.disabled = !verified;
    if (status) {
      status.textContent = message;
      status.classList.toggle('verified', verified);
      status.classList.toggle('error', !verified && Boolean(message));
    }
  },

  async testRemoteHostConfig() {
    const hostPayload = this._readRemoteHostFromForm();
    if (!this._validateRemoteHostFormForBrowse(hostPayload)) return;
    const verifyBtn = document.getElementById('remoteHostVerifyBtn');
    if (verifyBtn) verifyBtn.disabled = true;
    this._setRemoteHostVerificationState(false, 'Testing SSH access...');

    try {
      const res = await fetch('/api/remote-hosts/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hostPayload)
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'SSH verification failed');
      this.remoteHostVerifiedFingerprint = this._remoteHostFingerprint(hostPayload);
      this._setRemoteHostVerificationState(true, 'SSH access verified.');
    } catch (err) {
      this.remoteHostVerifiedFingerprint = null;
      this._setRemoteHostVerificationState(false, err.message);
      this.showToast('SSH verification failed: ' + err.message, 'error');
    } finally {
      if (verifyBtn) verifyBtn.disabled = false;
    }
  },

  async saveRemoteHostConfig() {
    const hostPayload = this._readRemoteHostFromForm();
    if (!this._validateRemoteHostFormForBrowse(hostPayload)) return;
    if (this.remoteHostVerifiedFingerprint !== this._remoteHostFingerprint(hostPayload)) {
      this._setRemoteHostVerificationState(false, 'Test SSH access before saving.');
      this.showToast('Test SSH access before saving this profile', 'error');
      return;
    }

    const saveBtn = document.getElementById('remoteHostSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    try {
      if (this.remoteHostConfigMode === 'edit') {
        const targetId = this.remoteHostConfigOriginalId || hostPayload.id;
        const updateRes = await fetch(`/api/remote-hosts/${encodeURIComponent(targetId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hostPayload)
        });
        const updateData = await updateRes.json();
        if (!updateData.success) throw new Error(updateData.error || 'Failed to update SSH profile');
      } else {
        const createRes = await fetch('/api/remote-hosts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(hostPayload)
        });
        const createData = await createRes.json();
        if (!createData.success) {
          if (createData.errorCode !== 'ALREADY_EXISTS') {
            throw new Error(createData.error || 'Failed to save SSH profile');
          }
          const updateRes = await fetch(`/api/remote-hosts/${encodeURIComponent(hostPayload.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(hostPayload)
          });
          const updateData = await updateRes.json();
          if (!updateData.success) throw new Error(updateData.error || 'Failed to update SSH profile');
        }
      }
      await this.loadRemoteHostsForCaseModal(hostPayload.id);
      const select = document.getElementById('remoteHostSavedSelect');
      if (select) select.value = hostPayload.id;
      this.closeRemoteHostConfigModal();
      this.showToast(`SSH profile "${hostPayload.id}" saved`, 'success');
    } catch (err) {
      this._setRemoteHostVerificationState(true, 'SSH access verified.');
      this.showToast('Failed to save SSH profile: ' + err.message, 'error');
    }
  },

  _validateRemoteHostFormForBrowse(hostPayload) {
    if (!hostPayload.id || !hostPayload.host || !hostPayload.username) {
      this.showToast('Fill in Host ID, address, and username first', 'error');
      return false;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(hostPayload.id)) {
      this.showToast('Invalid Host ID. Use letters, numbers, hyphens, underscores.', 'error');
      return false;
    }
    const portRaw = document.getElementById('remoteHostPort')?.value.trim() || '';
    if (portRaw) {
      const port = Number(portRaw);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        this.showToast('SSH port must be a number between 1 and 65535', 'error');
        return false;
      }
    }
    return true;
  },

  async _ensureRemoteHostSavedForBrowse() {
    const hostPayload = this._readRemoteHostFromForm();
    const selectedHostId = document.getElementById('remoteHostSavedSelect')?.value || '';
    const effectiveHostId = hostPayload.id || selectedHostId;
    const knownHost = (this.caseRemoteHosts || []).find(host => host.id === effectiveHostId);
    if (knownHost) {
      if (!hostPayload.id) this._fillRemoteHostForm(knownHost);
      return true;
    }
    this.showToast('Save this SSH profile before browsing remote directories', 'error');
    return false;
  },

  _currentCaseDirectoryPath(target) {
    if (target === 'remote') {
      return document.getElementById('remoteCasePath')?.value.trim() || '/';
    }
    return document.getElementById('linkCasePath')?.value.trim() || '~';
  },

  _caseDirectoryBrowseUrl(target, path) {
    if (target === 'remote') {
      const hostId = document.getElementById('remoteHostId')?.value.trim()
        || document.getElementById('remoteHostSavedSelect')?.value.trim();
      if (!hostId) {
        this.showToast('Select or enter a saved remote host first', 'error');
        return null;
      }
      return `/api/remote-hosts/${encodeURIComponent(hostId)}/directories?path=${encodeURIComponent(path || '/')}`;
    }
    return `/api/cases/browse-local?path=${encodeURIComponent(path || '~')}`;
  },

  _positionCaseDirectoryBrowser(target, panel) {
    const inputId = target === 'remote' ? 'remoteCasePath' : 'linkCasePath';
    const pathRow = document.getElementById(inputId)?.closest?.('.form-row');
    pathRow?.insertAdjacentElement?.('afterend', panel);
  },

  async openCaseDirectoryBrowser(target, pathOverride = null) {
    const panel = document.getElementById('caseDirectoryBrowserPanel');
    const error = document.getElementById('caseDirectoryBrowserError');
    const list = document.getElementById('caseDirectoryBrowserList');
    if (!panel || !list) return;

    const path = pathOverride || this._currentCaseDirectoryPath(target);

    this.caseDirectoryBrowserTarget = target;
    this._positionCaseDirectoryBrowser(target, panel);
    if (error) error.textContent = '';
    list.innerHTML = '<div class="form-hint">Loading...</div>';
    panel.classList.remove('hidden');

    try {
      if (target === 'remote') {
        if (!this.caseRemoteHosts) await this.loadRemoteHostsForCaseModal();
        const hostSaved = await this._ensureRemoteHostSavedForBrowse();
        if (!hostSaved) {
          list.innerHTML = '';
          return;
        }
      }
      const url = this._caseDirectoryBrowseUrl(target, path);
      if (!url) {
        list.innerHTML = '';
        return;
      }
      const res = await fetch(url);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Failed to browse directories');
      this.renderCaseDirectoryBrowser(target, data.data);
    } catch (err) {
      console.error('Failed to browse directories:', err);
      if (error) error.textContent = err.message;
      list.innerHTML = '';
    }
  },

  renderCaseDirectoryBrowser(target, data) {
    const pathEl = document.getElementById('caseDirectoryBrowserPath');
    const list = document.getElementById('caseDirectoryBrowserList');
    const selectBtn = document.getElementById('caseDirectoryBrowserSelect');
    if (!list) return;

    const currentPath = data?.path || this._currentCaseDirectoryPath(target);
    this.caseDirectoryBrowserTarget = target;
    this.caseDirectoryBrowserCurrentPath = currentPath;
    this.caseDirectoryBrowserParentPath = data?.parentPath || null;
    if (pathEl) pathEl.textContent = currentPath;
    if (selectBtn) selectBtn.disabled = false;

    const entries = Array.isArray(data?.entries) ? data.entries : [];
    if (entries.length === 0) {
      list.innerHTML = '<div class="form-hint">No subdirectories</div>';
      return;
    }

    list.innerHTML = entries.map(entry => {
      const targetArg = escapeHtml(JSON.stringify(target));
      const pathArg = escapeHtml(JSON.stringify(entry.path));
      return `
        <button type="button" class="case-directory-row" onclick="app.openCaseDirectoryBrowser(${targetArg}, ${pathArg})">
          <span class="case-directory-icon">/</span>
          <span class="case-directory-name">${escapeHtml(entry.name)}</span>
        </button>
      `;
    }).join('');
  },

  openParentCaseDirectory() {
    if (!this.caseDirectoryBrowserParentPath) return;
    this.openCaseDirectoryBrowser(this.caseDirectoryBrowserTarget || 'local', this.caseDirectoryBrowserParentPath);
  },

  selectCaseDirectory(path = null) {
    const selectedPath = path || this.caseDirectoryBrowserCurrentPath;
    if (!selectedPath) return;
    if (this.caseDirectoryBrowserTarget === 'remote') {
      document.getElementById('remoteCasePath').value = selectedPath;
    } else {
      document.getElementById('linkCasePath').value = selectedPath;
    }
    this.closeCaseDirectoryBrowser();
  },

  closeCaseDirectoryBrowser() {
    const panel = document.getElementById('caseDirectoryBrowserPanel');
    if (panel) panel.classList.add('hidden');
    this.caseDirectoryBrowserTarget = null;
    this.caseDirectoryBrowserCurrentPath = null;
    this.caseDirectoryBrowserParentPath = null;
  },

  // ═══════════════════════════════════════════════════════════════
  // COD-105 — Discover + attach existing remote tmux sessions
  // ═══════════════════════════════════════════════════════════════

  /** Read the remote-host fields from the remote-case form into a host payload. */
  _readRemoteHostFromForm() {
    const hostId = document.getElementById('remoteHostId').value.trim();
    const host = document.getElementById('remoteHostAddress').value.trim();
    const username = document.getElementById('remoteHostUsername').value.trim();
    const portRaw = document.getElementById('remoteHostPort').value.trim();
    const identityFile = document.getElementById('remoteHostIdentityFile').value.trim();
    const socksProxy = document.getElementById('remoteHostSocksProxy').value.trim();
    const jumpHost = document.getElementById('remoteHostJumpHost').value.trim();
    const extraSshOptions = document.getElementById('remoteHostExtraSshOptions').value
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    let port;
    if (portRaw) {
      const n = Number(portRaw);
      if (Number.isInteger(n) && n >= 1 && n <= 65535) port = n;
    }
    return {
      id: hostId,
      label: hostId,
      host,
      username,
      ...(port ? { port } : {}),
      ...(identityFile ? { identityFile } : {}),
      ...(socksProxy ? { socksProxy } : {}),
      ...(jumpHost ? { jumpHost } : {}),
      ...(extraSshOptions.length ? { extraSshOptions } : {}),
    };
  },

  _readRemoteCaseCommandsFromForm() {
    const codexCommand = document.getElementById('remoteCaseCodexCommand')?.value.trim() || '';
    return codexCommand ? { codex: codexCommand } : {};
  },

  /**
   * Explicit Discover action (Decision A — never auto-runs on host select).
   * Saves the host config (idempotent), then queries the host for `codeman-*`
   * tmux sessions it didn't create and renders an Attach action per session.
   */
  async discoverRemoteSessions() {
    const results = document.getElementById('remoteDiscoverResults');
    const btn = document.getElementById('remoteDiscoverBtn');
    const hostPayload = this._readRemoteHostFromForm();
    if (!hostPayload.id || !hostPayload.host || !hostPayload.username) {
      this.showToast('Fill in Host ID, address, and username first', 'error');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(hostPayload.id)) {
      this.showToast('Invalid Host ID. Use letters, numbers, hyphens, underscores.', 'error');
      return;
    }
    if (btn) btn.disabled = true;
    if (results) results.innerHTML = '<div class="form-hint">Discovering…</div>';
    try {
      // Persist the host so the discovery endpoint can resolve it by id (idempotent).
      const hostRes = await fetch('/api/remote-hosts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hostPayload)
      });
      const hostData = await hostRes.json();
      if (!hostData.success && hostData.errorCode !== 'ALREADY_EXISTS') {
        throw new Error(hostData.error || 'Failed to save remote host');
      }
      const res = await fetch(`/api/remote-hosts/${encodeURIComponent(hostPayload.id)}/sessions`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Discovery failed');
      this._renderDiscoveredSessions(hostPayload.id, data.data.sessions || []);
    } catch (err) {
      console.error('Discover remote sessions failed:', err);
      if (results) results.innerHTML = `<div class="form-hint" style="color: var(--error, #e06c75);">${escapeHtml(err.message)}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  /** Render the discovered remote sessions with an Attach action each. */
  _renderDiscoveredSessions(hostId, sessions) {
    const results = document.getElementById('remoteDiscoverResults');
    if (!results) return;
    if (!sessions.length) {
      results.innerHTML = '<div class="form-hint">No <code>codeman-*</code> sessions running on this host (or it is unreachable).</div>';
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const rows = sessions.map(s => {
      const ageSecs = Math.max(0, now - (s.created || 0));
      const age = ageSecs < 3600 ? `${Math.floor(ageSecs / 60)}m` : ageSecs < 86400 ? `${Math.floor(ageSecs / 3600)}h` : `${Math.floor(ageSecs / 86400)}d`;
      // COD-106 — show "shared · N clients" when more than one client is attached
      // (genuinely collaborative), else a plain "attached" badge for a single client.
      const clients = s.attachedClients != null ? s.attachedClients : s.attached ? 1 : 0;
      const attachedBadge =
        clients > 1
          ? `<span class="case-location-badge" style="background: var(--warning, #e5c07b); color: #000;">shared · ${clients} clients</span>`
          : clients === 1
            ? '<span class="case-location-badge" style="background: var(--accent, #61afef);">attached</span>'
            : '';
      return `
        <div class="remote-discover-item">
          <div class="remote-discover-info">
            <span class="remote-discover-name">${escapeHtml(s.name)} ${attachedBadge}</span>
            <span class="form-hint">age ${age} · ${s.windows || 1} window(s)</span>
          </div>
          <button type="button" class="btn-toolbar" onclick="app.attachDiscoveredSession(${escapeHtml(JSON.stringify(hostId))}, ${escapeHtml(JSON.stringify(s.name))})">Attach</button>
        </div>`;
    }).join('');
    results.innerHTML = rows;
  },

  /**
   * Create a NON-owned session that attaches to a discovered remote tmux session.
   * Closing this tab detaches — it never kills the remote session.
   */
  async attachDiscoveredSession(hostId, remoteSessionName) {
    try {
      const createRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'shell',
          name: remoteSessionName,
          attachRemoteSession: { hostId, remoteSessionName },
        })
      });
      const createData = await createRes.json();
      if (!createData.success) throw new Error(createData.error || 'Failed to create session');
      const id = createData.data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      const dims = this.getTerminalDimensions();
      if (dims) {
        await fetch(`/api/sessions/${id}/resize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(dims)
        });
      }
      this.closeCreateCaseModal();
      this.showToast(`Attached to ${remoteSessionName} (detach on close)`, 'success');
      this.activeSessionId = id;
      await this.selectSession(id);
      if (this.terminal && typeof this.terminal.focus === 'function') this.terminal.focus();
    } catch (err) {
      console.error('Attach discovered session failed:', err);
      this.showToast('Failed to attach: ' + err.message, 'error');
    }
  },

  async editCase(name) {
    const caseInfo = (this.cases || []).find(c => c.name === name);
    if (!caseInfo) {
      this.showToast(`Case "${name}" not found`, 'error');
      return;
    }

    this.resetCaseModalFields();
    this.caseEditOriginalName = name;
    this.caseEditOriginalLocation = caseInfo.location || (caseInfo.linked ? 'linked-local' : 'local');
    this.caseEditOriginalHostId = caseInfo.remote?.hostId || null;

    const title = document.getElementById('caseModalTitle');
    if (title) title.textContent = 'Edit Case';

    const modal = document.getElementById('createCaseModal');
    modal.querySelectorAll('.modal-tabs .modal-tab-btn').forEach(btn => {
      btn.onclick = () => this.switchCaseModalTab(btn.dataset.tab);
    });

    if (this.caseEditOriginalLocation === 'remote') {
      const remote = caseInfo.remote || {};
      document.getElementById('remoteCaseName').value = caseInfo.name || '';
      document.getElementById('remoteCasePath').value = remote.path || '';
      document.getElementById('remoteCaseCodexCommand').value = remote.commands?.codex || '';
      document.getElementById('remoteHostId').value = remote.hostId || '';
      document.getElementById('remoteHostId').disabled = true;
      document.getElementById('remoteHostAddress').value = remote.host || '';
      document.getElementById('remoteHostUsername').value = remote.username || '';

      try {
        await this.loadRemoteHostsForCaseModal(remote.hostId || '');
        const host = (this.caseRemoteHosts || []).find(item => item.id === remote.hostId);
        if (host) this._fillRemoteHostForm(host);
        document.getElementById('remoteHostId').value = remote.hostId || '';
        document.getElementById('remoteHostId').disabled = true;
      } catch (err) {
        console.warn('Failed to load remote host details for editing:', err);
      }

      const remoteDiscoverSection = document.getElementById('remoteDiscoverSection');
      if (remoteDiscoverSection) remoteDiscoverSection.classList.add('hidden');
      this.switchCaseModalTab('case-remote');
    } else if (this.caseEditOriginalLocation === 'linked-local' || caseInfo.linked) {
      document.getElementById('linkCaseName').value = caseInfo.name || '';
      document.getElementById('linkCasePath').value = caseInfo.path || '';
      this.switchCaseModalTab('case-link');
    } else {
      document.getElementById('newCaseName').value = caseInfo.name || '';
      document.getElementById('newCaseDescription').value = '';
      this.switchCaseModalTab('case-create');
    }

    modal.classList.add('active');
  },

  async updateCase() {
    const originalName = this.caseEditOriginalName;
    const originalLocation = this.caseEditOriginalLocation;
    if (!originalName) return;

    try {
      let nextName;
      let updatePayload;

      if (originalLocation === 'remote') {
        nextName = document.getElementById('remoteCaseName').value.trim();
        const remotePath = document.getElementById('remoteCasePath').value.trim();
        const hostId = this.caseEditOriginalHostId || document.getElementById('remoteHostId').value.trim();
        const host = document.getElementById('remoteHostAddress').value.trim();
        const username = document.getElementById('remoteHostUsername').value.trim();
        const commands = this._readRemoteCaseCommandsFromForm();
        const portRaw = document.getElementById('remoteHostPort').value.trim();

        if (!nextName || !remotePath || !hostId || !host || !username) {
          this.showToast('Please complete all required remote fields', 'error');
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(nextName)) {
          this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
          return;
        }
        if (!remotePath.startsWith('/')) {
          this.showToast('Remote path must be absolute', 'error');
          return;
        }

        let port;
        if (portRaw) {
          port = Number(portRaw);
          if (!Number.isInteger(port) || port < 1 || port > 65535) {
            this.showToast('SSH port must be a number between 1 and 65535', 'error');
            return;
          }
        }

        updatePayload = { name: nextName, hostId, remotePath, commands };
      } else if (originalLocation === 'linked-local') {
        nextName = document.getElementById('linkCaseName').value.trim();
        const path = document.getElementById('linkCasePath').value.trim();
        if (!nextName || !path) {
          this.showToast('Please enter a case name and folder path', 'error');
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(nextName)) {
          this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
          return;
        }
        updatePayload = { name: nextName, path };
      } else {
        nextName = document.getElementById('newCaseName').value.trim();
        if (!nextName) {
          this.showToast('Please enter a case name', 'error');
          return;
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(nextName)) {
          this.showToast('Invalid name. Use only letters, numbers, hyphens, underscores.', 'error');
          return;
        }
        updatePayload = { name: nextName };
      }

      const res = await fetch(`/api/cases/${encodeURIComponent(originalName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatePayload)
      });
      const data = await res.json();
      if (!data.success) {
        this.showToast(data.error || 'Failed to update case', 'error');
        return;
      }

      this.closeCreateCaseModal();
      this.showToast(`Case "${nextName}" updated`, 'success');
      await this.loadQuickStartCases(nextName);
      if (document.getElementById('quickStartCase')?.value === nextName || originalName === nextName) {
        await this.saveLastUsedCase(nextName);
      }
    } catch (err) {
      console.error('Failed to update case:', err);
      this.showToast('Failed to update case: ' + err.message, 'error');
    }
  },


  // ═══════════════════════════════════════════════════════════════
  // Case Management (reorder + delete)
  // ═══════════════════════════════════════════════════════════════

  renderCaseManageList() {
    const container = document.getElementById('caseManageList');
    const cases = this.cases || [];
    if (cases.length === 0) {
      container.innerHTML = '<div class="form-hint" style="text-align: center; padding: 2rem 0;">No cases yet</div>';
      return;
    }

    let html = '';
    cases.forEach((c, idx) => {
      const isFirst = idx === 0;
      const isLast = idx === cases.length - 1;
      const pathDisplay = c.path ? c.path.replace(/^\/Users\/[^/]+/, '~') : '';
      const locationBadge = c.location === 'remote' ? '<span class="case-location-badge">remote</span>' : '';
      html += `
        <div class="case-manage-item" data-case="${escapeHtml(c.name)}">
          <div class="case-manage-info">
            <span class="case-manage-name">${escapeHtml(c.name)} ${locationBadge}</span>
            <span class="case-manage-path">${escapeHtml(pathDisplay)}</span>
          </div>
          <div class="case-manage-actions">
            <button class="case-manage-btn case-manage-btn-edit" onclick="app.editCase(${escapeHtml(JSON.stringify(c.name))})"
                    title="Edit case">&#x270E;</button>
            <button class="case-manage-btn" onclick="app.moveCaseUp(${escapeHtml(JSON.stringify(c.name))})"
                    title="Move up" ${isFirst ? 'disabled' : ''}>&#x25B2;</button>
            <button class="case-manage-btn" onclick="app.moveCaseDown(${escapeHtml(JSON.stringify(c.name))})"
                    title="Move down" ${isLast ? 'disabled' : ''}>&#x25BC;</button>
            <button class="case-manage-btn case-manage-btn-delete" onclick="app.deleteCase(${escapeHtml(JSON.stringify(c.name))})"
                    title="Delete case">&#x2715;</button>
          </div>
        </div>
      `;
    });
    container.innerHTML = html;
  },

  async moveCaseUp(name) {
    const cases = this.cases || [];
    const idx = cases.findIndex(c => c.name === name);
    if (idx <= 0) return;
    // Swap positions (immutable)
    const reordered = [...cases];
    [reordered[idx - 1], reordered[idx]] = [reordered[idx], reordered[idx - 1]];
    this.cases = reordered;
    this.renderCaseManageList();
    await this.saveCaseOrder(reordered.map(c => c.name));
  },

  async moveCaseDown(name) {
    const cases = this.cases || [];
    const idx = cases.findIndex(c => c.name === name);
    if (idx < 0 || idx >= cases.length - 1) return;
    const reordered = [...cases];
    [reordered[idx], reordered[idx + 1]] = [reordered[idx + 1], reordered[idx]];
    this.cases = reordered;
    this.renderCaseManageList();
    await this.saveCaseOrder(reordered.map(c => c.name));
  },

  async deleteCase(name) {
    if (!confirm(`Delete case "${name}"? Linked cases will only be unlinked (folder preserved). Created cases will be permanently deleted.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Case "${name}" ${data.data?.type === 'unlinked' ? 'unlinked' : 'deleted'}`, 'success');
        // Remove from current list and refresh
        this.cases = (this.cases || []).filter(c => c.name !== name);
        this.renderCaseManageList();
        // Refresh the dropdown
        const select = document.getElementById('quickStartCase');
        const currentCase = select.value;
        await this.loadQuickStartCases(currentCase === name ? null : currentCase);
        if (currentCase === name) {
          await this.saveLastUsedCase(document.getElementById('quickStartCase')?.value || 'testcase');
        }
      } else {
        this.showToast(data.error || 'Failed to delete case', 'error');
      }
    } catch (err) {
      this.showToast('Failed to delete case: ' + err.message, 'error');
    }
  },

  async saveCaseOrder(order) {
    try {
      await fetch('/api/cases/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order })
      });
      // Refresh dropdown to reflect new order
      const select = document.getElementById('quickStartCase');
      const currentCase = select.value;
      await this.loadQuickStartCases(currentCase);
    } catch (err) {
      this.showToast('Failed to save case order: ' + err.message, 'error');
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // Mobile Case Picker
  // ═══════════════════════════════════════════════════════════════

  showMobileCasePicker() {
    const modal = document.getElementById('mobileCasePickerModal');
    const listContainer = document.getElementById('mobileCaseList');
    const select = document.getElementById('quickStartCase');
    const currentCase = select.value;

    // Build case list HTML
    let html = '';
    const cases = this.cases || [];

    // Add testcase if not in list
    const hasTestcase = cases.some(c => c.name === 'testcase');
    const allCases = hasTestcase ? cases : [{ name: 'testcase' }, ...cases];

    for (const c of allCases) {
      const isSelected = c.name === currentCase;
      html += `
        <button class="mobile-case-item ${isSelected ? 'selected' : ''}"
                onclick="app.selectMobileCase(${escapeHtml(JSON.stringify(c.name))})">
          <span class="mobile-case-item-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            </svg>
          </span>
          <span class="mobile-case-item-name">${escapeHtml(c.name)}</span>
          <span class="mobile-case-item-delete" onclick="event.stopPropagation(); app.deleteCaseMobile(${escapeHtml(JSON.stringify(c.name))})" title="Delete">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </span>
          <span class="mobile-case-item-check">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </span>
        </button>
      `;
    }

    listContainer.innerHTML = html;
    modal.classList.add('active');
  },

  closeMobileCasePicker() {
    document.getElementById('mobileCasePickerModal').classList.remove('active');
  },

  selectMobileCase(caseName) {
    // Update the desktop select (source of truth)
    const select = document.getElementById('quickStartCase');
    select.value = caseName;

    // Update mobile button label
    this.updateMobileCaseLabel(caseName);

    // Update directory display
    this.updateDirDisplayForCase(caseName);

    // Save as last used
    this.saveLastUsedCase(caseName);

    // Close the picker
    this.closeMobileCasePicker();

    this.showToast(`Selected: ${caseName}`, 'success');
  },

  updateMobileCaseLabel(caseName) {
    const label = document.getElementById('mobileCaseName');
    if (label) {
      // Let CSS handle truncation via text-overflow: ellipsis
      label.textContent = caseName;
    }
  },

  async deleteCaseMobile(name) {
    if (!confirm(`Delete case "${name}"?`)) return;
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(name)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        this.showToast(`Case "${name}" ${data.data?.type === 'unlinked' ? 'unlinked' : 'deleted'}`, 'success');
        this.cases = (this.cases || []).filter(c => c.name !== name);
        // Refresh mobile picker and dropdown
        this.closeMobileCasePicker();
        const select = document.getElementById('quickStartCase');
        const currentCase = select?.value;
        await this.loadQuickStartCases(currentCase === name ? null : currentCase);
        if (currentCase === name) {
          await this.saveLastUsedCase(document.getElementById('quickStartCase')?.value || 'testcase');
        }
      } else {
        this.showToast(data.error || 'Failed to delete case', 'error');
      }
    } catch (err) {
      this.showToast('Failed to delete case: ' + err.message, 'error');
    }
  },

  showCreateCaseFromMobile() {
    // Close mobile picker first
    this.closeMobileCasePicker();
    // Open the create case modal with slide-up animation
    this.showCreateCaseModal();
    const modal = document.getElementById('createCaseModal');
    modal.classList.add('from-mobile');
    // Remove animation class after it plays
    setTimeout(() => modal.classList.remove('from-mobile'), 300);
  },
});

Object.defineProperty(CodemanApp.prototype, 'runMode', {
  configurable: true,
  enumerable: true,
  get() {
    return this._runMode || 'claude';
  },
  set(mode) {
    this._runMode =
      mode === 'opencode' || mode === 'codex' || mode === 'gemini' || mode === 'claude' ? mode : 'claude';
  },
});
