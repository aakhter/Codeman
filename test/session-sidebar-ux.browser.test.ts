/** @fileoverview Real Chromium geometry coverage for COD-339. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(publicDir, 'styles.css'), 'utf8');
const constants = readFileSync(resolve(publicDir, 'constants.js'), 'utf8');
const tabLayout = readFileSync(resolve(publicDir, 'tab-layout-browser.js'), 'utf8');
const appSource = readFileSync(resolve(publicDir, 'app.js'), 'utf8');
const tabRailResize = readFileSync(resolve(publicDir, 'tab-rail-resize.js'), 'utf8');

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
            <aside id="sessionSidebar" class="session-sidebar" style="display:flex;width:300px;flex:0 0 300px">
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
        '\n' +
        tabRailResize +
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
      controller.applyTabWrapSettings = () => undefined;
      controller.applySidebarFilter = () => undefined;
      controller.__cod339Settings = { sessionListLayout: 'sidebar', sessionSidebarFontSize: 14 };
      controller.loadAppSettingsFromStorage = () => controller.__cod339Settings;
      controller.getDefaultSettings = () => ({});
      controller._applyTabEntrances = () => undefined;
      controller._scrollActiveTabIntoView = () => undefined;
      controller._tallTabsEnabled = false;
      controller._fullRenderSessionTabs();
      (window as any).__cod339Controller = controller;
    });
    await page.addScriptTag({ content: 'app = window.__cod339Controller; window.app = app;' });
  });

  beforeEach(async () => {
    await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.closeTabRailActionMenu?.();
      controller.__cod339Settings = { sessionListLayout: 'sidebar', sessionSidebarFontSize: 14 };
      controller._sidebarCollapsedOverride = false;
      controller.activeSessionId = 'short';
      controller.detachedSessions.clear();
      controller.minimizedSubagents.clear();
      controller.renderSubagentTabBadge = () => '';
      document.documentElement.dataset.sessionList = 'sidebar';
      document.documentElement.dataset.sidebar = 'expanded';
      document.documentElement.dataset.tabOrientation = 'horizontal';
      document.documentElement.classList.remove('tab-rail-compact');
      controller._lastTabStructureKey = null;
      controller.applySessionListLayout();
      controller._fullRenderSessionTabs();
    });
  });

  afterAll(async () => {
    await page.close();
    await browser.close();
  });

  async function applyExpandedSurface(surface: 'sidebar' | 'rail') {
    await page.evaluate((nextSurface) => {
      const controller = (window as any).__cod339Controller;
      controller.__cod339Settings =
        nextSurface === 'sidebar'
          ? { sessionListLayout: 'sidebar', sessionSidebarFontSize: 14 }
          : { sessionListLayout: 'header', tabOrientation: 'vertical', sessionSidebarFontSize: 14 };
      controller._sidebarCollapsedOverride = false;
      controller.activeSessionId = 'short';
      document.documentElement.dataset.sessionList = nextSurface === 'sidebar' ? 'sidebar' : 'header';
      document.documentElement.dataset.sidebar = 'expanded';
      document.documentElement.dataset.tabOrientation = nextSurface === 'sidebar' ? 'horizontal' : 'vertical';
      document.documentElement.classList.remove('tab-rail-compact');
      controller._lastTabStructureKey = null;
      controller.applySessionListLayout();
      controller._fullRenderSessionTabs();
    }, surface);
  }

  async function tabMoreState(targetPage: Page, sessionId = 'long') {
    return targetPage.locator(`.session-tab[data-id="${sessionId}"] .tab-more`).evaluate((element) => {
      const style = getComputedStyle(element);
      return { visibility: style.visibility, pointerEvents: style.pointerEvents };
    });
  }

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

  it('rebuilds action placement through the production collapse and expand path', async () => {
    const parentClasses = await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller._sidebarCollapsedOverride = false;
      controller.toggleSessionSidebar();
      const collapsed = document.querySelector('.session-tab[data-id="short"] .tab-actions')?.parentElement?.className;
      controller.toggleSessionSidebar();
      const expanded = document.querySelector('.session-tab[data-id="short"] .tab-actions')?.parentElement?.className;
      return { collapsed, expanded };
    });
    expect(parentClasses.collapsed).toContain('session-tab');
    expect(parentClasses.expanded).toContain('tab-name-row');
  });

  it('keeps detached status after the immediate title/action cluster', async () => {
    const childClasses = await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.detachedSessions.add('short');
      controller._fullRenderSessionTabs();
      const row = document.querySelector('.session-tab[data-id="short"] .tab-name-row')!;
      const classes = [...row.children].map((element) => element.className);
      controller.detachedSessions.delete('short');
      controller._fullRenderSessionTabs();
      return classes;
    });
    expect(childClasses.indexOf('tab-actions')).toBe(childClasses.indexOf('tab-name') + 1);
    expect(childClasses.indexOf('tab-detached-badge')).toBeGreaterThan(childClasses.indexOf('tab-actions'));
  });

  it('keeps an incrementally-added subagent badge outside the name row', async () => {
    const parentClass = await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.renderSubagentTabBadge = () =>
        '<span class="tab-subagent-badge"><span class="subagent-label">AGENT</span></span>';
      controller.minimizedSubagents.set('short', new Map([['agent', {}]]));
      controller._renderSessionTabsImmediate();
      return document.querySelector('.session-tab[data-id="short"] .tab-subagent-badge')?.parentElement?.className;
    });
    expect(parentClass).toContain('session-tab');
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

  it('keeps actions beside names and applies session-name sizing in the expanded vertical rail', async () => {
    await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.__cod339Settings = {
        sessionListLayout: 'header',
        tabOrientation: 'vertical',
        sessionSidebarFontSize: 11,
      };
      document.documentElement.dataset.sessionList = 'header';
      document.documentElement.dataset.sidebar = 'expanded';
      document.documentElement.dataset.tabOrientation = 'vertical';
      document.documentElement.classList.remove('tab-rail-compact');
      controller.applySessionListLayout();
      controller._fullRenderSessionTabs();
    });

    const shortTab = page.locator('.session-tab[data-id="short"]');
    expect
      .soft(await shortTab.locator('.tab-actions').evaluate((element) => element.parentElement?.className))
      .toContain('tab-name-row');
    const shortGap = await shortTab.evaluate((element) => {
      const name = element.querySelector('.tab-name')!.getBoundingClientRect();
      const actions = element.querySelector('.tab-actions')!.getBoundingClientRect();
      return actions.left - name.right;
    });
    expect.soft(shortGap).toBeGreaterThanOrEqual(0);
    expect.soft(shortGap).toBeLessThanOrEqual(6);

    const longMetrics = await page.locator('.session-tab[data-id="long"]').evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.activeSessionId = 'long';
      controller._fullRenderSessionTabs();
      const longTab = document.querySelector('.session-tab[data-id="long"]')!;
      const name = longTab.querySelector('.tab-name') as HTMLElement;
      // Pin width truncation independently of the rail's normal two-line wrapping.
      name.style.whiteSpace = 'nowrap';
      const actions = longTab.querySelector('.tab-actions')!;
      const lastVisibleAction = [...actions.children]
        .filter((child) => {
          const control = child as HTMLElement;
          const style = getComputedStyle(control);
          return style.display !== 'none' && style.visibility !== 'hidden' && control.getBoundingClientRect().width > 0;
        })
        .at(-1) as HTMLElement;
      const nameRect = name.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      const rowRect = longTab.getBoundingClientRect();
      return {
        nameClientWidth: name.clientWidth,
        nameScrollWidth: name.scrollWidth,
        nameRight: nameRect.right,
        actionsLeft: actionsRect.left,
        lastVisibleActionRight: lastVisibleAction.getBoundingClientRect().right,
        rowRight: rowRect.right,
      };
    });
    expect.soft(longMetrics.nameScrollWidth).toBeGreaterThan(longMetrics.nameClientWidth);
    expect.soft(longMetrics.nameRight).toBeLessThanOrEqual(longMetrics.actionsLeft);
    expect.soft(longMetrics.lastVisibleActionRight).toBeLessThanOrEqual(longMetrics.rowRight + 0.5);

    const nonNameBaseline = await page.evaluate(() => ({
      groupHeading: getComputedStyle(document.querySelector('.tab-layout-group-name')!).fontSize,
      groupCount: getComputedStyle(document.querySelector('.tab-layout-group-count')!).fontSize,
    }));

    for (const size of [11, 18]) {
      const computedSizes = await page.evaluate((value) => {
        const controller = (window as any).__cod339Controller;
        controller.__cod339Settings.sessionSidebarFontSize = value;
        controller.applySessionSidebarFontSize();
        return {
          name: getComputedStyle(document.querySelector('.tab-rail .session-tab .tab-name')!).fontSize,
          groupHeading: getComputedStyle(document.querySelector('.tab-layout-group-name')!).fontSize,
          groupCount: getComputedStyle(document.querySelector('.tab-layout-group-count')!).fontSize,
        };
      }, size);
      expect.soft(computedSizes.name).toBe(`${size}px`);
      expect.soft(computedSizes.groupHeading).toBe(nonNameBaseline.groupHeading);
      expect.soft(computedSizes.groupCount).toBe(nonNameBaseline.groupCount);
    }
  });

  it('keeps actions as a direct tab child in the horizontal header', async () => {
    const parentClass = await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.__cod339Settings = { sessionListLayout: 'header', tabOrientation: 'horizontal' };
      document.documentElement.dataset.tabOrientation = 'horizontal';
      controller.applySessionListLayout();
      controller._fullRenderSessionTabs();
      return document.querySelector('.session-tab[data-id="short"] .tab-actions')?.parentElement?.className;
    });
    expect(parentClass).toContain('session-tab');
    expect(parentClass).not.toContain('tab-name-row');
  });

  it('keeps actions as a direct tab child in the compact vertical rail', async () => {
    const parentClass = await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.__cod339Settings = { sessionListLayout: 'header', tabOrientation: 'vertical' };
      document.documentElement.dataset.tabOrientation = 'vertical';
      document.documentElement.classList.add('tab-rail-compact');
      controller.applySessionListLayout();
      controller._fullRenderSessionTabs();
      return document.querySelector('.session-tab[data-id="short"] .tab-actions')?.parentElement?.className;
    });
    expect(parentClass).toContain('session-tab');
    expect(parentClass).not.toContain('tab-name-row');
  });

  it('rebuilds action placement when the vertical rail crosses the compact threshold', async () => {
    const parentClasses = await page.evaluate(() => {
      const controller = (window as any).__cod339Controller;
      controller.__cod339Settings = { sessionListLayout: 'header', tabOrientation: 'vertical' };
      document.documentElement.dataset.tabOrientation = 'vertical';
      document.documentElement.classList.remove('tab-rail-compact');
      controller.applySessionListLayout();
      controller._fullRenderSessionTabs();
      const full = document.querySelector('.session-tab[data-id="short"] .tab-actions')?.parentElement?.className;
      controller._setTabRailWidth(220);
      const compact = document.querySelector('.session-tab[data-id="short"] .tab-actions')?.parentElement?.className;
      controller._setTabRailWidth(300);
      const expanded = document.querySelector('.session-tab[data-id="short"] .tab-actions')?.parentElement?.className;
      return { full, compact, expanded };
    });
    expect.soft(parentClasses.full).toContain('tab-name-row');
    expect.soft(parentClasses.compact).toContain('session-tab');
    expect.soft(parentClasses.compact).not.toContain('tab-name-row');
    expect.soft(parentClasses.expanded).toContain('tab-name-row');
  });

  it('reveals and opens nested session actions contextually on expanded vertical surfaces', async () => {
    for (const surface of ['sidebar', 'rail'] as const) {
      await applyExpandedSurface(surface);
      const longTab = page.locator('.session-tab[data-id="long"]');

      expect(await tabMoreState(page)).toEqual({ visibility: 'hidden', pointerEvents: 'none' });

      await longTab.hover();
      expect(await tabMoreState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
      try {
        await longTab.locator('.tab-more').click();
        expect(await page.locator('.tab-rail-action-menu').count()).toBe(1);
      } finally {
        await page.evaluate(() => (window as any).__cod339Controller.closeTabRailActionMenu());
      }
      expect(await page.locator('.tab-rail-action-menu').count()).toBe(0);

      await page.mouse.move(1200, 760);
      expect(await longTab.evaluate((element) => element.matches(':hover'))).toBe(false);
      await longTab.focus();
      expect(await tabMoreState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.evaluate(() => {
        const controller = (window as any).__cod339Controller;
        controller.activeSessionId = 'long';
        controller._fullRenderSessionTabs();
      });
      expect(await tabMoreState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
    }
  });

  it('keeps nested session actions reachable for coarse pointers', async () => {
    const touchContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    try {
      const touchPage = await touchContext.newPage();
      for (const surface of ['sidebar', 'rail'] as const) {
        await applyExpandedSurface(surface);
        const fixture = await page.locator('html').evaluate((element) => {
          const clone = element.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('script').forEach((script) => script.remove());
          return `<!doctype html>${clone.outerHTML}`;
        });
        await touchPage.setContent(fixture);
        expect(await tabMoreState(touchPage)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
      }
    } finally {
      await touchContext.close();
    }
  });

  it('closes the real action menu when viewport geometry changes', async () => {
    await applyExpandedSurface('rail');
    const tab = page.locator('.session-tab[data-id="long"]');
    await tab.hover();
    await tab.locator('.tab-more').click();
    expect(await page.locator('.tab-rail-action-menu').count()).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    expect(await page.locator('.tab-rail-action-menu').count()).toBe(0);
  });
});
