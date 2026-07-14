/**
 * @fileoverview Confirmed agent-checkpoint state-machine tests (COD-240).
 *
 * These tests use semantic terminal observations rather than inferring prompt
 * readiness from `!working`. Fake timers keep every timeout path deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionAutoOps,
  type CheckpointObservation,
  type CheckpointProgress,
  type CommandDeliveryResult,
} from '../src/session-auto-ops.js';

const POLL_MS = 500;
const OP_START_TIMEOUT_MS = 8_000;
const OP_MAX_MS = 180_000;
const READY_TIMEOUT_MS = 30_000;

describe('SessionAutoOps confirmed checkpoint', () => {
  let ops: SessionAutoOps;
  let writeCommand: ReturnType<typeof vi.fn>;
  let writeCheckpointCommand: ReturnType<typeof vi.fn>;
  let working: boolean;
  let promptVisible: boolean;
  let stopped: boolean;
  let tokens: number;
  let revision: number;
  let wasReady: boolean;
  let deliveryResult: CommandDeliveryResult;
  let progress: CheckpointProgress[];
  let observationHook: (() => void) | undefined;

  function observation(): CheckpointObservation {
    observationHook?.();
    const ready = promptVisible && !working;
    if (ready && !wasReady) revision++;
    wasReady = ready;
    return { ready, working, revision };
  }

  function sentCommands(): string[] {
    return writeCheckpointCommand.mock.calls.map((call) => call[0] as string);
  }

  async function tick(ms = POLL_MS): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
  }

  async function acceptAndCompleteOperation(): Promise<void> {
    working = true;
    await tick(POLL_MS * 2);
    working = false;
    await tick(POLL_MS * 2);
  }

  async function finishContinuation(): Promise<void> {
    working = true;
    await tick(POLL_MS * 2);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    writeCommand = vi.fn(async () => true);
    working = false;
    promptVisible = true;
    stopped = false;
    tokens = 0;
    revision = 0;
    wasReady = false;
    deliveryResult = { ok: true };
    progress = [];
    observationHook = undefined;
    writeCheckpointCommand = vi.fn(async () => deliveryResult);
    ops = new SessionAutoOps({
      writeCommand,
      writeCheckpointCommand,
      getCheckpointObservation: observation,
      isWorking: () => working,
      isStopped: () => stopped,
      getTotalTokens: () => tokens,
      getSessionId: () => 'test-session',
    });
    ops.on('checkpointProgress', (event: CheckpointProgress) => progress.push(event));
  });

  afterEach(() => {
    ops.destroy();
    vi.useRealTimers();
  });

  it('preserves synchronous refusal reasons', () => {
    expect(ops.requestCheckpoint()).toEqual({ triggered: false, reason: 'not-enabled' });
    ops.setCheckpoint(true, []);
    expect(ops.requestCheckpoint()).toEqual({ triggered: false, reason: 'no-mode-allowed' });
    expect(ops.requestCheckpoint({ mode: 'compact' })).toEqual({
      triggered: false,
      reason: 'mode-not-allowed',
    });
    stopped = true;
    expect(ops.requestCheckpoint()).toEqual({ triggered: false, reason: 'stopped' });
  });

  it('does not inject on false idle without a positive prompt', async () => {
    promptVisible = false;
    ops.setCheckpoint(true, ['compact']);
    expect(ops.requestCheckpoint()).toEqual({ triggered: true });

    await tick(POLL_MS * 6);

    expect(writeCheckpointCommand).not.toHaveBeenCalled();
    expect(progress.map((event) => event.phase)).toEqual(['requested', 'waiting-ready']);
  });

  it('accepts delayed positive readiness and submits exactly once', async () => {
    promptVisible = false;
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await tick(POLL_MS * 3);
    expect(writeCheckpointCommand).not.toHaveBeenCalled();

    promptVisible = true;
    await tick(POLL_MS * 2);

    expect(sentCommands()).toEqual(['/compact\r']);
  });

  it('fails when readiness never arrives', async () => {
    promptVisible = false;
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();

    await tick(READY_TIMEOUT_MS + POLL_MS);

    expect(ops.checkpointState).toMatchObject({
      active: false,
      phase: 'failed',
      reason: 'readiness-timeout',
      step: 'compact',
    });
    expect(sentCommands()).toEqual([]);
  });

  it('blocks continuation when checkpoint delivery fails', async () => {
    deliveryResult = { ok: false, stage: 'text', error: 'tmux rejected text', attempt: 2 };
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();

    await tick(POLL_MS * 2);

    expect(sentCommands()).toEqual(['/compact\r']);
    expect(ops.checkpointState).toMatchObject({
      active: false,
      phase: 'failed',
      reason: 'delivery-failed',
      stage: 'text',
      attempt: 2,
    });
  });

  it('treats a false legacy write acknowledgement as delivery failure', async () => {
    const legacyOps = new SessionAutoOps({
      writeCommand: vi.fn(async () => false),
      getCheckpointObservation: observation,
      isWorking: () => working,
      isStopped: () => stopped,
      getTotalTokens: () => 0,
      getSessionId: () => 'legacy-write-test',
    });
    legacyOps.setCheckpoint(true, ['compact']);
    legacyOps.requestCheckpoint();
    await tick(POLL_MS);

    expect(legacyOps.checkpointState).toMatchObject({
      active: false,
      phase: 'failed',
      reason: 'delivery-failed',
      stage: 'text',
    });
    legacyOps.destroy();
  });

  it('fails when a submitted operation never leaves the baseline prompt', async () => {
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await tick(POLL_MS * 2);

    await tick(OP_START_TIMEOUT_MS + POLL_MS);

    expect(sentCommands()).toEqual(['/compact\r']);
    expect(ops.checkpointState).toMatchObject({ phase: 'failed', reason: 'operation-not-accepted' });
  });

  it('fails when an operation starts but never returns to a fresh prompt', async () => {
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await tick(POLL_MS * 2);
    working = true;
    await tick(POLL_MS * 2);

    await tick(OP_MAX_MS + POLL_MS);

    expect(ops.checkpointState).toMatchObject({ phase: 'failed', reason: 'operation-timeout' });
    expect(sentCommands()).not.toContain('continue\r');
  });

  it('blocks done when continuation delivery fails', async () => {
    writeCheckpointCommand.mockImplementation(async (command: string) =>
      command === 'continue\r' ? { ok: false, stage: 'enter', attempt: 2 } : { ok: true }
    );
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await tick(POLL_MS * 2);
    await acceptAndCompleteOperation();

    expect(sentCommands()).toEqual(['/compact\r', 'continue\r']);
    expect(ops.checkpointState).toMatchObject({
      active: false,
      phase: 'failed',
      reason: 'continuation-delivery-failed',
      stage: 'enter',
    });
    expect(progress.some((event) => event.phase === 'done')).toBe(false);
  });

  it('blocks done when continuation never starts a new working turn', async () => {
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await tick(POLL_MS * 2);
    await acceptAndCompleteOperation();
    expect(sentCommands()).toContain('continue\r');

    await tick(OP_START_TIMEOUT_MS + POLL_MS);

    expect(ops.checkpointState).toMatchObject({ phase: 'failed', reason: 'continuation-not-started' });
    expect(progress.some((event) => event.phase === 'done')).toBe(false);
  });

  it('runs compact through every lifecycle phase and only finishes after the new turn starts', async () => {
    const done = vi.fn();
    ops.on('checkpointDone', done);
    ops.setCheckpoint(true, ['compact']);
    expect(ops.requestCheckpoint({ continuePrompt: '$jira-autoloop' })).toEqual({ triggered: true });
    await tick(POLL_MS * 2);
    await acceptAndCompleteOperation();

    expect(sentCommands()).toEqual(['/compact\r', '$jira-autoloop\r']);
    expect(done).not.toHaveBeenCalled();
    await finishContinuation();

    expect(done).toHaveBeenCalledWith({ mode: 'compact' });
    expect(progress.map((event) => event.phase)).toEqual([
      'requested',
      'waiting-ready',
      'command-submitted',
      'operation-started',
      'operation-complete',
      'continue-submitted',
      'done',
    ]);
    expect(ops.checkpointState).toMatchObject({ active: false, phase: 'done', mode: 'compact' });
  });

  it('runs clear as /clear then /init, with a confirmed cycle for each step', async () => {
    ops.setCheckpoint(true, ['clear']);
    ops.requestCheckpoint();
    await tick(POLL_MS * 2);
    expect(sentCommands()).toEqual(['/clear\r']);
    await acceptAndCompleteOperation();
    expect(sentCommands()).toEqual(['/clear\r', '/init\r']);
    await acceptAndCompleteOperation();
    expect(sentCommands()).toEqual(['/clear\r', '/init\r', 'continue\r']);
    await finishContinuation();

    expect(ops.checkpointState).toMatchObject({ active: false, phase: 'done', mode: 'clear' });
    expect(progress.filter((event) => event.phase === 'operation-complete').map((event) => event.step)).toEqual([
      'clear',
      'init',
    ]);
  });

  it('accepts an instantaneous /clear only from a genuinely fresh ready-prompt generation', async () => {
    ops.setCheckpoint(true, ['clear']);
    ops.requestCheckpoint();
    await tick(POLL_MS);
    expect(sentCommands()).toEqual(['/clear\r']);

    // /clear reset and returned to ready entirely between driver polls.
    revision++;
    await tick(POLL_MS * 2);

    expect(sentCommands()).toEqual(['/clear\r', '/init\r']);
    expect(progress.filter((event) => event.step === 'clear').map((event) => event.phase)).toContain(
      'operation-complete'
    );
  });

  it('does not let a fresh ready generation bypass strict compact acceptance', async () => {
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await tick(POLL_MS);
    revision++;
    await tick(POLL_MS * 2);

    expect(progress.some((event) => event.phase === 'operation-started')).toBe(false);
    expect(sentCommands()).toEqual(['/compact\r']);
  });

  it.each(['destroy', 'stop'] as const)(
    'does not write after readiness resolves when %s wins the await boundary',
    async (action) => {
      ops.setCheckpoint(true, ['compact']);
      ops.requestCheckpoint();
      if (action === 'destroy') ops.destroy();
      else stopped = true;
      await Promise.resolve();
      await Promise.resolve();

      expect(sentCommands()).toEqual([]);
      expect(progress.at(-1)).toMatchObject({ phase: 'aborted' });
      expect(progress.some((event) => event.phase === 'command-submitted')).toBe(false);
    }
  );

  it.each(['destroy', 'stop'] as const)(
    'does not emit done when %s wins the matched-working boundary',
    async (action) => {
      ops.setCheckpoint(true, ['compact']);
      ops.requestCheckpoint();
      await tick(POLL_MS);
      await acceptAndCompleteOperation();
      expect(sentCommands()).toContain('continue\r');

      observationHook = () => {
        observationHook = undefined;
        if (action === 'destroy') ops.destroy();
        else stopped = true;
      };
      working = true;
      await tick(POLL_MS);

      expect(progress.at(-1)).toMatchObject({ phase: 'aborted' });
      expect(progress.some((event) => event.phase === 'done')).toBe(false);
    }
  );

  it.each([
    ['waiting for readiness', async () => undefined],
    [
      'waiting for operation acceptance',
      async () => {
        await tick(POLL_MS * 2);
      },
    ],
    [
      'waiting for operation completion',
      async () => {
        await tick(POLL_MS * 2);
        working = true;
        await tick(POLL_MS * 2);
      },
    ],
    [
      'waiting for continuation start',
      async () => {
        await tick(POLL_MS * 2);
        await acceptAndCompleteOperation();
      },
    ],
  ])('aborts without later writes when stopped while %s', async (_label, reachWait) => {
    if (_label === 'waiting for readiness') promptVisible = false;
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await reachWait();
    const writesAtStop = sentCommands().length;
    stopped = true;
    await tick(POLL_MS * 3);

    expect(sentCommands()).toHaveLength(writesAtStop);
    expect(ops.checkpointState).toMatchObject({ active: false, phase: 'aborted', reason: 'stopped' });
  });

  it('destroy aborts an active sequence and clears future work', async () => {
    promptVisible = false;
    ops.setCheckpoint(true, ['compact']);
    ops.requestCheckpoint();
    await tick(POLL_MS);
    ops.destroy();
    await tick(READY_TIMEOUT_MS + POLL_MS);

    expect(sentCommands()).toEqual([]);
    expect(ops.checkpointState).toMatchObject({ active: false, phase: 'aborted', reason: 'destroyed' });
  });

  it('keeps allowed modes stable and suppresses threshold auto-ops while active', async () => {
    promptVisible = false;
    ops.setCheckpoint(true, ['clear', 'compact']);
    expect(ops.checkpointModes).toEqual(['compact', 'clear']);
    expect(ops.checkpointMode).toBe('compact');
    ops.requestCheckpoint();
    expect(ops.requestCheckpoint()).toEqual({ triggered: false, reason: 'busy' });
    ops.setAutoCompact(true, 1000);
    tokens = 200_000;
    ops.checkAutoCompact();
    await tick(5_000);
    expect(writeCommand).not.toHaveBeenCalled();
  });

  it('restores checkpoint flags and modes without arming work', () => {
    ops.restoreCheckpoint(true, ['clear']);
    expect(ops.checkpointEnabled).toBe(true);
    expect(ops.checkpointModes).toEqual(['clear']);
    expect(ops.checkpointMode).toBe('clear');
    expect(ops.isCheckpointActive).toBe(false);
    expect(writeCheckpointCommand).not.toHaveBeenCalled();
  });

  it('uses compact as the bare default and falls back to clear when it is the only allowed mode', async () => {
    ops.setCheckpoint(true);
    ops.requestCheckpoint();
    await tick(POLL_MS);
    expect(sentCommands()).toEqual(['/compact\r']);
    ops.destroy();

    const clearOnly = new SessionAutoOps({
      writeCommand,
      writeCheckpointCommand,
      getCheckpointObservation: observation,
      isWorking: () => working,
      isStopped: () => stopped,
      getTotalTokens: () => 0,
      getSessionId: () => 'clear-only',
    });
    clearOnly.setCheckpoint(true, ['clear']);
    clearOnly.requestCheckpoint();
    await tick(POLL_MS);
    expect(sentCommands()).toEqual(['/compact\r', '/clear\r']);
    clearOnly.destroy();
  });

  it('runs compact then clear in one session without changing checkpoint settings', async () => {
    ops.setCheckpoint(true);
    ops.requestCheckpoint();
    await tick(POLL_MS);
    await acceptAndCompleteOperation();
    await finishContinuation();
    expect(ops.checkpointState?.phase).toBe('done');

    working = false;
    expect(ops.requestCheckpoint({ mode: 'clear' })).toEqual({ triggered: true });
    await tick(POLL_MS);
    expect(sentCommands()).toContain('/compact\r');
    expect(sentCommands()).toContain('/clear\r');
  });
});
