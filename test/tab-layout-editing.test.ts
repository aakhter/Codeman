// @vitest-environment jsdom
/** @fileoverview COD-307 accessible tab-layout editing, persistence, and pointer contracts. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabLayoutService } from '../src/tab-layout-service.js';
import { installRouteErrorHandler } from '../src/web/route-error-handler.js';
import { registerTabLayoutRoutes } from '../src/web/routes/tab-layout-routes.js';

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

type Ref = { kind: 'session' | 'webview'; id: string; placement?: 'manual'; focus?: true };
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

describe('COD-309 browser child-placement intents', () => {
  const metadata = [
    { kind: 'session', id: 'parent', ownerValid: true },
    { kind: 'session', id: 'child', parentSessionId: 'parent', ownerValid: true },
    { kind: 'session', id: 'grandchild', parentSessionId: 'child', ownerValid: true },
    { kind: 'session', id: 'other', ownerValid: true },
    { kind: 'webview', id: 'web', ownerValid: true },
  ];

  it('keeps manual placement optimistic but leaves Follow-parent derivation to the server', () => {
    const h = loadHelper();
    const initial = layout();
    initial.groups[0].refs = [
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'grandchild' },
    ];
    initial.ungrouped.unshift({ kind: 'session', id: 'child', placement: 'manual' });

    const manual = h.applyOperation(initial, {
      type: 'setManualPlacement',
      ref: { kind: 'session', id: 'parent' },
      manual: true,
    });
    expect(manual.groups[0].refs[0]).toEqual({ kind: 'session', id: 'parent', placement: 'manual' });
    expect(
      h.applyOperation(initial, { type: 'followParent', ref: { kind: 'session', id: 'child' }, metadata })
    ).toEqual(initial);
    expect(() =>
      h.applyOperation(initial, { type: 'followParent', ref: { kind: 'session', id: 'missing' }, metadata })
    ).toThrow(/unknown ref/);
  });

  it('removes a fully committed mixed prefix while retaining its queued Follow-parent suffix', () => {
    const h = loadHelper();
    const initial = layout();
    const operations = [
      { type: 'createGroup', id: 'temporary', name: 'Temporary' },
      { type: 'deleteGroup', groupId: 'temporary' },
      { type: 'reorderGroup', groupId: 'g2', index: 0 },
      {
        type: 'moveRef',
        ref: { kind: 'session', id: 'other' },
        groupId: 'g1',
        index: 2,
        metadata,
      },
      { type: 'followParent', ref: { kind: 'session', id: 'child' }, metadata },
    ];
    const committedPrefix = operations
      .slice(0, 4)
      .reduce((candidate, operation) => h.applyOperation(candidate, operation), initial);

    expect(h.operationsAfterAppliedPrefix(initial, operations, { ...committedPrefix, version: 9 })).toEqual([
      operations[4],
    ]);
  });

  it('removes only the committed part of a mixed prefix before its queued Follow-parent suffix', () => {
    const h = loadHelper();
    const initial = layout();
    const operations = [
      { type: 'createGroup', id: 'new', name: 'New' },
      { type: 'deleteGroup', groupId: 'g2' },
      { type: 'reorderGroup', groupId: 'new', index: 0 },
      {
        type: 'moveRef',
        ref: { kind: 'session', id: 'parent' },
        groupId: 'new',
        index: 0,
        metadata,
      },
      { type: 'followParent', ref: { kind: 'session', id: 'child' }, metadata },
    ];
    const partiallyCommitted = operations
      .slice(0, 2)
      .reduce((candidate, operation) => h.applyOperation(candidate, operation), initial);

    expect(h.operationsAfterAppliedPrefix(initial, operations, { ...partiallyCommitted, version: 8 })).toEqual(
      operations.slice(2)
    );
  });

  it.each([
    ['beginning', 1],
    ['middle', 2],
    ['end', 3],
  ])('uses the authoritative applied count when Follow parent is at the %s of a batch', (_position, count) => {
    const h = loadHelper();
    const ordinary = [
      { type: 'createGroup', id: 'new', name: 'New' },
      { type: 'renameGroup', groupId: 'new', name: 'Renamed' },
    ];
    const follow = { type: 'followParent', ref: { kind: 'session', id: 'child' }, metadata };
    const operations =
      count === 1 ? [follow, ...ordinary] : count === 2 ? [ordinary[0], follow, ordinary[1]] : [...ordinary, follow];

    expect(h.operationsAfterAppliedPrefix(layout(), operations, layout(9), count)).toEqual(operations.slice(count));
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
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        layout: {
          ...remote,
          version: 9,
          groups: remote.groups.map((group: any) =>
            group.id === 'g1'
              ? {
                  ...group,
                  refs: [
                    { kind: 'session', id: 'parent' },
                    { kind: 'session', id: 'child' },
                  ],
                }
              : group
          ),
          ungrouped: remote.ungrouped.filter((ref: Ref) => ref.id !== 'child'),
        },
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

  it('adopts one stale-intent conflict without retrying when the destination was concurrently deleted', async () => {
    const h = loadHelper();
    const initial = layout();
    const current = {
      ...layout(8),
      groups: layout(8).groups.filter((group) => group.id !== 'g2'),
      ungrouped: [...layout(8).ungrouped, { kind: 'session', id: 'other' }],
    };
    const put = vi.fn(async () => ({ ok: false, status: 409, layout: current }));
    const reportError = vi.fn();
    const coordinator = h.createEditCoordinator({
      initialLayout: initial,
      applyLayout: vi.fn(),
      reportError,
      put,
      debounceMs: 0,
      schedule: setTimeout,
      cancel: clearTimeout,
    });

    coordinator.enqueue({
      type: 'moveRef',
      ref: { kind: 'session', id: 'other' },
      groupId: 'g2',
      index: 0,
      metadata: [
        { kind: 'session', id: 'parent' },
        { kind: 'session', id: 'child', parentSessionId: 'parent' },
        { kind: 'session', id: 'other' },
        { kind: 'webview', id: 'web' },
      ],
    });
    await vi.runAllTimersAsync();

    expect(put).toHaveBeenCalledOnce();
    expect(coordinator.getLayout()).toEqual(current);
    expect(reportError).toHaveBeenCalledOnce();
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

  it('does not let a late PUT response overwrite placements adopted with a newer GET/SSE layout', async () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    let resolvePut!: (response: unknown) => void;
    const delayedPut = new Promise((resolve) => {
      resolvePut = resolve;
    });
    app._apiPut = vi.fn(() => delayedPut);
    const coordinator = app._ensureTabLayoutEditCoordinator();
    coordinator.enqueue({ type: 'renameGroup', groupId: 'g1', name: 'Local edit' });
    const writing = coordinator.flush();
    await Promise.resolve();
    expect(app._apiPut).toHaveBeenCalledOnce();

    const external = {
      ...layout(8),
      groups: layout(8).groups.map((group) => (group.id === 'g1' ? { ...group, name: 'Newer server' } : group)),
    };
    const newerPlacement = {
      kind: 'session',
      id: 'child',
      state: 'dangling',
      parentId: 'missing-parent',
      canFollow: false,
    };
    app._applyTabLayout(external, [newerPlacement]);

    resolvePut({
      ok: true,
      status: 200,
      json: async () => ({
        data: {
          layout: { ...layout(5), groups: [] },
          placements: [{ kind: 'session', id: 'child', state: 'manual', parentId: 'parent', canFollow: true }],
        },
      }),
    });
    await writing;

    expect(app.tabLayoutVersion).toBe(8);
    expect(app.tabLayout.groups.find((group: any) => group.id === 'g1').name).toBe('Local edit');
    expect(app._tabRefPlacementState({ kind: 'session', id: 'child' }).state).toBe('dangling');
    const badge = document.querySelector<HTMLElement>('[data-id="child"] .tab-placement-state')!;
    expect(badge.textContent).toBe('Parent unavailable');
    expect(
      app._tabRefPlacementActions({ kind: 'session', id: 'child' }).map((action: any) => action.label)
    ).not.toContain('Follow parent again');
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
  app._tabPointerDrag = null;
  app._tabPendingFollowRefs = new Set();
  app._tabPlacementStates = new Map([
    ['session:child', { kind: 'session', id: 'child', state: 'inherited', parentId: 'parent', canFollow: false }],
  ]);
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
  app._putTabLayout = vi.fn(async ({ layout: next, operations }: { layout: Layout; operations?: any[] }) => {
    let authoritative = next;
    if (operations?.some((operation) => operation.type === 'followParent')) {
      const child = authoritative.ungrouped.find((ref) => ref.kind === 'session' && ref.id === 'child');
      if (child) {
        authoritative = {
          ...authoritative,
          groups: authoritative.groups.map((group) =>
            group.id === 'g1' ? { ...group, refs: [...group.refs, { kind: 'session', id: 'child' }] } : group
          ),
          ungrouped: authoritative.ungrouped.filter((ref) => !(ref.kind === 'session' && ref.id === 'child')),
        };
      }
    }
    return { ok: true, status: 200, layout: { ...authoritative, version: authoritative.version + 1 } };
  });
  app._putTabLayoutKeepalive = vi.fn(() => true);
}

function clickMenuItem(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === label
  );
  expect(button, `menu item ${label}`).toBeTruthy();
  button!.click();
}

function openGroupMenu(app: Record<string, any>, trigger: HTMLElement, groupId = 'g1') {
  app.openTabGroupMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: trigger }, groupId);
}

describe('COD-319 Focus smart group rendering', () => {
  it('renders vertical shortcuts ahead of canonical groups without numbering or tab semantics', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[0] = { kind: 'session', id: 'parent', focus: true };
    app.tabLayout.ungrouped[0] = { kind: 'webview', id: 'web', focus: true };
    app._fullRenderSessionTabs();

    const focus = document.querySelector<HTMLElement>('[data-tab-focus-group]')!;
    expect(focus).not.toBeNull();
    expect(focus.previousElementSibling).toBeNull();
    expect(focus.querySelectorAll('[data-tab-focus-shortcut]')).toHaveLength(2);
    expect(focus.querySelector('[data-tab-focus-shortcut="session:parent"]')).not.toBeNull();
    expect(focus.querySelector('[data-tab-focus-shortcut="webview:web"]')).not.toBeNull();
    expect(focus.querySelector('.tab-number, [data-tab-ref-drag]')).toBeNull();
    expect(focus.querySelector('[aria-selected]')).toBeNull();
    expect(focus.querySelector('[data-tab-focus-shortcut="session:parent"]')?.hasAttribute('oncontextmenu')).toBe(
      false
    );
    expect(focus.querySelector('[data-tab-focus-shortcut="session:parent"] .tab-more')?.textContent).toBe('⋯');
    expect(focus.querySelector('[data-tab-focus-shortcut="session:parent"]')?.getAttribute('aria-current')).toBe(
      'page'
    );
    expect(document.querySelectorAll('[data-id="parent"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-webview-id="web"]')).toHaveLength(1);
  });

  it('keeps a focused shortcut visible when its canonical real group is collapsed', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[1] = { kind: 'session', id: 'child', focus: true };
    app.collapsedTabGroupIds.add('g1');
    app._fullRenderSessionTabs();

    expect(document.querySelector('[data-tab-focus-shortcut="session:child"]')).not.toBeNull();
    expect(document.querySelector('[data-id="child"]')).toBeNull();
  });

  it('activates session and webview shortcuts with Enter and Space through roving focus', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[0] = { kind: 'session', id: 'parent', focus: true };
    app.tabLayout.ungrouped[0] = { kind: 'webview', id: 'web', focus: true };
    app._fullRenderSessionTabs();
    const session = document.querySelector<HTMLElement>('[data-tab-focus-shortcut="session:parent"]')!;
    const webview = document.querySelector<HTMLElement>('[data-tab-focus-shortcut="webview:web"]')!;

    session.focus();
    session.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    webview.focus();
    webview.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));

    expect(app.selectSession).toHaveBeenCalledWith('parent');
    expect(app.openWebview).toHaveBeenCalledWith('web');
    expect(app._tabLayoutIdentity(session)).toBe('focus:session:parent');
    expect(app._tabLayoutIdentity(webview)).toBe('focus:webview:web');
  });

  it('persists Focus collapse independently of real groups and hides all shortcuts', () => {
    localStorage.clear();
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[0] = { kind: 'session', id: 'parent', focus: true };
    app._fullRenderSessionTabs();

    let header = document
      .querySelector<HTMLElement>('[data-tab-focus-toggle]')!
      .closest<HTMLElement>('[role="treeitem"]')!;
    header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.querySelector('[data-tab-focus-toggle]')?.getAttribute('aria-expanded')).toBe('false');
    header = document.querySelector<HTMLElement>('[data-tab-focus-toggle]')!.closest<HTMLElement>('[role="treeitem"]')!;
    header.focus();
    header.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.querySelector('[data-tab-focus-toggle]')?.getAttribute('aria-expanded')).toBe('true');

    expect(app.toggleFocusGroupCollapsed(true)).toBe(true);
    expect(localStorage.getItem('codeman:focus-group-collapsed')).toBe('true');
    expect(document.querySelector('[data-tab-focus-toggle]')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-tab-focus-shortcut]')).toBeNull();
    expect(app.toggleFocusGroupCollapsed(false)).toBe(true);
    expect(document.querySelector('[data-tab-focus-shortcut="session:parent"]')).not.toBeNull();
  });

  it('does not collide when a real group ID is @focus', () => {
    localStorage.clear();
    const app = makeInteractionApp();
    app.tabLayout.groups[0].id = '@focus';
    app.tabLayout.groups[0].refs[0] = { kind: 'session', id: 'parent', focus: true };
    app._fullRenderSessionTabs();

    expect(app.toggleTabGroupCollapsed('@focus', true)).toBe(true);
    expect(app.toggleFocusGroupCollapsed(true)).toBe(true);
    expect(app.collapsedTabGroupIds.has('@focus')).toBe(true);
    expect(app.focusTabGroupCollapsed).toBe(true);
    expect(JSON.parse(localStorage.getItem('codeman:tab-groups-collapsed')!)).toEqual(['@focus']);
    expect(localStorage.getItem('codeman:focus-group-collapsed')).toBe('true');

    expect(app.toggleFocusGroupCollapsed(false)).toBe(true);
    expect(app.collapsedTabGroupIds.has('@focus')).toBe(true);
    expect(app.focusTabGroupCollapsed).toBe(false);
  });

  it('offers exact Focus actions from canonical and shortcut menus', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[0] = { kind: 'session', id: 'parent', focus: true };
    app.loadAppSettingsFromStorage = () => ({ showTabDetachButton: false });
    app.openSessionOptions = vi.fn();
    app.requestCloseSession = vi.fn();
    app.editTabLayout = vi.fn(() => true);
    app._fullRenderSessionTabs();

    const canonicalSessionTrigger = document.querySelector<HTMLElement>('[data-id="parent"] .tab-more')!;
    app.openTabRailActionMenu(
      { preventDefault() {}, stopPropagation() {}, currentTarget: canonicalSessionTrigger },
      'parent'
    );
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toContain(
      'Remove from Focus'
    );
    clickMenuItem('Remove from Focus');
    expect(app.editTabLayout).toHaveBeenLastCalledWith(
      { type: 'setFocus', ref: { kind: 'session', id: 'parent' }, focused: false },
      'session:parent'
    );

    const canonicalWebTrigger = document.querySelector<HTMLElement>('[data-webview-id="web"] .tab-more')!;
    app.openTabRefMoveMenu(
      { preventDefault() {}, stopPropagation() {}, currentTarget: canonicalWebTrigger },
      { kind: 'webview', id: 'web' }
    );
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toContain(
      'Add to Focus'
    );
    document.querySelector('.tab-layout-ref-move-menu')?.remove();

    const shortcutTrigger = document.querySelector<HTMLElement>('[data-tab-focus-shortcut] .tab-more')!;
    app.openFocusShortcutMenu(
      { preventDefault() {}, stopPropagation() {}, currentTarget: shortcutTrigger },
      { kind: 'session', id: 'parent' }
    );
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual([
      'Remove from Focus',
    ]);
  });

  it('keeps canonical markers and shortcut state synchronized without duplicate selected semantics', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[0] = { kind: 'session', id: 'parent', focus: true };
    app.tabLayout.ungrouped[0] = { kind: 'webview', id: 'web', focus: true };
    app._fullRenderSessionTabs();

    const canonical = document.querySelector<HTMLElement>('[data-id="parent"]')!;
    let shortcut = document.querySelector<HTMLElement>('[data-tab-focus-shortcut="session:parent"]')!;
    expect(canonical.querySelector('.tab-focus-marker')).not.toBeNull();
    expect(shortcut.querySelector('.tab-focus-marker')).toBeNull();
    expect(shortcut.classList.contains('active')).toBe(false);
    expect(shortcut.hasAttribute('aria-selected')).toBe(false);

    app.activeSessionId = 'child';
    app._updateActiveTabImmediate('child');
    expect(shortcut.getAttribute('aria-current')).toBe('false');
    app.activeSessionId = 'parent';
    app._updateActiveTabImmediate('parent');
    expect(shortcut.getAttribute('aria-current')).toBe('page');

    app.terminalLoadStates.set('parent', { generation: 1, phase: 'history' });
    app._updateTerminalLoadTab('parent');
    expect(
      document.querySelectorAll('[data-id="parent"].tab-loading, [data-focus-session-id="parent"].tab-loading')
    ).toHaveLength(2);

    app.sessions.get('parent').name = 'Renamed focus';
    app._renderSessionTabsImmediate();
    expect(
      [...document.querySelectorAll('[data-id="parent"] .tab-name, [data-focus-session-id="parent"] .tab-name')].map(
        (element) => element.textContent
      )
    ).toEqual(['Renamed focus', 'Renamed focus']);

    app.activeSessionId = 'parent';
    app.activeWebviewId = 'web';
    app._updateActiveWebviewTab();
    const webShortcut = document.querySelector<HTMLElement>('[data-focus-webview-id="web"]')!;
    expect(webShortcut.getAttribute('aria-current')).toBe('page');
    expect(webShortcut.classList.contains('active')).toBe(false);
    expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);

    const css = readFileSync(join(PUBLIC, 'styles.css'), 'utf8');
    expect(css).toContain("html[data-tab-orientation='vertical'] .tab-layout-focus-group");
    expect(css).toContain("html[data-tab-orientation='vertical'] .tab-focus-shortcut[aria-current='page']");
  });
});

describe('COD-315 dismissible group menu', () => {
  it('dismisses on an outside tab pointerdown without suppressing activation or running an action', () => {
    const app = makeInteractionApp();
    app.startTabGroupRename = vi.fn();
    app.editTabLayout = vi.fn();
    app.deleteTabGroup = vi.fn();
    app._fullRenderSessionTabs();
    const trigger = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-menu')!;
    const tab = document.querySelector<HTMLElement>('[data-id="other"]')!;
    const bubbled = vi.fn();
    tab.removeAttribute('onclick');
    tab.addEventListener('click', (event) => app.handleSessionTabClick(event, 'other'));
    document.addEventListener('pointerdown', bubbled, { once: true });

    openGroupMenu(app, trigger);
    const pointerdown = new Event('pointerdown', { bubbles: true, cancelable: true });
    tab.dispatchEvent(pointerdown);
    tab.click();

    expect(document.querySelector('.tab-layout-group-action-menu')).toBeNull();
    expect(pointerdown.defaultPrevented).toBe(false);
    expect(bubbled).toHaveBeenCalledOnce();
    expect(app.selectSession).toHaveBeenCalledWith('other');
    expect(app.startTabGroupRename).not.toHaveBeenCalled();
    expect(app.editTabLayout).not.toHaveBeenCalled();
    expect(app.deleteTabGroup).not.toHaveBeenCalled();
  });

  it('dismisses on document Escape after focus moves and restores the trigger', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const trigger = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-menu')!;
    const displaced = document.createElement('button');
    document.body.appendChild(displaced);
    openGroupMenu(app, trigger);
    displaced.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(document.querySelector('.tab-layout-group-action-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('consumes Escape before the shipping listener can close unrelated UI', () => {
    const app = makeInteractionApp();
    app._maybeCloseResponseViewerOnEscape = vi.fn(() => false);
    app.closeAllPanels = vi.fn();
    app.closeHelp = vi.fn();
    app.closeShortcutOverlay = vi.fn();
    app.closeSessionManager = vi.fn();
    app.closeCommandPalette = vi.fn();
    app.getShortcutRegistry = vi.fn(() => []);
    app.setupColorPicker = vi.fn();
    app._scheduleTerminalRepaint = vi.fn();
    app._fullRenderSessionTabs();
    const trigger = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-menu')!;
    const displaced = document.createElement('button');
    document.body.appendChild(displaced);
    const documentAddSpy = vi.spyOn(document, 'addEventListener').mockImplementation(() => {});
    const windowAddSpy = vi.spyOn(window, 'addEventListener').mockImplementation(() => {});
    app.setupEventListeners();
    const shippingKeydown = documentAddSpy.mock.calls.find(([type]) => type === 'keydown')?.[1] as EventListener;
    documentAddSpy.mockRestore();
    windowAddSpy.mockRestore();
    document.addEventListener('keydown', shippingKeydown, true);

    try {
      openGroupMenu(app, trigger);
      displaced.focus();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      displaced.dispatchEvent(escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(document.querySelector('.tab-layout-group-action-menu')).toBeNull();
      expect(document.activeElement).toBe(trigger);
      expect(app.closeAllPanels).not.toHaveBeenCalled();
      expect(app.closeHelp).not.toHaveBeenCalled();
      expect(app.closeShortcutOverlay).not.toHaveBeenCalled();
      expect(app.closeSessionManager).not.toHaveBeenCalled();
      expect(app.closeCommandPalette).not.toHaveBeenCalled();
    } finally {
      app.closeTabGroupMenu?.();
      document.removeEventListener('keydown', shippingKeydown, true);
    }
  });

  it('toggles from the same trigger, replaces from another trigger, and manages ARIA state', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const first = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-menu')!;
    const second = document.querySelector<HTMLElement>('[data-tab-group-id="g2"] .tab-layout-group-menu')!;
    expect(first.getAttribute('aria-haspopup')).toBe('menu');
    expect(first.getAttribute('aria-expanded')).toBe('false');

    openGroupMenu(app, first);
    expect(first.getAttribute('aria-expanded')).toBe('true');
    first.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelectorAll('.tab-layout-group-action-menu')).toHaveLength(1);
    openGroupMenu(app, first);
    expect(document.querySelector('.tab-layout-group-action-menu')).toBeNull();
    expect(first.getAttribute('aria-expanded')).toBe('false');

    openGroupMenu(app, first);
    openGroupMenu(app, second, 'g2');
    expect(document.querySelectorAll('.tab-layout-group-action-menu')).toHaveLength(1);
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(second.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement?.textContent).toBe('Rename group');
    app.closeTabGroupMenu();
  });

  it('preserves wrapping arrow navigation and runs the chosen action exactly once', () => {
    const app = makeInteractionApp();
    app.startTabGroupRename = vi.fn();
    app._fullRenderSessionTabs();
    const trigger = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-menu')!;
    openGroupMenu(app, trigger);
    const items = [...document.querySelectorAll<HTMLButtonElement>('.tab-layout-group-action-menu [role="menuitem"]')];

    items[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(items.at(-1));
    items.at(-1)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(items[0]);
    items[0].click();

    expect(app.startTabGroupRename).toHaveBeenCalledOnce();
    expect(app.startTabGroupRename).toHaveBeenCalledWith('g1');
    expect(document.querySelector('.tab-layout-group-action-menu')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('pairs transient document listeners across repeated open and close cycles', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const trigger = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-menu')!;
    const addSpy = vi.spyOn(document, 'addEventListener');
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    try {
      openGroupMenu(app, trigger);
      app.closeTabGroupMenu();
      openGroupMenu(app, trigger);
      app.closeTabGroupMenu();

      const additions = addSpy.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown');
      const removals = removeSpy.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown');
      expect(additions).toHaveLength(4);
      expect(removals).toHaveLength(4);
      expect(removals.map(([type, listener, options]) => [type, listener, options])).toEqual(
        additions.map(([type, listener, options]) => [type, listener, options])
      );
    } finally {
      app.closeTabGroupMenu?.();
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  it('closes the menu and listeners before a full tab-tree rerender disconnects its trigger', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const trigger = document.querySelector<HTMLElement>('[data-tab-group-id="g1"] .tab-layout-group-menu')!;
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    try {
      openGroupMenu(app, trigger);
      app._fullRenderSessionTabs();

      expect(trigger.isConnected).toBe(false);
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelector('.tab-layout-group-action-menu')).toBeNull();
      expect(removeSpy.mock.calls.filter(([type]) => type === 'pointerdown' || type === 'keydown')).toHaveLength(2);
    } finally {
      app.closeTabGroupMenu?.();
      removeSpy.mockRestore();
    }
  });
});

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
  it('refreshes placement accessibility during an unchanged-structure incremental render', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[1] = { kind: 'session', id: 'child', placement: 'manual' };
    app._fullRenderSessionTabs();
    const before = document.querySelector<HTMLElement>('[data-id="child"]')!;
    expect(before.getAttribute('aria-label')).toContain('can follow Parent');

    app.sessions.get('parent').name = 'Renamed parent';
    app._renderSessionTabsImmediate();

    const child = document.querySelector<HTMLElement>('[data-id="child"]')!;
    const badge = child.querySelector<HTMLElement>('.tab-placement-state--manual')!;
    expect(child.getAttribute('aria-label')).toContain('Placed manually; can follow Renamed parent');
    expect(child.title).toContain('Placed manually; can follow Renamed parent');
    expect(badge.getAttribute('aria-label')).toBe('Placed manually; can follow Renamed parent');
    expect(badge.title).toBe('Placed manually; can follow Renamed parent');
  });

  it('renders understandable escaped placement status and runs Follow parent again through the real coordinator', async () => {
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
    expect(document.querySelector('.tab-placement-state--following')?.textContent).toBe('Following parent');
    await app._tabLayoutEditCoordinator.flush();

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
    app._tabPlacementStates.set('session:child', {
      kind: 'session',
      id: 'child',
      state: 'dangling',
      parentId: 'parent',
      canFollow: false,
    });
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
    app._tabPlacementStates.set('session:child', {
      kind: 'session',
      id: 'child',
      state: 'cycle',
      parentId: 'parent',
      canFollow: false,
    });
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
      app._tabPlacementStates.set('session:child', {
        kind: 'session',
        id: 'child',
        state: 'dangling',
        parentId: 'parent',
        canFollow: false,
      });
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

  it('keeps horizontal navigation flat and activates session/webview tabs with Enter or Space', () => {
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
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(app.selectSession).toHaveBeenCalledTimes(2);

    const webview = tabs.find((tab) => tab.dataset.webviewId === 'web')!;
    webview.focus();
    webview.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    webview.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(app.openWebview).toHaveBeenNthCalledWith(1, 'web');
    expect(app.openWebview).toHaveBeenNthCalledWith(2, 'web');
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
  it('previews a nested pointer move and commits it through the authenticated route and authoritative service', async () => {
    vi.stubEnv('CODEMAN_MULTIUSER', '1');
    const serverLayout: Layout = {
      ...layout(),
      groups: layout().groups.map((group) =>
        group.id === 'g1'
          ? {
              ...group,
              refs: [...group.refs, { kind: 'session' as const, id: 'grandchild' }],
            }
          : group
      ),
    };
    const layouts: Record<string, Layout> = { alice: serverLayout };
    const sessions = {
      parent: { id: 'parent', owner: 'alice', createdAt: 1 },
      child: { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      grandchild: { id: 'grandchild', owner: 'alice', createdAt: 3, parentSessionId: 'child' },
      other: { id: 'other', owner: 'alice', createdAt: 4 },
      foreign: { id: 'foreign', owner: 'bob', createdAt: 5 },
    };
    const store = {
      getTabLayout: (owner: string) => layouts[owner] ?? null,
      setTabLayout: (owner: string, next: Layout) => {
        layouts[owner] = next;
      },
      getSessions: () => sessions,
      getSessionOrder: () => ['parent', 'child', 'grandchild', 'other'],
    };
    const service = new TabLayoutService({
      store: store as never,
      sessions: new Map(),
      readWebviews: async () => [{ id: 'web', owner: 'alice' }],
      broadcast: vi.fn(),
      now: () => '2026-08-16T12:00:00.000Z',
    });
    const server = Fastify({ logger: false });
    server.addHook('onRequest', async (request) => {
      (request as unknown as { authUser: { username: string; role: 'user' } }).authUser = {
        username: 'alice',
        role: 'user',
      };
    });
    registerTabLayoutRoutes(server, { tabLayouts: service });
    installRouteErrorHandler(server);
    await server.ready();
    const initialSnapshot = await service.getSnapshot('alice');

    const app = makeInteractionApp();
    app.sessions.set('grandchild', { id: 'grandchild', name: 'Grandchild', parentSessionId: 'child' });
    app.tabLayout = initialSnapshot.layout;
    app.tabLayoutVersion = initialSnapshot.layout.version;
    app._tabPlacementStates = new Map(
      initialSnapshot.placements.map((placement) => [`${placement.kind}:${placement.id}`, placement])
    );
    const wirePayloads: unknown[] = [];
    app._apiPut = async (path: string, payload: unknown) => {
      wirePayloads.push(payload);
      const response = await server.inject({ method: 'PUT', url: path, payload });
      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => response.json(),
      };
    };
    app._fullRenderSessionTabs();
    const container = document.getElementById('sessionTabs') as HTMLElement & {
      setPointerCapture: ReturnType<typeof vi.fn>;
    };
    container.setPointerCapture = vi.fn();
    const parent = container.querySelector<HTMLElement>('[data-id="parent"]')!;
    const zone = container.querySelector<HTMLElement>('[data-tab-drop-group="g2"][data-tab-drop-index="1"]')!;
    (document as any).elementFromPoint = vi.fn(() => zone);

    const parentHandle = parent.querySelector<HTMLElement>('[data-tab-ref-drag]')!;
    parentHandle.dispatchEvent(
      pointerEvent('pointerdown', { pointerId: 71, pointerType: 'mouse', clientX: 1, clientY: 1 })
    );
    container.dispatchEvent(
      pointerEvent('pointermove', { pointerId: 71, pointerType: 'mouse', clientX: 20, clientY: 20 })
    );
    expect([...container.querySelectorAll<HTMLElement>('.tab-layout-drag-block')].map((tab) => tab.dataset.id)).toEqual(
      ['parent', 'child', 'grandchild']
    );
    container.dispatchEvent(
      pointerEvent('pointerup', { pointerId: 71, pointerType: 'mouse', clientX: 20, clientY: 20 })
    );
    await app._tabLayoutEditCoordinator.flush();

    expect(wirePayloads).toEqual([
      {
        baseVersion: initialSnapshot.layout.version,
        operations: [{ type: 'moveRef', ref: { kind: 'session', id: 'parent' }, groupId: 'g2', index: 1 }],
        recoveryBaseLayout: initialSnapshot.layout,
      },
    ]);
    expect(layouts.alice.version).toBe(initialSnapshot.layout.version + 1);
    expect(layouts.alice.groups[1].refs.map((ref: Ref) => ref.id)).toEqual(['other', 'parent', 'child', 'grandchild']);
    expect(app.tabLayout.groups[1].refs.map((ref: Ref) => ref.id)).toEqual(['other', 'parent', 'child', 'grandchild']);

    const stale = await server.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: {
        baseVersion: initialSnapshot.layout.version,
        operations: [{ type: 'moveRef', ref: { kind: 'session', id: 'foreign' }, groupId: null, index: 0 }],
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().data.layout.version).toBe(initialSnapshot.layout.version + 1);
    const crossOwner = await server.inject({
      method: 'PUT',
      url: '/api/tab-layout',
      payload: {
        baseVersion: layouts.alice.version,
        operations: [{ type: 'moveRef', ref: { kind: 'session', id: 'foreign' }, groupId: null, index: 0 }],
      },
    });
    expect(crossOwner.statusCode).toBe(400);
    expect(layouts.alice.ungrouped.some((ref) => ref.id === 'foreign')).toBe(false);
    await server.close();
    vi.unstubAllEnvs();
  });

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

    const handle = tab.querySelector<HTMLElement>('[data-tab-ref-drag]')!;
    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 7, pointerType: 'mouse', clientX: 1, clientY: 1 }));
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

  it('does not advertise Focus shortcuts as drag destinations', () => {
    const app = makeInteractionApp();
    app.tabLayout.groups[0].refs[0] = { kind: 'session', id: 'parent', focus: true };
    app._fullRenderSessionTabs();
    const container = document.getElementById('sessionTabs') as HTMLElement & {
      setPointerCapture: ReturnType<typeof vi.fn>;
    };
    container.setPointerCapture = vi.fn();
    const handle = container.querySelector<HTMLElement>('[data-id="child"] [data-tab-ref-drag]')!;
    const shortcut = container.querySelector<HTMLElement>('[data-tab-focus-shortcut="session:parent"]')!;
    (document as any).elementFromPoint = vi.fn(() => shortcut);

    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 72, pointerType: 'mouse', clientX: 1, clientY: 1 }));
    container.dispatchEvent(
      pointerEvent('pointermove', { pointerId: 72, pointerType: 'mouse', clientX: 20, clientY: 20 })
    );

    expect(shortcut.classList.contains('tab-layout-drop-active')).toBe(false);
    container.dispatchEvent(
      pointerEvent('pointercancel', { pointerId: 72, pointerType: 'mouse', clientX: 20, clientY: 20 })
    );
  });

  it('starts reference dragging only from the dedicated handle', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const container = document.getElementById('sessionTabs') as HTMLElement & {
      setPointerCapture: ReturnType<typeof vi.fn>;
    };
    container.setPointerCapture = vi.fn();
    const tab = container.querySelector<HTMLElement>('[data-id="parent"]')!;

    for (const target of [tab, tab.querySelector('.tab-status')!, tab.querySelector('.tab-name')!]) {
      target.dispatchEvent(
        pointerEvent('pointerdown', { pointerId: 17, pointerType: 'mouse', clientX: 1, clientY: 1 })
      );
      expect(app._tabPointerDrag).toBeNull();
      expect(container.setPointerCapture).not.toHaveBeenCalled();
    }
    tab.dispatchEvent(pointerEvent('pointerdown', { pointerId: 19, pointerType: 'touch', clientX: 1, clientY: 1 }));
    expect(app._tabPointerDrag).toBeNull();
    expect(container.setPointerCapture).not.toHaveBeenCalled();

    const handle = tab.querySelector<HTMLElement>('[data-tab-ref-drag]')!;
    handle.dispatchEvent(pointerEvent('pointerdown', { pointerId: 18, pointerType: 'mouse', clientX: 1, clientY: 1 }));
    expect(app._tabPointerDrag?.source).toMatchObject({
      type: 'ref',
      ref: { kind: 'session', id: 'parent' },
    });
    expect(container.setPointerCapture).toHaveBeenCalledWith(18);
  });

  it('keeps the drag handle and tab actions separate from row activation', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();
    const tab = document.querySelector<HTMLElement>('[data-id="parent"]')!;
    const handlers = new Map(
      ['.tab-ref-drag-handle', '.tab-gear', '.tab-detach', '.tab-close', '.tab-more'].map((selector) => [
        selector,
        tab.querySelector<HTMLElement>(selector)!.getAttribute('onclick'),
      ])
    );

    for (const handler of handlers.values()) expect(handler).toContain('event.stopPropagation()');
    expect(handlers.get('.tab-ref-drag-handle')).toContain('event.preventDefault()');
    expect(tab.querySelector<HTMLElement>('.tab-ref-drag-handle')!.tabIndex).toBe(-1);
    expect(handlers.get('.tab-gear')).toContain('app.openSessionOptions');
    expect(handlers.get('.tab-detach')).toContain('app.detachSession');
    expect(handlers.get('.tab-close')).toContain('app.requestCloseSession');
    expect(handlers.get('.tab-more')).toContain('app.openTabRailActionMenu');
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
    expect(css).toMatch(/\.tab-ref-drag-handle\s*\{[^}]*display:\s*inline-flex/s);
    expect(css).toMatch(/\.tab-ref-drag-handle\s*\{[^}]*cursor:\s*grab/s);
    expect(css).toMatch(/\.tab-ref-drag-handle\s*\{[^}]*touch-action:\s*none/s);
    expect(css).toMatch(/\.session-tab\s*\{[^}]*cursor:\s*pointer/s);
    expect(css).toMatch(/\.session-tab:hover\s*\{[^}]*background:/s);
    expect(css).toMatch(/\.session-tab \.tab-close\s*\{[^}]*cursor:\s*pointer/s);
  });
});

describe('COD-322 drag handle affordance', () => {
  it('renders a glyph-free grip at the leading edge of session and web tabs', () => {
    const app = makeInteractionApp();
    app._fullRenderSessionTabs();

    for (const selector of ['[data-id="parent"]', '[data-webview-id="web"]']) {
      const tab = document.querySelector<HTMLElement>(selector)!;
      const handle = tab.querySelector<HTMLElement>('.tab-ref-drag-handle')!;
      // The hamburger glyph is what made the handle read as a menu button; the
      // grip is painted in CSS instead so nothing menu-shaped is in the DOM.
      expect(handle.textContent).toBe('');
      expect(handle.getAttribute('title')).toBe('Drag to reorder');
      // Grip-first, so the handle stops competing with the trailing actions.
      expect(tab.firstElementChild).toBe(handle);
    }
  });

  it('paints an orientation-aware grip that rests dim and lights up with the row', () => {
    const css = readFileSync(join(PUBLIC, 'styles.css'), 'utf8');
    // Dimmed, never display:none — COD-316 needs the handle visible and tappable
    // in both orientations, and touch dragging is handle-only.
    expect(css).toMatch(/\.tab-ref-drag-handle\s*\{[^}]*opacity:\s*0\.35/s);
    expect(css).toMatch(/\.session-tab:hover\s+\.tab-ref-drag-handle[^{]*\{[^}]*opacity:\s*1/s);
    // The dot grid IS the content box, so it has to be clipped to it.
    expect(css).toMatch(/\.tab-ref-drag-handle\s*\{[^}]*background-clip:\s*content-box/s);
    // Transposed per orientation, so the grip always runs along the axis the
    // tab actually moves: 2 columns in the strip, 2 rows in the rail.
    const gripBox = (selector: string) => {
      const rule = new RegExp(`${selector}[^{]*\\.tab-ref-drag-handle\\s*\\{([^}]*)\\}`, 's').exec(css)?.[1];
      return /padding:\s*(\S+)\s+(\S+)\s*;/.exec(rule ?? '')?.slice(1, 3);
    };
    // The strip rule keys off :not(vertical), so it also covers the first paint
    // before settings-ui.js sets the attribute at all.
    const strip = gripBox("html:not\\(\\[data-tab-orientation='vertical'\\]\\)");
    expect(strip).toBeDefined();
    expect(strip![0]).not.toBe(strip![1]);
    expect(gripBox("html\\[data-tab-orientation='vertical'\\]")).toEqual([...strip!].reverse());
  });
});

describe('COD-307 page lifecycle persistence', () => {
  it('persists and keepalive-flushes the rebased retry state during pagehide', async () => {
    vi.useFakeTimers();
    const h = loadHelper();
    const initial = layout();
    const remote = {
      ...layout(8),
      groups: [...layout(8).groups, { id: 'new', name: 'New', refs: [] }],
    };
    let resolveRetry!: (response: unknown) => void;
    const retry = new Promise((resolve) => {
      resolveRetry = resolve;
    });
    let markRetryStarted!: () => void;
    const retryStarted = new Promise<void>((resolve) => {
      markRetryStarted = resolve;
    });
    const put = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 409, layout: remote, appliedOperationCount: 1 })
      .mockImplementationOnce(() => {
        markRetryStarted();
        return retry;
      });
    const keepalive = vi.fn();
    const coordinator = h.createEditCoordinator({
      initialLayout: initial,
      applyLayout: vi.fn(),
      put,
      putKeepalive: keepalive,
      debounceMs: 180,
      schedule: setTimeout,
      cancel: clearTimeout,
    });
    const remaining = { type: 'renameGroup', groupId: 'new', name: 'Recovered' };
    coordinator.enqueue({ type: 'createGroup', id: 'new', name: 'New' });
    coordinator.enqueue(remaining);
    const writing = coordinator.flush();
    await retryStarted;
    expect(put).toHaveBeenCalledTimes(2);

    const app = makeInteractionApp();
    app._tabLayoutEditCoordinator = coordinator;
    app._tabLayoutCoordinator = null;
    app._tabLayoutPagehideHandler = null;
    app._fetchTabLayout = vi.fn(async () => ({ layout: remote, placements: [] }));
    app._applyTabLayoutFallback = vi.fn();
    app._ensureTabLayoutCoordinator();
    window.dispatchEvent(new Event('pagehide'));

    expect(keepalive).toHaveBeenCalledWith({
      baseVersion: 8,
      layout: expect.any(Object),
      operations: [remaining],
      recoveryBaseLayout: remote,
    });
    expect(JSON.parse(sessionStorage.getItem('codeman:tab-layout-pending-operations')!)).toEqual({
      baseLayout: remote,
      operations: [remaining],
    });

    resolveRetry({
      ok: true,
      status: 200,
      layout: {
        ...remote,
        version: 9,
        groups: remote.groups.map((group) => (group.id === 'new' ? { ...group, name: 'Recovered' } : group)),
      },
    });
    await writing;
    expect(coordinator.getLayout().version).toBe(9);
    expect(coordinator.getLayout().groups.find((group: any) => group.id === 'new').name).toBe('Recovered');
    sessionStorage.removeItem('codeman:tab-layout-pending-operations');
    vi.useRealTimers();
  });

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
      operations: [{ type: 'renameGroup', groupId: 'g1', name: 'Leaving' }],
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

  it('recovers persisted ordinary operations after an authoritatively applied middle Follow-parent prefix', async () => {
    const base = layout();
    base.groups[0].refs = [{ kind: 'session', id: 'parent' }];
    base.ungrouped.unshift({ kind: 'session', id: 'child', placement: 'manual' });
    const operations = [
      { type: 'createGroup', id: 'new', name: 'New' },
      { type: 'followParent', ref: { kind: 'session', id: 'child' } },
      { type: 'renameGroup', groupId: 'new', name: 'Recovered' },
    ];
    sessionStorage.setItem('codeman:tab-layout-pending-operations', JSON.stringify({ baseLayout: base, operations }));
    const current = {
      ...base,
      version: 8,
      groups: [
        {
          ...base.groups[0],
          refs: [
            { kind: 'session', id: 'parent' },
            { kind: 'session', id: 'child' },
          ],
        },
        ...base.groups.slice(1),
        { id: 'new', name: 'New', refs: [] },
      ],
      ungrouped: base.ungrouped.filter((ref) => ref.id !== 'child'),
    };
    const app = makeInteractionApp();
    app.tabLayout = null;
    app.tabLayoutVersion = null;
    app._tabLayoutEditCoordinator = null;
    app._putTabLayout = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        layout: current,
        placements: [{ kind: 'session', id: 'child', state: 'inherited', parentId: 'parent', canFollow: false }],
        appliedOperationCount: 2,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        layout: {
          ...current,
          version: 9,
          groups: current.groups.map((group) => (group.id === 'new' ? { ...group, name: 'Recovered' } : group)),
        },
        placements: [{ kind: 'session', id: 'child', state: 'inherited', parentId: 'parent', canFollow: false }],
      });

    app._applyTabLayout(current);
    expect(app._tabLayoutEditCoordinator).toBeTruthy();
    await app._tabLayoutEditCoordinator.flush();

    expect(app._putTabLayout).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        baseVersion: 4,
        operations: [operations[0], expect.objectContaining(operations[1]), operations[2]],
        recoveryBaseLayout: base,
      })
    );
    expect(app._putTabLayout).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        baseVersion: 8,
        operations: [{ type: 'renameGroup', groupId: 'new', name: 'Recovered' }],
      })
    );
    expect(app.tabLayout.groups.find((group) => group.id === 'new')?.name).toBe('Recovered');
    expect(app.showToast).not.toHaveBeenCalled();
  });
});
