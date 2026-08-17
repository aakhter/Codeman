/**
 * @fileoverview COD-310 integration coverage for device-local saved-webview
 * openness and authoritative shared placement.
 */

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const CONSTANTS = readFileSync(new URL('../src/web/public/constants.js', import.meta.url), 'utf8');
const TAB_LAYOUT = readFileSync(new URL('../src/web/public/tab-layout-browser.js', import.meta.url), 'utf8');
const WEBVIEW_TABS = readFileSync(new URL('../src/web/public/webview-tabs.js', import.meta.url), 'utf8');

const sharedLayout = {
  version: 12,
  updatedAt: '2026-08-16T00:00:00.000Z',
  groups: [
    {
      id: 'shared',
      name: 'Shared',
      refs: [
        { kind: 'webview', id: 'w1' },
        { kind: 'session', id: 's1' },
        { kind: 'webview', id: 'w2' },
      ],
    },
  ],
  ungrouped: [],
};

function boot(initial: Record<string, string> = {}) {
  const dom = new JSDOM(
    '<!doctype html><body><main class="main"><div id="sessionTabs"></div><div id="webviewLayer"></div></main></body>',
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window as unknown as Window &
    typeof globalThis & {
      app: Record<string, any>;
      CodemanApp: new () => Record<string, any>;
      CodemanTabLayout: { project(layout: unknown, options: unknown): { visibleRefs: Array<{ id: string }> } };
    };
  (win as unknown as { CSS: { escape(value: string): string } }).CSS = { escape: (value) => value };
  for (const [key, value] of Object.entries(initial)) win.localStorage.setItem(key, value);
  (win as unknown as { eval(source: string): void }).eval(
    ['window.CodemanApp = class CodemanApp {};', CONSTANTS, TAB_LAYOUT, WEBVIEW_TABS].join('\n')
  );

  const app = new win.CodemanApp();
  app.sessions = new Map([['s1', { id: 's1', name: 'Session' }]]);
  app.webviews = new Map();
  app.webviewOrder = [];
  app.activeWebviewId = null;
  app.activeSessionId = 's1';
  app.$ = (id: string) => win.document.getElementById(id);
  app._apiJson = vi.fn(async (path: string) => {
    if (path === '/api/webviews') {
      return {
        webviews: [
          { id: 'w1', name: 'One', url: 'https://one.example/' },
          { id: 'w2', name: 'Two', url: 'https://two.example/' },
        ],
        maxLiveFrames: 4,
      };
    }
    const id = decodeURIComponent(path.split('/')[3] || '');
    const webview = app.webviews.get(id);
    return webview ? { webview, embedUrl: `/webview/cap-${id}/` } : null;
  });
  app.renderWebviewMenuItems = vi.fn();
  app._mountWebviewFrame = vi.fn();
  app.hideWelcome = vi.fn();
  app.showWelcome = vi.fn();
  app._updateActiveTabImmediate = vi.fn();
  app.renderSessionTabs = vi.fn(() => {
    app.visibleIds = win.CodemanTabLayout.project(sharedLayout, {
      liveSessionIds: ['s1'],
      openWebviewIds: app.webviewOrder,
      orientation: 'horizontal',
    }).visibleRefs.map((ref) => ref.id);
  });
  win.app = app;
  return { dom, win, app };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('COD-310 device-local saved-webview openness', () => {
  it.each([
    { label: 'new-key state', initial: { 'codeman-webview-open': '["w2"]' } },
    { label: 'legacy-only state', initial: { 'codeman-webview-order': '["w2"]' } },
  ])('preserves $label across a failed first list load and successful retry', async ({ initial }) => {
    const { win, app } = boot(initial);
    const authoritative = {
      webviews: [
        { id: 'w1', name: 'One', url: 'https://one.example/' },
        { id: 'w2', name: 'Two', url: 'https://two.example/' },
      ],
    };
    app._apiJson = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(authoritative);
    const write = vi.spyOn(win.Storage.prototype, 'setItem');

    await app.initWebviews();

    expect(write).not.toHaveBeenCalled();
    expect(win.localStorage.getItem('codeman-webview-open')).toBe(initial['codeman-webview-open'] || null);
    expect(win.localStorage.getItem('codeman-webview-order')).toBe(initial['codeman-webview-order'] || null);

    await app.initWebviews();
    expect(app.webviewOrder).toEqual(['w2']);
    expect(win.localStorage.getItem('codeman-webview-open')).toBe('["w2"]');
    write.mockRestore();
  });

  it('migrates the legacy array once as a filtered, deduplicated open set', async () => {
    const { win, app } = boot({
      'codeman-webview-order': JSON.stringify(['w2', null, 'w1', 'w2', 'unknown', 7]),
    });

    await app.initWebviews();

    expect(app.webviewOrder).toEqual(['w1', 'w2']);
    expect(win.localStorage.getItem('codeman-webview-open')).toBe('["w1","w2"]');
  });

  it('treats a present empty new set as completed migration and never reimports legacy state', async () => {
    const { app } = boot({
      'codeman-webview-order': '["w1"]',
      'codeman-webview-open': '[]',
    });

    await app.initWebviews();

    expect(app.webviewOrder).toEqual([]);
  });

  it('repairs malformed new storage to an empty completed set without consulting legacy order', async () => {
    const { win, app } = boot({
      'codeman-webview-order': '["w1"]',
      'codeman-webview-open': '{broken',
    });

    await app.initWebviews();

    expect(app.webviewOrder).toEqual([]);
    expect(win.localStorage.getItem('codeman-webview-open')).toBe('[]');
  });

  it('keeps two devices locally independent while both use the same shared placement', async () => {
    const first = boot({ 'codeman-webview-open': '["w1"]' });
    const second = boot({ 'codeman-webview-open': '["w2"]' });

    await first.app.initWebviews();
    await second.app.initWebviews();

    expect(first.app.visibleIds).toEqual(['w1', 's1']);
    expect(second.app.visibleIds).toEqual(['s1', 'w2']);
  });

  it('persists only local openness and reopens at the saved server position', async () => {
    const { win, app } = boot({
      'codeman-webview-order': '["w2","w1"]',
      'codeman-webview-open': '["w2"]',
    });
    await app.initWebviews();
    expect(app.visibleIds).toEqual(['s1', 'w2']);

    await app.openWebview('w1');
    expect(app.visibleIds).toEqual(['w1', 's1', 'w2']);
    expect(win.localStorage.getItem('codeman-webview-open')).toBe('["w1","w2"]');
    expect(win.localStorage.getItem('codeman-webview-order')).toBe('["w2","w1"]');

    app.activeWebviewId = null;
    app.closeWebviewTab('w1');
    expect(app.visibleIds).toEqual(['s1', 'w2']);

    await app.openWebview('w1');
    expect(app.visibleIds).toEqual(['w1', 's1', 'w2']);
  });

  it('continues with in-memory open state when localStorage property access fails', async () => {
    const { win, app } = boot();
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      get: () => {
        throw new win.DOMException('denied', 'SecurityError');
      },
    });

    await expect(app.initWebviews()).resolves.toBeUndefined();
    await expect(app.openWebview('w1')).resolves.toBeUndefined();
    expect(app.webviewOrder).toEqual(['w1']);
    expect(app.visibleIds).toEqual(['w1', 's1']);
  });

  it('continues with in-memory open state when localStorage reads fail', async () => {
    const { win, app } = boot();
    Object.defineProperty(win, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new win.DOMException('denied', 'SecurityError');
        },
        setItem: vi.fn(),
      },
    });

    await app.initWebviews();
    await app.openWebview('w1');
    expect(app.webviewOrder).toEqual(['w1']);
    expect(app.visibleIds).toEqual(['w1', 's1']);
  });

  it('keeps successful in-memory changes when localStorage writes fail', async () => {
    const { win, app } = boot({ 'codeman-webview-open': '["w2"]' });
    const write = vi.spyOn(win.Storage.prototype, 'setItem').mockImplementation(() => {
      throw new win.DOMException('quota', 'QuotaExceededError');
    });

    await app.initWebviews();
    await app.openWebview('w1');
    expect(app.webviewOrder).toEqual(['w1', 'w2']);
    expect(app.visibleIds).toEqual(['w1', 's1', 'w2']);

    app.activeWebviewId = null;
    app.closeWebviewTab('w2');
    expect(app.webviewOrder).toEqual(['w1']);
    expect(app.visibleIds).toEqual(['w1', 's1']);
    write.mockRestore();
  });

  it('does not persist a failed first open', async () => {
    const { win, app } = boot();
    await app.initWebviews();
    app._apiJson = vi.fn(async () => null);

    await app.openWebview('w1');

    expect(app.webviewOrder).toEqual([]);
    expect(win.localStorage.getItem('codeman-webview-open')).toBe('[]');
    expect(app._mountWebviewFrame).not.toHaveBeenCalled();
  });

  it('preserves the last authoritative list and openness when an SSE refresh fails', async () => {
    const { win, app } = boot({ 'codeman-webview-open': '["w1"]' });
    await app.initWebviews();
    app._apiJson = vi.fn(async () => null);

    await app._onWebviewChanged({ action: 'deleted', id: 'w1', owner: '@single' });

    expect([...app.webviews.keys()]).toEqual(['w1', 'w2']);
    expect(app.webviewOrder).toEqual(['w1']);
    expect(win.localStorage.getItem('codeman-webview-open')).toBe('["w1"]');
  });

  it('keeps the latest A/B navigation active when responses complete in reverse order', async () => {
    const { app } = boot();
    await app.initWebviews();
    const a = deferred<any>();
    const b = deferred<any>();
    app._apiJson = vi.fn((path: string) => (path.includes('/w1/') ? a.promise : b.promise));

    const openA = app.openWebview('w1');
    const openB = app.openWebview('w2');
    b.resolve({ webview: app.webviews.get('w2'), embedUrl: '/webview/b/' });
    await openB;
    a.resolve({ webview: app.webviews.get('w1'), embedUrl: '/webview/a/' });
    await openA;

    expect(app.activeWebviewId).toBe('w2');
    expect(app.webviewOrder).toEqual(['w1', 'w2']);
    expect(app._mountWebviewFrame).toHaveBeenCalledTimes(1);
    expect(app._mountWebviewFrame).toHaveBeenCalledWith('w2', '/webview/b/', app.webviews.get('w2'));
  });

  it('cancels a pending open when that webview is closed', async () => {
    const { app } = boot();
    await app.initWebviews();
    const pending = deferred<any>();
    app._apiJson = vi.fn(() => pending.promise);

    const opening = app.openWebview('w1');
    app.closeWebviewTab('w1');
    pending.resolve({ webview: app.webviews.get('w1'), embedUrl: '/webview/a/' });
    await opening;

    expect(app.webviewOrder).toEqual([]);
    expect(app.activeWebviewId).toBeNull();
    expect(app._mountWebviewFrame).not.toHaveBeenCalled();
  });

  it('does not cancel the latest navigation when an older pending webview is closed', async () => {
    const { app } = boot();
    await app.initWebviews();
    const a = deferred<any>();
    const b = deferred<any>();
    app._apiJson = vi.fn((path: string) => (path.includes('/w1/') ? a.promise : b.promise));

    const openA = app.openWebview('w1');
    const openB = app.openWebview('w2');
    app.closeWebviewTab('w1');
    b.resolve({ webview: app.webviews.get('w2'), embedUrl: '/webview/b/' });
    await openB;
    a.resolve({ webview: app.webviews.get('w1'), embedUrl: '/webview/a/' });
    await openA;

    expect(app.activeWebviewId).toBe('w2');
    expect(app.webviewOrder).toEqual(['w2']);
    expect(app._mountWebviewFrame).toHaveBeenCalledTimes(1);
    expect(app._mountWebviewFrame).toHaveBeenCalledWith('w2', '/webview/b/', app.webviews.get('w2'));
  });

  it('lets only the newest same-ID retry mount and activate', async () => {
    const { app } = boot();
    await app.initWebviews();
    const first = deferred<any>();
    const second = deferred<any>();
    app._apiJson = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstOpen = app.openWebview('w1');
    const retry = app.openWebview('w1');
    second.resolve({ webview: app.webviews.get('w1'), embedUrl: '/webview/new/' });
    await retry;
    first.resolve({ webview: app.webviews.get('w1'), embedUrl: '/webview/stale/' });
    await firstOpen;

    expect(app.activeWebviewId).toBe('w1');
    expect(app.webviewOrder).toEqual(['w1']);
    expect(app._mountWebviewFrame).toHaveBeenCalledTimes(1);
    expect(app._mountWebviewFrame).toHaveBeenCalledWith('w1', '/webview/new/', app.webviews.get('w1'));
  });

  it('closes an active webview to its authoritative successor instead of local chronology', async () => {
    const { win, app } = boot({ 'codeman-webview-open': '["w1","w2"]' });
    await app.initWebviews();
    app.webviewOrder = ['w2', 'w1'];
    app.activeWebviewId = 'w1';
    app.activeSessionId = 's1';
    win.document.querySelector('.main')!.classList.add('webview-active');
    app._refreshTabProjection = () =>
      win.CodemanTabLayout.project(sharedLayout, {
        liveSessionIds: ['s1'],
        openWebviewIds: app.webviewOrder,
        orientation: 'horizontal',
      });
    app.selectSession = vi.fn();
    app.openWebview = vi.fn();

    app.closeWebviewTab('w1');

    expect(app.selectSession).toHaveBeenCalledWith('s1');
    expect(app.openWebview).not.toHaveBeenCalled();
  });
});
