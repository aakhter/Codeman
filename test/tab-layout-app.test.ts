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

describe('COD-306 CodemanApp integration', () => {
  it('keeps a session selection authoritative over a pending webview response', async () => {
    const app = makeApp();
    const pending = deferred<any>();
    app.activeSessionId = 's1';
    app.activeWebviewId = null;
    app.webviewOrder = [];
    app._apiJson = vi.fn(() => pending.promise);
    app._mountWebviewFrame = vi.fn();
    app.renderSessionTabs = vi.fn();

    const opening = app.openWebview('w1');
    await app.selectSession('s1');
    pending.resolve({ webview: app.webviews.get('w1'), embedUrl: '/webview/a/' });
    await opening;

    expect(app.activeSessionId).toBe('s1');
    expect(app.activeWebviewId).toBeNull();
    expect(app._mountWebviewFrame).not.toHaveBeenCalled();
  });

  it('defers the rail render scheduler while first layout paint is pending', () => {
    const app = makeApp();
    app._tabLayoutFirstPaintPending = true;
    app.updateFileBrowserHeaderButton = vi.fn();
    app._debouncedCall = vi.fn();
    app.renderSessionTabs();
    expect(app._debouncedCall).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.session-tab')).toHaveLength(0);
  });

  it('does not append Map-order session creations while first layout paint is pending', () => {
    const app = makeApp();
    app.sessions = new Map();
    app.sessionOrder = [];
    app._tabLayoutFirstPaintPending = true;
    app.updateAttachmentHistoryCountFromSession = vi.fn();
    app.saveSessionOrder = vi.fn();
    app.renderSessionTabs = vi.fn();
    app.updateCost = vi.fn();
    app.renderMuxSessions = vi.fn();
    app.startSystemStatsPolling = vi.fn();

    app._onSessionCreated({ id: 'created-during-load', status: 'idle' });

    expect(app.sessions.has('created-during-load')).toBe(true);
    expect(app.sessionOrder).toEqual([]);
    expect(app.saveSessionOrder).not.toHaveBeenCalled();
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

  it('collapses from the header, persists locally, and redraws geometry', () => {
    const app = makeApp();
    app.updateConnectionLines = vi.fn();
    app._fullRenderSessionTabs();
    const header = document.querySelector<HTMLElement>('[data-tab-group-header="group-x"]')!;
    app.toggleTabGroupCollapsed(header.dataset.tabGroupHeader);

    expect(app.collapsedTabGroupIds).toEqual(new Set(['group-x']));
    expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('["group-x"]');
    expect(document.querySelector('[data-tab-group-header="group-x"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(app.updateConnectionLines).toHaveBeenCalled();
  });

  it('selects a hidden next session without expanding and swaps the lone shown member', () => {
    const app = makeApp();
    app.activeWebviewId = null;
    app.activeSessionId = 's2';
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._fullRenderSessionTabs();
    expect([...document.querySelectorAll<HTMLElement>('.session-tab')].map((tab) => tab.dataset.id)).toEqual([
      's2',
      's3',
    ]);

    app.selectSession = vi.fn((id: string) => {
      app.activeSessionId = id;
      app.activeWebviewId = null;
      app._renderSessionTabsImmediate();
    });
    app.nextSession();

    expect(app.selectSession).toHaveBeenCalledWith('s1');
    expect(app.collapsedTabGroupIds).toEqual(new Set(['group-x']));
    const tabs = [...document.querySelectorAll<HTMLElement>('.session-tab')];
    expect(tabs.map((tab) => tab.dataset.id)).toEqual(['s1', 's3']);
    expect(tabs.map((tab) => tab.querySelector('.tab-number')?.textContent)).toEqual(['1', '2']);
  });

  it('selects a hidden previous session without expanding and renumbers visible badges', () => {
    const app = makeApp();
    app.activeWebviewId = null;
    app.activeSessionId = 's1';
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._fullRenderSessionTabs();
    expect([...document.querySelectorAll<HTMLElement>('.session-tab')].map((tab) => tab.dataset.id)).toEqual([
      's1',
      's3',
    ]);

    app.selectSession = vi.fn((id: string) => {
      app.activeSessionId = id;
      app.activeWebviewId = null;
      app._renderSessionTabsImmediate();
    });
    app.prevSession();

    expect(app.selectSession).toHaveBeenCalledWith('s2');
    expect(app.collapsedTabGroupIds).toEqual(new Set(['group-x']));
    const tabs = [...document.querySelectorAll<HTMLElement>('.session-tab')];
    expect(tabs.map((tab) => tab.dataset.id)).toEqual(['s2', 's3']);
    expect(tabs.map((tab) => tab.querySelector('.tab-number')?.textContent)).toEqual(['1', '2']);
  });

  it('expands every group when persisting collapse fails', () => {
    const app = makeApp();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    app.toggleTabGroupCollapsed('group-x', true);
    expect(app.collapsedTabGroupIds.size).toBe(0);
    expect(app._tabCollapseStorageFailed).toBe(true);
    setItem.mockRestore();

    app._applyTabLayout(layout);
    expect(app.collapsedTabGroupIds.size).toBe(0);
  });

  it('falls back to all-expanded when either collapse storage record is malformed', () => {
    const app = makeApp();
    localStorage.setItem('codeman:tab-groups-collapsed', JSON.stringify(['group-x']));
    localStorage.setItem('codeman:focus-group-collapsed', 'invalid');

    app._applyTabLayout({
      ...layout,
      version: 9,
      groups: [
        {
          ...layout.groups[0],
          refs: layout.groups[0].refs.map((ref) => (ref.id === 's2' ? { ...ref, focus: true } : ref)),
        },
      ],
    });

    expect(app._tabCollapseStorageFailed).toBe(true);
    expect(app.collapsedTabGroupIds.size).toBe(0);
    expect(app.focusTabGroupCollapsed).toBe(false);
  });

  it('adopts and renders grouped layout when acquiring localStorage throws', () => {
    const app = makeApp();
    const getter = vi.fn(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: getter });

    expect(() => app._applyTabLayout({ ...layout, version: 9 })).not.toThrow();
    expect(app.tabLayoutVersion).toBe(9);
    expect(app.tabLayoutReadOnly).toBe(false);
    expect(app._tabCollapseStorageFailed).toBe(true);
    expect(app.collapsedTabGroupIds.size).toBe(0);
    expect(document.querySelectorAll('.tab-layout-group')).toHaveLength(2);

    expect(() => app._applyTabLayout({ ...layout, version: 10 })).not.toThrow();
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('keeps toggle all-expanded and does not reacquire storage after getter failure', () => {
    const app = makeApp();
    const getter = vi.fn(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    Object.defineProperty(window, 'localStorage', { configurable: true, get: getter });

    expect(() => app.toggleTabGroupCollapsed('group-x', true)).not.toThrow();
    expect(app._tabCollapseStorageFailed).toBe(true);
    expect(app.collapsedTabGroupIds.size).toBe(0);
    expect(document.querySelector('[data-tab-group-header="group-x"]')?.getAttribute('aria-expanded')).toBe('true');

    expect(() => app.toggleTabGroupCollapsed('group-x', true)).not.toThrow();
    expect(getter).toHaveBeenCalledTimes(1);
  });

  it('proxies a collapse-hidden lineage endpoint to the group header', () => {
    const app = makeApp();
    app.activeWebviewId = null;
    app.activeSessionId = 's3';
    app.sessions.get('s3').status = 'working';
    app.sessions.get('s3').parentSessionId = 's2';
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._lineageLinesEnabled = () => true;
    app._fullRenderSessionTabs();

    const strip = document.getElementById('sessionTabs') as HTMLElement;
    const header = document.querySelector<HTMLElement>('[data-tab-group-header="group-x"]')!;
    const child = document.querySelector<HTMLElement>('[data-id="s3"]')!;
    strip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 320, height: 320 }) as DOMRect;
    header.getBoundingClientRect = () => ({ left: 32, top: 20, width: 260, height: 36 }) as DOMRect;
    child.getBoundingClientRect = () => ({ left: 32, top: 180, width: 260, height: 40 }) as DOMRect;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    app._appendLineageConnectionLines(svg, new Map());

    const line = svg.querySelector('.lineage-line');
    expect(line?.classList.contains('lineage-line--proxied')).toBe(true);
    expect(line?.getAttribute('data-parent-tab')).toBe('s2');
    const dot = svg.querySelector('.lineage-line-dot');
    expect(dot?.classList.contains('lineage-line-dot--proxied')).toBe(true);
    expect(dot?.classList.contains('lineage-line-dot--working')).toBe(true);
  });

  it('suppresses lineage when both collapse-hidden endpoints share a header', () => {
    const app = makeApp();
    app.activeWebviewId = null;
    app.activeSessionId = 's3';
    app.sessions.get('s1').parentSessionId = 's2';
    app.collapsedTabGroupIds = new Set(['group-x']);
    app._lineageLinesEnabled = () => true;
    app._fullRenderSessionTabs();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');

    app._appendLineageConnectionLines(svg, new Map());

    expect(svg.querySelectorAll('.lineage-line')).toHaveLength(0);
    expect(app._lineageEdgeCount).toBe(0);
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

  it('sequences concurrent app loads', async () => {
    const app = makeApp();
    const pending: Array<(value: unknown) => void> = [];
    app._fetchTabLayout = () => new Promise((resolve) => pending.push(resolve));
    app._applyTabLayout = vi.fn();
    app._applyTabLayoutFallback = vi.fn();
    app._tabLayoutCoordinator = null;
    const first = app._loadTabLayout();
    const second = app._loadTabLayout();
    const placements = [{ kind: 'session', id: 's1', state: 'manual', parentId: 's2', canFollow: true }];
    pending[1]({ layout: { ...layout, version: 10 }, placements });
    await second;
    pending[0]({ layout: { ...layout, version: 9 }, placements: [] });
    await first;
    expect(app._applyTabLayout).toHaveBeenCalledTimes(1);
    expect(app._applyTabLayout).toHaveBeenCalledWith({ ...layout, version: 10 }, placements);

    app._tabLayoutCoordinator.dispose();
  });

  it('adopts an inline owner layout without refetching', () => {
    const app = makeApp();
    const inlineLayout = { ...layout, version: 11 };
    app._applyTabLayout = vi.fn();
    app._loadTabLayout = vi.fn();
    (window as any).__codemanUser = { multiUser: true, username: 'alice', role: 'admin' };

    app._onTabLayoutChanged({ owner: 'alice', version: 11, layout: inlineLayout });

    expect(app._applyTabLayout).toHaveBeenCalledWith(inlineLayout);
    expect(app._loadTabLayout).not.toHaveBeenCalled();
  });

  it('rebases a pending semantic edit through inline layout adoption', () => {
    const app = makeApp();
    const inlineLayout = { ...layout, version: 11 };
    const adoptExternal = vi.fn();
    app._tabLayoutEditCoordinator = { hasPending: () => true, adoptExternal };
    app._loadTabLayout = vi.fn();
    (window as any).__codemanUser = { multiUser: true, username: 'alice', role: 'admin' };

    app._onTabLayoutChanged({ owner: 'alice', version: 11, layout: inlineLayout });

    expect(adoptExternal).toHaveBeenCalledWith(inlineLayout, { placements: undefined });
    expect(app._tabLayoutSsePending).not.toBe(true);
    expect(app._loadTabLayout).not.toHaveBeenCalled();
  });

  it('ignores foreign-owner inline layouts', () => {
    const app = makeApp();
    app._applyTabLayout = vi.fn();
    app._loadTabLayout = vi.fn();
    (window as any).__codemanUser = { multiUser: true, username: 'alice', role: 'admin' };

    app._onTabLayoutChanged({ owner: 'bob', version: 11, layout: { ...layout, version: 11 } });

    expect(app._applyTabLayout).not.toHaveBeenCalled();
    expect(app._loadTabLayout).not.toHaveBeenCalled();
  });

  it('keeps GET fallback behavior for layout-change payloads without inline layouts', () => {
    const app = makeApp();
    app._loadTabLayout = vi.fn();

    app._onTabLayoutChanged();
    expect(app._loadTabLayout).toHaveBeenCalledOnce();

    app._tabLayoutEditCoordinator = { hasPending: () => true };
    app._onTabLayoutChanged({ version: 11 });
    expect(app._tabLayoutSsePending).toBe(true);
    expect(app._loadTabLayout).toHaveBeenCalledOnce();
  });

  it('waits for the authoritative initial layout before selecting its first session', async () => {
    const app = makeInitApp();
    const request = deferred<any>();
    app._fetchTabLayout = () => request.promise;

    app.handleInit(initData);
    app.sessions.get('s1').parentSessionId = 's2';
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.sessionOrder).toEqual([]);
    expect(app._activateVisibleTabNumber(1)).toBe(false);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app._collectLineageEdges()).toEqual([]);

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
    // `{ auto: true }`: the BOOT RESTORE is an app-made selection, so it must
    // not spend that session's pending idle alert (upstream 1.19.4). Pinned
    // explicitly rather than loosened — restore silently becoming user-initiated
    // is exactly the regression that flag exists to prevent.
    expect(app.selectSession).toHaveBeenCalledWith('s3', { auto: true });
    app.cases = [];
    app.pendingHooks = new Map();
    app._buildCommandPaletteNewSessionItem = () => ({ id: 'new', type: 'new-session' });
    expect(
      app
        .buildCommandPaletteItems()
        .filter((item: any) => item.type === 'session')
        .map((item: any) => item.sessionId)
    ).toEqual(['s3', 's2', 's1']);
    expect(app.buildHomeSessionRows().map((row: any) => row.id)).toEqual(['s3', 's2', 's1']);
    expect(
      app
        .buildMobileOverviewModel({
          sessions: app.sessions,
          cases: [],
          sessionOrder: app.sessionOrder,
          layoutPending: app._tabLayoutFirstPaintPending,
        })
        .current.map((row: any) => row.id)
    ).toEqual(['s3', 's2', 's1']);
    expect(app._collectLineageEdges().map((edge: any) => edge.childId)).toEqual(['s1']);
    app._tabLayoutCoordinator.dispose();
  });

  it('does not steal a session selected while reconnect layout loading is delayed', async () => {
    const app = makeInitApp();
    const request = deferred<any>();
    app._tabLayoutFirstPaintPending = false;
    app.activeSessionId = 's1';
    app._selectGeneration = 4;
    app._fetchTabLayout = () => request.promise;
    app.selectSession.mockImplementation((id: string) => {
      app._selectGeneration++;
      app.activeSessionId = id;
      app.activeWebviewId = null;
    });

    app.handleInit(initData);
    app.selectSession('s2');
    request.resolve(layout);
    await request.promise;
    await vi.waitFor(() => expect(app.sessionOrder).toEqual(['s2', 's1', 's3']));

    expect(app.activeSessionId).toBe('s2');
    expect(app.selectSession).toHaveBeenCalledTimes(1);
    expect(app.selectSession).toHaveBeenCalledWith('s2');
    app._tabLayoutCoordinator.dispose();
  });

  it('does not steal a webview activated while reconnect layout loading is delayed', async () => {
    const app = makeInitApp();
    const request = deferred<any>();
    app._tabLayoutFirstPaintPending = false;
    app.activeSessionId = 's1';
    app._selectGeneration = 4;
    app._fetchTabLayout = () => request.promise;
    app.openWebview = vi.fn((id: string) => {
      app.activeWebviewId = id;
    });

    app.handleInit(initData);
    app.openWebview('w1');
    request.resolve(layout);
    await request.promise;
    await vi.waitFor(() => expect(app.sessionOrder).toEqual(['s2', 's1', 's3']));
    await Promise.resolve();

    expect(app.activeSessionId).toBe('s1');
    expect(app.activeWebviewId).toBe('w1');
    expect(app.selectSession).not.toHaveBeenCalled();
    app._tabLayoutCoordinator.dispose();
  });

  it('preserves an existing active webview and its background session after reconnect success', async () => {
    const app = makeInitApp();
    const request = deferred<any>();
    app._tabLayoutFirstPaintPending = false;
    app.activeSessionId = 's1';
    app.activeWebviewId = 'w1';
    app._fetchTabLayout = () => request.promise;

    app.handleInit(initData);
    request.resolve(layout);
    await request.promise;
    await vi.waitFor(() => expect(app.sessionOrder).toEqual(['s2', 's1', 's3']));
    await Promise.resolve();

    expect(app.activeSessionId).toBe('s1');
    expect(app.activeWebviewId).toBe('w1');
    expect(app.selectSession).not.toHaveBeenCalled();
    app._tabLayoutCoordinator.dispose();
  });

  it('preserves an existing active webview without a background session after reconnect fallback', async () => {
    vi.useFakeTimers();
    const app = makeInitApp();
    const request = deferred<any>();
    app._tabLayoutFirstPaintPending = false;
    app.activeSessionId = null;
    app.activeWebviewId = 'w1';
    app._fetchTabLayout = () => request.promise;

    app.handleInit(initData);
    request.reject(new Error('offline'));
    await request.promise.catch(() => undefined);
    await Promise.resolve();

    expect(app.tabLayoutReadOnly).toBe(true);
    expect(app.activeSessionId).toBeNull();
    expect(app.activeWebviewId).toBe('w1');
    expect(app.selectSession).not.toHaveBeenCalled();
    app._tabLayoutCoordinator.dispose();
  });

  it('refreshes an open pending command palette after authoritative layout adoption', async () => {
    const app = makeApp();
    const request = deferred<any>();
    app._tabLayoutFirstPaintPending = true;
    app.sessionOrder = [];
    app._fetchTabLayout = () => request.promise;
    app._tabLayoutCoordinator = null;
    const search = openPendingPalette(app);
    const load = app._loadTabLayout();

    expect(app.commandPaletteItems.filter((item: any) => item.type === 'session')).toEqual([]);
    request.resolve(layout);
    await load;

    expect(search.value).toBe('o');
    expect(
      app.commandPaletteItems.filter((item: any) => item.type === 'session').map((item: any) => item.sessionId)
    ).toEqual(['s2', 's1']);
    expect(
      [...document.querySelectorAll('#commandPaletteList .command-palette-title')].map((el) => el.textContent)
    ).toEqual(['Two', 'One', 'New session', 'Browse all sessions…']);
    app._tabLayoutCoordinator.dispose();
  });

  it('refreshes an open pending command palette after read-only fallback adoption', async () => {
    vi.useFakeTimers();
    const app = makeApp();
    const request = deferred<any>();
    app._tabLayoutFirstPaintPending = true;
    app.sessionOrder = [];
    app._fetchTabLayout = () => request.promise;
    app._tabLayoutCoordinator = null;
    const search = openPendingPalette(app);
    const load = app._loadTabLayout();

    expect(app.commandPaletteItems.filter((item: any) => item.type === 'session')).toEqual([]);
    request.reject(new Error('offline'));
    await load;

    expect(search.value).toBe('o');
    expect(
      app.commandPaletteItems.filter((item: any) => item.type === 'session').map((item: any) => item.sessionId)
    ).toEqual(['s1', 's2']);
    expect(
      [...document.querySelectorAll('#commandPaletteList .command-palette-title')].map((el) => el.textContent)
    ).toEqual(['One', 'Two', 'New session', 'Browse all sessions…']);
    app._tabLayoutCoordinator.dispose();
  });

  it('selects the legacy-first session only after the initial layout GET fails', async () => {
    vi.useFakeTimers();
    const app = makeInitApp();
    const request = deferred<any>();
    app._fetchTabLayout = () => request.promise;
    app._refreshHomeSessionsIfVisible = vi.fn();
    app._refreshMobileOverviewIfVisible = vi.fn();

    app.handleInit(initData);
    expect(app.selectSession).not.toHaveBeenCalled();
    request.reject(new Error('offline'));
    await request.promise.catch(() => undefined);
    await Promise.resolve();

    expect(app.tabLayoutReadOnly).toBe(true);
    expect(app.selectSession).toHaveBeenCalledOnce();
    // `{ auto: true }`: the BOOT RESTORE is an app-made selection, so it must
    // not spend that session's pending idle alert (upstream 1.19.4). Pinned
    // explicitly rather than loosened — restore silently becoming user-initiated
    // is exactly the regression that flag exists to prevent.
    expect(app.selectSession).toHaveBeenCalledWith('s1', { auto: true });
    app.cases = [];
    app.pendingHooks = new Map();
    app._buildCommandPaletteNewSessionItem = () => ({ id: 'new', type: 'new-session' });
    expect(
      app
        .buildCommandPaletteItems()
        .filter((item: any) => item.type === 'session')
        .map((item: any) => item.sessionId)
    ).toEqual(['s1', 's2', 's3']);
    expect(app.buildHomeSessionRows().map((row: any) => row.id)).toEqual(['s1', 's2', 's3']);
    expect(
      app
        .buildMobileOverviewModel({
          sessions: app.sessions,
          cases: [],
          sessionOrder: app.sessionOrder,
          layoutPending: app._tabLayoutFirstPaintPending,
        })
        .current.map((row: any) => row.id)
    ).toEqual(['s1', 's2', 's3']);
    expect(app._refreshHomeSessionsIfVisible).toHaveBeenCalledOnce();
    expect(app._refreshMobileOverviewIfVisible).toHaveBeenCalledOnce();
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
    // `{ auto: true }`: the BOOT RESTORE is an app-made selection, so it must
    // not spend that session's pending idle alert (upstream 1.19.4). Pinned
    // explicitly rather than loosened — restore silently becoming user-initiated
    // is exactly the regression that flag exists to prevent.
    expect(app.selectSession).toHaveBeenCalledWith('s2', { auto: true });
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
