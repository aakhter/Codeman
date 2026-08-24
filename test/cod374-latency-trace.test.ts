import { describe, expect, it, vi } from 'vitest';
import {
  BROWSER_GLOBAL_OUTPUT_STAGES,
  BROWSER_INPUT_STAGES,
  BROWSER_VISIBILITY_STAGES,
  correlateBrowserServerTrace,
  componentLocalDuration,
  createPaintFence,
  createXtermWriteCorrelator,
  observePaneVisibilities,
  observePaneVisibility,
  PaneObservationError,
  PaneVisibilitiesObservationError,
  requireNoBrowserLongTasks,
  runCleanupSteps,
  tracingOverheadGate,
  validateBrowserLatencyTrace,
  validateServerOutputChain,
  type BrowserLatencyEvent,
} from './utils/cod374-latency-trace.js';

describe('COD-374 latency trace helpers', () => {
  it('requires both absolute and percentage tracing overhead limits', () => {
    expect(tracingOverheadGate(100, 105)).toEqual({
      passed: true,
      deltaMs: 5,
      deltaPercent: 5,
    });
    expect(tracingOverheadGate(20, 24)).toMatchObject({ passed: false, deltaMs: 4, deltaPercent: 20 });
    expect(tracingOverheadGate(100, 106)).toMatchObject({ passed: false, deltaMs: 6, deltaPercent: 6 });
  });

  it.each([
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ])('rejects invalid p95 values (%s, %s)', (offP95, onP95) => {
    expect(() => tracingOverheadGate(offP95, onP95)).toThrow(/finite positive p95/i);
  });

  it('retains every pane probe, including errors, and reports conservative bounds', async () => {
    const captures = [new Error('probe failed'), 'not-yet', 'prefix-token-suffix'];
    const clock = [0n, 2_000_000n, 3_000_000n, 5_000_000n, 7_000_000n, 11_000_000n];
    const capture = vi.fn(async () => {
      const value = captures.shift();
      if (value instanceof Error) throw value;
      return value ?? '';
    });

    const interval = await observePaneVisibility({
      capture,
      isPresent: (text) => text.includes('token'),
      deadlineMs: 100,
      pollIntervalMs: 0,
      nowNs: () => clock.shift()!,
      wait: async () => undefined,
    });

    expect(capture).toHaveBeenCalledTimes(3);
    expect(interval.probes).toEqual([
      { startedNs: 0n, completedNs: 2_000_000n, present: false, durationMs: 2, error: 'probe failed' },
      { startedNs: 3_000_000n, completedNs: 5_000_000n, present: false, durationMs: 2 },
      { startedNs: 7_000_000n, completedNs: 11_000_000n, present: true, durationMs: 4 },
    ]);
    expect(interval).toMatchObject({
      lastAbsentCompletedNs: 5_000_000n,
      firstPresentStartedNs: 7_000_000n,
      firstPresentCompletedNs: 11_000_000n,
      widthMs: 6,
    });
  });

  it('retains isPresent exceptions as errored probes and bounds active capture execution', async () => {
    const seenOptions: Array<{ aborted: boolean; timeoutMs: number }> = [];
    let predicateCalls = 0;
    const interval = await observePaneVisibility({
      capture: async ({ signal, timeoutMs }) => {
        seenOptions.push({ aborted: signal?.aborted === true, timeoutMs });
        return predicateCalls === 0 ? 'first' : predicateCalls === 1 ? 'absent' : 'token';
      },
      isPresent: (text) => {
        predicateCalls++;
        if (predicateCalls === 1) throw new Error('predicate failed');
        return text === 'token';
      },
      deadlineMs: 100,
      pollIntervalMs: 0,
      wait: async () => undefined,
    });

    expect(interval.probes[0]).toMatchObject({ present: false, error: 'predicate failed' });
    expect(interval.probes.at(-1)).toMatchObject({ present: true });
    expect(seenOptions).toHaveLength(3);
    expect(
      seenOptions.every((entry) => entry.aborted === false && entry.timeoutMs > 0 && Number.isInteger(entry.timeoutMs))
    ).toBe(true);
  });

  it('aborts between non-overlapping probes and waits for the active capture', async () => {
    const controller = new AbortController();
    let active = 0;
    let maxActive = 0;
    const capture = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      controller.abort();
      return 'absent';
    });

    await expect(
      observePaneVisibility({
        capture,
        isPresent: () => false,
        deadlineMs: 100,
        pollIntervalMs: 0,
        signal: controller.signal,
      })
    ).rejects.toThrow(/aborted/i);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('uses one pane capture per tick for every pending cumulative token', async () => {
    const snapshots = ['empty', 'q', 'qz1'];
    const clock = [0n, 2_000_000n, 3_000_000n, 5_000_000n, 7_000_000n, 11_000_000n];
    let active = 0;
    let maxActive = 0;
    const capture = vi.fn(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const snapshot = snapshots.shift() ?? 'qz1';
      active--;
      return snapshot;
    });

    const results = await observePaneVisibilities({
      capture,
      targets: [
        { id: 'q', isPresent: (text) => text === 'q' },
        { id: 'qz', isPresent: (text) => text === 'qz' },
        { id: 'qz1', isPresent: (text) => text === 'qz1' },
      ],
      completionTargetId: 'qz1',
      deadlineMs: 100,
      pollIntervalMs: 0,
      nowNs: () => clock.shift()!,
      wait: async () => undefined,
    });

    expect(capture).toHaveBeenCalledTimes(3);
    expect(maxActive).toBe(1);
    expect(results.map((result) => result.status)).toEqual(['visible', 'incomplete', 'visible']);
    expect(results[0].status === 'visible' ? results[0].interval.probes : []).toHaveLength(2);
    expect(results[1].status === 'incomplete' ? results[1].error.probes : []).toHaveLength(3);
    expect(results[2].status === 'visible' ? results[2].interval.probes : []).toHaveLength(3);
    const secondTickStarts = results.map((result) =>
      result.status === 'visible' ? result.interval.probes[1]?.startedNs : result.error.probes[1]?.startedNs
    );
    expect(secondTickStarts).toEqual([3_000_000n, 3_000_000n, 3_000_000n]);
  });

  it('awaits the shared active pane capture and retains every target probe when aborted', async () => {
    const controller = new AbortController();
    let active = 0;
    const timeouts: number[] = [];
    const capture = vi.fn(async ({ timeoutMs }: { signal?: AbortSignal; timeoutMs: number }) => {
      active++;
      timeouts.push(timeoutMs);
      controller.abort();
      await Promise.resolve();
      active--;
      return 'empty';
    });
    let failure: PaneVisibilitiesObservationError | null = null;

    try {
      await observePaneVisibilities({
        capture,
        targets: [
          { id: 'q', isPresent: () => false },
          { id: 'qz1', isPresent: () => false },
        ],
        completionTargetId: 'qz1',
        deadlineMs: 100,
        pollIntervalMs: 0,
        signal: controller.signal,
      });
    } catch (error) {
      failure = error as PaneVisibilitiesObservationError;
    }

    expect(active).toBe(0);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).toBeGreaterThan(0);
    expect(Number.isInteger(timeouts[0])).toBe(true);
    expect(failure).toMatchObject({
      message: expect.stringMatching(/aborted/i),
      results: [
        { id: 'q', status: 'incomplete', error: { probes: [expect.any(Object)] } },
        { id: 'qz1', status: 'incomplete', error: { probes: [expect.any(Object)] } },
      ],
    });
  });

  it('rejects accepted typing windows containing any browser long-task diagnostic', () => {
    expect(() => requireNoBrowserLongTasks([])).not.toThrow();
    expect(() => requireNoBrowserLongTasks(['[CRASH-DIAG] long task 247ms'])).toThrow(
      /accepted typing window.*long task 247ms/i
    );
  });

  it('rejects incomplete and out-of-order browser traces without publishing raw text', () => {
    const input = BROWSER_INPUT_STAGES.map((stage, index) => ({
      stage,
      atMs: index + 1,
      clock: 'browser' as const,
      clockId: 'page-1',
      trialId: 'trial-1',
      generation: 1,
      inputIndex: 0,
      tokenHash: '0123456789abcdef',
      tokenLength: 4,
      ...(['browser.durable-queued', 'browser.ws-input-send', 'browser.ws-input-send-return'].includes(stage)
        ? { clientId: 'client-1', seq: 7 }
        : stage === 'browser.ws-input-ack'
          ? { clientId: 'client-1', seq: 7 }
          : {}),
    }));
    const output = BROWSER_GLOBAL_OUTPUT_STAGES.map((stage, index) => ({
      stage,
      atMs: input.length + index + 1,
      clock: 'browser' as const,
      clockId: 'page-1',
      trialId: 'trial-1',
      generation: 0,
      inputIndex: 0,
      tokenHash: '0123456789abcdef',
      tokenLength: 4,
      ordinal: 1,
      ...(stage.startsWith('browser.xterm') ? { writeId: 1 } : {}),
      selectedForAttribution: false,
    }));
    const visibility = BROWSER_VISIBILITY_STAGES.map((stage, index) => ({
      stage,
      atMs: input.length + output.length + index + 1,
      clock: 'browser' as const,
      clockId: 'page-1',
      trialId: 'trial-1',
      generation: 1,
      inputIndex: 0,
      tokenHash: '0123456789abcdef',
      tokenLength: 4,
      ordinal: 1,
      writeId: 1,
      selectedForAttribution: true,
    }));
    const complete = [...input, ...output, ...visibility] as BrowserLatencyEvent[];
    expect(validateBrowserLatencyTrace(complete)).toEqual(complete);
    expect(() => validateBrowserLatencyTrace(complete.slice(1))).toThrow(/missing browser stage/i);
    expect(() => validateBrowserLatencyTrace([complete[1], complete[0], ...complete.slice(2)])).toThrow(
      /stage order|non-monotonic/i
    );
    expect(() =>
      validateBrowserLatencyTrace([...complete, { ...complete[0], raw: 'secret' } as BrowserLatencyEvent])
    ).toThrow(/unknown browser trace field/i);
    expect(() =>
      validateBrowserLatencyTrace(
        complete.map((event, index) => (index === 4 ? { ...event, clockId: 'page-2' } : event))
      )
    ).toThrow(/clock identity/i);
    expect(() =>
      validateBrowserLatencyTrace(
        complete.map((event, index) => (index === 4 ? { ...event, trialId: 'trial-2' } : event))
      )
    ).toThrow(/trial identity/i);
  });

  it('validates two complete input generations and rejects duplicates, non-monotonic time, and mixed identity', () => {
    const inputStages = [...BROWSER_INPUT_STAGES, ...BROWSER_VISIBILITY_STAGES];
    const generation = (inputIndex: number, seq: number, offset: number): BrowserLatencyEvent[] =>
      inputStages.map((stage, stageIndex) => ({
        stage,
        atMs: offset + stageIndex,
        clock: 'browser',
        clockId: 'page-1',
        trialId: 'trial-1',
        generation: inputIndex + 1,
        inputIndex,
        tokenHash: inputIndex === 0 ? '0123456789abcdef' : 'fedcba9876543210',
        tokenLength: inputIndex + 1,
        clientId: 'client-1',
        seq,
        selectedForAttribution: true,
        ...(stage === 'browser.ws-output-receive' ||
        stage.startsWith('browser.xterm-write') ||
        stage.includes('parsed') ||
        stage.includes('render')
          ? { writeId: inputIndex + 10, ordinal: inputIndex + 20 }
          : {}),
      }));
    const twoInputs = [...generation(0, 7, 1), ...generation(1, 8, 100)];
    expect(validateBrowserLatencyTrace(twoInputs)).toEqual(twoInputs);
    const duplicateAt = twoInputs.findIndex((event) => event.stage === 'browser.logical');
    const duplicated = [
      ...twoInputs.slice(0, duplicateAt + 1),
      { ...twoInputs[duplicateAt] },
      ...twoInputs.slice(duplicateAt + 1),
    ];
    expect(() => validateBrowserLatencyTrace(duplicated)).toThrow(/duplicate/i);
    expect(() =>
      validateBrowserLatencyTrace(twoInputs.map((event, index) => (index === 2 ? { ...event, atMs: 0 } : event)))
    ).toThrow(/monotonic/i);
    expect(() =>
      validateBrowserLatencyTrace(
        twoInputs.map((event) =>
          event.inputIndex === 1 && event.stage === 'browser.ws-input-send' ? { ...event, seq: 99 } : event
        )
      )
    ).toThrow(/client.*sequence identity/i);
    expect(() =>
      validateBrowserLatencyTrace(
        twoInputs.map((event) =>
          event.inputIndex === 1 && event.stage === 'browser.ws-input-ack' ? { ...event, clientId: undefined } : event
        )
      )
    ).toThrow(/client.*sequence identity/i);
    expect(() =>
      validateBrowserLatencyTrace(
        twoInputs.map((event) =>
          event.inputIndex === 1 && event.stage === 'browser.logical'
            ? { ...event, coalescedIndex: 1, coalescedCount: 2 }
            : event
        )
      )
    ).toThrow(/coalesced input identity/i);
    expect(() =>
      validateBrowserLatencyTrace(
        twoInputs.map((event) => (event.inputIndex === 1 ? { ...event, generation: 1 } : event))
      )
    ).toThrow(/generation.*input identity/i);
    const generationSize = inputStages.length;
    const reorderedGenerations = [...twoInputs.slice(generationSize), ...twoInputs.slice(0, generationSize)].map(
      (event, index) => ({ ...event, atMs: index + 1 })
    );
    expect(() => validateBrowserLatencyTrace(reorderedGenerations)).toThrow(/generation order/i);
    const globalRegression = [
      ...twoInputs,
      {
        ...twoInputs[0],
        stage: 'browser.ws-output-receive' as const,
        ordinal: 999,
        atMs: 0,
        selectedForAttribution: false,
      },
    ];
    expect(() => validateBrowserLatencyTrace(globalRegression)).toThrow(/global.*monotonic/i);
  });

  it('correlates every browser output on the measured input connection without dropping incomplete ordinals', () => {
    const browser = [
      {
        stage: 'browser.ws-output-receive',
        atMs: 1,
        clock: 'browser',
        clockId: 'page-1',
        trialId: 'trial-1',
        generation: 1,
        inputIndex: 0,
        tokenHash: '0123456789abcdef',
        tokenLength: 1,
        ordinal: 1,
        bytes: 3,
        valueHash: 'aaaaaaaaaaaaaaaa',
        selectedForAttribution: false,
      },
      {
        stage: 'browser.ws-output-receive',
        atMs: 2,
        clock: 'browser',
        clockId: 'page-1',
        trialId: 'trial-1',
        generation: 1,
        inputIndex: 0,
        tokenHash: '0123456789abcdef',
        tokenLength: 1,
        ordinal: 2,
        bytes: 4,
        valueHash: 'bbbbbbbbbbbbbbbb',
        selectedForAttribution: true,
      },
    ] as BrowserLatencyEvent[];
    const server = [
      {
        stage: 'server.output.post-send',
        monoNs: '0',
        connectionHash: '1111111111111111',
        ordinal: 39,
        bytes: 3,
        valueHash: 'aaaaaaaaaaaaaaaa',
      },
      {
        stage: 'server.output.post-send',
        monoNs: '0',
        connectionHash: '2222222222222222',
        ordinal: 1,
        bytes: 3,
        valueHash: 'aaaaaaaaaaaaaaaa',
      },
      {
        stage: 'server.input.post-ack',
        monoNs: '1',
        connectionHash: '1111111111111111',
        ordinal: 40,
        clientId: 'client-1',
        seq: 7,
      },
      {
        stage: 'server.output.post-send',
        monoNs: '1',
        connectionHash: '1111111111111111',
        ordinal: 41,
        bytes: 3,
        valueHash: 'aaaaaaaaaaaaaaaa',
      },
      {
        stage: 'server.output.post-send',
        monoNs: '2',
        connectionHash: '1111111111111111',
        ordinal: 42,
        bytes: 4,
        valueHash: 'bbbbbbbbbbbbbbbb',
      },
    ];

    expect(correlateBrowserServerTrace(browser, server, { clientId: 'client-1', seq: 7 })).toEqual([
      expect.objectContaining({ ordinal: 1, serverOrdinal: 41, connectionHash: '1111111111111111' }),
      expect.objectContaining({ ordinal: 2, serverOrdinal: 42, connectionHash: '1111111111111111' }),
    ]);
    expect(() => correlateBrowserServerTrace(browser, server, { clientId: 'client-1', seq: 8 })).toThrow(
      /measured input connection/i
    );
    expect(() =>
      correlateBrowserServerTrace(
        browser,
        [
          ...server.slice(0, 2),
          {
            stage: 'server.output.post-send',
            monoNs: '1',
            connectionHash: '1111111111111111',
            ordinal: 41,
            bytes: 9,
            valueHash: 'cccccccccccccccc',
          },
          ...server.slice(2),
        ],
        { clientId: 'client-1', seq: 7 }
      )
    ).toThrow(/extra|lossless|mismatch/i);
  });

  it('validates the complete ordered server output chain for the measured connection', () => {
    const upstream = ['pty-received', 'handler-enter', 'terminal-emitted'].map((stage, index) => ({
      stage: `server.output.${stage}`,
      monoNs: String(index + 1),
      sessionHash: 'aaaaaaaaaaaaaaaa',
      ordinal: index + 1,
      bytes: 1,
      valueHash: 'bbbbbbbbbbbbbbbb',
    }));
    const connection = ['ws-received', 'batch-enqueued', 'flush-start', 'pre-send', 'post-send'].map(
      (stage, index) => ({
        stage: `server.output.${stage}`,
        monoNs: String(index + 4),
        sessionHash: 'aaaaaaaaaaaaaaaa',
        connectionHash: 'cccccccccccccccc',
        ordinal: index + 10,
        bytes: 1,
        valueHash: 'bbbbbbbbbbbbbbbb',
      })
    );
    expect(validateServerOutputChain([...upstream, ...connection], 'cccccccccccccccc')).toEqual({
      upstreamChunks: 1,
      connectionChunks: 1,
      flushes: 1,
    });
    expect(() =>
      validateServerOutputChain([...upstream, connection[1], connection[0], ...connection.slice(2)], 'cccccccccccccccc')
    ).toThrow(/order/i);
    expect(() =>
      validateServerOutputChain(
        [...upstream, connection[0], { ...connection[1], ordinal: 9 }, ...connection.slice(2)],
        'cccccccccccccccc'
      )
    ).toThrow(/ordinal order/i);
  });

  it('fences paint callbacks to the exact generation, selection, ordinal, and write', () => {
    const fence = createPaintFence();
    const first = fence.select({ generation: 1, inputIndex: 0, ordinal: 4, writeId: 8 });
    expect(fence.isCurrent(first)).toBe(true);
    fence.select({ generation: 1, inputIndex: 0, ordinal: 5, writeId: 9 });
    expect(fence.isCurrent(first)).toBe(false);
    const secondGeneration = fence.select({ generation: 2, inputIndex: 1, ordinal: 6, writeId: 10 });
    expect(fence.isCurrent(secondGeneration)).toBe(true);
  });

  it('keeps immutable write entry/return/callback records and safely correlates a coalesced parse/render', () => {
    const trace = createXtermWriteCorrelator(() => 10);
    const first = trace.enter({ generation: 1, inputIndex: 0, outputOrdinal: 4 });
    const second = trace.enter({ generation: 1, inputIndex: 0, outputOrdinal: 5 });
    trace.returned(first);
    trace.returned(second);
    trace.callback(second);
    trace.callback(first);
    trace.parsed(20);
    trace.rendered(21);

    expect(trace.snapshot()).toEqual([
      { phase: 'entry', writeId: 1, atMs: 10, generation: 1, inputIndex: 0, outputOrdinal: 4 },
      { phase: 'entry', writeId: 2, atMs: 10, generation: 1, inputIndex: 0, outputOrdinal: 5 },
      { phase: 'return', writeId: 1, atMs: 10, generation: 1, inputIndex: 0, outputOrdinal: 4 },
      { phase: 'return', writeId: 2, atMs: 10, generation: 1, inputIndex: 0, outputOrdinal: 5 },
      { phase: 'callback', writeId: 2, atMs: 10, generation: 1, inputIndex: 0, outputOrdinal: 5 },
      { phase: 'callback', writeId: 1, atMs: 10, generation: 1, inputIndex: 0, outputOrdinal: 4 },
      { phase: 'parsed', writeId: 1, atMs: 20, generation: 1, inputIndex: 0, outputOrdinal: 4 },
      { phase: 'parsed', writeId: 2, atMs: 20, generation: 1, inputIndex: 0, outputOrdinal: 5 },
      { phase: 'render', writeId: 2, atMs: 21, generation: 1, inputIndex: 0, outputOrdinal: 5 },
    ]);
    expect(new Set(trace.snapshot().map((event) => event)).size).toBe(trace.snapshot().length);
  });

  it('runs every cleanup step and aggregates failures', async () => {
    const calls: string[] = [];
    await expect(
      runCleanupSteps([
        ['first', async () => calls.push('first')],
        [
          'broken',
          async () => {
            calls.push('broken');
            throw new Error('boom');
          },
        ],
        ['last', async () => calls.push('last')],
      ])
    ).rejects.toThrow(/broken.*boom/i);
    expect(calls).toEqual(['first', 'broken', 'last']);
  });

  it('forbids subtraction across clock domains without bounded calibration', () => {
    expect(
      componentLocalDuration(
        { clock: 'browser', clockId: 'page-1', atMs: 10 },
        { clock: 'browser', clockId: 'page-1', atMs: 14 }
      )
    ).toBe(4);
    expect(() =>
      componentLocalDuration(
        { clock: 'browser', clockId: 'page-1', atMs: 10 },
        { clock: 'browser', clockId: 'page-2', atMs: 14 }
      )
    ).toThrow(/calibration/i);
    expect(() =>
      componentLocalDuration(
        { clock: 'browser', clockId: 'page-1', atMs: 10 },
        { clock: 'server', clockId: 'server-1', atMs: 14 }
      )
    ).toThrow(/calibration/i);
    expect(
      componentLocalDuration(
        { clock: 'browser', clockId: 'page-1', atMs: 10 },
        { clock: 'server', clockId: 'server-1', atMs: 14 },
        { offsetMs: 2, uncertaintyMs: 0.5 }
      )
    ).toEqual({ durationMs: 2, uncertaintyMs: 0.5 });
  });

  it('fails closed when the first successful pane probe is already present', async () => {
    await expect(
      observePaneVisibility({
        capture: async () => 'token',
        isPresent: (text) => text === 'token',
        deadlineMs: 100,
        pollIntervalMs: 0,
      })
    ).rejects.toThrow(/pre-armed/i);
  });

  it('awaits an active capture before rejecting a deadline', async () => {
    let active = 0;
    let failure: unknown;
    try {
      await observePaneVisibility({
        capture: async () => {
          active++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return 'token';
        },
        isPresent: () => true,
        deadlineMs: 1,
        pollIntervalMs: 0,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PaneObservationError);
    expect(failure).toMatchObject({ message: expect.stringMatching(/deadline/i), probes: [expect.any(Object)] });
    expect(active).toBe(0);
  });
});
