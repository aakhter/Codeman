/**
 * @fileoverview Real-browser regression coverage for COD-316 tab activation and drag hit targets.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const tabLayout = readFileSync(resolve(publicDir, 'tab-layout-browser.js'), 'utf8');
const appSource = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const webviews = readFileSync(resolve(publicDir, 'webview-tabs.js'), 'utf8');

describe('COD-316 full-row tab activation in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let touchContext: BrowserContext;
  let touchPage: Page;

  async function setupApp(targetPage: Page) {
    await targetPage.setContent(`
      <!doctype html>
      <html data-tab-orientation="horizontal">
        <head><style>${styles}</style></head>
        <body><div class="session-tabs" id="sessionTabs"></div></body>
      </html>
    `);
    await targetPage.addScriptTag({
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
    await targetPage.addScriptTag({ content: webviews });
    await targetPage.evaluate(() => {
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
      (window as any).__cod316Controller = controller;
    });
  }

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    touchContext = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    touchPage = await touchContext.newPage();
    await setupApp(page);
    await setupApp(touchPage);
  });

  afterAll(async () => {
    await touchContext.close();
    await browser.close();
  });

  async function renderLayout(targetPage: Page, orientation: 'horizontal' | 'vertical', grouped = false) {
    await targetPage.evaluate(
      ({ nextOrientation, nextGrouped }) => {
        document.documentElement.setAttribute('data-tab-orientation', nextOrientation);
        const controller = (window as any).__cod316Controller;
        controller.tabLayout = {
          version: controller.tabLayout.version + 1,
          updatedAt: '2026-08-17T00:00:00.000Z',
          groups: nextGrouped
            ? [
                {
                  id: 'group',
                  name: 'Group',
                  refs: [
                    { kind: 'session', id: 'session' },
                    { kind: 'webview', id: 'web' },
                  ],
                },
              ]
            : [],
          ungrouped: nextGrouped
            ? []
            : [
                { kind: 'session', id: 'session' },
                { kind: 'webview', id: 'web' },
              ],
        };
        controller._lastTabStructureKey = null;
        controller._fullRenderSessionTabs();
      },
      { nextOrientation: orientation, nextGrouped: grouped }
    );
  }

  async function expectActivation(targetPage: Page, selector: string, expected: string, touch = false) {
    await targetPage.evaluate(() => ((window as any).__activation = null));
    if (touch) await targetPage.locator(selector).tap();
    else await targetPage.locator(selector).click();
    expect(await targetPage.evaluate(() => (window as any).__activation)).toBe(expected);
  }

  it('activates session and webview tabs from status, icon, name, and row padding', async () => {
    await renderLayout(page, 'horizontal');
    await expectActivation(page, '[data-id="session"] .tab-status', 'session:session');
    await expectActivation(page, '[data-id="session"] .tab-name', 'session:session');
    await expectActivation(page, '[data-webview-id="web"] .tab-web-icon', 'webview:web');
    await expectActivation(page, '[data-webview-id="web"] .tab-name', 'webview:web');

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

  it('activates rows from a genuinely rendered vertical grouped projection', async () => {
    await renderLayout(page, 'vertical', true);
    expect(await page.locator('.tab-layout-tree[role="tree"] [data-tab-group-id="group"]').count()).toBe(1);
    expect(await page.locator('.session-tab[role="treeitem"]').count()).toBe(2);

    await expectActivation(page, '[data-id="session"] .tab-status', 'session:session');
    await expectActivation(page, '[data-id="session"] .tab-name', 'session:session');
    await expectActivation(page, '[data-webview-id="web"] .tab-web-icon', 'webview:web');
    await expectActivation(page, '[data-webview-id="web"] .tab-name', 'webview:web');

    const box = await page.locator('[data-id="session"]').boundingBox();
    expect(box).not.toBeNull();
    await page.evaluate(() => ((window as any).__activation = null));
    await page.mouse.click(box!.x + 2, box!.y + box!.height / 2);
    expect(await page.evaluate(() => (window as any).__activation)).toBe('session:session');
  });

  it('keeps drag handles separate and visible in horizontal and vertical desktop layouts', async () => {
    await renderLayout(page, 'horizontal');
    const handles = page.locator('.tab-ref-drag-handle');
    expect(await handles.count()).toBe(2);
    expect(await handles.first().isVisible()).toBe(true);
    expect(await handles.first().evaluate((element) => getComputedStyle(element).cursor)).toBe('grab');
    expect(
      await handles.evaluateAll((elements) => elements.map((element) => (element as HTMLElement).tabIndex))
    ).toEqual([-1, -1]);

    await renderLayout(page, 'vertical', true);
    expect(await handles.first().isVisible()).toBe(true);
    await page.evaluate(() => ((window as any).__activation = null));
    await handles.first().click();
    expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
    await handles.nth(1).click();
    expect(await page.evaluate(() => (window as any).__activation)).toBeNull();
  });

  it('paints a dimmed but visible grip that transposes per orientation and lights with the row', async () => {
    await renderLayout(page, 'horizontal');
    await page.mouse.move(600, 400);
    const handle = page.locator('[data-id="session"] .tab-ref-drag-handle');

    const resting = await handle.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        opacity: Number(style.opacity),
        painted: style.backgroundImage !== 'none',
        padding: [style.paddingTop, style.paddingLeft],
      };
    });
    // Dim enough that an idle tab stops looking like it carries a control, but
    // genuinely drawn — COD-316 needs the handle reachable, not merely present.
    expect(resting.opacity).toBeGreaterThan(0);
    expect(resting.opacity).toBeLessThan(1);
    expect(resting.painted).toBe(true);

    // Poll: opacity is transitioned, so a single read lands mid-interpolation.
    await page.locator('[data-id="session"] .tab-name').hover();
    await expect.poll(() => handle.evaluate((element) => Number(getComputedStyle(element).opacity))).toBe(1);

    // settings-ui.js only sets data-tab-orientation once settings load, and the
    // rest of the app reads "not vertical" as horizontal. The grip has to agree,
    // or the first paint tiles dots across the whole button.
    await page.evaluate(() => document.documentElement.removeAttribute('data-tab-orientation'));
    expect(
      await handle.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.paddingTop, style.paddingLeft];
      })
    ).toEqual(resting.padding);

    // The rail transposes the dot grid so it runs along the axis of motion.
    await renderLayout(page, 'vertical', true);
    await page.mouse.move(600, 400);
    const railPadding = await handle.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.paddingTop, style.paddingLeft];
    });
    expect(resting.padding[0]).not.toBe(resting.padding[1]);
    expect(railPadding).toEqual([...resting.padding].reverse());
  });

  it('retains full-row hover and pointer feedback while action controls remain separate', async () => {
    await renderLayout(page, 'horizontal');
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

  it('activates session/webview rows from real touchscreen taps while handles and controls stay separate', async () => {
    await renderLayout(touchPage, 'horizontal');
    await expectActivation(touchPage, '[data-id="session"] .tab-name', 'session:session', true);
    await expectActivation(touchPage, '[data-webview-id="web"] .tab-web-icon', 'webview:web', true);

    for (const handle of await touchPage.locator('.tab-ref-drag-handle').all()) {
      await touchPage.evaluate(() => ((window as any).__activation = null));
      await handle.tap();
      expect(await touchPage.evaluate(() => (window as any).__activation)).toBeNull();
    }

    const session = touchPage.locator('[data-id="session"]');
    await session.evaluate((element) => element.classList.add('active', 'tab-show-detach'));
    await touchPage.evaluate(() => {
      (window as any).__activation = null;
      (window as any).__action = null;
    });
    await session.locator('.tab-gear').tap();
    expect(await touchPage.evaluate(() => (window as any).__action)).toBe('settings');
    expect(await touchPage.evaluate(() => (window as any).__activation)).toBeNull();

    await session.evaluate((element) => element.classList.remove('active'));
    const webview = touchPage.locator('[data-webview-id="web"]');
    await webview.evaluate((element) => element.classList.add('active'));
    await touchPage.evaluate(() => {
      (window as any).__activation = null;
      (window as any).__action = null;
    });
    await webview.locator('.tab-close').tap();
    expect(await touchPage.evaluate(() => (window as any).__action)).toBe('web-close');
    expect(await touchPage.evaluate(() => (window as any).__activation)).toBeNull();
  });
});
