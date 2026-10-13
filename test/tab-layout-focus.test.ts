/**
 * @fileoverview Focus, placement and first-paint on the grouped vertical rail
 * (COD-509, COD-510, COD-512), restored on top of the upstream rail.
 *
 * Two halves, like tab-layout-editing.test.ts:
 *  - the pure module (tab-layout-browser.js, vm-loaded): Focus and placement
 *    survive a whole-layout save, the Focus/placement operations mirror the
 *    server, the projection draws Focus first and once, Alt+N leads with it,
 *    and drops into/out of Focus map to the right operations;
 *  - the app.js wiring through the shipping CodemanApp inside JSDOM: the Focus
 *    section and its collapse, Alt+N, the row menu, placement badges and
 *    "Follow parent again", create-in-group, and the first-paint hold.
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import Fastify from 'fastify';
import { TabLayoutService } from '../src/tab-layout-service.js';
import { registerTabLayoutRoutes } from '../src/web/routes/tab-layout-routes.js';
import type { TabLayout } from '../src/tab-layout.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

type Ref = { kind: 'session' | 'webview'; id: string; placement?: 'manual'; focus?: true };
type Layout = {
  version: number;
  updatedAt: string;
  groups: Array<{ id: string; name: string; refs: Ref[] }>;
  ungrouped: Ref[];
  focusOrder?: Ref[];
};

const s = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'session', id, ...extra });
const w = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'webview', id, ...extra });
const keys = (refs: Ref[]) => refs.map((ref) => `${ref.kind}:${ref.id}`);

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {} });
  vm.runInContext(read('tab-layout-browser.js'), context, { filename: 'tab-layout-browser.js' });
  return (context.window as any).CodemanTabLayout;
}

const TL = loadHelper();

const focusLayout = (version = 8): Layout => ({
  version,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [
    { id: 'gx', name: 'Core', refs: [s('s2'), w('w1', { focus: true })] },
    { id: 'gy', name: 'Later', refs: [s('s4', { focus: true })] },
  ],
  ungrouped: [s('s1'), s('s3')],
  focusOrder: [s('s4'), w('w1')],
});

describe('Focus survives the browser round trip', () => {
  it('keeps focus flags, the Focus order and manual placement through normalizeLayout', () => {
    const input = focusLayout();
    input.ungrouped[0] = s('s1', { placement: 'manual' });
    const normalized = TL.normalizeLayout(input);
    expect(normalized.groups[1].refs[0]).toEqual(s('s4', { focus: true }));
    expect(normalized.groups[0].refs[1]).toEqual(w('w1', { focus: true }));
    expect(normalized.ungrouped[0]).toEqual(s('s1', { placement: 'manual' }));
    expect(normalized.focusOrder).toEqual([s('s4'), w('w1')]);
  });

  it('a group edit PUTs the focus flags and Focus order it did not touch', async () => {
    const puts: any[] = [];
    const editor = TL.createEditCoordinator({
      initialLayout: focusLayout(),
      put: async (request: any) => {
        puts.push(request);
        return { ok: true, status: 200, layout: { ...request.layout, version: request.baseVersion + 1 } };
      },
      applyLayout: () => {},
      schedule: (fn: () => void) => setTimeout(fn, 0),
    });
    editor.enqueue({ type: 'renameGroup', groupId: 'gy', name: 'Soon' });
    await editor.flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].layout.groups[1]).toEqual({ id: 'gy', name: 'Soon', refs: [s('s4', { focus: true })] });
    expect(puts[0].layout.groups[0].refs[1]).toEqual(w('w1', { focus: true }));
    expect(puts[0].layout.focusOrder).toEqual([s('s4'), w('w1')]);
  });

  it('counts a Focus change as a content change', () => {
    const before = focusLayout();
    const after = TL.applyOperation(before, { type: 'moveFocus', ref: w('w1'), index: 0 });
    expect(TL.contentKey(after)).not.toBe(TL.contentKey(before));
  });
});

describe('Focus and placement operations mirror the server', () => {
  it('setFocus adds at the end and removing prunes the explicit order', () => {
    const added = TL.applyOperation(focusLayout(), { type: 'setFocus', ref: s('s1'), focused: true });
    expect(keys(TL.orderedFocusRefs(added))).toEqual(['session:s4', 'webview:w1', 'session:s1']);
    const removed = TL.applyOperation(added, { type: 'setFocus', ref: s('s4'), focused: false });
    expect(removed.groups[1].refs[0]).toEqual(s('s4'));
    expect(removed.focusOrder).toEqual([w('w1')]);
    expect(keys(TL.orderedFocusRefs(removed))).toEqual(['webview:w1', 'session:s1']);
    // Leaving Focus leaves the stored group position alone.
    expect(keys(removed.groups[1].refs)).toEqual(['session:s4']);
  });

  it('moveFocus reorders Focus without moving the stored refs', () => {
    const moved = TL.applyOperation(focusLayout(), { type: 'moveFocus', ref: w('w1'), index: 0 });
    expect(keys(TL.orderedFocusRefs(moved))).toEqual(['webview:w1', 'session:s4']);
    expect(keys(moved.groups[0].refs)).toEqual(['session:s2', 'webview:w1']);
    expect(() => TL.applyOperation(focusLayout(), { type: 'moveFocus', ref: s('s1'), index: 0 })).toThrow(
      /not in Focus/
    );
  });

  it('setManualPlacement marks a ref, and followParent clears it and lands it after its parent', () => {
    const parents = { kid: 's1' };
    const base: Layout = { ...focusLayout(), ungrouped: [s('s1'), s('s3')] };
    base.groups[1].refs.push(s('kid'));
    const manual = TL.applyOperation(base, { type: 'setManualPlacement', ref: s('kid'), manual: true });
    expect(manual.groups[1].refs[1]).toEqual(s('kid', { placement: 'manual' }));
    const followed = TL.applyOperation(manual, { type: 'followParent', ref: s('kid'), parents });
    expect(keys(followed.groups[1].refs)).toEqual(['session:s4']);
    expect(keys(followed.ungrouped)).toEqual(['session:s1', 'session:kid', 'session:s3']);
    expect(followed.ungrouped[1]).toEqual(s('kid'));
    expect(() => TL.applyOperation(manual, { type: 'followParent', ref: s('s3'), parents })).toThrow(/no parent/);
  });
});

describe('describePlacements', () => {
  it('reports inherited, manual, dangling and cycle children only', () => {
    const layout: Layout = {
      version: 1,
      updatedAt: 'x',
      groups: [{ id: 'g', name: 'G', refs: [s('p'), s('kid'), s('moved', { placement: 'manual' })] }],
      ungrouped: [s('orphan'), s('a'), s('b'), s('lone')],
    };
    const placements = TL.describePlacements(layout, {
      kid: 'p',
      moved: 'p',
      orphan: 'gone',
      a: 'b',
      b: 'a',
    });
    expect(placements).toEqual({
      'session:kid': { state: 'inherited', parentId: 'p', canFollow: false },
      'session:moved': { state: 'manual', parentId: 'p', canFollow: true },
      'session:orphan': { state: 'dangling', parentId: 'gone', canFollow: false },
      'session:a': { state: 'cycle', parentId: 'b', canFollow: false },
      'session:b': { state: 'cycle', parentId: 'a', canFollow: false },
    });
  });
});

describe('Focus projection', () => {
  const live = ['s1', 's2', 's3', 's4'];

  it('draws Focus first, in Focus order, and each focused row only there', () => {
    const projection = TL.project(focusLayout(), { liveSessionIds: live, openWebviewIds: ['w1'] });
    expect(projection.sections.map((section: any) => section.id)).toEqual([':focus', 'gx', 'gy', null]);
    expect(keys(projection.sections[0].refs)).toEqual(['session:s4', 'webview:w1']);
    expect(keys(projection.sections[1].refs)).toEqual(['session:s2']);
    expect(projection.sections[2].count).toBe(0);
    expect(keys(projection.focusRefs)).toEqual(['session:s4', 'webview:w1']);
    expect(projection.sectionByRef['session:s4']).toBe(':focus');
  });

  it('skips a focused web tab that is not open here', () => {
    const projection = TL.project(focusLayout(), { liveSessionIds: live, openWebviewIds: [] });
    expect(keys(projection.focusRefs)).toEqual(['session:s4']);
  });

  it('a collapsed Focus hides its rows except the selection', () => {
    const projection = TL.project(focusLayout(), {
      liveSessionIds: live,
      openWebviewIds: ['w1'],
      focusCollapsed: true,
      activeSessionId: 's4',
    });
    expect(keys(projection.sections[0].refs)).toEqual(['session:s4']);
    expect(keys(projection.sections[0].hidden)).toEqual(['webview:w1']);
    expect(projection.hiddenTabGroupByRef).toEqual({ 'webview:w1': ':focus' });
  });

  it('Focus alone (no named group) still projects, with no Ungrouped divider', () => {
    const layout: Layout = { version: 2, updatedAt: 'x', groups: [], ungrouped: [s('s1'), s('s2', { focus: true })] };
    const projection = TL.project(layout, { liveSessionIds: ['s1', 's2'], openWebviewIds: [] });
    expect(projection.sections.map((section: any) => section.id)).toEqual([':focus', null]);
    expect(projection.sections[1].headless).toBe(true);
    const html = TL.renderProjection(
      projection,
      (ref: Ref) => `<i data-ref="${ref.id}"></i>`,
      (v: string) => v
    );
    expect(html).not.toContain('Ungrouped');
    expect(html).toContain('data-tab-group-header=":focus"');
    // Nothing focused and no group: the flat rail, as before.
    expect(TL.project({ ...layout, ungrouped: [s('s1'), s('s2')] }, { liveSessionIds: ['s1'] })).toBeNull();
  });

  it('Alt+N order leads with Focus, then sessions, then web tabs', () => {
    const projection = TL.project(focusLayout(), { liveSessionIds: live, openWebviewIds: ['w1'] });
    expect(keys(TL.altRefs(projection, live, ['w1']))).toEqual([
      'session:s4',
      'webview:w1',
      'session:s1',
      'session:s2',
      'session:s3',
    ]);
    expect(keys(TL.altRefs(null, ['s1', 's2'], ['w1']))).toEqual(['session:s1', 'session:s2', 'webview:w1']);
  });

  it('the Focus header is a treeitem with collapse wiring and no group menu', () => {
    const projection = TL.project(focusLayout(), { liveSessionIds: live, openWebviewIds: ['w1'] });
    const html = TL.renderProjection(
      projection,
      () => '',
      (v: string) => v
    );
    const focusSection = html.slice(0, html.indexOf('data-tab-group-id="gx"'));
    expect(focusSection).toContain('role="treeitem"');
    expect(focusSection).toContain('aria-expanded="true"');
    expect(focusSection).toContain('app.toggleTabGroupCollapsed');
    expect(focusSection).not.toContain('openTabGroupMenu');
  });
});

describe('dropOperation and Focus', () => {
  const layout = focusLayout();

  it('a row dropped on the Focus header joins Focus', () => {
    expect(TL.dropOperation(layout, { type: 'ref', ref: s('s1') }, { type: 'group', groupId: ':focus' })).toEqual({
      type: 'setFocus',
      ref: s('s1'),
      focused: true,
    });
    // Already in Focus: nothing to do.
    expect(TL.dropOperation(layout, { type: 'ref', ref: s('s4') }, { type: 'group', groupId: ':focus' })).toBeNull();
  });

  it('a row dropped on a Focus row joins Focus at that slot', () => {
    const operation = TL.dropOperation(
      layout,
      { type: 'ref', ref: s('s1') },
      { type: 'ref', ref: s('s4'), groupId: ':focus', placement: 'before' }
    );
    expect(operation).toEqual([
      { type: 'setFocus', ref: s('s1'), focused: true },
      { type: 'moveFocus', ref: s('s1'), index: 0 },
    ]);
  });

  it('a Focus row dropped on another Focus row reorders Focus', () => {
    expect(
      TL.dropOperation(
        layout,
        { type: 'ref', ref: w('w1') },
        { type: 'ref', ref: s('s4'), groupId: ':focus', placement: 'before' }
      )
    ).toEqual({ type: 'moveFocus', ref: w('w1'), index: 0 });
  });

  it('a Focus row dragged out leaves Focus and lands where dropped', () => {
    const operation = TL.dropOperation(layout, { type: 'ref', ref: s('s4') }, { type: 'ungrouped' });
    expect(operation[0]).toEqual({ type: 'setFocus', ref: s('s4'), focused: false });
    expect(operation[1]).toMatchObject({ type: 'moveRef', ref: s('s4'), groupId: null });
    // Dropped on its own (stored) group: only leaves Focus.
    expect(TL.dropOperation(layout, { type: 'ref', ref: s('s4') }, { type: 'group', groupId: 'gy' })).toEqual({
      type: 'setFocus',
      ref: s('s4'),
      focused: false,
    });
  });

  it('the Focus header is not a draggable group and takes no group', () => {
    expect(TL.dropOperation(layout, { type: 'group', groupId: ':focus' }, { type: 'group', groupId: 'gy' })).toBeNull();
    expect(TL.dropOperation(layout, { type: 'group', groupId: 'gy' }, { type: 'group', groupId: ':focus' })).toBeNull();
  });
});

// ─── app.js wiring ──────────────────────────────────────────────────────

let win: any;
let CodemanApp: any;
let document: Document;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  win = dom.window;
  document = win.document;
  // The harness builds its own controller; suppress the page's automatic boot.
  document.addEventListener('DOMContentLoaded', (event) => event.stopImmediatePropagation(), { once: true });
  win.setInterval = () => 0;
  win.requestAnimationFrame = () => 0;
  win.CSS = { escape: (value: string) => value };
  win.eval(
    'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
      'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
      read('constants.js') +
      '\n' +
      read('tab-layout-browser.js') +
      '\n' +
      read('app.js') +
      '\n' +
      read('tab-rail-resize.js') +
      '\n' +
      read('api-client.js') +
      '\n' +
      read('webview-tabs.js') +
      '\n;window.__FocusCodemanApp = CodemanApp;'
  );
  CodemanApp = win.__FocusCodemanApp;
});

function installFetch() {
  const puts: any[] = [];
  let saved = focusLayout();
  win.fetch = vi.fn(async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (init?.method === 'PUT') puts.push(body);
    const next = body?.operations
      ? body.operations.reduce((layout: Layout, operation: any) => TL.applyOperation(layout, operation), saved)
      : body?.layout;
    saved = { ...next, version: (body?.baseVersion ?? 0) + 1 };
    const payload = { success: true, data: { layout: saved } };
    return { ok: true, status: 200, json: async () => payload };
  });
  return puts;
}

function makeApp(layout: unknown = focusLayout(), sessions?: Array<Record<string, unknown>>) {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', 'vertical');
  document.documentElement.dataset.tabRailSort = 'manual';
  document.body.innerHTML = '<div id="sessionTabs" role="tablist" aria-label="Session tabs"></div>';
  app.$ = (id: string) => document.getElementById(id);
  const rows = sessions || [
    { id: 's1', name: 'One', status: 'idle' },
    { id: 's2', name: 'Two', status: 'busy' },
    { id: 's3', name: 'Three', status: 'idle' },
    { id: 's4', name: 'Four', status: 'idle' },
  ];
  app.sessions = new Map(rows.map((row) => [row.id as string, row]));
  app.sessionOrder = rows.map((row) => row.id);
  app.webviews = new Map([['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test' }]]);
  app.webviewOrder = ['w1'];
  app.activeSessionId = 's2';
  app.activeWebviewId = null;
  app.tabLayout = null;
  app.collapsedTabGroupIds = new Set();
  app._hiddenTabGroupByRef = new Map();
  app._lastTabGroupStructureKey = null;
  app._tabCollapseStorageFailed = false;
  app._inlineRenameActive = false;
  app.tabAlerts = new Map();
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => {};
  app.updateTabOverflowMode = () => {};
  app.updateConnectionLines = () => {};
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  app.applySidebarFilter = () => {};
  app.isSessionSidebarActive = () => false;
  app._startSidebarRichClock = () => {};
  app._stopSidebarRichClock = () => {};
  app.loadAppSettingsFromStorage = () => ({});
  app.openSessionOptions = vi.fn();
  app.requestCloseSession = vi.fn();
  app.selectSession = vi.fn();
  app.openWebview = vi.fn();
  app.showWebviewModal = vi.fn();
  app.showToast = vi.fn();
  app.closeAllPanels = vi.fn();
  app._fullRenderSessionTabs();
  if (layout) app._applyTabLayout(layout);
  return app;
}

const row = (id: string) => document.querySelector<HTMLElement>(`.session-tab[data-id="${id}"]`)!;
const menuLabels = () => [...document.querySelectorAll('.tab-rail-action-menu button')].map((b) => b.textContent);
const clickMenu = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.tab-rail-action-menu button')]
    .find((b) => b.textContent === label)!
    .click();
const key = (target: Element, k: string, init: Record<string, unknown> = {}) =>
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const openRowMenu = (app: Record<string, any>, id: string) =>
  app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row(id) }, id);

beforeEach(() => {
  win.localStorage.clear();
  win.sessionStorage.clear();
  document.body.innerHTML = '';
  win.__codemanUser = { username: 'admin', role: 'admin', multiUser: false };
});

afterEach(() => {
  document.querySelectorAll('.tab-rail-action-menu').forEach((menu) => menu.remove());
});

describe('Focus section on the rail (COD-509)', () => {
  it('COD-515 keeps a session in Focus after the real save response and reload', async () => {
    const api = Fastify();
    let saved = focusLayout() as TabLayout;
    let order = ['s1', 's2', 's3', 's4'];
    const service = new TabLayoutService({
      store: {
        getTabLayout: () => saved,
        getTabLayouts: () => ({ '@single': saved }),
        getSessions: () => Object.fromEntries(order.map((id, index) => [id, { id, createdAt: index }])),
        getSessionOrder: () => order,
        commitTabLayoutProjection: (updates: Record<string, TabLayout>, project: (ids: string[]) => string[]) => {
          saved = updates['@single'];
          order = project(order);
          return { layouts: updates, sessionOrder: order };
        },
      } as never,
      sessions: new Map(),
      readWebviews: async () => [{ id: 'w1' }],
      broadcast: () => {},
      broadcastSessionOrder: () => {},
      now: () => '2026-10-12T00:00:00.000Z',
    });
    registerTabLayoutRoutes(api, { tabLayouts: service });
    const statuses: number[] = [];
    win.fetch = vi.fn(async (url: string, init: any) => {
      const response = await api.inject({
        method: init?.method || 'GET',
        url,
        payload: init?.body ? JSON.parse(init.body) : undefined,
      });
      statuses.push(response.statusCode);
      expect([200, 409]).toContain(response.statusCode);
      return { ok: response.statusCode === 200, status: response.statusCode, json: async () => response.json() };
    });
    const app = makeApp();
    try {
      // Another client changed the group while this browser held version 8.
      saved = {
        ...saved,
        version: 9,
        groups: saved.groups.map((group) => (group.id === 'gx' ? { ...group, name: 'Renamed elsewhere' } : group)),
      };
      openRowMenu(app, 's2');
      clickMenu('Add to Focus');
      await app._tabLayoutEditor.flush();
      expect(statuses).toEqual([409, 200]);
      expect(saved.groups[0].name).toBe('Renamed elsewhere');
      expect(row('s2').closest('[data-tab-focus-group]')).not.toBeNull();
      expect(saved.groups[0].refs[0].focus).toBe(true);
      await app._loadTabLayout();
      expect(row('s2').closest('[data-tab-focus-group]')).not.toBeNull();
      app.moveFocusRefBy(s('s2'), -1);
      await app._tabLayoutEditor.flush();
      expect(saved.focusOrder).toEqual([s('s4'), s('s2'), w('w1')]);
      openRowMenu(app, 's2');
      clickMenu('Remove from Focus');
      await app._tabLayoutEditor.flush();
      expect(saved.groups[0].refs[0].focus).toBeUndefined();
      expect(row('s2').closest('[data-tab-group-id="gx"]')).not.toBeNull();
      // A page closing before its queued save flushes must persist the same intent.
      openRowMenu(app, 's2');
      clickMenu('Add to Focus');
      app._persistPendingTabLayoutEdits();
      app._tabLayoutEditor.dispose();
      const keepaliveResponse = await win.fetch.mock.results.at(-1).value;
      expect(keepaliveResponse.status).toBe(200);
      expect(saved.groups[0].refs[0].focus).toBe(true);
      makeApp(saved);
      expect(row('s2').closest('[data-tab-focus-group]')).not.toBeNull();
    } finally {
      app._tabLayoutEditor?.dispose();
      await api.close();
    }
  });

  it('renders Focus on top with a star on its rows, numbered first', () => {
    makeApp();
    const sections = [...document.querySelectorAll<HTMLElement>('.tab-layout-group')].map(
      (el) => el.dataset.tabGroupId
    );
    expect(sections).toEqual([':focus', 'gx', 'gy', '']);
    const focusRows = [...document.querySelectorAll<HTMLElement>('[data-tab-focus-group] .session-tab')];
    expect(focusRows.map((el) => el.dataset.id || el.dataset.webviewId)).toEqual(['s4', 'w1']);
    expect(focusRows.every((el) => el.querySelector('.tab-focus-marker'))).toBe(true);
    // One row per tab: a focused row is not drawn in its group as well.
    expect(document.querySelectorAll('.session-tab[data-id="s4"]')).toHaveLength(1);
    const badge = (el: Element | null) => el?.querySelector('.tab-number')?.textContent;
    expect(badge(row('s4'))).toBe('1');
    expect(badge(document.querySelector('.session-tab[data-webview-id="w1"]'))).toBe('2');
    expect(badge(row('s1'))).toBe('3');
    expect(badge(row('s3'))).toBe('5');
  });

  it('Alt+N targets lead with Focus (the keydown handler indexes _tabAltRefs)', () => {
    const app = makeApp();
    expect(read('app.js')).toContain('const target = this._tabAltRefs()[idx];');
    expect(app._tabAltRefs().slice(0, 3)).toEqual([s('s4'), w('w1'), s('s1')]);
  });

  it('collapses Focus per device, keeping the selection visible', () => {
    const app = makeApp();
    app.activeSessionId = 's4';
    app.toggleTabGroupCollapsed(':focus');
    expect(win.localStorage.getItem('codeman:focus-group-collapsed')).toBe('true');
    expect(row('s4')).not.toBeNull();
    expect(document.querySelector('.session-tab[data-webview-id="w1"]')).toBeNull();
    expect(document.querySelector('[data-tab-group-header=":focus"]')!.getAttribute('aria-expanded')).toBe('false');
    app.toggleTabGroupCollapsed(':focus');
    expect(document.querySelector('.session-tab[data-webview-id="w1"]')).not.toBeNull();
  });

  it('"Add to Focus" saves its semantic intent and keeps the existing Focus', async () => {
    const puts = installFetch();
    const app = makeApp();
    openRowMenu(app, 's1');
    expect(menuLabels()).toContain('Add to Focus');
    clickMenu('Add to Focus');
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0]).toEqual({ baseVersion: 8, operations: [{ type: 'setFocus', ref: s('s1'), focused: true }] });
    expect(app.tabLayout.ungrouped[0]).toEqual(s('s1', { focus: true }));
    expect(app.tabLayout.groups[1].refs[0]).toEqual(s('s4', { focus: true }));
    expect(app.tabLayout.focusOrder).toEqual([s('s4'), w('w1')]);
    expect(row('s1').closest('[data-tab-focus-group]')).not.toBeNull();
  });

  it('a Focus row offers removal and Focus moves, not group moves', async () => {
    const puts = installFetch();
    const app = makeApp();
    openRowMenu(app, 's4');
    expect(menuLabels()).toEqual([
      'Session options',
      'Remove from Focus',
      'Move down in Focus',
      'Move to "Core"',
      'Move to Ungrouped',
      'Move to new group',
      'Close session',
    ]);
    clickMenu('Move down in Focus');
    await flush();
    expect(puts[0].operations).toEqual([{ type: 'moveFocus', ref: s('s4'), index: 1 }]);
    expect(app.tabLayout.focusOrder).toEqual([w('w1'), s('s4')]);
  });

  it('Alt+ArrowUp on a Focus row reorders Focus from the keyboard', async () => {
    const puts = installFetch();
    const app = makeApp();
    app.setupTabKeyboardNavigation(document.getElementById('sessionTabs'));
    const web = document.querySelector<HTMLElement>('.session-tab[data-webview-id="w1"]')!;
    web.focus();
    key(web, 'ArrowUp', { altKey: true });
    await flush();
    expect(puts[0].operations).toEqual([{ type: 'moveFocus', ref: w('w1'), index: 0 }]);
    expect(app.tabLayout.focusOrder).toEqual([w('w1'), s('s4')]);
    // A row outside Focus: the chord does nothing.
    key(row('s1'), 'ArrowUp', { altKey: true });
    await flush();
    expect(puts).toHaveLength(1);
  });
});

describe('placement badges and Follow parent again (COD-510)', () => {
  const lineage = (): Layout => ({
    version: 3,
    updatedAt: 'x',
    groups: [{ id: 'g', name: 'Work', refs: [s('p'), s('kid')] }],
    ungrouped: [s('moved', { placement: 'manual' })],
  });
  const sessions = [
    { id: 'p', name: 'Parent', status: 'idle' },
    { id: 'kid', name: 'Kid', status: 'idle', parentSessionId: 'p' },
    { id: 'moved', name: 'Moved', status: 'idle', parentSessionId: 'p' },
  ];

  it('badges a child row and names its placement in the tooltip and accessible name', () => {
    makeApp(lineage(), sessions);
    const kid = row('kid');
    expect(kid.querySelector('.tab-placement-state')!.textContent).toBe('Follows parent');
    expect(kid.getAttribute('aria-label')).toContain('Follows parent Parent');
    expect(kid.title).toContain('Follows parent Parent');
    const moved = row('moved');
    expect(moved.querySelector('.tab-placement-state--manual')!.textContent).toBe('Manual');
    expect(moved.getAttribute('aria-label')).toContain('Placed manually; can follow Parent');
    expect(row('p').querySelector('.tab-placement-state')).toBeNull();
  });

  it('"Follow parent again" clears the manual placement and files it after the parent', async () => {
    const puts = installFetch();
    const app = makeApp(lineage(), sessions);
    openRowMenu(app, 'moved');
    expect(menuLabels()).toContain('Placed manually; can follow Parent');
    clickMenu('Follow parent again');
    await flush();
    expect(puts).toHaveLength(1);
    expect(keys(puts[0].layout.groups[0].refs)).toEqual(['session:p', 'session:moved', 'session:kid']);
    expect(puts[0].layout.ungrouped).toEqual([]);
    expect(puts[0].layout.groups[0].refs[1]).toEqual(s('moved'));
  });

  it('an inherited child offers no "Follow parent again"', () => {
    const app = makeApp(lineage(), sessions);
    openRowMenu(app, 'kid');
    expect(menuLabels()).toContain('Follows parent Parent');
    expect(menuLabels()).not.toContain('Follow parent again');
  });
});

describe('create a session in a group (COD-512)', () => {
  it('"New session in group" runs with the group id and opens a collapsed group', async () => {
    installFetch();
    const app = makeApp();
    app.collapsedTabGroupIds = new Set(['gx']);
    app.run = vi.fn(async () => {});
    await app.createSessionInTabGroup('gx');
    expect(app.run).toHaveBeenCalledWith({ tabGroupId: 'gx' });
    expect(app.collapsedTabGroupIds.has('gx')).toBe(false);
    expect(await app.createSessionInTabGroup('nope')).toBe(false);
    app._runInFlight = true;
    expect(await app.createSessionInTabGroup('gx')).toBe(false);
    expect(app.run).toHaveBeenCalledTimes(1);
  });
});

describe('first-paint hold (COD-512)', () => {
  it('paints nothing on the vertical rail until the first layout read settles', () => {
    installFetch();
    const app = makeApp(null);
    app.tabLayout = null;
    app._tabLayoutFirstPaintPending = true;
    app._tabLayoutCoordinator = { load: () => Promise.resolve(true) };
    document.getElementById('sessionTabs')!.innerHTML = '';
    app._fullRenderSessionTabs();
    app._renderSessionTabsImmediate();
    expect(document.querySelectorAll('.session-tab')).toHaveLength(0);
    app._applyTabLayout(focusLayout());
    expect(document.querySelector('[data-tab-focus-group]')).not.toBeNull();
    expect(app._tabLayoutFirstPaintPending).toBe(false);
  });

  it('a failed read releases the hold onto the flat rail', () => {
    installFetch();
    const app = makeApp(null);
    app._tabLayoutFirstPaintPending = true;
    app._tabLayoutCoordinator = { load: () => Promise.resolve(false) };
    document.getElementById('sessionTabs')!.innerHTML = '';
    app._applyTabLayout(null);
    expect(document.querySelectorAll('.session-tab[data-id]')).toHaveLength(4);
  });

  it('the header strip is never held', () => {
    installFetch();
    const app = makeApp(null);
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._tabLayoutFirstPaintPending = true;
    app._tabLayoutCoordinator = { load: () => Promise.resolve(true) };
    app._fullRenderSessionTabs();
    expect(document.querySelectorAll('.session-tab[data-id]')).toHaveLength(4);
  });
});
