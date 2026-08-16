// @vitest-environment jsdom
/** @fileoverview COD-306 integration coverage over the shipping browser controller and DOM. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
  document.body.innerHTML = '';
});

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
});
