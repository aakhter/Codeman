/**
 * @fileoverview Tab-layout server coordinator lifecycle, ownership, and version tests.
 */
import { describe, expect, it, vi } from 'vitest';
import { TabLayoutService } from '../src/tab-layout-service.js';
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
  const readWebviews = vi.fn(async () => options.webviews ?? []);
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
    readWebviews,
    broadcast,
    now: () => '2026-08-16T12:00:00.000Z',
  });
  return { service, store, broadcast, layouts, live, persisted, readWebviews };
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
      layouts: { alice: existing([{ kind: 'session', id: 'mine' }]) },
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

  it('does not commit a prepared stale layout when asynchronous cleanup rejects', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'alice-stale' }]) },
      persisted: [{ id: 'alice-stale', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    const cleanup = vi.fn(async () => {
      throw new Error('state removal failed');
    });

    await expect(h.service.runStaleSessionCleanup(new Set(), cleanup)).rejects.toThrow('state removal failed');

    expect(h.layouts.alice).toEqual(existing([{ kind: 'session', id: 'alice-stale' }]));
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('binds stale cleanup to revalidated original candidates after an owner queue wait', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([{ kind: 'session', id: 'alice-stale' }]),
        bob: existing([{ kind: 'session', id: 'bob-new-stale' }]),
      },
      persisted: [{ id: 'alice-stale', owner: 'alice', createdAt: 1 }],
    });
    h.service.markRestorationComplete();
    let releaseFacts!: () => void;
    const factsBlocked = new Promise<void>((resolve) => {
      releaseFacts = resolve;
    });
    h.readWebviews.mockImplementationOnce(async () => {
      await factsBlocked;
      return [];
    });

    const occupiedOwnerQueue = h.service.get('alice');
    await vi.waitFor(() => expect(h.readWebviews).toHaveBeenCalledOnce());
    const cleanup = vi.fn((ids: ReadonlySet<string>) => ({ ids: [...ids] }));
    const pending = h.service.runStaleSessionCleanup(new Set(), cleanup);

    h.persisted['alice-stale'].pinned = true;
    h.persisted['bob-new-stale'] = { id: 'bob-new-stale', owner: 'bob', createdAt: 2 };
    releaseFacts();

    await occupiedOwnerQueue;
    await expect(pending).resolves.toEqual({ ids: [] });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(new Set());
    expect(h.persisted['alice-stale']).toBeDefined();
    expect(h.persisted['bob-new-stale']).toBeDefined();
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'alice-stale' }]);
    expect(h.layouts.bob.ungrouped).toEqual([{ kind: 'session', id: 'bob-new-stale' }]);
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
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
    });
    const first = await h.service.get('alice');
    expect(first.ungrouped).toEqual([
      { kind: 'session', id: 'unknown' },
      { kind: 'session', id: 'mine' },
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

  it('returns an unpersisted prepared layout for a stale first write without broadcasting', async () => {
    const h = createHarness({
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });

    await expect(h.service.put('alice', existing([{ kind: 'session', id: 'mine' }]), 7)).resolves.toEqual({
      status: 'conflict',
      layout: {
        version: 0,
        groups: [],
        ungrouped: [{ kind: 'session', id: 'mine' }],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
    expect(h.layouts.alice).toBeUndefined();
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('returns a normalized prepared layout for a stale write without persisting the reconciliation', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'unknown' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });

    await expect(h.service.put('alice', existing([{ kind: 'session', id: 'mine' }]), 6)).resolves.toEqual({
      status: 'conflict',
      layout: existing([
        { kind: 'session', id: 'unknown' },
        { kind: 'session', id: 'mine' },
      ]),
    });
    expect(h.layouts.alice).toEqual(existing([{ kind: 'session', id: 'unknown' }]));
    expect(h.store.setTabLayout).not.toHaveBeenCalled();
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('folds first-write initialization and the requested update into one commit', async () => {
    const h = createHarness({
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const desired = {
      ...existing([]),
      groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
    };

    const result = await h.service.put('alice', desired, 0);

    expect(result).toEqual({
      status: 'updated',
      layout: {
        version: 1,
        groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
        ungrouped: [],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    expect(h.store.setTabLayout).toHaveBeenCalledWith('alice', result.layout);
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 1 });
  });

  it('uses the prepared authoritative ordering for a matching folded first write with tied session timestamps', async () => {
    const h = createHarness({
      live: [
        { id: 'a', owner: 'alice', createdAt: 1 },
        { id: 'B', owner: 'alice', createdAt: 1 },
      ],
    });

    const result = await h.service.put('alice', existing([]), 0);

    expect(result).toEqual({
      status: 'updated',
      layout: {
        version: 1,
        groups: [],
        ungrouped: [
          { kind: 'session', id: 'B' },
          { kind: 'session', id: 'a' },
        ],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
  });

  it('folds normalization and a matching requested update into one commit', async () => {
    const h = createHarness({
      layouts: { alice: existing([{ kind: 'session', id: 'unknown' }]) },
      live: [{ id: 'mine', owner: 'alice', createdAt: 1 }],
    });
    const desired = {
      ...existing([]),
      groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
    };

    const result = await h.service.put('alice', desired, 7);

    expect(result).toEqual({
      status: 'updated',
      layout: {
        version: 8,
        groups: [{ id: 'g', name: 'Mine', refs: [{ kind: 'session', id: 'mine' }] }],
        ungrouped: [],
        updatedAt: '2026-08-16T12:00:00.000Z',
      },
    });
    expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
    expect(h.store.setTabLayout).toHaveBeenCalledWith('alice', result.layout);
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(SseEvent.TabLayoutChanged, { owner: 'alice', version: 8 });
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

  it('places a root at the end and a child after its parent subtree', async () => {
    const h = createHarness({
      layouts: {
        alice: existing([
          { kind: 'session', id: 'parent' },
          { kind: 'session', id: 'tail' },
        ]),
      },
      live: [
        { id: 'parent', owner: 'alice', createdAt: 1 },
        { id: 'tail', owner: 'alice', createdAt: 2 },
      ],
    });
    h.live.set('root', { id: 'root', owner: 'alice', createdAt: 3 } as never);
    await h.service.sessionCreated('alice');
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['parent', 'tail', 'root']);
    h.live.set('child', { id: 'child', owner: 'alice', createdAt: 4, parentSessionId: 'parent' } as never);
    await h.service.sessionCreated('alice');
    expect(h.layouts.alice.ungrouped.map((ref) => ref.id)).toEqual(['parent', 'child', 'tail', 'root']);
    expect(h.layouts.alice.version).toBe(9);
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
          { kind: 'webview', id: 'gone-web' },
        ]),
      },
      persisted: [{ id: 'pinned', owner: 'alice', createdAt: 1, pinned: true }],
    });
    h.service.markRestorationComplete();
    await h.service.webviewDeleted('alice', 'gone-web');
    expect(h.layouts.alice.ungrouped).toEqual([{ kind: 'session', id: 'pinned' }]);
    expect(h.layouts.alice.version).toBe(8);
  });
});
