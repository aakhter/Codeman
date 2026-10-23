/**
 * @fileoverview Real-browser coverage for the COD-522 active-session pointer.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const mobileStyles = readFileSync(resolve(publicDir, 'mobile.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const tabLayout = readFileSync(resolve(publicDir, 'tab-layout-browser.js'), 'utf8');
const appSource = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const webviews = readFileSync(resolve(publicDir, 'webview-tabs.js'), 'utf8');

describe('COD-522 active-session pointer in Chromium', () => {
  let browser: Browser;
  let page: Page;
  let touchContext: BrowserContext;
  let touchPage: Page;

  async function setupApp(targetPage: Page, includeMobileStyles = false) {
    await targetPage.goto('about:blank');
    await targetPage.setContent(`
      <!doctype html>
      <html data-tab-orientation="horizontal">
        <head><style>${styles}</style>${includeMobileStyles ? `<style media="(max-width: 1023px)">${mobileStyles}</style>` : ''}</head>
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
      controller.sessionOrder = ['session'];
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

  it.each([
    ['vertical', 'carbon', false, false],
    ['vertical', 'paper-gray', true, false],
    ['vertical', 'og', false, true],
    ['horizontal', 'carbon', false, false],
    ['horizontal', 'paper-gray', false, false],
    ['mobile', 'carbon', false, false],
    ['mobile', 'paper-gray', false, false],
    ['sidebar', 'carbon', false, false],
    ['collapsed-sidebar', 'paper-gray', false, false],
    ['mobile-sidebar', 'paper-gray', false, false],
    ['mobile-collapsed-sidebar', 'carbon', false, false],
  ] as const)(
    'COD-522 shows only the selected pointer in %s / %s (grouped %s, compact %s)',
    async (layout, skin, grouped, compact) => {
      const target = layout.startsWith('mobile') ? touchPage : page;
      await setupApp(target, true);
      await renderLayout(target, layout === 'vertical' ? 'vertical' : 'horizontal', grouped);
      await target.evaluate(
        ({ layout, skin, compact }) => {
          const root = document.documentElement;
          root.dataset.skin = skin;
          root.classList.toggle('tab-rail-compact', compact);
          const container = document.getElementById('sessionTabs')!;
          const host = document.createElement('div');
          host.className = layout.includes('sidebar')
            ? 'session-sidebar open'
            : layout === 'vertical'
              ? 'tab-rail'
              : 'header';
          host.style.width = layout === 'collapsed-sidebar' ? '44px' : layout === 'vertical' ? '256px' : '100%';
          host.style.flex = 'none';
          container.before(host);
          host.append(container);
          if (layout.includes('sidebar')) {
            root.dataset.sessionList = 'sidebar';
            root.dataset.sidebar = layout.includes('collapsed') ? 'collapsed' : 'expanded';
          }
          const controller = (window as any).__cod316Controller;
          if (layout === 'collapsed-sidebar') controller.sessions.get('session').taskStats = { running: 1, total: 1 };
          controller.sessions.set('second', { id: 'second', name: 'Second', status: 'busy' });
          controller.sessionOrder.push('second');
          const refs = controller.tabLayout.groups[0]?.refs ?? controller.tabLayout.ungrouped;
          refs.push({ kind: 'session', id: 'second' });
          controller.activeSessionId = 'session';
          controller._fullRenderSessionTabs();
          document.querySelector('[data-id="second"]')!.classList.add('tab-alert-idle');
        },
        { layout, skin, compact }
      );

      const active = target.locator('[data-id="session"]');
      const inactive = target.locator('[data-id="second"]');
      const marker = active.locator('.tab-active-indicator');
      expect(await marker.count()).toBe(1);
      if (grouped) expect(await target.locator('.session-tabs--grouped [data-tab-group-id="group"]').count()).toBe(1);
      const before = await marker.boundingBox();
      expect(before).not.toBeNull();
      const style = await marker.evaluate((el) => {
        const css = getComputedStyle(el);
        return {
          visibility: css.visibility,
          pointerEvents: css.pointerEvents,
          color: css.backgroundColor,
          clip: css.clipPath,
        };
      });
      expect(style.visibility).toBe('visible');
      expect(style.pointerEvents).toBe('none');
      expect(style.color).toBe(
        skin === 'paper-gray' ? 'rgb(31, 35, 40)' : skin === 'og' ? 'rgb(236, 236, 240)' : 'rgb(243, 246, 250)'
      );
      expect(style.clip).toBe(
        layout === 'vertical' || layout.includes('sidebar')
          ? 'polygon(0px 0px, 100% 50%, 0px 100%)'
          : 'polygon(0px 0px, 100% 0px, 50% 100%)'
      );
      expect(await inactive.locator('.tab-active-indicator').evaluate((el) => getComputedStyle(el).visibility)).toBe(
        'hidden'
      );
      const dot = await active.locator('.tab-status').boundingBox();
      expect(dot).not.toBeNull();
      expect(before!.x + before!.width).toBeLessThanOrEqual(dot!.x);
      const row = await active.boundingBox();
      expect(before!.x).toBeGreaterThanOrEqual(row!.x);
      expect(before!.y).toBeGreaterThanOrEqual(row!.y);
      expect(before!.y + before!.height).toBeLessThanOrEqual(row!.y + row!.height);

      await inactive.hover({ force: true });
      expect(await inactive.locator('.tab-active-indicator').evaluate((el) => getComputedStyle(el).visibility)).toBe(
        'hidden'
      );
      await target.evaluate(() => {
        const controller = (window as any).__cod316Controller;
        controller.activeSessionId = 'second';
        controller._renderSessionTabsImmediate();
      });
      expect(await marker.evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
      expect(await inactive.locator('.tab-active-indicator').evaluate((el) => getComputedStyle(el).visibility)).toBe(
        'visible'
      );
      expect(await inactive.getAttribute('aria-selected')).toBe('true');
      const after = await marker.boundingBox();
      expect(after).not.toBeNull();
      expect(Math.abs(after!.width - before!.width)).toBeLessThan(0.1);
      expect(Math.abs(after!.x - before!.x)).toBeLessThanOrEqual(1);
      if (process.env.TAB_INDICATOR_SCREENSHOT_PATH && layout === 'vertical' && skin === 'carbon') {
        await target.locator('.tab-rail').screenshot({ path: process.env.TAB_INDICATOR_SCREENSHOT_PATH });
      }
    }
  );
});
