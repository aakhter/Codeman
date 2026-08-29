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
      controller.focusTabGroupCollapsed = false;
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
      controller._tabLayoutEditCoordinator = null;
      controller.__putRequests = [];
      controller.__serverLayout = structuredClone(controller.tabLayout);
      controller._apiPut = async (_path: string, body: any) => {
        controller.__putRequests.push(structuredClone(body));
        let next = controller.__serverLayout;
        for (const operation of body.operations) {
          next = (window as any).CodemanTabLayout.applyOperation(next, operation);
        }
        controller.__serverLayout = { ...next, version: next.version + 1 };
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { layout: structuredClone(controller.__serverLayout), placements: [] } }),
        };
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
    const canonical = page!.locator('[data-id="s1"]');
    await canonical.hover();
    const canonicalMenu = canonical.locator('.tab-more');
    expect(await canonicalMenu.evaluate((element) => getComputedStyle(element).display)).not.toBe('none');
    await canonicalMenu.click();
    expect(await page!.getByRole('menuitem', { name: 'Add to Focus' }).count()).toBe(1);
    await page!.getByRole('menuitem', { name: 'Add to Focus' }).click();

    const shortcut = page!.locator('[data-tab-focus-shortcut="session:s1"]');
    await shortcut.waitFor();
    expect(await shortcut.count()).toBe(1);
    expect(await shortcut.getAttribute('aria-current')).toBe('page');
    // COD-372 (`044f7749`) numbers Focus shortcuts FIRST: the shortcut takes Alt+1,
    // its canonical row drops its badge entirely, and the remaining canonical rows
    // number on from there. This used to assert the shortcut carried no badge at all.
    // The drag handle is still stripped — only the number came back.
    expect(await shortcut.locator('[data-tab-ref-drag]').count()).toBe(0);
    expect(await shortcut.locator('.tab-number').textContent()).toBe('1');
    expect(await page!.locator('[data-id="s1"] .tab-number').count()).toBe(0);
    expect(await page!.locator('[data-webview-id="w1"] .tab-number').textContent()).toBe('2');
    expect(await page!.locator('[aria-selected="true"]').count()).toBe(1);

    await shortcut.hover();
    const shortcutMenu = shortcut.locator('.tab-more');
    expect(await shortcutMenu.evaluate((element) => getComputedStyle(element).display)).not.toBe('none');
    await shortcutMenu.click();
    expect(await page!.getByRole('menuitem', { name: 'Remove from Focus' }).count()).toBe(1);
    await page!.getByRole('menuitem', { name: 'Remove from Focus' }).click();
    expect(await page!.locator('[data-tab-focus-shortcut="session:s1"]').count()).toBe(0);

    await page!.waitForTimeout(220);
    expect(
      await page!.evaluate(() =>
        (window as any).__cod319Controller.__putRequests.flatMap((request: any) => request.operations)
      )
    ).toContainEqual({ type: 'setFocus', ref: { kind: 'session', id: 's1' }, focused: false });

    await canonical.hover();
    await canonicalMenu.click();
    await page!.getByRole('menuitem', { name: 'Add to Focus' }).click();
    await shortcut.waitFor();
    await page!.waitForTimeout(220);
  });

  it('activates shortcuts by keyboard and persists smart collapse locally', async () => {
    const shortcut = page!.locator('[data-tab-focus-shortcut="session:s1"]');
    await shortcut.focus();
    await shortcut.press('Enter');
    expect(await page!.evaluate(() => (window as any).__activation)).toBe('session:s1');

    await page!.locator('[data-tab-focus-toggle]').click();
    expect(await page!.locator('[data-tab-focus-toggle]').getAttribute('aria-expanded')).toBe('false');
    expect(await page!.locator('[data-tab-focus-shortcut]').count()).toBe(0);
    expect(await page!.evaluate(() => localStorage.getItem('codeman:focus-group-collapsed'))).toBe('true');
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

    const webShortcut = page!.locator('[data-tab-focus-shortcut="webview:w1"]');
    await webShortcut.focus();
    await webShortcut.press(' ');
    expect(await page!.evaluate(() => (window as any).__activation)).toBe('webview:w1');
    expect(await webShortcut.getAttribute('aria-current')).toBe('page');
    expect(await webShortcut.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
      'rgba(0, 0, 0, 0)'
    );

    expect(
      await page!.evaluate(() => ({
        sessionOrder: (window as any).__cod319Controller.sessionOrder,
        visibleRefs: (window as any).__cod319Controller._visibleTabRefs,
      }))
    ).toEqual({
      sessionOrder: ['s1', 's2'],
      visibleRefs: [
        { kind: 'session', id: 's1' },
        { kind: 'webview', id: 'w1' },
        { kind: 'session', id: 's2' },
      ],
    });

    await page!.evaluate(() => {
      document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
      const controller = (window as any).__cod319Controller;
      controller._lastTabStructureKey = null;
      controller._fullRenderSessionTabs();
    });
    expect(await page!.locator('[data-tab-focus-group], [data-tab-focus-shortcut]').count()).toBe(0);
    expect(await page!.locator('.tab-focus-marker').count()).toBe(2);
  });

  it('adopts same-owner deletion pruning, ignores foreign-owner SSE, and stays flat on phones', async () => {
    await page!.waitForTimeout(220);
    await page!.evaluate(() => {
      document.documentElement.setAttribute('data-tab-orientation', 'vertical');
      (window as any).__codemanUser = { multiUser: true, username: 'alice', role: 'user' };
      const controller = (window as any).__cod319Controller;
      controller.webviewOrder = ['w1'];
      controller.__layoutFetches = 0;
      controller.__sseSnapshot = structuredClone(controller.tabLayout);
      controller._fetchTabLayout = async () => {
        controller.__layoutFetches++;
        return { layout: structuredClone(controller.__sseSnapshot), placements: [] };
      };
      controller._tabLayoutCoordinator?.dispose?.();
      controller._tabLayoutCoordinator = null;
      controller._lastTabStructureKey = null;
      controller._fullRenderSessionTabs();
    });
    expect(await page!.locator('[data-tab-focus-shortcut="session:s1"]').count()).toBe(1);
    expect(await page!.locator('[data-tab-focus-shortcut="webview:w1"]').count()).toBe(1);

    await page!.evaluate(() => {
      const controller = (window as any).__cod319Controller;
      const current = controller.tabLayout;
      controller.__sseSnapshot = {
        ...current,
        version: current.version + 1,
        groups: current.groups.map((group: any) => ({
          ...group,
          refs: group.refs.filter((ref: any) => !(ref.kind === 'session' && ref.id === 's1')),
        })),
      };
      controller._onTabLayoutChanged({ owner: 'alice', version: controller.__sseSnapshot.version });
    });
    await page!.waitForFunction(() => !document.querySelector('[data-tab-focus-shortcut="session:s1"]'));
    expect(await page!.evaluate(() => (window as any).__cod319Controller.__layoutFetches)).toBe(1);

    await page!.evaluate(() => {
      const controller = (window as any).__cod319Controller;
      controller._onTabLayoutChanged({ owner: 'bob', version: controller.tabLayout.version + 1 });
    });
    await page!.waitForTimeout(50);
    expect(await page!.evaluate(() => (window as any).__cod319Controller.__layoutFetches)).toBe(1);

    await page!.evaluate(() => {
      const controller = (window as any).__cod319Controller;
      const current = controller.tabLayout;
      controller.__sseSnapshot = {
        ...current,
        version: current.version + 1,
        groups: current.groups.map((group: any) => ({
          ...group,
          refs: group.refs.filter((ref: any) => !(ref.kind === 'webview' && ref.id === 'w1')),
        })),
      };
      controller._onTabLayoutChanged({ owner: 'alice', version: controller.__sseSnapshot.version });
    });
    await page!.waitForFunction(() => !document.querySelector('[data-tab-focus-shortcut="webview:w1"]'));
    expect(await page!.evaluate(() => (window as any).__cod319Controller.__layoutFetches)).toBe(2);

    await page!.evaluate(() => {
      document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
      (window as any).MobileDetection.getDeviceType = () => 'phone';
      const controller = (window as any).__cod319Controller;
      controller._lastTabStructureKey = null;
      controller._fullRenderSessionTabs();
    });
    expect(await page!.locator('[data-tab-focus-group], [data-tab-focus-shortcut]').count()).toBe(0);
    expect(await page!.locator('.tab-layout-group').count()).toBe(0);
  });
});
