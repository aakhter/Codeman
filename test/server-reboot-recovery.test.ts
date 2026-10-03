import { describe, expect, it, vi } from 'vitest';

import { snapshotDeadSessionRecoveries } from '../src/session-recovery.js';
import { WebServer } from '../src/web/server.js';
import type { SessionState } from '../src/types/session.js';
import type { MuxSession } from '../src/mux-interface.js';
import type { SessionRecoveryRecord } from '../src/types/session-recovery.js';
import { createMockRouteContext } from './mocks/index.js';
import { rebootRestoreRegistry } from '../src/web/reboot-restore-registry.js';

function savedSession(id: string): SessionState {
  return {
    id,
    pid: 42,
    status: 'running',
    workingDir: '/work/project',
    currentTaskId: null,
    createdAt: 100,
    lastActivityAt: 200,
    mode: 'codex',
    nativeResumeId: 'rollout-123',
  };
}

function muxSession(id: string): MuxSession {
  return {
    sessionId: id,
    muxName: `codeman-${id}`,
    pid: 42,
    createdAt: 99,
    workingDir: '/mux/project',
    mode: 'codex',
    attached: true,
    remote: {
      hostId: 'build-host',
      label: 'build-host',
      host: 'build.example.test',
      username: 'operator',
      remotePath: '/remote/project',
    },
    owner: 'alice',
  };
}

describe('server reboot recovery snapshot', () => {
  it('carries a discovered Codex native ID into the reboot banner before pruning', () => {
    const id = '01a0c810-a5c4-7b32-be0b-1599d9d5995d';
    const saved = {
      ...savedSession('banner-codex'),
      status: 'idle' as const,
      nativeResumeId: undefined,
      workingDir: process.cwd(),
    };
    const server = new WebServer(0, false, true) as unknown as {
      bootRecoveryRecords: SessionRecoveryRecord[];
      store: { getSessions: () => Record<string, SessionState> };
      planRebootRestoreOffer: (dead: string[], live: number) => number;
    };
    server.store = { getSessions: () => ({ 'banner-codex': saved }) };
    server.bootRecoveryRecords = [
      {
        id: 'recovery-banner-codex',
        sourceSessionId: saved.id,
        mode: 'codex',
        workingDir: saved.workingDir,
        transport: 'local',
        nativeResumeId: id,
        status: 'resumable',
        launch: { kind: 'built-in' },
        createdAt: saved.createdAt,
      },
    ];
    try {
      expect(server.planRebootRestoreOffer([saved.id], 0)).toBe(1);
      expect(rebootRestoreRegistry.list(() => true)[0].resumeConversationId).toBe(id);
    } finally {
      rebootRestoreRegistry.reset();
    }
  });

  it('automatically launches a newly-created resumable boot record when the setting is enabled', async () => {
    const ctx = createMockRouteContext();
    const record: SessionRecoveryRecord = {
      id: 'recovery-dead-auto',
      sourceSessionId: 'dead-auto',
      mode: 'codex',
      workingDir: '/tmp/project',
      transport: 'local',
      nativeResumeId: '01a0c810-a5c4-7b32-be0b-1599d9d5995d',
      status: 'resumable',
      launch: { kind: 'built-in' },
      createdAt: 100,
    };
    const upsertSessionRecovery = vi.fn();
    Object.assign(ctx.store, { upsertSessionRecovery });
    Object.assign(ctx.mux, {
      backend: 'tmux',
      muxSessionExists: vi.fn(async () => false),
      isPaneDead: vi.fn(async () => false),
      setAttached: vi.fn(),
    });
    ctx.mux.createSession.mockImplementation(async (options) => ({
      sessionId: options.sessionId,
      muxName: `codeman-${options.sessionId}`,
      pid: 1,
      createdAt: Date.now(),
      workingDir: options.workingDir,
      mode: options.mode,
      attached: false,
    }));

    const server = new WebServer(0, false, true) as unknown as {
      bootRecoveryRecords: SessionRecoveryRecord[];
      readSettings: (fresh?: boolean) => Promise<Record<string, unknown>>;
      createRouteContext: () => typeof ctx;
      autoRecoverBootSessions: () => Promise<void>;
    };
    server.bootRecoveryRecords = [record];
    server.readSettings = vi.fn(async () => ({ autoRecoverSessionsAfterReboot: true }));
    server.createRouteContext = vi.fn(() => ctx);

    await server.autoRecoverBootSessions();

    expect(ctx.mux.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'codex',
        codexConfig: { resumeSessionId: record.nativeResumeId },
      })
    );
    expect(upsertSessionRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ id: record.id, status: 'recovered', recoveredSessionId: expect.any(String) })
    );
    expect(server.bootRecoveryRecords).toEqual([]);
  });

  it('captures a dead session through the server restore path before finalize cleanup removes its saved state', async () => {
    const state = savedSession('dead-server-1');
    const savedStates = new Map([[state.id, state]]);
    const recoveries: SessionRecoveryRecord[] = [];
    const cleanupSessionsByIds = vi.fn((ids: ReadonlySet<string>) => {
      const cleaned = [...ids].flatMap((id) => {
        const saved = savedStates.get(id);
        if (!saved) return [];
        savedStates.delete(id);
        return [{ id, name: saved.name }];
      });
      return { count: cleaned.length, cleaned };
    });
    const store = {
      getSession: vi.fn((id: string) => savedStates.get(id) ?? null),
      getSessionRecoveries: vi.fn(() => recoveries),
      upsertSessionRecovery: vi.fn((recovery: SessionRecoveryRecord) => recoveries.push(recovery)),
      cleanupSessionsByIds,
    };
    const mux = {
      getSessions: vi.fn(() => [muxSession(state.id)]),
      reconcileSessions: vi.fn(async () => ({ alive: [], dead: [state.id], discovered: [] })),
    };
    const server = new WebServer(0, false, true) as unknown as {
      store: typeof store;
      mux: typeof mux;
      tabLayouts: {
        markRestorationComplete: () => void;
        reconcileAfterRestoration: () => Promise<void>;
        runStaleSessionCleanup: (
          activeIds: Set<string>,
          cleanup: (ids: ReadonlySet<string>) => { count: number; cleaned: Array<{ id: string }> }
        ) => Promise<{ count: number; cleaned: Array<{ id: string }> }>;
      };
      restoreMuxSessions: () => Promise<boolean>;
      finalizeRestoredState: (restored: boolean) => Promise<void>;
    };
    server.store = store;
    server.mux = mux;
    server.tabLayouts = {
      markRestorationComplete: vi.fn(),
      reconcileAfterRestoration: vi.fn(async () => {}),
      runStaleSessionCleanup: vi.fn(async (_activeIds, cleanup) => cleanup(new Set([state.id]))),
    };

    expect(await server.restoreMuxSessions()).toBe(true);
    expect(store.upsertSessionRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: state.id, transport: 'remote', status: 'reattachable' })
    );
    expect(cleanupSessionsByIds).not.toHaveBeenCalled();
    expect(store.getSession(state.id)).toEqual(state);

    await server.finalizeRestoredState(true);

    expect(cleanupSessionsByIds).toHaveBeenCalledWith(new Set([state.id]));
    expect(store.getSession(state.id)).toBeNull();
    expect(recoveries).toHaveLength(1);
  });

  it('creates no recovery record through the server restore path when reconciliation reports the mux session alive', async () => {
    const state = savedSession('alive-server-1');
    const upsertSessionRecovery = vi.fn();
    const store = {
      getSession: vi.fn(() => state),
      getSessionRecoveries: vi.fn(() => [] as SessionRecoveryRecord[]),
      upsertSessionRecovery,
    };
    const mux = {
      // The first read is the pre-reconcile metadata snapshot; the second is the
      // post-reconcile restore list. Keeping it empty avoids unrelated PTY attach work.
      getSessions: vi
        .fn()
        .mockReturnValueOnce([muxSession(state.id)])
        .mockReturnValue([]),
      reconcileSessions: vi.fn(async () => ({ alive: [state.id], dead: [], discovered: [] })),
      startStatsCollection: vi.fn(),
    };
    const server = new WebServer(0, false, true) as unknown as {
      store: typeof store;
      mux: typeof mux;
      restoreMuxSessions: () => Promise<boolean>;
    };
    server.store = store;
    server.mux = mux;

    expect(await server.restoreMuxSessions()).toBe(true);
    expect(upsertSessionRecovery).not.toHaveBeenCalled();
    expect(store.getSession).not.toHaveBeenCalled();
  });

  it('persists a dead managed session from saved state and pre-reconcile mux metadata', async () => {
    const state = savedSession('dead-1');
    const upsert = vi.fn();
    const store = {
      getSession: vi.fn((id: string) => (id === state.id ? state : null)),
      getSessionRecoveries: vi.fn(() => [] as SessionRecoveryRecord[]),
      upsertSessionRecovery: upsert,
    };

    await snapshotDeadSessionRecoveries(store, ['dead-1'], new Map([['dead-1', muxSession('dead-1')]]));

    expect(upsert).toHaveBeenCalledWith({
      id: 'recovery-dead-1',
      sourceSessionId: 'dead-1',
      owner: 'alice',
      mode: 'codex',
      workingDir: '/work/project',
      transport: 'remote',
      // The durable locator is deliberately minimal: host lookup belongs to the
      // canonical remote configuration, not the reboot record.
      remote: { hostId: 'build-host' },
      nativeResumeId: 'rollout-123',
      status: 'reattachable',
      launch: { kind: 'built-in' },
      createdAt: 100,
      lastActivityAt: 200,
    });
    expect(upsert.mock.calls[0]?.[0].remote).toStrictEqual({ hostId: 'build-host' });
  });

  it('does not create or overwrite recovery records when all managed mux sessions survive', async () => {
    const upsert = vi.fn();
    const store = {
      getSession: vi.fn(),
      getSessionRecoveries: vi.fn(() => [] as SessionRecoveryRecord[]),
      upsertSessionRecovery: upsert,
    };

    await snapshotDeadSessionRecoveries(store, [], new Map([['alive-1', muxSession('alive-1')]]));

    expect(store.getSession).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not overwrite a record already marked recovered for the same dead session', async () => {
    const state = savedSession('dead-1');
    const upsert = vi.fn();
    const store = {
      getSession: vi.fn(() => state),
      getSessionRecoveries: vi.fn(
        () =>
          [
            {
              id: 'recovery-dead-1',
              sourceSessionId: 'dead-1',
              mode: 'codex',
              workingDir: '/work/project',
              transport: 'local',
              status: 'recovered',
              launch: { kind: 'built-in' as const },
              createdAt: 1,
              recoveredSessionId: 'replacement-1',
            },
          ] satisfies SessionRecoveryRecord[]
      ),
      upsertSessionRecovery: upsert,
    };

    await snapshotDeadSessionRecoveries(store, ['dead-1'], new Map([['dead-1', muxSession('dead-1')]]));

    expect(upsert).not.toHaveBeenCalled();
  });

  it('discovers and persists a native id for an active session before stale cleanup', async () => {
    const state = { ...savedSession('dead-native'), nativeResumeId: null };
    const upsert = vi.fn();
    const store = {
      getSession: vi.fn(() => state),
      getSessionRecoveries: vi.fn(() => [] as SessionRecoveryRecord[]),
      upsertSessionRecovery: upsert,
    };
    const resolveNativeResumeId = vi.fn(async () => '01a0c810-a5c4-7b32-be0b-1599d9d5995d');

    const created = await snapshotDeadSessionRecoveries(
      store,
      [state.id],
      new Map([[state.id, { ...muxSession(state.id), remote: undefined }]]),
      { resolveNativeResumeId }
    );

    expect(resolveNativeResumeId).toHaveBeenCalledWith(expect.objectContaining({ id: state.id }));
    expect(created).toEqual([
      expect.objectContaining({
        sourceSessionId: state.id,
        nativeResumeId: '01a0c810-a5c4-7b32-be0b-1599d9d5995d',
        status: 'resumable',
      }),
    ]);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ status: 'resumable' }));
  });
});
