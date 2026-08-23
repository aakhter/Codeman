/** @fileoverview COD-359 compatibility and publication invariants for the richer local tab-layout service. */

import { describe, expect, it, vi } from 'vitest';
import { TabLayoutService } from '../src/tab-layout-service.js';
import type { TabLayout } from '../src/tab-layout.js';

type SessionFact = { id: string; owner?: string; createdAt: number; parentSessionId?: string; pinned?: boolean };

function createHarness(
  options: {
    layouts?: Record<string, TabLayout>;
    order?: string[];
    persisted?: SessionFact[];
    live?: SessionFact[];
    webviews?: Array<{ id: string; owner?: string }>;
  } = {}
) {
  const layouts: Record<string, TabLayout> = Object.assign(Object.create(null), options.layouts ?? {});
  const persisted = Object.fromEntries((options.persisted ?? []).map((session) => [session.id, session]));
  const live = new Map((options.live ?? []).map((session) => [session.id, session]));
  const order = [...(options.order ?? [])];
  const readWebviews = vi.fn(async () => options.webviews ?? []);
  const setTabLayout = vi.fn((owner: string, value: TabLayout) => {
    layouts[owner] = structuredClone(value);
  });
  const store = {
    getTabLayout: vi.fn((owner: string) => (Object.hasOwn(layouts, owner) ? structuredClone(layouts[owner]) : null)),
    getTabLayouts: vi.fn(() => structuredClone(layouts)),
    setTabLayout,
    getSessions: vi.fn(() => persisted),
    getSessionOrder: vi.fn(() => [...order]),
    getCaseDefaultGroup: vi.fn(() => undefined),
    setCaseDefaultGroup: vi.fn(),
    commitTabLayoutProjection: vi.fn(
      (updates: Readonly<Record<string, TabLayout>>, project: (latest: readonly string[]) => readonly string[]) => {
        const projected = [...project([...order])];
        for (const [owner, layout] of Object.entries(updates)) setTabLayout(owner, layout);
        order.splice(0, order.length, ...projected);
        return { layouts: structuredClone(updates), sessionOrder: [...order] };
      }
    ),
  };
  const broadcast = vi.fn();
  const broadcastSessionOrder = vi.fn();
  const service = new TabLayoutService({
    store: store as never,
    sessions: live as never,
    readWebviews,
    broadcast,
    broadcastSessionOrder,
    now: () => '2026-08-23T12:00:00.000Z',
  } as never);
  return { service, store, broadcast, broadcastSessionOrder, layouts, order, live, persisted, readWebviews };
}

const layout = (ids: readonly string[], version = 7): TabLayout => ({
  version,
  groups: [],
  ungrouped: ids.map((id) => ({ kind: 'session', id })),
  updatedAt: '2026-08-22T00:00:00.000Z',
});

describe('TabLayoutService COD-359 compatibility', () => {
  it('rejects stale direct and semantic first writes without reconciliation side effects', async () => {
    const direct = createHarness({ live: [{ id: 'a', owner: 'alice', createdAt: 1 }] });
    await expect(direct.service.put('alice', layout(['a'], 0), 99)).resolves.toMatchObject({ status: 'conflict' });
    expect(direct.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(direct.store.setTabLayout).not.toHaveBeenCalled();
    expect(direct.broadcast).not.toHaveBeenCalled();

    const semantic = createHarness({ live: [{ id: 'a', owner: 'alice', createdAt: 1 }] });
    await expect(
      semantic.service.putOperations('alice', [{ type: 'createGroup', id: 'g', name: 'Group' }], 99)
    ).resolves.toMatchObject({ status: 'conflict' });
    expect(semantic.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(semantic.store.setTabLayout).not.toHaveBeenCalled();
    expect(semantic.broadcast).not.toHaveBeenCalled();
  });

  it('folds a matching first direct write into one version and one atomic publication', async () => {
    const h = createHarness({ order: ['a'], live: [{ id: 'a', owner: 'alice', createdAt: 1 }] });

    const result = await h.service.put('alice', layout(['a'], 0), 0);

    expect(result).toMatchObject({ status: 'updated', layout: { version: 1 } });
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it('publishes an order-only repair when registration makes a pre-existing layout ref authoritative', async () => {
    const h = createHarness({ layouts: { alice: layout(['reserved']) }, order: [] });

    const result = await h.service.sessionCreated('alice', 'reserved', {}, () => {
      h.live.set('reserved', { id: 'reserved', owner: 'alice', createdAt: 1 });
    });

    expect(result.layout.version).toBe(7);
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.store.commitTabLayoutProjection).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(['reserved']);
    expect(h.broadcastSessionOrder).toHaveBeenCalledWith({
      changedOwnerOrders: { alice: ['reserved'] },
      globalOrder: ['reserved'],
      globalChanged: true,
    });
  });

  it('bridges legacy ranking while preserving groups, webviews, Focus, and manual child placement', async () => {
    const current: TabLayout = {
      ...layout([], 7),
      groups: [
        {
          id: 'g',
          name: 'Group',
          refs: [
            { kind: 'session', id: 'parent' },
            { kind: 'webview', id: 'dash', focus: true },
            { kind: 'session', id: 'child', focus: true },
          ],
        },
      ],
    };
    const h = createHarness({
      layouts: { alice: current },
      order: ['parent', 'child'],
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'child', owner: 'alice', createdAt: 2, parentSessionId: 'parent' },
      ],
      webviews: [{ id: 'dash', owner: 'alice' }],
    });

    const result = await h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['child', 'parent']);

    expect(result.order).toEqual(['child', 'parent']);
    expect(h.layouts.alice.groups[0].refs).toContainEqual({
      kind: 'session',
      id: 'child',
      focus: true,
      placement: 'manual',
    });
    expect(h.layouts.alice.groups[0].refs).toContainEqual({ kind: 'webview', id: 'dash', focus: true });
    expect(h.layouts.alice.groups[0].refs).toContainEqual({ kind: 'session', id: 'parent' });
    expect((await h.service.get('alice')).groups[0].refs).toEqual(h.layouts.alice.groups[0].refs);
  });

  it('rejects foreign, unknown, and prototype-inherited regular legacy ids without publication', async () => {
    const h = createHarness({
      layouts: { alice: layout(['a']) },
      order: ['a', 'b'],
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'b', owner: 'bob', createdAt: 2 },
      ],
    });

    for (const id of ['b', 'unknown', 'constructor']) {
      await expect(h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, [id, 'a'])).rejects.toThrow(
        /not owned/
      );
    }
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
  });

  it('uses latest committed state for overlapping owner projections without losing either update', async () => {
    const h = createHarness({
      layouts: { alice: layout(['a1', 'a2']), bob: layout(['b1', 'b2']) },
      order: ['a1', 'b1', 'a2', 'b2'],
      live: [
        { id: 'a1', owner: 'alice', createdAt: 1 },
        { id: 'b1', owner: 'bob', createdAt: 2 },
        { id: 'a2', owner: 'alice', createdAt: 3 },
        { id: 'b2', owner: 'bob', createdAt: 4 },
      ],
    });

    await Promise.all([
      h.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['a2', 'a1']),
      h.service.putLegacyOrder({ owner: 'bob', isAdmin: false }, ['b2', 'b1']),
    ]);

    expect(h.order).toEqual(['a2', 'b2', 'a1', 'b1']);
  });

  it('admin publishes owner ranks atomically and broadcasts global-only interleaving changes', async () => {
    const h = createHarness({
      layouts: { alice: layout(['a1', 'a2']), bob: layout(['b1', 'b2']) },
      order: ['a1', 'b1', 'a2', 'b2'],
      live: [
        { id: 'a1', owner: 'alice', createdAt: 1 },
        { id: 'b1', owner: 'bob', createdAt: 2 },
        { id: 'a2', owner: 'alice', createdAt: 3 },
        { id: 'b2', owner: 'bob', createdAt: 4 },
      ],
    });

    const changed = await h.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['a2', 'b2', 'a1', 'b1']);
    expect(changed.changedOwnerOrders).toEqual({ alice: ['a2', 'a1'], bob: ['b2', 'b1'] });
    expect(Object.keys(h.store.commitTabLayoutProjection.mock.calls[0][0])).toEqual(['alice', 'bob']);

    h.broadcastSessionOrder.mockClear();
    const globalOnly = await h.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['b2', 'a2', 'b1', 'a1']);
    expect(globalOnly.changedOwnerOrders).toEqual({});
    expect(globalOnly.globalChanged).toBe(true);
    expect(h.broadcastSessionOrder).toHaveBeenCalledExactlyOnceWith({
      changedOwnerOrders: {},
      globalOrder: globalOnly.globalOrder,
      globalChanged: true,
    });
  });

  it('publishes deletion only after the destructive action succeeds', async () => {
    const h = createHarness({
      layouts: { alice: layout(['gone']) },
      order: ['gone'],
      live: [{ id: 'gone', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();

    await expect(
      h.service.runSessionDeletion([{ id: 'gone', owner: 'alice' }], async () => {
        expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
        throw new Error('delete failed');
      })
    ).rejects.toThrow('delete failed');
    expect(h.store.commitTabLayoutProjection).not.toHaveBeenCalled();
    expect(h.order).toEqual(['gone']);
  });

  it('revalidates stale candidates and passes only confirmed ids to the destructive action', async () => {
    const h = createHarness({
      layouts: { alice: layout(['stale', 'became-live']) },
      order: ['stale', 'became-live'],
      persisted: [
        { id: 'stale', owner: 'alice', createdAt: 1 },
        { id: 'became-live', owner: 'alice', createdAt: 2 },
      ],
    });
    h.service.markRestorationComplete();
    const action = vi.fn((ids: ReadonlySet<string>) => [...ids]);
    h.store.getSessions.mockImplementationOnce(() => {
      h.live.set('became-live', { id: 'became-live', owner: 'alice', createdAt: 2 } as never);
      return h.persisted;
    });

    await expect(h.service.runStaleSessionCleanup(new Set(), action)).resolves.toEqual(['stale']);
    expect(action).toHaveBeenCalledWith(new Set(['stale']));
  });
});
