import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectExternalCliWorkingFrame, Session } from '../src/session.js';
import { workingFramePollCoordinator } from '../src/working-frame-poll-coordinator.js';

describe('Opencode working detection', () => {
  // COD-375: opencode's IDLE frame carries `esc interrupt` (and `⬝`), so the interrupt
  // hint cannot prove working for this mode — it latched sessions busy forever. Only
  // `Working`, the `… (Ns` timer, or a braille spinner count. This test used to assert
  // the opposite; it now pins the fix so the false-positive cannot come back.
  it('does not treat esc to interrupt alone as working (idle frames carry it)', () => {
    expect(detectExternalCliWorkingFrame('esc to interrupt', 'opencode')).toBe(false);
    expect(detectExternalCliWorkingFrame('ESC TO INTERRUPT', 'opencode')).toBe(false);
    expect(detectExternalCliWorkingFrame('some text • esc to interrupt more', 'opencode')).toBe(false);
    // …but the same frame WITH a real working signal still reads as working.
    expect(detectExternalCliWorkingFrame('Working • esc to interrupt', 'opencode')).toBe(true);
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

  // Driven by `Working` rather than `esc to interrupt` since COD-375 (see above); the
  // behaviour under test is the latch itself — repeated working frames hold busy, and
  // the quiet window is what releases it.
  it('a working frame keeps busy and flips idle after quiet window', () => {
    const idleEvents: number[] = [];
    session.on('idle', () => idleEvents.push(Date.now()));
    (session as unknown as { _resetBuffers(): void })._resetBuffers();
    (session as unknown as { _armExternalCliIdleTimer(): void })._armExternalCliIdleTimer();

    feed('some text • Working more');
    expect(session.isWorking).toBe(true);

    vi.advanceTimersByTime(1000);
    feed('still Working');
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
      expect.objectContaining({ signal: expect.any(AbortSignal) })
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

  it('does not emit initial-ready while the first rendered-frame capture is still pending', async () => {
    let resolveCapture!: (value: string | null) => void;
    asyncCapture.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveCapture = resolve;
        })
    );
    const idleEvents: unknown[] = [];
    session.on('idle', (event) => idleEvents.push(event));
    const internals = session as unknown as { _startWorkingFramePoller(): void };
    internals._startWorkingFramePoller();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(asyncCapture).toHaveBeenCalledTimes(1);
    expect(idleEvents).toEqual([]);

    resolveCapture('Working (5s • esc to interrupt)');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.isWorking).toBe(true);
    expect(session.status).toBe('busy');
    expect(idleEvents).toEqual([]);
  });

  it('does not let an awaiting initial-ready check escape a poller restart fence', async () => {
    let captureCount = 0;
    asyncCapture.mockImplementation((_muxName: string, options: { signal?: AbortSignal }) =>
      ++captureCount === 1
        ? new Promise<string | null>((_resolve, reject) => {
            options.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          })
        : Promise.resolve('idle frame')
    );
    const idleEvents: unknown[] = [];
    session.on('idle', (event) => idleEvents.push(event));
    const internals = session as unknown as { _startWorkingFramePoller(): void };
    internals._startWorkingFramePoller();

    await vi.advanceTimersByTimeAsync(5_000);
    internals._startWorkingFramePoller();
    await vi.advanceTimersByTimeAsync(0);

    expect(session.status).toBe('busy');
    expect(idleEvents).toEqual([]);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(session.status).toBe('idle');
    expect(idleEvents).toEqual([{ reason: 'initial-ready' }]);
  });

  it('keeps first-capture rejection retries on the coordinator backoff schedule', async () => {
    const callTimes: number[] = [];
    asyncCapture.mockImplementation(async () => {
      callTimes.push(Date.now());
      if (callTimes.length === 1) throw new Error('capture failed');
      return '';
    });
    const internals = session as unknown as { _startWorkingFramePoller(): void };
    internals._startWorkingFramePoller();

    await vi.advanceTimersByTimeAsync(1_999);
    expect(callTimes).toHaveLength(1);
    const retryAt = callTimes[0]! + 4_000;
    await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
    expect(callTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(callTimes).toHaveLength(2);
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

    await vi.advanceTimersByTimeAsync(1_999);
    expect(callTimes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(callTimes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(callTimes).toHaveLength(3);
    expect(callTimes[1] - callTimes[0]).toBe(4_000);
    expect(callTimes[2] - callTimes[1]).toBe(8_000);
    expect(workingFramePollCoordinator.getStats().captureFailures - failuresBefore).toBe(2);
  });
});
