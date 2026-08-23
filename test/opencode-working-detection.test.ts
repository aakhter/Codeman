import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectExternalCliWorkingFrame, Session } from '../src/session.js';
import { workingFramePollCoordinator } from '../src/working-frame-poll-coordinator.js';

describe('Opencode working detection', () => {
  it('detects esc to interrupt as working', () => {
    expect(detectExternalCliWorkingFrame('esc to interrupt', 'opencode')).toBe(true);
    expect(detectExternalCliWorkingFrame('ESC TO INTERRUPT', 'opencode')).toBe(true);
    expect(detectExternalCliWorkingFrame('some text • esc to interrupt more', 'opencode')).toBe(true);
  });

  it('detects Working word as working', () => {
    expect(detectExternalCliWorkingFrame('Working', 'opencode')).toBe(true);
    expect(detectExternalCliWorkingFrame('  Working · context', 'opencode')).toBe(true);
  });

  it('detects ellipsis timer as working', () => {
    expect(detectExternalCliWorkingFrame('… (5s', 'opencode')).toBe(true);
    expect(detectExternalCliWorkingFrame('… (13m 23s', 'opencode')).toBe(true);
  });

  it('detects braille spinner as working', () => {
    expect(detectExternalCliWorkingFrame('⠋ spinner', 'opencode')).toBe(true);
  });

  it('does not treat idle opencode prompt as working', () => {
    expect(detectExternalCliWorkingFrame('› idle opencode prompt', 'opencode')).toBe(false);
    expect(detectExternalCliWorkingFrame('  gpt-5.5 medium · /tmp', 'opencode')).toBe(false);
    expect(detectExternalCliWorkingFrame('just some text', 'opencode')).toBe(false);
  });

  it('does not treat idle codex prompt as opencode working (negative)', () => {
    expect(detectExternalCliWorkingFrame('› Improve documentation', 'codex')).toBe(false);
  });
});

describe('Opencode idle transition (spinner latch regression)', () => {
  let session: Session;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new Session({ workingDir: '/tmp', mode: 'opencode' });
  });

  afterEach(async () => {
    await session.stop();
    vi.useRealTimers();
  });

  function feed(data: string): void {
    (session as unknown as { _detectInteractiveActivity(data: string): void })._detectInteractiveActivity(data);
  }

  it('spinner re-arms quiet window and eventually goes idle (no latch)', () => {
    const idleEvents: number[] = [];
    session.on('idle', () => idleEvents.push(Date.now()));
    // Simulate _resetBuffers busy state as startInteractive does
    (session as unknown as { _resetBuffers(): void })._resetBuffers();
    (session as unknown as { _armExternalCliIdleTimer(): void })._armExternalCliIdleTimer();

    feed('⠋ spinner char');
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');

    vi.advanceTimersByTime(6000);
    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
    expect(idleEvents.length).toBe(1);
  });

  it('esc to interrupt keeps busy and flips idle after quiet window', () => {
    const idleEvents: number[] = [];
    session.on('idle', () => idleEvents.push(Date.now()));
    (session as unknown as { _resetBuffers(): void })._resetBuffers();
    (session as unknown as { _armExternalCliIdleTimer(): void })._armExternalCliIdleTimer();

    feed('some text • esc to interrupt more');
    expect(session.isWorking).toBe(true);

    vi.advanceTimersByTime(1000);
    feed('still esc to interrupt');
    vi.advanceTimersByTime(4000);
    expect(session.isWorking).toBe(true);
    vi.advanceTimersByTime(6000);
    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
  });

  it('idle prompt never marks busy and quiet window clears initial busy', () => {
    (session as unknown as { _resetBuffers(): void })._resetBuffers();
    (session as unknown as { _armExternalCliIdleTimer(): void })._armExternalCliIdleTimer();

    feed('› idle prompt gpt-5.5 medium');
    expect(session.isWorking).toBe(false);
    // still busy from _resetBuffers until quiet window expires
    expect(session.status).toBe('busy');
    vi.advanceTimersByTime(6000);
    expect(session.status).toBe('idle');
    expect(session.isWorking).toBe(false);
  });
});

describe('Opencode rendered-frame poller', () => {
  let session: Session;
  let frame: string;
  let asyncCapture: ReturnType<typeof vi.fn>;
  let syncCapture: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    session = new Session({ id: 'opencode-poller', workingDir: '/tmp', mode: 'opencode' });
    frame = 'idle frame\n› prompt\n  opencode · /tmp';
    const s = session as unknown as {
      _mux: unknown;
      _muxSession: unknown;
      _startWorkingFramePoller(): void;
      _resetBuffers(): void;
      _armExternalCliIdleTimer(): void;
    };
    asyncCapture = vi.fn(async () => frame);
    syncCapture = vi.fn(() => {
      throw new Error('activity polling must not use synchronous capture');
    });
    s._mux = {
      capturePaneTextAsync: asyncCapture,
      captureActivePaneBuffer: syncCapture,
      killSession: vi.fn(async () => false),
    };
    s._muxSession = { muxName: 'codeman-test1234' };
    s._resetBuffers();
    s._armExternalCliIdleTimer();
    s._startWorkingFramePoller();
  });

  afterEach(async () => {
    await session.stop();
    vi.useRealTimers();
  });

  it('flips to busy from an asynchronously captured rendered esc to interrupt frame', async () => {
    frame = '\x1b[1mWorking\x1b[0m (2s • esc to interrupt) opencode TUI\r\n› prompt';
    await vi.advanceTimersByTimeAsync(4200);
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
    expect(asyncCapture).toHaveBeenCalledWith(
      'codeman-test1234',
      expect.objectContaining({ lastLines: expect.any(Number) })
    );
    expect(syncCapture).not.toHaveBeenCalled();
  });

  it('stays busy while frame keeps showing working', async () => {
    frame = 'Working (2s • esc to interrupt)';
    await vi.advanceTimersByTimeAsync(4200);
    expect(session.isWorking).toBe(true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(session.isWorking).toBe(true);
  });

  it('flips to idle once working line disappears', async () => {
    frame = 'Working (2s • esc to interrupt)';
    await vi.advanceTimersByTimeAsync(4200);
    expect(session.isWorking).toBe(true);
    frame = 'idle again\n› prompt';
    await vi.advanceTimersByTimeAsync(7000);
    expect(session.isWorking).toBe(false);
    expect(session.status).toBe('idle');
  });

  it('fails quietly when async capture is unavailable without falling back synchronously', async () => {
    const internals = session as unknown as { _mux: unknown; _startWorkingFramePoller(): void };
    internals._mux = { captureActivePaneBuffer: syncCapture };
    internals._startWorkingFramePoller();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(syncCapture).not.toHaveBeenCalled();
  });

  it('backs off null failures from the real Session capture path while treating empty text as success', async () => {
    const failuresBefore = workingFramePollCoordinator.getStats().captureFailures;
    const callTimes: number[] = [];
    asyncCapture.mockImplementation(async () => {
      callTimes.push(Date.now());
      return callTimes.length < 3 ? null : '';
    });
    const internals = session as unknown as { _startWorkingFramePoller(): void };
    internals._startWorkingFramePoller();

    await vi.advanceTimersByTimeAsync(15_999);
    expect(callTimes).toHaveLength(3);
    expect(callTimes[1] - callTimes[0]).toBe(4_000);
    expect(callTimes[2] - callTimes[1]).toBe(8_000);
    expect(workingFramePollCoordinator.getStats().captureFailures - failuresBefore).toBe(2);
  });
});
