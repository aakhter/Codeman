/**
 * COD-124 unit 2, Gap B — native external-CLI resume-id threading.
 *
 * Verifies the Session-side half of the contract (the route-side capture-at-
 * park half is covered by test/routes/session-park-native-resume.test.ts):
 *  - nativeResumeId getter/setter round-trip.
 *  - toState() persists nativeResumeId (survives reboot).
 *  - startInteractive() merges a captured nativeResumeId into the
 *    mode-specific config (codexConfig.resumeSessionId /
 *    openCodeConfig.continueSession / geminiConfig.resumeSession /
 *    antigravityConfig.resumeConversationId — see the matching CLI builders in
 *    tmux-manager.ts) so a relaunch resumes the original conversation,
 *    without clobbering an explicit caller-supplied id (COD-251 extends this
 *    from codex-only to opencode/gemini/agy).
 *  - claude/shell never get a resume mechanism invented for them —
 *    nativeResumeId is inert there.
 *
 * startInteractive() itself spawns a real PTY/tmux pane in production, which
 * unit tests can't do — so these tests invoke the private merge step
 * directly via a cast, mirroring the existing internals-cast pattern used by
 * test/session-park.test.ts (e.g. `internals._pid = ...`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Session } from '../src/session.js';
import { legacyResumeSlot } from '../src/session-cli-registry-bridge.js';
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

  it('merges nativeResumeId into openCodeConfig.continueSession on resume (opencode mode)', () => {
    const session = track(
      new Session({
        id: 'native-resume-merge-opencode',
        workingDir: '/tmp',
        mode: 'opencode',
        mux: makeFakeMux(),
        useMux: true,
      })
    );
    session.setNativeResumeId('ses_captured123');
    expect(session.openCodeConfig?.continueSession).toBeUndefined();

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.openCodeConfig?.continueSession).toBe('ses_captured123');
  });

  it('does not clobber an explicit caller-supplied continueSession (opencode mode)', () => {
    const session = track(
      new Session({
        id: 'native-resume-explicit-wins-opencode',
        workingDir: '/tmp',
        mode: 'opencode',
        mux: makeFakeMux(),
        useMux: true,
        openCodeConfig: { continueSession: 'explicit-target-id' },
      })
    );
    session.setNativeResumeId('captured-at-park-id');

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.openCodeConfig?.continueSession).toBe('explicit-target-id');
  });

  it('merges nativeResumeId into geminiConfig.resumeSession on resume (gemini mode)', () => {
    const session = track(
      new Session({
        id: 'native-resume-merge-gemini',
        workingDir: '/tmp',
        mode: 'gemini',
        mux: makeFakeMux(),
        useMux: true,
      })
    );
    session.setNativeResumeId('gemini-session-uuid');
    expect(session.geminiConfig?.resumeSession).toBeUndefined();

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.geminiConfig?.resumeSession).toBe('gemini-session-uuid');
  });

  it('does not clobber an explicit caller-supplied resumeSession (gemini mode)', () => {
    const session = track(
      new Session({
        id: 'native-resume-explicit-wins-gemini',
        workingDir: '/tmp',
        mode: 'gemini',
        mux: makeFakeMux(),
        useMux: true,
        geminiConfig: { resumeSession: 'explicit-target-id' },
      })
    );
    session.setNativeResumeId('captured-at-park-id');

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.geminiConfig?.resumeSession).toBe('explicit-target-id');
  });

  it('merges nativeResumeId into antigravityConfig.resumeConversationId on resume (antigravity mode)', () => {
    const session = track(
      new Session({
        id: 'native-resume-merge-antigravity',
        workingDir: '/tmp',
        mode: 'antigravity',
        mux: makeFakeMux(),
        useMux: true,
      })
    );
    session.setNativeResumeId('agy-conversation-id');
    expect(session.antigravityConfig?.resumeConversationId).toBeUndefined();

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.antigravityConfig?.resumeConversationId).toBe('agy-conversation-id');
  });

  it('does not clobber an explicit caller-supplied resumeSession (antigravity mode)', () => {
    const session = track(
      new Session({
        id: 'native-resume-explicit-wins-antigravity',
        workingDir: '/tmp',
        mode: 'antigravity',
        mux: makeFakeMux(),
        useMux: true,
        antigravityConfig: { resumeConversationId: 'explicit-target-id' },
      })
    );
    session.setNativeResumeId('captured-at-park-id');

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    expect(session.antigravityConfig?.resumeConversationId).toBe('explicit-target-id');
  });

  it.each(['claude', 'shell'] as const)('does not invent a resume mechanism for mode %s', (mode) => {
    const session = track(
      new Session({
        id: `native-resume-non-external-${mode}`,
        workingDir: '/tmp',
        mode,
        mux: makeFakeMux(),
        useMux: true,
      })
    );
    session.setNativeResumeId('some-captured-id');

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    // No CLI-specific config gets invented for modes with no resume-by-id
    // mechanism wired — claude/shell have none.
    expect(session.codexConfig).toBeUndefined();
    expect(session.openCodeConfig).toBeUndefined();
    expect(session.geminiConfig).toBeUndefined();
    expect(session.agyConfig).toBeUndefined();
  });

  /**
   * COD-416: the four-way `mode === 'codex' / 'opencode' / 'gemini' / 'antigravity'` chain
   * became `legacyResumeSlot()`, which reads the SAME pairs the registry already declares
   * (`legacyConfigField` + the `resumeId` alias).
   *
   * ⚠️ This is a DELIBERATE widening, called out rather than buried. The old chain covered
   * only the four CLIs that had park-time capture wired when it was written; the registry
   * declares a resume slot for pi/grok/deepseek/omp too, so they now merge as well.
   *
   * It is unreachable today — `captureNativeResumeId()` (session-routes.ts) returns null for
   * every mode outside those four, and the merge is guarded by `if (!this._nativeResumeId)`
   * — so nothing a user can reach changes. It is the RIGHT direction regardless: when capture
   * is widened, the apply side follows automatically instead of silently not following, which
   * is the exact drift the four-way chain was an instance of.
   */
  it.each([
    ['pi', 'piConfig', 'resumeSessionId'],
    ['grok', 'grokConfig', 'resumeSessionId'],
    ['deepseek', 'deepSeekConfig', 'resumeSessionId'],
    ['omp', 'ompConfig', 'resumeSessionId'],
  ] as const)('merges into the registry-declared slot for mode %s', (mode, field, key) => {
    const session = track(
      new Session({
        id: `native-resume-registry-${mode}`,
        workingDir: '/tmp',
        mode,
        mux: makeFakeMux(),
        useMux: true,
      })
    );
    session.setNativeResumeId(`captured-${mode}-id`);

    (session as unknown as SessionInternals)._applyNativeResumeIdForResume();

    // Read the PRIVATE field: unlike codex/antigravity, these four expose no public getter,
    // and reading a missing getter returns undefined — indistinguishable from "did not merge".
    const config = (session as unknown as Record<string, Record<string, unknown> | undefined>)[`_${field}`];
    expect(config?.[key], `${mode} should merge into ${field}.${key}`).toBe(`captured-${mode}-id`);
  });

  /**
   * The slot is chosen by REGISTRY DATA, so the four originally-wired pairs must still be
   * exactly the ones the removed chain hardcoded. Pinned as a table because a wrong alias is
   * otherwise silent: the id lands on a key the CLI's launch template never reads, and the
   * session simply starts a fresh conversation instead of resuming.
   */
  it('resolves each mode to the same config field and key the removed chain hardcoded', () => {
    expect(legacyResumeSlot('codex')).toEqual({ field: 'codexConfig', key: 'resumeSessionId' });
    expect(legacyResumeSlot('opencode')).toEqual({ field: 'openCodeConfig', key: 'continueSession' });
    expect(legacyResumeSlot('gemini')).toEqual({ field: 'geminiConfig', key: 'resumeSession' });
    expect(legacyResumeSlot('antigravity')).toEqual({ field: 'antigravityConfig', key: 'resumeConversationId' });
    // No <Mode>Config object at all — the chain's explicit "stays inert" case.
    expect(legacyResumeSlot('claude')).toBeUndefined();
    expect(legacyResumeSlot('shell')).toBeUndefined();
    expect(legacyResumeSlot('not-a-cli')).toBeUndefined();
  });
});
