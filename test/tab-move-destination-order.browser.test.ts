/**
 * @fileoverview COD-335: the move menu's destinations must read in the same
 * order as the left navigation's sections.
 *
 * This is a visual-ordering bug, so the assertion is on RENDERED order from both
 * surfaces — the rail's section headings and the menu's `menuitem` labels, each
 * read out of the DOM — rather than on what a builder function returns. A unit
 * test that compared two arrays would have agreed with itself just as happily
 * while the two surfaces still disagreed on screen.
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
const railSource = readFileSync(resolve(publicDir, 'tab-rail-resize.js'), 'utf8');
const webviews = readFileSync(resolve(publicDir, 'webview-tabs.js'), 'utf8');

/** The reporter's own example, which is what the ticket's ACs are written against. */
const GROUP_NAMES = ['SP', 'codeman', 'ingestion', 'events', 'planning'];

describe('COD-335 move destinations follow the left navigation in Chromium', () => {
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
        '\nwindow.CodemanApp = CodemanApp; window.__setCod335App = value => { app = value; };',
    });
    await page.evaluate((groupNames) => {
      const controller = Object.create((window as any).CodemanApp.prototype);
      controller.$ = (id: string) => document.getElementById(id);
      controller.sessions = new Map([['s1', { id: 's1', name: 'Session one', status: 'idle', mode: 'claude' }]]);
      controller.webviews = new Map();
      controller.webviewOrder = [];
      controller.activeSessionId = 's1';
      controller.activeWebviewId = null;
      controller.tabLayout = {
        version: 1,
        updatedAt: '2026-08-19T00:00:00.000Z',
        // `s1` lives in the FIRST group, so a menu that merely happened to put
        // the current group first would not be mistaken for correct ordering.
        groups: groupNames.map((name, index) => ({
          id: name,
          name,
          refs: index === 0 ? [{ kind: 'session', id: 's1' }] : [],
        })),
        ungrouped: [],
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
      controller.selectSession = () => undefined;
      controller.openWebview = () => undefined;
      controller._tabLayoutEditCoordinator = null;
      controller._apiPut = async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) });
      controller._fullRenderSessionTabs();
      (window as any).__setCod335App(controller);
      (window as any).__cod335Controller = controller;
    }, GROUP_NAMES);
  });

  afterAll(async () => {
    await page?.close();
    await browser?.close();
  });

  /** Section names as the left navigation actually paints them, top to bottom. */
  async function railOrder(): Promise<string[]> {
    // The name lives in `.tab-layout-group-label` inside the header; the
    // `[data-tab-group-header]` element itself is the collapse toggle and has no
    // text, so reading it yields five empty strings that compare equal to each
    // other and prove nothing.
    return page!.evaluate(() =>
      [...document.querySelectorAll('#sessionTabs .tab-layout-group-header .tab-layout-group-label')].map((element) =>
        (element.textContent || '').trim()
      )
    );
  }

  /** Destination labels as the open menu actually paints them, top to bottom. */
  async function menuDestinations(): Promise<string[]> {
    await page!.evaluate(() => {
      document.querySelector('.tab-layout-ref-move-menu')?.remove();
      (window as any).__cod335Controller.openTabRefMoveMenu(null, { kind: 'session', id: 's1' });
    });
    return page!.evaluate(() =>
      [...document.querySelectorAll('.tab-layout-ref-move-menu [role="menuitem"]')]
        .map((element) => (element.textContent || '').trim())
        .filter((label) => label.startsWith('Move to '))
    );
  }

  it('paints destinations in the rail order, with Ungrouped last', async () => {
    const rail = await railOrder();
    expect(rail).toEqual(GROUP_NAMES);

    const destinations = await menuDestinations();
    // Derived from the rail's own rendered order, so this cannot pass while the
    // two surfaces disagree — including the AC's "Ungrouped after planning".
    expect(destinations).toEqual([...rail.map((name) => `Move to ${name}`), 'Move to Ungrouped']);
  });

  it('follows a group reorder on the next open, without a reload', async () => {
    await page!.evaluate(() => {
      const controller = (window as any).__cod335Controller;
      controller.tabLayout = (window as any).CodemanTabLayout.applyOperation(controller.tabLayout, {
        type: 'reorderGroup',
        groupId: 'planning',
        index: 0,
      });
      controller._fullRenderSessionTabs();
    });

    const rail = await railOrder();
    expect(rail[0]).toBe('planning');
    expect(await menuDestinations()).toEqual([...rail.map((name) => `Move to ${name}`), 'Move to Ungrouped']);
  });

  it('is unchanged by collapsing every group', async () => {
    const expanded = await menuDestinations();
    await page!.evaluate(() => {
      const controller = (window as any).__cod335Controller;
      controller.collapsedTabGroupIds = new Set(controller.tabLayout.groups.map((group: { id: string }) => group.id));
      controller._fullRenderSessionTabs();
    });
    // Collapse changes what the rail draws INSIDE a section, never section order.
    expect(await railOrder()).toEqual(expanded.map((label) => label.replace('Move to ', '')).slice(0, -1));
    expect(await menuDestinations()).toEqual(expanded);
  });
});
