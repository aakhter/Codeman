import { mkdir, rename, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { dirname } from 'node:path';

export const APPROVED_HOST_CONDITIONS = Object.freeze(['idle', 'cpu']);
export const APPROVED_APPLICATION_CONDITIONS = Object.freeze(['idle', 'interactive']);
export const MAX_LOAD_DURATION_MS = 60_000;
export const DEFAULT_DUTY_CYCLE = 0.7;
export const APPROVED_ONLY_SCOPES = Object.freeze(['input', 'frontend', 'backend']);

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be at least one sample`);
}

function requireApproved(values, approved, label) {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => !approved.includes(value))) {
    throw new Error(`unsupported ${label}; approved values: ${approved.join(', ')}`);
  }
}

export function validateBenchmarkOptions(options) {
  const validated = { ...options };
  if (!['localhost', '127.0.0.1', '::1'].includes(validated.host)) {
    throw new Error('benchmark host must be loopback');
  }
  if (!Number.isSafeInteger(validated.port) || validated.port < 1 || validated.port > 65_535) {
    throw new Error('benchmark port must be valid');
  }
  if (validated.port === 3002) throw new Error('benchmark must never use production port 3002');
  if (!Number.isFinite(validated.durationMs) || validated.durationMs <= 0) {
    throw new Error('benchmark requires a bounded duration');
  }
  if (validated.durationMs > MAX_LOAD_DURATION_MS) throw new Error('benchmark load window cannot exceed 60 seconds');
  requirePositiveInteger(validated.samples, 'benchmark samples');
  requireApproved(validated.conditions, APPROVED_HOST_CONDITIONS, 'host condition');
  requireApproved(validated.applicationConditions, APPROVED_APPLICATION_CONDITIONS, 'application condition');
  if (!Number.isSafeInteger(validated.logicalCpuCount) || validated.logicalCpuCount < 1) {
    throw new Error('logical CPU count must be a positive integer');
  }
  if (!Number.isSafeInteger(validated.workers) || validated.workers < 0) {
    throw new Error('load workers must be a non-negative integer');
  }
  if (validated.workers >= validated.logicalCpuCount && validated.workers !== 0) {
    throw new Error('load workers must leave one logical CPU unused');
  }
  return validated;
}

export function parseOnlySelection(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('--only requires at least one scope');
  if (values.includes('all')) {
    if (values.length !== 1) throw new Error('--only all cannot combine with another scope');
    return { input: true, frontend: true, backend: true };
  }
  const unsupported = values.filter((value) => !APPROVED_ONLY_SCOPES.includes(value));
  if (unsupported.length) throw new Error(`unsupported --only scope: ${unsupported.join(', ')}`);
  const selected = new Set(values);
  return Object.fromEntries(APPROVED_ONLY_SCOPES.map((scope) => [scope, selected.has(scope)]));
}

function nearestRank(sorted, percentile) {
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0 || samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error('samples must be a non-empty array of finite numbers');
  }
  const raw = [...samples];
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  const statistics = {
    samples: raw,
    count: raw.length,
    sampleCount: raw.length,
    percentileEstimator: 'nearest-rank',
    min: sorted[0],
    median,
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    max: sorted.at(-1),
  };
  const round = (value) => Math.round(value * 1_000) / 1_000;
  return {
    ...statistics,
    presentation: Object.fromEntries(
      ['min', 'median', 'p95', 'p99', 'max'].map((key) => [key, round(statistics[key])])
    ),
  };
}

export function calculateProcCpuPercent({ beforeTicks, afterTicks, elapsedMs, clockTicksPerSecond }) {
  if (!Number.isFinite(clockTicksPerSecond) || clockTicksPerSecond <= 0) {
    return { value: null, reason: 'clock ticks per second unavailable' };
  }
  if (![beforeTicks, afterTicks, elapsedMs].every(Number.isFinite) || elapsedMs <= 0) {
    return { value: null, reason: 'proc CPU sample unavailable' };
  }
  return {
    value: (Math.max(0, afterTicks - beforeTicks) / clockTicksPerSecond / (elapsedMs / 1_000)) * 100,
    reason: null,
  };
}

function byteCounts(bytes) {
  const counts = new Map();
  for (const byte of bytes) counts.set(byte, (counts.get(byte) ?? 0) + 1);
  return counts;
}

function filterToSharedOccurrences(bytes, sharedCounts) {
  const used = new Map();
  return [...bytes].filter((byte) => {
    const next = (used.get(byte) ?? 0) + 1;
    used.set(byte, next);
    return next <= (sharedCounts.get(byte) ?? 0);
  });
}

function longestCommonSubsequenceLength(left, right) {
  const row = new Uint32Array(right.length + 1);
  for (const leftByte of left) {
    let diagonal = 0;
    for (let index = 1; index <= right.length; index++) {
      const previous = row[index];
      row[index] = leftByte === right[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = previous;
    }
  }
  return row[right.length];
}

export function diffByteSequences(expectedInput, receivedInput) {
  const expected = Buffer.from(expectedInput);
  const received = Buffer.from(receivedInput);
  const expectedCounts = byteCounts(expected);
  const receivedCounts = byteCounts(received);
  const byteValues = new Set([...expectedCounts.keys(), ...receivedCounts.keys()]);
  let duplicateCount = 0;
  let missingCount = 0;
  const sharedCounts = new Map();
  for (const byte of byteValues) {
    const expectedCount = expectedCounts.get(byte) ?? 0;
    const receivedCount = receivedCounts.get(byte) ?? 0;
    duplicateCount += Math.max(0, receivedCount - expectedCount);
    missingCount += Math.max(0, expectedCount - receivedCount);
    sharedCounts.set(byte, Math.min(expectedCount, receivedCount));
  }
  const sharedExpected = filterToSharedOccurrences(expected, sharedCounts);
  const sharedReceived = filterToSharedOccurrences(received, sharedCounts);
  const sharedLength = [...sharedCounts.values()].reduce((sum, count) => sum + count, 0);
  const reorderedCount = sharedLength - longestCommonSubsequenceLength(sharedExpected, sharedReceived);
  const mismatchIndexes = [];
  for (let index = 0; index < Math.max(expected.length, received.length); index++) {
    if (expected[index] !== received[index]) mismatchIndexes.push(index);
  }
  return {
    expectedBase64: expected.toString('base64'),
    receivedBase64: received.toString('base64'),
    expectedBytes: expected.length,
    receivedBytes: received.length,
    duplicateCount,
    missingCount,
    reorderedCount,
    mismatchIndexes,
    exact: expected.equals(received),
  };
}

export function aggregateEventLoopIntervals(intervals) {
  const valid = intervals.filter(
    (interval) => interval && ['medianMs', 'p95Ms', 'p99Ms', 'maxMs'].every((field) => Number.isFinite(interval[field]))
  );
  if (valid.length === 0) {
    return {
      semantics: 'distribution of per-interval monitorEventLoopDelay fields',
      intervalCount: 0,
      intervalMedianMs: null,
      intervalP95Ms: null,
      intervalP99Ms: null,
      intervalMaxMs: null,
    };
  }
  return {
    semantics: 'distribution of per-interval monitorEventLoopDelay fields',
    intervalCount: valid.length,
    intervalMedianMs: summarizeSamples(valid.map((interval) => interval.medianMs)),
    intervalP95Ms: summarizeSamples(valid.map((interval) => interval.p95Ms)),
    intervalP99Ms: summarizeSamples(valid.map((interval) => interval.p99Ms)),
    intervalMaxMs: summarizeSamples(valid.map((interval) => interval.maxMs)),
  };
}

export function summarizeTmuxTrace(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return {
      available: false,
      reason: 'no tmux wrapper events observed',
      subprocessCount: null,
      maxOverlap: null,
      failures: null,
      incomplete: null,
      durationsMs: [],
    };
  }
  const captureIds = new Set(
    events
      .filter((event) => event.type === 'start' && event.command === 'capture-pane')
      .map((event) => event.invocationId)
  );
  const captureEvents = events
    .filter((event) => captureIds.has(event.invocationId))
    .sort((left, right) => (BigInt(left.timestampNs) < BigInt(right.timestampNs) ? -1 : 1));
  const starts = new Map();
  const durationsMs = [];
  let subprocessCount = 0;
  let failures = 0;
  let active = 0;
  let maxOverlap = 0;
  for (const event of captureEvents) {
    if (event.type === 'start') {
      subprocessCount++;
      active++;
      maxOverlap = Math.max(maxOverlap, active);
      starts.set(event.invocationId, BigInt(event.timestampNs));
    } else if (event.type === 'end') {
      const started = starts.get(event.invocationId);
      if (started !== undefined) {
        durationsMs.push(Number(BigInt(event.timestampNs) - started) / 1e6);
        starts.delete(event.invocationId);
        active = Math.max(0, active - 1);
      }
      if (event.status !== 0) failures++;
    }
  }
  return {
    available: subprocessCount > 0,
    ...(subprocessCount > 0 ? {} : { reason: 'no capture-pane wrapper events observed' }),
    subprocessCount,
    maxOverlap,
    failures,
    incomplete: starts.size,
    durationsMs,
  };
}

export function assertLoadCoverage({ expectedWorkers, minimumActiveWorkers }) {
  if (!Number.isSafeInteger(expectedWorkers) || expectedWorkers < 0) throw new Error('invalid expected worker count');
  if (minimumActiveWorkers < expectedWorkers) {
    throw new Error(`CPU load coverage absent: expected ${expectedWorkers}, observed ${minimumActiveWorkers}`);
  }
  return true;
}

export async function runFixedLoadWindow({ supervisor, samples, runSample }) {
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('samples must be a positive integer');
  const window = supervisor.start();
  try {
    const runCoveredSample = async (sampleIndex) => {
      const run = await supervisor.runWithinDeadline(() => runSample(sampleIndex));
      assertLoadCoverage(run.loadCoverage);
      return run;
    };
    const warmup = await runCoveredSample('warmup');
    const recorded = [];
    for (let sampleIndex = 1; sampleIndex <= samples; sampleIndex++) {
      recorded.push(await runCoveredSample(sampleIndex));
    }
    return { window, warmup, recorded };
  } finally {
    supervisor.stop();
  }
}

export function selectInteractiveFixture(sessionIds, sampleIndex) {
  if (!Array.isArray(sessionIds) || sessionIds.length < 2) {
    throw new Error('interactive condition requires a non-target fixture');
  }
  if (!Number.isSafeInteger(sampleIndex) || sampleIndex < 1) throw new Error('sample index must be positive');
  return sessionIds[1 + ((sampleIndex - 1) % (sessionIds.length - 1))];
}

export async function authenticateDisposableTarget(fetchImpl, { baseUrl, username, password }) {
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const response = await fetchImpl(`${baseUrl}/api/status`, {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`disposable target authentication failed with HTTP ${response.status}`);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.match(/(?:^|,\s*)(codeman_session=[^;,\s]+)/)?.[1];
  if (!cookie) throw new Error('target did not issue an authenticated session cookie');
  return { cookie, payload: await response.json(), authorization };
}

export function formatInputAcknowledgement({ id, timestampNs, bytes }) {
  return `\r\nCOD356_ACK:${id}:${timestampNs}:${Buffer.from(bytes).toString('base64')}\r\n› `;
}

export function deriveLoadProfile({
  logicalCpuCount = availableParallelism(),
  workers = Math.min(8, Math.max(0, logicalCpuCount - 1)),
  dutyCycle = DEFAULT_DUTY_CYCLE,
  durationMs = MAX_LOAD_DURATION_MS,
} = {}) {
  if (!Number.isSafeInteger(logicalCpuCount) || logicalCpuCount < 1) {
    throw new Error('logical CPU count must be a positive integer');
  }
  if (!Number.isSafeInteger(workers) || workers < 0 || workers >= logicalCpuCount) {
    throw new Error('load workers must leave one logical CPU unused');
  }
  if (!Number.isFinite(dutyCycle) || dutyCycle <= 0 || dutyCycle >= 1) {
    throw new Error('load duty cycle must be between zero and one');
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_LOAD_DURATION_MS) {
    throw new Error('load duration must be bounded to 60 seconds');
  }
  const cycleMs = 100;
  const busyIntervalMs = Math.round(cycleMs * dutyCycle);
  return {
    workers,
    dutyCycle,
    durationMs,
    busyIntervalMs,
    idleIntervalMs: cycleMs - busyIntervalMs,
  };
}

export function collectEnvironmentMetadata(extra = {}) {
  const cpuList = cpus();
  return {
    capturedAt: new Date().toISOString(),
    platform: platform(),
    release: release(),
    hostname: hostname(),
    node: process.version,
    architecture: process.arch,
    logicalCpuCount: availableParallelism(),
    cpuModel: cpuList[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
    ...extra,
  };
}

export async function writeJsonArtifact(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tempPath, filePath);
  return filePath;
}

export class WorkerCoverageSupervisor {
  constructor({
    expectedWorkers,
    createWorker,
    registry,
    signal,
    durationMs = MAX_LOAD_DURATION_MS,
    coverageIntervalMs = 100,
    now = () => performance.now(),
    onDeadline = () => undefined,
  }) {
    this.expectedWorkers = expectedWorkers;
    this.createWorker = createWorker;
    this.registry = registry;
    this.signal = signal;
    this.durationMs = durationMs;
    this.coverageIntervalMs = coverageIntervalMs;
    this.now = now;
    this.onDeadline = onDeadline;
    this.active = false;
    this.workers = new Map();
    this.coverage = [];
    this.startedPids = [];
    this.monitor = null;
    this.startedAtMs = null;
    this.deadlineAtMs = null;
  }

  start() {
    this.signal.throwIfAborted();
    if (this.startedAtMs !== null || this.active) throw new Error('CPU load supervisor already started');
    if (!Number.isFinite(this.durationMs) || this.durationMs <= 0 || this.durationMs > MAX_LOAD_DURATION_MS) {
      throw new Error('CPU load window must be positive and cannot exceed 60 seconds');
    }
    this.active = true;
    this.startedAtMs = this.now();
    this.deadlineAtMs = this.startedAtMs + this.durationMs;
    while (this.workers.size < this.expectedWorkers) this.#spawnWorker();
    this.#recordCoverage();
    this.monitor = setInterval(() => this.#recordCoverage(), this.coverageIntervalMs);
    this.monitor.unref?.();
    return { startedAtMs: this.startedAtMs, deadlineAtMs: this.deadlineAtMs, durationMs: this.durationMs };
  }

  loadWindow() {
    if (this.startedAtMs === null) return null;
    return { startedAtMs: this.startedAtMs, deadlineAtMs: this.deadlineAtMs, durationMs: this.durationMs };
  }

  #spawnWorker() {
    if (!this.active || this.signal.aborted) return;
    const child = this.createWorker();
    try {
      this.registry.registerChild(child);
    } catch (error) {
      child.kill('SIGTERM');
      if (!this.signal.aborted) throw error;
      return;
    }
    this.workers.set(child.pid, child);
    this.startedPids.push(child.pid);
    child.once('exit', () => {
      this.workers.delete(child.pid);
      this.#recordCoverage();
    });
  }

  #recordCoverage() {
    const activeWorkers = [...this.workers.values()].filter((child) => child.exitCode === null).length;
    this.coverage.push({ timestamp: Date.now(), activeWorkers });
    return activeWorkers;
  }

  beginSample() {
    this.#assertWithinDeadline();
    this.#recordCoverage();
    return this.coverage.length - 1;
  }

  endSample(marker) {
    this.#assertWithinDeadline();
    this.#recordCoverage();
    const observations = this.coverage.slice(marker);
    const minimumActiveWorkers = Math.min(...observations.map((entry) => entry.activeWorkers));
    assertLoadCoverage({ expectedWorkers: this.expectedWorkers, minimumActiveWorkers });
    return {
      expectedWorkers: this.expectedWorkers,
      minimumActiveWorkers,
      observations,
      workerPidsStarted: [...this.startedPids],
      covered: true,
      loadWindow: {
        startedAtMs: this.startedAtMs,
        deadlineAtMs: this.deadlineAtMs,
        durationMs: this.durationMs,
        sampleCompletedAtMs: this.now(),
      },
    };
  }

  #assertWithinDeadline() {
    if (this.deadlineAtMs === null || this.now() >= this.deadlineAtMs) {
      throw new Error('CPU samples exceeded the approved 60-second load deadline');
    }
  }

  async runWithinDeadline(operation) {
    this.#assertWithinDeadline();
    const remainingMs = this.deadlineAtMs - this.now();
    let timeout;
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('CPU samples exceeded the approved 60-second load deadline');
            this.onDeadline(error);
            reject(error);
          }, remainingMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  stop() {
    this.active = false;
    if (this.monitor) clearInterval(this.monitor);
    this.monitor = null;
    for (const child of this.workers.values()) {
      if (child.connected) child.disconnect();
      if (child.exitCode === null) child.kill('SIGTERM');
    }
    this.#recordCoverage();
  }
}
