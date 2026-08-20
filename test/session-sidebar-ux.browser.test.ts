/** @fileoverview Real Chromium geometry coverage for COD-339. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const tabLayout = readFileSync(resolve(publicDir, 'tab-layout-browser.js'), 'utf8');
const appSource = readFileSync(resolve(publicDir, 'app.js'), 'utf8');

describe('COD-339 sidebar actions and session-name font size in Chromium', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.setContent(`<!doctype html>
      <html data-session-list="sidebar" data-sidebar="expanded" data-sidebar-detail="simple">
        <head><style>${styles}</style></head>
        <body>
          <main class="main" style="height:760px">
            <aside class="session-sidebar" style="display:flex;width:300px;flex:0 0 300px">
              <div id="projectHeading" style="font-size:14px">cisco</div>
              <div class="session-sidebar-list" id="sessionSidebarList">
                <div class="session-tabs" id="sessionTabs"></div>
              </div>
            </aside>
            <div class="session-tabs-host" id="sessionTabsHost"></div>
            <div class="tab-rail" id="tabRail"></div>
            <div class="terminal-wrap"></div>
          </main>
          <button id="sidebarToggleBtn"></button>
          <input id="sessionSidebarFilter">
        </body>
      </html>`);
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
        '\nwindow.CodemanApp = CodemanApp;',
    });
    await page.evaluate(() => {
      const controller = Object.create((window as any).CodemanApp.prototype);
      controller.$ = (id: string) => document.getElementById(id);
      controller.sessions = new Map([
        ['short', { id: 'short', name: 'w2-mini-me', status: 'idle', mode: 'codex' }],
        [
          'long',
          {
            id: 'long',
            name: 'w1-smartswitch-pipeline-with-a-session-name-that-must-truncate',
            status: 'idle',
            mode: 'codex',
          },
        ],
      ]);
      controller.webviews = new Map();
      controller.webviewOrder = [];
      controller.activeSessionId = 'short';
      controller.activeWebviewId = null;
      controller.tabLayout = {
        version: 1,
        updatedAt: '2026-08-20T00:00:00.000Z',
        groups: [],
        ungrouped: [
          { kind: 'session', id: 'short' },
          { kind: 'session', id: 'long' },
        ],
      };
      controller.tabLayoutVersion = 1;
      controller.tabLayoutReadOnly = false;
      controller.collapsedTabGroupIds = new Set();
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
      controller._tallTabsEnabled = false;
      controller._fullRenderSessionTabs();
      (window as any).__cod339Controller = controller;
    });
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
  });

  it('keeps the complete action cluster immediately beside a short session name', async () => {
    const tab = page.locator('.session-tab[data-id="short"]');
    expect(await tab.locator('.tab-actions').evaluate((element) => element.parentElement?.className)).toContain(
      'tab-name-row'
    );
    const gap = await tab.evaluate((element) => {
      const name = element.querySelector('.tab-name')!.getBoundingClientRect();
      const actions = element.querySelector('.tab-actions')!.getBoundingClientRect();
      return actions.left - name.right;
    });
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThanOrEqual(6);
  });

  it('truncates a long name before the fixed action cluster without row overflow', async () => {
    await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.activeSessionId = 'long';
      controller._fullRenderSessionTabs();
    });
    const tab = page.locator('.session-tab[data-id="long"]');
    const metrics = await tab.evaluate((element) => {
      const name = element.querySelector('.tab-name') as HTMLElement;
      const actions = element.querySelector('.tab-actions')!.getBoundingClientRect();
      const row = element.getBoundingClientRect();
      return {
        clientWidth: name.clientWidth,
        scrollWidth: name.scrollWidth,
        nameRight: name.getBoundingClientRect().right,
        actionsLeft: actions.left,
        actionsRight: actions.right,
        rowRight: row.right,
      };
    });
    expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
    expect(metrics.nameRight).toBeLessThanOrEqual(metrics.actionsLeft);
    expect(metrics.actionsRight).toBeLessThanOrEqual(metrics.rowRight + 0.5);
  });

  it('changes only session-name text at the 11px and 18px boundaries', async () => {
    expect(await page.evaluate(() => typeof (window as any).__cod339Controller.applySessionSidebarFontSize)).toBe(
      'function'
    );
    for (const size of [11, 18]) {
      const result = await page.evaluate((value) => {
        (window as any).__cod339Controller.applySessionSidebarFontSize({ sessionSidebarFontSize: value });
        return {
          name: getComputedStyle(document.querySelector('.tab-name')!).fontSize,
          project: getComputedStyle(document.getElementById('projectHeading')!).fontSize,
        };
      }, size);
      expect(result).toEqual({ name: `${size}px`, project: '14px' });
    }
  });
});
