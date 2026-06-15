/**
 * Tests for SessionAutoOps agent-initiated checkpoint (compact-or-clear, then continue).
 *
 * Uses fake timers; the SessionAutoOps callbacks are plain mocks, so no real
 * session, tmux, or ports are involved. Port: N/A
 *
 * The ORDERING is the crux: after sending the op command (/compact or
 * /clear→/init), the continue prompt must be sent ONLY after the op actually
 * runs (the working→idle transition), not on the immediate post-send idle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionAutoOps } from '../src/session-auto-ops.js';

const POLL_MS = 500; // CHECKPOINT_POLL_MS in session-auto-ops.ts

describe('SessionAutoOps checkpoint', () => {
  let ops: SessionAutoOps;
  let writeCommand: ReturnType<typeof vi.fn>;
  let working: boolean;
  let stopped: boolean;
  let tokens: number;

  /** All command strings sent so far, in order. */
  function sentCommands(): string[] {
    return writeCommand.mock.calls.map((c) => c[0] as string);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    writeCommand = vi.fn(async () => true);
    working = false;
    stopped = false;
    tokens = 0;
    ops = new SessionAutoOps({
      writeCommand,
      isWorking: () => working,
      isStopped: () => stopped,
      getTotalTokens: () => tokens,
      getSessionId: () => 'test-session',
    });
  });

  afterEach(() => {
    ops.destroy();
    vi.useRealTimers();
  });

  it('does nothing when not enabled', () => {
    const res = ops.requestCheckpoint();
    expect(res).toEqual({ triggered: false, reason: 'not-enabled' });
    expect(writeCommand).not.toHaveBeenCalled();
    expect(ops.isCheckpointActive).toBe(false);
  });

  it('refuses when the session is stopped', () => {
    ops.setCheckpoint(true, ['compact']);
    stopped = true;
    const res = ops.requestCheckpoint();
    expect(res).toEqual({ triggered: false, reason: 'stopped' });
    expect(writeCommand).not.toHaveBeenCalled();
  });

  it('compact happy path: sends /compact, waits for the op, THEN continues', async () => {
    ops.setCheckpoint(true, ['compact']);
    const started = vi.fn();
    const done = vi.fn();
    ops.on('checkpointStart', started);
    ops.on('checkpointDone', done);

    const res = ops.requestCheckpoint();
    expect(res).toEqual({ triggered: true });
    expect(ops.isCheckpointActive).toBe(true);
    expect(started).toHaveBeenCalledWith({ mode: 'compact' });

    // Phase 1: idle → /compact is sent. Continue must NOT be sent yet.
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/compact\r');
    expect(sentCommands()).not.toContain('continue\r');

    // The op starts (working=true). Continue still must not fire mid-op:
    // this is the trap a naive "send continue on next idle" impl falls into.
    working = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(sentCommands()).not.toContain('continue\r');
    expect(done).not.toHaveBeenCalled();

    // Op completes (working→idle): NOW the continue prompt is sent.
    working = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(sentCommands()).toContain('continue\r');
    expect(done).toHaveBeenCalledWith({ mode: 'compact' });
    expect(ops.isCheckpointActive).toBe(false);

    // ...and it came AFTER /compact.
    const cmds = sentCommands();
    expect(cmds.indexOf('continue\r')).toBeGreaterThan(cmds.indexOf('/compact\r'));
  });

  it('clear mode sends /clear → /init → continue in order, each gated by an op cycle', async () => {
    ops.setCheckpoint(true, ['clear']);
    ops.requestCheckpoint();

    // Step 1: /clear
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/clear\r');
    expect(sentCommands()).not.toContain('/init\r');

    // Drive the /clear op working→idle cycle
    working = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    working = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    // Step 2: /init
    expect(sentCommands()).toContain('/init\r');
    expect(sentCommands()).not.toContain('continue\r');

    // Drive the /init op working→idle cycle
    working = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    working = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    // Final: continue
    expect(sentCommands()).toContain('continue\r');

    const cmds = sentCommands();
    expect(cmds.indexOf('/clear\r')).toBeLessThan(cmds.indexOf('/init\r'));
    expect(cmds.indexOf('/init\r')).toBeLessThan(cmds.indexOf('continue\r'));
  });

  it('uses an agent-supplied continue prompt', async () => {
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint({ continuePrompt: 'resume task X' });

    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    working = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    working = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);

    expect(sentCommands()).toContain('resume task X\r');
    expect(sentCommands()).not.toContain('continue\r');
  });

  it('busy guard: a second request is rejected, and token-threshold compact is suppressed', async () => {
    ops.setCheckpoint(true, ['compact']);
    const first = ops.requestCheckpoint();
    expect(first).toEqual({ triggered: true });

    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(ops.isCheckpointActive).toBe(true);

    // Second request while active → busy
    const second = ops.requestCheckpoint();
    expect(second).toEqual({ triggered: false, reason: 'busy' });

    // Token-threshold auto-compact must NOT fire during an active checkpoint.
    ops.setAutoCompact(true, 1000);
    tokens = 200_000;
    ops.checkAutoCompact();
    await vi.advanceTimersByTimeAsync(5000);
    // The only /compact present is the checkpoint's own (exactly one).
    const compacts = sentCommands().filter((c) => c === '/compact\r');
    expect(compacts.length).toBe(1);
  });

  it('gating: an explicit mode the operator forbade is refused', () => {
    ops.setCheckpoint(true, ['clear']); // compact NOT allowed
    expect(ops.checkpointModes).toEqual(['clear']);
    expect(ops.checkpointMode).toBe('clear'); // bare checkpoint falls to clear

    const res = ops.requestCheckpoint({ mode: 'compact' });
    expect(res).toEqual({ triggered: false, reason: 'mode-not-allowed' });
    expect(writeCommand).not.toHaveBeenCalled();
    expect(ops.isCheckpointActive).toBe(false);
  });

  it('restoreCheckpoint restores flags + allowed modes without arming anything', () => {
    ops.restoreCheckpoint(true, ['clear']);
    expect(ops.checkpointEnabled).toBe(true);
    expect(ops.checkpointModes).toEqual(['clear']);
    expect(ops.checkpointMode).toBe('clear');
    expect(ops.isCheckpointActive).toBe(false);
    expect(writeCommand).not.toHaveBeenCalled();
  });

  it('aborts the sequence (no continue) if the session stops mid-checkpoint', async () => {
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/compact\r');

    working = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    stopped = true;
    working = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(sentCommands()).not.toContain('continue\r');
  });

  // ── COD-112: both modes available (agent-selectable), compact the default ──

  it('default fallback is compact when enabled without a mode (no -m given)', async () => {
    // Operator enables checkpoint without choosing a mode; agent signals with
    // no explicit mode → compact runs (AC: "no explicit mode → compact").
    ops.setCheckpoint(true);
    expect(ops.checkpointMode).toBe('compact');

    const res = ops.requestCheckpoint();
    expect(res).toEqual({ triggered: true });
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/compact\r');
    expect(sentCommands()).not.toContain('/clear\r');
  });

  it('compact default + agent picks clear per-call → /clear runs (both available)', async () => {
    // Headline AC: operator did NOT lock the session; default is compact, yet
    // the agent can still run a clear checkpoint by passing the mode.
    ops.setCheckpoint(true); // default compact, no lock
    ops.requestCheckpoint({ mode: 'clear' });

    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/clear\r');
    expect(sentCommands()).not.toContain('/compact\r');
  });

  it('agent runs compact then clear in one session without changing settings', async () => {
    // AC: "an agent can trigger a compact checkpoint and a clear checkpoint
    // within the same session without the operator changing settings."
    ops.setCheckpoint(true); // enabled once, default compact

    // 1) compact (default) — drive the full op cycle to completion.
    ops.requestCheckpoint();
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/compact\r');
    working = true;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    working = false;
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(ops.isCheckpointActive).toBe(false); // first checkpoint done

    // 2) clear (per-call override) — same session, no setCheckpoint between.
    const res = ops.requestCheckpoint({ mode: 'clear' });
    expect(res).toEqual({ triggered: true });
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/clear\r');

    // Both modes ran in the one session.
    expect(sentCommands()).toContain('/compact\r');
    expect(sentCommands()).toContain('/clear\r');
  });

  // ── COD-112 (toggles): operator-selectable allowed-mode set + gating ──

  it('enabling with no modes specified defaults to both allowed', () => {
    ops.setCheckpoint(true);
    expect(ops.checkpointModes).toEqual(['compact', 'clear']);
  });

  it('allowed set is reported in stable order regardless of input order', () => {
    ops.setCheckpoint(true, ['clear', 'compact']);
    expect(ops.checkpointModes).toEqual(['compact', 'clear']);
  });

  it('gating: only compact allowed → clear refused, bare checkpoint runs compact', async () => {
    ops.setCheckpoint(true, ['compact']);
    expect(ops.checkpointModes).toEqual(['compact']);

    const refused = ops.requestCheckpoint({ mode: 'clear' });
    expect(refused).toEqual({ triggered: false, reason: 'mode-not-allowed' });

    const ok = ops.requestCheckpoint(); // no -m → compact (the only allowed mode)
    expect(ok).toEqual({ triggered: true });
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/compact\r');
    expect(sentCommands()).not.toContain('/clear\r');
  });

  it('gating: empty allowed set → every request is refused (no-mode-allowed)', () => {
    ops.setCheckpoint(true, []);
    expect(ops.checkpointModes).toEqual([]);
    expect(ops.requestCheckpoint()).toEqual({ triggered: false, reason: 'no-mode-allowed' });
    expect(ops.requestCheckpoint({ mode: 'compact' })).toEqual({ triggered: false, reason: 'mode-not-allowed' });
    expect(writeCommand).not.toHaveBeenCalled();
  });

  it('only clear allowed → bare checkpoint runs clear (compact-preferred default falls through)', async () => {
    ops.setCheckpoint(true, ['clear']);
    expect(ops.checkpointMode).toBe('clear');
    ops.requestCheckpoint();
    await vi.advanceTimersByTimeAsync(POLL_MS + 50);
    expect(sentCommands()).toContain('/clear\r');
    expect(sentCommands()).not.toContain('/compact\r');
  });
});
