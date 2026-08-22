import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  WorkerCoverageSupervisor,
  aggregateEventLoopIntervals,
  authenticateDisposableTarget,
  assertLoadCoverage,
  calculateProcCpuPercent,
  deriveLoadProfile,
  diffByteSequences,
  formatInputAcknowledgement,
  parseOnlySelection,
  runFixedLoadWindow,
  selectInteractiveFixture,
  summarizeTmuxTrace,
  summarizeSamples,
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
  buildHarnessProvenance,
  parseTrackedStatusPaths,
} from '../scripts/perf/cod-356-provenance.mjs';
import { proveReachedServerOwnership } from '../scripts/perf/cod-356-safety.mjs';
import { runFixedOfferSchedule, summarizeFixedOfferSchedule } from '../scripts/perf/cod-356-scheduler.mjs';

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

describe('COD-356 benchmark statistics', () => {
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
        { type: 'start', invocationId: 'b', timestampNs: '2000000', command: 'capture-pane' },
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
    });
    expect(summarizeTmuxTrace([])).toEqual({
      available: false,
      reason: 'no tmux wrapper events observed',
      subprocessCount: null,
      maxOverlap: null,
      failures: null,
      incomplete: null,
      durationsMs: [],
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
  it('parses leading-space and renamed porcelain paths without corrupting provenance', () => {
    expect(
      parseTrackedStatusPaths(
        ' M scripts/perf/cod-356-benchmark.mjs\nM  package.json\nR  old-name.mjs -> scripts/perf/new-name.mjs\n'
      )
    ).toEqual(['scripts/perf/cod-356-benchmark.mjs', 'package.json', 'scripts/perf/new-name.mjs']);
  });

  it('records dirty harness content independently from informational HEAD', () => {
    const inputs = {
      branchPointRevision: 'a445cdaf645309ce51d8b1431733afa8f0bc55ac',
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
      runtimeRevision: 'a445cdaf645309ce51d8b1431733afa8f0bc55ac',
      branchPointRevision: 'a445cdaf645309ce51d8b1431733afa8f0bc55ac',
      headRevision: {
        value: 'deadbeef',
        semantics: 'informational only; not the measured runtime or harness identity',
      },
      runtimeTreeHash: 'runtime-tree-hash',
      harness: { dirty: true },
      outOfScopeTrackedDirtyPaths: ['src/outside-task.ts'],
    });
    expect(first.harness.contentHash).not.toBe(changedContent.harness.contentHash);
  });

  it('rejects a runtime tree that differs from the declared branch point', () => {
    expect(() =>
      assertRuntimeTreeMatchesRevision({
        branchPointRevision: 'a445cdaf645309ce51d8b1431733afa8f0bc55ac',
        changedPaths: ['src/index.ts'],
        untrackedPaths: [],
      })
    ).toThrow('runtime tree does not match branch point');
    expect(
      assertRuntimeTreeMatchesRevision({
        branchPointRevision: 'a445cdaf645309ce51d8b1431733afa8f0bc55ac',
        changedPaths: [],
        untrackedPaths: [],
      })
    ).toBe(true);
  });

  it('allows only the benchmark script difference in the runtime package manifest', () => {
    const branchPoint = JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { fastify: '5.0.0' } });
    const harness = JSON.stringify({
      scripts: { test: 'vitest', 'perf:cod356': 'node scripts/perf/cod-356-benchmark.mjs' },
      dependencies: { fastify: '5.0.0' },
    });
    expect(assertRuntimePackageManifestMatches({ branchPointContent: branchPoint, actualContent: harness })).toEqual({
      allowedDifference: 'scripts.perf:cod356 only',
      normalizedHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(() =>
      assertRuntimePackageManifestMatches({
        branchPointContent: branchPoint,
        actualContent: JSON.stringify({ scripts: { test: 'vitest' }, dependencies: { fastify: '6.0.0' } }),
      })
    ).toThrow('runtime package manifest does not match branch point');
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
