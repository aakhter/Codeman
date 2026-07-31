/**
 * COD-124 — Session.park() unit tests.
 *
 * Verifies the park() behavior contract:
 *  - claude-mode happy path: detaches mux, clears pid, preserves resumeSessionId,
 *    transitions to status 'parked'.
 *  - remote-attached (owned:false) sessions: park() delegates entirely to
 *    mux.killSession() (which itself implements the COD-105 detach-never-kill
 *    guarantee) — park() must not attempt anything beyond that delegation.
 *  - non-claude modes: resumeSessionId is left untouched (best-effort relaunch,
 *    no conversation restore).
 *  - idempotence: calling park() twice only detaches the mux session once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Session } from '../src/session.js';
import type { TerminalMultiplexer } from '../src/mux-interface.js';

function makeFakeMux(overrides: Partial<TerminalMultiplexer> = {}): TerminalMultiplexer {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    backend: 'tmux',
    muxSocket: 'codeman',
    isAvailable: () => true,
    killSession: vi.fn(async () => true),
    ...overrides,
  }) as unknown as TerminalMultiplexer;
}

describe('Session.park()', () => {
  let sessions: Session[] = [];

  afterEach(async () => {
    for (const s of sessions) {
      try {
        await s.stop(false);
      } catch {
        // ignore — some sessions are already parked/stopped in these tests
      }
    }
    sessions = [];
    vi.restoreAllMocks();
  });

  function track(s: Session): Session {
    sessions.push(s);
    return s;
  }

  it('parks a claude-mode session: detaches mux, clears pid, preserves resumeSessionId, status=parked', async () => {
    const fakeMux = makeFakeMux();
    const session = track(
      new Session({
        id: 'park-happy-path',
        workingDir: '/tmp',
        mode: 'claude',
        mux: fakeMux,
        useMux: true,
      })
    );

    // Simulate an already-running session (no real PTY spawn in unit tests).
    const internals = session as unknown as {
      _pid: number | null;
      _status: string;
      _claudeSessionId: string | null;
      _muxSession: unknown;
    };
    internals._pid = 4242;
    internals._status = 'idle';
    internals._claudeSessionId = 'claude-conv-abc123';
    internals._muxSession = { sessionId: session.id, muxName: `codeman-${session.id}`, pid: 4242 };

    await session.park();

    expect(session.status).toBe('parked');
    expect(session.pid).toBeNull();
    expect(fakeMux.killSession).toHaveBeenCalledTimes(1);
    expect(fakeMux.killSession).toHaveBeenCalledWith(session.id);

    const state = session.toState();
    expect(state.status).toBe('parked');
    expect(state.resumeSessionId).toBe('claude-conv-abc123');
    // workingDir / id (the record needed to resume later) must survive untouched.
    expect(state.workingDir).toBe('/tmp');
    expect(state.id).toBe('park-happy-path');
  });

  it('does not populate resumeSessionId for non-claude modes (best-effort relaunch only)', async () => {
    const fakeMux = makeFakeMux();
    const session = track(
      new Session({
        id: 'park-codex-mode',
        workingDir: '/tmp',
        mode: 'codex',
        mux: fakeMux,
        useMux: true,
      })
    );

    const internals = session as unknown as { _pid: number | null; _status: string };
    internals._pid = 555;
    internals._status = 'idle';

    await session.park();

    expect(session.status).toBe('parked');
    const state = session.toState();
    expect(state.resumeSessionId).toBeUndefined();
  });

  it('remote-attached (owned:false) sessions: park() delegates to mux.killSession() without extra kill logic', async () => {
    const fakeMux = makeFakeMux();
    const session = track(
      new Session({
        id: 'park-remote-attached',
        workingDir: '/tmp',
        mode: 'claude',
        mux: fakeMux,
        useMux: true,
        remote: {
          hostId: 'remote-host-1',
          label: 'Remote Host',
          host: 'remote-host',
          username: 'aakhter',
          remotePath: '/home/aakhter/project',
          owned: false,
        },
      })
    );

    const internals = session as unknown as { _pid: number | null; _status: string };
    internals._pid = 777;
    internals._status = 'idle';

    await session.park();

    // park() itself never inspects remote.owned — the detach-never-kill
    // guarantee lives inside TmuxManager.killSession(), which park() must
    // call exactly once and trust completely.
    expect(fakeMux.killSession).toHaveBeenCalledTimes(1);
    expect(fakeMux.killSession).toHaveBeenCalledWith(session.id);
    expect(session.status).toBe('parked');
    expect(session.remote?.owned).toBe(false);
  });

  it('is idempotent: parking an already-parked session is a no-op', async () => {
    const fakeMux = makeFakeMux();
    const session = track(
      new Session({
        id: 'park-idempotent',
        workingDir: '/tmp',
        mode: 'claude',
        mux: fakeMux,
        useMux: true,
      })
    );

    const internals = session as unknown as { _pid: number | null; _status: string };
    internals._pid = 111;
    internals._status = 'idle';

    await session.park();
    expect(fakeMux.killSession).toHaveBeenCalledTimes(1);
    expect(session.status).toBe('parked');

    await session.park();
    // Second call must not re-invoke the mux detach.
    expect(fakeMux.killSession).toHaveBeenCalledTimes(1);
    expect(session.status).toBe('parked');
  });
});
