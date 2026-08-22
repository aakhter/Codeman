#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { availableParallelism, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

import {
  FIXED_INPUT_TRIALS_PER_SAMPLE,
  INPUT_SETTLE_WINDOW_MS,
  WorkerCoverageSupervisor,
  aggregateEventLoopIntervals,
  assertComparableInputTrialProfiles,
  assertLoadCoverage,
  authenticateDisposableTarget,
  buildCorrelatedInputTimeline,
  buildInputTrialProfile,
  calculateProcCpuPercent,
  collectEnvironmentMetadata,
  createInputTrialPayload,
  deriveLoadProfile,
  diffByteSequences,
  parseOnlySelection,
  runFixedInputTrials,
  runFixedLoadWindow,
  selectInteractiveFixture,
  summarizeTmuxTrace,
  summarizeInputTrialMatrix,
  summarizeSamples,
  validateBenchmarkOptions,
  writeJsonArtifact,
} from './cod-356-metrics.mjs';
import { CleanupRegistry, SignalCleanupController, validateDisposableTmuxSocket } from './cod-356-cleanup.mjs';
import { proveReachedServerOwnership } from './cod-356-safety.mjs';
import { runFixedOfferSchedule, summarizeFixedOfferSchedule } from './cod-356-scheduler.mjs';
import {
  assertCurrentHeadRevision,
  assertGeneratedAssetsStableAtPublication,
  assertGeneratedAssetManifestMatches,
  collectBenchmarkProvenance,
  collectGeneratedRuntimeAssetManifest,
  compactReportFilenamesForPhase,
  guardGeneratedAssetPublication,
  loadCommittedBaselineAssetManifest,
  resolveRuntimeRevisionPolicyFromGit,
  validateBenchmarkPhase,
  writePairedJsonArtifacts,
} from './cod-356-provenance.mjs';
import * as browserTelemetry from './cod-356-browser.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const REPORT_DIR = join(ROOT, 'docs/reports/cod-356');
const HOST = '127.0.0.1';
const APPLICATION_CONDITIONS = ['idle', 'interactive'];
const FIXTURE_COUNT = 15;
const SAMPLE_WINDOW_MS = 2_250;
const API_OFFER_INTERVAL_MS = 50;
const API_OFFERED_COUNT = SAMPLE_WINDOW_MS / API_OFFER_INTERVAL_MS;
const SERIOUS_CONSOLE = /(?:uncaught|unhandled|failed|fatal|error)/i;
const BRANCH_POINT_REVISION = 'a445cdaf645309ce51d8b1431733afa8f0bc55ac';
const RUNTIME_PATHS = ['src', 'packages', 'config', 'scripts/build.mjs', 'package-lock.json'];
const GENERATED_ASSET_POLICY = {
  repositoryRoot: ROOT,
  runtimeRoot: join(ROOT, 'src/web/public'),
  monitoredDirectories: ['vendor'],
  documentedNonRuntimeFiles: ['vendor/exceljs.min.js', 'vendor/fflate.min.js'],
  requiredAssets: [
    'vendor/xterm-addon-fit.min.js',
    'vendor/xterm-addon-serialize.min.js',
    'vendor/xterm-addon-unicode11.min.js',
    'vendor/xterm-addon-webgl.min.js',
    'vendor/xterm-predictive-echo.js',
    'vendor/xterm-zerolag-input.js',
    'vendor/xterm.css',
    'vendor/xterm.min.js',
  ],
  allowedFiles: [
    'vendor/dompurify.min.js',
    'vendor/exceljs.min.js',
    'vendor/fflate.min.js',
    'vendor/marked.min.js',
    'vendor/xterm-addon-fit.min.js',
    'vendor/xterm-addon-serialize.min.js',
    'vendor/xterm-addon-unicode11.min.js',
    'vendor/xterm-addon-webgl.min.js',
    'vendor/xterm-predictive-echo.js',
    'vendor/xterm-zerolag-input.js',
    'vendor/xterm.css',
    'vendor/xterm.min.js',
  ],
};
const HARNESS_PATHS = [
  'scripts/perf/cod-356-benchmark.mjs',
  'scripts/perf/cod-356-cpu-worker.mjs',
  'scripts/perf/cod-356-input-probe.mjs',
  'scripts/perf/cod-356-metrics.mjs',
  'scripts/perf/cod-356-cleanup.mjs',
  'scripts/perf/cod-356-safety.mjs',
  'scripts/perf/cod-356-scheduler.mjs',
  'scripts/perf/cod-356-provenance.mjs',
  'scripts/perf/cod-356-browser.mjs',
  'test/perf-cod-356-harness.test.ts',
  'package.json',
];
const OWNED_TASK_PATHS = [
  ...HARNESS_PATHS,
  'docs/reports/cod-356/baseline-summary.json',
  'docs/reports/cod-356/baseline-environment.json',
  'docs/superpowers/plans/2026-08-22-cod-356-performance-improvements.md',
];

function parseArgs(argv) {
  const options = {
    dryRun: false,
    phase: 'before',
    conditions: ['idle', 'cpu'],
    samples: 5,
    only: ['all'],
    runtimeRevision: undefined,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--phase') options.phase = argv[++index];
    else if (argument === '--conditions') options.conditions = argv[++index].split(',').filter(Boolean);
    else if (argument === '--samples') options.samples = Number(argv[++index]);
    else if (argument === '--only') options.only = argv[++index].split(',').filter(Boolean);
    else if (argument === '--runtime-revision') {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
        throw new Error('--runtime-revision requires a full commit SHA value');
      }
      options.runtimeRevision = argv[++index];
    } else throw new Error(`unknown argument: ${argument}`);
  }
  validateBenchmarkPhase(options.phase);
  if (!Number.isSafeInteger(options.samples) || options.samples < 1)
    throw new Error('samples must be at least one sample');
  options.selection = parseOnlySelection(options.only);
  return options;
}

async function chooseUnusedPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function createRegisteredTempRoot(registry, prefix) {
  const directory = await mkdtemp(prefix);
  try {
    return registry.registerTempRoot(directory);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function launchRegisteredBrowser(registry) {
  const browser = await chromium.launch({ headless: true });
  try {
    return registry.registerBrowser(browser);
  } catch (error) {
    await browser.close();
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function resolveExecutable(name) {
  return new Promise((resolvePath, reject) => {
    execFile('which', [name], (error, stdout) => {
      if (error || !stdout.trim()) reject(new Error(`required executable not found: ${name}`));
      else resolvePath(stdout.trim());
    });
  });
}

async function runTool(file, arguments_, options = {}) {
  return new Promise((resolveResult) => {
    execFile(file, arguments_, options, (error, stdout, stderr) => {
      resolveResult({
        exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

async function cleanupExactTmuxSocket({ realTmux, socketName, socketPath, tmuxTmpDir }) {
  const environment = { ...process.env, TMUX_TMPDIR: tmuxTmpDir };
  const listed = await runTool(realTmux, ['-L', socketName, 'list-sessions', '-F', '#{session_name}'], {
    env: environment,
  });
  if (listed.exitCode === 0) await runTool(realTmux, ['-L', socketName, 'kill-server'], { env: environment });
  const verified = await runTool(realTmux, ['-L', socketName, 'list-sessions'], { env: environment });
  if (verified.exitCode === 0) throw new Error('exact tmux socket still has a live server after fallback cleanup');
  await rm(socketPath, { force: true });
  const socketPresent = await stat(socketPath)
    .then(() => true)
    .catch(() => false);
  return { remainingSessions: 0, socketPresent };
}

async function createProbeShims(binDir, probeLog, tmuxTraceLog, realTmux) {
  await mkdir(binDir, { recursive: true });
  const probePath = join(HERE, 'cod-356-input-probe.mjs');
  for (const binary of ['codex', 'opencode']) {
    const script = `#!/bin/sh
if [ "$1" = "--version" ] || [ "$1" = "version" ]; then
  printf '%s\\n' '${binary} cod356-probe 1.0.0'
  exit 0
fi
export COD356_PROBE_LOG=${shellQuote(probeLog)}
exec ${shellQuote(process.execPath)} ${shellQuote(probePath)} "$@"
`;
    const shimPath = join(binDir, binary);
    await writeFile(shimPath, script, { mode: 0o700 });
    await chmod(shimPath, 0o700);
  }
  const tmuxWrapper = `#!/bin/sh
invocation_id="$$-$(date +%s%N)"
command_name="other"
for argument in "$@"; do
  if [ "$argument" = "capture-pane" ]; then command_name="capture-pane"; fi
done
started_ns="$(date +%s%N)"
printf 'start\\t%s\\t%s\\t%s\\n' "$invocation_id" "$started_ns" "$command_name" >> ${shellQuote(tmuxTraceLog)}
${shellQuote(realTmux)} "$@"
status=$?
ended_ns="$(date +%s%N)"
printf 'end\\t%s\\t%s\\t%s\\n' "$invocation_id" "$ended_ns" "$status" >> ${shellQuote(tmuxTraceLog)}
exit "$status"
`;
  const tmuxPath = join(binDir, 'tmux');
  await writeFile(tmuxPath, tmuxWrapper, { mode: 0o700 });
  await chmod(tmuxPath, 0o700);
}

async function waitForAuthenticatedStatus(baseUrl, child, credentials, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`benchmark server exited with code ${child.exitCode}`);
    try {
      const authentication = await authenticateDisposableTarget(fetch, { baseUrl, ...credentials });
      return await proveReachedServerOwnership({
        baseUrl,
        port: Number(new URL(baseUrl).port),
        spawnedPid: child.pid,
        authenticate: async () => authentication,
      });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`benchmark server did not become ready: ${lastError?.message ?? 'timeout'}`);
}

async function api(baseUrl, auth, method, path, body) {
  const started = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: auth.authorization,
      Cookie: auth.cookie,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.success === false) {
    throw new Error(`${method} ${path} failed (${response.status}): ${JSON.stringify(payload).slice(0, 500)}`);
  }
  return { payload: payload?.data ?? payload, latencyMs: performance.now() - started };
}

async function createFixtures(baseUrl, auth, workingDir, registry, onCleanupStatus, signal) {
  const sessions = [];
  for (let index = 0; index < FIXTURE_COUNT; index++) {
    signal.throwIfAborted();
    const mode = index % 2 === 0 ? 'codex' : 'opencode';
    const { payload } = await api(baseUrl, auth, 'POST', '/api/sessions', {
      mode,
      workingDir,
      name: `cod356-benchmark-${String(index + 1).padStart(2, '0')}`,
      cols: 120,
      rows: 32,
    });
    const session = payload.session ?? payload;
    if (!session?.id) throw new Error(`fixture ${index + 1} did not return a session ID`);
    sessions.push({ id: session.id, mode, name: session.name });
    try {
      registry.registerSession(session.id, async (sessionId) => {
        await api(baseUrl, auth, 'DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`);
        const { payload: remaining } = await api(baseUrl, auth, 'GET', '/api/sessions');
        onCleanupStatus(Array.isArray(remaining) ? remaining.length : null);
      });
    } catch (error) {
      await api(baseUrl, auth, 'DELETE', `/api/sessions/${encodeURIComponent(session.id)}`).catch(() => undefined);
      throw error;
    }
  }
  return sessions;
}

async function readProcSnapshot(pid) {
  if (process.platform !== 'linux') return { supported: false, cpuTicks: null, rssBytes: null };
  const [stat, status] = await Promise.all([
    readFile(`/proc/${pid}/stat`, 'utf8'),
    readFile(`/proc/${pid}/status`, 'utf8'),
  ]);
  const closeParen = stat.lastIndexOf(')');
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const rssKb = Number(status.match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
  return { supported: true, cpuTicks: userTicks + systemTicks, rssBytes: rssKb * 1024 };
}

async function detectClockTicksPerSecond() {
  if (process.platform !== 'linux') return null;
  const result = await runTool('getconf', ['CLK_TCK']);
  const value = Number(result.stdout.trim());
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function readJsonLines(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function readTmuxTrace(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [type, invocationId, timestampNs, detail] = line.split('\t');
      return type === 'start'
        ? { type, invocationId, timestampNs, command: detail }
        : { type, invocationId, timestampNs, status: Number(detail) };
    });
}

async function runBrowserSample({
  browser,
  baseUrl,
  credentials,
  sessionIds,
  applicationCondition,
  probeLog,
  sampleIndex,
  selection,
}) {
  const context = await browser.newContext({
    viewport: { width: 1365, height: 768 },
    httpCredentials: credentials,
  });
  const page = await context.newPage();
  const pageErrors = [];
  const seriousConsoleErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if ((message.type() === 'error' || message.type() === 'warning') && SERIOUS_CONSOLE.test(message.text())) {
      seriousConsoleErrors.push(`${message.type()}: ${message.text()}`);
    }
  });
  await browserTelemetry.installPageInstrumentation(page);
  const navigationStart = performance.now();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  const navigationMs = performance.now() - navigationStart;
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, { timeout: 20_000 });
  const appReadyMs = performance.now() - navigationStart;
  await browserTelemetry.attachAppInstrumentation(page);

  const targetSessionId = sessionIds[0];
  const interactiveSessionId =
    applicationCondition === 'interactive'
      ? sampleIndex === 'warmup'
        ? sessionIds[1]
        : selectInteractiveFixture(sessionIds, sampleIndex)
      : null;
  const terminalStart = performance.now();
  await browserTelemetry.prepareInteractiveTargetSession(page, { interactiveSessionId, targetSessionId });
  const firstTerminalReadyMs = performance.now() - terminalStart;
  if (!selection.input) {
    const browserMetrics = await browserTelemetry.collectBrowserMetrics(page);
    await context.close();
    browserTelemetry.assertBrowserSampleClean({ pageErrors, seriousConsoleErrors });
    return {
      navigationMs,
      appReadyMs,
      firstTerminalReadyMs,
      input: null,
      terminal: null,
      ...browserMetrics,
      pageErrors,
      seriousConsoleErrors,
    };
  }
  const pageTimeOriginMs = await page.evaluate(() => performance.timeOrigin);
  const terminalTrials = [];
  const inputTrials = await runFixedInputTrials({
    trialCount: FIXED_INPUT_TRIALS_PER_SAMPLE,
    runTrial: async (trialIndex) => {
      const priorEvents = await browserTelemetry.readProbeEvents(probeLog);
      const priorTraceCounts = await page.evaluate(() => ({
        outputFrames: window.__cod356.outputFrames.length,
        longTasks: window.__cod356.longTasks.length,
      }));
      const input = createInputTrialPayload({ sampleIndex, trialIndex });
      const expected = Buffer.from(input);
      const expectedBase64 = expected.toString('base64');
      const queueAtSend = await browserTelemetry.browserQueueSnapshot(page);
      const sendStart = performance.now();
      await page.evaluate(({ id, data }) => window.app._sendInputAsync(id, data), { id: targetSessionId, data: input });
      const inputSendMs = performance.now() - sendStart;
      const sentFrame = await page
        .waitForFunction(
          (data) =>
            [...window.__cod356.webSocketSends]
              .reverse()
              .find((entry) => entry.frame?.t === 'i' && entry.frame?.d === data),
          input,
          { timeout: 5_000 }
        )
        .then((handle) => handle.jsonValue());
      if (!Number.isInteger(sentFrame?.frame?.seq))
        throw new Error('browser did not serialize a sequenced input frame');
      const sequence = sentFrame.frame.seq;
      let receivedEvents = [];
      const probeDeadline = Date.now() + 10_000;
      while (Date.now() < probeDeadline) {
        const events = await browserTelemetry.readProbeEvents(probeLog);
        receivedEvents = events.slice(priorEvents.length).filter((event) => event.type === 'stdin');
        if (Buffer.concat(receivedEvents.map((event) => Buffer.from(event.base64, 'base64'))).includes(expected)) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      const probeReceiptMs = performance.now() - sendStart;
      const probeEvent = receivedEvents[0];
      if (!Number.isFinite(probeEvent?.timestampEpochMs)) throw new Error('probe receipt epoch timestamp unavailable');
      const ack = await page
        .waitForFunction((seq) => window.__cod356.inputAcks.find((entry) => entry.seq === seq), sequence, {
          timeout: 10_000,
        })
        .then((handle) => handle.jsonValue());
      const browserAckMs = ack.timestamp - sentFrame.timestamp;
      const queueAtAck = await browserTelemetry.browserQueueSnapshot(page);
      const visibleToken = `COD356_ECHO:${expectedBase64}`;
      const convergenceDeadline = Date.now() + 10_000;
      while (Date.now() < convergenceDeadline && !(await browserTelemetry.terminalContains(page, visibleToken))) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      if (!(await browserTelemetry.terminalContains(page, visibleToken))) {
        throw new Error('visible terminal convergence was not observed');
      }
      await page.waitForFunction(
        () => window.app.pendingWrites.length === 0 && window.app.writeFrameScheduled === false,
        undefined,
        { timeout: 5_000 }
      );
      const flushCompleteAt = await page.evaluate(
        () => new Promise((resolveFlush) => window.app.terminal.write('', () => resolveFlush(performance.now())))
      );
      const convergenceMs = flushCompleteAt - sentFrame.timestamp;
      const queueAtConvergence = await browserTelemetry.browserQueueSnapshot(page);
      const matchingOutput = await page.evaluate(
        (token) => window.__cod356.outputFrames.find((entry) => entry.data.includes(token)) ?? null,
        visibleToken
      );
      if (!matchingOutput) throw new Error('matching output frame timestamp unavailable');
      await new Promise((resolveWait) => setTimeout(resolveWait, INPUT_SETTLE_WINDOW_MS));
      receivedEvents = (await browserTelemetry.readProbeEvents(probeLog))
        .slice(priorEvents.length)
        .filter((event) => event.type === 'stdin');
      const received = Buffer.concat(receivedEvents.map((event) => Buffer.from(event.base64, 'base64')));
      const identity = diffByteSequences(expected, received);
      const queueAfterSettle = await browserTelemetry.browserQueueSnapshot(page);
      const trialBrowserMetrics = await browserTelemetry.collectBrowserMetrics(page);
      const outputFrames = trialBrowserMetrics.outputFrames.slice(priorTraceCounts.outputFrames);
      const trialLongTasks = trialBrowserMetrics.longTasks.slice(priorTraceCounts.longTasks);
      const timeline = buildCorrelatedInputTimeline({
        pageTimeOriginMs,
        sentFrameBrowserMs: sentFrame.timestamp,
        ackBrowserMs: ack.timestamp,
        probeEpochMs: probeEvent.timestampEpochMs,
        probeMonotonicNs: probeEvent.timestampNs,
        frameMatchBrowserMs: matchingOutput.timestamp,
        flushBrowserMs: flushCompleteAt,
        settleCompleteBrowserMs: queueAfterSettle.timestamp,
        longTasks: trialLongTasks,
      });
      terminalTrials.push({
        sampleIndex,
        trialIndex,
        queueAtSend,
        queueAtAck,
        queueAtConvergence,
        queueAfterSettle,
        outputFrameCount: outputFrames.length,
        outputFrameBytes: outputFrames.reduce((sum, frame) => sum + frame.byteLength, 0),
        flushMs: flushCompleteAt - matchingOutput.timestamp,
        flushReason: null,
        timeline,
      });
      return {
        sampleIndex,
        trialIndex,
        inputSendMs,
        browserAckMs,
        probeReceiptMs,
        convergenceMs,
        settleWindowMs: INPUT_SETTLE_WINDOW_MS,
        sequence,
        timeline,
        ...identity,
      };
    },
  });
  const browserMetrics = await browserTelemetry.collectBrowserMetrics(page);
  await context.close();
  browserTelemetry.assertBrowserSampleClean({ pageErrors, seriousConsoleErrors });
  return {
    ...(selection.frontend ? { navigationMs, appReadyMs, firstTerminalReadyMs, ...browserMetrics } : {}),
    pageTimeOriginMs,
    inputTrials,
    terminalTrials,
    pageErrors,
    seriousConsoleErrors,
  };
}

async function runApiWindow(baseUrl, auth) {
  return runFixedOfferSchedule({
    offeredCount: API_OFFERED_COUNT,
    intervalMs: API_OFFER_INTERVAL_MS,
    request: () => api(baseUrl, auth, 'GET', '/api/status'),
  });
}

async function runSample(context) {
  context.signal.throwIfAborted();
  const sampleStartedAtEpochMs = Date.now();
  const sampleStartedAt = performance.now();
  const coverageMarker = context.loadSupervisor?.beginSample() ?? null;
  const telemetryBefore = context.selection.backend ? await readJsonLines(context.telemetryLog) : [];
  const tmuxBefore = context.selection.backend ? (await readTmuxTrace(context.tmuxTraceLog)).length : 0;
  const procBefore = context.selection.backend ? await readProcSnapshot(context.serverPid) : null;
  const [apiMetrics, browserMetrics] = await Promise.all([
    context.selection.backend ? runApiWindow(context.baseUrl, context.auth) : Promise.resolve(null),
    context.selection.input || context.selection.frontend ? runBrowserSample(context) : Promise.resolve(null),
  ]);
  const sampleElapsedMs = performance.now() - sampleStartedAt;
  const sampleEndedAtEpochMs = Date.now();
  const tmuxCapture = context.selection.backend
    ? summarizeTmuxTrace((await readTmuxTrace(context.tmuxTraceLog)).slice(tmuxBefore))
    : null;
  const procAfter = context.selection.backend ? await readProcSnapshot(context.serverPid) : null;
  const telemetry = context.selection.backend
    ? (await readJsonLines(context.telemetryLog)).slice(telemetryBefore.length)
    : [];
  const procCpu = context.selection.backend
    ? calculateProcCpuPercent({
        beforeTicks: procBefore?.cpuTicks,
        afterTicks: procAfter?.cpuTicks,
        elapsedMs: sampleElapsedMs,
        clockTicksPerSecond: context.clockTicksPerSecond,
      })
    : { value: null, reason: 'backend measurement disabled by --only' };
  return {
    phase: context.phase,
    hostCondition: context.hostCondition,
    applicationCondition: context.applicationCondition,
    sampleIndex: context.sampleIndex,
    recordedAt: new Date().toISOString(),
    sampleTimeline: {
      startedAtEpochMs: sampleStartedAtEpochMs,
      endedAtEpochMs: sampleEndedAtEpochMs,
      elapsedMonotonicMs: sampleElapsedMs,
    },
    eventLoopHistogram: telemetry.map((entry) => entry.eventLoop),
    measurementSelection: context.selection,
    apiSchedule: apiMetrics,
    externalSchedulingDelayMs: apiMetrics?.slots.map((slot) => slot.backlogMs) ?? [],
    apiLatencyMs: apiMetrics?.latenciesMs ?? [],
    node: {
      cpuPercentOfOneCore:
        telemetry.length > 0
          ? telemetry.reduce((sum, entry) => sum + entry.cpuPercentOfOneCore, 0) / telemetry.length
          : procCpu.value,
      cpuUnavailableReason: telemetry.length > 0 ? null : procCpu.reason,
      rssBytes:
        telemetry.length > 0 ? Math.max(...telemetry.map((entry) => entry.rssBytes)) : (procAfter?.rssBytes ?? null),
      samplingMethod:
        telemetry.length > 0
          ? 'process.cpuUsage/process.memoryUsage benchmark preload'
          : context.selection.backend
            ? '/proc exact server PID fallback with measured elapsed time and detected CLK_TCK'
            : 'not measured (--only excluded backend)',
    },
    tmuxCapture,
    browser: browserMetrics,
    loadCoverage:
      coverageMarker === null
        ? { expectedWorkers: 0, minimumActiveWorkers: 0, observations: [], workerPidsStarted: [], covered: true }
        : context.loadSupervisor.endSample(coverageMarker),
  };
}

function values(runs, accessor) {
  return runs.flatMap((run) => {
    const value = accessor(run);
    return Array.isArray(value) ? value.filter(Number.isFinite) : Number.isFinite(value) ? [value] : [];
  });
}

function summaryOrNull(samples) {
  return samples.length ? summarizeSamples(samples) : null;
}

function compactCellSummary(runs, warmupRun) {
  const inputTrialMatrix = runs.map((run) => run.browser?.inputTrials).filter(Boolean);
  const inputSummary = inputTrialMatrix.length ? summarizeInputTrialMatrix(inputTrialMatrix) : null;
  const browserRuns = runs.filter((run) => run.browser && Number.isFinite(run.browser.navigationMs));
  const terminalRows = runs.flatMap((run) => run.browser?.terminalTrials ?? []);
  const tmuxRuns = runs.filter((run) => run.tmuxCapture);
  const tmuxAvailable = tmuxRuns.filter((run) => run.tmuxCapture.available);
  const apiSchedules = runs.map((run) => run.apiSchedule).filter(Boolean);
  const apiSummary = apiSchedules.length ? summarizeFixedOfferSchedule(apiSchedules) : null;
  const loadWindows = runs.map((run) => run.loadCoverage.loadWindow).filter(Boolean);
  const workerPidsStarted = [...new Set(runs.flatMap((run) => run.loadCoverage.workerPidsStarted))];
  return {
    recordedSamples: runs.length,
    warmupLoadCoverage: {
      expectedWorkers: warmupRun.loadCoverage.expectedWorkers,
      minimumActiveWorkers: warmupRun.loadCoverage.minimumActiveWorkers,
      covered: warmupRun.loadCoverage.covered,
      workerPidsStarted: warmupRun.loadCoverage.workerPidsStarted,
      observationCount: warmupRun.loadCoverage.observations.length,
      loadWindow: warmupRun.loadCoverage.loadWindow ?? null,
    },
    eventLoopDelay: runs.some((run) => run.measurementSelection.backend)
      ? aggregateEventLoopIntervals(runs.flatMap((run) => run.eventLoopHistogram))
      : null,
    externalSchedulingDelayMs: summaryOrNull(values(runs, (run) => run.externalSchedulingDelayMs)),
    apiLatencyMs: apiSummary
      ? {
          semantics: 'equivalent fixed-offer per-sample summaries; no pooled unequal populations',
          median: apiSummary.latencyMedianMsAcrossSamples?.median ?? null,
          p95: apiSummary.latencyP95MsAcrossSamples?.median ?? null,
          ...apiSummary,
        }
      : null,
    nodeCpuPercentOfOneCore: summaryOrNull(values(runs, (run) => run.node.cpuPercentOfOneCore)),
    nodeRssBytes: summaryOrNull(values(runs, (run) => run.node.rssBytes)),
    tmuxCapture: tmuxRuns.length
      ? {
          availableRuns: tmuxAvailable.length,
          unavailableReasons: tmuxRuns.filter((run) => !run.tmuxCapture.available).map((run) => run.tmuxCapture.reason),
          subprocessCount: summaryOrNull(values(tmuxAvailable, (run) => run.tmuxCapture.subprocessCount)),
          maxOverlap: tmuxAvailable.length
            ? Math.max(...values(tmuxAvailable, (run) => run.tmuxCapture.maxOverlap))
            : null,
          durationMs: summaryOrNull(values(tmuxRuns, (run) => run.tmuxCapture.durationsMs)),
          failures: tmuxAvailable.length ? tmuxAvailable.reduce((sum, run) => sum + run.tmuxCapture.failures, 0) : null,
          incomplete: tmuxAvailable.length
            ? tmuxAvailable.reduce((sum, run) => sum + run.tmuxCapture.incomplete, 0)
            : null,
        }
      : null,
    input: inputSummary ? { ...inputSummary, settleWindowMs: INPUT_SETTLE_WINDOW_MS } : null,
    loadCoverage: {
      expectedWorkers: Math.max(...runs.map((run) => run.loadCoverage.expectedWorkers)),
      minimumActiveWorkers: Math.min(...runs.map((run) => run.loadCoverage.minimumActiveWorkers)),
      covered: runs.every((run) => run.loadCoverage.covered),
      workerPidsStarted,
      fixedCohort: loadWindows.length === 0 || workerPidsStarted.length === runs[0].loadCoverage.expectedWorkers,
      loadWindow:
        loadWindows.length === 0
          ? null
          : {
              durationMs: loadWindows[0].durationMs,
              startedAtMs: loadWindows[0].startedAtMs,
              deadlineAtMs: loadWindows[0].deadlineAtMs,
              lastSampleCompletedAtMs: Math.max(...loadWindows.map((window) => window.sampleCompletedAtMs)),
              deadlineMet: loadWindows.every((window) => window.sampleCompletedAtMs < window.deadlineAtMs),
            },
    },
    terminal: terminalRows.length
      ? {
          pendingWritesCountAtSend: summaryOrNull(terminalRows.map((row) => row.queueAtSend.pendingWritesCount)),
          pendingWritesBytesAtSend: summaryOrNull(terminalRows.map((row) => row.queueAtSend.pendingWritesBytes)),
          pendingWritesCountAfterSettle: summaryOrNull(
            terminalRows.map((row) => row.queueAfterSettle.pendingWritesCount)
          ),
          pendingWritesBytesAfterSettle: summaryOrNull(
            terminalRows.map((row) => row.queueAfterSettle.pendingWritesBytes)
          ),
          writeFrameScheduledAfterSettle: terminalRows.map((row) => row.queueAfterSettle.writeFrameScheduled),
          outputFrameCount: summaryOrNull(terminalRows.map((row) => row.outputFrameCount)),
          outputFrameBytes: summaryOrNull(terminalRows.map((row) => row.outputFrameBytes)),
          flushMs: summaryOrNull(terminalRows.map((row) => row.flushMs)),
          unavailableReasons: terminalRows.map((row) => row.flushReason).filter(Boolean),
        }
      : null,
    browser: browserRuns.length
      ? {
          navigationMs: summaryOrNull(values(browserRuns, (run) => run.browser.navigationMs)),
          appReadyMs: summaryOrNull(values(browserRuns, (run) => run.browser.appReadyMs)),
          firstTerminalReadyMs: summaryOrNull(values(browserRuns, (run) => run.browser.firstTerminalReadyMs)),
          longTaskCount: summaryOrNull(values(browserRuns, (run) => run.browser.longTasks.length)),
          longTaskDurationMs: summaryOrNull(
            values(browserRuns, (run) => run.browser.longTasks.map((entry) => entry.duration))
          ),
          resourceCount: summaryOrNull(values(browserRuns, (run) => run.browser.resourceCount)),
          transferBytes: summaryOrNull(values(browserRuns, (run) => run.browser.transferBytes)),
          decodedBytes: summaryOrNull(values(browserRuns, (run) => run.browser.decodedBytes)),
          domNodes: summaryOrNull(values(browserRuns, (run) => run.browser.domNodes)),
          pageErrors: browserRuns.flatMap((run) => run.browser.pageErrors),
          seriousConsoleErrors: browserRuns.flatMap((run) => run.browser.seriousConsoleErrors),
        }
      : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputTrialProfile = buildInputTrialProfile({ sampleCount: options.samples });
  const benchmarkProtocol = {
    schemaVersion: 1,
    inputTrials: inputTrialProfile,
    apiOffersPerSample: API_OFFERED_COUNT,
    apiOfferIntervalMs: API_OFFER_INTERVAL_MS,
  };
  const logicalCpuCount = availableParallelism();
  const loadProfile = deriveLoadProfile({ logicalCpuCount });
  const applicationConditions =
    options.selection.input || options.selection.frontend ? APPLICATION_CONDITIONS : ['idle'];
  const matrix = options.conditions.flatMap((hostCondition) =>
    applicationConditions.map((applicationCondition) => ({ hostCondition, applicationCondition }))
  );
  validateBenchmarkOptions({
    host: HOST,
    port: 43123,
    durationMs: loadProfile.durationMs,
    samples: options.samples,
    conditions: options.conditions,
    applicationConditions: APPLICATION_CONDITIONS,
    workers: loadProfile.workers,
    logicalCpuCount,
  });

  const revisionPolicy = await resolveRuntimeRevisionPolicyFromGit({
    root: ROOT,
    phase: options.phase,
    requestedRevision: options.runtimeRevision,
    branchPointRevision: BRANCH_POINT_REVISION,
  });

  if (options.dryRun) {
    console.log(
      JSON.stringify(
        {
          dryRun: true,
          phase: options.phase,
          revisionPolicy,
          only: options.only,
          selection: options.selection,
          matrix,
          samples: options.samples,
          benchmarkProtocol,
          warmupsPerCell: 1,
          fixtureCount: FIXTURE_COUNT,
          target: { host: HOST, port: 'auto (never 3002)', instance: 'cod356-benchmark-<nonce>' },
          loadProfile,
          cleanup: ['exact child PIDs', 'exact session IDs', 'registered browser', 'temporary Codeman data directory'],
        },
        null,
        2
      )
    );
    return;
  }

  const provenance = await collectBenchmarkProvenance({
    root: ROOT,
    phase: options.phase,
    requestedRuntimeRevision: options.runtimeRevision,
    branchPointRevision: BRANCH_POINT_REVISION,
    runtimePaths: RUNTIME_PATHS,
    harnessPaths: HARNESS_PATHS,
    ownedPaths: OWNED_TASK_PATHS,
    generatedAssetPolicy: GENERATED_ASSET_POLICY,
    acceptedBaselineReportPath: 'docs/reports/cod-356/baseline-summary.json',
  });
  if (options.phase !== 'before') {
    assertComparableInputTrialProfiles({
      baseline: provenance.acceptedBenchmarkProtocol?.inputTrials,
      comparison: inputTrialProfile,
    });
  }
  const registry = new CleanupRegistry({ cleanupTimeoutMs: 15_000 });
  const controller = new AbortController();
  let cleanupEvidence;
  let signalName = null;
  let artifactDir;
  let dataDir;
  let browser;
  let server;
  let disposableSessionsRemaining = null;
  const logChunks = [];
  const overallTimeoutMs = Math.min(15 * 60_000, Math.max(120_000, matrix.length * (options.samples + 1) * 30_000));
  const signalCleanup = new SignalCleanupController({
    processLike: process,
    registry,
    controller,
    onAbort: (reason) => {
      signalName ??= reason;
    },
  });
  signalCleanup.install();
  const abortRun = (reason) => signalCleanup.abort(reason);
  const overallTimeout = setTimeout(() => abortRun('TIMEOUT'), overallTimeoutMs);
  overallTimeout.unref();

  const startedAt = new Date().toISOString();
  const reportSetId = randomBytes(16).toString('hex');
  const runs = [];
  const warmups = [];
  let fixtures = [];
  let browserLaunchMs = null;
  let instance;
  let tmuxSocketName;
  let tmuxSocketPath;
  let tmuxTmpDir;
  let port;
  let baseUrl;
  let auth;
  let targetOwnership;
  let clockTicksPerSecond = null;
  const credentials = { username: 'cod356', password: randomBytes(32).toString('base64url') };
  try {
    controller.signal.throwIfAborted();
    const nonce = `${process.pid}-${randomBytes(8).toString('hex')}`;
    instance = `cod356-benchmark-${nonce}`;
    const runTempRoot = await createRegisteredTempRoot(registry, join(tmpdir(), 'cod356-run-'));
    dataDir = join(runTempRoot, 'data');
    tmuxTmpDir = join(runTempRoot, 'tmux');
    await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(tmuxTmpDir, { recursive: true, mode: 0o700 })]);
    tmuxSocketName = `cod356-benchmark-${nonce}`;
    const tmuxSocketDirectory = join(tmuxTmpDir, `tmux-${process.getuid?.() ?? 'unsupported'}`);
    tmuxSocketPath = join(tmuxSocketDirectory, tmuxSocketName);
    validateDisposableTmuxSocket({
      socketName: tmuxSocketName,
      socketPath: tmuxSocketPath,
      runNonce: nonce,
      allowedSocketDirectory: tmuxSocketDirectory,
    });
    artifactDir = await mkdtemp(join(tmpdir(), `cod356-artifacts-${options.phase}-`));
    const binDir = join(dataDir, 'bin');
    const workingDir = join(dataDir, 'work');
    const probeLog = join(dataDir, 'input-probe.jsonl');
    const telemetryLog = join(dataDir, 'server-telemetry.jsonl');
    const tmuxTraceLog = join(dataDir, 'tmux-trace.tsv');
    await mkdir(workingDir, { recursive: true });
    await Promise.all([writeFile(probeLog, ''), writeFile(telemetryLog, ''), writeFile(tmuxTraceLog, '')]);
    const realTmux = await resolveExecutable('tmux');
    registry.registerTmuxSocket({
      name: tmuxSocketName,
      path: tmuxSocketPath,
      cleanup: () =>
        cleanupExactTmuxSocket({ realTmux, socketName: tmuxSocketName, socketPath: tmuxSocketPath, tmuxTmpDir }),
    });
    await createProbeShims(binDir, probeLog, tmuxTraceLog, realTmux);
    const telemetryPreload = await browserTelemetry.createServerTelemetryPreload(dataDir, telemetryLog);
    port = await chooseUnusedPort();
    validateBenchmarkOptions({
      host: HOST,
      port,
      durationMs: loadProfile.durationMs,
      samples: options.samples,
      conditions: options.conditions,
      applicationConditions: APPLICATION_CONDITIONS,
      workers: loadProfile.workers,
      logicalCpuCount,
    });
    baseUrl = `http://${HOST}:${port}`;
    controller.signal.throwIfAborted();
    server = registry.registerChild(
      spawn(join(ROOT, 'node_modules/.bin/tsx'), ['src/index.ts', 'web', '--host', HOST, '--port', String(port)], {
        cwd: ROOT,
        env: {
          ...process.env,
          CODEMAN_INSTANCE: instance,
          CODEMAN_DATA_DIR: dataDir,
          CODEMAN_PORT: String(port),
          CODEMAN_HOST: HOST,
          CODEMAN_USERNAME: credentials.username,
          CODEMAN_PASSWORD: credentials.password,
          CODEMAN_TMUX_SOCKET: tmuxSocketName,
          TMUX_TMPDIR: tmuxTmpDir,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${telemetryPreload}`.trim(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    const appendLog = (chunk) => {
      logChunks.push(chunk.toString());
      if (logChunks.length > 5_000) logChunks.shift();
    };
    server.stdout.on('data', appendLog);
    server.stderr.on('data', appendLog);

    targetOwnership = await waitForAuthenticatedStatus(baseUrl, server, credentials);
    auth = { authorization: targetOwnership.authorization, cookie: targetOwnership.cookie };
    const status = targetOwnership.payload;
    if (!Array.isArray((status.data ?? status).sessions) || (status.data ?? status).sessions.length !== 0) {
      throw new Error('disposable target was not empty before fixture creation');
    }
    fixtures = await createFixtures(
      baseUrl,
      auth,
      workingDir,
      registry,
      (remaining) => {
        disposableSessionsRemaining = remaining;
      },
      controller.signal
    );
    if (fixtures.length !== FIXTURE_COUNT)
      throw new Error(`expected ${FIXTURE_COUNT} fixtures, created ${fixtures.length}`);

    clockTicksPerSecond = await detectClockTicksPerSecond();
    if (options.selection.input || options.selection.frontend) {
      const launchStart = performance.now();
      browser = await launchRegisteredBrowser(registry);
      browserLaunchMs = performance.now() - launchStart;
    }
    for (const cell of matrix) {
      controller.signal.throwIfAborted();
      const baseContext = {
        browser,
        baseUrl,
        auth,
        credentials,
        sessionIds: fixtures.map((fixture) => fixture.id),
        probeLog,
        phase: options.phase,
        hostCondition: cell.hostCondition,
        applicationCondition: cell.applicationCondition,
        serverPid: server.pid,
        telemetryLog,
        tmuxTraceLog,
        signal: controller.signal,
        selection: options.selection,
        clockTicksPerSecond,
      };

      const loadSupervisor =
        cell.hostCondition === 'cpu'
          ? new WorkerCoverageSupervisor({
              expectedWorkers: loadProfile.workers,
              durationMs: loadProfile.durationMs,
              registry,
              signal: controller.signal,
              onDeadline: () => abortRun('LOAD_DEADLINE'),
              createWorker: () =>
                fork(join(HERE, 'cod-356-cpu-worker.mjs'), [JSON.stringify(loadProfile)], {
                  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                }),
            })
          : null;
      const common = {
        ...baseContext,
        loadSupervisor,
      };
      const executeAndRecord = async (sampleIndex) => {
        controller.signal.throwIfAborted();
        const run = await runSample({ ...common, sampleIndex });
        if (sampleIndex === 'warmup') warmups.push(run);
        else runs.push(run);
        await writeJsonArtifact(
          join(artifactDir, `${options.phase}-${cell.hostCondition}-${cell.applicationCondition}-${sampleIndex}.json`),
          run
        );
        return run;
      };
      if (loadSupervisor) {
        await runFixedLoadWindow({
          supervisor: loadSupervisor,
          samples: options.samples,
          runSample: executeAndRecord,
        });
      } else {
        await executeAndRecord('warmup');
        for (let sampleIndex = 1; sampleIndex <= options.samples; sampleIndex++) {
          await executeAndRecord(sampleIndex);
        }
      }
    }
  } finally {
    clearTimeout(overallTimeout);
    if (artifactDir) await writeFile(join(artifactDir, 'server.log'), logChunks.join(''));
    cleanupEvidence = await signalCleanup.finish();
    if (artifactDir) await writeJsonArtifact(join(artifactDir, 'cleanup.json'), cleanupEvidence);
  }

  const exactPidsStillAlive = cleanupEvidence.childPids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  const cleanup = {
    ...cleanupEvidence,
    signal: signalName,
    exactPidsStillAlive,
    disposableSessionsRemaining:
      cleanupEvidence.tmuxSocketFallback && cleanupEvidence.errors.length === 0 ? 0 : disposableSessionsRemaining,
    browserClosed: browser ? !browser.isConnected() : true,
    stable:
      cleanupEvidence.clean &&
      exactPidsStillAlive.length === 0 &&
      cleanupEvidence.tmuxSocketFallback &&
      cleanupEvidence.errors.length === 0 &&
      (!browser || !browser.isConnected()),
  };
  const cells = {};
  for (const cell of matrix) {
    const key = `${cell.hostCondition}-${cell.applicationCondition}`;
    const warmupRun = warmups.find(
      (run) => run.hostCondition === cell.hostCondition && run.applicationCondition === cell.applicationCondition
    );
    if (!warmupRun) throw new Error(`missing warmup evidence for ${key}`);
    cells[key] = compactCellSummary(
      runs.filter(
        (run) => run.hostCondition === cell.hostCondition && run.applicationCondition === cell.applicationCondition
      ),
      warmupRun
    );
  }
  const summary = {
    reportSetId,
    schemaVersion: 2,
    issue: 'COD-356',
    phase: options.phase,
    startedAt,
    completedAt: new Date().toISOString(),
    benchmarkProtocol,
    provenance,
    target: {
      host: HOST,
      port,
      instance,
      tmuxSocket: { name: tmuxSocketName, path: tmuxSocketPath },
      productionPortRefused: 3002,
      identityProof: {
        method: targetOwnership.ownershipMethod,
        authenticatedSessionCookieIssued: true,
        listenerPid: targetOwnership.listenerPid,
        spawnedPid: targetOwnership.spawnedPid,
        descendantPids: targetOwnership.descendantPids,
      },
    },
    fixtures: {
      count: fixtures.length,
      modes: fixtures.map((fixture) => fixture.mode),
      names: fixtures.map((fixture) => fixture.name),
    },
    samplesPerCell: options.samples,
    warmupsPerCell: 1,
    only: options.only,
    rawArtifactDirectory: artifactDir,
    browserLaunchMs,
    cells,
    cleanup,
  };
  const environment = collectEnvironmentMetadata({
    issue: 'COD-356',
    phase: options.phase,
    provenance,
    loadProfile,
    affinity: {
      applied: false,
      strategy: 'platform scheduler',
      fallback: 'Node child_process has no portable CPU affinity API; worker count leaves host headroom',
    },
    measurement: {
      nodeProcess: 'process.cpuUsage/process.memoryUsage benchmark preload with /proc exact-PID fallback on Linux',
      eventLoopDelay: 'perf_hooks.monitorEventLoopDelay at 10ms resolution in a benchmark-only preload',
      tmuxCapture: 'PATH-first transparent tmux wrapper recording invocation start/end/status/duration',
    },
  });
  environment.benchmarkProtocol = benchmarkProtocol;
  environment.reportSetId = reportSetId;
  const reportFilenames = compactReportFilenamesForPhase(options.phase);
  const summaryPath = join(REPORT_DIR, reportFilenames.summary);
  const environmentPath = join(REPORT_DIR, reportFilenames.environment);
  if (!cleanup.stable) throw new Error(`cleanup was not stable: ${JSON.stringify(cleanup)}`);
  for (const cell of Object.values(cells)) {
    if (cell.input && (cell.input.missingCount || cell.input.duplicateCount || cell.input.reorderedCount)) {
      throw new Error('input byte identity was not stable; inspect raw artifacts before optimizing');
    }
  }
  const verifyPublicationState = async () => {
    const sourceCommit = provenance.revisionPolicy.headRevision;
    await assertCurrentHeadRevision({ root: ROOT, sourceCommit });
    let acceptedGeneratedAssetBaseline = null;
    if (options.phase !== 'before') {
      const accepted = await loadCommittedBaselineAssetManifest({
        root: ROOT,
        reportPath: 'docs/reports/cod-356/baseline-summary.json',
        sourceCommit,
      });
      assertGeneratedAssetManifestMatches({
        accepted: accepted.manifest,
        actual: provenance.generatedRuntimeAssets,
      });
      assertComparableInputTrialProfiles({
        baseline: accepted.benchmarkProtocol?.inputTrials,
        comparison: inputTrialProfile,
      });
      acceptedGeneratedAssetBaseline = accepted.binding;
    }
    await assertCurrentHeadRevision({ root: ROOT, sourceCommit });
    return {
      checkedAt: new Date().toISOString(),
      result: 'matched',
      sourceCommit,
      acceptedGeneratedAssetBaseline,
    };
  };
  const verifyBeforeRename = async () => {
    await verifyPublicationState();
    try {
      const verification = await assertGeneratedAssetsStableAtPublication({
        preRunManifest: provenance.generatedRuntimeAssets,
        collectCurrent: () => collectGeneratedRuntimeAssetManifest(GENERATED_ASSET_POLICY),
      });
      cleanup.preRenameGeneratedAssets = verification;
      return verification;
    } catch (error) {
      cleanup.preRenameGeneratedAssets = error?.verification ?? {
        checkedAt: new Date().toISOString(),
        result: 'failed',
        preHash: provenance.generatedRuntimeAssets.manifestHash,
        postHash: null,
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  };
  try {
    await guardGeneratedAssetPublication({
      preRunManifest: provenance.generatedRuntimeAssets,
      collectPostRun: () => collectGeneratedRuntimeAssetManifest(GENERATED_ASSET_POLICY),
      verifyPublicationState,
      publish: async (verification, publicationState) => {
        cleanup.postRunGeneratedAssets = verification;
        cleanup.postRunProvenance = publicationState;
        summary.postRunGeneratedAssets = verification;
        summary.postRunProvenance = publicationState;
        environment.postRunGeneratedAssets = verification;
        environment.postRunProvenance = publicationState;
        await writePairedJsonArtifacts({
          summaryPath,
          environmentPath,
          summary,
          environment,
          reportSetId,
          beforeRename: verifyBeforeRename,
        });
      },
    });
  } catch (error) {
    cleanup.postRunGeneratedAssets = error?.verification ?? {
      checkedAt: new Date().toISOString(),
      result: 'failed',
      preHash: provenance.generatedRuntimeAssets.manifestHash,
      postHash: null,
      error: error instanceof Error ? error.message : String(error),
    };
    await writeJsonArtifact(join(artifactDir, 'cleanup.json'), cleanup);
    throw error;
  }
  await writeJsonArtifact(join(artifactDir, 'cleanup.json'), cleanup);
  console.log(
    JSON.stringify(
      {
        summary: summaryPath,
        environment: environmentPath,
        rawArtifactDirectory: artifactDir,
        cleanup,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
