/** @fileoverview Real-browser coverage for COD-319 persistent Focus shortcuts. */

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

describe('COD-319 Focus smart group in Chromium', () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.route('http://codeman.test/', async (route) => {
      await route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html data-tab-orientation="vertical"><head><style>${styles}</style></head><body><div class="session-tabs tab-rail" id="sessionTabs"></div></body></html>`,
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
        '\nwindow.CodemanApp = CodemanApp; window.__setCod319App = value => { app = value; };',
    });
    await page.evaluate(() => {
      const controller = Object.create((window as any).CodemanApp.prototype);
      controller.$ = (id: string) => document.getElementById(id);
      controller.sessions = new Map([
        ['s1', { id: 's1', name: 'Session one', status: 'working', mode: 'codex' }],
        ['s2', { id: 's2', name: 'Session two', status: 'idle', mode: 'claude' }],
      ]);
      controller.webviews = new Map([['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test', icon: 'D' }]]);
      controller.webviewOrder = ['w1'];
      controller.activeSessionId = 's1';
      controller.activeWebviewId = null;
      controller.tabLayout = {
        version: 1,
        updatedAt: '2026-08-18T00:00:00.000Z',
        groups: [
          {
            id: 'g1',
            name: 'Work',
            refs: [
              { kind: 'session', id: 's1' },
              { kind: 'webview', id: 'w1' },
            ],
          },
        ],
        ungrouped: [{ kind: 'session', id: 's2' }],
      };
      controller.tabLayoutVersion = 1;
      controller.tabLayoutReadOnly = false;
      controller.collapsedTabGroupIds = new Set();
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
      controller.loadAppSettingsFromStorage = () => ({ showTabDetachButton: false });
      controller.openSessionOptions = () => undefined;
      controller.requestCloseSession = () => undefined;
      controller.showWebviewModal = () => undefined;
      controller.closeWebviewTab = () => undefined;
      controller.selectSession = (id: string) => {
        controller.activeSessionId = id;
        controller.activeWebviewId = null;
        (window as any).__activation = `session:${id}`;
        controller._updateActiveTabImmediate(id);
      };
      controller.openWebview = (id: string) => {
        controller.activeWebviewId = id;
        (window as any).__activation = `webview:${id}`;
        controller._updateActiveWebviewTab();
      };
      controller.editTabLayout = (operation: unknown) => {
        const next = (window as any).CodemanTabLayout.applyOperation(controller.tabLayout, operation);
        controller.tabLayout = { ...next, version: controller.tabLayout.version + 1 };
        controller.tabLayoutVersion = controller.tabLayout.version;
        controller._lastTabStructureKey = null;
        controller._fullRenderSessionTabs();
        return true;
      };
      controller._fullRenderSessionTabs();
      (window as any).__setCod319App(controller);
      (window as any).__cod319Controller = controller;
    });
  });

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  it('toggles a canonical session into Focus without changing canonical numbering', async () => {
    await page!.locator('[data-id="s1"] .tab-more').dispatchEvent('click');
    expect(await page!.getByRole('menuitem', { name: 'Add to Focus' }).count()).toBe(1);
    await page!.getByRole('menuitem', { name: 'Add to Focus' }).dispatchEvent('click');

    const shortcut = page!.locator('[data-tab-focus-shortcut="session:s1"]');
    expect(await shortcut.count()).toBe(1);
    expect(await shortcut.getAttribute('aria-current')).toBe('page');
    expect(await shortcut.locator('.tab-number, [data-tab-ref-drag]').count()).toBe(0);
    expect(await page!.locator('[data-id="s1"] .tab-number').textContent()).toBe('1');
    expect(await page!.locator('[data-webview-id="w1"] .tab-number').textContent()).toBe('2');
    expect(await page!.locator('[aria-selected="true"]').count()).toBe(1);
  });

  it('activates shortcuts by keyboard and persists smart collapse locally', async () => {
    const shortcut = page!.locator('[data-tab-focus-shortcut="session:s1"]');
    await shortcut.focus();
    await shortcut.press('Enter');
    expect(await page!.evaluate(() => (window as any).__activation)).toBe('session:s1');

    await page!.locator('[data-tab-focus-toggle]').click();
    expect(await page!.locator('[data-tab-focus-toggle]').getAttribute('aria-expanded')).toBe('false');
    expect(await page!.locator('[data-tab-focus-shortcut]').count()).toBe(0);
    expect(
      await page!.evaluate(() => JSON.parse(localStorage.getItem('codeman:tab-groups-collapsed') || '[]'))
    ).toContain('@focus');
    await page!.locator('[data-tab-focus-toggle]').click();
    expect(await page!.locator('[data-tab-focus-shortcut="session:s1"]').count()).toBe(1);
  });

  it('retains a closed focused webview and renders no shortcut copies horizontally', async () => {
    await page!.evaluate(() => {
      const controller = (window as any).__cod319Controller;
      controller.setTabRefFocus({ kind: 'webview', id: 'w1' }, true);
      controller.webviewOrder = [];
      controller._lastTabStructureKey = null;
      controller._fullRenderSessionTabs();
    });
    expect(await page!.locator('[data-tab-focus-shortcut="webview:w1"]').count()).toBe(0);
    expect(
      await page!.evaluate(
        () => (window as any).__cod319Controller.tabLayout.groups[0].refs.find((ref: any) => ref.id === 'w1')?.focus
      )
    ).toBe(true);

    await page!.evaluate(() => {
      const controller = (window as any).__cod319Controller;
      controller.webviewOrder = ['w1'];
      controller._lastTabStructureKey = null;
      controller._fullRenderSessionTabs();
    });
    expect(await page!.locator('[data-tab-focus-shortcut="webview:w1"]').count()).toBe(1);

    await page!.evaluate(() => {
      document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
      const controller = (window as any).__cod319Controller;
      controller._lastTabStructureKey = null;
      controller._fullRenderSessionTabs();
    });
    expect(await page!.locator('[data-tab-focus-group], [data-tab-focus-shortcut]').count()).toBe(0);
    expect(await page!.locator('.tab-focus-marker').count()).toBe(2);
  });
});
