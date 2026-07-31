/**
 * COD-124 unit 2, Gap B — native external-CLI resume-id threading.
 *
 * Verifies the Session-side half of the contract (the route-side capture-at-
 * park half is covered by test/routes/session-park-native-resume.test.ts):
 *  - nativeResumeId getter/setter round-trip.
 *  - toState() persists nativeResumeId (survives reboot).
 *  - startInteractive() merges a captured nativeResumeId into
 *    codexConfig.resumeSessionId for codex-mode sessions (so `codex resume
 *    <id>` — see buildCodexCommand() in tmux-manager.ts — restores the
 *    original conversation), without clobbering an explicit caller-supplied
 *    resumeSessionId.
 *  - non-codex modes (gemini/opencode/claude) never get a resume mechanism
 *    invented for them — nativeResumeId is inert there.
 *
 * startInteractive() itself spawns a real PTY/tmux pane in production, which
 * unit tests can't do — so these tests invoke the private merge step
 * directly via a cast, mirroring the existing internals-cast pattern used by
 * test/session-park.test.ts (e.g. `internals._pid = ...`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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

type SessionInternals = { _applyNativeResumeIdForResume: () => void };

describe('Session nativeResumeId (COD-124 Gap B)', () => {
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

  it('getter/setter round-trip and default to null', () => {
    const session = track(
      new Session({ id: 'native-resume-basic', workingDir: '/tmp', mode: 'codex', mux: makeFakeMux(), useMux: true })
    );

    expect(session.nativeResumeId).toBeNull();
    session.setNativeResumeId('11111111-2222-3333-4444-555555555555');
    expect(session.nativeResumeId).toBe('11111111-2222-3333-4444-555555555555');
  });

  it('constructor accepts an initial nativeResumeId', () => {
    const session = track(
      new Session({
        id: 'native-resume-ctor',
        workingDir: '/tmp',
        mode: 'codex',
        mux: makeFakeMux(),
        useMux: true,
        nativeResumeId: 'ctor-supplied-id',
      })
    );

    expect(session.nativeResumeId).toBe('ctor-supplied-id');
  });

  it('toState() persists nativeResumeId', () => {
    const session = track(
      new Session({ id: 'native-resume-tostate', workingDir: '/tmp', mode: 'codex', mux: makeFakeMux(), useMux: true })
    );
    session.setNativeResumeId('persist-me-id');

    const state = session.toState();
    expect(state.nativeResumeId).toBe('persist-me-id');
  });

  it('toState() reports null when nothing was captured', () => {
    const session = track(
      new Session({
        id: 'native-resume-tostate-null',
        workingDir: '/tmp',
        mode: 'codex',
        mux: makeFakeMux(),
        useMux: true,
      })
    );

    expect(session.toState().nativeResumeId).toBeNull();
  });

  it('merges nativeResumeId into codexConfig.resumeSessionId on resume (codex mode)', () => {
    const session = track(
      new Session({ id: 'native-resume-merge', workingDir: '/tmp', mode: 'codex', mux: makeFakeMux(), useMux: true })
    );
    session.setNativeResumeId('rollout-uuid-abc');
    expect(session.codexConfig?.resumeSessionId).toBeUndefined();

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.codexConfig?.resumeSessionId).toBe('rollout-uuid-abc');
  });

  it('does not clobber an explicit caller-supplied resumeSessionId', () => {
    const session = track(
      new Session({
        id: 'native-resume-explicit-wins',
        workingDir: '/tmp',
        mode: 'codex',
        mux: makeFakeMux(),
        useMux: true,
        codexConfig: { resumeSessionId: 'explicit-target-id' },
      })
    );
    session.setNativeResumeId('captured-at-park-id');

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.codexConfig?.resumeSessionId).toBe('explicit-target-id');
  });

  it('is a no-op when no nativeResumeId was captured', () => {
    const session = track(
      new Session({ id: 'native-resume-noop', workingDir: '/tmp', mode: 'codex', mux: makeFakeMux(), useMux: true })
    );

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.codexConfig?.resumeSessionId).toBeUndefined();
  });

  it.each(['claude', 'gemini', 'opencode', 'shell'] as const)(
    'does not invent a resume mechanism for non-codex mode %s',
    (mode) => {
      const session = track(
        new Session({
          id: `native-resume-non-codex-${mode}`,
          workingDir: '/tmp',
          mode,
          mux: makeFakeMux(),
          useMux: true,
        })
      );
      session.setNativeResumeId('some-captured-id');

      (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

      // codexConfig must stay untouched (undefined) for non-codex modes —
      // there's no resume-by-id flow wired for them to feed.
      expect(session.codexConfig).toBeUndefined();
    }
  );
});
