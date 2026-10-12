// @vitest-environment jsdom
/** @fileoverview COD-306 integration coverage over the shipping browser controller and DOM. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
let CodemanApp: { prototype: Record<string, any> };
let localStorageDescriptor: PropertyDescriptor;

beforeAll(() => {
  localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
  const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
  const source =
    'var MobileDetection = {}, KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, ' +
    'DeepgramProvider = {}, NotificationManager = function(){};\n' +
    read('constants.js') +
    '\n' +
    read('tab-layout-browser.js') +
    '\n' +
    read('app.js') +
    '\n' +
    read('webview-tabs.js') +
    '\n' +
    read('mobile-overview.js') +
    '\n' +
    read('home-sessions.js') +
    '\n' +
    read('panels-ui.js') +
    '\n' +
    read('session-lineage.js') +
    '\n;globalThis.__TabLayoutCodemanApp = CodemanApp;';
  const previousInterval = window.setInterval;
  const previousAnimationFrame = window.requestAnimationFrame;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
  (0, eval)(source);
  window.setInterval = previousInterval;
  window.requestAnimationFrame = previousAnimationFrame;
  CodemanApp = (globalThis as any).__TabLayoutCodemanApp;
});

const layout = {
  version: 8,
  updatedAt: '2026-08-16T00:00:00.000Z',
  groups: [
    {
      id: 'group-x',
      name: '<Core & Ops>',
      refs: [
        { kind: 'session', id: 's2' },
        { kind: 'webview', id: 'w1' },
        { kind: 'session', id: 's1' },
        { kind: 'webview', id: 'closed' },
      ],
    },
  ],
  ungrouped: [{ kind: 'session', id: 's3' }],
};

describe('effective activity in session tabs', () => {
  it('renders and incrementally updates agent activity classes, data, and accessible name', () => {
    const app = makeApp();
    app.activeWebviewId = null;
    app.sessions.get('s1').activityStatus = 'waiting_agents';
    app._fullRenderSessionTabs();
    const tab = document.querySelector<HTMLElement>('[data-id="s1"]')!;
    expect(tab.dataset.activityStatus).toBe('waiting_agents');
    expect(tab.querySelector('.tab-status')?.classList.contains('waiting-agents')).toBe(true);
    expect(tab.getAttribute('aria-label')).toContain('waiting on background agents');

    app.sessions.get('s1').activityStatus = 'checking_agents';
    app._renderSessionTabsImmediate();
    expect(tab.dataset.activityStatus).toBe('checking_agents');
    expect(tab.querySelector('.tab-status')?.classList.contains('checking-agents')).toBe(true);
    expect(tab.getAttribute('aria-label')).toContain('checking background agents');
  });
});

function makeApp() {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', 'vertical');
  document.body.innerHTML = '<div id="sessionTabs"></div>';
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map([
    ['s1', { id: 's1', name: 'One', status: 'idle' }],
    ['s2', { id: 's2', name: 'Two', status: 'busy' }],
    ['s3', { id: 's3', name: 'Three', status: 'idle' }],
  ]);
  app.webviews = new Map([
    ['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test' }],
    ['closed', { id: 'closed', name: 'Closed', url: 'https://closed.test' }],
  ]);
  app.webviewOrder = ['w1'];
  app.activeSessionId = 's2';
  app.activeWebviewId = 'w1';
  app.tabLayout = layout;
  app.tabLayoutVersion = layout.version;
  app.tabLayoutReadOnly = false;
  app.collapsedTabGroupIds = new Set();
  app._tabCollapseStorageFailed = false;
  app.sessionOrder = ['s1', 's2', 's3'];
  app._legacySessionOrder = ['s1', 's2', 's3'];
  app._tabLayoutFirstPaintPending = false;
  app._lastTabStructureKey = null;
  app._inlineRenameActive = false;
  app._tabLayoutManaged = true;
  app._deferredCreatedSessionIds = new Set();
  app.detachedSessions = new Set();
  app.tabAlerts = new Map();
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => {};
  app.updateTabOverflowMode = () => {};
  app.updateConnectionLines = () => {};
  app.setupTabKeyboardNavigation = () => {};
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  return app;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeInitApp() {
  const app = makeApp();
  app._initGeneration = 0;
  app._clearTimer = vi.fn();
  app._updateCjkInputState = vi.fn();
  app._applyCodemanCliHints = vi.fn();
  app._resetAllAppState = vi.fn(() => app.sessions.clear());
  app.updateAttachmentHistoryCountFromSession = vi.fn();
  app.updateCost = vi.fn();
  app.renderSessionTabs = vi.fn();
  app.renderMuxSessions = vi.fn();
  app.seedApprovals = vi.fn();
  app.startSystemStatsPolling = vi.fn();
  app.stopSystemStatsPolling = vi.fn();
  app.cleanupAllFloatingWindows = vi.fn();
  app.updateFileBrowserHeaderButton = vi.fn();
  app.selectSession = vi.fn();
  app.syncSessionOrder = vi.fn(() => {
    app.sessionOrder = ['s1', 's2', 's3'];
  });
  app.isSoloWindow = false;
  app.activeSessionId = null;
  app.activeWebviewId = null;
  app._tabLayoutFirstPaintPending = true;
  app._tabLayoutCoordinator = null;
  app.ralphClosedSessions = new Set();
  app.ralphStates = new Map();
  (globalThis as any).VoiceInput.cleanup = vi.fn();
  localStorage.removeItem('codeman-active-session');
  return app;
}

function openPendingPalette(app: Record<string, any>, query = 'o') {
  document.body.insertAdjacentHTML(
    'beforeend',
    '<div id="commandPaletteModal"><input id="commandPaletteSearch"><div id="commandPaletteList"></div></div>'
  );
  app.cases = [];
  app.closeMobileHeaderUtilities = vi.fn();
  app._commandPaletteWired = false;
  app.openCommandPalette();
  const search = document.getElementById('commandPaletteSearch') as HTMLInputElement;
  search.value = query;
  app.renderCommandPalette();
  return search;
}

const initData = {
  sessions: [
    { id: 's1', name: 'One', status: 'idle' },
    { id: 's2', name: 'Two', status: 'idle' },
    { id: 's3', name: 'Three', status: 'idle' },
  ],
  sessionOrder: ['s1', 's2', 's3'],
  scheduledRuns: [],
};

function makeActivityEventApp() {
  const app = makeApp();
  app.renderSessionTabs = vi.fn();
  app.renderMuxSessions = vi.fn();
  app.updateCost = vi.fn();
  app.updateAttachmentHistoryCountFromSession = vi.fn();
  app.updateSubagentParentNames = vi.fn();
  app.recheckOrphanSubagents = vi.fn();
  app.sendPendingCtrlL = vi.fn();
  app._updateLocalEchoState = vi.fn();
  app._isTuiSession = vi.fn(() => false);
  app._notifySession = vi.fn();
  app.pendingHooks = new Map();
  app.idleTimers = new Map();
  app.respawnStatus = {};
  app.notificationManager = { preferences: { stuckThresholdMs: 60_000 } };
  app._wsSessionId = null;
  app._wsReady = false;
  app.sessionOrder = ['s1', 's2', 's3'];
  app.saveSessionOrder = vi.fn();
  app.startSystemStatsPolling = vi.fn();
  return app;
}

describe('session activity event reconciliation', () => {
  it('merges an activity-only update without replacing session data or raw status and refreshes every status surface', () => {
    const app = makeActivityEventApp();
    const original = app.sessions.get('s1');

    app._onSessionUpdated({ id: 's1', activityStatus: 'waiting_agents', activityStatusSince: 1234 });

    expect(app.sessions.get('s1')).toMatchObject({
      id: 's1',
      name: 'One',
      status: 'idle',
      activityStatus: 'waiting_agents',
      activityStatusSince: 1234,
    });
    expect(app.sessions.get('s1')).toBe(original);
    expect(app.renderSessionTabs).toHaveBeenCalledOnce();
    expect(app.renderMuxSessions).toHaveBeenCalledOnce();
  });

  it('replaces a full session update so absent legacy fields cannot survive', () => {
    const app = makeActivityEventApp();
    app.sessions.get('s1').legacyOnly = true;

    app._onSessionUpdated({
      id: 's1',
      name: 'Renamed',
      status: 'idle',
      activityStatus: 'idle',
      activityStatusSince: null,
    });

    expect(app.sessions.get('s1')).toMatchObject({ name: 'Renamed', status: 'idle', activityStatus: 'idle' });
    expect(app.sessions.get('s1')).not.toHaveProperty('legacyOnly');
  });

  it.each(['waiting_agents', 'checking_agents'])(
    '%s idle evidence cancels a stuck timer without creating local idle semantics',
    (activityStatus) => {
      vi.useFakeTimers();
      const app = makeActivityEventApp();
      const existingTimer = setTimeout(() => {}, 60_000);
      const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
      app.idleTimers.set('s1', existingTimer);

      app._onSessionIdle({ id: 's1', status: 'idle', activityStatus, activityStatusSince: 1234 });

      expect(clearSpy).toHaveBeenCalledWith(existingTimer);
      expect(app.idleTimers.has('s1')).toBe(false);
      expect(app.sendPendingCtrlL).not.toHaveBeenCalled();
      expect(app._updateLocalEchoState).not.toHaveBeenCalled();
    }
  );

  it('arms genuine derived idle once and does not replace the timer on repeated events', () => {
    vi.useFakeTimers();
    const app = makeActivityEventApp();
    app.sessions.get('s1').status = 'busy';

    app._onSessionIdle({ id: 's1', status: 'idle', activityStatus: 'idle', activityStatusSince: null });
    const firstTimer = app.idleTimers.get('s1');
    app._onSessionIdle({ id: 's1', status: 'idle', activityStatus: 'idle', activityStatusSince: null });

    expect(firstTimer).toBeDefined();
    expect(app.idleTimers.get('s1')).toBe(firstTimer);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('clears stale waiting activity on working, terminal output, and exit events', () => {
    const app = makeActivityEventApp();
    const session = app.sessions.get('s1');
    session.status = 'idle';
    session.activityStatus = 'waiting_agents';
    session.activityStatusSince = 1234;

    app._onSessionWorking({ id: 's1', status: 'busy' });
    expect(session).toMatchObject({ status: 'busy', activityStatus: 'busy', activityStatusSince: null });

    session.activityStatus = 'checking_agents';
    session.activityStatusSince = 2345;
    app._onSessionTerminal({ id: 's1', data: 'output' });
    expect(session).toMatchObject({ activityStatus: 'busy', activityStatusSince: null });
    expect(session).not.toHaveProperty('data');

    session.activityStatus = 'waiting_agents';
    session.activityStatusSince = 3456;
    app._onSessionExit({ id: 's1', code: 0 });
    expect(session).toMatchObject({ status: 'stopped', activityStatus: 'stopped', activityStatusSince: null });
    expect(session).not.toHaveProperty('code');
  });

  it('ignores an incremental activity event for an unknown session', () => {
    const app = makeActivityEventApp();

    app._onSessionTerminal({ id: 'missing', data: 'late output' });

    expect(app.sessions.has('missing')).toBe(false);
    expect(app.renderSessionTabs).not.toHaveBeenCalled();
    expect(app.renderMuxSessions).not.toHaveBeenCalled();
  });

  it('ignores an unknown activity-only update until a full create snapshot arrives', () => {
    const app = makeActivityEventApp();

    app._onSessionUpdated({ id: 'late', activityStatus: 'waiting_agents', activityStatusSince: 1234 });

    expect(app.sessions.has('late')).toBe(false);
    expect(app.renderSessionTabs).not.toHaveBeenCalled();
    expect(app.renderMuxSessions).not.toHaveBeenCalled();

    app._onSessionCreated({ id: 'late', name: 'Late arrival', status: 'idle' });

    expect(app.sessions.get('late')).toMatchObject({ id: 'late', name: 'Late arrival', status: 'idle' });
  });

  it.each([
    ['parked', '_onSessionParked', 'parked'],
    ['resumed', '_onSessionResumed', 'active'],
    ['restored restart', '_onSessionRestarted', 'busy'],
    ['crash-loop restart', '_onSessionRestarted', 'busy'],
  ])('%s clears stale derived activity and its idle timer', (_label, handler, status) => {
    vi.useFakeTimers();
    const app = makeActivityEventApp();
    const session = app.sessions.get('s1');
    session.activityStatus = 'waiting_agents';
    session.activityStatusSince = 1234;
    app.idleTimers.set(
      's1',
      setTimeout(() => {}, 60_000)
    );

    app[handler]({ id: 's1' });

    expect(session).toMatchObject({ status, activityStatus: status, activityStatusSince: null });
    expect(app.idleTimers.has('s1')).toBe(false);
    expect(app.renderSessionTabs).toHaveBeenCalled();
    expect(app.renderMuxSessions).toHaveBeenCalled();
  });

  it('hydrates an unknown full session:updated snapshot while ignoring narrow lifecycle-shaped updates', () => {
    const app = makeActivityEventApp();

    app._onSessionUpdated({ id: 'full', status: 'idle', activityStatus: 'waiting_agents' });
    expect(app.sessions.has('full')).toBe(false);

    app._onSessionUpdated({
      id: 'full',
      pid: null,
      status: 'idle',
      workingDir: '/tmp/full',
      currentTaskId: null,
      createdAt: 100,
      lastActivityAt: 200,
      activityStatus: 'waiting_agents',
      activityStatusSince: 150,
    });

    expect(app.sessions.get('full')).toMatchObject({
      workingDir: '/tmp/full',
      status: 'idle',
      activityStatus: 'waiting_agents',
    });
    expect(app.renderSessionTabs).toHaveBeenCalled();
    expect(app.renderMuxSessions).toHaveBeenCalled();
  });

  it('reconnect hydration replaces stale activity and clears fields omitted by a legacy snapshot', () => {
    const app = makeInitApp();
    app.sessions.get('s1').activityStatus = 'waiting_agents';
    app.sessions.get('s1').activityStatusSince = 1234;

    app.handleInit({
      ...initData,
      sessions: initData.sessions.map((session) =>
        session.id === 's2'
          ? { ...session, activityStatus: 'checking_agents', activityStatusSince: 5678 }
          : { ...session }
      ),
    });

    expect(app.sessions.get('s1')).not.toHaveProperty('activityStatus');
    expect(app.sessions.get('s1')).not.toHaveProperty('activityStatusSince');
    expect(app.sessions.get('s2')).toMatchObject({ activityStatus: 'checking_agents', activityStatusSince: 5678 });
    app._tabLayoutCoordinator?.dispose();
  });
});

beforeEach(() => {
  (globalThis as any).CSS = { escape: (value: string) => value };
  delete (window as any).__codemanUser;
  document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
  document.body.innerHTML = '';
  localStorage.removeItem('codeman:tab-groups-collapsed');
});

afterEach(() => {
  Object.defineProperty(window, 'localStorage', localStorageDescriptor);
  vi.useRealTimers();
});
