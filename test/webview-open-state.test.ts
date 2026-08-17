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

describe('COD-310 device-local saved-webview openness', () => {
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
});
