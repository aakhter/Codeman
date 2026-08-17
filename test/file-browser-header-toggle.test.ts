// @vitest-environment jsdom
/**
 * @fileoverview COD-235 — the desktop Files header button is a session-gated toggle whose
 * state is derived from the canonical file-browser panel, including non-header entry points.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';

const publicDir = join(process.cwd(), 'src/web/public');
const readPublic = (file: string) => readFileSync(join(publicDir, file), 'utf8');

let CodemanApp: { new (): any };

beforeAll(() => {
  const combined =
    'var marked, MobileDetection = { isMobile: function(){ return false; }, isTouchDevice: function(){ return false; }, getDeviceType: function(){ return "desktop"; } }, ' +
    'KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = { cleanup: function(){} }, DeepgramProvider = {}, ' +
    'NotificationManager = function(){}, FocusTrap = function(){ return { activate(){}, deactivate(){} }; };\n' +
    readPublic('constants.js') +
    '\n' +
    readPublic('app.js') +
    '\n' +
    readPublic('panels-ui.js') +
    '\n' +
    readPublic('settings-ui.js') +
    '\n' +
    readPublic('session-ui.js') +
    '\n;globalThis.__Cod235App = CodemanApp;';
  (0, eval)(combined);
  CodemanApp = (globalThis as any).__Cod235App as { new (): any };
});

function mountFileBrowserDom() {
  document.body.innerHTML = `
    <button id="fileBrowserBtn" aria-expanded="false" disabled></button>
    <div id="fileBrowserPanel"></div>
  `;
  return {
    button: document.getElementById('fileBrowserBtn') as HTMLButtonElement,
    panel: document.getElementById('fileBrowserPanel') as HTMLDivElement,
  };
}

function makeApp(activeSessionId: string | null = null): any {
  const app = Object.create(CodemanApp.prototype);
  app._elemCache = {};
  app.activeSessionId = activeSessionId;
  app.fileBrowserDragListeners = {};
  app.loadFileBrowser = vi.fn();
  app.makeWindowDraggable = vi.fn(() => ({}));
  app.loadAppSettingsFromStorage = vi.fn(() => ({}));
  app.saveAppSettingsToStorage = vi.fn();
  return app;
}

function makeSelectSessionHarness(sessionId: string): any {
  const app = makeApp(null);
  app.isSoloWindow = false;
  app.detachedSessions = new Set();
  app.sessions = new Map([
    [sessionId, { id: sessionId, name: 'Selected session', mode: 'shell', status: 'idle', pid: 1 }],
  ]);
  app.terminal = {
    options: {},
    focus: vi.fn(),
    reset: vi.fn(),
    write: vi.fn((_text: string, callback?: () => void) => callback?.()),
    scrollToBottom: vi.fn(),
  };
  app._selectGeneration = 0;
  app._setTerminalLoadState = vi.fn();
  app._clearTerminalLoadState = vi.fn();
  app._cleanupPreviousSession = vi.fn();
  app._isMirrorSession = vi.fn(() => false);
  app._userScrollback = vi.fn(() => 1000);
  app._updateSseSubscription = vi.fn();
  app._connectWs = vi.fn();
  app.hideWelcome = vi.fn();
  app.clearPendingHooks = vi.fn();
  // Real constructor field: selectSession clears the idle alert on view via
  // markIdleAlertSeen(), which reads this map before delegating to the stub above.
  app.pendingHooks = new Map();
  app._updateActiveTabImmediate = vi.fn();
  app.renderSessionTabs = vi.fn();
  app.updateAttachmentHistoryBadge = vi.fn();
  app.attachmentHistoryDrawerOpen = false;
  app._updateLocalEchoState = vi.fn();
  app._flushedOffsets = new Map();
  app._flushedTexts = new Map();
  app._localEchoOverlay = null;
  app.terminalBufferCache = new Map();
  app._xtermSnapshots = new Map();
  app._sessionsLoadedSincePageOpen = new Set();
  // Real constructor field (app.js). The harness builds the app with
  // Object.create, so every field selectSession touches has to be stubbed here;
  // a missing one makes selectSession throw and the sync assertions read as
  // "callback never scheduled".
  app._fullHistoryLoaded = new Set();
  app._beginBufferLoad = vi.fn(() => 1);
  app._isLoadingBuffer = false;
  app._isStaleSelect = vi.fn(() => false);
  app.sendResize = vi.fn(async () => false);
  app._resetTerminalForReplay = vi.fn();
  app.respawnStatus = {};
  app.hideRespawnBanner = vi.fn();
  app.stopCountdownInterval = vi.fn();
  app.renderRalphStatePanel = vi.fn();
  app.updateCliInfoDisplay = vi.fn();
  app.renderProjectInsightsPanel = vi.fn();
  app.updateSubagentWindowVisibility = vi.fn();
  app.scrollToLastNonEmptyLine = vi.fn();
  app._scheduleTerminalRepaint = vi.fn();
  app.showConfiguredFileBrowserPanel = vi.fn();
  return app;
}

beforeEach(() => {
  mountFileBrowserDom();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('COD-235 Files header markup and phone policy', () => {
  it('ships an accessible, initially disabled folder toggle beside Sources and Library', () => {
    const html = readPublic('index.html');
    const match = html.match(/<button\b[^>]*id="fileBrowserBtn"[^>]*>[\s\S]*?<\/button>/);

    expect(match, '#fileBrowserBtn is missing').toBeTruthy();
    const button = match![0];
    expect(button).toContain('class="btn-icon-header btn-files"');
    expect(button).toContain('onclick="app.toggleFileBrowserPanel()"');
    expect(button).toContain('title="Files"');
    expect(button).toContain('aria-label="Open files panel"');
    expect(button).toContain('aria-expanded="false"');
    expect(button).toMatch(/<button\b[^>]*\sdisabled(?:\s|>)/);
    expect(button).toMatch(/<svg\b[\s\S]*?<path\b/);

    const sourcesIndex = html.indexOf('id="sourcesBtn"');
    const filesIndex = html.indexOf('id="fileBrowserBtn"');
    const libraryIndex = html.indexOf('id="libraryBtn"');
    expect(sourcesIndex).toBeGreaterThan(-1);
    expect(filesIndex).toBeGreaterThan(sourcesIndex);
    expect(filesIndex).toBeLessThan(libraryIndex);
  });

  it('independently hides .btn-files at phone width', () => {
    const hiddenAtPhone = new Set<string>();
    postcss.parse(readPublic('mobile.css')).walkAtRules('media', (atRule) => {
      const max = atRule.params.match(/max-width:\s*(\d+)px/);
      const min = atRule.params.match(/min-width:\s*(\d+)px/);
      if (max && 393 > Number(max[1])) return;
      if (min && 393 < Number(min[1])) return;
      if (!max && !min) return;

      atRule.walkRules((rule) => {
        const hides = rule.nodes.some(
          (node) =>
            node.type === 'decl' && node.prop === 'display' && node.value.replace(/!important/i, '').trim() === 'none'
        );
        if (hides && rule.selector.includes('.btn-files')) hiddenAtPhone.add('btn-files');
      });
    });

    expect(hiddenAtPhone.has('btn-files')).toBe(true);
  });
});

describe('COD-235 canonical Files header behavior', () => {
  it('does nothing without an active session or the required panel DOM', () => {
    const app = makeApp(null);
    app.showFileBrowserPanel = vi.fn();
    app.closeFileBrowserPanel = vi.fn();

    expect(app.toggleFileBrowserPanel).toBeTypeOf('function');
    app.toggleFileBrowserPanel();
    expect(app.showFileBrowserPanel).not.toHaveBeenCalled();
    expect(app.closeFileBrowserPanel).not.toHaveBeenCalled();

    app.activeSessionId = 'session-a';
    document.getElementById('fileBrowserPanel')?.remove();
    expect(() => app.toggleFileBrowserPanel()).not.toThrow();
    expect(app.showFileBrowserPanel).not.toHaveBeenCalled();
    expect(app.closeFileBrowserPanel).not.toHaveBeenCalled();
  });

  it('routes closed to canonical show for the active session and open to canonical close', () => {
    const { panel } = mountFileBrowserDom();
    const app = makeApp('session-a');
    app.showFileBrowserPanel = vi.fn();
    app.closeFileBrowserPanel = vi.fn();

    app.toggleFileBrowserPanel();
    expect(app.showFileBrowserPanel).toHaveBeenCalledWith('session-a');
    expect(app.closeFileBrowserPanel).not.toHaveBeenCalled();

    panel.classList.add('visible');
    app.toggleFileBrowserPanel();
    expect(app.closeFileBrowserPanel).toHaveBeenCalledOnce();
  });

  it('derives disabled, active, and aria-expanded only from session plus panel visibility', () => {
    const { button, panel } = mountFileBrowserDom();
    const app = makeApp(null);

    panel.classList.add('visible');
    app.updateFileBrowserHeaderButton();
    expect(button.disabled).toBe(true);
    expect(button.classList.contains('active')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');

    app.activeSessionId = 'session-a';
    app.updateFileBrowserHeaderButton();
    expect(button.disabled).toBe(false);
    expect(button.classList.contains('active')).toBe(true);
    expect(button.getAttribute('aria-expanded')).toBe('true');

    panel.classList.remove('visible');
    app.updateFileBrowserHeaderButton();
    expect(button.disabled).toBe(false);
    expect(button.classList.contains('active')).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('synchronizes derived header state after canonical show and close', () => {
    const app = makeApp('session-a');
    app.updateFileBrowserHeaderButton = vi.fn();

    CodemanApp.prototype.showFileBrowserPanel.call(app, 'session-a');
    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();

    app.updateFileBrowserHeaderButton.mockClear();
    app.fileBrowserDragListeners = null;
    CodemanApp.prototype.closeFileBrowserPanel.call(app);
    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();
  });

  it('synchronizes after App Settings directly hides the panel', () => {
    const { panel } = mountFileBrowserDom();
    panel.classList.add('visible');
    const app = makeApp('session-a');
    app._cachedAppSettings = { showMonitor: false, showSubagents: false, showFileBrowser: false };
    app.getDefaultSettings = vi.fn(() => ({ showMonitor: false, showSubagents: false, showFileBrowser: false }));
    app.updateFileBrowserHeaderButton = vi.fn();

    app.applyMonitorVisibility();

    expect(panel.classList.contains('visible')).toBe(false);
    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();
  });

  it('synchronizes from the central session-tab render path', () => {
    const app = makeApp('session-a');
    app._inlineRenameActive = false;
    app._debouncedCall = vi.fn();
    app.updateFileBrowserHeaderButton = vi.fn();

    app.renderSessionTabs();

    expect(app.updateFileBrowserHeaderButton).toHaveBeenCalledOnce();
  });

  it('post-selection sync canonically reveals a configured hidden panel for the selected session', () => {
    const app = makeApp('selected-session');
    app.loadAppSettingsFromStorage.mockReturnValue({ showFileBrowser: true });
    app.showFileBrowserPanel = vi.fn();

    expect(app.showConfiguredFileBrowserPanel).toBeTypeOf('function');
    app.showConfiguredFileBrowserPanel('selected-session');

    expect(app.showFileBrowserPanel).toHaveBeenCalledOnce();
    expect(app.showFileBrowserPanel).toHaveBeenCalledWith('selected-session');
  });

  it('post-selection sync retains an already-visible panel owner without loading or drag rebinding', () => {
    const { panel } = mountFileBrowserDom();
    panel.classList.add('visible');
    const app = makeApp('new-active-session');
    app.fileBrowserSessionId = 'existing-owner-session';
    app.loadAppSettingsFromStorage.mockReturnValue({ showFileBrowser: true });
    app.showFileBrowserPanel = vi.fn();

    expect(app.showConfiguredFileBrowserPanel).toBeTypeOf('function');
    app.showConfiguredFileBrowserPanel('new-active-session');

    expect(app.showFileBrowserPanel).not.toHaveBeenCalled();
    expect(app.loadFileBrowser).not.toHaveBeenCalled();
    expect(app.makeWindowDraggable).not.toHaveBeenCalled();
    expect(app.fileBrowserSessionId).toBe('existing-owner-session');
  });

  it('selectSession post-selection callback invokes configured Files sync with the selected session', async () => {
    const sessionId = 'selected-session';
    const idleCallbacks: Array<() => void> = [];
    vi.stubGlobal(
      'requestIdleCallback',
      vi.fn((callback: () => void) => idleCallbacks.push(callback))
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ json: async () => ({ data: { terminalBuffer: '', truncated: false } }) }))
    );
    const app = makeSelectSessionHarness(sessionId);

    await app.selectSession(sessionId);

    expect(idleCallbacks).toHaveLength(1);
    expect(app.showConfiguredFileBrowserPanel).not.toHaveBeenCalled();
    idleCallbacks[0]();
    expect(app.showConfiguredFileBrowserPanel).toHaveBeenCalledOnce();
    expect(app.showConfiguredFileBrowserPanel).toHaveBeenCalledWith(sessionId);
  });

  it('preserves Session Manager Open folder routing through canonical reveal', () => {
    const source = readPublic('terminal-ui.js');
    const openFolderBlock = source.match(/addItem\('Open folder',[\s\S]*?\n\s*}\);/)?.[0] ?? '';

    expect(openFolderBlock).toContain('this.selectSession(s.sessionId)');
    expect(openFolderBlock).toContain('this.showFileBrowserPanel?.(s.sessionId)');
  });
});

describe('COD-235 direct active-session mutation sync', () => {
  it('synchronizes immediately when empty init clears the active session after tab rendering', () => {
    const app = makeApp('stale-session');
    app._initGeneration = 0;
    app._clearTimer = vi.fn();
    app._updateCjkInputState = vi.fn();
    app._applyCodemanCliHints = vi.fn();
    app._resetAllAppState = vi.fn();
    app.sessions = new Map();
    app.ralphClosedSessions = new Set();
    app.ralphStates = new Map();
    app.sessionOrder = [];
    app.syncSessionOrder = vi.fn();
    app.updateCost = vi.fn();
    app.renderSessionTabs = vi.fn();
    app.stopSystemStatsPolling = vi.fn();
    app.cleanupAllFloatingWindows = vi.fn();
    app.isSoloWindow = false;
    const observedActiveSessions: Array<string | null> = [];
    app.updateFileBrowserHeaderButton = vi.fn(() => observedActiveSessions.push(app.activeSessionId));

    app.handleInit({ sessions: [], scheduledRuns: [] });

    expect(app.activeSessionId).toBeNull();
    expect(observedActiveSessions).toEqual([null]);
  });

  it('lets selectSession assign a remote quick-start session before synchronizing the header', async () => {
    document.body.innerHTML = `
      <select id="quickStartCase"><option value="remote-case" selected>remote-case</option></select>
      <input id="shellCount" value="1">
    `;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ json: async () => ({ data: { location: 'remote', path: '/remote/case' } }) })
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { sessionId: 'remote-session' } }) });
    vi.stubGlobal('fetch', fetchMock);

    const app = makeApp(null);
    app.sessions = new Map();
    app.cases = [];
    app.terminal = { clear: vi.fn(), writeln: vi.fn(), focus: vi.fn() };
    // Added to the remote runShell path after this test was written: with no
    // `session` in the quick-start payload it fetches the session itself, which
    // this test's two-call fetch mock does not cover. Not what is under test —
    // the assertion below is purely about selectSession's ordering.
    app._ensureCreatedSessionVisible = vi.fn();
    const observedActiveSessions: Array<string | null> = [];
    app.updateFileBrowserHeaderButton = vi.fn(() => observedActiveSessions.push(app.activeSessionId));
    app.selectSession = vi.fn(function (
      this: { activeSessionId: string | null; updateFileBrowserHeaderButton: () => void },
      sessionId: string
    ) {
      expect(this.activeSessionId).toBeNull();
      this.activeSessionId = sessionId;
      this.updateFileBrowserHeaderButton();
    });

    await app.runShell();

    expect(app.activeSessionId).toBe('remote-session');
    expect(observedActiveSessions).toEqual(['remote-session']);
    expect(app.selectSession.mock.invocationCallOrder[0]).toBeLessThan(
      app.updateFileBrowserHeaderButton.mock.invocationCallOrder[0]
    );
  });
});
