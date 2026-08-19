/** @fileoverview Real-browser coverage for COD-338 vertical rail session-name search. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const tabLayout = readFileSync(resolve(publicDir, 'tab-layout-browser.js'), 'utf8');
const appSource = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const railSource = readFileSync(resolve(publicDir, 'tab-rail-resize.js'), 'utf8');
const webviews = readFileSync(resolve(publicDir, 'webview-tabs.js'), 'utf8');

describe('COD-338 vertical rail session search in Chromium', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('http://codeman.test/', async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html>
          <html data-tab-orientation="vertical">
            <head><style>${styles}</style></head>
            <body>
              <main class="main">
                <div class="tab-rail" id="tabRail">
                  <div class="tab-rail-session-search" id="tabRailSessionSearchWrap">
                    <input id="tabRailSessionSearch" class="tab-rail-session-search-input" type="search"
                      aria-label="Search sessions" oninput="app.setTabRailSessionSearch(this.value)">
                    <button id="tabRailSessionSearchClear" class="tab-rail-session-search-clear" type="button"
                      aria-label="Clear session search" onclick="app.clearTabRailSessionSearch()" hidden>&times;</button>
                  </div>
                  <div id="tabRailSessionSearchEmpty" class="tab-rail-session-search-empty" role="status" hidden>
                    No sessions match
                  </div>
                  <div class="session-tabs" id="sessionTabs"></div>
                </div>
              </main>
            </body>
          </html>`,
      });
    });
    await page.goto('http://codeman.test/');
    await page.addScriptTag({
      content:
        'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, ' +
        'KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, ' +
        'NotificationManager = function(){}, KeyboardAccessoryBar = function(){}, FocusTrap = function(){};\n' +
        constants +
        '\n' +
        tabLayout +
        '\n' +
        appSource +
        '\n' +
        railSource +
        '\n' +
        webviews +
        '\nwindow.CodemanApp = CodemanApp; window.__setCod338App = value => { app = value; };',
    });
    await page.evaluate(() => {
      const controller = Object.create((window as any).CodemanApp.prototype);
      controller.$ = (id: string) => document.getElementById(id);
      controller.sessions = new Map([
        ['alpha', { id: 'alpha', name: 'Alpha API', status: 'idle', mode: 'codex' }],
        ['roadmap', { id: 'roadmap', name: 'Roadmap', status: 'idle', mode: 'claude' }],
        ['review', { id: 'review', name: 'API Review', status: 'idle', mode: 'claude' }],
        ['notes', { id: 'notes', name: 'Notes', status: 'idle', mode: 'claude' }],
      ]);
      controller.webviews = new Map([
        ['web', { id: 'web', name: 'API dashboard', url: 'https://example.test', icon: 'D' }],
      ]);
      controller.webviewOrder = ['web'];
      controller.activeSessionId = 'alpha';
      controller.activeWebviewId = null;
      controller.tabLayout = {
        version: 1,
        updatedAt: '2026-08-19T00:00:00.000Z',
        groups: [
          { id: 'engineering', name: 'Engineering', refs: [{ kind: 'session', id: 'alpha', focus: true }] },
          {
            id: 'planning',
            name: 'Planning',
            refs: [
              { kind: 'session', id: 'roadmap' },
              { kind: 'session', id: 'review' },
            ],
          },
        ],
        ungrouped: [
          { kind: 'webview', id: 'web' },
          { kind: 'session', id: 'notes' },
        ],
      };
      controller.tabLayoutVersion = 1;
      controller.tabLayoutReadOnly = false;
      controller.collapsedTabGroupIds = new Set(['planning']);
      controller.focusTabGroupCollapsed = false;
      controller._tabRailSessionSearch = '';
      controller._tabCollapseStorageFailed = false;
      controller._legacySessionOrder = [];
      controller._tabLayoutFirstPaintPending = false;
      controller._lastTabStructureKey = null;
      controller._inlineRenameActive = false;
      controller._tabLayoutManaged = true;
      controller._tabPointerHandlersBound = false;
      controller._tabPendingFollowRefs = new Set();
      controller._tabPlacementStates = new Map();
      controller._tabFocusIdentity = null;
      controller.detachedSessions = new Set();
      controller.tabAlerts = new Map();
      controller.terminalLoadStates = new Map();
      controller.minimizedSubagents = new Map();
      controller.hasTabDetachOverride = () => false;
      controller.renderSubagentTabBadge = () => '';
      controller.cancelHideSubagentDropdown = () => undefined;
      controller.updateTabOverflowMode = () => undefined;
      controller.updateConnectionLines = () => undefined;
      controller._applyTabEntrances = () => undefined;
      controller._scrollActiveTabIntoView = () => undefined;
      controller.selectSession = (id: string) => {
        controller.activeSessionId = id;
        controller.activeWebviewId = null;
        (window as any).__activation = `session:${id}`;
        controller._updateActiveTabImmediate(id);
      };
      localStorage.setItem('codeman:tab-groups-collapsed', '["planning"]');
      controller._fullRenderSessionTabs();
      (window as any).__setCod338App(controller);
      (window as any).__cod338Controller = controller;
    });
  });

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it('reveals a collapsed match, selects it, and restores collapse when cleared', async () => {
    const search = page!.getByRole('searchbox', { name: 'Search sessions' });
    expect(await search.count()).toBe(1);
    expect(
      await search.evaluate((element) => getComputedStyle(element.closest('.tab-rail-session-search')!).display)
    ).toBe('flex');
    expect(await page!.locator('[data-tab-group-header="planning"]').getAttribute('aria-expanded')).toBe('false');

    await search.fill('aPi');

    expect(await page!.locator('.session-tab[data-id] .tab-name').allTextContents()).toEqual([
      'Alpha API',
      'API Review',
    ]);
    expect(await page!.locator('.tab-layout-group-name').allTextContents()).toEqual([
      'Focus',
      'Engineering',
      'Planning',
    ]);
    expect(await page!.locator('[data-webview-id="web"], [data-id="roadmap"], [data-id="notes"]').count()).toBe(0);
    expect(await page!.locator('[data-tab-group-header="planning"]').getAttribute('aria-expanded')).toBe('true');
    expect(await page!.locator('[data-tab-group-header="planning"]').isDisabled()).toBe(true);

    await page!.locator('[data-id="review"]').click();
    expect(await page!.evaluate(() => (window as any).__activation)).toBe('session:review');

    const clear = page!.getByRole('button', { name: 'Clear session search' });
    expect(await clear.count()).toBe(1);
    await clear.click();

    expect(await search.inputValue()).toBe('');
    expect(await search.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await clear.isHidden()).toBe(true);
    expect(await page!.locator('[data-tab-group-header="planning"]').getAttribute('aria-expanded')).toBe('false');
    expect(await page!.locator('[data-id="roadmap"]').count()).toBe(0);
    expect(await page!.evaluate(() => localStorage.getItem('codeman:tab-groups-collapsed'))).toBe('["planning"]');
  });
});
