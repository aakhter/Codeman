// @vitest-environment jsdom
/** @fileoverview COD-307 accessible tab-layout editing, persistence, and pointer contracts. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { followParent, setManualPlacement, type TabRefMetadata } from '../src/tab-layout.js';

const PUBLIC = join(process.cwd(), 'src/web/public');
const HELPER_SOURCE = readFileSync(join(PUBLIC, 'tab-layout-browser.js'), 'utf8');
const APP_SOURCE = readFileSync(join(PUBLIC, 'app.js'), 'utf8');
const TAB_RAIL_SOURCE = readFileSync(join(PUBLIC, 'tab-rail-resize.js'), 'utf8');
let CodemanApp: { prototype: Record<string, any> };

beforeAll(() => {
  const constants = readFileSync(join(PUBLIC, 'constants.js'), 'utf8');
  const webviews = readFileSync(join(PUBLIC, 'webview-tabs.js'), 'utf8');
  const source =
    'var MobileDetection = { isTouchDevice: () => false }, KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, ' +
    'DeepgramProvider = {}, NotificationManager = function(){};\n' +
    constants +
    '\n' +
    HELPER_SOURCE +
    '\n' +
    APP_SOURCE +
    '\n' +
    TAB_RAIL_SOURCE +
    '\n' +
    webviews +
    '\n;globalThis.__Cod307App = CodemanApp;';
  const interval = window.setInterval;
  const raf = window.requestAnimationFrame;
  window.setInterval = (() => 0) as typeof window.setInterval;
  window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
  (0, eval)(source);
  window.setInterval = interval;
  window.requestAnimationFrame = raf;
  CodemanApp = (globalThis as any).__Cod307App;
});

type Ref = { kind: 'session' | 'webview'; id: string; placement?: 'manual' };
type Layout = {
  version: number;
  updatedAt: string;
  groups: Array<{ id: string; name: string; refs: Ref[] }>;
  ungrouped: Ref[];
};

function layout(version = 4): Layout {
  return {
    version,
    updatedAt: '2026-08-16T00:00:00.000Z',
    groups: [
      {
        id: 'g1',
        name: 'Core <&>',
        refs: [
          { kind: 'session', id: 'parent' },
          { kind: 'session', id: 'child' },
        ],
      },
      { id: 'g2', name: 'Ops', refs: [{ kind: 'session', id: 'other' }] },
    ],
    ungrouped: [{ kind: 'webview', id: 'web' }],
  };
}

function loadHelper() {
  const context = vm.createContext({ window: {}, globalThis: {}, setTimeout, clearTimeout });
  vm.runInContext(HELPER_SOURCE, context, { filename: 'tab-layout-browser.js' });
  return (context.window as any).CodemanTabLayout;
}

describe('COD-307 browser semantic mirror', () => {
  it('creates, renames, deletes, and reorders groups without mutating input', () => {
    const h = loadHelper();
    const initial = layout();
    const created = h.applyOperation(initial, { type: 'createGroup', id: 'g3', name: 'New', index: 1 });
    const renamed = h.applyOperation(created, { type: 'renameGroup', groupId: 'g3', name: 'Renamed' });
    const reordered = h.applyOperation(renamed, { type: 'reorderGroup', groupId: 'g3', index: 0 });
    const deleted = h.applyOperation(reordered, { type: 'deleteGroup', groupId: 'g1' });

    expect(initial.groups.map((group) => group.id)).toEqual(['g1', 'g2']);
    expect(reordered.groups.map((group) => group.id)).toEqual(['g3', 'g1', 'g2']);
    expect(reordered.groups[0].name).toBe('Renamed');
    expect(deleted.ungrouped.map((ref) => ref.id)).toEqual(['web', 'parent', 'child']);
  });

  it('moves a parent as one contiguous inherited subtree and marks an independently moved child manual', () => {
    const h = loadHelper();
    const metadata = [
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'child', parentSessionId: 'parent' },
      { kind: 'session', id: 'other' },
      { kind: 'webview', id: 'web' },
    ];
    const movedParent = h.applyOperation(layout(), {
      type: 'moveRef',
      ref: { kind: 'session', id: 'parent' },
      groupId: 'g2',
      index: 1,
      metadata,
    });
    expect(movedParent.groups[1].refs.map((ref: Ref) => ref.id)).toEqual(['other', 'parent', 'child']);
    expect(
      h
        .previewOperation(layout(), {
          type: 'moveRef',
          ref: { kind: 'session', id: 'parent' },
          groupId: 'g2',
          index: 1,
          metadata,
        })
        .refs.map((ref: Ref) => ref.id)
    ).toEqual(['parent', 'child']);

    const movedChild = h.applyOperation(layout(), {
      type: 'moveRef',
      ref: { kind: 'session', id: 'child' },
      groupId: null,
      index: 0,
      metadata,
    });
    expect(movedChild.ungrouped[0]).toEqual({ kind: 'session', id: 'child', placement: 'manual' });
  });
});

describe('COD-309 browser child-placement semantics', () => {
  const metadata = [
    { kind: 'session', id: 'parent', ownerValid: true },
    { kind: 'session', id: 'child', parentSessionId: 'parent', ownerValid: true },
    { kind: 'session', id: 'grandchild', parentSessionId: 'child', ownerValid: true },
    { kind: 'session', id: 'other', ownerValid: true },
    { kind: 'webview', id: 'web', ownerValid: true },
  ];

  it('mirrors manual placement and Follow parent again with immediate nested normalization', () => {
    const h = loadHelper();
    const initial = layout();
    initial.groups[0].refs = [
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'grandchild' },
    ];
    initial.ungrouped.unshift({ kind: 'session', id: 'child', placement: 'manual' });

    const followed = h.applyOperation(initial, {
      type: 'followParent',
      ref: { kind: 'session', id: 'child' },
      metadata,
    });
    expect(followed.groups[0].refs.map((ref: Ref) => ref.id)).toEqual(['parent', 'child', 'grandchild']);
    expect(followed.groups[0].refs[1]).toEqual({ kind: 'session', id: 'child' });

    const manual = h.applyOperation(followed, {
      type: 'setManualPlacement',
      ref: { kind: 'session', id: 'child' },
      manual: true,
    });
    expect(manual.groups[0].refs[1]).toEqual({ kind: 'session', id: 'child', placement: 'manual' });
  });

  it('keeps the browser semantic results in parity with the authoritative TypeScript model', () => {
    const h = loadHelper();
    const source = layout() as any;
    source.groups[0].refs[1] = { kind: 'session', id: 'child', placement: 'manual' };
    source.ungrouped.unshift({ kind: 'session', id: 'grandchild' });
    const authoritativeMetadata = metadata.map((item, order) => ({
      ...item,
      order,
      visible: true,
    })) as TabRefMetadata[];

    expect(
      h.applyOperation(source, {
        type: 'setManualPlacement',
        ref: { kind: 'session', id: 'parent' },
        manual: true,
      })
    ).toEqual(setManualPlacement(source, { kind: 'session', id: 'parent' }, true));
    expect(
      h.applyOperation(source, {
        type: 'followParent',
        ref: { kind: 'session', id: 'child' },
        metadata: authoritativeMetadata,
      })
    ).toEqual(followParent(source, { kind: 'session', id: 'child' }, authoritativeMetadata));
  });

  it('classifies inherited, manual, dangling, and cycle placement without offering invalid follow', () => {
    const h = loadHelper();
    const inherited = h.placementState(layout(), { kind: 'session', id: 'child' }, metadata);
    expect(inherited).toMatchObject({ state: 'inherited', canFollow: false, parentId: 'parent' });

    const manualLayout = layout();
    manualLayout.groups[0].refs[1] = { kind: 'session', id: 'child', placement: 'manual' };
    expect(h.placementState(manualLayout, { kind: 'session', id: 'child' }, metadata)).toMatchObject({
      state: 'manual',
      canFollow: true,
    });
    expect(h.placementState(manualLayout, { kind: 'session', id: 'child' }, metadata.slice(1))).toMatchObject({
      state: 'dangling',
      canFollow: false,
    });

    const cyclic = [
      { kind: 'session', id: 'parent', parentSessionId: 'child', ownerValid: true },
      { kind: 'session', id: 'child', parentSessionId: 'parent', ownerValid: true },
    ];
    expect(h.placementState(manualLayout, { kind: 'session', id: 'child' }, cyclic)).toMatchObject({
      state: 'cycle',
      canFollow: false,
    });
    expect(() =>
      h.applyOperation(manualLayout, {
        type: 'followParent',
        ref: { kind: 'session', id: 'child' },
        metadata: [
          { kind: 'session', id: 'child', parentSessionId: 'parent' },
          { kind: 'session', id: 'parent', ownerValid: false },
        ],
      })
    ).toThrow(/owner-valid parent/);
  });
});

describe('COD-307 optimistic write coordinator', () => {
  beforeEach(() => vi.useFakeTimers());

  it('coalesces a deterministic semantic burst and adopts the successful PUT version', async () => {
    const h = loadHelper();
    const adopted: Layout[] = [];
    const put = vi.fn(async ({ baseVersion, layout: next }: any) => ({
      ok: true,
      status: 200,
      layout: { ...next, version: baseVersion + 1 },
    }));
    const coordinator = h.createEditCoordinator({
      initialLayout: layout(),
      applyLayout: (next: Layout) => adopted.push(next),
      put,
      debounceMs: 100,
      schedule: setTimeout,
      cancel: clearTimeout,
    });

    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Platform' });
    coordinator.enqueue({ type: 'reorderGroup', groupId: 'g2', index: 0 });
    expect(adopted.at(-1)?.groups.map((group) => group.id)).toEqual(['g2', 'g1']);
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0].baseVersion).toBe(4);
    expect(coordinator.getLayout().version).toBe(5);
  });

  it('rebases the same pending semantic operations once after 409 and retries once', async () => {
    const h = loadHelper();
    const server = { ...layout(8), groups: [...layout(8).groups, { id: 'remote', name: 'Remote', refs: [] }] };
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, layout: server })
      .mockImplementationOnce(async ({ layout: next }: any) => ({
        ok: true,
        status: 200,
        layout: { ...next, version: 9 },
      }));
    const coordinator = h.createEditCoordinator({
      initialLayout: layout(),
      applyLayout: vi.fn(),
      put,
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Local' });
    await vi.runAllTimersAsync();

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][0].baseVersion).toBe(8);
    expect(coordinator.getLayout().groups.find((group: any) => group.id === 'remote')).toBeTruthy();
    expect(coordinator.getLayout().groups.find((group: any) => group.id === 'g1').name).toBe('Local');
  });

  it('rebases Follow parent again over one conflict with fresh lineage metadata', async () => {
    const h = loadHelper();
    const initial = layout();
    initial.groups[0].refs = [{ kind: 'session', id: 'parent' }];
    initial.ungrouped.unshift({ kind: 'session', id: 'child', placement: 'manual' });
    const metadata = [
      { kind: 'session', id: 'parent', ownerValid: true },
      { kind: 'session', id: 'child', parentSessionId: 'parent', ownerValid: true },
      { kind: 'session', id: 'other', ownerValid: true },
      { kind: 'webview', id: 'web', ownerValid: true },
    ];
    const remote = {
      ...initial,
      version: 8,
      groups: [...initial.groups, { id: 'remote', name: 'Remote', refs: [] }],
    };
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, layout: remote })
      .mockImplementationOnce(async ({ layout: desired }: any) => ({
        ok: true,
        status: 200,
        layout: { ...desired, version: 9 },
      }));
    const coordinator = h.createEditCoordinator({
      initialLayout: initial,
      applyLayout: vi.fn(),
      put,
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    coordinator.enqueue({
      type: 'followParent',
      ref: { kind: 'session', id: 'child' },
      metadata,
    });
    await vi.runAllTimersAsync();

    expect(put).toHaveBeenCalledTimes(2);
    expect(coordinator.getLayout().groups[0].refs.map((ref: Ref) => ref.id)).toEqual(['parent', 'child']);
    expect(coordinator.getLayout().groups.at(-1).id).toBe('remote');
  });

  it('adopts a 409 layout that already contains the complete semantic burst without replaying moves', async () => {
    const h = loadHelper();
    const initial = {
      ...layout(),
      groups: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id, refs: [] })),
    };
    const operations = [
      { type: 'reorderGroup', groupId: 'a', index: 1 },
      { type: 'reorderGroup', groupId: 'b', index: 2 },
    ];
    const committed = operations.reduce((candidate, operation) => h.applyOperation(candidate, operation), initial);
    const put = vi.fn(async () => ({ ok: false, status: 409, layout: { ...committed, version: 5 } }));
    const coordinator = h.createEditCoordinator({
      initialLayout: initial,
      applyLayout: vi.fn(),
      put,
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    for (const operation of operations) coordinator.enqueue(operation);
    await vi.runAllTimersAsync();

    expect(put).toHaveBeenCalledOnce();
    expect(coordinator.getLayout().groups.map((group: any) => group.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('stops after a second conflict, adopts server state, and ignores stale success/SSE adoption', async () => {
    const h = loadHelper();
    const second = { ...layout(10), groups: [{ id: 'server', name: 'Server', refs: [] }] };
    const error = vi.fn();
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, layout: layout(9) })
      .mockResolvedValueOnce({ ok: false, status: 409, layout: second });
    const coordinator = h.createEditCoordinator({
      initialLayout: layout(),
      applyLayout: vi.fn(),
      reportError: error,
      put,
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Local' });
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledTimes(2);
    expect(coordinator.getLayout()).toEqual(second);
    expect(error).toHaveBeenCalledOnce();
    expect(coordinator.adoptExternal(layout(8))).toBe(false);
    expect(coordinator.getLayout()).toEqual(second);
  });

  it('rebases an in-flight semantic batch over newer SSE state and cannot resurrect a stale success', async () => {
    const h = loadHelper();
    let resolveFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const put = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(async ({ baseVersion, layout: next }: any) => ({
        ok: true,
        status: 200,
        layout: { ...next, version: baseVersion + 1 },
      }));
    const coordinator = h.createEditCoordinator({
      initialLayout: layout(),
      applyLayout: vi.fn(),
      put,
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Local' });
    await vi.advanceTimersByTimeAsync(0);
    const external = { ...layout(8), groups: [...layout(8).groups, { id: 'remote', name: 'Remote', refs: [] }] };
    expect(coordinator.adoptExternal(external)).toBe(true);
    expect(coordinator.getLayout().groups.find((group: any) => group.id === 'g1').name).toBe('Local');
    resolveFirst({ ok: true, status: 200, layout: { ...layout(5), groups: [] } });
    await first;
    await vi.runAllTimersAsync();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1][0].baseVersion).toBe(8);
    expect(coordinator.getLayout().version).toBe(9);
    expect(coordinator.getLayout().groups.find((group: any) => group.id === 'remote')).toBeTruthy();
    expect(coordinator.getLayout().groups.find((group: any) => group.id === 'g1').name).toBe('Local');
  });

  it('snapshots both an in-flight batch and operations queued behind it for reload recovery', async () => {
    const h = loadHelper();
    const never = new Promise(() => {});
    const coordinator = h.createEditCoordinator({
      initialLayout: layout(),
      applyLayout: vi.fn(),
      put: vi.fn(() => never),
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'First' });
    await vi.advanceTimersByTimeAsync(0);
    coordinator.enqueue({ type: 'reorderGroup', groupId: 'g2', index: 0 });
    expect(coordinator.pendingOperations().map((operation: any) => operation.type)).toEqual([
      'renameGroup',
      'reorderGroup',
    ]);
  });

  it('snapshots the rebased authoritative state while the conflict retry is in flight', async () => {
    const h = loadHelper();
    const remote = {
      ...layout(8),
      groups: [...layout(8).groups, { id: 'remote', name: 'Remote', refs: [] }],
    };
    const never = new Promise(() => {});
    const put = vi.fn().mockResolvedValueOnce({ ok: false, status: 409, layout: remote }).mockReturnValueOnce(never);
    const coordinator = h.createEditCoordinator({
      initialLayout: layout(),
      applyLayout: vi.fn(),
      put,
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Local' });
    await vi.advanceTimersByTimeAsync(0);

    expect(put).toHaveBeenCalledTimes(2);
    expect(coordinator.recoverySnapshot().baseLayout.version).toBe(8);
    expect(coordinator.recoverySnapshot().baseLayout.groups.at(-1).id).toBe('remote');
  });
});

describe('COD-307 accessible rendering and pointer wiring', () => {
  it('renders one vertical tree, named headers and members as treeitems, groups, explicit zones, and escaped names', () => {
    const h = loadHelper();
    const projection = h.project(layout(), {
      liveSessionIds: ['parent', 'child', 'other'],
      openWebviewIds: ['web'],
      collapsedGroupIds: ['g2'],
      activeSessionId: 'parent',
      orientation: 'vertical',
    });
    const html = h.renderProjection(
      projection,
      'vertical',
      (ref: Ref) => `<div class="session-tab" data-id="${ref.id}" aria-selected="${ref.id === 'parent'}"></div>`,
      (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    );
    document.body.innerHTML = `<div id="sessionTabs">${html}</div>`;
    const container = document.getElementById('sessionTabs')!;
    expect(container.querySelectorAll('[role="tree"]')).toHaveLength(1);
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(6);
    expect(container.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(container.querySelector('[data-tab-group-id="g2"] .tab-layout-group-refs')?.getAttribute('role')).toBe(
      'presentation'
    );
    expect(container.querySelectorAll('.tab-layout-drop-zone').length).toBeGreaterThan(8);
    expect(
      [...container.querySelectorAll('.tab-layout-drop-zone')].every(
        (zone) => zone.getAttribute('role') === 'presentation'
      )
    ).toBe(true);
    expect(container.querySelector('.tab-layout-create-group')?.parentElement?.getAttribute('role')).not.toBe('tree');
    expect(container.innerHTML).toContain('Core &lt;&amp;&gt;');
    expect(container.innerHTML).not.toContain('Core <&>');
    expect(container.querySelector('[data-tab-group-header="g2"]')?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-id="other"]')).toBeNull();
    expect(container.querySelector('[data-tab-group-id=""] [data-tab-group-header]')).toBeNull();
  });

  it('renders the editable name outside the collapse button and preserves user-entered case', () => {
    const h = loadHelper();
    const html = h.renderProjection(
      h.project(layout(), {
        liveSessionIds: ['parent', 'child', 'other'],
        openWebviewIds: ['web'],
        orientation: 'vertical',
      }),
      'vertical',
      (ref: Ref) => `<div class="session-tab" data-id="${ref.id}" role="tab"></div>`,
      (value: string) => value
    );
    document.body.innerHTML = html;
    const header = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-header')!;
    const label = header.querySelector<HTMLElement>('.tab-layout-group-label')!;
    const toggle = header.querySelector<HTMLButtonElement>('.tab-layout-group-toggle')!;
    expect(toggle.contains(label)).toBe(false);
    expect(label.tagName).toBe('SPAN');
    expect(toggle.getAttribute('aria-label')).toContain('Core <&>');
    const css = readFileSync(join(PUBLIC, 'styles.css'), 'utf8');
    expect(css).not.toMatch(/\.tab-layout-group-name\s*\{[^}]*text-transform:\s*uppercase/s);
  });

  it('exposes a highlighted collapsed member as a sibling treeitem rather than an owned expanded child', () => {
    const h = loadHelper();
    const html = h.renderProjection(
      h.project(layout(), {
        liveSessionIds: ['parent', 'child', 'other'],
        openWebviewIds: ['web'],
        collapsedGroupIds: ['g1'],
        activeSessionId: 'parent',
        orientation: 'vertical',
      }),
      'vertical',
      (ref: Ref) => `<div class="session-tab" data-id="${ref.id}" role="tab"></div>`,
      (value: string) => value
    );
    document.body.innerHTML = html;
    const active = document.querySelector<HTMLElement>('[data-id="parent"]')!;
    expect(active).not.toBeNull();
    expect(active.getAttribute('role')).toBe('treeitem');
    expect(active.closest('[role="group"]')).toBeNull();
    expect(active.closest('[data-tab-highlighted-exception="g1"]')).not.toBeNull();
    expect(document.querySelector('[data-tab-group-header="g1"]')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('uses complete stored indices for drop zones when visible refs omit unopened or collapsed members', () => {
    const h = loadHelper();
    const indexed = layout();
    indexed.groups[0].refs = [
      { kind: 'webview', id: 'closed' },
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'child' },
    ];
    const projection = h.project(indexed, {
      liveSessionIds: ['parent', 'child'],
      openWebviewIds: [],
      activeSessionId: 'parent',
      orientation: 'vertical',
    });
    const html = h.renderProjection(
      projection,
      'vertical',
      (ref: Ref) => `<div class="session-tab" data-id="${ref.id}" role="tab" tabindex="0"></div>`,
      (value: string) => value
    );
    document.body.innerHTML = html;
    const zones = [...document.querySelectorAll<HTMLElement>('[data-tab-drop-group="g1"]')];
    expect(zones.map((zone) => zone.dataset.tabDropIndex)).toEqual(['1', '2', '3']);
  });

  it('has one delegated pointer-event system and no HTML5 managed drag system', () => {
    expect(APP_SOURCE).toContain("container.addEventListener('pointerdown'");
    expect(APP_SOURCE).toContain("container.addEventListener('pointermove'");
    expect(APP_SOURCE).toContain("container.addEventListener('pointerup'");
    expect(APP_SOURCE).toContain("container.addEventListener('pointercancel'");
    expect(APP_SOURCE).toContain('setPointerCapture');
    expect(APP_SOURCE).not.toContain("tab.addEventListener('dragstart'");
    expect(APP_SOURCE).not.toContain("tab.setAttribute('draggable', 'true')");
  });
});

function makeInteractionApp() {
  (globalThis as any).CSS ||= { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') };
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', 'vertical');
  document.body.innerHTML = '<div id="sessionTabs"></div>';
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map([
    ['parent', { id: 'parent', name: 'Parent' }],
    ['child', { id: 'child', name: 'Child', parentSessionId: 'parent' }],
    ['other', { id: 'other', name: 'Other' }],
  ]);
  app.webviews = new Map([['web', { id: 'web', name: 'Web', url: 'https://example.test' }]]);
  app.webviewOrder = ['web'];
  app.activeSessionId = 'parent';
  app.activeWebviewId = null;
  app.tabLayout = layout();
  app.tabLayoutVersion = 4;
  app.tabLayoutReadOnly = false;
  app.collapsedTabGroupIds = new Set();
  app._tabCollapseStorageFailed = false;
  app._legacySessionOrder = [];
  app._tabLayoutFirstPaintPending = false;
  app._lastTabStructureKey = null;
  app._inlineRenameActive = false;
  app._tabLayoutManaged = true;
  app._tabPointerHandlersBound = false;
  app._tabFocusIdentity = null;
  app.detachedSessions = new Set();
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
  app.selectSession = vi.fn();
  app.openWebview = vi.fn();
  app.showToast = vi.fn();
  return app;
}

function enableRealSemanticEditing(app: Record<string, any>) {
  app._tabLayoutEditCoordinator = null;
  app._putTabLayout = vi.fn(async ({ layout: next }: { layout: Layout }) => ({
    ok: true,
    status: 200,
    layout: { ...next, version: next.version + 1 },
  }));
  app._putTabLayoutKeepalive = vi.fn(() => true);
}

function clickMenuItem(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === label
  );
  expect(button, `menu item ${label}`).toBeTruthy();
  button!.click();
}

describe('COD-307 subtree-aware move destinations', () => {
  it('moves to the current group end through the real ref menu without a semantic error', () => {
    const app = makeInteractionApp();
    enableRealSemanticEditing(app);
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    app.openTabRefMoveMenu(
      { preventDefault() {}, stopPropagation() {}, currentTarget: trigger },
      {
        kind: 'session',
        id: 'other',
      }
    );
    clickMenuItem('Move to Ops');

    expect(app.showToast).not.toHaveBeenCalled();
    expect(app.tabLayout.groups[1].refs.map((ref: Ref) => ref.id)).toEqual(['other']);
  });

  it('does not expose Move later when a parent subtree has no external next block', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs = [
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'child' },
    ];
    app.tabLayout.groups[1].refs = [];
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    app.openTabRefMoveMenu(
      { preventDefault() {}, stopPropagation() {}, currentTarget: trigger },
      {
        kind: 'session',
        id: 'parent',
      }
    );

    expect([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === 'Move later')).toBe(
      false
    );
  });

  it('moves a parent later through the legacy action with both adjacent subtrees contiguous', () => {
    const app = makeInteractionApp();
    app.sessions.set('otherChild', { id: 'otherChild', name: 'Other child', parentSessionId: 'other' });
    app.tabLayout.groups[0].refs = [
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'child' },
      { kind: 'session', id: 'other' },
      { kind: 'session', id: 'otherChild' },
    ];
    app.tabLayout.groups[1].refs = [];
    enableRealSemanticEditing(app);
    app.moveActiveTabRight();

    expect(app.showToast).not.toHaveBeenCalled();
    expect(app.tabLayout.groups[0].refs.map((ref: Ref) => ref.id)).toEqual(['other', 'otherChild', 'parent', 'child']);
  });

  it('moves a parent subtree to another group end through the session action menu', () => {
    const app = makeInteractionApp();
    enableRealSemanticEditing(app);
    app.loadAppSettingsFromStorage = () => ({ showTabDetachButton: false });
    app.openSessionOptions = vi.fn();
    app.requestCloseSession = vi.fn();
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: trigger }, 'parent');
    clickMenuItem('Move to Ops');

    expect(app.showToast).not.toHaveBeenCalled();
    expect(app.tabLayout.groups[1].refs.map((ref: Ref) => ref.id)).toEqual(['other', 'parent', 'child']);
  });
});

describe('COD-309 shipping placement UI', () => {
  it('renders understandable escaped placement status and runs Follow parent again through the real coordinator', () => {
    const app = makeInteractionApp();
    app.sessions.get('parent').name = 'Parent <unsafe>';
    enableRealSemanticEditing(app);
    app.loadAppSettingsFromStorage = () => ({ showTabDetachButton: false });
    app.openSessionOptions = vi.fn();
    app.requestCloseSession = vi.fn();
    expect(app.moveTabRefToGroup({ kind: 'session', id: 'child' }, null, 0)).toBe(true);
    app._fullRenderSessionTabs();

    const child = document.querySelector<HTMLElement>('[data-id="child"]')!;
    expect(app.tabLayout.ungrouped[0]).toEqual({ kind: 'session', id: 'child', placement: 'manual' });
    expect(child.getAttribute('aria-label')).toContain('Placed manually; can follow Parent <unsafe>');
    expect(child.querySelector('.tab-placement-state--manual')?.textContent).toBe('Manual');
    expect(child.textContent).not.toContain('Parent <unsafe>');
    expect(child.querySelector('unsafe')).toBeNull();
    const trigger = child.querySelector<HTMLElement>('.tab-more')!;
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: trigger }, 'child');
    const placementSummary = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith('Placed manually;')
    );
    expect(placementSummary?.getAttribute('aria-disabled')).toBe('true');
    clickMenuItem('Follow parent again');

    expect(app.showToast).not.toHaveBeenCalled();
    expect(app.tabLayout.groups[0].refs.map((ref: Ref) => ref.id)).toEqual(['parent', 'child']);
    expect(app.tabLayout.groups[0].refs[1]).toEqual({ kind: 'session', id: 'child' });
  });

  it('exposes Follow parent again through the real Shift+F10 ref menu but not for dangling or cyclic children', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[1] = { kind: 'session', id: 'child', placement: 'manual' };
    enableRealSemanticEditing(app);
    app._fullRenderSessionTabs();
    let child = document.querySelector<HTMLElement>('[data-id="child"]')!;
    child.focus();
    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === 'Follow parent again')
    ).toBe(true);
    document.querySelector('.tab-layout-ref-move-menu')?.remove();

    app.sessions.delete('parent');
    app._lastTabStructureKey = null;
    app._fullRenderSessionTabs();
    child = document.querySelector<HTMLElement>('[data-id="child"]')!;
    expect(child.querySelector('.tab-placement-state--dangling')?.textContent).toBe('Parent unavailable');
    app.openTabRefMoveMenu(
      { preventDefault() {}, stopPropagation() {}, currentTarget: child },
      { kind: 'session', id: 'child' }
    );
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent === 'Parent unavailable; placed independently'
      )
    ).toBe(true);
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === 'Follow parent again')
    ).toBe(false);

    app.sessions.set('parent', { id: 'parent', name: 'Parent', parentSessionId: 'child' });
    app._lastTabStructureKey = null;
    app._fullRenderSessionTabs();
    child = document.querySelector<HTMLElement>('[data-id="child"]')!;
    expect(child.querySelector('.tab-placement-state--cycle')?.textContent).toBe('Parent cycle');
  });

  it('treats an administrator-visible cross-owner parent as unavailable', () => {
    const previousUser = (window as any).__codemanUser;
    (window as any).__codemanUser = { username: 'alice', role: 'admin', multiUser: true };
    try {
      const app = makeInteractionApp();
      app.sessions.get('child').owner = 'alice';
      app.sessions.get('parent').owner = 'bob';
      app.tabLayout.groups[0].refs[1] = { kind: 'session', id: 'child', placement: 'manual' };
      app._fullRenderSessionTabs();
      const child = document.querySelector<HTMLElement>('[data-id="child"]')!;
      expect(child.querySelector('.tab-placement-state--dangling')?.textContent).toBe('Parent unavailable');
      expect(app._tabRefPlacementActions({ kind: 'session', id: 'child' })).toEqual([
        { label: 'Parent unavailable; placed independently', disabled: true },
      ]);
    } finally {
      (window as any).__codemanUser = previousUser;
    }
  });

  it('keeps placement badges visually scoped to the vertical rail', () => {
    const css = readFileSync(join(PUBLIC, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.session-tab \.tab-placement-state\s*\{[^}]*display:\s*none/s);
    expect(css).toMatch(
      /html\[data-tab-orientation='vertical'\] \.tab-rail \.session-tab \.tab-placement-state\s*\{[^}]*display:\s*block/s
    );

    const app = makeInteractionApp();
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app.tabLayout.groups[0].refs[1] = { kind: 'session', id: 'child', placement: 'manual' };
    app._fullRenderSessionTabs();
    expect(document.querySelector('.tab-placement-state--manual')).toBeTruthy();
    expect(document.getElementById('sessionTabs')?.getAttribute('role')).toBe('tablist');
  });
});

describe('COD-307 roving tree and focus restoration', () => {
  it('keeps exactly one vertical treeitem tabbable and implements Up/Down/Home/End', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const container = document.getElementById('sessionTabs')!;
    const items = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(items.filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect([...container.querySelectorAll<HTMLButtonElement>('button')].every((button) => button.tabIndex === -1)).toBe(
      true
    );
    items[0].focus();
    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[1]);
    items[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(items.at(-1));
    items.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items.at(-1));
  });

  it('collapses/expands/enters named groups with Left/Right and activates with Enter/Space', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    let header = document.querySelector<HTMLElement>('.tab-layout-group-header')!;
    header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(app.collapsedTabGroupIds.has('g1')).toBe(true);
    expect(document.querySelector('[data-id="child"]')).toBeNull();

    header = document.querySelector<HTMLElement>('.tab-layout-group-header')!;
    header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(app.collapsedTabGroupIds.has('g1')).toBe(false);
    header = document.querySelector<HTMLElement>('.tab-layout-group-header')!;
    header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.id).toBe('parent');
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(header);
    header.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(app.collapsedTabGroupIds.has('g1')).toBe(true);
  });

  it('retains exclusive aria-selected and restores identity across orientation rerenders', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
    const parent = document.querySelector<HTMLElement>('[data-id="parent"]')!;
    parent.focus();
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._fullRenderSessionTabs();
    expect(document.getElementById('sessionTabs')?.getAttribute('role')).toBe('tablist');
    expect(document.activeElement).toBe(document.querySelector('[data-id="parent"]'));
    expect(document.querySelectorAll('.session-tab[tabindex="0"]')).toHaveLength(1);
  });

  it('exposes keyboard equivalents for create, rename, delete, group reorder, and ref move menus', () => {
    const app = makeInteractionApp();
    app.createTabGroup = vi.fn();
    app.startTabGroupRename = vi.fn();
    app.deleteTabGroup = vi.fn();
    app.editTabLayout = vi.fn();
    app.openTabGroupMenu = vi.fn();
    app.openTabRefMoveMenu = vi.fn();
    app._fullRenderSessionTabs();
    const header = document.querySelector<HTMLElement>('.tab-layout-group-header')!;
    header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Insert', bubbles: true }));
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }));
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    expect(app.createTabGroup).toHaveBeenCalledOnce();
    expect(app.startTabGroupRename).toHaveBeenCalledWith('g1');
    expect(app.deleteTabGroup).toHaveBeenCalledWith('g1');
    expect(app.editTabLayout).toHaveBeenCalledWith({ type: 'reorderGroup', groupId: 'g1', index: 1 }, 'group:g1');
    expect(app.openTabGroupMenu).toHaveBeenCalledWith(expect.anything(), 'g1');

    const tab = document.querySelector<HTMLElement>('[data-id="parent"]')!;
    tab.focus();
    tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    expect(app.openTabRefMoveMenu).toHaveBeenCalledWith(expect.anything(), { kind: 'session', id: 'parent' });
  });

  it('keeps horizontal Left/Right/Home/End navigation and Enter activation flat', () => {
    const app = makeInteractionApp();
    document.documentElement.setAttribute('data-tab-orientation', 'horizontal');
    app._fullRenderSessionTabs();
    const tabs = [...document.querySelectorAll<HTMLElement>('.session-tab[role="tab"]')];
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(tabs.at(-1));
    tabs.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(tabs.at(-1));
    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(app.selectSession).toHaveBeenCalledWith('parent');
  });

  it('preserves a group rename input through debounced and authoritative render attempts', () => {
    const app = makeInteractionApp();
    app.toggleTabGroupCollapsed = vi.fn();
    (window as any).app = app;
    app._fullRenderSessionTabs();
    expect(app.startTabGroupRename('g1')).toBe(true);
    const input = document.querySelector<HTMLInputElement>('.tab-layout-group-rename-input')!;
    expect(input.closest('button')).toBeNull();
    expect(input.getAttribute('aria-label')).toBe('Rename Core <&> group');
    input.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(app.toggleTabGroupCollapsed).not.toHaveBeenCalled();
    input.value = 'Still typing';
    app.renderSessionTabs();
    app._fullRenderSessionTabs();
    app._applyTabLayout({
      ...layout(5),
      groups: [{ ...layout(5).groups[0], name: 'Server name' }, layout(5).groups[1]],
    });
    expect(document.body.contains(input)).toBe(true);
    expect(input.value).toBe('Still typing');
    expect(app._inlineRenameActive).toBe(true);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.tab-layout-group-label')?.textContent).toBe('Server name');
  });

  it('does not let inline-edit keystrokes bubble into tree navigation or commands', () => {
    const app = makeInteractionApp();
    app.deleteTabGroup = vi.fn();
    app._fullRenderSessionTabs();
    app.startTabGroupRename('g1');
    const input = document.querySelector<HTMLInputElement>('.tab-layout-group-rename-input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(app.deleteTabGroup).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    expect(app.collapsedTabGroupIds.has('g1')).toBe(false);
  });

  it('adjusts forward group drops to post-removal reorder indices', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups.push({ id: 'g3', name: 'Three', refs: [] });
    expect(app._adjustGroupReorderIndex('g1', 2)).toBe(1);
    expect(app._adjustGroupReorderIndex('g3', 0)).toBe(0);
  });
});

function pointerEvent(type: string, values: Record<string, unknown>) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX: Number(values.clientX),
    clientY: Number(values.clientY),
  });
  for (const [key, value] of Object.entries(values)) Object.defineProperty(event, key, { value });
  return event;
}

describe('COD-307 delegated pointer behavior', () => {
  it('installs once and commits one semantic drop after the movement threshold', () => {
    const app = makeInteractionApp();
    app.editTabLayout = vi.fn(() => true);
    app._fullRenderSessionTabs();
    const container = document.getElementById('sessionTabs') as HTMLElement & {
      setPointerCapture: ReturnType<typeof vi.fn>;
    };
    container.setPointerCapture = vi.fn();
    app.setupTabDragHandlers();
    app.setupTabDragHandlers();
    const tab = container.querySelector<HTMLElement>('[data-id="parent"]')!;
    const zone = container.querySelector<HTMLElement>('[data-tab-drop-group="g2"][data-tab-drop-index="1"]')!;
    (document as any).elementFromPoint = vi.fn(() => zone);

    tab.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, pointerType: 'mouse', clientX: 1, clientY: 1 }));
    container.dispatchEvent(
      pointerEvent('pointermove', { pointerId: 7, pointerType: 'mouse', clientX: 3, clientY: 3 })
    );
    expect(zone.classList.contains('tab-layout-drop-active')).toBe(false);
    container.dispatchEvent(
      pointerEvent('pointermove', { pointerId: 7, pointerType: 'mouse', clientX: 20, clientY: 20 })
    );
    expect(zone.classList.contains('tab-layout-drop-active')).toBe(true);
    container.dispatchEvent(
      pointerEvent('pointerup', { pointerId: 7, pointerType: 'mouse', clientX: 20, clientY: 20 })
    );

    expect(app.editTabLayout).toHaveBeenCalledTimes(1);
    expect(app.editTabLayout.mock.calls[0][0]).toMatchObject({
      type: 'moveRef',
      ref: { kind: 'session', id: 'parent' },
      groupId: 'g2',
      index: 1,
    });
    expect(app._tabPointerDrag).toBeNull();
    expect(container.querySelector('.tab-layout-drop-active')).toBeNull();
  });

  it('supports touch intent and fully cleans up on pointercancel without committing', () => {
    const app = makeInteractionApp();
    app.editTabLayout = vi.fn(() => true);
    app._fullRenderSessionTabs();
    const container = document.getElementById('sessionTabs') as HTMLElement & {
      setPointerCapture: ReturnType<typeof vi.fn>;
    };
    container.setPointerCapture = vi.fn();
    const tab = container.querySelector<HTMLElement>('[data-id="parent"]')!;
    const handle = tab.querySelector<HTMLElement>('[data-tab-ref-drag]')!;
    const zone = container.querySelector<HTMLElement>('[data-tab-drop-group="g2"]')!;
    (document as any).elementFromPoint = vi.fn(() => zone);
    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 8, pointerType: 'touch', clientX: 0, clientY: 0 }));
    container.dispatchEvent(
      pointerEvent('pointermove', { pointerId: 8, pointerType: 'touch', clientX: 12, clientY: 12 })
    );
    expect(container.querySelectorAll('.tab-layout-drag-block').length).toBeGreaterThan(1);
    container.dispatchEvent(
      pointerEvent('pointercancel', { pointerId: 8, pointerType: 'touch', clientX: 12, clientY: 12 })
    );
    expect(app.editTabLayout).not.toHaveBeenCalled();
    expect(app._tabPointerDrag).toBeNull();
    expect(container.querySelector('.tab-layout-drag-block')).toBeNull();
  });

  it('cleans up after lost pointer capture and ships touch arbitration for vertical ref dragging', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const container = document.getElementById('sessionTabs') as HTMLElement & {
      setPointerCapture: ReturnType<typeof vi.fn>;
    };
    container.setPointerCapture = vi.fn();
    const tab = container.querySelector<HTMLElement>('[data-id="parent"]')!;
    const handle = tab.querySelector<HTMLElement>('[data-tab-ref-drag]')!;
    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 9, pointerType: 'touch', clientX: 0, clientY: 0 }));
    container.dispatchEvent(
      pointerEvent('pointermove', { pointerId: 9, pointerType: 'touch', clientX: 12, clientY: 12 })
    );
    container.dispatchEvent(
      pointerEvent('lostpointercapture', { pointerId: 9, pointerType: 'touch', clientX: 12, clientY: 12 })
    );
    expect(app._tabPointerDrag).toBeNull();
    expect(container.querySelector('.tab-layout-drag-block')).toBeNull();
    const css = readFileSync(join(PUBLIC, 'styles.css'), 'utf8');
    expect(css).toMatch(/vertical[^}]*session-tab[^}]*\{[^}]*touch-action:\s*pan-y/s);
    expect(css).toMatch(/\.tab-ref-drag-handle\s*\{[^}]*touch-action:\s*none/s);
  });
});

describe('COD-307 page lifecycle persistence', () => {
  it('sends the latest optimistic layout through keepalive on ordinary pagehide only', () => {
    const h = loadHelper();
    const keepalive = vi.fn();
    const coordinator = h.createEditCoordinator({
      initialLayout: layout(),
      applyLayout: vi.fn(),
      put: vi.fn(),
      putKeepalive: keepalive,
      debounceMs: 180,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Leaving' });
    coordinator.flushKeepalive();
    expect(keepalive).toHaveBeenCalledWith({
      baseVersion: 4,
      layout: expect.objectContaining({
        groups: expect.arrayContaining([expect.objectContaining({ name: 'Leaving' })]),
      }),
    });
  });

  it('flushes edits on ordinary pagehide but preserves BFCache state', () => {
    const app = makeInteractionApp();
    app._tabLayoutCoordinator = null;
    app._tabLayoutPagehideHandler = null;
    app._fetchTabLayout = vi.fn(async () => layout());
    app._tabLayoutEditCoordinator = { flushKeepalive: vi.fn(), hasPending: () => true };
    app._ensureTabLayoutCoordinator();
    const persisted = new Event('pagehide');
    Object.defineProperty(persisted, 'persisted', { value: true });
    window.dispatchEvent(persisted);
    expect(app._tabLayoutEditCoordinator.flushKeepalive).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    expect(app._tabLayoutEditCoordinator.flushKeepalive).toHaveBeenCalledOnce();
  });

  it('restores persisted semantic operations through a fresh authoritative layout load', () => {
    const base = layout();
    sessionStorage.setItem(
      'codeman:tab-layout-pending-operations',
      JSON.stringify({
        baseLayout: base,
        operations: [
          { type: 'reorderGroup', groupId: 'g2', index: 0 },
          { type: 'renameGroup', groupId: 'g1', name: 'Recovered' },
        ],
      })
    );
    const app = makeInteractionApp();
    const enqueue = vi.fn();
    app.tabLayout = null;
    app.tabLayoutVersion = null;
    app._tabLayoutEditCoordinator = null;
    app._ensureTabLayoutEditCoordinator = vi.fn(() => ({ enqueue }));
    const prefixCommitted = (window as any).CodemanTabLayout.applyOperation(base, {
      type: 'reorderGroup',
      groupId: 'g2',
      index: 0,
    });
    app._applyTabLayout({ ...prefixCommitted, version: 5 });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith({ type: 'renameGroup', groupId: 'g1', name: 'Recovered' });
    expect(sessionStorage.getItem('codeman:tab-layout-pending-operations')).toBeNull();
  });
});
