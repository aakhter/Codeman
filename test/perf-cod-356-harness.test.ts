import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

import {
  FIXED_INPUT_TRIALS_PER_SAMPLE,
  WorkerCoverageSupervisor,
  aggregateEventLoopIntervals,
  assertComparableInputTrialProfiles,
  authenticateDisposableTarget,
  assertLoadCoverage,
  buildCorrelatedInputTimeline,
  buildInputBoundaryMetrics,
  buildInputTrialProfile,
  createInputTrialPayload,
  createProbeInputEvent,
  calculateProcCpuPercent,
  deriveLoadProfile,
  diffByteSequences,
  formatInputAcknowledgement,
  parseOnlySelection,
  runFixedLoadWindow,
  runFixedInputTrials,
  selectProductionOutputBoundary,
  selectCorrelatedOutputBoundaries,
  selectInteractiveFixture,
  summarizeTmuxTrace,
  summarizeSamples,
  summarizeInputTrialMatrix,
  validateBenchmarkOptions,
} from '../scripts/perf/cod-356-metrics.mjs';
import {
  CleanupRegistry,
  SignalCleanupController,
  validateDisposableTmuxSocket,
  withCleanup,
} from '../scripts/perf/cod-356-cleanup.mjs';
import {
  assertRuntimePackageManifestMatches,
  assertRuntimeTreeMatchesRevision,
  assertGeneratedAssetsStableAtPublication,
  assertGeneratedAssetManifestMatches,
  buildHarnessProvenance,
  collectGeneratedRuntimeAssetManifest,
  compactReportFilenamesForPhase,
  guardGeneratedAssetPublication,
  loadCommittedBaselineAssetManifest,
  parseTrackedStatusPaths,
  resolveRuntimeRevisionPolicy,
  resolveRuntimeRevisionPolicyFromGit,
  validateBenchmarkPhase,
  validatePairedReports,
  verifyPostRunGeneratedAssets,
  writePairedJsonArtifacts,
} from '../scripts/perf/cod-356-provenance.mjs';
import { proveReachedServerOwnership } from '../scripts/perf/cod-356-safety.mjs';
import { runFixedOfferSchedule, summarizeFixedOfferSchedule } from '../scripts/perf/cod-356-scheduler.mjs';
import { assertBrowserSampleClean, prepareInteractiveTargetSession } from '../scripts/perf/cod-356-browser.mjs';

describe('COD-356 benchmark policy', () => {
  const valid = {
    host: '127.0.0.1',
    port: 43123,
    durationMs: 30_000,
    samples: 5,
    conditions: ['idle', 'cpu'],
    applicationConditions: ['idle', 'interactive'],
    workers: 3,
    logicalCpuCount: 8,
  };

  it.each([
    [{ port: 3002 }, 'port 3002'],
    [{ host: '192.168.20.10' }, 'loopback'],
    [{ durationMs: Number.POSITIVE_INFINITY }, 'bounded duration'],
    [{ durationMs: 60_001 }, '60 seconds'],
    [{ samples: 0 }, 'at least one sample'],
    [{ workers: 8 }, 'leave one logical CPU'],
  ])('rejects unsafe options %o', (override, message) => {
    expect(() => validateBenchmarkOptions({ ...valid, ...override })).toThrow(message);
  });

  it.each(['localhost', '127.0.0.1', '::1'])('accepts loopback host %s', (host) => {
    expect(validateBenchmarkOptions({ ...valid, host })).toMatchObject({ host });
  });

  it('accepts only idle/cpu host conditions', () => {
    expect(() => validateBenchmarkOptions({ ...valid, conditions: ['memory'] })).toThrow('host condition');
  });

  it('accepts only idle/interactive application conditions', () => {
    expect(() => validateBenchmarkOptions({ ...valid, applicationConditions: ['batch'] })).toThrow(
      'application condition'
    );
  });

  it('validates and resolves --only measurement restrictions', () => {
    expect(parseOnlySelection(['all'])).toEqual({ input: true, frontend: true, backend: true });
    expect(parseOnlySelection(['input'])).toEqual({ input: true, frontend: false, backend: false });
    expect(parseOnlySelection(['frontend', 'backend'])).toEqual({ input: false, frontend: true, backend: true });
    expect(() => parseOnlySelection(['unknown'])).toThrow('unsupported --only');
    expect(() => parseOnlySelection(['all', 'input'])).toThrow('cannot combine');
  });

  it('requires lowercase benchmark phase labels', () => {
    expect(validateBenchmarkPhase('before')).toBe('before');
    expect(validateBenchmarkPhase('after-poller')).toBe('after-poller');
    expect(() => validateBenchmarkPhase('Before')).toThrow('lowercase');
  });

  it('uses baseline report names only for before and phase-specific names afterward', () => {
    expect(compactReportFilenamesForPhase('before')).toEqual({
      summary: 'baseline-summary.json',
      environment: 'baseline-environment.json',
    });
    expect(compactReportFilenamesForPhase('after-poller')).toEqual({
      summary: 'after-poller-summary.json',
      environment: 'after-poller-environment.json',
    });
  });

  it('rejects a wrong HTTP target that does not issue the nonce-authenticated cookie', async () => {
    const wrongTargetFetch = vi.fn(async () => new Response(JSON.stringify({ sessions: [] }), { status: 200 }));
    await expect(
      authenticateDisposableTarget(wrongTargetFetch, {
        baseUrl: 'http://127.0.0.1:43123',
        username: 'cod356',
        password: 'unpredictable-nonce',
      })
    ).rejects.toThrow('did not issue an authenticated session cookie');
  });

  it('accepts only the HTTP target that authenticates the unpredictable nonce', async () => {
    const fetchTarget = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { 'set-cookie': 'codeman_session=proof-token; Path=/; HttpOnly' },
        })
    );
    await expect(
      authenticateDisposableTarget(fetchTarget, {
        baseUrl: 'http://127.0.0.1:43123',
        username: 'cod356',
        password: 'unpredictable-nonce',
      })
    ).resolves.toMatchObject({ cookie: 'codeman_session=proof-token', payload: { sessions: [] } });
  });
});

describe('COD-356 browser lifecycle safety', () => {
  it('waits for the intermediate interactive WebSocket before switching to the measured target', async () => {
    const calls: string[] = [];
    const page = {
      evaluate: vi.fn(async (_callback, sessionId: string) => calls.push(`select:${sessionId}`)),
      waitForFunction: vi.fn(async (_callback, sessionId: string) => calls.push(`ready:${sessionId}`)),
    };

    await prepareInteractiveTargetSession(page, {
      interactiveSessionId: 'interactive-fixture',
      targetSessionId: 'measured-target',
    });

    expect(calls).toEqual([
      'select:interactive-fixture',
      'ready:interactive-fixture',
      'select:measured-target',
      'ready:measured-target',
    ]);
  });

  it('fails a sample on every page error or serious console error without filtering it', () => {
    expect(() => assertBrowserSampleClean({ pageErrors: [], seriousConsoleErrors: [] })).not.toThrow();
    expect(() =>
      assertBrowserSampleClean({
        pageErrors: [],
        seriousConsoleErrors: ['warning: WebSocket is closed before the connection is established'],
      })
    ).toThrow('serious browser console error');
    expect(() =>
      assertBrowserSampleClean({ pageErrors: ['uncaught browser failure'], seriousConsoleErrors: [] })
    ).toThrow('browser page error');
  });
});

describe('COD-356 benchmark statistics', () => {
  const exactTrial = (sampleIndex: number, trialIndex: number, convergenceMs: number) => {
    const payload = Buffer.from(`sample-${sampleIndex}-trial-${trialIndex}`);
    return {
      sampleIndex,
      trialIndex,
      inputSendMs: convergenceMs / 10,
      browserAckMs: convergenceMs / 5,
      probeReceiptMs: convergenceMs / 4,
      convergenceMs,
      settleWindowMs: 500,
      expectedBase64: payload.toString('base64'),
      receivedBase64: payload.toString('base64'),
      expectedBytes: payload.length,
      receivedBytes: payload.length,
      duplicateCount: 0,
      missingCount: 0,
      reorderedCount: 0,
      mismatchIndexes: [],
      exact: true,
    };
  };

  it('uses a fixed five-by-eight trial protocol with a reproducible compatibility hash', () => {
    const baseline = buildInputTrialProfile({ sampleCount: 5 });
    const comparison = buildInputTrialProfile({ sampleCount: 5 });
    expect(FIXED_INPUT_TRIALS_PER_SAMPLE).toBe(8);
    expect(baseline).toMatchObject({
      schemaVersion: 1,
      sampleCount: 5,
      trialsPerSample: 8,
      totalRecordedTrials: 40,
      sequential: true,
      adaptive: false,
      payloadSchedule: 'cod356-input-v2/sample-{sampleIndex}/trial-{trialIndex}',
      settleWindowMs: 500,
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      cpuDeadlineBudget: {
        fixedWindowMs: 60_000,
        evidenceBaseCellMs: 24_000,
        perAdditionalTrialBudgetMs: 750,
        projectedCellMs: 55_500,
        marginMs: 4_500,
      },
    });
    expect(assertComparableInputTrialProfiles({ baseline, comparison })).toBe(true);
    expect(() =>
      assertComparableInputTrialProfiles({ baseline, comparison: buildInputTrialProfile({ sampleCount: 4 }) })
    ).toThrow('input trial profile does not match accepted baseline');
    expect(() => buildInputTrialProfile({ sampleCount: 6 })).toThrow('60-second CPU load deadline budget');
  });

  it('uses deterministic unique framed payloads and records both monotonic and epoch probe receipt clocks', () => {
    expect(createInputTrialPayload({ sampleIndex: 3, trialIndex: 7 })).toBe('cod356:sample-3:trial-7:aaabbb111___');
    expect(createInputTrialPayload({ sampleIndex: 'warmup', trialIndex: 1 })).toBe(
      'cod356:sample-warmup:trial-1:aaabbb111___'
    );
    const bytes = Buffer.from('abc');
    expect(createProbeInputEvent({ id: 4, monotonicNs: '9000', epochMs: 1_700_000_000_123, bytes })).toEqual({
      type: 'stdin',
      id: 4,
      timestampNs: '9000',
      timestampEpochMs: 1_700_000_000_123,
      base64: 'YWJj',
      byteLength: 3,
    });
  });

  it('reports a pooled empirical p95 that is not the maximum and exposes sample clustering', () => {
    const trialsBySample = Array.from({ length: 5 }, (_, sample) =>
      Array.from({ length: 8 }, (_, trial) => exactTrial(sample + 1, trial + 1, sample * 8 + trial + 1))
    );
    const summary = summarizeInputTrialMatrix(trialsBySample);
    expect(summary).toMatchObject({
      semantics: 'empirical user-interaction distribution clustered within five independent browser samples',
      sampleCount: 5,
      trialsPerSample: 8,
      totalTrials: 40,
      quantileDesign: {
        estimator: 'nearest-rank',
        p95Rank: 38,
        observationsAboveP95Rank: 2,
        p95IsMaximum: false,
        noDeletionOrWinsorization: true,
      },
      convergenceMs: {
        pooled: expect.objectContaining({ count: 40, p95: 38, p99: 40, max: 40 }),
        perSample: expect.arrayContaining([
          expect.objectContaining({ sampleIndex: 1, median: 4.5, p95: 8, max: 8 }),
          expect.objectContaining({ sampleIndex: 5, median: 36.5, p95: 40, max: 40 }),
        ]),
      },
    });
    expect(summary.convergenceMs.pooled.samples).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
  });

  it('rejects incomplete, duplicated, or byte-inexact input trials instead of reducing the population', () => {
    const complete = Array.from({ length: 5 }, (_, sample) =>
      Array.from({ length: 8 }, (_, trial) => exactTrial(sample + 1, trial + 1, 10))
    );
    expect(() => summarizeInputTrialMatrix(complete.map((sample) => sample.slice(0, 7)))).toThrow(
      'exactly 8 input trials'
    );
    const duplicated = structuredClone(complete);
    duplicated[0][1].expectedBase64 = duplicated[0][0].expectedBase64;
    duplicated[0][1].receivedBase64 = duplicated[0][0].receivedBase64;
    expect(() => summarizeInputTrialMatrix(duplicated)).toThrow('unique framed payload');
    const inexact = structuredClone(complete);
    inexact[2][3].duplicateCount = 1;
    inexact[2][3].exact = false;
    expect(() => summarizeInputTrialMatrix(inexact)).toThrow('byte identity');
  });

  it('runs exactly eight sequential trials and fails closed without adapting at a deadline', async () => {
    const order: number[] = [];
    await expect(
      runFixedInputTrials({
        trialCount: FIXED_INPUT_TRIALS_PER_SAMPLE,
        runTrial: async (trialIndex) => {
          order.push(trialIndex);
          if (trialIndex === 6) throw new Error('CPU samples exceeded the approved 60-second load deadline');
          return trialIndex;
        },
      })
    ).rejects.toThrow('60-second load deadline');
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('maps input, flush, probe, and long-task boundaries onto coherent browser and epoch clocks', () => {
    expect(
      buildCorrelatedInputTimeline({
        pageTimeOriginMs: 1_700_000_000_000,
        sentFrameBrowserMs: 100,
        ackBrowserMs: 110,
        probeEpochMs: 1_700_000_000_115,
        probeMonotonicNs: '9000000',
        frameMatchBrowserMs: 125,
        flushStartBrowserMs: 130,
        flushEndBrowserMs: 132,
        visibleDetectedBrowserMs: 140,
        xtermDrainBrowserMs: 145,
        settleCompleteBrowserMs: 650,
        longTasks: [{ startTime: 120, duration: 30 }],
      })
    ).toEqual({
      clockMapping: { pageTimeOriginEpochMs: 1_700_000_000_000 },
      send: { browserMs: 100, epochMs: 1_700_000_000_100 },
      ack: { browserMs: 110, epochMs: 1_700_000_000_110 },
      probeReceipt: { epochMs: 1_700_000_000_115, monotonicNs: '9000000' },
      frameMatch: { browserMs: 125, epochMs: 1_700_000_000_125 },
      flushStart: { browserMs: 130, epochMs: 1_700_000_000_130 },
      flushEnd: { browserMs: 132, epochMs: 1_700_000_000_132 },
      firstVisibleObservation: { browserMs: 140, epochMs: 1_700_000_000_140 },
      xtermDrain: { browserMs: 145, epochMs: 1_700_000_000_145 },
      settleAndResetComplete: { browserMs: 650, epochMs: 1_700_000_000_650 },
      longTasks: [
        {
          startBrowserMs: 120,
          endBrowserMs: 150,
          startEpochMs: 1_700_000_000_120,
          endEpochMs: 1_700_000_000_150,
          durationMs: 30,
        },
      ],
    });
  });

  it('defines convergence at first visible observation and never substitutes a later drain callback', () => {
    expect(
      buildInputBoundaryMetrics({
        sendAt: 100,
        terminalReceiptAt: 120,
        flushStartedAt: 125,
        flushCompletedAt: 127,
        visibleDetectedAt: 135,
        xtermDrainAt: 180,
      })
    ).toEqual({
      convergenceMs: 35,
      receiptToFlushStartMs: 5,
      flushDurationMs: 2,
      flushEndToFirstVisibleMs: 8,
      firstVisibleToDrainMs: 45,
    });
  });

  it('rejects a first-visible observation before the production flush begins', () => {
    expect(() =>
      buildInputBoundaryMetrics({
        sendAt: 100,
        terminalReceiptAt: 120,
        flushStartedAt: 125,
        flushCompletedAt: 140,
        visibleDetectedAt: 124,
        xtermDrainAt: 150,
      })
    ).toThrow('visible observation preceded production flush start');
  });

  it('uses the matching real terminal write when output bypasses the pending-write flush', () => {
    expect(
      selectProductionOutputBoundary({
        matchingWrite: { flushId: null, startedAt: 130, completedAt: 131, drainedAt: 132 },
        flushCalls: [],
      })
    ).toEqual({
      id: null,
      source: 'direct-terminal-write',
      startedAt: 130,
      completedAt: 131,
      durationMs: 1,
    });
  });

  it('uses the owning pending-write flush when the matching terminal write has a flush id', () => {
    expect(
      selectProductionOutputBoundary({
        matchingWrite: { flushId: 7, startedAt: 130, completedAt: 131, drainedAt: 132 },
        flushCalls: [{ id: 7, startedAt: 125, completedAt: 133, durationMs: 8 }],
      })
    ).toEqual({ id: 7, source: 'flushPendingWrites', startedAt: 125, completedAt: 133, durationMs: 8 });
  });

  it('selects exact current-token output boundaries amid adjacent terminal traffic', () => {
    expect(
      selectCorrelatedOutputBoundaries({
        token: 'COD356_ECHO:current',
        writes: [
          { startedAt: 10, correlationTokens: ['COD356_ECHO:current'] },
          { startedAt: 11, correlationTokens: ['COD356_ECHO:adjacent'] },
        ],
        outputFrames: [
          { timestamp: 8, correlationTokens: ['COD356_ECHO:current'] },
          { timestamp: 9, correlationTokens: ['COD356_ECHO:adjacent'] },
        ],
        terminalReceipts: [
          { startedAt: 8.5, correlationTokens: ['COD356_ECHO:current'] },
          { startedAt: 9.5, correlationTokens: ['COD356_ECHO:adjacent'] },
        ],
      })
    ).toEqual({
      matchingWrite: { startedAt: 10, correlationTokens: ['COD356_ECHO:current'] },
      matchingOutput: { timestamp: 8, correlationTokens: ['COD356_ECHO:current'] },
      terminalReceipt: { startedAt: 8.5, correlationTokens: ['COD356_ECHO:current'] },
    });
  });

  it('rejects missing exact current-token output boundaries instead of falling back', () => {
    expect(() =>
      selectCorrelatedOutputBoundaries({
        token: 'COD356_ECHO:current',
        writes: [{ startedAt: 10, correlationTokens: ['COD356_ECHO:adjacent'] }],
        outputFrames: [{ timestamp: 8, correlationTokens: ['COD356_ECHO:adjacent'] }],
        terminalReceipts: [{ startedAt: 8.5, correlationTokens: ['COD356_ECHO:adjacent'] }],
      })
    ).toThrow('exact current-token terminal write unavailable');
  });

  it.each(['idle', 'interactive'])(
    'runs the cpu-%s warmup and five samples under one fixed load window',
    async (applicationCondition) => {
      const events: string[] = [];
      const supervisor = {
        start: vi.fn(() => {
          events.push('start');
          return { startedAtMs: 0, deadlineAtMs: 60_000, durationMs: 60_000 };
        }),
        runWithinDeadline: vi.fn(async (operation: () => Promise<unknown>) => {
          events.push('deadline');
          return operation();
        }),
        stop: vi.fn(() => events.push('stop')),
      };
      const result = await runFixedLoadWindow({
        supervisor,
        samples: 5,
        runSample: async (sampleIndex) => {
          events.push(`run:${applicationCondition}:${sampleIndex}`);
          return {
            sampleIndex,
            loadCoverage: { expectedWorkers: 2, minimumActiveWorkers: 2, covered: true },
          };
        },
      });

      expect(events).toEqual([
        'start',
        'deadline',
        `run:${applicationCondition}:warmup`,
        'deadline',
        `run:${applicationCondition}:1`,
        'deadline',
        `run:${applicationCondition}:2`,
        'deadline',
        `run:${applicationCondition}:3`,
        'deadline',
        `run:${applicationCondition}:4`,
        'deadline',
        `run:${applicationCondition}:5`,
        'stop',
      ]);
      expect(supervisor.start).toHaveBeenCalledTimes(1);
      expect(supervisor.runWithinDeadline).toHaveBeenCalledTimes(6);
      expect(result.warmup.loadCoverage.covered).toBe(true);
      expect(result.recorded).toHaveLength(5);
    }
  );

  it('fails the CPU cell when warmup lacks full worker coverage', async () => {
    const supervisor = {
      start: vi.fn(),
      runWithinDeadline: vi.fn(async (operation: () => Promise<unknown>) => operation()),
      stop: vi.fn(),
    };
    await expect(
      runFixedLoadWindow({
        supervisor,
        samples: 5,
        runSample: async () => ({
          loadCoverage: { expectedWorkers: 2, minimumActiveWorkers: 1, covered: false },
        }),
      })
    ).rejects.toThrow('CPU load coverage');
    expect(supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it('distributes one distinct interactive fixture switch across each of five recorded samples', () => {
    const sessionIds = ['target', 'one', 'two', 'three', 'four', 'five'];
    expect([1, 2, 3, 4, 5].map((sampleIndex) => selectInteractiveFixture(sessionIds, sampleIndex))).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five',
    ]);
  });

  it('frames input acknowledgements around the exact received bytes', () => {
    expect(formatInputAcknowledgement({ id: 3, timestampNs: '42', bytes: Buffer.from('aaabbb111___') })).toBe(
      '\r\nCOD356_ACK:3:42:YWFhYmJiMTExX19f\r\n› '
    );
  });

  it('calculates deterministic nearest-rank summary statistics', () => {
    expect(summarizeSamples([100, 1, 9, 5, 3, 7, 2, 8, 4, 6])).toEqual({
      samples: [100, 1, 9, 5, 3, 7, 2, 8, 4, 6],
      count: 10,
      sampleCount: 10,
      percentileEstimator: 'nearest-rank',
      min: 1,
      median: 5.5,
      p95: 100,
      p99: 100,
      max: 100,
      presentation: { min: 1, median: 5.5, p95: 100, p99: 100, max: 100 },
    });
  });

  it('rounds presentation statistics without changing raw samples', () => {
    const summary = summarizeSamples([1.234_567_89, 2.345_678_91, 9.876_543_21]);
    expect(summary.samples).toEqual([1.234_567_89, 2.345_678_91, 9.876_543_21]);
    expect(summary.median).toBe(2.345_678_91);
    expect(summary.presentation.median).toBe(2.346);
  });

  it('uses measured elapsed time and detected clock ticks for proc CPU fallback', () => {
    expect(
      calculateProcCpuPercent({ beforeTicks: 100, afterTicks: 150, elapsedMs: 2_000, clockTicksPerSecond: 100 })
    ).toEqual({ value: 25, reason: null });
    expect(
      calculateProcCpuPercent({ beforeTicks: 100, afterTicks: 150, elapsedMs: 2_000, clockTicksPerSecond: null })
    ).toEqual({ value: null, reason: 'clock ticks per second unavailable' });
  });

  it('preserves raw samples without exposing mutable caller state', () => {
    const raw = [2, 1, 3];
    const summary = summarizeSamples(raw);
    raw.push(999);
    expect(summary.samples).toEqual([2, 1, 3]);
  });

  it.each([
    ['duplicate', 'abc', 'abbc', { duplicateCount: 1, missingCount: 0, reorderedCount: 0 }],
    ['missing', 'abc', 'ac', { duplicateCount: 0, missingCount: 1, reorderedCount: 0 }],
    ['reordered', 'abc', 'bac', { duplicateCount: 0, missingCount: 0, reorderedCount: 1 }],
    ['mixed', 'abca', 'baacx', { duplicateCount: 1, missingCount: 0, reorderedCount: 2 }],
  ])('classifies exact %s byte-sequence differences', (_name, expected, received, counts) => {
    expect(diffByteSequences(Buffer.from(expected), Buffer.from(received))).toMatchObject({
      ...counts,
      expectedBase64: Buffer.from(expected).toString('base64'),
      receivedBase64: Buffer.from(received).toString('base64'),
    });
  });

  it('aggregates monitorEventLoopDelay interval fields without relabeling maxima as histogram quantiles', () => {
    expect(
      aggregateEventLoopIntervals([
        { medianMs: 2, p95Ms: 8, p99Ms: 9, maxMs: 10 },
        { medianMs: 4, p95Ms: 16, p99Ms: 18, maxMs: 20 },
      ])
    ).toEqual({
      semantics: 'distribution of per-interval monitorEventLoopDelay fields',
      intervalCount: 2,
      intervalMedianMs: expect.objectContaining({ samples: [2, 4], median: 3 }),
      intervalP95Ms: expect.objectContaining({ samples: [8, 16], median: 12 }),
      intervalP99Ms: expect.objectContaining({ samples: [9, 18], median: 13.5 }),
      intervalMaxMs: expect.objectContaining({ samples: [10, 20], median: 15 }),
    });
  });

  it('summarizes truthful tmux wrapper status, duration, overlap, and failures', () => {
    expect(
      summarizeTmuxTrace([
        { type: 'start', invocationId: 'a', timestampNs: '1000000', command: 'capture-pane' },
        { type: 'start', invocationId: 'c', timestampNs: '1500000', command: 'other' },
        { type: 'start', invocationId: 'b', timestampNs: '2000000', command: 'capture-pane' },
        { type: 'end', invocationId: 'c', timestampNs: '2500000', status: 0 },
        { type: 'end', invocationId: 'a', timestampNs: '4000000', status: 0 },
        { type: 'end', invocationId: 'b', timestampNs: '6000000', status: 1 },
      ])
    ).toMatchObject({
      available: true,
      subprocessCount: 2,
      maxOverlap: 2,
      failures: 1,
      incomplete: 0,
      durationsMs: [3, 4],
      captures: [
        {
          invocationId: 'a',
          startTimestampNs: '1000000',
          endTimestampNs: '4000000',
          durationMs: 3,
          status: 0,
        },
        {
          invocationId: 'b',
          startTimestampNs: '2000000',
          endTimestampNs: '6000000',
          durationMs: 4,
          status: 1,
        },
      ],
      wrapperInvocations: [
        {
          invocationId: 'a',
          command: 'capture-pane',
          startTimestampNs: '1000000',
          endTimestampNs: '4000000',
          durationMs: 3,
          status: 0,
        },
        {
          invocationId: 'c',
          command: 'other',
          startTimestampNs: '1500000',
          endTimestampNs: '2500000',
          durationMs: 1,
          status: 0,
        },
        {
          invocationId: 'b',
          command: 'capture-pane',
          startTimestampNs: '2000000',
          endTimestampNs: '6000000',
          durationMs: 4,
          status: 1,
        },
      ],
    });
    expect(summarizeTmuxTrace([])).toEqual({
      available: false,
      reason: 'no tmux wrapper events observed',
      subprocessCount: null,
      maxOverlap: null,
      failures: null,
      incomplete: null,
      durationsMs: [],
      captures: [],
      wrapperInvocations: [],
    });
  });

  it('fails samples without full declared CPU-worker coverage', () => {
    expect(() => assertLoadCoverage({ expectedWorkers: 7, minimumActiveWorkers: 6 })).toThrow('CPU load coverage');
    expect(assertLoadCoverage({ expectedWorkers: 7, minimumActiveWorkers: 7 })).toBe(true);
  });

  it('does not replace a bounded worker that exits before the load deadline', () => {
    let nextPid = 5000;
    const created: Array<
      EventEmitter & {
        pid: number;
        exitCode: number | null;
        connected: boolean;
        kill: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
      }
    > = [];
    const registry = { registerChild: vi.fn((child) => child) };
    const supervisor = new WorkerCoverageSupervisor({
      expectedWorkers: 2,
      registry,
      signal: new AbortController().signal,
      createWorker: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: nextPid++,
          exitCode: null as number | null,
          connected: true,
          kill: vi.fn(),
          disconnect: vi.fn(),
        });
        created.push(child);
        return child;
      },
    });
    supervisor.start();
    const marker = supervisor.beginSample();

    created[0].exitCode = 0;
    created[0].emit('exit', 0);

    expect(() => supervisor.endSample(marker)).toThrow('CPU load coverage');
    supervisor.stop();
    expect(created).toHaveLength(2);
  });

  it('covers five recorded samples with the same workers inside one 60-second window', () => {
    let nowMs = 0;
    let nextPid = 6000;
    const created: Array<
      EventEmitter & {
        pid: number;
        exitCode: null;
        connected: boolean;
        kill: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
      }
    > = [];
    const supervisor = new WorkerCoverageSupervisor({
      expectedWorkers: 2,
      durationMs: 60_000,
      now: () => nowMs,
      registry: { registerChild: vi.fn((child) => child) },
      signal: new AbortController().signal,
      createWorker: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: nextPid++,
          exitCode: null,
          connected: true,
          kill: vi.fn(),
          disconnect: vi.fn(),
        });
        created.push(child);
        return child;
      },
    });

    expect(supervisor.start()).toEqual({ startedAtMs: 0, deadlineAtMs: 60_000, durationMs: 60_000 });
    for (let sample = 0; sample < 5; sample++) {
      const marker = supervisor.beginSample();
      nowMs += 11_000;
      expect(supervisor.endSample(marker)).toMatchObject({ minimumActiveWorkers: 2, covered: true });
    }
    supervisor.stop();
    expect(created).toHaveLength(2);
  });

  it('fails at the hard load deadline without extending or replacing workers for extra samples', () => {
    let nowMs = 10_000;
    const created: Array<
      EventEmitter & {
        pid: number;
        exitCode: null;
        connected: boolean;
        kill: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
      }
    > = [];
    const supervisor = new WorkerCoverageSupervisor({
      expectedWorkers: 1,
      durationMs: 60_000,
      now: () => nowMs,
      registry: { registerChild: vi.fn((child) => child) },
      signal: new AbortController().signal,
      createWorker: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: 7000,
          exitCode: null,
          connected: true,
          kill: vi.fn(),
          disconnect: vi.fn(),
        });
        created.push(child);
        return child;
      },
    });

    const window = supervisor.start();
    nowMs = 70_001;
    expect(() => supervisor.beginSample()).toThrow('60-second load deadline');
    expect(window.deadlineAtMs).toBe(70_000);
    expect(created).toHaveLength(1);
    supervisor.stop();
  });

  it('rejects supervisor re-entry without replacing its cohort or deadline', () => {
    let nowMs = 1_000;
    let nextPid = 8000;
    const created: Array<
      EventEmitter & {
        pid: number;
        exitCode: null;
        connected: boolean;
        kill: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
      }
    > = [];
    const supervisor = new WorkerCoverageSupervisor({
      expectedWorkers: 2,
      durationMs: 60_000,
      now: () => nowMs,
      registry: { registerChild: vi.fn((child) => child) },
      signal: new AbortController().signal,
      createWorker: () => {
        const child = Object.assign(new EventEmitter(), {
          pid: nextPid++,
          exitCode: null,
          connected: true,
          kill: vi.fn(),
          disconnect: vi.fn(),
        });
        created.push(child);
        return child;
      },
    });
    const originalWindow = supervisor.start();
    nowMs = 5_000;
    expect(() => supervisor.start()).toThrow('already started');
    expect(supervisor.loadWindow()).toEqual(originalWindow);
    expect(created).toHaveLength(2);
    supervisor.stop();
  });

  it('derives a bounded default CPU load profile', () => {
    expect(deriveLoadProfile({ logicalCpuCount: 8 })).toEqual({
      workers: 7,
      dutyCycle: 0.7,
      durationMs: 60_000,
      busyIntervalMs: 70,
      idleIntervalMs: 30,
    });
    expect(deriveLoadProfile({ logicalCpuCount: 64 }).workers).toBeLessThanOrEqual(63);
    expect(deriveLoadProfile({ logicalCpuCount: 1 }).workers).toBe(0);
  });
});

describe('COD-356 benchmark provenance', () => {
  const branchPointRevision = 'a445cdaf645309ce51d8b1431733afa8f0bc55ac';
  const postChangeRevision = '4a149c42af57e1c473ab196b1a39efd0f1a7d52d';

  const resolvePolicy = (phase: string, requestedRevision?: string, overrides = {}) =>
    resolveRuntimeRevisionPolicy({
      phase,
      requestedRevision,
      branchPointRevision,
      headRevision: postChangeRevision,
      resolveCommit: async (revision: string) => revision,
      isAncestor: async () => true,
      ...overrides,
    });

  it('pins before runs to the implicit or explicit immutable branch point', async () => {
    await expect(resolvePolicy('before')).resolves.toMatchObject({
      runtimeRevision: branchPointRevision,
      explicit: false,
    });
    await expect(resolvePolicy('before', branchPointRevision)).resolves.toMatchObject({
      runtimeRevision: branchPointRevision,
      explicit: true,
    });
    await expect(resolvePolicy('before', postChangeRevision)).rejects.toThrow('before phase');
  });

  it('requires an explicit full resolvable revision for post-change phases', async () => {
    await expect(resolvePolicy('after-poller')).rejects.toThrow('requires --runtime-revision');
    await expect(resolvePolicy('after-poller', '4a149c42')).rejects.toThrow('full 40-character');
    await expect(
      resolvePolicy('after-poller', 'f'.repeat(40), {
        resolveCommit: async () => {
          throw new Error('unknown revision');
        },
      })
    ).rejects.toThrow('unknown runtime revision');
  });

  it('rejects a --runtime-revision flag without a value instead of treating it as implicit before', () => {
    expect(() =>
      execFileSync(process.execPath, ['scripts/perf/cod-356-benchmark.mjs', '--dry-run', '--runtime-revision'], {
        cwd: process.cwd(),
        stdio: 'pipe',
      })
    ).toThrow();
  });

  it('rejects post-change revisions outside the branch-point-to-HEAD ancestry', async () => {
    await expect(resolvePolicy('after-poller', branchPointRevision)).rejects.toThrow('strict descendant');
    await expect(
      resolvePolicy('after-poller', postChangeRevision, {
        isAncestor: async (ancestor: string) => ancestor !== branchPointRevision,
      })
    ).rejects.toThrow('descendant of branch point');
    await expect(
      resolvePolicy('after-poller', postChangeRevision, {
        isAncestor: async (ancestor: string) => ancestor === branchPointRevision,
      })
    ).rejects.toThrow('reachable from current HEAD');
  });

  it('accepts a clean explicit post-change revision with both ancestry proofs', async () => {
    await expect(resolvePolicy('after-poller', postChangeRevision)).resolves.toEqual({
      runtimeRevision: postChangeRevision,
      explicit: true,
      comparisonBaselineRevision: branchPointRevision,
      headRevision: postChangeRevision,
    });
  });

  it('exercises revision policy against real Git ancestry and object resolution', async () => {
    const repository = await mkdtemp(join(tmpdir(), 'cod356-revision-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'COD-356',
          GIT_AUTHOR_EMAIL: 'cod356@example.invalid',
          GIT_COMMITTER_NAME: 'COD-356',
          GIT_COMMITTER_EMAIL: 'cod356@example.invalid',
        },
      }).trim();
    try {
      git('init', '-q');
      await writeFile(join(repository, 'runtime.txt'), 'before\n');
      git('add', 'runtime.txt');
      git('commit', '-qm', 'before');
      const before = git('rev-parse', 'HEAD');
      await writeFile(join(repository, 'runtime.txt'), 'after\n');
      git('commit', '-qam', 'after');
      const after = git('rev-parse', 'HEAD');
      const unrelated = git('commit-tree', `${after}^{tree}`, '-m', 'unrelated');

      await expect(
        resolveRuntimeRevisionPolicyFromGit({
          root: repository,
          phase: 'after-poller',
          requestedRevision: after,
          branchPointRevision: before,
        })
      ).resolves.toMatchObject({ runtimeRevision: after });
      await expect(
        resolveRuntimeRevisionPolicyFromGit({
          root: repository,
          phase: 'after-poller',
          requestedRevision: before,
          branchPointRevision: before,
        })
      ).rejects.toThrow('strict descendant');
      await expect(
        resolveRuntimeRevisionPolicyFromGit({
          root: repository,
          phase: 'after-poller',
          requestedRevision: unrelated,
          branchPointRevision: before,
        })
      ).rejects.toThrow('descendant');
      await expect(
        resolveRuntimeRevisionPolicyFromGit({
          root: repository,
          phase: 'after-poller',
          requestedRevision: after.slice(0, 8),
          branchPointRevision: before,
        })
      ).rejects.toThrow('full 40-character');
      await expect(
        resolveRuntimeRevisionPolicyFromGit({
          root: repository,
          phase: 'after-poller',
          requestedRevision: 'f'.repeat(40),
          branchPointRevision: before,
        })
      ).rejects.toThrow('unknown runtime revision');
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it('parses leading-space and renamed porcelain paths without corrupting provenance', () => {
    expect(
      parseTrackedStatusPaths(
        ' M scripts/perf/cod-356-benchmark.mjs\nM  package.json\nR  old-name.mjs -> scripts/perf/new-name.mjs\n'
      )
    ).toEqual(['scripts/perf/cod-356-benchmark.mjs', 'package.json', 'scripts/perf/new-name.mjs']);
  });

  it('records dirty harness content independently from informational HEAD', () => {
    const inputs = {
      branchPointRevision,
      runtimeRevision: postChangeRevision,
      headRevision: 'deadbeef',
      runtimeTreeHash: 'runtime-tree-hash',
      harnessFiles: [
        { path: 'scripts/perf/cod-356-benchmark.mjs', content: 'dirty working tree content' },
        { path: 'package.json', content: '{"scripts":{"perf:cod356":"node benchmark"}}' },
      ],
      dirtyHarnessPaths: ['scripts/perf/cod-356-benchmark.mjs'],
      dirtyTrackedPaths: ['src/outside-task.ts'],
      ownedPaths: ['scripts/perf/cod-356-benchmark.mjs', 'package.json'],
    };
    const first = buildHarnessProvenance(inputs);
    const changedContent = buildHarnessProvenance({
      ...inputs,
      harnessFiles: [{ path: 'scripts/perf/cod-356-benchmark.mjs', content: 'different content' }],
    });

    expect(first).toMatchObject({
      runtimeRevision: postChangeRevision,
      branchPointRevision,
      comparisonBaselineRevision: branchPointRevision,
      headRevision: {
        value: 'deadbeef',
        semantics: 'informational only; not the measured runtime or harness identity',
      },
      runtimeTreeHash: 'runtime-tree-hash',
      harness: { dirty: true, dirtyPaths: ['scripts/perf/cod-356-benchmark.mjs'] },
      outOfScopeTrackedDirtyPaths: ['src/outside-task.ts'],
    });
    expect(first.harness.contentHash).not.toBe(changedContent.harness.contentHash);
  });

  it('rejects a runtime tree that differs from the declared runtime revision', () => {
    expect(() =>
      assertRuntimeTreeMatchesRevision({
        runtimeRevision: postChangeRevision,
        changedPaths: ['src/index.ts'],
        untrackedPaths: [],
      })
    ).toThrow('runtime tree does not match declared revision');
    expect(
      assertRuntimeTreeMatchesRevision({
        runtimeRevision: postChangeRevision,
        changedPaths: [],
        untrackedPaths: [],
      })
    ).toBe(true);
  });

  it('compares the package manifest to the declared runtime revision and permits only the harness script', () => {
    const revisionContent = JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { fastify: '5.0.0' } });
    const harness = JSON.stringify({
      scripts: { test: 'vitest', 'perf:cod356': 'node scripts/perf/cod-356-benchmark.mjs' },
      dependencies: { fastify: '5.0.0' },
    });
    expect(
      assertRuntimePackageManifestMatches({
        declaredRevision: postChangeRevision,
        revisionContent,
        actualContent: harness,
      })
    ).toEqual({
      allowedDifference: 'scripts.perf:cod356 only',
      comparedToRevision: postChangeRevision,
      normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() =>
      assertRuntimePackageManifestMatches({
        declaredRevision: postChangeRevision,
        revisionContent,
        actualContent: JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { fastify: '6.0.0' } }),
      })
    ).toThrow('runtime package manifest does not match declared revision');
  });
});

describe('COD-356 ignored generated runtime assets', () => {
  const requiredAssets = ['vendor/critical.js'];
  const monitoredDirectories = ['vendor'];
  const allowedFiles = ['vendor/critical.js', 'vendor/document-preview.js'];

  async function fixture() {
    const repositoryRoot = await mkdtemp(join(tmpdir(), 'cod356-assets-'));
    const runtimeRoot = join(repositoryRoot, 'runtime');
    await mkdir(join(runtimeRoot, 'vendor'), { recursive: true });
    await writeFile(join(runtimeRoot, 'vendor/critical.js'), 'critical-v1');
    await writeFile(join(runtimeRoot, 'vendor/document-preview.js'), 'not loaded during startup');
    return { repositoryRoot, runtimeRoot };
  }

  const collect = ({ repositoryRoot, runtimeRoot }: Awaited<ReturnType<typeof fixture>>) =>
    collectGeneratedRuntimeAssetManifest({
      repositoryRoot,
      runtimeRoot,
      requiredAssets,
      monitoredDirectories,
      allowedFiles,
    });

  it('accepts and compares an exact regular-file manifest', async () => {
    const assetFixture = await fixture();
    try {
      const accepted = await collect(assetFixture);
      expect(accepted.runtimeRoot).toBe('runtime');
      expect(accepted.files).toEqual([
        {
          path: 'vendor/critical.js',
          bytes: 11,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
      expect(assertGeneratedAssetManifestMatches({ accepted, actual: await collect(assetFixture) })).toBe(true);
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('rejects byte changes and missing required assets', async () => {
    const assetFixture = await fixture();
    try {
      const accepted = await collect(assetFixture);
      await writeFile(join(assetFixture.runtimeRoot, 'vendor/critical.js'), 'critical-v2');
      await expect(
        Promise.resolve().then(async () =>
          assertGeneratedAssetManifestMatches({ accepted, actual: await collect(assetFixture) })
        )
      ).rejects.toThrow('does not match accepted baseline');
      await unlink(join(assetFixture.runtimeRoot, 'vendor/critical.js'));
      await expect(collect(assetFixture)).rejects.toThrow('missing required generated runtime asset');
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('rejects unexpected files in monitored directories', async () => {
    const assetFixture = await fixture();
    try {
      await writeFile(join(assetFixture.runtimeRoot, 'vendor/unexpected.js'), 'surprise');
      await expect(collect(assetFixture)).rejects.toThrow('unexpected generated runtime asset');
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('rejects symlinks and required paths escaping the runtime root', async () => {
    const assetFixture = await fixture();
    try {
      await unlink(join(assetFixture.runtimeRoot, 'vendor/critical.js'));
      await symlink('/etc/passwd', join(assetFixture.runtimeRoot, 'vendor/critical.js'));
      await expect(collect(assetFixture)).rejects.toThrow('symlink');
      await expect(
        collectGeneratedRuntimeAssetManifest({
          repositoryRoot: assetFixture.repositoryRoot,
          runtimeRoot: assetFixture.runtimeRoot,
          requiredAssets: ['../outside.js'],
          monitoredDirectories,
          allowedFiles,
        })
      ).rejects.toThrow('outside declared runtime root');
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('compares schema and policy identity in addition to file bytes', async () => {
    const assetFixture = await fixture();
    try {
      const accepted = await collect(assetFixture);
      expect(() =>
        assertGeneratedAssetManifestMatches({ accepted, actual: { ...accepted, schemaVersion: 2 } })
      ).toThrow('does not match accepted baseline');
      expect(() =>
        assertGeneratedAssetManifestMatches({
          accepted,
          actual: {
            ...accepted,
            policy: { ...accepted.policy, allowedFiles: [...accepted.policy.allowedFiles, 'vendor/extra.js'] },
          },
        })
      ).toThrow('does not match accepted baseline');
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('records stable pre/post hashes for unchanged generated assets', async () => {
    const assetFixture = await fixture();
    try {
      const preRun = await collect(assetFixture);
      await expect(
        verifyPostRunGeneratedAssets({ preRunManifest: preRun, collectPostRun: () => collect(assetFixture) })
      ).resolves.toMatchObject({
        result: 'matched',
        preHash: preRun.manifestHash,
        postHash: preRun.manifestHash,
      });
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('refuses publication after a mid-run asset mutation', async () => {
    const assetFixture = await fixture();
    const publish = vi.fn(async () => 'published');
    try {
      const preRun = await collect(assetFixture);
      await writeFile(join(assetFixture.runtimeRoot, 'vendor/critical.js'), 'mutated-during-run');
      await expect(
        guardGeneratedAssetPublication({
          preRunManifest: preRun,
          collectPostRun: () => collect(assetFixture),
          publish,
        })
      ).rejects.toMatchObject({
        message: expect.stringContaining('changed during benchmark run'),
        verification: { result: 'failed', preHash: preRun.manifestHash },
      });
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('refuses canonical summary publication when an asset changes after report staging', async () => {
    const assetFixture = await fixture();
    const summaryPath = join(assetFixture.repositoryRoot, 'summary.json');
    const environmentPath = join(assetFixture.repositoryRoot, 'environment.json');
    try {
      const preRun = await collect(assetFixture);
      await writePairedJsonArtifacts({
        summaryPath,
        environmentPath,
        summary: { generation: 'accepted' },
        environment: { generation: 'accepted' },
        reportSetId: 'accepted-set',
      });
      await expect(
        guardGeneratedAssetPublication({
          preRunManifest: preRun,
          collectPostRun: () => collect(assetFixture),
          publish: async () =>
            writePairedJsonArtifacts({
              summaryPath,
              environmentPath,
              summary: { generation: 'stale-success' },
              environment: { generation: 'stale-success' },
              reportSetId: 'stale-set',
              beforeRename: async () => {
                await writeFile(join(assetFixture.runtimeRoot, 'vendor/critical.js'), 'mutated-after-staging');
                await assertGeneratedAssetsStableAtPublication({
                  preRunManifest: preRun,
                  collectCurrent: () => collect(assetFixture),
                });
              },
            }),
        })
      ).rejects.toThrow('changed immediately before compact report publication');
      expect(JSON.parse(await readFile(summaryPath, 'utf8')).reportSetId).toBe('accepted-set');
      expect(JSON.parse(await readFile(environmentPath, 'utf8')).reportSetId).toBe('accepted-set');
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });

  it('refuses publication when HEAD moves after measurement', async () => {
    const assetFixture = await fixture();
    const publish = vi.fn(async () => 'published');
    try {
      const preRun = await collect(assetFixture);
      await expect(
        guardGeneratedAssetPublication({
          preRunManifest: preRun,
          collectPostRun: () => collect(assetFixture),
          verifyPublicationState: async () => {
            throw new Error('current HEAD moved after provenance capture');
          },
          publish,
        })
      ).rejects.toThrow('current HEAD moved');
      expect(publish).not.toHaveBeenCalled();
    } finally {
      await rm(assetFixture.repositoryRoot, { recursive: true, force: true });
    }
  });
});

describe('COD-356 immutable accepted asset baseline', () => {
  const reportPath = 'docs/reports/cod-356/baseline-summary.json';
  const gitEnvironment = {
    ...process.env,
    GIT_AUTHOR_NAME: 'COD-356',
    GIT_AUTHOR_EMAIL: 'cod356@example.invalid',
    GIT_COMMITTER_NAME: 'COD-356',
    GIT_COMMITTER_EMAIL: 'cod356@example.invalid',
  };

  async function repositoryWithReport(report: unknown) {
    const root = await mkdtemp(join(tmpdir(), 'cod356-baseline-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', env: gitEnvironment }).trim();
    git('init', '-q');
    await mkdir(join(root, 'docs/reports/cod-356'), { recursive: true });
    await writePairedJsonArtifacts({
      summaryPath: join(root, reportPath),
      environmentPath: join(root, 'docs/reports/cod-356/baseline-environment.json'),
      summary: report,
      environment: { phase: 'before' },
      reportSetId: 'accepted-test-report-set',
    });
    git('add', reportPath, 'docs/reports/cod-356/baseline-environment.json');
    git('commit', '-qm', 'accepted baseline');
    return { root, git };
  }

  const manifest = {
    schemaVersion: 1,
    algorithm: 'sha256',
    runtimeRoot: 'src/web/public',
    policy: { requiredAssets: ['vendor/x.js'], monitoredDirectories: ['vendor'], allowedFiles: ['vendor/x.js'] },
    files: [{ path: 'vendor/x.js', bytes: 1, sha256: 'a'.repeat(64) }],
    manifestHash: 'b'.repeat(64),
  };

  it('loads a valid accepted manifest from the committed HEAD blob', async () => {
    const repository = await repositoryWithReport({ provenance: { generatedRuntimeAssets: manifest } });
    try {
      const sourceCommit = repository.git('rev-parse', 'HEAD');
      await expect(
        loadCommittedBaselineAssetManifest({ root: repository.root, reportPath, sourceCommit })
      ).resolves.toMatchObject({
        manifest,
        binding: {
          sourceCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
          blobObjectId: expect.stringMatching(/^[a-f0-9]{40}$/),
          contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          indexBlobObjectId: expect.stringMatching(/^[a-f0-9]{40}$/),
          indexContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          workingContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          indexMatchesHead: true,
          workingMatchesHead: true,
        },
      });
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });

  it.each(['unstaged', 'staged'])('rejects a %s working baseline replacement', async (mode) => {
    const repository = await repositoryWithReport({ provenance: { generatedRuntimeAssets: manifest } });
    try {
      await writeFile(join(repository.root, reportPath), `${JSON.stringify({ replacement: true })}\n`);
      if (mode === 'staged') repository.git('add', reportPath);
      const sourceCommit = repository.git('rev-parse', 'HEAD');
      await expect(
        loadCommittedBaselineAssetManifest({ root: repository.root, reportPath, sourceCommit })
      ).rejects.toThrow(`${mode === 'staged' ? 'index' : 'working'} baseline report does not match committed Git blob`);
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });

  it('rejects a staged-only replacement after the working file is restored to HEAD bytes', async () => {
    const repository = await repositoryWithReport({ provenance: { generatedRuntimeAssets: manifest } });
    try {
      await writeFile(join(repository.root, reportPath), `${JSON.stringify({ stagedReplacement: true })}\n`);
      repository.git('add', reportPath);
      const headContent = repository.git('show', `HEAD:${reportPath}`);
      await writeFile(join(repository.root, reportPath), `${headContent}\n`);
      expect(repository.git('hash-object', reportPath)).toBe(repository.git('rev-parse', `HEAD:${reportPath}`));
      expect(repository.git('diff', '--cached', '--name-only')).toBe(reportPath);
      const sourceCommit = repository.git('rev-parse', 'HEAD');
      await expect(
        loadCommittedBaselineAssetManifest({ root: repository.root, reportPath, sourceCommit })
      ).rejects.toThrow('index baseline report does not match committed Git blob');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });

  it('rejects when HEAD advances after the source commit was resolved', async () => {
    const repository = await repositoryWithReport({ provenance: { generatedRuntimeAssets: manifest } });
    try {
      const sourceCommit = repository.git('rev-parse', 'HEAD');
      await writeFile(join(repository.root, 'advance.txt'), 'advance\n');
      repository.git('add', 'advance.txt');
      repository.git('commit', '-qm', 'advance HEAD');
      await expect(
        loadCommittedBaselineAssetManifest({ root: repository.root, reportPath, sourceCommit })
      ).rejects.toThrow('current HEAD moved after provenance capture');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });

  it('rejects a missing accepted baseline Git blob', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod356-baseline-git-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: root, env: gitEnvironment });
      await writeFile(join(root, 'README'), 'no baseline');
      execFileSync('git', ['add', 'README'], { cwd: root, env: gitEnvironment });
      execFileSync('git', ['commit', '-qm', 'no baseline'], { cwd: root, env: gitEnvironment });
      const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        env: gitEnvironment,
      }).trim();
      await expect(loadCommittedBaselineAssetManifest({ root, reportPath, sourceCommit })).rejects.toThrow(
        'committed accepted baseline blob is missing'
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a malformed committed accepted baseline', async () => {
    const repository = await repositoryWithReport({ provenance: {} });
    try {
      const sourceCommit = repository.git('rev-parse', 'HEAD');
      await expect(
        loadCommittedBaselineAssetManifest({ root: repository.root, reportPath, sourceCommit })
      ).rejects.toThrow('committed accepted baseline manifest is malformed');
    } finally {
      await rm(repository.root, { recursive: true, force: true });
    }
  });
});

describe('COD-356 paired compact report publication', () => {
  it('writes a shared report set and binds the canonical summary to the exact environment bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod356-report-pair-'));
    const summaryPath = join(root, 'summary.json');
    const environmentPath = join(root, 'environment.json');
    try {
      await writePairedJsonArtifacts({
        summaryPath,
        environmentPath,
        summary: { phase: 'before' },
        environment: { platform: 'test' },
        reportSetId: 'report-set-1',
      });
      const summaryContent = await readFile(summaryPath, 'utf8');
      const environmentContent = await readFile(environmentPath, 'utf8');
      expect(validatePairedReports({ summaryContent, environmentContent, summaryPath, environmentPath })).toMatchObject(
        { reportSetId: 'report-set-1' }
      );
      expect(JSON.parse(summaryContent).reportSetId).toBe(JSON.parse(environmentContent).reportSetId);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a mismatched or partially published pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod356-report-pair-'));
    const summaryPath = join(root, 'summary.json');
    const environmentPath = join(root, 'environment.json');
    try {
      await writePairedJsonArtifacts({
        summaryPath,
        environmentPath,
        summary: { generation: 'old' },
        environment: { generation: 'old' },
        reportSetId: 'old-set',
      });
      await expect(
        writePairedJsonArtifacts({
          summaryPath,
          environmentPath,
          summary: { generation: 'new' },
          environment: { generation: 'new' },
          reportSetId: 'new-set',
          renameImpl: async (source: string, destination: string) => {
            if (destination === summaryPath) throw new Error('injected summary rename failure');
            await rename(source, destination);
          },
        })
      ).rejects.toThrow('injected summary rename failure');
      await expect(async () =>
        validatePairedReports({
          summaryContent: await readFile(summaryPath, 'utf8'),
          environmentContent: await readFile(environmentPath, 'utf8'),
          summaryPath,
          environmentPath,
        })
      ).rejects.toThrow('reportSetId');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks publication state after staging both files and before the first rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod356-report-pair-'));
    const summaryPath = join(root, 'summary.json');
    const environmentPath = join(root, 'environment.json');
    try {
      await writePairedJsonArtifacts({
        summaryPath,
        environmentPath,
        summary: { generation: 'old' },
        environment: { generation: 'old' },
        reportSetId: 'old-set',
      });
      await expect(
        writePairedJsonArtifacts({
          summaryPath,
          environmentPath,
          summary: { generation: 'new' },
          environment: { generation: 'new' },
          reportSetId: 'new-set',
          beforeRename: async () => {
            throw new Error('current HEAD moved after compact reports were staged');
          },
        })
      ).rejects.toThrow('current HEAD moved');
      expect(JSON.parse(await readFile(summaryPath, 'utf8')).reportSetId).toBe('old-set');
      expect(JSON.parse(await readFile(environmentPath, 'utf8')).reportSetId).toBe('old-set');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('COD-356 fixed-offer API scheduling', () => {
  it('offers the same slot count for fast and slow responses without catch-up bursts', async () => {
    const run = async (responseMs: number) => {
      let clock = 0;
      const dispatches: number[] = [];
      const result = await runFixedOfferSchedule({
        offeredCount: 6,
        intervalMs: 50,
        now: () => clock,
        sleep: async (milliseconds: number) => {
          clock += milliseconds;
        },
        request: async () => {
          dispatches.push(clock);
          clock += responseMs;
          return { latencyMs: responseMs };
        },
      });
      return { result, dispatches };
    };

    const fast = await run(10);
    const slow = await run(120);
    expect(fast.result.offeredCount).toBe(6);
    expect(slow.result.offeredCount).toBe(6);
    expect(fast.result.missedSlots).toBe(0);
    expect(slow.result.missedSlots).toBeGreaterThan(0);
    expect(slow.dispatches.every((value, index) => index === 0 || value - slow.dispatches[index - 1] >= 50)).toBe(true);
  });

  it('reports fixed-offer missed slots, backlog, timeout, and equivalent per-sample summaries', async () => {
    let clock = 0;
    const result = await runFixedOfferSchedule({
      offeredCount: 4,
      intervalMs: 50,
      now: () => clock,
      sleep: async (milliseconds: number) => {
        clock += milliseconds;
      },
      request: async ({ slot }: { slot: number }) => {
        if (slot === 0) {
          clock += 120;
          return { latencyMs: 120 };
        }
        const error = new Error('timed out');
        error.name = 'TimeoutError';
        throw error;
      },
    });
    expect(result).toMatchObject({
      offeredCount: 4,
      attemptedCount: 3,
      completedCount: 1,
      missedSlots: 1,
      timedOut: 2,
    });
    expect(result.maxBacklogMs).toBeGreaterThan(0);
    expect(summarizeFixedOfferSchedule([result, result])).toMatchObject({
      samples: 2,
      offeredCountPerSample: 4,
      totalOffered: 8,
      totalMissedSlots: 2,
      totalTimedOut: 4,
      latencyMedianMsAcrossSamples: expect.objectContaining({ sampleCount: 2 }),
    });
  });
});

describe('COD-356 reached-target ownership', () => {
  it('rejects an authenticated port-race target not owned by the spawned process tree', async () => {
    await expect(
      proveReachedServerOwnership({
        baseUrl: 'http://127.0.0.1:43123',
        port: 43123,
        spawnedPid: 100,
        authenticate: async () => ({ cookie: 'codeman_session=nonce', payload: { sessions: [] } }),
        findListenerOwners: async () => [999],
        findDescendantPids: async () => [100, 101],
      })
    ).rejects.toThrow('listener is not owned by spawned server process tree');
  });

  it('accepts only authenticated listener ownership by the spawned PID or recorded descendant', async () => {
    await expect(
      proveReachedServerOwnership({
        baseUrl: 'http://127.0.0.1:43123',
        port: 43123,
        spawnedPid: 100,
        authenticate: async () => ({ cookie: 'codeman_session=nonce', payload: { sessions: [] } }),
        findListenerOwners: async () => [101],
        findDescendantPids: async () => [100, 101],
      })
    ).resolves.toMatchObject({ listenerPid: 101, spawnedPid: 100 });
  });
});

describe('COD-356 exact fallback cleanup', () => {
  it('refuses unsafe or unrelated tmux socket names and paths', () => {
    expect(
      validateDisposableTmuxSocket({
        socketName: 'cod356-benchmark-a1b2c3',
        socketPath: '/tmp/tmux-1000/cod356-benchmark-a1b2c3',
        runNonce: 'a1b2c3',
        allowedSocketDirectory: '/tmp/tmux-1000',
      })
    ).toBe(true);
    expect(() =>
      validateDisposableTmuxSocket({
        socketName: 'codeman',
        socketPath: '/tmp/tmux-1000/codeman',
        runNonce: 'a1b2c3',
        allowedSocketDirectory: '/tmp/tmux-1000',
      })
    ).toThrow('exact disposable tmux socket');
    expect(() =>
      validateDisposableTmuxSocket({
        socketName: 'cod356-benchmark-a1b2c3',
        socketPath: '/tmp/else/cod356-benchmark-a1b2c3',
        runNonce: 'a1b2c3',
        allowedSocketDirectory: '/tmp/tmux-1000',
      })
    ).toThrow('socket path');
  });

  it('uses the exact socket fallback when API session cleanup fails with a dead server', async () => {
    const registry = new CleanupRegistry({ cleanupTimeoutMs: 250 });
    const apiRemove = vi.fn(async () => {
      throw new Error('server unavailable');
    });
    const fallback = vi.fn(async () => ({ remainingSessions: 0, socketPresent: false }));
    registry.registerSession('session-1', apiRemove);
    registry.registerTmuxSocket({
      name: 'cod356-benchmark-a1b2c3',
      path: '/tmp/tmux-1000/cod356-benchmark-a1b2c3',
      cleanup: fallback,
    });

    const evidence = await registry.cleanup();
    expect(apiRemove).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(evidence).toMatchObject({ clean: true, tmuxSocketFallback: true });
    expect(evidence.warnings[0]).toContain('server unavailable');
  });

  it('bounds cleanup as a whole when a resource never settles', async () => {
    const registry = new CleanupRegistry({ cleanupTimeoutMs: 30 });
    registry.registerBrowser({ close: () => new Promise(() => undefined) });
    const started = performance.now();
    const evidence = await registry.cleanup();
    expect(performance.now() - started).toBeLessThan(250);
    expect(evidence.clean).toBe(false);
    expect(evidence.errors.join(' ')).toContain('cleanup deadline');
  });

  it('keeps signal handlers installed through cleanup and coalesces a second signal', async () => {
    const processLike = new EventEmitter();
    let releaseCleanup!: () => void;
    const registry = {
      cleanup: vi.fn(() => new Promise((resolve) => (releaseCleanup = () => resolve({ clean: true })))),
    };
    const controller = new AbortController();
    const signals = new SignalCleanupController({ processLike, registry, controller, signals: ['SIGTERM'] });
    signals.install();
    processLike.emit('SIGTERM');
    processLike.emit('SIGTERM');
    expect(registry.cleanup).toHaveBeenCalledTimes(1);
    expect(processLike.listenerCount('SIGTERM')).toBe(1);
    releaseCleanup();
    await signals.finish();
    expect(processLike.listenerCount('SIGTERM')).toBe(0);
    expect(controller.signal.aborted).toBe(true);
  });

  it('deletes only the exact registered benchmark temp root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod356-run-'));
    const child = join(root, 'data');
    await mkdir(child);
    const registry = new CleanupRegistry({ cleanupTimeoutMs: 250 });
    registry.registerTempRoot(root);
    expect(() => registry.registerTempRoot(join(tmpdir(), 'unrelated-cod356-dir'))).toThrow(
      'exact benchmark temp root'
    );
    await registry.cleanup();
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('COD-356 exact cleanup registry', () => {
  it('cleans exact child PIDs, temp dirs, browsers, and disposable session IDs once', async () => {
    const registry = new CleanupRegistry();
    const kill = vi.fn();
    const close = vi.fn(async () => undefined);
    const removeSession = vi.fn(async () => undefined);
    const dataDir = await mkdtemp(join(tmpdir(), 'cod356-run-'));

    registry.registerChild({ pid: 424242, kill });
    registry.registerTempRoot(dataDir);
    registry.registerBrowser({ close });
    registry.registerSession('cod356-benchmark-session-7', removeSession);

    const evidence = await registry.cleanup();
    await registry.cleanup();

    expect(kill).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(removeSession).toHaveBeenCalledExactlyOnceWith('cod356-benchmark-session-7');
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(evidence).toEqual({
      childPids: [424242],
      tempRoots: [dataDir],
      browserCount: 1,
      sessionIds: ['cod356-benchmark-session-7'],
      tmuxSocket: null,
      tmuxSocketFallback: false,
      warnings: [],
      errors: [],
      clean: true,
    });
  });

  it('waits for a registered child PID to exit before reporting cleanup', async () => {
    const registry = new CleanupRegistry();
    const child = Object.assign(new EventEmitter(), {
      pid: 424243,
      exitCode: null as number | null,
      kill: vi.fn(function (this: EventEmitter & { exitCode: number | null }) {
        setTimeout(() => {
          this.exitCode = 0;
          this.emit('exit', 0);
        }, 20);
        return true;
      }),
    });
    registry.registerChild(child);

    await registry.cleanup();

    expect(child.exitCode).toBe(0);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('cleans resources when setup fails inside the enclosing operation', async () => {
    const registry = new CleanupRegistry();
    const dataDir = await mkdtemp(join(tmpdir(), 'cod356-run-'));

    await expect(
      withCleanup(registry, async () => {
        registry.registerTempRoot(dataDir);
        throw new Error('injected setup failure');
      })
    ).rejects.toThrow('injected setup failure');

    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans exact resources when an operation is aborted', async () => {
    const registry = new CleanupRegistry();
    const controller = new AbortController();
    const kill = vi.fn();
    const operation = withCleanup(registry, async () => {
      registry.registerChild({ pid: 424244, kill });
      await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
      throw controller.signal.reason;
    });

    controller.abort(new Error('injected signal'));

    await expect(operation).rejects.toThrow('injected signal');
    expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
  });

  it('rejects registrations once cleanup starts so races cannot leak resources', async () => {
    const registry = new CleanupRegistry();
    let releaseClose!: () => void;
    registry.registerBrowser({
      close: () => new Promise<void>((resolve) => (releaseClose = resolve)),
    });

    const cleanup = registry.cleanup();
    expect(() => registry.registerChild({ pid: 424245, kill: vi.fn() })).toThrow('cleanup has started');
    await new Promise((resolve) => setImmediate(resolve));
    releaseClose();
    await cleanup;
  });
});
