// @vitest-environment jsdom
/** @fileoverview COD-356 operation-count coverage for the measured session-tab render path. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
let CodemanApp: { prototype: Record<string, any> };

beforeAll(() => {
  const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
  const source =
    'var MobileDetection = { getDeviceType: () => "desktop" }, KeyboardHandler = {}, SwipeHandler = {}, ' +
    'VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
    read('constants.js') +
    '\n' +
    read('tab-layout-browser.js') +
    '\n' +
    read('app.js') +
    '\n' +
    read('terminal-ui.js') +
    '\n;globalThis.__Cod356RenderApp = CodemanApp;';
  const previousInterval = window.setInterval;
  const previousAnimationFrame = window.requestAnimationFrame;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
  (0, eval)(source);
  window.setInterval = previousInterval;
  window.requestAnimationFrame = previousAnimationFrame;
  CodemanApp = (globalThis as any).__Cod356RenderApp;
});

beforeEach(() => {
  document.documentElement.dataset.tabOrientation = 'horizontal';
  document.documentElement.dataset.sessionList = 'header';
  document.documentElement.dataset.sidebarDetail = 'simple';
  document.body.innerHTML = '<header class="header"></header><div id="sessionTabs"></div>';
  (globalThis as any).CSS = { escape: (value: string) => value };
});

function makeApp() {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  const ids = Array.from({ length: 15 }, (_, index) => `render-session-${String(index + 1).padStart(2, '0')}`);
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map(
    ids.map((id, index) => [
      id,
      {
        id,
        name: `Render session ${index + 1}`,
        mode: 'shell',
        status: 'idle',
        workingDir: `/tmp/render-${index + 1}`,
        createdAt: 1_700_000_000_000 + index,
        lastActivityAt: 1_700_000_000_000 + index,
      },
    ])
  );
  app.sessionOrder = [...ids];
  app._legacySessionOrder = [...ids];
  app.webviews = new Map();
  app.webviewOrder = [];
  app.activeSessionId = ids[0];
  app.activeWebviewId = null;
  app.tabLayout = null;
  app.tabLayoutVersion = null;
  app.tabLayoutReadOnly = true;
  app.collapsedTabGroupIds = new Set();
  app.focusTabGroupCollapsed = false;
  app._tabLayoutFirstPaintPending = false;
  app._lastTabStructureKey = null;
  app._lastRenderedActiveTabIdentity = null;
  app._inlineRenameActive = false;
  app._tabLayoutManaged = false;
  app._deferredCreatedSessionIds = new Set();
  app._tabPlacementStates = new Map();
  app._tabFocusIdentity = null;
  app._tabPendingFollowRefs = new Set();
  app.detachedSessions = new Set();
  app.tabAlerts = new Map();
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.pendingHooks = new Map();
  app.idleTimers = new Map();
  app.respawnStatus = {};
  app._debounceTimers = {};
  app._sidebarFilter = '';
  app._lineageEdgeCount = 0;
  app.notificationManager = { preferences: { stuckThresholdMs: 60_000 } };
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => undefined;
  app.updateTabOverflowMode = vi.fn();
  app.updateConnectionLines = vi.fn();
  app.setupTabDragHandlers = vi.fn();
  app.setupTabKeyboardNavigation = vi.fn();
  app._applyTabEntrances = vi.fn();
  app._scrollActiveTabIntoView = vi.fn();
  app.applySidebarFilter = vi.fn();
  app.updateFileBrowserHeaderButton = vi.fn();
  app.renderMuxSessions = vi.fn();
  app.updateCost = vi.fn();
  app.updateAttachmentHistoryCountFromSession = vi.fn();
  app.updateSubagentParentNames = vi.fn();
  app.recheckOrphanSubagents = vi.fn();
  app._notifySession = vi.fn();
  app._refreshMobileOverviewIfVisible = vi.fn();
  app._refreshHomeSessionsIfVisible = vi.fn();
  app._refreshCommandPaletteIfOpen = vi.fn();
  return { app, ids };
}

describe('COD-356 frontend render budget', () => {
  it('rebuilds 15 session rows only for structure changes across switches, live updates, and a 100k-line replay', async () => {
    vi.useFakeTimers();
    const { app, ids } = makeApp();
    app._fullRenderSessionTabs();
    const initialTabs = new Map(
      ids.map((id: string) => [id, document.querySelector<HTMLElement>(`.session-tab[data-id="${id}"]`)])
    );
    expect([...initialTabs.values()].every(Boolean)).toBe(true);

    const originalFullRender = app._fullRenderSessionTabs.bind(app);
    const fullRender = vi.fn(() => originalFullRender());
    app._fullRenderSessionTabs = fullRender;

    for (const id of [ids[7], ids[14], ids[1], ids[0]]) {
      app.activeSessionId = id;
      app._updateActiveTabImmediate(id);
      app._renderSessionTabsImmediate();
      expect(document.querySelector(`.session-tab[data-id="${id}"]`)?.classList.contains('active')).toBe(true);
    }

    for (const [index, id] of [ids[3], ids[9], ids[12]].entries()) {
      const session = app.sessions.get(id);
      app._onSessionUpdated({
        session: {
          ...session,
          status: index % 2 === 0 ? 'busy' : 'idle',
          lastActivityAt: session.lastActivityAt + index + 1,
        },
      });
      await vi.advanceTimersByTimeAsync(101);
    }

    const terminalWrites: string[] = [];
    app._chunkedWriteGen = 0;
    app._bufferLoadSeq = 0;
    app._safeYield = (callback: () => void) => callback();
    app.pendingWrites = [];
    app.terminal = {
      write: (data: string, callback?: () => void) => {
        terminalWrites.push(data);
        callback?.();
      },
    };
    const replay = Array.from({ length: 100_000 }, (_, index) => `render-replay-${index}\r\n`).join('');
    expect(replay.match(/\n/g)).toHaveLength(100_000);
    await app.chunkedTerminalWrite(replay, 32 * 1024, 'cod356-render-budget');

    expect(terminalWrites.join('')).toBe(replay);
    expect(fullRender).not.toHaveBeenCalled();
    for (const [id, initialTab] of initialTabs) {
      expect(document.querySelector(`.session-tab[data-id="${id}"]`)).toBe(initialTab);
    }
    expect([...document.querySelectorAll<HTMLElement>('.session-tab')].map((tab) => tab.dataset.id)).toEqual(ids);
    expect(document.querySelectorAll('.session-tab.active')).toHaveLength(1);
    expect(document.querySelector('.session-tab.active')?.getAttribute('data-id')).toBe(ids[0]);
  });
});
