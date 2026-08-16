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
  return { service, store, broadcast, layouts, live };
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
