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
    order?: string[];
    persisted?: SessionFact[];
    live?: SessionFact[];
    webviews?: Array<{ id: string; owner?: string }>;
    readWebviews?: () => Promise<Array<{ id: string; owner?: string }>>;
    caseDefaults?: Record<string, Record<string, string | null>>;
    now?: () => string;
    /** The synced spawnedTabsFollowParent setting (absent = off, the default). */
    follow?: boolean;
  } = {}
) {
  const layouts = { ...(options.layouts ?? {}) };
  const order = [...(options.order ?? [])];
  const persisted = Object.fromEntries((options.persisted ?? []).map((session) => [session.id, session]));
  const live = new Map((options.live ?? []).map((session) => [session.id, session]));
  const caseDefaults = structuredClone(options.caseDefaults ?? {});
  const store = {
    getTabLayout: vi.fn((owner: string) => (Object.hasOwn(layouts, owner) ? layouts[owner] : null)),
    getTabLayouts: vi.fn(() => structuredClone(layouts)),
    setTabLayout: vi.fn((owner: string, value: TabLayout) => {
      layouts[owner] = value;
    }),
    getSessions: vi.fn(() => persisted),
    getSessionOrder: vi.fn(() => [...order]),
    commitTabLayoutProjection: vi.fn(
      (updates: Readonly<Record<string, TabLayout>>, project: (latest: readonly string[]) => readonly string[]) => {
        const projected = [...project([...order])];
        for (const [owner, layout] of Object.entries(updates)) store.setTabLayout(owner, layout);
        order.splice(0, order.length, ...projected);
        return { layouts: structuredClone(updates), sessionOrder: [...order] };
      }
    ),
    getCaseDefaultGroup: vi.fn((owner: string, caseName: string) => caseDefaults[owner]?.[caseName]),
    setCaseDefaultGroup: vi.fn((owner: string, caseName: string, groupId: string | null) => {
      caseDefaults[owner] = { ...(caseDefaults[owner] ?? {}), [caseName]: groupId };
    }),
    deleteCaseDefaultGroup: vi.fn((owner: string, caseName: string) => {
      if (caseDefaults[owner]) delete caseDefaults[owner][caseName];
    }),
  };
  const broadcast = vi.fn();
  const broadcastSessionOrder = vi.fn();
  const service = new TabLayoutService({
    store: store as never,
    sessions: live as never,
    readWebviews: options.readWebviews ?? vi.fn(async () => options.webviews ?? []),
    broadcast,
    broadcastSessionOrder,
    childrenFollowParent: vi.fn(() => options.follow === true),
    // Upstream #676 reads case defaults through this dep, not `store`.
    caseDefaults: store as never,
    now: options.now ?? (() => '2026-08-16T12:00:00.000Z'),
  });
  return { service, store, broadcast, broadcastSessionOrder, layouts, order, live, persisted, caseDefaults };
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

    // Upstream 7a340fe7 made 'failed' fail OPEN for an EXPLICIT user deletion: a
    // failed restore must not lock the user out of closing a tab for the rest of
    // the process lifetime, so it degrades to best-effort deletion without layout
    // coordination. Only the AUTOMATED stale sweep stays fail-closed on 'failed'
    // (runStaleSessionCleanup), because that one picks its own victims.
    h.service.markRestorationFailed();
    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).resolves.toBe('removed');
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    action.mockClear();

    h.service.markRestorationSkipped();
    await expect(h.service.runSessionDeletion([{ id: 'mine' }], action)).resolves.toBe('removed');
    expect(action).toHaveBeenCalledTimes(1);
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
  });

  it('keeps the automated stale sweep fail-closed when restoration failed', async () => {
    const h = createHarness({ layouts: { '@single': existing([{ kind: 'session', id: 'mine' }]) } });
    const sweep = vi.fn(async () => undefined);
    h.service.markRestorationFailed();
    await expect(h.service.runStaleSessionCleanup(new Set(['mine']), sweep)).rejects.toThrow(/restoration.*failed/i);
    expect(sweep).not.toHaveBeenCalled();
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
    expect(h.broadcast).toHaveBeenCalledWith(SseEvent.TabLayoutChanged, {
      owner: 'alice',
      version: 8,
    });
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

  it('stores a matching write with one fresh version and an invalidation event payload', async () => {
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
    expect(h.broadcast).toHaveBeenLastCalledWith(SseEvent.TabLayoutChanged, {
      owner: 'alice',
      version: 8,
    });
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

  it('reorders Focus without moving refs and rejects a move for a ref that is not in Focus', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'a', focus: true },
          { kind: 'session', id: 'b' },
          { kind: 'webview', id: 'dash', focus: true },
        ]),
      },
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'alice', createdAt: 2 },
      ],
      webviews: [{ id: 'dash', owner: 'alice' }],
    });

    const moved = await h.service.putOperations(
      'alice',
      [{ type: 'moveFocus', ref: { kind: 'webview', id: 'dash' }, index: 0 }],
      7
    );
    expect(moved.status).toBe('updated');
    expect(moved.layout.focusOrder).toEqual([
      { kind: 'webview', id: 'dash' },
      { kind: 'session', id: 'a' },
    ]);
    expect(moved.layout.ungrouped.map((ref) => ref.id)).toEqual(['a', 'b', 'dash']);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);

    const legacy = await h.service.put(
      'alice',
      existing(moved.layout.ungrouped, moved.layout.version),
      moved.layout.version
    );
    expect(legacy.layout.focusOrder).toEqual([
      { kind: 'webview', id: 'dash' },
      { kind: 'session', id: 'a' },
    ]);

    await expect(
      h.service.putOperations(
        'alice',
        [{ type: 'moveFocus', ref: { kind: 'session', id: 'b' }, index: 0 }],
        legacy.layout.version
      )
    ).rejects.toThrow(/not in Focus/);
    await expect(
      h.service.putOperations(
        'alice',
        [{ type: 'moveFocus', ref: { kind: 'session', id: 'a' } } as never],
        legacy.layout.version
      )
    ).rejects.toThrow(/moveFocus/);
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
      7
    );
    expect(moved.layout.ungrouped[0]).toEqual({ kind: 'session', id: 'child', placement: 'manual' });

    await expect(
      h.service.putOperations(
        'alice',
        [
          { type: 'createGroup', id: 'duplicate', name: 'One' },
          { type: 'createGroup', id: 'duplicate', name: 'Two' },
        ],
        8
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

  it('keeps get, getSnapshot, put, and putOperations reconciliation behavior stable', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'first' }]) },
      live: [
        { id: 'first', owner: 'alice', createdAt: 1 },
        { id: 'second', owner: 'alice', createdAt: 2 },
      ],
    });

    const reconciled = await h.service.get('alice');
    expect(reconciled).toMatchObject({
      version: 8,
      ungrouped: [
        { kind: 'session', id: 'first' },
        { kind: 'session', id: 'second' },
      ],
    });
    const snapshot = await h.service.getSnapshot('alice');
    expect(snapshot.layout).toEqual(reconciled);
    expect(snapshot.placements).toEqual([]);

    const put = await h.service.put(
      'alice',
      { ...reconciled, groups: [{ id: 'work', name: 'Work', refs: [] }] },
      reconciled.version
    );
    expect(put.status).toBe('updated');
    const operations = await h.service.putOperations(
      'alice',
      [{ type: 'renameGroup', groupId: 'work', name: 'Focused work' }],
      put.layout.version
    );
    expect(operations).toMatchObject({ status: 'updated', layout: { version: 10 } });
    expect(operations.layout.groups[0].name).toBe('Focused work');
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(3);
  });

  it('reconciles and places a created session at the end of an existing group in one mutation', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([{ kind: 'session', id: 'outside' }]),
          groups: [{ id: 'work', name: 'Work', refs: [{ kind: 'session', id: 'inside' }] }],
        },
      },
      live: [
        { id: 'inside', owner: 'alice', createdAt: 1 },
        { id: 'outside', owner: 'alice', createdAt: 2 },
      ],
    });
    h.live.set('new-session', { id: 'new-session', owner: 'alice', createdAt: 3 } as never);

    const result = await h.service.sessionCreated('alice', 'new-session', { tabGroupId: 'work' });
    const { layout } = result;

    expect(layout.groups[0].refs.at(-1)).toEqual({ kind: 'session', id: 'new-session' });
    expect(layout.version).toBe(8);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledWith(SseEvent.TabLayoutChanged, {
      owner: 'alice',
      version: 8,
      layout,
      placements: result.placements,
    });
  });

  it('registers a new live session only after older owner work completes', async () => {
    let releaseFacts!: () => void;
    const blockedFacts = new Promise<void>((resolve) => {
      releaseFacts = resolve;
    });
    let reads = 0;
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([{ kind: 'session', id: 'existing' }]),
          groups: [{ id: 'work', name: 'Work', refs: [] }],
        },
      },
      live: [{ id: 'existing', owner: 'alice', createdAt: 1 }],
      readWebviews: vi.fn(async () => {
        if (reads++ === 0) await blockedFacts;
        return [];
      }),
    });
    const older = h.service.putOperations(
      'alice',
      [{ type: 'renameGroup', groupId: 'work', name: 'Older mutation' }],
      7
    );
    await Promise.resolve();
    const created = { id: 'new-session', owner: 'alice', createdAt: 2 };
    const register = vi.fn(() => {
      h.live.set(created.id, created as never);
      return () => h.live.delete(created.id);
    });
    const creation = h.service.sessionCreated('alice', created.id, { tabGroupId: 'work' }, register);

    expect(register).not.toHaveBeenCalled();
    expect(h.live.has(created.id)).toBe(false);
    releaseFacts();
    const olderResult = await older;
    const creationResult = await creation;

    expect(olderResult.layout.groups[0].refs).toEqual([]);
    expect(register).toHaveBeenCalledOnce();
    expect(creationResult.layout.groups[0].refs).toEqual([{ kind: 'session', id: created.id }]);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(2);
    expect(h.broadcast.mock.calls.at(-1)?.[1]).toMatchObject({
      version: 9,
      layout: creationResult.layout,
      placements: creationResult.placements,
    });
  });

  it('rolls back owner-queued live registration when creation reconciliation fails', async () => {
    const reconciliationError = new Error('saved webviews unavailable');
    const h = createHarness({
      layouts: { alice: existing([]) },
      readWebviews: vi.fn(async () => {
        throw reconciliationError;
      }),
    });
    const created = { id: 'new-session', owner: 'alice', createdAt: 1 };

    await expect(
      h.service.sessionCreated('alice', created.id, { tabGroupId: 'work' }, () => {
        h.live.set(created.id, created as never);
        return () => h.live.delete(created.id);
      })
    ).rejects.toBe(reconciliationError);

    expect(h.live.has(created.id)).toBe(false);
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('commits a missing owner layout once at version zero while targeting a group is unavailable', async () => {
    const h = createHarness({ live: [{ id: 'new-session', owner: 'alice', createdAt: 1 }] });

    const { layout } = await h.service.sessionCreated('alice', 'new-session', { tabGroupId: 'work' });

    expect(layout.version).toBe(0);
    expect(layout.ungrouped).toEqual([{ kind: 'session', id: 'new-session' }]);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it.each(['unknown', 'deleted', 'bob-work'])(
    'falls back to normal reconciled placement for an unavailable %s group hint',
    async (tabGroupId) => {
      const h = createHarness({
        layouts: {
          alice: existing([{ kind: 'session', id: 'existing' }]),
          bob: {
            ...existing([], 4),
            groups: [{ id: 'bob-work', name: 'Bob work', refs: [] }],
          },
        },
        live: [
          { id: 'existing', owner: 'alice', createdAt: 1 },
          { id: 'bob-session', owner: 'bob', createdAt: 1 },
        ],
      });
      h.live.set('new-session', { id: 'new-session', owner: 'alice', createdAt: 2 } as never);

      const { layout } = await h.service.sessionCreated('alice', 'new-session', { tabGroupId });

      expect(layout.groups).toEqual([]);
      expect(layout.ungrouped.at(-1)).toEqual({ kind: 'session', id: 'new-session' });
      expect(layout.version).toBe(8);
      expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    }
  );

  it('places a root session in the configured case default without marking it manual', async () => {
    const h = createHarness({
      layouts: {
        alice: { ...existing([]), groups: [{ id: 'nzbdav', name: 'NzbDav', refs: [] }] },
      },
      live: [{ id: 'created', owner: 'alice', createdAt: 1 }],
      caseDefaults: { alice: { nzbdav: 'nzbdav' } },
    });

    const result = await h.service.sessionCreated('alice', 'created', { caseName: 'nzbdav' });

    expect(result.placementSource).toBe('case-default');
    expect(result.layout.groups[0].refs).toEqual([{ kind: 'session', id: 'created' }]);
    expect(h.store.getCaseDefaultGroup).toHaveBeenCalledWith('alice', 'nzbdav');
    expect(h.store.setCaseDefaultGroup).not.toHaveBeenCalled();
  });

  it('lets an explicit group override the configured case default', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([]),
          groups: [
            { id: 'nzbdav', name: 'NzbDav', refs: [] },
            { id: 'tcc', name: 'TCC', refs: [] },
          ],
        },
      },
      live: [{ id: 'created', owner: 'alice', createdAt: 1 }],
      caseDefaults: { alice: { nzbdav: 'nzbdav' } },
    });

    const result = await h.service.sessionCreated('alice', 'created', {
      caseName: 'nzbdav',
      tabGroupId: 'tcc',
    });

    expect(result.layout.groups.find((group) => group.id === 'nzbdav')?.refs).toEqual([]);
    expect(result.layout.groups.find((group) => group.id === 'tcc')?.refs).toEqual([
      { kind: 'session', id: 'created' },
    ]);
    expect(result.placementSource).toBeUndefined();
    expect(h.store.getCaseDefaultGroup).toHaveBeenCalledWith('alice', 'nzbdav');
  });

  it('forgets a stale case default even when an explicit group determines placement', async () => {
    const h = createHarness({
      layouts: {
        alice: { ...existing([]), groups: [{ id: 'tcc', name: 'TCC', refs: [] }] },
      },
      live: [{ id: 'created', owner: 'alice', createdAt: 1 }],
      caseDefaults: { alice: { nzbdav: 'deleted-group' } },
    });

    const result = await h.service.sessionCreated('alice', 'created', {
      caseName: 'nzbdav',
      tabGroupId: 'tcc',
    });

    expect(result.layout.groups[0].refs).toEqual([{ kind: 'session', id: 'created' }]);
    // Upstream #676: a stale default is forgotten (unset) after the creating write, not set to null.
    expect(h.store.setCaseDefaultGroup).not.toHaveBeenCalled();
    expect(h.store.deleteCaseDefaultGroup).toHaveBeenCalledWith('alice', 'nzbdav');
    expect(h.caseDefaults.alice.nzbdav).toBeUndefined();
  });

  it('keeps an eligible represented parent ahead of the configured case default', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([]),
          groups: [
            { id: 'parent-work', name: 'Parent work', refs: [{ kind: 'session', id: 'parent' }] },
            { id: 'nzbdav', name: 'NzbDav', refs: [] },
          ],
        },
      },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      ],
      caseDefaults: { alice: { nzbdav: 'nzbdav' } },
    });

    const result = await h.service.sessionCreated('alice', 'child', { caseName: 'nzbdav' });

    expect(result.layout.groups.find((group) => group.id === 'parent-work')?.refs.map((ref) => ref.id)).toEqual([
      'parent',
      'child',
    ]);
    expect(result.layout.groups.find((group) => group.id === 'nzbdav')?.refs).toEqual([]);
    expect(result.placementSource).toBeUndefined();
    expect(h.store.getCaseDefaultGroup).toHaveBeenCalledWith('alice', 'nzbdav');
  });

  it('forgets a stale case default even when an eligible represented parent determines placement', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([]),
          groups: [{ id: 'parent-work', name: 'Parent work', refs: [{ kind: 'session', id: 'parent' }] }],
        },
      },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      ],
      caseDefaults: { alice: { nzbdav: 'deleted-group' } },
    });

    const result = await h.service.sessionCreated('alice', 'child', { caseName: 'nzbdav' });

    expect(result.layout.groups[0].refs.map((ref) => ref.id)).toEqual(['parent', 'child']);
    // Upstream #676: a stale default is forgotten (unset) after the creating write, not set to null.
    expect(h.store.setCaseDefaultGroup).not.toHaveBeenCalled();
    expect(h.store.deleteCaseDefaultGroup).toHaveBeenCalledWith('alice', 'nzbdav');
    expect(h.caseDefaults.alice.nzbdav).toBeUndefined();
  });

  it('removes only the created ref manual marker when a case default moves an orphaned child', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([{ kind: 'session', id: 'child', placement: 'manual', focus: true }]),
          groups: [{ id: 'nzbdav', name: 'NzbDav', refs: [] }],
        },
      },
      live: [{ id: 'child', owner: 'alice', createdAt: 1, parentSessionId: 'missing-parent' }],
      caseDefaults: { alice: { nzbdav: 'nzbdav' } },
    });

    const result = await h.service.sessionCreated('alice', 'child', { caseName: 'nzbdav' });

    expect(result.layout.groups[0].refs).toEqual([{ kind: 'session', id: 'child', focus: true }]);
    expect(result.placementSource).toBe('case-default');
  });

  it('keeps an intentional Ungrouped default in Ungrouped', async () => {
    const h = createHarness({
      layouts: {
        alice: { ...existing([]), groups: [{ id: 'nzbdav', name: 'NzbDav', refs: [] }] },
      },
      live: [{ id: 'created', owner: 'alice', createdAt: 1 }],
      caseDefaults: { alice: { nzbdav: null } },
    });

    const result = await h.service.sessionCreated('alice', 'created', { caseName: 'nzbdav' });

    expect(result.layout.ungrouped).toEqual([{ kind: 'session', id: 'created' }]);
    expect(result.placementSource).toBeUndefined();
    expect(h.store.setCaseDefaultGroup).not.toHaveBeenCalled();
  });

  it('forgets a deleted case default (leaving the session Ungrouped) after the creating write', async () => {
    const h = createHarness({
      layouts: { alice: existing([]) },
      live: [{ id: 'created', owner: 'alice', createdAt: 1 }],
      caseDefaults: { alice: { nzbdav: 'deleted-group' } },
    });

    const result = await h.service.sessionCreated('alice', 'created', { caseName: 'nzbdav' });

    expect(result.layout.ungrouped).toEqual([{ kind: 'session', id: 'created' }]);
    expect(result.placementSource).toBeUndefined();
    // Upstream #676: a stale default is forgotten (unset) after the creating write, not set to null.
    expect(h.store.setCaseDefaultGroup).not.toHaveBeenCalled();
    expect(h.store.deleteCaseDefaultGroup).toHaveBeenCalledWith('alice', 'nzbdav');
    expect(h.caseDefaults.alice.nzbdav).toBeUndefined();
  });

  it('prefers an explicit group over inherited parent placement and marks the child manual', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([]),
          groups: [
            { id: 'parent-work', name: 'Parent work', refs: [{ kind: 'session', id: 'parent' }] },
            { id: 'target', name: 'Target', refs: [] },
          ],
        },
      },
      live: [{ id: 'parent', owner: 'alice', createdAt: 1 }],
    });
    h.live.set('child', {
      id: 'child',
      owner: 'alice',
      createdAt: 2,
      parentSessionId: 'parent',
    } as never);

    const result = await h.service.sessionCreated('alice', 'child', { tabGroupId: 'target' });
    const { layout } = result;

    expect(layout.groups.find((group) => group.id === 'parent-work')?.refs).toEqual([
      { kind: 'session', id: 'parent' },
    ]);
    expect(layout.groups.find((group) => group.id === 'target')?.refs.at(-1)).toEqual({
      kind: 'session',
      id: 'child',
      placement: 'manual',
    });
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    expect(result.placements).toContainEqual({
      kind: 'session',
      id: 'child',
      state: 'manual',
      parentId: 'parent',
      canFollow: true,
    });
  });

  it('serializes concurrent targeted creations and appends them in owner-queue order', async () => {
    const h = createHarness({
      layouts: {
        alice: { ...existing([]), groups: [{ id: 'work', name: 'Work', refs: [] }] },
      },
      live: [
        { id: 'first', owner: 'alice', createdAt: 1 },
        { id: 'second', owner: 'alice', createdAt: 2 },
      ],
    });

    const [first, second] = await Promise.all([
      h.service.sessionCreated('alice', 'first', { tabGroupId: 'work' }),
      h.service.sessionCreated('alice', 'second', { tabGroupId: 'work' }),
    ]);

    expect(first.layout.groups[0].refs.map((ref) => ref.id)).toEqual(['first']);
    expect(second.layout.groups[0].refs.map((ref) => ref.id)).toEqual(['first', 'second']);
    expect(second.layout.version).toBe(9);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(2);
  });

  it('falls back to the reconciled candidate when only explicit placement is invalid', async () => {
    const h = createHarness({
      layouts: {
        alice: { ...existing([]), groups: [{ id: 'work', name: 'Work', refs: [] }] },
      },
      live: [{ id: 'actual-new-session', owner: 'alice', createdAt: 1 }],
    });

    const { layout } = await h.service.sessionCreated('alice', 'missing-created-session', { tabGroupId: 'work' });

    expect(layout.groups[0].refs).toEqual([]);
    expect(layout.ungrouped).toEqual([{ kind: 'session', id: 'actual-new-session' }]);
    expect(layout.version).toBe(8);
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
  });

  it('propagates reconciliation failures without writing or broadcasting a layout', async () => {
    const reconciliationError = new Error('saved webviews unavailable');
    const h = createHarness({
      layouts: {
        alice: { ...existing([]), groups: [{ id: 'work', name: 'Work', refs: [] }] },
      },
      live: [{ id: 'new-session', owner: 'alice', createdAt: 1 }],
      readWebviews: vi.fn(async () => {
        throw reconciliationError;
      }),
    });

    await expect(h.service.sessionCreated('alice', 'new-session', { tabGroupId: 'work' })).rejects.toBe(
      reconciliationError
    );
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('appends an already-targeted created session after removing its complete inherited descendant block', async () => {
    const h = createHarness({
      layouts: {
        alice: {
          ...existing([]),
          groups: [
            {
              id: 'work',
              name: 'Work',
              refs: [
                { kind: 'session', id: 'created' },
                { kind: 'session', id: 'child' },
                { kind: 'session', id: 'tail' },
              ],
            },
          ],
        },
      },
      live: [
        { id: 'created', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'created' },
        { id: 'tail', owner: 'alice', createdAt: 3 },
      ],
    });

    const { layout } = await h.service.sessionCreated('alice', 'created', { tabGroupId: 'work' });

    expect(layout.groups[0].refs.map((ref) => ref.id)).toEqual(['tail', 'created', 'child']);
    expect(layout.version).toBe(8);
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
    await h.service.sessionCreated('alice', 'root');
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['tail', 'root']);
    h.live.set('child', { id: 'child', owner: 'alice', createdAt: 4, parentSessionId: 'parent' } as never);
    await h.service.sessionCreated('alice', 'child');
    h.live.set('grandchild', { id: 'grandchild', owner: 'alice', createdAt: 5, parentSessionId: 'child' } as never);
    await h.service.sessionCreated('alice', 'grandchild');
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
    await h.service.sessionCreated('alice', 'parent');
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

describe('TabLayoutService grouped session creation', () => {
  const grouped = (version = 7): TabLayout => ({
    version,
    groups: [
      { id: 'g1', name: 'Core', refs: [{ kind: 'session', id: 'a' }] },
      { id: 'g2', name: 'Ops', refs: [] },
    ],
    ungrouped: [{ kind: 'session', id: 'b' }],
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
  const facts = (owner = 'alice') => [
    { id: 'a', owner, createdAt: 1 },
    { id: 'b', owner, createdAt: 2 },
  ];
  // Upstream's service resolves to the bare layout; this fork's resolves to a
  // snapshot `{ layout, placements }` (COD-320), so read the layout off it.
  const createdLayout = async (
    h: ReturnType<typeof createHarness>,
    ...args: Parameters<ReturnType<typeof createHarness>['service']['sessionCreated']>
  ) => (await h.service.sessionCreated(...args)).layout;
  /** Registers `id` the way server.ts does: inside the owner lock, with a rollback. */
  const register = (h: ReturnType<typeof createHarness>, fact: SessionFact) =>
    vi.fn(() => {
      h.live.set(fact.id, fact as never);
      return () => h.live.delete(fact.id);
    });

  it('places a new session at the end of the requested group in ONE versioned write', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const added = register(h, { id: 'new', owner: 'alice', createdAt: 3 });

    const layout = await createdLayout(h, 'alice', 'new', { tabGroupId: 'g1' }, added);

    expect(added).toHaveBeenCalledOnce();
    expect(layout.version).toBe(8);
    expect(layout.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'new' },
    ]);
    expect(layout.ungrouped).toEqual([{ kind: 'session', id: 'b' }]);
    expect(h.layouts.alice).toEqual(layout);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    // This fork's creation broadcast also carries the layout and placements (COD-320).
    expect(h.broadcast.mock.calls.filter(([event]) => event === SseEvent.TabLayoutChanged)).toEqual([
      [SseEvent.TabLayoutChanged, expect.objectContaining({ owner: 'alice', version: 8 })],
    ]);
  });

  it('registers the session INSIDE the owner lock, so a queued edit cannot commit it first', async () => {
    const readWebviews = vi.fn(async (): Promise<Array<{ id: string; owner?: string }>> => []);
    const h = createHarness({ layouts: { alice: grouped() }, live: facts(), order: ['a', 'b'], readWebviews });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    readWebviews.mockImplementationOnce(async () => {
      await blocked;
      return [];
    });
    const occupied = h.service.get('alice');
    await vi.waitFor(() => expect(readWebviews).toHaveBeenCalledOnce());
    const added = register(h, { id: 'new', owner: 'alice', createdAt: 3 });

    const created = createdLayout(h, 'alice', 'new', { tabGroupId: 'g2' }, added);
    await Promise.resolve();
    expect(added).not.toHaveBeenCalled();
    release();
    await occupied;
    const layout = await created;

    expect(layout.groups[1].refs).toEqual([{ kind: 'session', id: 'new' }]);
    // The queued read committed nothing; the creation is the only write.
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(layout.version).toBe(8);
  });

  it('treats an unknown group as a hint, not an error: the session lands where it normally would', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const layout = await createdLayout(
      h,
      'alice',
      'new',
      { tabGroupId: 'gone' },
      register(h, { id: 'new', owner: 'alice', createdAt: 3 })
    );
    expect(layout.ungrouped.map((ref) => ref.id)).toEqual(['b', 'new']);
    expect(layout.groups.flatMap((group) => group.refs.map((ref) => ref.id))).toEqual(['a']);
  });

  it("never places a session into another owner's group", async () => {
    const h = createHarness({
      layouts: { alice: grouped(), bob: existing([{ kind: 'session', id: 'bob-1' }], 3) },
      live: [...facts(), { id: 'bob-1', owner: 'bob', createdAt: 4 }],
    });
    const layout = await createdLayout(
      h,
      'bob',
      'bob-new',
      { tabGroupId: 'g1' },
      register(h, { id: 'bob-new', owner: 'bob', createdAt: 5 })
    );
    expect(layout.groups).toEqual([]);
    expect(layout.ungrouped.map((ref) => ref.id)).toEqual(['bob-1', 'bob-new']);
    expect(h.layouts.alice).toEqual(grouped());
  });

  it('with the follow setting on, a child follows its parent; an explicit group pins it manual', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts(), follow: true });
    const followed = await createdLayout(
      h,
      'alice',
      'child',
      {},
      register(h, { id: 'child', owner: 'alice', createdAt: 3, parentSessionId: 'a' })
    );
    expect(followed.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'child' },
    ]);

    const pinned = await createdLayout(
      h,
      'alice',
      'child-2',
      { tabGroupId: 'g2' },
      register(h, { id: 'child-2', owner: 'alice', createdAt: 4, parentSessionId: 'a' })
    );
    expect(pinned.groups[1].refs).toEqual([{ kind: 'session', id: 'child-2', placement: 'manual' }]);
    // Move ONLY the parent: the following child goes with it, the hand-placed one stays.
    const moved = await h.service.put(
      'alice',
      {
        ...pinned,
        groups: [{ ...pinned.groups[0], refs: [{ kind: 'session', id: 'child' }] }, pinned.groups[1]],
        ungrouped: [...pinned.ungrouped, { kind: 'session', id: 'a' }],
      },
      pinned.version
    );
    expect(moved.layout.groups[0].refs).toEqual([]);
    expect(moved.layout.groups[1].refs).toEqual([{ kind: 'session', id: 'child-2', placement: 'manual' }]);
    expect(moved.layout.ungrouped).toEqual([
      { kind: 'session', id: 'b' },
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'child' },
    ]);
  });

  it('with the follow setting off (the default), a child lands after its parent once and is hand-placed', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const created = await createdLayout(
      h,
      'alice',
      'child',
      {},
      register(h, { id: 'child', owner: 'alice', createdAt: 3, parentSessionId: 'a' })
    );
    // Same place as a following child, in ONE write, but pinned there.
    expect(created.version).toBe(8);
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(created.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'child', placement: 'manual' },
    ]);
    const moved = await h.service.put(
      'alice',
      {
        ...created,
        groups: [{ ...created.groups[0], refs: [created.groups[0].refs[1]] }, created.groups[1]],
        ungrouped: [...created.ungrouped, { kind: 'session', id: 'a' }],
      },
      created.version
    );
    expect(moved.layout.groups[0].refs).toEqual([{ kind: 'session', id: 'child', placement: 'manual' }]);
    expect(moved.layout.ungrouped.map((ref) => ref.id)).toEqual(['b', 'a']);
  });

  it('with the follow setting off, children spawned one after another keep creation order', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    let layout = grouped();
    for (const [index, id] of ['c1', 'c2', 'c3'].entries()) {
      layout = await createdLayout(
        h,
        'alice',
        id,
        {},
        register(h, { id, owner: 'alice', createdAt: 3 + index, parentSessionId: 'a' })
      );
    }
    expect(layout.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'c1', placement: 'manual' },
      { kind: 'session', id: 'c2', placement: 'manual' },
      { kind: 'session', id: 'c3', placement: 'manual' },
    ]);
  });

  it('reads the follow setting fresh at every creation', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const setting = vi.fn<() => boolean>().mockReturnValueOnce(true).mockReturnValueOnce(false);
    (h.service as unknown as { deps: { childrenFollowParent: typeof setting } }).deps.childrenFollowParent = setting;
    await createdLayout(
      h,
      'alice',
      'c1',
      {},
      register(h, { id: 'c1', owner: 'alice', createdAt: 3, parentSessionId: 'a' })
    );
    const layout = await createdLayout(
      h,
      'alice',
      'c2',
      {},
      register(h, { id: 'c2', owner: 'alice', createdAt: 4, parentSessionId: 'a' })
    );
    expect(setting).toHaveBeenCalledTimes(2);
    expect(layout.groups[0].refs).toEqual([
      { kind: 'session', id: 'a' },
      { kind: 'session', id: 'c1' },
      { kind: 'session', id: 'c2', placement: 'manual' },
    ]);
  });

  it('a session without a parent is never pinned, whatever the setting', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    const layout = await createdLayout(
      h,
      'alice',
      'plain',
      {},
      register(h, { id: 'plain', owner: 'alice', createdAt: 3 })
    );
    expect(layout.ungrouped).toEqual([
      { kind: 'session', id: 'b' },
      { kind: 'session', id: 'plain' },
    ]);
  });

  it('rolls the registration back when the layout write fails', async () => {
    const h = createHarness({ layouts: { alice: grouped() }, live: facts() });
    h.store.commitTabLayoutProjection.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const added = register(h, { id: 'new', owner: 'alice', createdAt: 3 });
    await expect(createdLayout(h, 'alice', 'new', { tabGroupId: 'g1' }, added)).rejects.toThrow('disk full');
    expect(added).toHaveBeenCalledOnce();
    expect(h.live.has('new')).toBe(false);
    expect(h.layouts.alice).toEqual(grouped());
  });
});

describe('TabLayoutService legacy order PUTs keep a following child following', () => {
  const family = (): TabLayout => ({
    version: 4,
    groups: [
      {
        id: 'g1',
        name: 'Core',
        refs: [
          { kind: 'session', id: 'x' },
          { kind: 'session', id: 'p' },
          { kind: 'session', id: 'kid' },
        ],
      },
    ],
    ungrouped: [{ kind: 'session', id: 'y' }],
    updatedAt: '2026-08-15T00:00:00.000Z',
  });
  const live = [
    { id: 'x', owner: 'alice', createdAt: 1 },
    { id: 'p', owner: 'alice', createdAt: 2 },
    { id: 'kid', owner: 'alice', createdAt: 3, parentSessionId: 'p' },
    { id: 'y', owner: 'alice', createdAt: 4 },
  ];

  for (const actor of [
    { owner: 'alice', isAdmin: false },
    { owner: 'admin', isAdmin: true },
  ]) {
    it(`a PUT of the current order leaves placement alone (${actor.isAdmin ? 'admin' : 'owner'})`, async () => {
      const h = createHarness({ layouts: { alice: family() }, live, order: ['x', 'p', 'kid', 'y'] });
      await h.service.putLegacyOrder(actor, ['x', 'p', 'kid', 'y']);
      expect(h.layouts.alice).toEqual(family());
      expect(h.store.commitTabLayoutProjection.mock.calls.every(([updates]) => !Object.hasOwn(updates, 'alice'))).toBe(
        true
      );
    });
  }

  it('a reorder that keeps the child after its parent keeps it following, so it moves with its parent', async () => {
    const h = createHarness({ layouts: { alice: family() }, live, order: ['x', 'p', 'kid', 'y'] });
    await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['p', 'kid', 'x', 'y']);
    expect(h.layouts.alice.groups[0].refs).toEqual([
      { kind: 'session', id: 'p' },
      { kind: 'session', id: 'kid' },
      { kind: 'session', id: 'x' },
    ]);
    // Still following: moving only the parent takes the child along.
    const current = h.layouts.alice;
    const moved = await h.service.put(
      'alice',
      {
        ...current,
        groups: [{ ...current.groups[0], refs: [current.groups[0].refs[1], current.groups[0].refs[2]] }],
        ungrouped: [...current.ungrouped, { kind: 'session', id: 'p' }],
      },
      current.version
    );
    expect(moved.layout.ungrouped.map((ref) => ref.id)).toEqual(['y', 'p', 'kid']);
    expect(moved.layout.groups[0].refs).toEqual([{ kind: 'session', id: 'x' }]);
  });

  it('a reorder that splits the child from its parent pins it', async () => {
    const h = createHarness({ layouts: { alice: family() }, live, order: ['x', 'p', 'kid', 'y'] });
    await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['kid', 'x', 'p', 'y']);
    expect(h.layouts.alice.groups[0].refs).toEqual([
      { kind: 'session', id: 'kid', placement: 'manual' },
      { kind: 'session', id: 'x' },
      { kind: 'session', id: 'p' },
    ]);
  });
});
