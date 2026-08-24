import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BASELINE_PRODUCT,
  CANDIDATE_PRODUCT,
  HARNESS_FILES,
  OVERLAY_FILES,
  SERVER_OUTPUT_STAGES,
  buildAttributionReport,
  canonicalJson,
  measureRuntimeObservation,
  deriveSampleEvidence,
  publishAttributionReport,
  publishExperimentAttempt,
  processStartIdentity,
  reconcileExperimentLedger,
  runExperimentProducerTransaction,
  summarizeExperiment,
  summaryStatistics,
  validateAttempt,
  validateCalibration,
  validateDiagnosticMatrix,
  validateExperimentLedger,
  validateRepetition,
  verifyOverlayArtifact,
  verifyExperimentPreflight,
  verifyRepositoryProvenance,
  verifyRuntimeObservation,
} from '../scripts/perf/cod-374-summarize.mjs';
import { createMobileInputTraceCollector } from '../src/perf/mobile-input-trace.js';
import {
  BROWSER_GLOBAL_OUTPUT_STAGES,
  BROWSER_INPUT_STAGES,
  BROWSER_LATENCY_STAGES,
  BROWSER_VISIBILITY_STAGES,
  correlateBrowserServerTrace,
  validateBrowserLatencyTrace,
  validateServerOutputChain,
} from './utils/cod374-latency-trace.js';

const HASH64 = 'a'.repeat(64);
const BLOB = 'b'.repeat(40);
const HARNESS_COMMIT = 'c'.repeat(40);
const HARNESS_TREE = 'd'.repeat(40);
const EXPERIMENT_ID = '9999999999999999';
const OPENCODE_VERSION = 'opencode-fixture-1.0.0';
const OPENCODE_VERSION_HASH = createHash('sha256').update(OPENCODE_VERSION).digest('hex').slice(0, 16);

function browserEvent(stage: string, atMs: number, context: Record<string, unknown>, optional = {}) {
  return { stage, atMs, clock: 'browser', ...context, ...optional };
}

function singleInputShape(index: number, sequenceBase: number, browserClockId: string, traceEnabled: boolean) {
  const seq = sequenceBase + index + 1;
  const generation = index + 1;
  const clientId = (sequenceBase + 50).toString(16).padStart(16, '0');
  const connectionHash = (sequenceBase + 60).toString(16).padStart(16, '0');
  const sessionHash = (sequenceBase + 70).toString(16).padStart(16, '0');
  const tokenHash = (sequenceBase + index + 80).toString(16).padStart(16, '0');
  const trialId = `cod374-${sequenceBase.toString(36)}`;
  const chunkA = '1111111111111111';
  const chunkB = '2222222222222222';
  const batchHash = '3333333333333333';
  const inputContext = { clockId: browserClockId, trialId, generation, inputIndex: index, tokenHash, tokenLength: 10 };
  const globalContext = {
    clockId: browserClockId,
    trialId,
    generation: 0,
    inputIndex: 0,
    tokenHash,
    tokenLength: 10,
  };
  const browserEvents = [
    browserEvent('browser.keydown', 1, inputContext),
    browserEvent('browser.xterm-on-data', 2, inputContext),
    browserEvent('browser.logical', 3, inputContext),
    browserEvent('browser.durable-queued', 4, inputContext, { clientId, seq }),
    browserEvent('browser.ws-input-send', 5, inputContext, { clientId, seq, attempt: 1 }),
    browserEvent('browser.ws-input-send-return', 6, inputContext, { clientId, seq, attempt: 1 }),
    browserEvent('browser.ws-input-ack', 7, inputContext, { clientId, seq, attempt: 1 }),
    browserEvent('browser.ws-output-receive', 10, globalContext, { ordinal: 1, valueHash: batchHash, bytes: 2 }),
    browserEvent('browser.output-handler', 11, globalContext, { ordinal: 1 }),
    browserEvent('browser.write-queued', 12, globalContext, {
      ordinal: 1,
      pendingCount: 1,
    }),
    browserEvent('browser.xterm-write', 13, globalContext, { ordinal: 1, writeId: 1, bytes: 2 }),
    browserEvent('browser.xterm-write-return', 14, globalContext, { ordinal: 1, writeId: 1, bytes: 2 }),
    browserEvent('browser.xterm-write-callback', 15, globalContext, { ordinal: 1, writeId: 1, bytes: 2 }),
    browserEvent('browser.xterm-parsed', 16, globalContext, { ordinal: 1, writeId: 1 }),
    ...BROWSER_VISIBILITY_STAGES.map((stage, offset) =>
      browserEvent(stage, 17 + offset, inputContext, {
        ordinal: 1,
        writeId: 1,
        attributedGeneration: generation,
        attributedInputIndex: index,
      })
    ),
  ];
  let mono = 0;
  const server = (stage: string, optional: Record<string, unknown> = {}) => ({
    stage,
    monoNs: String((mono += 1) * 1_000_000),
    epochMs: 1_000 + mono,
    ordinal: mono,
    ...optional,
  });
  const serverEvents = traceEnabled
    ? [
        server('server.input.received', { sessionHash, connectionHash, clientId, seq }),
        server('server.input.parsed', { sessionHash, connectionHash, clientId, seq }),
        server('server.input.deduped', { sessionHash, connectionHash, clientId, seq, applied: true }),
        server('server.input.activated', { sessionHash, connectionHash, clientId, seq }),
        server('server.input.pre-write', { sessionHash, connectionHash, clientId, seq, bytes: 1 }),
        server('server.input.post-write', { sessionHash, connectionHash, clientId, seq, bytes: 1, delivered: true }),
        server('server.input.pre-ack', { sessionHash, connectionHash, clientId, seq, ordinal: 7 }),
        server('server.input.post-ack', { sessionHash, connectionHash, clientId, seq, ordinal: 8 }),
        server('server.output.pty-received', { sessionHash, ordinal: 100, valueHash: chunkA, bytes: 1 }),
        server('server.output.handler-enter', { sessionHash, ordinal: 101, valueHash: chunkA, bytes: 1 }),
        server('server.output.terminal-emitted', { sessionHash, ordinal: 102, valueHash: chunkA, bytes: 1 }),
        server('server.output.pty-received', { sessionHash, ordinal: 103, valueHash: chunkB, bytes: 1 }),
        server('server.output.handler-enter', { sessionHash, ordinal: 104, valueHash: chunkB, bytes: 1 }),
        server('server.output.terminal-emitted', { sessionHash, ordinal: 105, valueHash: chunkB, bytes: 1 }),
        server('server.output.ws-received', { sessionHash, connectionHash, ordinal: 110, valueHash: chunkA, bytes: 1 }),
        server('server.output.batch-enqueued', {
          sessionHash,
          connectionHash,
          ordinal: 111,
          valueHash: chunkA,
          bytes: 1,
        }),
        server('server.output.ws-received', { sessionHash, connectionHash, ordinal: 112, valueHash: chunkB, bytes: 1 }),
        server('server.output.batch-enqueued', {
          sessionHash,
          connectionHash,
          ordinal: 113,
          valueHash: chunkB,
          bytes: 1,
        }),
        server('server.output.flush-start', {
          sessionHash,
          connectionHash,
          ordinal: 120,
          valueHash: batchHash,
          bytes: 2,
        }),
        server('server.output.pre-send', {
          sessionHash,
          connectionHash,
          ordinal: 121,
          valueHash: batchHash,
          bytes: 2,
        }),
        server('server.output.post-send', {
          sessionHash,
          connectionHash,
          ordinal: 122,
          valueHash: batchHash,
          bytes: 2,
          delivered: true,
        }),
      ]
    : [];
  return {
    index,
    input: {
      clientId,
      seq,
      tokenHash,
      tokenLength: 10,
      generation,
      inputIndex: index,
      coalescedIndex: 0,
      coalescedCount: 1,
    },
    evidence: {
      browserEvents,
      serverEvents,
      paneResults: [
        {
          inputIndex: index,
          tokenHash,
          tokenLength: 10,
          status: 'visible',
          probes: [
            { startedNs: '500000', completedNs: '600000', present: false, durationMs: 0.1, errorHash: null },
            { startedNs: '700000', completedNs: '800000', present: true, durationMs: 0.1, errorHash: null },
          ],
        },
      ],
      longTaskWindow: { startedMs: 0, endedMs: 21, entries: [] },
      resizeEvents: [],
    },
  };
}

function realShapeWindow(sampleIndex: number, sequenceBase: number, browserClockId: string, traceEnabled: boolean) {
  const parts = [0, 1, 2].map((inputIndex) => singleInputShape(inputIndex, sequenceBase, browserClockId, traceEnabled));
  const trialId = `cod374-${sequenceBase.toString(36)}`;
  for (const [inputIndex, part] of parts.entries()) {
    const tokenLength = inputIndex + 1;
    const tokenHash = createHash('sha256').update(['q', 'qz', 'qz1'][inputIndex]).digest('hex').slice(0, 16);
    part.input.tokenLength = tokenLength;
    part.input.tokenHash = tokenHash;
    for (const event of part.evidence.browserEvents) {
      event.trialId = trialId;
      event.tokenLength = tokenLength;
      event.tokenHash = tokenHash;
    }
    part.evidence.paneResults[0].tokenLength = tokenLength;
    part.evidence.paneResults[0].tokenHash = tokenHash;
  }
  const browserEvents: any[] = [];
  for (const [inputIndex, part] of parts.entries()) {
    const inputEvents = part.evidence.browserEvents.filter((event: any) => event.generation > 0).slice(0, 7);
    for (const event of inputEvents) browserEvents.push({ ...event, atMs: event.atMs + inputIndex * 8 });
    if (inputIndex < 2) {
      const context = inputEvents[0];
      browserEvents.push({
        ...context,
        stage: 'browser.generation-incomplete',
        atMs: 8 + inputIndex * 8,
        incompleteReason: 'coalesced-before-exact-visibility',
      });
    }
  }
  const final = parts.at(-1)!;
  browserEvents.push(
    ...final.evidence.browserEvents
      .filter((event: any) => event.generation === 0)
      .map((event: any) => ({ ...event, atMs: event.atMs + 20 })),
    ...final.evidence.browserEvents
      .filter((event: any) => BROWSER_VISIBILITY_STAGES.includes(event.stage))
      .map((event: any) => ({ ...event, atMs: event.atMs + 20 }))
  );
  let serverOrdinal = 0;
  const serverEvents = traceEnabled
    ? [...parts.flatMap((part) => part.evidence.serverEvents.slice(0, 8)), ...final.evidence.serverEvents.slice(8)].map(
        (event: any) => ({
          ...event,
          monoNs: String(++serverOrdinal * 1_000_000),
          epochMs: 1_000 + serverOrdinal,
          ordinal: serverOrdinal,
        })
      )
    : [];
  const paneResults = parts.map((part, inputIndex) => ({
    ...part.evidence.paneResults[0],
    ...(inputIndex < 2
      ? {
          status: 'incomplete',
          errorHash: (sequenceBase + inputIndex + 900).toString(16).padStart(16, '0'),
          probes: part.evidence.paneResults[0].probes.map((probe: any) => ({ ...probe, present: false })),
        }
      : { status: 'visible', errorHash: null }),
  }));
  return {
    index: sampleIndex,
    inputs: parts.map((part) => part.input),
    evidence: {
      browserEvents,
      serverEvents,
      paneResults,
      longTaskWindow: { startedMs: 0, endedMs: 41, entries: [] },
      resizeEvents: [],
      firstAcked: {
        clientId: parts[0].input.clientId,
        seq: parts[0].input.seq,
        serverOrdinal: traceEnabled ? 8 : null,
      },
    },
  };
}

function repetition(
  phase: 'calibration' | 'diagnostic',
  label: 'trace-off' | 'trace-on' | 'baseline' | 'candidate',
  repetitionNumber: number,
  attempt: number
) {
  const traceEnabled = label !== 'trace-off';
  const product = label === 'baseline' ? BASELINE_PRODUCT : CANDIDATE_PRODUCT;
  const startedAt = new Date(Date.UTC(2026, 7, 24, 0, attempt * 2, 0)).toISOString();
  const endedAt = new Date(Date.UTC(2026, 7, 24, 0, attempt * 2 + 1, 0)).toISOString();
  const browserClockId = `page-00000000-0000-4000-8000-${(attempt + 300).toString(16).padStart(12, '0')}`;
  const serverClockId = (attempt + 400).toString(16).padStart(16, '0');
  const harnessClockId = (attempt + 500).toString(16).padStart(16, '0');
  return {
    schemaVersion: 2,
    phase,
    experimentId: EXPERIMENT_ID,
    config: {
      label,
      repetition: repetitionNumber,
      traceEnabled,
      rates: [1, 4],
      samplesPerCell: 10,
      viewport: { width: 390, height: 844 },
      fontPx: label === 'baseline' ? 10 : 9,
      payloadHash: createHash('sha256').update('qz1').digest('hex').slice(0, 16),
      payloadLength: 3,
    },
    provenance: {
      product: { ...product },
      harness: {
        commit: HARNESS_COMMIT,
        tree: HARNESS_TREE,
        dirty: false,
        files: HARNESS_FILES.map((file) => ({ file, blob: BLOB, sha256: HASH64 })),
      },
      overlay: {
        semanticSha256: HASH64,
        patchSha256: label === 'baseline' ? '1'.repeat(64) : '2'.repeat(64),
        files: OVERLAY_FILES.map((file) => ({ file, mode: '100644', sha256: HASH64 })),
        manifestSha256: label === 'baseline' ? '3'.repeat(64) : '4'.repeat(64),
        servedAssets: ['/', '/app.js', '/styles.css'].map((path) => ({ path, sha256: HASH64 })),
      },
      dependencies: {
        packageLockSha256: HASH64,
        vendorManifestSha256: HASH64,
        dependencyRootHash: HASH64,
        dependencyContentHash: HASH64,
        dependencyDevice: '64512',
        dependencyInode: '2951130',
      },
      runtimeVendorHash: HASH64,
      host: {
        hostnameHash: '0123456789abcdef',
        cpuModelHash: '1234567890abcdef',
        cpuCount: 8,
        platform: 'linux',
        releaseHash: '234567890abcdef1',
        nodeVersionHash: '34567890abcdef12',
        opencodeVersionHash: OPENCODE_VERSION_HASH,
      },
      process: {
        runId: (attempt + 200).toString(16).padStart(16, '0'),
        tmuxSessionHash: attempt.toString(16).padStart(16, '0'),
        tempRootHash: (attempt + 100).toString(16).padStart(16, '0'),
        server: {
          pid: 10_000 + attempt,
          startedAt: new Date(Date.parse(startedAt) + 100).toISOString(),
          startIdentity: String(100_000 + attempt),
          startUncertaintyMs: 10,
        },
        browser: {
          pid: 20_000 + attempt,
          startedAt: new Date(Date.parse(startedAt) + 200).toISOString(),
          startIdentity: String(200_000 + attempt),
          startUncertaintyMs: 10,
        },
        opencode: {
          pid: 30_000 + attempt,
          startedAt: new Date(Date.parse(startedAt) + 300).toISOString(),
          startIdentity: String(300_000 + attempt),
          startUncertaintyMs: 10,
        },
      },
    },
    timing: { startedAt, endedAt, loadAverageBefore: [0.1, 0.2, 0.3], loadAverageAfter: [0.2, 0.3, 0.4] },
    clock: { mode: 'component-local', browserClockId, serverClockId, harnessClockId },
    selection: { attempt, lifecycle: 'completed', accepted: true, failureReasons: [] },
    cells: [1, 4].map((rate) => ({
      rate,
      realizedCpuThrottle: rate,
      cpuCalibration: {
        baselineSamplesMs: [10, 10, 10, 10, 10],
        throttledSamplesMs: [10 * rate, 10 * rate, 10 * rate, 10 * rate, 10 * rate],
        baselineMedianMs: 10,
        throttledMedianMs: 10 * rate,
        ratio: rate,
      },
      samples: Array.from({ length: 10 }, (_, index) =>
        realShapeWindow(index, attempt * 10_000 + rate * 1_000 + index * 10, browserClockId, traceEnabled)
      ),
    })),
    diagnostics: {
      traceOverflowed: false,
      observerErrorHashes: [],
      pageErrorHashes: [],
      consoleErrorHashes: [],
      processReplaced: false,
      resizeEvents: [],
      longTasks: [],
      errorHashes: [],
      serverStdoutHashes: [],
      serverStderrHashes: [],
      startupStageHashes: [],
      startupNameHashes: [],
      startupMessageHashes: [],
    },
    allocation: {
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    },
    cleanup: {
      browserClosed: true,
      serverStopped: true,
      tmuxRemoved: true,
      tempRootRemoved: true,
      hooksRestored: true,
      listenersDisposed: true,
    },
  };
}

function rejectedPreflight(attempt = 1) {
  const row: any = repetition('calibration', 'trace-off', 1, attempt);
  row.selection = {
    attempt,
    lifecycle: 'preflight',
    accepted: false,
    failureReasons: [{ code: 'browser-launch-failed', detailHash: '7777777777777777' }],
  };
  row.provenance.process = {
    runId: (attempt + 200).toString(16).padStart(16, '0'),
    tmuxSessionHash: null,
    tempRootHash: (attempt + 100).toString(16).padStart(16, '0'),
    server: null,
    browser: null,
    opencode: null,
  };
  row.provenance.runtimeVendorHash = null;
  row.cells = [];
  row.allocation = {
    browserClosed: false,
    serverStopped: false,
    tmuxRemoved: false,
    tempRootRemoved: false,
    hooksRestored: false,
    listenersDisposed: false,
  };
  return row;
}

function rejectedCompleted(attempt = 2) {
  const row: any = repetition('calibration', 'trace-on', 1, attempt);
  row.selection = {
    attempt,
    lifecycle: 'completed',
    accepted: false,
    failureReasons: [{ code: 'browser-long-task', detailHash: '8888888888888888' }],
  };
  row.diagnostics.longTasks = [{ startedMs: 5, durationMs: 60 }];
  row.cleanup.browserClosed = false;
  return row;
}

function rejectedPartial(attempt = 2) {
  const row: any = rejectedCompleted(attempt);
  row.selection.lifecycle = 'partial';
  row.selection.failureReasons = [{ code: 'browser-process-exited', detailHash: '8989898989898989' }];
  row.cells = [{ ...row.cells[0], samples: row.cells[0].samples.slice(0, 3) }];
  return row;
}

const completeCalibration = () => [
  repetition('calibration', 'trace-off', 1, 1),
  repetition('calibration', 'trace-on', 1, 2),
  repetition('calibration', 'trace-off', 2, 3),
];
const completeDiagnostic = () => [
  repetition('diagnostic', 'baseline', 1, 4),
  repetition('diagnostic', 'candidate', 1, 5),
  repetition('diagnostic', 'candidate', 2, 6),
  repetition('diagnostic', 'baseline', 2, 7),
];
const allAttempts = () => [...completeCalibration(), ...completeDiagnostic()];

function runtimeObservation(row: any) {
  return measureRuntimeObservation(row, runtimeProbes(row));
}

function runtimeProbes(row: any) {
  return {
    readOpenCodeVersion: () => OPENCODE_VERSION,
    readViewport: () => ({ ...row.config.viewport }),
    readFontPx: () => row.config.fontPx,
    readRealizedCpuThrottle: (rate: number) => row.cells.find((cell: any) => cell.rate === rate).realizedCpuThrottle,
    readCpuCalibration: (rate: number) => row.cells.find((cell: any) => cell.rate === rate).cpuCalibration,
    readServerProcess: () => ({ ...row.provenance.process.server }),
    readBrowserProcess: () => ({ ...row.provenance.process.browser }),
    readOpenCodeProcess: () => ({ ...row.provenance.process.opencode }),
  };
}

async function publishAttempt(options: any) {
  const preflightProof =
    options.repetition.selection.lifecycle !== 'preflight'
      ? await verifyExperimentPreflight({
          repetition: options.repetition,
          repositoryRoot: options.repositoryRoot,
          vendorManifestPath: '/vendor.json',
          gitVerifier: async () => {},
        })
      : undefined;
  return publishExperimentAttempt({ ...options, preflightProof });
}

function setDuration(row: any, durationMs: number) {
  for (const cell of row.cells) {
    for (const sample of cell.samples) {
      sample.evidence.browserEvents.find((event: any) => event.stage === 'browser.paint-proxy').atMs = 1 + durationMs;
      sample.evidence.longTaskWindow.endedMs = 2 + durationMs;
    }
  }
}

describe('COD-374 real-shape evidence validation', () => {
  it('canonicalizes nested object keys recursively and BigInts as decimal strings', () => {
    expect(canonicalJson({ z: { b: 2, a: 1n }, a: 0 })).toBe(canonicalJson({ a: 0, z: { a: 1n, b: 2 } }));
  });
  it('uses the conventional average-of-middle-two median', () => {
    expect(summaryStatistics([1, 3, 5, 7])).toEqual({ median: 4, p95: 7, max: 7 });
  });

  it('derives stage vocabulary from contracts accepted by Task 3', () => {
    const collector = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'fixture',
      capacity: SERVER_OUTPUT_STAGES.length,
    });
    for (const [ordinal, stage] of SERVER_OUTPUT_STAGES.entries()) {
      expect(() => collector.record({ stage, monoNs: String(ordinal + 1) } as never)).not.toThrow();
    }
    expect(SERVER_OUTPUT_STAGES).toContain('server.output.batch-enqueued');
    expect(BROWSER_LATENCY_STAGES).toEqual(
      expect.arrayContaining([...BROWSER_INPUT_STAGES, ...BROWSER_GLOBAL_OUTPUT_STAGES, ...BROWSER_VISIBILITY_STAGES])
    );
  });

  it('accepts a browser fixture through the actual Task 3 validator', () => {
    const sample: any = realShapeWindow(0, 100, 'page-00000000-0000-4000-8000-000000000001', true);
    expect(validateBrowserLatencyTrace(sample.evidence.browserEvents)).toHaveLength(34);
  });

  it('accepts multi-chunk and batched server output through actual Task 3 validators', () => {
    const sample: any = realShapeWindow(0, 100, 'page-00000000-0000-4000-8000-000000000001', true);
    const collector = createMobileInputTraceCollector({
      nodeEnv: 'test',
      traceFlag: '1',
      secret: 'fixture',
      capacity: 100,
    });
    for (const event of sample.evidence.serverEvents) expect(collector.record(event)).toBe(true);
    const connectionHash = sample.evidence.serverEvents.find(
      (event: any) => event.stage === 'server.input.post-ack'
    ).connectionHash;
    expect(validateServerOutputChain(sample.evidence.serverEvents, connectionHash)).toEqual({
      upstreamChunks: 2,
      connectionChunks: 2,
      flushes: 1,
    });
    expect(
      correlateBrowserServerTrace(sample.evidence.browserEvents, sample.evidence.serverEvents, sample.inputs[0])
    ).toHaveLength(1);
  });

  it('accepts honest trace-off samples with no server events', () => {
    const row: any = repetition('calibration', 'trace-off', 1, 1);
    expect(
      row.cells.every((cell: any) => cell.samples.every((sample: any) => !sample.evidence.serverEvents.length))
    ).toBe(true);
    expect(validateRepetition(row)).toBe(row);
    row.cells[0].samples[0].evidence.serverEvents.push({ stage: 'server.input.received', monoNs: '1' });
    expect(() => validateRepetition(row)).toThrow(/trace-off.*server/i);
  });

  it('bounds every retained diagnostic hash array', () => {
    const row: any = rejectedPartial();
    row.diagnostics.startupMessageHashes = Array.from({ length: 33 }, (_, index) =>
      createHash('sha256').update(`diagnostic-${index}`).digest('hex').slice(0, 16)
    );
    expect(() => validateAttempt(row)).toThrow(/startupMessageHashes.*bounded|too many/i);
  });

  it('accepts full trace-on evidence and recomputes multiplicity and correctness', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    expect(validateRepetition(row)).toBe(row);
    expect(deriveSampleEvidence(row.cells[0].samples[0], true)).toMatchObject({
      totalMs: 39,
      correctness: {
        browserAcks: 3,
        serverApplied: 3,
        serverWrites: 3,
        serverAcks: 3,
        outputFrames: 1,
        paneVisible: 1,
        xtermVisible: 1,
      },
      serverMultiplicity: { upstreamChunks: 2, connectionChunks: 2, flushes: 1 },
    });
  });

  it.each([
    [
      'asynchronous',
      ['browser.xterm-write', 'browser.xterm-write-return', 'browser.xterm-write-callback', 'browser.xterm-parsed'],
    ],
    [
      'synchronous',
      ['browser.xterm-write', 'browser.xterm-write-callback', 'browser.xterm-parsed', 'browser.xterm-write-return'],
    ],
  ])('accepts the legal %s xterm write callback order', (_name, stages) => {
    const sample: any = realShapeWindow(0, 100, 'page-00000000-0000-4000-8000-000000000001', true);
    const events = sample.evidence.browserEvents;
    const group = events.filter(
      (event: any) =>
        event.generation === 0 &&
        event.writeId === 1 &&
        [
          'browser.xterm-write',
          'browser.xterm-write-return',
          'browser.xterm-write-callback',
          'browser.xterm-parsed',
        ].includes(event.stage)
    );
    const insertAt = Math.min(...group.map((event: any) => events.indexOf(event)));
    sample.evidence.browserEvents = events.filter((event: any) => !group.includes(event));
    sample.evidence.browserEvents.splice(
      insertAt,
      0,
      ...stages.map((stage, index) => ({ ...group.find((event: any) => event.stage === stage), atMs: 33 + index }))
    );
    const derived = deriveSampleEvidence(sample, true);
    expect(derived).toMatchObject({ correctness: { outputFrames: 1 } });
    const writeSegments = Object.fromEntries(
      Object.entries(derived.segments).filter(([name]) => name.startsWith('browser-write1:'))
    );
    expect(Object.keys(writeSegments)).toEqual([
      'browser-write1:browser.xterm-write→browser.xterm-write-return',
      'browser-write1:browser.xterm-write→browser.xterm-write-callback',
      'browser-write1:browser.xterm-write-callback→browser.xterm-parsed',
    ]);
    expect(Object.values(writeSegments)).toEqual(_name === 'asynchronous' ? [1, 2, 1] : [3, 1, 1]);
  });

  it.each([
    [
      'callback after parsed',
      ['browser.xterm-write', 'browser.xterm-parsed', 'browser.xterm-write-callback', 'browser.xterm-write-return'],
    ],
    [
      'write not first',
      ['browser.xterm-write-return', 'browser.xterm-write', 'browser.xterm-write-callback', 'browser.xterm-parsed'],
    ],
  ])('rejects the noncausal xterm write order: %s', (_name, stages) => {
    const sample: any = realShapeWindow(0, 100, 'page-00000000-0000-4000-8000-000000000001', true);
    const events = sample.evidence.browserEvents;
    const group = events.filter(
      (event: any) =>
        event.generation === 0 &&
        event.writeId === 1 &&
        [
          'browser.xterm-write',
          'browser.xterm-write-return',
          'browser.xterm-write-callback',
          'browser.xterm-parsed',
        ].includes(event.stage)
    );
    const insertAt = Math.min(...group.map((event: any) => events.indexOf(event)));
    sample.evidence.browserEvents = events.filter((event: any) => !group.includes(event));
    sample.evidence.browserEvents.splice(
      insertAt,
      0,
      ...stages.map((stage, index) => ({ ...group.find((event: any) => event.stage === stage), atMs: 33 + index }))
    );
    expect(() => deriveSampleEvidence(sample, true)).toThrow(/xterm write/i);
  });

  it('accepts multiple global browser output/write batches and server flushes', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    const sample = row.cells[0].samples[0];
    const global = sample.evidence.browserEvents.filter((event: any) => event.generation === 0);
    const visibility = sample.evidence.browserEvents.filter((event: any) => event.generation > 0).slice(-4);
    const second = global.map((event: any) => ({
      ...event,
      atMs: event.atMs + 7,
      ordinal: 2,
      ...(event.writeId === undefined ? {} : { writeId: 2 }),
      ...(event.valueHash === undefined ? {} : { valueHash: '4444444444444444' }),
    }));
    for (const event of visibility) event.atMs += 7;
    const visibilityIndex = sample.evidence.browserEvents.findIndex((event: any) =>
      BROWSER_VISIBILITY_STAGES.includes(event.stage)
    );
    sample.evidence.browserEvents.splice(visibilityIndex, 0, ...second);
    sample.evidence.longTaskWindow.endedMs += 7;
    const lastNs = BigInt(sample.evidence.serverEvents.at(-1).monoNs);
    for (const [index, stage] of [
      'server.output.flush-start',
      'server.output.pre-send',
      'server.output.post-send',
    ].entries()) {
      sample.evidence.serverEvents.push({
        ...sample.evidence.serverEvents.at(-1),
        stage,
        monoNs: String(lastNs + BigInt(index + 1) * 1_000_000n),
        ordinal: 123 + index,
        valueHash: '4444444444444444',
        bytes: 2,
        ...(stage === 'server.output.post-send' ? { delivered: true } : {}),
      });
    }
    expect(deriveSampleEvidence(sample, true)).toMatchObject({
      correctness: { outputFrames: 2 },
      serverMultiplicity: { flushes: 2 },
    });
  });

  it('ignores output chunks for unrelated connections while preserving measured joins', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    const sample = row.cells[0].samples[0];
    const measuredChunks = sample.evidence.serverEvents.filter((event: any) =>
      ['server.output.ws-received', 'server.output.batch-enqueued'].includes(event.stage)
    );
    sample.evidence.serverEvents.push(
      { ...measuredChunks[0], monoNs: '38000000', connectionHash: '9999999999999999', ordinal: 200 },
      { ...measuredChunks[1], monoNs: '39000000', connectionHash: '9999999999999999', ordinal: 201 }
    );
    expect(deriveSampleEvidence(sample, true).serverMultiplicity).toMatchObject({ connectionChunks: 2 });
  });

  it('accepts an exact matching actual runtime observation', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    expect(() => verifyRuntimeObservation(row, runtimeObservation(row))).not.toThrow();
  });

  it('requires explicit output identity fields instead of comparing undefined values', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    for (const event of row.cells[0].samples[0].evidence.serverEvents.filter((entry: any) =>
      entry.stage.startsWith('server.output.')
    )) {
      delete event.valueHash;
      delete event.bytes;
    }
    expect(() => validateRepetition(row)).toThrow(/output.*identity|required|hash/i);
  });

  it.each([
    ['browser token', (sample: any) => (sample.evidence.browserEvents.at(-1).tokenHash = 'aaaaaaaaaaaaaaaa')],
    ['pane target', (sample: any) => (sample.evidence.paneResults[0].tokenLength = 9)],
    [
      'global output hash',
      (sample: any) =>
        (sample.evidence.browserEvents.find((event: any) => event.stage === 'browser.ws-output-receive').valueHash =
          'aaaaaaaaaaaaaaaa'),
    ],
    ['required server identity', (sample: any) => delete sample.evidence.serverEvents[2].clientId],
  ])('rejects mismatched real-shape %s evidence', (_name, mutate) => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    mutate(row.cells[0].samples[0]);
    expect(() => validateRepetition(row)).toThrow();
  });

  it('requires the long-task window to enclose keydown through selected paint', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    row.cells[0].samples[0].evidence.longTaskWindow.endedMs = 19.5;
    expect(() => validateRepetition(row)).toThrow(/long-task window/i);
  });

  it('rejects a generation that is both incomplete and visible or spans parsed writes', () => {
    const both: any = repetition('diagnostic', 'candidate', 1, 5);
    const sample = both.cells[0].samples[0];
    const final = sample.evidence.browserEvents.find((event: any) => event.stage === 'browser.paint-proxy');
    sample.evidence.browserEvents.push({
      ...final,
      stage: 'browser.generation-incomplete',
      atMs: final.atMs,
      incompleteReason: 'coalesced-before-exact-visibility',
    });
    expect(() => validateRepetition(both)).toThrow(/both visible and incomplete/i);

    const split: any = repetition('diagnostic', 'candidate', 1, 5);
    split.cells[0].samples[0].evidence.browserEvents.find(
      (event: any) => event.stage === 'browser.paint-proxy'
    ).writeId = 99;
    expect(() => validateRepetition(split)).toThrow(/share one parsed write|parsed write/i);
  });

  it('rejects pane probe errors in accepted evidence but preserves them after contamination', () => {
    const accepted: any = repetition('diagnostic', 'candidate', 1, 5);
    accepted.cells[0].samples[0].evidence.paneResults[0].probes.unshift({
      startedNs: '100000',
      completedNs: '200000',
      present: false,
      durationMs: 0.1,
      errorHash: '9999999999999999',
    });
    expect(() => validateRepetition(accepted)).toThrow(/pane.*error/i);
    const rejected: any = rejectedCompleted();
    rejected.cells[0].samples[0].evidence.paneResults[0].probes.unshift({
      startedNs: '100000',
      completedNs: '200000',
      present: false,
      durationMs: 0.1,
      errorHash: '9999999999999999',
    });
    expect(validateAttempt(rejected).cells[0].samples[0].evidence.paneResults[0].probes[0].errorHash).toBe(
      '9999999999999999'
    );
  });

  it('removes calibrated causality and rejects every calibrated field', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    row.clock.calibration = { offsetMs: 1 };
    expect(() => validateRepetition(row)).toThrow(/clock.*field|unknown/i);
    const report = buildAttributionReport({ attempts: allAttempts() });
    expect(report).toMatch(/INCONCLUSIVE ACROSS CLOCK DOMAINS/);
    expect(report).not.toMatch(/FIRST DELAYED BOUNDARY|calibrated|uncertainty/i);
  });

  it('rejects an attributed server flush that crosses the measured post-ACK boundary', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    const sample = row.cells[0].samples[0];
    sample.evidence.serverEvents.find((event: any) => event.stage === 'server.output.flush-start').ordinal = 1;
    expect(() => validateRepetition(row)).toThrow(/post-ACK boundary/i);
  });

  it('rejects copied CPU throttle scalars without measured calibration evidence', () => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    row.cells[1].cpuCalibration.throttledSamplesMs = [10, 10, 10, 10, 10];
    row.cells[1].cpuCalibration.throttledMedianMs = 10;
    row.cells[1].cpuCalibration.ratio = 1;
    expect(() => validateRepetition(row)).toThrow(/CPU throttle calibration/i);
  });

  it.each([
    [
      'server start before repetition',
      (row: any) => (row.provenance.process.server.startedAt = '2026-08-23T00:00:00Z'),
    ],
    [
      'browser start after repetition',
      (row: any) => (row.provenance.process.browser.startedAt = '2026-08-25T00:00:00Z'),
    ],
  ])('rejects %s', (_name, mutate) => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    mutate(row);
    expect(() => validateRepetition(row)).toThrow(/start.*repetition|process/i);
  });

  it.each([
    ['OpenCode', (probes: any) => (probes.readOpenCodeVersion = () => 'unexpected-version')],
    ['viewport', (probes: any) => (probes.readViewport = () => ({ width: 391, height: 844 }))],
    ['font', (probes: any) => (probes.readFontPx = () => 99)],
    ['CDP throttle', (probes: any) => (probes.readRealizedCpuThrottle = () => 3.9)],
    [
      'server process',
      (probes: any) => (probes.readServerProcess = () => ({ pid: 1, startedAt: '2026-08-24T00:00:00Z' })),
    ],
    [
      'browser process',
      (probes: any) => (probes.readBrowserProcess = () => ({ pid: 2, startedAt: '2026-08-24T00:00:00Z' })),
    ],
    [
      'OpenCode process',
      (probes: any) => (probes.readOpenCodeProcess = () => ({ pid: 3, startedAt: '2026-08-24T00:00:00Z' })),
    ],
  ])('runtime verifier rejects mismatched measured %s', (_name, mutate) => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    const probes: any = runtimeProbes(row);
    mutate(probes);
    const proof = measureRuntimeObservation(row, probes);
    expect(() => verifyRuntimeObservation(row, proof)).toThrow(/runtime.*mismatch/i);
  });

  it('requires globally unique client plus sequence identity', () => {
    const rows: any[] = completeDiagnostic();
    const duplicate = rows[0].cells[0].samples[0].inputs[0];
    const sample = rows[1].cells[0].samples[0];
    const original = { ...sample.inputs[0] };
    for (const input of sample.inputs) input.clientId = duplicate.clientId;
    sample.inputs[0].seq = duplicate.seq;
    for (const event of sample.evidence.browserEvents) {
      if (event.clientId !== undefined) event.clientId = duplicate.clientId;
      if (event.inputIndex === 0 && event.generation > 0 && event.seq !== undefined) event.seq = duplicate.seq;
    }
    for (const event of sample.evidence.serverEvents) {
      if (event.clientId === original.clientId) event.clientId = duplicate.clientId;
      if (event.seq === original.seq) event.seq = duplicate.seq;
    }
    sample.evidence.firstAcked.clientId = duplicate.clientId;
    sample.evidence.firstAcked.seq = duplicate.seq;
    expect(() => validateDiagnosticMatrix(rows)).toThrow(/global.*input|duplicate/i);
  });

  it('requires fresh process and clock identities in the diagnostic matrix', () => {
    const rows: any[] = completeDiagnostic();
    rows[1].provenance.process.server = { ...rows[0].provenance.process.server };
    expect(() => validateDiagnosticMatrix(rows)).toThrow(/fresh.*process|process.*reused|start.*repetition/i);
    const clocks: any[] = completeDiagnostic();
    clocks[1].clock.browserClockId = clocks[0].clock.browserClockId;
    for (const cell of clocks[1].cells) {
      for (const sample of cell.samples) {
        for (const event of sample.evidence.browserEvents) event.clockId = clocks[0].clock.browserClockId;
      }
    }
    expect(() => validateDiagnosticMatrix(clocks)).toThrow(/fresh.*clock|clock.*reused/i);
  });

  it.each([
    ['free host string', (row: any) => (row.provenance.host.release = '6.8.0')],
    ['raw payload', (row: any) => (row.cells[0].samples[0].payload = 'secret')],
    ['unknown nested field', (row: any) => (row.cells[0].samples[0].evidence.note = 'hidden')],
  ])('rejects privacy/schema violation: %s', (_name, mutate) => {
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    mutate(row);
    expect(() => validateAttempt(row)).toThrow();
  });

  it('rejects process-start uncertainty large enough to make lifecycle overlap vacuous', () => {
    const row: any = completeCalibration()[0];
    row.provenance.process.server.startUncertaintyMs = 1001;
    expect(() => validateAttempt(row)).toThrow(/uncertainty.*1000|process.*uncertainty/i);
  });
});

describe('COD-374 lifecycle and report policy', () => {
  it('accepts exact calibration and diagnostic schedules', () => {
    expect(validateCalibration(completeCalibration()).gate.passed).toBe(true);
    expect(validateDiagnosticMatrix(completeDiagnostic())).toHaveLength(4);
  });

  it('accepts a rejected preflight with nullable process provenance and zero cells', () => {
    expect(validateAttempt(rejectedPreflight())).toMatchObject({ selection: { accepted: false }, cells: [] });
    const report = buildAttributionReport({ attempts: [rejectedPreflight()] });
    expect(report).toMatch(/MEASUREMENT INVALID.*launch-failed/is);
    expect(report).toMatch(/browserClosed=not-allocated.*tmuxRemoved=not-allocated.*hooksRestored=not-allocated/i);
    expect(report).not.toMatch(/browserClosed=false|tmuxRemoved=false|hooksRestored=false/i);
  });

  it('accepts a completed contaminated attempt with full evidence and failure reasons', () => {
    expect(validateAttempt(rejectedCompleted())).toMatchObject({
      selection: { lifecycle: 'completed', accepted: false },
      diagnostics: { longTasks: [{ durationMs: 60 }] },
    });
  });

  it('preserves sample-local long-task evidence in a rejected completed attempt', () => {
    const row: any = rejectedCompleted();
    row.cells[0].samples[0].evidence.longTaskWindow.entries.push({ startedMs: 5, durationMs: 60 });
    expect(validateAttempt(row).cells[0].samples[0].evidence.longTaskWindow.entries).toHaveLength(1);
  });

  it('publishes an honest launched partial attempt with only its captured prefix', () => {
    const row = rejectedPartial();
    expect(validateAttempt(row)).toBe(row);
    row.cells[0].samples.push({ index: 9 });
    expect(() => validateAttempt(row)).toThrow(/sample|field|prefix/i);
  });

  it('rejects a missing or unknown lifecycle state', () => {
    const row: any = rejectedPreflight();
    delete row.selection.lifecycle;
    expect(() => validateAttempt(row)).toThrow(/selection.*field|lifecycle/i);
  });

  it('stops after completed contamination just as it does after preflight rejection', () => {
    expect(() =>
      buildAttributionReport({
        attempts: [completeCalibration()[0], rejectedCompleted(), completeCalibration()[2]],
      })
    ).toThrow(/later attempt.*rejected|stopped/i);
  });

  it('forbids any later attempt after a rejected or contaminated attempt', () => {
    expect(() =>
      buildAttributionReport({ attempts: [rejectedPreflight(), repetition('calibration', 'trace-on', 1, 2)] })
    ).toThrow(/later attempt.*rejected|stopped/i);
  });

  it('requires the exact global schedule with no gaps or selective retry', () => {
    expect(() => buildAttributionReport({ attempts: [repetition('calibration', 'trace-on', 1, 1)] })).toThrow(
      /schedule/i
    );
    expect(() => buildAttributionReport({ attempts: [completeCalibration()[0], completeCalibration()[2]] })).toThrow(
      /attempt.*gap|schedule/i
    );
  });

  it('requires both tracing overhead bounds and never authorizes diagnostic after failure', () => {
    const calibration: any[] = completeCalibration();
    for (const row of calibration) setDuration(row, 100);
    setDuration(calibration[1], 105);
    expect(validateCalibration(calibration).gate.passed).toBe(true);
    setDuration(calibration[1], 105.01);
    expect(validateCalibration(calibration).gate.passed).toBe(false);
    expect(() => buildAttributionReport({ attempts: [...calibration, ...completeDiagnostic()] })).toThrow(
      /diagnostic.*overhead|after.*failed/i
    );
    expect(buildAttributionReport({ attempts: calibration })).toMatch(/MEASUREMENT INVALID.*OVERHEAD/is);
  });

  it('prints complete recomputed per-sample component-local evidence without hard-coded correctness', () => {
    const report = buildAttributionReport({ attempts: allAttempts() });
    expect(report).toMatch(/runtime vendor [0-9a-f]{64}/i);
    expect(report).toMatch(/inputs [0-9a-f]{16}\/seq-\d+/i);
    expect(report).toMatch(/browser\.keydown→browser\.xterm-on-data/i);
    expect(report).toMatch(/correctness browser ACKs 3, server applied 3, server writes 3, server ACKs 3/i);
    expect(report).toMatch(/pane visible; pane results .*; probes 6; errors 0/i);
    expect(report).toMatch(/browser events 34; server events 37; output ordinals/i);
    expect(report).toMatch(/component-local.*cross-domain.*inconclusive/i);
  });

  it('prints retained per-sample evidence in an invalid contaminated report', () => {
    const row: any = rejectedPartial(1);
    row.config.label = 'trace-off';
    row.config.traceEnabled = false;
    for (const sample of row.cells[0].samples) {
      sample.evidence.serverEvents = [];
      sample.evidence.firstAcked.serverOrdinal = null;
    }
    const report = buildAttributionReport({ attempts: [row] });
    expect(report).toMatch(/MEASUREMENT INVALID/i);
    expect(report).toMatch(/Complete retained sample evidence/i);
    expect(report).toMatch(/browser\.keydown→browser\.xterm-on-data/i);
    expect(report).toMatch(/pane interval .*multiplicity .*long-task window/i);
  });
});

describe('COD-374 overlay and runtime provenance', () => {
  it('requires retained runtime vendor proof only after a runtime is proven', () => {
    const accepted: any = repetition('calibration', 'trace-off', 1, 1);
    accepted.provenance.runtimeVendorHash = null;
    expect(() => validateAttempt(accepted)).toThrow(/runtime vendor proof/i);
    const preflight: any = rejectedPreflight();
    preflight.provenance.runtimeVendorHash = HASH64;
    expect(() => validateAttempt(preflight)).toThrow(/preflight.*runtime vendor proof/i);
    const completed: any = rejectedCompleted();
    completed.provenance.runtimeVendorHash = null;
    expect(() => validateAttempt(completed)).toThrow(/runtime vendor proof/i);
    const partial: any = rejectedPartial();
    partial.provenance.runtimeVendorHash = null;
    expect(() => validateAttempt(partial)).toThrow(/runtime vendor proof/i);
    const mixedCrash: any = rejectedPartial();
    mixedCrash.provenance.runtimeVendorHash = null;
    mixedCrash.selection.failureReasons.push({ code: 'producer-crash', detailHash: 'abcdef0123456789' });
    expect(() => validateAttempt(mixedCrash)).toThrow(/runtime vendor proof|producer crash/i);
    const crashWithClaim: any = rejectedPreflight();
    const crashHash = createHash('sha256').update('producer-crash').digest('hex').slice(0, 16);
    crashWithClaim.selection = {
      attempt: 1,
      lifecycle: 'partial',
      accepted: false,
      failureReasons: [{ code: 'producer-crash', detailHash: crashHash }],
    };
    crashWithClaim.provenance.runtimeVendorHash = HASH64;
    crashWithClaim.provenance.process = {
      runId: 'abcdef0123456789',
      tmuxSessionHash: null,
      tempRootHash: null,
      server: null,
      browser: null,
      opencode: null,
    };
    crashWithClaim.diagnostics = {
      traceOverflowed: false,
      observerErrorHashes: [],
      pageErrorHashes: [],
      consoleErrorHashes: [],
      processReplaced: false,
      resizeEvents: [],
      longTasks: [],
      errorHashes: [crashHash],
      serverStdoutHashes: [],
      serverStderrHashes: [],
      startupStageHashes: [crashHash],
      startupNameHashes: [],
      startupMessageHashes: [],
    };
    crashWithClaim.allocation = Object.fromEntries(Object.keys(crashWithClaim.allocation).map((key) => [key, true]));
    crashWithClaim.cleanup = Object.fromEntries(Object.keys(crashWithClaim.cleanup).map((key) => [key, false]));
    expect(() => validateAttempt(crashWithClaim)).toThrow(/producer crash.*runtime vendor|runtime vendor.*crash/i);
  });

  it('reads patch bytes once, applies through stdin, and includes added files from porcelain-z status', async () => {
    const patch = Buffer.from('reviewed patch bytes');
    const patchSha256 = createHash('sha256').update(patch).digest('hex');
    const contents = new Map(OVERLAY_FILES.map((file) => [file, Buffer.from(`instrumented:${file}`)]));
    const files = OVERLAY_FILES.map((file) => ({
      file,
      mode: '100644',
      sha256: createHash('sha256').update(contents.get(file)!).digest('hex'),
    }));
    const manifestSha256 = createHash('sha256')
      .update(files.map((entry) => `${entry.file}\0${entry.mode}\0${entry.sha256}\n`).join(''))
      .digest('hex');
    const patchPath = resolve('/evidence/candidate.patch');
    let patchReads = 0;
    const calls: Array<{ args: string[]; input?: Buffer }> = [];
    await expect(
      verifyOverlayArtifact(
        { product: CANDIDATE_PRODUCT, patchPath, patchSha256, files, manifestSha256 },
        {
          read: async (file: string) => {
            if (file === patchPath) {
              patchReads += 1;
              return patch;
            }
            return contents.get(file)!;
          },
          stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }),
          createWorktree: async () => '/tmp/cod374-overlay-fixture',
          git: async (args: string[], _root: string, input?: Buffer) => {
            calls.push({ args, input });
            if (args[0] === 'status') return Buffer.from(OVERLAY_FILES.map((file) => ` M ${file}\0`).join(''));
            return Buffer.from('');
          },
          cleanupWorktree: async () => {},
        }
      )
    ).resolves.toEqual({ manifestSha256 });
    expect(patchReads).toBe(1);
    expect(calls.slice(0, 2)).toEqual([
      { args: ['apply', '--check', '-'], input: patch },
      { args: ['apply', '-'], input: patch },
    ]);
    expect(calls.at(-1)?.args).toEqual([
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ]);
  });

  it('rejects files outside the allowlist and treats cleanup failure as fatal', async () => {
    const patch = Buffer.from('patch');
    const row: any = repetition('diagnostic', 'candidate', 1, 5);
    const artifact = {
      product: CANDIDATE_PRODUCT,
      patchPath: '/evidence/candidate.patch',
      patchSha256: createHash('sha256').update(patch).digest('hex'),
      files: row.provenance.overlay.files,
      manifestSha256: row.provenance.overlay.manifestSha256,
    };
    const read = async (file: string) => (file === resolve(artifact.patchPath) ? patch : Buffer.from('x'));
    await expect(
      verifyOverlayArtifact(artifact, {
        read,
        stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }),
        createWorktree: async () => '/tmp/worktree',
        git: async (args: string[]) =>
          args[0] === 'status'
            ? Buffer.from(`${OVERLAY_FILES.map((file) => ` M ${file}\0`).join('')}?? evil.ts\0`)
            : Buffer.from(''),
        cleanupWorktree: async () => {},
      })
    ).rejects.toThrow(/allowlist/i);
    await expect(
      verifyOverlayArtifact(artifact, {
        read,
        stat: async () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o100644 }),
        createWorktree: async () => '/tmp/worktree',
        git: async () => Buffer.from(''),
        cleanupWorktree: async () => {
          throw new Error('cleanup failed');
        },
      })
    ).rejects.toThrow(/cleanup failed/i);
  });

  it('verifies clean executing Git objects and dependency hashes', async () => {
    const rows: any[] = completeDiagnostic();
    const content = Buffer.from('fixture harness object');
    const lock = Buffer.from('lock');
    const vendor = Buffer.from('vendor');
    for (const row of rows) {
      for (const file of row.provenance.harness.files) file.sha256 = createHash('sha256').update(content).digest('hex');
      row.provenance.dependencies.packageLockSha256 = createHash('sha256').update(lock).digest('hex');
      row.provenance.dependencies.vendorManifestSha256 = createHash('sha256').update(vendor).digest('hex');
    }
    const git = async (args: string[]) => {
      const spec = args.at(-1)!;
      if (args[0] === 'show') return content;
      if (args[0] === 'status') return Buffer.from('');
      if (spec === 'HEAD') return Buffer.from(`${HARNESS_COMMIT}\n`);
      if (spec === `${HARNESS_COMMIT}^{tree}`) return Buffer.from(`${HARNESS_TREE}\n`);
      if (spec.endsWith('^{tree}')) {
        const product = spec.startsWith(BASELINE_PRODUCT.sha) ? BASELINE_PRODUCT : CANDIDATE_PRODUCT;
        return Buffer.from(`${product.tree}\n`);
      }
      return Buffer.from(`${BLOB}\n`);
    };
    await expect(
      verifyRepositoryProvenance(rows, {
        repositoryRoot: '/repo',
        packageLockPath: '/repo/package-lock.json',
        vendorManifestPath: '/external/vendor.json',
        git,
        read: async (file: string) => (file.endsWith('package-lock.json') ? lock : vendor),
      })
    ).resolves.toBeUndefined();
  });
});

describe('COD-374 evidence-source transaction and publication', () => {
  it('requires a real clean-repository preflight proof for completed attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row: any = completeCalibration()[0];
    let checked = 0;
    const preflightProof = await verifyExperimentPreflight({
      repetition: row,
      repositoryRoot: '/repo',
      vendorManifestPath: '/vendor.json',
      gitVerifier: async () => {
        checked += 1;
      },
    });
    expect(checked).toBe(1);
    await expect(
      publishExperimentAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
      })
    ).rejects.toThrow(/preflight/i);
    await expect(
      publishExperimentAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
        preflightProof,
      })
    ).resolves.toBeDefined();
  });

  it('rejects a preflight proof bound to different frozen provenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row: any = completeCalibration()[0];
    const preflightProof = await verifyExperimentPreflight({
      repetition: row,
      repositoryRoot: '/repo',
      vendorManifestPath: '/vendor.json',
      gitVerifier: async () => {},
    });
    row.provenance.dependencies.vendorManifestSha256 = 'f'.repeat(64);
    await expect(
      publishExperimentAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
        preflightProof,
      })
    ).rejects.toThrow(/preflight.*provenance/i);
  });

  it('recovers a crash after immutable evidence and before ledger regeneration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row: any = completeCalibration()[0];
    await expect(
      publishAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
        afterEvidence: async () => {
          throw new Error('crash-after-evidence');
        },
      })
    ).rejects.toThrow(/crash-after-evidence/);
    expect(await readdir(join(root, 'attempts'))).toEqual(['attempt-0001.json']);
    const manifest = await reconcileExperimentLedger(root);
    expect(manifest.attempts).toHaveLength(1);
    expect(await reconcileExperimentLedger(root)).toEqual(manifest);
  });

  it('immutably publishes a launched partial attempt without inventing missing cells', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row: any = rejectedPartial(1);
    row.config.label = 'trace-off';
    row.config.traceEnabled = false;
    for (const sample of row.cells[0].samples) {
      sample.evidence.serverEvents = [];
      sample.evidence.firstAcked.serverOrdinal = null;
    }
    const preflightProof = await verifyExperimentPreflight({
      repetition: row,
      repositoryRoot: '/repo',
      vendorManifestPath: '/vendor.json',
      gitVerifier: async () => {},
    });
    const runtimeProof = runtimeObservation(row);
    await publishExperimentAttempt({
      experimentRoot: root,
      repositoryRoot: '/repo',
      repetition: row,
      preflightProof,
      runtimeObservation: runtimeProof,
    });
    const stored = JSON.parse(await readFile(join(root, 'attempts', 'attempt-0001.json'), 'utf8'));
    expect(stored.selection.lifecycle).toBe('partial');
    expect(stored.cells).toHaveLength(1);
    expect(stored.cells[0].samples).toHaveLength(3);
  });

  it('recovers idempotently when the process crashes after ledger regeneration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row: any = completeCalibration()[0];
    await expect(
      publishAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
        afterLedger: async () => {
          throw new Error('crash-after-ledger');
        },
      })
    ).rejects.toThrow(/crash-after-ledger/);
    expect((await reconcileExperimentLedger(root)).attempts).toHaveLength(1);
  });

  it('rejects a symlink ledger manifest instead of replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const target = join(root, 'target.json');
    await writeFile(target, '{}');
    await symlink(target, join(root, 'ledger.json'));
    await expect(reconcileExperimentLedger(root)).rejects.toThrow(/manifest.*symlink|symlink/i);
  });

  it('regenerates a partial manifest and rejects a concurrent or stale lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row: any = completeCalibration()[0];
    await publishAttempt({
      experimentRoot: root,
      repositoryRoot: '/repo',
      repetition: row,
      runtimeObservation: runtimeObservation(row),
    });
    await writeFile(join(root, 'ledger.json'), '{"partial":');
    expect((await reconcileExperimentLedger(root)).attempts).toHaveLength(1);
    await writeFile(join(root, '.cod374-experiment.lock'), 'locked');
    await expect(reconcileExperimentLedger(root)).rejects.toThrow(/lock|concurrent/i);
  });

  it('recovers a lock left by an actually killed child process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const lockPath = join(root, '.cod374-experiment.lock');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const fs=require('fs');const s=fs.readFileSync('/proc/self/stat','utf8');const f=s.slice(s.lastIndexOf(')')+2).split(' ');fs.writeFileSync(${JSON.stringify(lockPath)},JSON.stringify({pid:process.pid,startIdentity:f[19]}));process.stdout.write('ready\\n');setInterval(()=>{},1000);`,
      ],
      { stdio: ['ignore', 'pipe', 'inherit'] }
    );
    await new Promise<void>((resolveReady, rejectReady) => {
      child.once('error', rejectReady);
      child.stdout.once('data', () => resolveReady());
    });
    expect(await processStartIdentity(child.pid!)).toMatch(/^\d+$/);
    child.kill('SIGKILL');
    await new Promise<void>((resolveExit) => child.once('close', () => resolveExit()));
    await expect(reconcileExperimentLedger(root)).resolves.toMatchObject({ attempts: [] });
  });

  it.each(['afterLockLink', 'afterReclaimLink'])(
    'recovers an actual SIGKILL at the %s transaction crash point',
    async (hook) => {
      const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
      if (hook === 'afterReclaimLink') {
        await writeFile(join(root, '.cod374-experiment.lock'), canonicalJson({ pid: 999_999_999, startIdentity: '0' }));
      }
      const modulePath = resolve('scripts/perf/cod-374-summarize.mjs');
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {reconcileExperimentLedger} from ${JSON.stringify(`file://${modulePath}`)};await reconcileExperimentLedger(process.argv[1],{[process.argv[2]]:async()=>process.kill(process.pid,'SIGKILL')});`,
          root,
          hook,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] }
      );
      await new Promise<void>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('close', () => resolveExit());
      });
      await expect(reconcileExperimentLedger(root)).resolves.toMatchObject({ attempts: [] });
      expect(await readdir(join(root, '.staging'))).toEqual([]);
    }
  );

  it('does not unlink an incomplete lock staging record owned by a live publisher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const staging = join(root, '.staging');
    await mkdir(staging, { mode: 0o700 });
    const staged = join(staging, `.lock-${process.pid}-1234567890abcdef.tmp`);
    await writeFile(staged, '{');
    await expect(reconcileExperimentLedger(root)).rejects.toThrow(/active|lock/i);
    expect(await readFile(staged, 'utf8')).toBe('{');
  });

  it.each([
    ['after-staging', 'afterStaging', 0],
    ['after-link', 'afterLink', 1],
  ])('recovers an actual SIGKILL %s publication crash', async (_label, hook, expectedAttempts) => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row = rejectedPreflight();
    const encoded = Buffer.from(JSON.stringify(row)).toString('base64');
    const modulePath = resolve('scripts/perf/cod-374-summarize.mjs');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {publishExperimentAttempt} from ${JSON.stringify(`file://${modulePath}`)};const row=JSON.parse(Buffer.from(process.argv[1],'base64'));await publishExperimentAttempt({experimentRoot:process.argv[2],repositoryRoot:'/repo',repetition:row,[process.argv[3]]:async()=>process.kill(process.pid,'SIGKILL')});`,
        encoded,
        root,
        hook,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', () => resolveExit());
    });
    const manifest = await reconcileExperimentLedger(root);
    expect(manifest.attempts).toHaveLength(expectedAttempts);
    expect(await readdir(join(root, '.staging'))).toEqual([]);
  });

  it('reconciles orphan evidence before rejecting a malformed proposed attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    await mkdir(join(root, 'attempts'));
    await writeFile(join(root, 'attempts', 'attempt-0001.json'), canonicalJson(completeCalibration()[0]));
    const malformed: any = completeCalibration()[1];
    malformed.unknown = true;
    await expect(
      publishExperimentAttempt({ experimentRoot: root, repositoryRoot: '/repo', repetition: malformed })
    ).rejects.toThrow(/unknown|field/i);
    expect(JSON.parse(await readFile(join(root, 'ledger.json'), 'utf8')).attempts).toHaveLength(1);
  });

  it.each(['symlink', 'hardlink', 'partial', 'gap'])('rejects %s attempt evidence', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const attempts = join(root, 'attempts');
    await mkdir(attempts);
    const row = completeCalibration()[0];
    const first = join(attempts, 'attempt-0001.json');
    await writeFile(first, canonicalJson(row));
    if (kind === 'symlink') await symlink(first, join(attempts, 'attempt-0002.json'));
    else if (kind === 'hardlink') await link(first, join(attempts, 'attempt-0002.json'));
    else if (kind === 'partial') await writeFile(join(attempts, 'attempt-0002.json'), '{');
    else
      await writeFile(join(attempts, 'attempt-0003.json'), canonicalJson(repetition('calibration', 'trace-off', 2, 3)));
    await expect(reconcileExperimentLedger(root)).rejects.toThrow(/symlink|hardlink|partial|gap|attempt/i);
  });

  it('requires external evidence storage and blocks a later attempt after rejection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    await publishAttempt({ experimentRoot: root, repositoryRoot: '/repo', repetition: rejectedPreflight() });
    const later: any = repetition('calibration', 'trace-on', 1, 2);
    await expect(
      publishAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: later,
        runtimeObservation: runtimeObservation(later),
      })
    ).rejects.toThrow(/stopped|rejected/i);
    await expect(
      publishAttempt({
        experimentRoot: '/repo/docs/reports/cod-374/raw',
        repositoryRoot: '/repo',
        repetition: later,
        runtimeObservation: runtimeObservation(later),
      })
    ).rejects.toThrow(/external/i);
  });

  it('reserves the exact schedule before capture and never invokes an invalid producer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    let calls = 0;
    await expect(
      runExperimentProducerTransaction({
        experimentRoot: root,
        repositoryRoot: '/repo',
        intent: completeCalibration()[1],
        produce: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      })
    ).rejects.toThrow(/schedule|attempt|order/i);
    expect(calls).toBe(0);

    await publishAttempt({ experimentRoot: root, repositoryRoot: '/repo', repetition: rejectedPreflight() });
    await expect(
      runExperimentProducerTransaction({
        experimentRoot: root,
        repositoryRoot: '/repo',
        intent: completeCalibration()[1],
        produce: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      })
    ).rejects.toThrow(/stopped|rejected/i);
    expect(calls).toBe(0);

    const finalizedRoot = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    await writeFile(join(finalizedRoot, 'finalized.json'), '{}');
    await expect(
      runExperimentProducerTransaction({
        experimentRoot: finalizedRoot,
        repositoryRoot: '/repo',
        intent: completeCalibration()[0],
        produce: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      })
    ).rejects.toThrow(/finalized/i);
    expect(calls).toBe(0);

    const failedCalibrationRoot = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const calibration: any[] = completeCalibration();
    for (const row of calibration) setDuration(row, row.config.label === 'trace-on' ? 200 : 100);
    for (const row of calibration) {
      await publishAttempt({
        experimentRoot: failedCalibrationRoot,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
      });
    }
    await expect(
      runExperimentProducerTransaction({
        experimentRoot: failedCalibrationRoot,
        repositoryRoot: '/repo',
        intent: completeDiagnostic()[0],
        produce: async () => {
          calls += 1;
          throw new Error('must not run');
        },
      })
    ).rejects.toThrow(/diagnostic|overhead|gate/i);
    expect(calls).toBe(0);
  });

  it('turns an actual SIGKILL after reservation into immutable rejected evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const modulePath = resolve('scripts/perf/cod-374-summarize.mjs');
    const intentPath = join(root, 'test-intent.json');
    await writeFile(intentPath, JSON.stringify(completeCalibration()[0]));
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import fs from 'node:fs';import {runExperimentProducerTransaction} from ${JSON.stringify(`file://${modulePath}`)};const intent=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));await runExperimentProducerTransaction({experimentRoot:process.argv[2],repositoryRoot:'/repo',intent,afterReservation:async()=>process.kill(process.pid,'SIGKILL'),produce:async()=>{throw new Error('unreachable')}});`,
        intentPath,
        root,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', () => resolveExit());
    });
    const manifest = await reconcileExperimentLedger(root);
    expect(manifest.attempts).toHaveLength(1);
    const row = JSON.parse(await readFile(join(root, 'attempts', 'attempt-0001.json'), 'utf8'));
    expect(row).toMatchObject({
      selection: { lifecycle: 'partial', accepted: false, failureReasons: [{ code: 'producer-crash' }] },
      provenance: { runtimeVendorHash: null },
      cleanup: { browserClosed: false, serverStopped: false },
    });
    await expect(
      runExperimentProducerTransaction({
        experimentRoot: root,
        repositoryRoot: '/repo',
        intent: completeCalibration()[0],
        produce: async () => {
          throw new Error('must not retry');
        },
      })
    ).rejects.toThrow(/stopped|rejected/i);
  });

  it('retains cleanup-bearing evidence when publication rejects the runtime observation proof', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    const row = completeCalibration()[0];
    const preflightProof = await verifyExperimentPreflight({
      repetition: row,
      repositoryRoot: '/repo',
      vendorManifestPath: '/vendor.json',
      gitVerifier: async () => {},
    });
    const mismatchedObservation = measureRuntimeObservation(row, {
      ...runtimeProbes(row),
      readFontPx: () => 16,
    });

    await expect(
      runExperimentProducerTransaction({
        experimentRoot: root,
        repositoryRoot: '/repo',
        intent: row,
        produce: async () => ({ repetition: row, runtimeObservation: mismatchedObservation, preflightProof }),
      })
    ).resolves.toEqual(expect.objectContaining({ attempts: [expect.objectContaining({ accepted: false })] }));

    const published = JSON.parse(await readFile(join(root, 'attempts', 'attempt-0001.json'), 'utf8'));
    const mismatch = 'Error: COD-374 evidence invalid: runtime observation mismatch';
    expect(published.selection).toEqual({
      attempt: 1,
      lifecycle: 'partial',
      accepted: false,
      failureReasons: [
        { code: 'runtime-proof-failed', detailHash: createHash('sha256').update(mismatch).digest('hex').slice(0, 16) },
      ],
    });
    expect(published.cells).toHaveLength(2);
    expect(published.cells.every((cell: any) => cell.samples.length === 10)).toBe(true);
    expect(published.cleanup).toEqual(row.cleanup);
    expect(published.diagnostics.errorHashes).toContain(
      createHash('sha256').update(mismatch).digest('hex').slice(0, 16)
    );
    expect(published.diagnostics.startupStageHashes).toContain(
      createHash('sha256').update('runtime-proof').digest('hex').slice(0, 16)
    );
    expect(published.selection.failureReasons).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'producer-crash' })])
    );
    expect(JSON.stringify(published)).not.toContain('runtime observation mismatch');
  });

  it('rejects an external-looking symlink whose real path is inside the repository', async () => {
    const container = await mkdtemp(join(tmpdir(), 'cod374-root-check-'));
    const repositoryRoot = join(container, 'repo');
    const inside = join(repositoryRoot, 'evidence');
    await mkdir(inside, { recursive: true });
    const alias = join(container, 'alias');
    await symlink(inside, alias);
    await expect(
      publishExperimentAttempt({ experimentRoot: alias, repositoryRoot, repetition: rejectedPreflight() })
    ).rejects.toThrow(/external/i);
  });

  it('rejects nested, broad, or unsafe-mode experiment roots on every API entry', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'cod374-parent-'));
    const nested = join(parent, 'cod374-nested');
    await mkdir(nested, { mode: 0o700 });
    await expect(reconcileExperimentLedger(nested)).rejects.toThrow(/direct cod374|temporary/i);
    await expect(reconcileExperimentLedger(tmpdir())).rejects.toThrow(/0700|owner|direct cod374|temporary/i);
    const unsafe = await mkdtemp(join(tmpdir(), 'cod374-unsafe-'));
    await chmod(unsafe, 0o755);
    await expect(reconcileExperimentLedger(unsafe)).rejects.toThrow(/0700|mode/i);
  });

  it('validates the manifest against every attempt file and no extras', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    for (const row of completeCalibration()) {
      await publishAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
      });
    }
    const manifest = await reconcileExperimentLedger(root);
    expect(validateExperimentLedger(manifest, completeCalibration())).toHaveLength(3);
    await writeFile(join(root, 'attempts', 'extra.json'), '{}');
    await expect(reconcileExperimentLedger(root)).rejects.toThrow(/extra|filename/i);
  });

  it('publishes the report exclusively with fsynced atomic semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-report-'));
    const reportPath = join(root, 'report.md');
    await publishAttributionReport(reportPath, 'report');
    await expect(publishAttributionReport(reportPath, 'other')).rejects.toThrow(/exist|stale/i);
    expect((await readdir(root)).filter((file) => file.includes('.tmp-'))).toEqual([]);
  });

  it('recovers an actual report SIGKILL after link without losing or replacing the target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-report-'));
    const reportPath = join(root, 'report.md');
    const modulePath = resolve('scripts/perf/cod-374-summarize.mjs');
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {publishAttributionReport} from ${JSON.stringify(`file://${modulePath}`)};await publishAttributionReport(process.argv[1],'durable-report',{afterLink:async()=>process.kill(process.pid,'SIGKILL')});`,
        reportPath,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );
    await new Promise<void>((resolveExit, rejectExit) => {
      child.once('error', rejectExit);
      child.once('close', () => resolveExit());
    });
    await publishAttributionReport(reportPath, 'durable-report');
    expect(await readFile(reportPath, 'utf8')).toBe('durable-report\n');
    expect(await readdir(join(root, '.staging'))).toEqual([]);
  });

  it.each(['afterFinalizingLink', 'afterFinalizedLink'])(
    'recovers an actual %s SIGKILL and completes finalization idempotently',
    async (hook) => {
      const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
      await publishExperimentAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: rejectedPreflight(),
      });
      const outputDirectory = await mkdtemp(join(tmpdir(), 'cod374-output-'));
      const outputPath = join(outputDirectory, 'report.md');
      const modulePath = resolve('scripts/perf/cod-374-summarize.mjs');
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {summarizeExperiment} from ${JSON.stringify(`file://${modulePath}`)};await summarizeExperiment({experimentRoot:process.argv[1],outputDirectory:process.argv[2],outputPath:process.argv[3],repositoryRoot:'/repo',[process.argv[4]]:async()=>process.kill(process.pid,'SIGKILL')});`,
          root,
          outputDirectory,
          outputPath,
          hook,
        ],
        { stdio: ['ignore', 'ignore', 'inherit'] }
      );
      await new Promise<void>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('close', () => resolveExit());
      });
      await expect(
        summarizeExperiment({
          experimentRoot: root,
          outputDirectory,
          outputPath,
          repositoryRoot: '/repo',
        })
      ).resolves.toMatch(/MEASUREMENT INVALID/i);
      expect(await readdir(join(root, '.staging'))).toEqual([]);
      expect(JSON.parse(await readFile(join(root, 'finalized.json'), 'utf8')).reportName).toBe('report.md');
    }
  );

  it('reconciles the experiment before summarization and includes every attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
    for (const row of allAttempts()) {
      await publishAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: row,
        runtimeObservation: runtimeObservation(row),
      });
    }
    const outputDirectory = await mkdtemp(join(tmpdir(), 'cod374-output-'));
    const output = join(outputDirectory, 'report.md');
    await summarizeExperiment({
      experimentRoot: root,
      outputDirectory,
      outputPath: output,
      repositoryRoot: '/repo',
      vendorManifestPath: '/vendor.json',
      candidateOverlayPath: '/candidate.patch',
      baselineOverlayPath: '/baseline.patch',
      gitVerifier: async () => {},
      overlayVerifier: async () => ({ manifestSha256: HASH64 }),
    });
    expect(await readFile(output, 'utf8')).toMatch(/INCONCLUSIVE ACROSS CLOCK DOMAINS/);
    expect(JSON.parse(await readFile(join(root, 'finalized.json'), 'utf8')).experimentId).toBe(EXPERIMENT_ID);
    const otherOutputDirectory = await mkdtemp(join(tmpdir(), 'cod374-output-other-'));
    await expect(
      summarizeExperiment({
        experimentRoot: root,
        outputDirectory: otherOutputDirectory,
        outputPath: join(otherOutputDirectory, 'report.md'),
        repositoryRoot: '/repo',
        vendorManifestPath: '/vendor.json',
        candidateOverlayPath: '/candidate.patch',
        baselineOverlayPath: '/baseline.patch',
        gitVerifier: async () => {},
        overlayVerifier: async () => ({ manifestSha256: HASH64 }),
      })
    ).rejects.toThrow(/finalized marker mismatch/i);
    await expect(
      publishExperimentAttempt({
        experimentRoot: root,
        repositoryRoot: '/repo',
        repetition: rejectedPreflight(8),
      })
    ).rejects.toThrow(/finalized/i);
    await unlink(join(root, 'finalized.json'));
    const linkedFinalized = join(outputDirectory, 'linked-finalized.json');
    await writeFile(linkedFinalized, canonicalJson({ linked: true }));
    await symlink(linkedFinalized, join(root, 'finalized.json'));
    await expect(
      summarizeExperiment({
        experimentRoot: root,
        outputDirectory,
        outputPath: output,
        repositoryRoot: '/repo',
        vendorManifestPath: '/vendor.json',
        candidateOverlayPath: '/candidate.patch',
        baselineOverlayPath: '/baseline.patch',
        gitVerifier: async () => {},
        overlayVerifier: async () => ({ manifestSha256: HASH64 }),
      })
    ).rejects.toThrow(/special|linked/i);
    await unlink(join(root, 'finalized.json'));
    await summarizeExperiment({
      experimentRoot: root,
      outputDirectory,
      outputPath: output,
      repositoryRoot: '/repo',
      vendorManifestPath: '/vendor.json',
      candidateOverlayPath: '/candidate.patch',
      baselineOverlayPath: '/baseline.patch',
      gitVerifier: async () => {},
      overlayVerifier: async () => ({ manifestSha256: HASH64 }),
    });
    expect(JSON.parse(await readFile(join(root, 'finalized.json'), 'utf8')).reportName).toBe('report.md');
  });

  it.each(['repository-dirty', 'dependency-mismatch', 'overlay-verification-failed'])(
    'publishes an honest INVALID %s preflight report without rerunning the failed verifier',
    async (code) => {
      const root = await mkdtemp(join(tmpdir(), 'cod374-experiment-'));
      const row: any = rejectedPreflight();
      row.selection.failureReasons = [{ code, detailHash: '7777777777777777' }];
      await publishExperimentAttempt({ experimentRoot: root, repositoryRoot: '/repo', repetition: row });
      const outputDirectory = await mkdtemp(join(tmpdir(), 'cod374-output-'));
      let verifierCalls = 0;
      const report = await summarizeExperiment({
        experimentRoot: root,
        outputDirectory,
        outputPath: join(outputDirectory, 'report.md'),
        repositoryRoot: '/repo',
        gitVerifier: async () => {
          verifierCalls += 1;
          throw new Error('failed prerequisite must not rerun');
        },
        overlayVerifier: async () => {
          verifierCalls += 1;
          throw new Error('failed prerequisite must not rerun');
        },
      });
      expect(verifierCalls).toBe(0);
      expect(report).toMatch(new RegExp(`MEASUREMENT INVALID[\\s\\S]*${code}`, 'i'));
    }
  );
});
