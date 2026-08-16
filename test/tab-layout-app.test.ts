// @vitest-environment jsdom
/** @fileoverview COD-306 integration coverage over the shipping browser controller and DOM. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
let CodemanApp: { prototype: Record<string, any> };

beforeAll(() => {
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
  app._legacySessionOrder = ['s1', 's2', 's3'];
  app._tabLayoutFirstPaintPending = false;
  app._lastTabStructureKey = null;
  app._inlineRenameActive = false;
  app._tabLayoutManaged = true;
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

const initData = {
  sessions: [
    { id: 's1', name: 'One', status: 'idle' },
    { id: 's2', name: 'Two', status: 'idle' },
    { id: 's3', name: 'Three', status: 'idle' },
  ],
  sessionOrder: ['s1', 's2', 's3'],
  scheduledRuns: [],
};

beforeEach(() => {
  document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
  document.body.innerHTML = '';
});

afterEach(() => vi.useRealTimers());

describe('COD-306 CodemanApp integration', () => {
  it('defers the rail render scheduler while first layout paint is pending', () => {
    const app = makeApp();
    app._tabLayoutFirstPaintPending = true;
    app.updateFileBrowserHeaderButton = vi.fn();
    app._debouncedCall = vi.fn();
    app.renderSessionTabs();
    expect(app._debouncedCall).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.session-tab')).toHaveLength(0);
  });

  it('renders escaped vertical groups, interleaved badges, exclusive active identity, and no duplicate DOM', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    expect([...document.querySelectorAll('.tab-layout-group-name')].map((el) => el.textContent)).toEqual([
      '<Core & Ops>',
      'Ungrouped',
    ]);
    expect(document.querySelectorAll('.tab-layout-group-name img')).toHaveLength(0);
    const tabs = [...document.querySelectorAll<HTMLElement>('.session-tab')];
    expect(tabs.map((tab) => tab.dataset.webviewId || tab.dataset.id)).toEqual(['s2', 'w1', 's1', 's3']);
    expect(tabs.map((tab) => tab.querySelector('.tab-number')?.textContent)).toEqual(['1', '2', '3', '4']);
    expect(document.querySelectorAll('.session-tab.active')).toHaveLength(1);
    expect(document.querySelector('.session-tab.active')?.getAttribute('data-webview-id')).toBe('w1');
    expect(document.querySelectorAll('[data-webview-id="closed"]')).toHaveLength(0);
  });

  it('activates Alt-number refs through the app as session or webview', () => {
    const app = makeApp();
    app.selectSession = vi.fn();
    app.openWebview = vi.fn();
    expect(app._activateVisibleTabNumber(1)).toBe(true);
    expect(app.selectSession).toHaveBeenCalledWith('s2');
    expect(app._activateVisibleTabNumber(2)).toBe(true);
    expect(app.openWebview).toHaveBeenCalledWith('w1');
  });

  it('invalidates structural DOM when orientation changes', () => {
    const app = makeApp();
    app._fullRenderSessionTabs();
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(2);
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._renderSessionTabsImmediate();
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    expect(
      [...document.querySelectorAll<HTMLElement>('.session-tab')].map((tab) => tab.dataset.webviewId || tab.dataset.id)
    ).toEqual(['s2', 'w1', 's1', 's3']);
  });

  it('renders phone mode flat with grouped-then-ungrouped order', () => {
    const app = makeApp();
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._fullRenderSessionTabs();
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    expect(
      [...document.querySelectorAll<HTMLElement>('.session-tab')].map((tab) => tab.dataset.webviewId || tab.dataset.id)
    ).toEqual(['s2', 'w1', 's1', 's3']);
  });

  it('paints vertical failure as read-only legacy flat, schedules retry, then adopts success', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    app._fullRenderSessionTabs();
    let attempt = 0;
    app._fetchTabLayout = vi.fn(async () => {
      attempt++;
      if (attempt === 1) throw new Error('offline');
      return { ...layout, version: 12 };
    });
    app._tabLayoutCoordinator = null;

    await app._loadTabLayout();
    expect(app.tabLayout).toBeNull();
    expect(app.tabLayoutReadOnly).toBe(true);
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(0);
    const fallbackTabs = [...document.querySelectorAll<HTMLElement>('.session-tab')];
    expect(fallbackTabs.map((tab) => tab.dataset.webviewId || tab.dataset.id)).toEqual(['s1', 's2', 's3', 'w1']);
    expect(fallbackTabs.map((tab) => tab.querySelector('.tab-number')?.textContent)).toEqual(['1', '2', '3', '4']);

    await vi.advanceTimersByTimeAsync(2000);
    expect(app._fetchTabLayout).toHaveBeenCalledTimes(2);
    expect(app.tabLayoutVersion).toBe(12);
    expect(app.tabLayoutReadOnly).toBe(false);
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(2);
    app._tabLayoutCoordinator.dispose();
  });

  it('refreshes visible home/mobile consumers when an adopted projection reorders sessions', () => {
    const app = makeApp();
    const home = document.createElement('div');
    home.id = 'homeSessions';
    home.hidden = false;
    const mobile = document.createElement('div');
    mobile.id = 'mobileOverview';
    mobile.classList.add('visible');
    document.body.append(home, mobile);
    app.renderHomeSessions = vi.fn();
    app.renderMobileOverview = vi.fn();
    app._debouncedCall = (_key: string, fn: () => void) => fn();
    app._applyTabLayout({
      ...layout,
      version: 9,
      groups: [{ id: 'reordered', name: 'Reordered', refs: [{ kind: 'session', id: 's3' }] }],
      ungrouped: [
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's2' },
      ],
    });
    expect(app.sessionOrder).toEqual(['s3', 's1', 's2']);
    expect(app.renderHomeSessions).toHaveBeenCalledOnce();
    expect(app.renderMobileOverview).toHaveBeenCalledOnce();
  });

  it('feeds complete projected session order to palette, switching, cleanup, and lineage consumers', () => {
    const app = makeApp();
    app.activeWebviewId = null;
    app.activeSessionId = 's2';
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._refreshTabProjection();
    expect(app.sessionOrder).toEqual(['s2', 's1', 's3']);

    app.cases = [];
    app._buildCommandPaletteNewSessionItem = () => ({ id: 'new', type: 'new-session' });
    expect(
      app
        .buildCommandPaletteItems()
        .filter((item: any) => item.type === 'session')
        .map((item: any) => item.sessionId)
    ).toEqual(['s2', 's1', 's3']);

    app.selectSession = vi.fn();
    app.nextSession();
    expect(app.selectSession).toHaveBeenCalledWith('s1');

    app.sessions.get('s1').parentSessionId = 's2';
    app.sessions.get('s3').parentSessionId = 's2';
    expect(app._collectLineageEdges().map((edge: any) => edge.childId)).toEqual(['s1', 's3']);

    app.terminalBuffers = new Map();
    app.terminalBufferCache = new Map();
    app.projectInsights = new Map();
    app.pendingHooks = new Map();
    app.tabAlerts = new Map();
    app.attachmentHistoryCounts = new Map();
    app.terminalLoadStates = new Map();
    app.idleTimers = new Map();
    app.ralphStates = new Map();
    app.ralphClosedSessions = new Set();
    app.respawnStatus = {};
    app.respawnTimers = {};
    app.respawnCountdownTimers = {};
    app.respawnActionLogs = {};
    app._clearHistoryTruncation = () => {};
    app._persistReliableState = () => {};
    app.clearCountdownTimers = () => {};
    app.closeSessionLogViewerWindows = () => {};
    app.closeSessionImagePopups = () => {};
    app.closeSessionAttachmentCards = () => {};
    app.closeSessionSubagentWindows = () => {};
    app.saveSessionOrder = () => {};
    app._cleanupSessionData('s1');
    expect(app.sessionOrder).toEqual(['s2', 's3']);
  });

  it('sequences concurrent app loads and routes layout-change invalidation through refetch', async () => {
    const app = makeApp();
    const pending: Array<(value: unknown) => void> = [];
    app._fetchTabLayout = () => new Promise((resolve) => pending.push(resolve));
    app._applyTabLayout = vi.fn();
    app._applyTabLayoutFallback = vi.fn();
    app._tabLayoutCoordinator = null;
    const first = app._loadTabLayout();
    const second = app._loadTabLayout();
    pending[1]({ ...layout, version: 10 });
    await second;
    pending[0]({ ...layout, version: 9 });
    await first;
    expect(app._applyTabLayout).toHaveBeenCalledTimes(1);
    expect(app._applyTabLayout).toHaveBeenCalledWith({ ...layout, version: 10 });

    app._loadTabLayout = vi.fn();
    app._onTabLayoutChanged();
    expect(app._loadTabLayout).toHaveBeenCalledOnce();
    app._tabLayoutCoordinator.dispose();
  });

  it('waits for the authoritative initial layout before selecting its first session', async () => {
    const app = makeInitApp();
    const request = deferred<any>();
    app._fetchTabLayout = () => request.promise;

    app.handleInit(initData);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.sessionOrder).toEqual([]);
    expect(app._activateVisibleTabNumber(1)).toBe(false);
    expect(app.selectSession).not.toHaveBeenCalled();

    request.resolve({
      ...layout,
      groups: [{ id: 'authoritative', name: 'Owner', refs: [{ kind: 'session', id: 's3' }] }],
      ungrouped: [
        { kind: 'session', id: 's2' },
        { kind: 'session', id: 's1' },
      ],
    });
    await request.promise;
    await vi.waitFor(() => expect(app.selectSession).toHaveBeenCalledOnce());

    expect(app.sessionOrder).toEqual(['s3', 's2', 's1']);
    expect(app.selectSession).toHaveBeenCalledWith('s3');
    app._tabLayoutCoordinator.dispose();
  });

  it('selects the legacy-first session only after the initial layout GET fails', async () => {
    vi.useFakeTimers();
    const app = makeInitApp();
    const request = deferred<any>();
    app._fetchTabLayout = () => request.promise;

    app.handleInit(initData);
    expect(app.selectSession).not.toHaveBeenCalled();
    request.reject(new Error('offline'));
    await request.promise.catch(() => undefined);
    await Promise.resolve();

    expect(app.tabLayoutReadOnly).toBe(true);
    expect(app.selectSession).toHaveBeenCalledOnce();
    expect(app.selectSession).toHaveBeenCalledWith('s1');
    app._tabLayoutCoordinator.dispose();
  });

  it('does not let an overlapping stale init select a session', async () => {
    const app = makeInitApp();
    const requests = [deferred<any>(), deferred<any>()];
    app._fetchTabLayout = vi.fn().mockReturnValueOnce(requests[0].promise).mockReturnValueOnce(requests[1].promise);

    app.handleInit(initData);
    app.handleInit(initData);
    requests[0].resolve(layout);
    await requests[0].promise;
    await Promise.resolve();
    expect(app.selectSession).not.toHaveBeenCalled();

    requests[1].resolve({
      ...layout,
      version: 9,
      groups: [{ id: 'newest', name: 'Newest', refs: [{ kind: 'session', id: 's2' }] }],
      ungrouped: [
        { kind: 'session', id: 's1' },
        { kind: 'session', id: 's3' },
      ],
    });
    await requests[1].promise;
    await vi.waitFor(() => expect(app.selectSession).toHaveBeenCalledOnce());
    expect(app.selectSession).toHaveBeenCalledWith('s2');
    app._tabLayoutCoordinator.dispose();
  });

  it('keeps the layout coordinator live across BFCache pagehide', async () => {
    const app = makeApp();
    app._fetchTabLayout = vi.fn(async () => layout);
    app._tabLayoutCoordinator = null;
    app._ensureTabLayoutCoordinator();
    const pagehide = new Event('pagehide');
    Object.defineProperty(pagehide, 'persisted', { value: true });
    window.dispatchEvent(pagehide);

    expect(await app._loadTabLayout()).toBe(true);
    expect(app._fetchTabLayout).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event('pagehide'));
  });

  it('disposes and cancels retries on an ordinary pagehide', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    app._fetchTabLayout = vi.fn(async () => {
      throw new Error('offline');
    });
    app._tabLayoutCoordinator = null;

    await app._loadTabLayout();
    expect(app._fetchTabLayout).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(2000);

    expect(app._fetchTabLayout).toHaveBeenCalledOnce();
    expect(await app._loadTabLayout()).toBe(false);
  });

  it('invalidates an in-flight layout generation on an ordinary pagehide', async () => {
    const app = makeApp();
    const request = deferred<any>();
    app._fetchTabLayout = () => request.promise;
    app._applyTabLayout = vi.fn();
    app._tabLayoutCoordinator = null;

    const load = app._loadTabLayout();
    window.dispatchEvent(new Event('pagehide'));
    request.resolve(layout);

    expect(await load).toBe(false);
    expect(app._applyTabLayout).not.toHaveBeenCalled();
  });
});
