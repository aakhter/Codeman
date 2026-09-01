import { describe, expect, it, vi } from 'vitest';

import { snapshotDeadSessionRecoveries } from '../src/session-recovery.js';
import type { SessionState } from '../src/types/session.js';
import type { MuxSession } from '../src/mux-interface.js';
import type { SessionRecoveryRecord } from '../src/types/session-recovery.js';

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
  it('persists a dead managed session from saved state and pre-reconcile mux metadata', () => {
    const state = savedSession('dead-1');
    const upsert = vi.fn();
    const store = {
      getSession: vi.fn((id: string) => (id === state.id ? state : null)),
      getSessionRecoveries: vi.fn(() => [] as SessionRecoveryRecord[]),
      upsertSessionRecovery: upsert,
    };

    snapshotDeadSessionRecoveries(store, ['dead-1'], new Map([['dead-1', muxSession('dead-1')]]));

    expect(upsert).toHaveBeenCalledWith({
      id: 'recovery-dead-1',
      sourceSessionId: 'dead-1',
      owner: 'alice',
      mode: 'codex',
      workingDir: '/work/project',
      transport: 'remote',
      nativeResumeId: 'rollout-123',
      status: 'reattachable',
      launch: { kind: 'built-in' },
      createdAt: 100,
      lastActivityAt: 200,
    });
  });

  it('does not create or overwrite recovery records when all managed mux sessions survive', () => {
    const upsert = vi.fn();
    const store = {
      getSession: vi.fn(),
      getSessionRecoveries: vi.fn(() => [] as SessionRecoveryRecord[]),
      upsertSessionRecovery: upsert,
    };

    snapshotDeadSessionRecoveries(store, [], new Map([['alive-1', muxSession('alive-1')]]));

    expect(store.getSession).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not overwrite a record already marked recovered for the same dead session', () => {
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

    snapshotDeadSessionRecoveries(store, ['dead-1'], new Map([['dead-1', muxSession('dead-1')]]));

    expect(upsert).not.toHaveBeenCalled();
  });
});
