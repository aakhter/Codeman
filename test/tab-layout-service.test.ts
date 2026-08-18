/**
 * @fileoverview Tab-layout server coordinator lifecycle, ownership, and version tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { TabLayoutService } from '../src/tab-layout-service.js';
import { TabLayoutValidationError } from '../src/tab-layout.js';
import { SseEvent } from '../src/web/sse-events.js';
import type { TabLayout } from '../src/tab-layout.js';

type SessionFact = { id: string; owner?: string; createdAt: number; parentSessionId?: string; pinned?: boolean };

function createHarness(
  options: {
    layouts?: Record<string, TabLayout>;
    persisted?: SessionFact[];
    live?: SessionFact[];
    webviews?: Array<{ id: string; owner?: string }>;
  } = {}
) {
  const layouts = { ...(options.layouts ?? {}) };
  const persisted = Object.fromEntries((options.persisted ?? []).map((session) => [session.id, session]));
  const live = new Map((options.live ?? []).map((session) => [session.id, session]));
  const store = {
    getTabLayout: vi.fn((owner: string) => layouts[owner] ?? null),
    setTabLayout: vi.fn((owner: string, value: TabLayout) => {
      layouts[owner] = value;
    }),
    getSessions: vi.fn(() => persisted),
    getSessionOrder: vi.fn(() => []),
  };
  const broadcast = vi.fn();
  const service = new TabLayoutService({
    store: store as never,
    sessions: live as never,
    readWebviews: vi.fn(async () => options.webviews ?? []),
    broadcast,
    now: () => '2026-08-16T12:00:00.000Z',
  });
  return { service, store, broadcast, layouts, live, persisted };
}

const existing = (refs: TabLayout['ungrouped'], version = 7): TabLayout => ({
  version,
  groups: [],
  ungrouped: refs,
  updatedAt: '2026-08-15T00:00:00.000Z',
});

describe('TabLayoutService', () => {
  it('guards destructive transactions by restoration state while allowing skipped test mode', async () => {
    const h = createHarness({ layouts: { '@single': existing([{ kind: 'session', id: 'mine' }]) } });
    const action = vi.fn(async () => 'removed');

    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).rejects.toThrow(/restoration.*pending/i);
    expect(action).not.toHaveBeenCalled();

    h.service.markRestorationFailed();
    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).rejects.toThrow(/restoration.*failed/i);
    expect(action).not.toHaveBeenCalled();

    h.service.markRestorationSkipped();
    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).resolves.toBe('removed');
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
  });

  it('prepares and commits a complete-state session deletion around the resource action', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine', focus: true }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const action = vi.fn(async () => {
      expect(h.store.setTabLayout).not.toHaveBeenCalled();
      h.live.delete('mine');
      return 'removed';
    });

    await expect(h.service.runSessionDeletion([{ id: 'mine', owner: 'alice' }], action)).resolves.toBe('removed');

    expect(h.layouts.alice.ungrouped).toEqual([]);
    expect(h.layouts.alice.version).toBe(8);
  });

  it('leaves stale records, layouts, versions, and events intact when bulk preparation fails', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'stale' }]) },
      persisted: [{ id: 'stale', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const cleanup = vi.fn(() => {
      delete h.persisted.stale;
      return { count: 1, cleaned: [{ id: 'stale', owner: 'alice' }] };
    });
    h.store.getSessions
      .mockImplementationOnce(() => h.persisted)
      .mockImplementationOnce(() => {
        throw new Error('malformed persisted state');
      });

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).rejects.toThrow('malformed persisted state');

    expect(cleanup).not.toHaveBeenCalled();
    expect(h.persisted.stale).toBeDefined();
    expect(h.layouts.alice).toEqual(existing([{ kind: 'session', id: 'stale' }]));
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('bulk-cleans multiple owners once each while preserving pinned stale records', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'alice-stale' },
          { kind: 'session', id: 'alice-pinned' },
        ]),
        bob: existing([{ kind: 'session', id: 'bob-stale' }]),
      },
      persisted: [
        { id: 'bob-stale', owner: 'bob', createdAt: 1 },
        { id: 'alice-stale', owner: 'alice', createdAt: 2 },
        { id: 'alice-pinned', owner: 'alice', createdAt: 3, pinned: true },
      ],
    });
    h.service.markRestorationComplete();
    const cleanup = vi.fn(() => {
      delete h.persisted['alice-stale'];
      delete h.persisted['bob-stale'];
      return { count: 2 };
    });

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).resolves.toEqual({ count: 2 });

    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'alice-pinned' }]);
    expect(h.layouts.bob.ungrouped).toEqual([]);
    expect(h.layouts.alice.version).toBe(8);
    expect(h.layouts.bob.version).toBe(8);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(2);
    expect(h.store.setTabLayout.mock.calls.map(([owner]) => owner)).toEqual(['alice', 'bob']);
    expect(h.broadcast).toHaveBeenCalledTimes(2);
  });

  it('allows skipped-mode stale cleanup without pruning or versioning layouts', async () => {
    const h = createHarness({
      layouts: { '@single': existing([{ kind: 'session', id: 'stale' }]) },
      persisted: [{ id: 'stale', createdAt: 1 }],
    });
    h.service.markRestorationSkipped();
    const cleanup = vi.fn(() => ({ count: 1 }));

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).resolves.toEqual({ count: 1 });

    expect(cleanup).toHaveBeenCalledOnce();
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('repairs missing owner refs once while preserving unknown refs', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'unknown' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
      webviews: [{ id: 'dashboard', owner: 'alice' }],
    });
    const first = await h.service.get('alice');
    expect(first.ungrouped).toEqual([
      { kind: 'session', id: 'unknown' },
      { kind: 'session', id: 'mine' },
      { kind: 'webview', id: 'dashboard' },
    ]);
    expect(first.version).toBe(8);
    await h.service.get('alice');
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 });
  });

  it('isolates owner metadata and filters saved webviews by exact owner', async () => {
    const h = createHarness({
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'bob', createdAt: 2 },
      ],
      webviews: [
        { id: 'wa', owner: 'alice' },
        { id: 'wb', owner: 'bob' },
      ],
    });
    expect((await h.service.get('alice')).ungrouped.map((ref) => ref.id)).toEqual(['a', 'wa']);
    expect((await h.service.get('bob')).ungrouped.map((ref) => ref.id)).toEqual(['b', 'wb']);
  });

  it('rejects foreign and unknown refs atomically even for an admin-owned layout', async () => {
    const h = createHarness({
      layouts: { admin: existing([{ kind: 'session', id: 'mine' }]) },
      live: [
        { id: 'mine', owner: 'admin', createdAt: 1 },
        { id: 'foreign', owner: 'bob', createdAt: 2 },
      ],
    });
    const desired = existing([{ kind: 'session', id: 'foreign' }]);
    await expect(h.service.put('admin', desired, 7)).rejects.toThrow(/not owned/);
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
  });

  it.each([6, 8])('conflicts on every non-exact base version (%s)', async (baseVersion) => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    expect(await h.service.put('alice', existing([{ kind: 'session', id: 'mine' }]), baseVersion)).toEqual({
      status: 'conflict',
      layout: existing([{ kind: 'session', id: 'mine' }]),
    });
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
  });

  it('stores a matching write with one fresh version and minimal event payload', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const result = await h.service.put(
      'alice',
      { ...existing([{ kind: 'session', id: 'mine' }]), groups: [{ id: 'g', name: ' Group ', refs: [] }] },
      7
    );
    expect(result.status).toBe('updated');
    expect(result.layout).toMatchObject({ version: 8, updatedAt: '2026-08-16T12:00:00.000Z' });
    expect(result.layout.groups[0].name).toBe('Group');
    expect(h.broadcast).toHaveBeenLastCalledWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 });
  });

  it('preserves authoritative Focus flags across legacy full-layout writes', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'focused', focus: true },
          { kind: 'session', id: 'plain' },
        ]),
      },
      live: [
        { id: 'focused', owner: 'alice', createdAt: 1 },
        { id: 'plain', owner: 'alice', createdAt: 2 },
      ],
    });

    const result = await h.service.put(
      'alice',
      {
        ...existing([
          { kind: 'session', id: 'plain', focus: true },
          { kind: 'session', id: 'focused' },
        ]),
        groups: [{ id: 'g', name: 'Moved', refs: [] }],
      },
      7
    );

    expect(result.status).toBe('updated');
    expect(result.layout.ungrouped).toEqual([
      { kind: 'session', id: 'plain' },
      { kind: 'session', id: 'focused', focus: true },
    ]);
  });

  it('applies Follow parent intent through the authoritative model instead of accepting a browser-derived layout', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([{ kind: 'session', id: 'child', placement: 'manual' }]),
          groups: [{ id: 'g', name: 'Work', refs: [{ kind: 'session', id: 'parent' }] }],
        },
      },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      ],
    });

    const result = await h.service.putOperations(
      'alice',
      [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }],
      7
    );
    expect(result.status).toBe('updated');
    expect(result.layout.groups[0].refs).toEqual([
      { kind: 'session', id: 'parent' },
      { kind: 'session', id: 'child' },
    ]);
  });

  it('accepts a recovered Follow-parent intent idempotently after it is already inherited', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([]),
          groups: [
            {
              id: 'g',
              name: 'Work',
              refs: [
                { kind: 'session', id: 'parent' },
                { kind: 'session', id: 'child' },
              ],
            },
          ],
        },
      },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      ],
    });

    const result = await h.service.putOperations(
      'alice',
      [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }],
      7
    );

    expect(result.status).toBe('updated');
    expect(result.layout.version).toBe(7);
    expect(result.placements.find((placement) => placement.id === 'child')?.state).toBe('inherited');
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
  });

  it('sets Focus for owned session and webview refs and does not bump an idempotent repeat', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'mine' },
          { kind: 'webview', id: 'dash' },
        ]),
      },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
      webviews: [{ id: 'dash', owner: 'alice' }],
    });

    const sessionFocused = await h.service.putOperations(
      'alice',
      [{ type: 'setFocus', ref: { kind: 'session', id: 'mine' }, focused: true }],
      7
    );
    expect(sessionFocused.layout.ungrouped[0]).toEqual({ kind: 'session', id: 'mine', focus: true });

    const webFocused = await h.service.putOperations(
      'alice',
      [{ type: 'setFocus', ref: { kind: 'webview', id: 'dash' }, focused: true }],
      8
    );
    expect(webFocused.layout.ungrouped[1]).toEqual({ kind: 'webview', id: 'dash', focus: true });

    const unchanged = await h.service.putOperations(
      'alice',
      [{ type: 'setFocus', ref: { kind: 'webview', id: 'dash' }, focused: true }],
      9
    );
    expect(unchanged.layout.version).toBe(9);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(2);
    expect(h.broadcast).toHaveBeenCalledTimes(2);

    await expect(
      h.service.putOperations(
        'alice',
        [{ type: 'setFocus', ref: { kind: 'session', id: 'foreign' }, focused: true }],
        9
      )
    ).rejects.toThrow(/unknown ref/);
  });

  it.each([
    ['beginning', 1],
    ['middle', 2],
    ['end', 3],
  ])('authoritatively recognizes a committed prefix with Follow parent at the %s', async (_position, prefixLength) => {
    const base: TabLayout = {
      ...existing([{ kind: 'session', id: 'child', placement: 'manual' }]),
      groups: [{ id: 'g', name: 'Work', refs: [{ kind: 'session', id: 'parent' }] }],
    };
    const h = createHarness({
      layouts: { alice: base },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      ],
    });
    const ordinary = [
      { type: 'createGroup' as const, id: 'new', name: 'New' },
      { type: 'renameGroup' as const, groupId: 'new', name: 'Renamed' },
    ];
    const follow = { type: 'followParent' as const, ref: { kind: 'session' as const, id: 'child' } };
    const operations =
      prefixLength === 1
        ? [follow, ...ordinary]
        : prefixLength === 2
          ? [ordinary[0], follow, ordinary[1]]
          : [...ordinary, follow];

    const committed = await h.service.putOperations('alice', operations.slice(0, prefixLength), 7);
    expect(committed.status).toBe('updated');
    const recovery = await h.service.putOperations('alice', operations, 7, base);

    expect(recovery.status).toBe('conflict');
    expect(recovery.appliedOperationCount).toBe(prefixLength);
  });

  it.each(['dangling', 'cycle', 'cross-owner'] as const)(
    'returns an unknown-prefix conflict when stale Follow parent is now %s',
    async (scenario) => {
      const base: TabLayout = {
        ...existing([{ kind: 'session', id: 'child', placement: 'manual' }]),
        groups: [{ id: 'g', name: 'Work', refs: [{ kind: 'session', id: 'parent' }] }],
      };
      const live: SessionFact[] =
        scenario === 'cycle'
          ? [
              { id: 'parent', owner: 'alice', createdAt: 1, parentSessionId: 'child' },
              { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
            ]
          : [
              { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
              ...(scenario === 'cross-owner' ? [{ id: 'parent', owner: 'bob', createdAt: 1 }] : []),
            ];
      const current: TabLayout = {
        ...existing([{ kind: 'session', id: 'child', placement: 'manual' }], 8),
      };
      const h = createHarness({ layouts: { alice: current }, live });

      const recovery = await h.service.putOperations(
        'alice',
        [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }],
        7,
        base
      );

      expect(recovery.status).toBe('conflict');
      expect(recovery.layout.version).toBeGreaterThanOrEqual(8);
      expect(recovery.appliedOperationCount).toBeUndefined();
    }
  );

  it.each(['deleted-ref', 'removed-destination', 'cross-owner-ref'] as const)(
    'returns an unknown-prefix conflict for a stale move with a %s',
    async (scenario) => {
      const base: TabLayout = {
        ...existing([{ kind: 'session', id: 'moving' }]),
        groups: [{ id: 'destination', name: 'Destination', refs: [] }],
      };
      const current: TabLayout = {
        ...existing([], 8),
        groups: scenario === 'removed-destination' ? [] : base.groups,
      };
      const live: SessionFact[] =
        scenario === 'cross-owner-ref'
          ? [{ id: 'moving', owner: 'bob', createdAt: 1 }]
          : scenario === 'removed-destination'
            ? [{ id: 'moving', owner: 'alice', createdAt: 1 }]
            : [];
      const h = createHarness({ layouts: { alice: current }, live });

      const recovery = await h.service.putOperations(
        'alice',
        [{ type: 'moveRef', ref: { kind: 'session', id: 'moving' }, groupId: 'destination', index: 0 }],
        7,
        base
      );

      expect(recovery.status).toBe('conflict');
      expect(recovery.appliedOperationCount).toBeUndefined();
    }
  );

  it.each([
    { type: 'unknown' },
    { type: 'followParent', ref: { kind: 'invalid', id: 'child' } },
    { type: 'createGroup', id: 'new', name: '', index: 0 },
    { type: 'reorderGroup', groupId: 'g', index: -1 },
    { type: 'setManualPlacement', ref: { kind: 'session', id: 'child' }, manual: false },
    { type: 'setFocus', ref: { kind: 'session', id: 'child' } },
    { type: 'setFocus', ref: { kind: 'session', id: 'child' }, focused: 'yes' },
  ])('returns conflict for stale malformed $type but rejects it at the matching version', async (operation) => {
    const base: TabLayout = {
      ...existing([{ kind: 'session', id: 'child', placement: 'manual' }]),
      groups: [{ id: 'g', name: 'Work', refs: [] }],
    };
    const h = createHarness({
      layouts: { alice: { ...base, version: 8 } },
      live: [{ id: 'child', owner: 'alice', createdAt: 1 }],
    });

    for (const staleVersion of [7, 9]) {
      const stale = await h.service.putOperations('alice', [operation] as never, staleVersion, base);
      expect(stale.status).toBe('conflict');
      expect(stale.layout.version).toBe(8);
      expect(stale.appliedOperationCount).toBeUndefined();
    }
    await expect(h.service.putOperations('alice', [operation] as never, 8, base)).rejects.toThrow(
      TabLayoutValidationError
    );
  });

  it('repairs missing refs before applying semantic intent and rejects duplicate edits atomically', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'parent' }]) },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      ],
    });
    const moved = await h.service.putOperations(
      'alice',
      [{ type: 'moveRef', ref: { kind: 'session', id: 'child' }, groupId: null, index: 0 }],
      8
    );
    expect(moved.layout.ungrouped[0]).toEqual({ kind: 'session', id: 'child', placement: 'manual' });

    await expect(
      h.service.putOperations(
        'alice',
        [
          { type: 'createGroup', id: 'duplicate', name: 'One' },
          { type: 'createGroup', id: 'duplicate', name: 'Two' },
        ],
        9
      )
    ).rejects.toThrow(/duplicate/);
    expect(h.layouts.alice.groups).toEqual([]);
  });

  it('rejects invalid, dangling, cross-owner, and cyclic Follow-parent intents', async () => {
    const dangling = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'child', placement: 'manual' }]) },
      live: [{ id: 'child', owner: 'alice', createdAt: 1, parentSessionId: 'missing' }],
    });
    await expect(
      dangling.service.putOperations('alice', [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }], 7)
    ).rejects.toThrow(/eligible/);
    await expect(
      dangling.service.putOperations('alice', [{ type: 'followParent', ref: { kind: 'session', id: 'unknown' } }], 7)
    ).rejects.toThrow(/eligible/);
    await expect(dangling.service.putOperations('alice', [{ type: 'followParent' } as never], 7)).rejects.toThrow(
      /invalid ref/
    );

    const foreign = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'child', placement: 'manual' }]) },
      live: [
        { id: 'child', owner: 'alice', createdAt: 1, parentSessionId: 'parent' },
        { id: 'parent', owner: 'bob', createdAt: 2 },
      ],
    });
    await expect(
      foreign.service.putOperations('alice', [{ type: 'followParent', ref: { kind: 'session', id: 'child' } }], 7)
    ).rejects.toThrow(/eligible/);

    const cycle = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a' },
          { kind: 'session', id: 'b' },
        ]),
      },
      live: [
        { id: 'a', owner: 'alice', createdAt: 1, parentSessionId: 'b' },
        { id: 'b', owner: 'alice', createdAt: 2, parentSessionId: 'a' },
      ],
    });
    const normalized = await cycle.service.get('alice');
    await expect(
      cycle.service.putOperations(
        'alice',
        [{ type: 'followParent', ref: { kind: 'session', id: normalized.ungrouped[0].id } }],
        normalized.version
      )
    ).rejects.toThrow(/eligible/);
  });

  it('serializes concurrent writes so only one exact base version can win', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const desired = existing([{ kind: 'session', id: 'mine' }]);
    const results = await Promise.all([h.service.put('alice', desired, 7), h.service.put('alice', desired, 7)]);
    expect(results.map((result) => result.status).sort()).toEqual(['conflict', 'updated']);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    expect(h.layouts.alice.version).toBe(8);
  });

  it('places Session Bridge children in their parent group and extends the nested subtree', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          version: 7,
          updatedAt: '2026-08-15T00:00:00.000Z',
          groups: [{ id: 'work', name: 'Work', refs: [{ kind: 'session', id: 'parent' }] }],
          ungrouped: [{ kind: 'session', id: 'tail' }],
        },
      },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'tail', owner: 'alice', createdAt: 2 },
      ],
    });
    h.live.set('root', { id: 'root', owner: 'alice', createdAt: 3 } as never);
    await h.service.sessionCreated('alice');
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['tail', 'root']);
    h.live.set('child', { id: 'child', owner: 'alice', createdAt: 4, parentSessionId: 'parent' } as never);
    await h.service.sessionCreated('alice');
    h.live.set('grandchild', { id: 'grandchild', owner: 'alice', createdAt: 5, parentSessionId: 'child' } as never);
    await h.service.sessionCreated('alice');
    expect(h.layouts.alice.groups[0].refs.map((ref) => ref.id)).toEqual(['parent', 'child', 'grandchild']);
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['tail', 'root']);
    expect(h.layouts.alice.version).toBe(10);
  });

  it('appends a newly saved owner webview and rejects over-limit writes atomically', async () => {
    const webviews: Array<{ id: string; owner?: string }> = [];
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
      webviews,
    });
    webviews.push({ id: 'dashboard', owner: 'alice' });
    await h.service.webviewCreated('alice');
    expect(h.layouts.alice.ungrouped.at(-1)).toEqual({ kind: 'webview', id: 'dashboard' });

    const tooMany = Array.from({ length: 513 }, (_, index) => ({ kind: 'session' as const, id: `s-${index}` }));
    await expect(h.service.put('alice', existing(tooMany, 8), 8)).rejects.toThrow(/512/);
    expect(h.layouts.alice.version).toBe(8);
  });

  it('materializes children and removes an explicitly deleted parent in one mutation', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'parent' },
          { kind: 'session', id: 'child' },
        ]),
      },
      live: [{ id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' }],
    });
    h.service.markRestorationComplete();
    await h.service.sessionsRemoved([{ id: 'parent', owner: 'alice' }]);
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'child', placement: 'manual' }]);
    expect(h.layouts.alice.version).toBe(8);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);

    h.live.set('parent', { id: 'parent', owner: 'alice', createdAt: 3 } as never);
    await h.service.sessionCreated('alice');
    expect(h.layouts.alice.ungrouped).toEqual([
      { kind: 'session', id: 'child', placement: 'manual' },
      { kind: 'session', id: 'parent' },
    ]);
  });

  it('does not prune or bump when restoration was skipped', async () => {
    const h = createHarness({ layouts: { '@single': existing([{ kind: 'session', id: 'gone' }]) } });
    h.service.markRestorationSkipped();
    await h.service.sessionsRemoved([{ id: 'gone' }]);
    await h.service.webviewDeleted('@single', 'also-gone');
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.layouts['@single'].version).toBe(7);
  });

  it('retains pinned stopped sessions and prunes saved webviews after restoration', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'pinned' },
          { kind: 'webview', id: 'gone-web', focus: true },
        ]),
      },
      persisted: [{ id: 'pinned', owner: 'alice', createdAt: 1, pinned: true }],
    });
    h.service.markRestorationComplete();
    await h.service.webviewDeleted('alice', 'gone-web');
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'pinned' }]);
    expect(h.layouts.alice.version).toBe(8);

    const stale = await h.service.put(
      'alice',
      existing([
        { kind: 'session', id: 'pinned' },
        { kind: 'webview', id: 'gone-web' },
      ]),
      7
    );
    expect(stale).toEqual({ status: 'conflict', layout: h.layouts.alice });
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'pinned' }]);
  });
});
