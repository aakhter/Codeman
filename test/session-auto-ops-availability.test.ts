import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionAutoOps, type CheckpointObservation } from '../src/session-auto-ops.js';

describe('SessionAutoOps autonomous availability', () => {
  let activityBlocked: boolean;
  let tokens: number;
  let writeCommand: ReturnType<typeof vi.fn>;
  let writeCheckpointCommand: ReturnType<typeof vi.fn>;
  let checkpointDeliveryAccesses: number;
  let blockOnCheckpointDeliveryAccess: number | null;
  let observation: CheckpointObservation;
  let ops: SessionAutoOps;

  beforeEach(() => {
    vi.useFakeTimers();
    activityBlocked = false;
    tokens = 0;
    writeCommand = vi.fn(async () => true);
    writeCheckpointCommand = vi.fn(async () => ({ ok: true as const, attempt: 1 }));
    checkpointDeliveryAccesses = 0;
    blockOnCheckpointDeliveryAccess = null;
    observation = { ready: true, working: false, revision: 1, conversationId: 'conversation-1' };
    const callbacks = {
      writeCommand,
      getCheckpointObservation: async () => observation,
      getCheckpointBackendMode: () => 'claude',
      isWorking: () => false,
      isIdleAutomationBlocked: () => activityBlocked,
      isStopped: () => false,
      getTotalTokens: () => tokens,
      getSessionId: () => 'availability-test',
    };
    Object.defineProperty(callbacks, 'writeCheckpointCommand', {
      get: () => {
        checkpointDeliveryAccesses++;
        if (checkpointDeliveryAccesses === blockOnCheckpointDeliveryAccess) activityBlocked = true;
        return writeCheckpointCommand;
      },
    });
    ops = new SessionAutoOps(callbacks);
  });

  afterEach(() => {
    ops.destroy();
    vi.useRealTimers();
  });

  it.each(['live', 'unknown'])('retries auto-compact without writing while activity is %s', async () => {
    ops.setAutoCompact(true, 1000);
    tokens = 1000;
    activityBlocked = true;
    ops.checkAutoCompact();

    await vi.advanceTimersByTimeAsync(5000);
    expect(writeCommand).not.toHaveBeenCalled();

    activityBlocked = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(writeCommand).toHaveBeenCalledWith('/compact\r');
  });

  it.each(['live', 'unknown'])('retries auto-clear without writing while activity is %s', async () => {
    ops.setAutoClear(true, 1000);
    tokens = 1000;
    activityBlocked = true;
    ops.checkAutoClear();

    await vi.advanceTimersByTimeAsync(5000);
    expect(writeCommand).not.toHaveBeenCalled();

    activityBlocked = false;
    await vi.advanceTimersByTimeAsync(2500);
    expect(writeCommand).toHaveBeenCalledWith('/clear\r');
  });

  it.each(['live', 'unknown'])('refuses a checkpoint request while activity is %s', (activityStatus) => {
    ops.setCheckpoint(true);
    activityBlocked = true;

    expect(ops.requestCheckpoint()).toEqual({ triggered: false, reason: 'activity-blocked' });
    expect(writeCheckpointCommand).not.toHaveBeenCalled();

    activityBlocked = false;
    expect(ops.requestCheckpoint()).toEqual({ triggered: true, runId: expect.any(String) });
  });

  it('holds checkpoint readiness and delayed writes until agent activity clears', async () => {
    ops.setCheckpoint(true);
    const requested = ops.requestCheckpoint();
    expect(requested.triggered).toBe(true);
    activityBlocked = true;

    await vi.advanceTimersByTimeAsync(1000);
    expect(writeCheckpointCommand).not.toHaveBeenCalled();

    activityBlocked = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(writeCheckpointCommand).toHaveBeenCalledWith('/compact\r');

    activityBlocked = true;
    observation = { ready: false, working: true, revision: 1, conversationId: 'conversation-1' };
    await vi.advanceTimersByTimeAsync(500);
    observation = { ready: true, working: false, revision: 2, conversationId: 'conversation-1' };
    await vi.advanceTimersByTimeAsync(500);
    expect(writeCheckpointCommand).toHaveBeenCalledTimes(1);

    activityBlocked = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(writeCheckpointCommand).toHaveBeenCalledWith('continue\r');
  });

  it.each(['live', 'unknown'])(
    'rechecks %s activity at checkpoint and continuation delivery boundaries without duplicate writes',
    async () => {
      ops.setCheckpoint(true);
      blockOnCheckpointDeliveryAccess = checkpointDeliveryAccesses + 1;

      expect(ops.requestCheckpoint()).toEqual({ triggered: true, runId: expect.any(String) });
      await vi.advanceTimersByTimeAsync(500);
      expect(writeCheckpointCommand).not.toHaveBeenCalled();

      activityBlocked = false;
      blockOnCheckpointDeliveryAccess = null;
      await vi.advanceTimersByTimeAsync(500);
      expect(writeCheckpointCommand).toHaveBeenCalledTimes(1);
      expect(writeCheckpointCommand).toHaveBeenLastCalledWith('/compact\r');

      observation = { ready: false, working: true, revision: 1, conversationId: 'conversation-1' };
      await vi.advanceTimersByTimeAsync(500);
      observation = { ready: true, working: false, revision: 2, conversationId: 'conversation-1' };
      blockOnCheckpointDeliveryAccess = checkpointDeliveryAccesses + 1;
      await vi.advanceTimersByTimeAsync(500);
      expect(writeCheckpointCommand).toHaveBeenCalledTimes(1);

      activityBlocked = false;
      blockOnCheckpointDeliveryAccess = null;
      await vi.advanceTimersByTimeAsync(500);
      expect(writeCheckpointCommand).toHaveBeenCalledTimes(2);
      expect(writeCheckpointCommand).toHaveBeenLastCalledWith('continue\r');
      await vi.advanceTimersByTimeAsync(1000);
      expect(writeCheckpointCommand).toHaveBeenCalledTimes(2);
    }
  );
});
