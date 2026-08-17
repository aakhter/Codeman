/**
 * @fileoverview Real-browser regression coverage for COD-316 tab activation and drag hit targets.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const tabLayout = readFileSync(resolve(publicDir, 'tab-layout-browser.js'), 'utf8');
const appSource = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const webviews = readFileSync(resolve(publicDir, 'webview-tabs.js'), 'utf8');

describe('COD-316 full-row tab activation in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`
      <!doctype html>
      <html data-tab-orientation="horizontal">
        <head><style>${styles}</style></head>
        <body><div class="session-tabs" id="sessionTabs"></div></body>
      </html>
    `);
    await page.addScriptTag({
      content:
        'var MobileDetection = { isTouchDevice: () => false }, KeyboardHandler = {}, SwipeHandler = {}, ' +
        'VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){}, KeyboardAccessoryBar = function(){}, ' +
        'FocusTrap = function(){};\n' +
        constants +
        '\n' +
        tabLayout +
        '\n' +
        appSource +
        '\nwindow.CodemanApp = CodemanApp; window.__setCod316App = value => { app = value; };',
    });
    await page.addScriptTag({ content: webviews });
    await page.evaluate(() => {
      const controller = Object.create((window as any).CodemanApp.prototype);
      controller.$ = (id: string) => document.getElementById(id);
      controller.sessions = new Map([['session', { id: 'session', name: 'Session', status: 'idle' }]]);
      controller.webviews = new Map([['web', { id: 'web', name: 'Web', url: 'https://example.test', icon: 'W' }]]);
      controller.webviewOrder = ['web'];
      controller.activeSessionId = null;
      controller.activeWebviewId = null;
      controller.tabLayout = {
        version: 1,
        updatedAt: '2026-08-17T00:00:00.000Z',
        groups: [],
        ungrouped: [
          { kind: 'session', id: 'session' },
          { kind: 'webview', id: 'web' },
        ],
      };
      controller.tabLayoutReadOnly = false;
      controller.collapsedTabGroupIds = new Set();
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
        (window as any).__activation = `session:${id}`;
      };
      controller.openWebview = (id: string) => {
        (window as any).__activation = `webview:${id}`;
      };
      controller.openSessionOptions = () => {
        (window as any).__action = 'settings';
      };
      controller.detachSession = () => {
        (window as any).__action = 'detach';
      };
      controller.requestCloseSession = () => {
        (window as any).__action = 'close';
      };
      controller.openTabRailActionMenu = () => {
        (window as any).__action = 'overflow';
      };
      controller.showWebviewModal = () => {
        (window as any).__action = 'web-settings';
      };
      controller.closeWebviewTab = () => {
        (window as any).__action = 'web-close';
      };
      controller.openTabRefMoveMenu = () => {
        (window as any).__action = 'web-overflow';
      };
      controller._fullRenderSessionTabs();
      (window as any).__setCod316App(controller);
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  async function expectActivation(selector: string, expected: string) {
    await page.evaluate(() => ((window as any).__activation = null));
    await page.locator(selector).click();
    expect(await page.evaluate(() => (window as any).__activation)).toBe(expected);
  }

  it('activates session and webview tabs from status, icon, name, and row padding', async () => {
    await expectActivation('[data-id="session"] .tab-status', 'session:session');
    await expectActivation('[data-id="session"] .tab-name', 'session:session');
    await expectActivation('[data-webview-id="web"] .tab-web-icon', 'webview:web');
    await expectActivation('[data-webview-id="web"] .tab-name', 'webview:web');

    for (const [selector, expected] of [
      ['[data-id="session"]', 'session:session'],
      ['[data-webview-id="web"]', 'webview:web'],
    ] as const) {
      await page.evaluate(() => ((window as any).__activation = null));
      const box = await page.locator(selector).boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.click(box!.x + 2, box!.y + box!.height / 2);
      expect(await page.evaluate(() => (window as any).__activation)).toBe(expected);
    }
  });

  it('keeps drag handles separate and visible in horizontal and vertical desktop layouts', async () => {
    const handles = page.locator('.tab-ref-drag-handle');
    expect(await handles.count()).toBe(2);
    expect(await handles.first().isVisible()).toBe(true);
    expect(await handles.first().evaluate((element) => getComputedStyle(element).cursor)).toBe('grab');

    await page.evaluate(() => document.documentElement.setAttribute('data-tab-orientation', 'vertical'));
    expect(await handles.first().isVisible()).toBe(true);
    await page.evaluate(() => ((window as any).__activation = null));
    await handles.first().click();
    expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
    await handles.nth(1).click();
    expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
  });

  it('retains full-row hover and pointer feedback while action controls remain separate', async () => {
    await page.evaluate(() => document.documentElement.setAttribute('data-tab-orientation', 'horizontal'));
    const session = page.locator('[data-id="session"]');
    await session.locator('.tab-name').hover();
    expect(await session.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer');
    expect(await session.evaluate((element) => element.matches(':hover'))).toBe(true);

    for (const [selector, expected] of [
      ['.tab-gear', 'settings'],
      ['.tab-detach', 'detach'],
      ['.tab-close', 'close'],
      ['.tab-more', 'overflow'],
    ] as const) {
      await page.evaluate(() => {
        (window as any).__activation = null;
        (window as any).__action = null;
      });
      await session.evaluate((element) => element.classList.add('active', 'tab-show-detach'));
      if (selector === '.tab-more') {
        await page.evaluate(() => {
          document.documentElement.setAttribute('data-tab-orientation', 'vertical');
          document.documentElement.classList.add('tab-rail-compact');
        });
      }
      const control = session.locator(selector);
      expect(await control.isVisible()).toBe(true);
      expect(await control.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer');
      await control.click();
      expect(await page.evaluate(() => (window as any).__action)).toBe(expected);
      expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
      await page.evaluate(() => {
        document.documentElement.classList.remove('tab-rail-compact');
        document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
      });
    }

    const webview = page.locator('[data-webview-id="web"]');
    await session.evaluate((element) => element.classList.remove('active'));
    await webview.evaluate((element) => element.classList.add('active'));
    for (const [selector, expected] of [
      ['.tab-gear', 'web-settings'],
      ['.tab-close', 'web-close'],
      ['.tab-more', 'web-overflow'],
    ] as const) {
      await page.evaluate(() => {
        (window as any).__activation = null;
        (window as any).__action = null;
      });
      if (selector === '.tab-more') {
        await page.evaluate(() => {
          document.documentElement.setAttribute('data-tab-orientation', 'vertical');
          document.documentElement.classList.add('tab-rail-compact');
        });
      }
      const control = webview.locator(selector);
      expect(await control.isVisible()).toBe(true);
      await control.click();
      expect(await page.evaluate(() => (window as any).__action)).toBe(expected);
      expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
      await page.evaluate(() => {
        document.documentElement.classList.remove('tab-rail-compact');
        document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
      });
    }
  });
});
