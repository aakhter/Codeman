import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The respawn controller transitively drives the AI idle checker, which spawns real
// `tmux`/`claude` via child_process. Neutralize those spawns here (mirrors
// respawn-controller.test.ts) so tests never launch real processes.
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(() => ({ unref: vi.fn(), pid: 12345, on: vi.fn() })),
  };
});

import { RespawnController, RespawnState } from '../src/respawn-controller.js';
import { Session } from '../src/session.js';
import { MockSession } from './mocks/index.js';

/**
 * COD-51 regression: respawn step callbacks must NOT resurrect a stopped state
 * machine after the `await this.session.writeViaMux(...)` they suspend on.
 *
 * The race: a step (e.g. sendUpdateDocs) checks `if (this._state === 'stopped')`
 * BEFORE the await, then awaits writeViaMux. If stop() runs while that await is
 * pending (state → 'stopped', timers cleared), the post-await
 * `setState('waiting_*')` would revive the machine and arm a fresh stuck-state
 * timer — a zombie controller. The fix re-checks `stopped` immediately after the
 * await. Here we suspend the await with a deferred promise, call stop(), then
 * resolve and assert the machine stays stopped.
 */
describe('RespawnController COD-51 stopped-check race', () => {
  let session: MockSession;
  let controller: RespawnController;

  beforeEach(() => {
    session = new MockSession();
    controller = new RespawnController(session as unknown as Session, {
      interStepDelayMs: 1, // fire the step-delay timer almost immediately (0 is rejected by config validation)
      aiIdleCheckEnabled: false,
    });
  });

  afterEach(() => {
    controller.stop();
  });

  it('does not resurrect the stopped machine when stop() runs during an awaited writeViaMux', async () => {
    // Make writeViaMux hang on a deferred promise so we can suspend a step mid-await.
    let resolveWrite!: (value: boolean) => void;
    const writePending = new Promise<boolean>((resolve) => {
      resolveWrite = resolve;
    });
    const writeSpy = vi.fn(() => writePending);
    session.writeViaMux = writeSpy as unknown as MockSession['writeViaMux'];

    controller.start();
    expect(controller.state).toBe('watching');

    // Drive the most representative step (the first cycle step) up to its
    // awaited writeViaMux. sendUpdateDocs sets state to 'sending_update' and arms
    // a 0ms 'step-delay' timer whose async callback performs the write.
    (controller as unknown as { sendUpdateDocs(): void }).sendUpdateDocs();
    expect(controller.state).toBe('sending_update');

    // Let the step-delay timer fire; the callback now suspends at `await writeViaMux`.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(controller.state).toBe('sending_update');

    // Record any state transitions that happen AFTER stop().
    const postStopStates: RespawnState[] = [];
    controller.on('stateChanged', (state: RespawnState) => postStopStates.push(state));

    // stop() while the write is suspended: state → 'stopped', timers cleared.
    controller.stop();
    expect(controller.state).toBe('stopped');
    postStopStates.length = 0; // ignore the watching→stopped transition from stop() itself

    // Resolve the suspended write and flush microtasks so the post-await code runs.
    resolveWrite(true);
    await writePending;
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The post-await setState('waiting_update') must NOT have run.
    // Behaviorally: state stays 'stopped' and no resurrecting transition fired
    // (which also proves no fresh stuck-state timer was armed, since
    // startStuckStateTimer is only reached via setState to a non-stopped state).
    expect(controller.state).toBe('stopped');
    expect(postStopStates).not.toContain('waiting_update');
    expect(postStopStates).toEqual([]);
  });
});
