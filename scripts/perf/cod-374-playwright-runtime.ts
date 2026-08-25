import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { Page } from 'playwright';

import {
  armBrowserLatencyTrial,
  completeBrowserLatencyWindow,
  installBrowserLatencyHooks,
  installBrowserLatencyInitScript,
  observePaneVisibilities,
  PaneVisibilitiesObservationError,
  readBrowserLatencyTrace,
  removeBrowserLatencyHooks,
  validateBrowserLatencyTrace,
} from '../../test/utils/cod374-latency-trace.js';
import { Cod370OpenCodeFixture, hasMandatoryCleanupProof } from '../../test/utils/cod370-opencode-fixture.js';
import {
  BROWSER_MAX_DRIFT_MS,
  BROWSER_MAX_P95_DRIFT_MS,
  BROWSER_TICK_COUNT,
  BROWSER_TIMER_INTERVAL_MS,
  nearestRankPercentile,
} from './cod-374-quiescence.mjs';

const execFileAsync = promisify(execFile);
const INPUTS = ['q', 'z', '1'];
const MAX_BROWSER_DIAGNOSTICS = 32;
const BROWSER_QUIESCENCE_RESET_EXPRESSION = String.raw`(async () => {
  const browserWindow = window;
  browserWindow.__cod374PhaseBLongTasks ??= [];
  browserWindow.__cod374PhaseBResizeEvents ??= [];
  browserWindow.__cod374PhaseBLongTaskObserver?.takeRecords();
  browserWindow.__cod374PhaseBLongTasks.length = 0;
  browserWindow.__cod374PhaseBResizeEvents.length = 0;
  browserWindow.__cod374PhaseBResizeCollecting = false;
  if (browserWindow.__cod374LatencyTrace && 'overflowed' in browserWindow.__cod374LatencyTrace) {
    browserWindow.__cod374LatencyTrace.overflowed = false;
  }
  browserWindow.__cod374PhaseBTraceOverflowed = false;
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  browserWindow.__cod374PhaseBLongTasks.length = 0;
  browserWindow.__cod374PhaseBResizeEvents.length = 0;
  if (browserWindow.__cod374LatencyTrace && 'overflowed' in browserWindow.__cod374LatencyTrace) {
    browserWindow.__cod374LatencyTrace.overflowed = false;
  }
  browserWindow.__cod374PhaseBTraceOverflowed = false;
})()`;

const BROWSER_QUIESCENCE_TICK_EXPRESSION = String.raw`(async () => {
  const browserWindow = window;
  const driftsMs = [];
  let measurementError = null;
  browserWindow.__cod374PhaseBLongTasks.length = 0;
  browserWindow.__cod374PhaseBResizeEvents.length = 0;
  if (browserWindow.__cod374LatencyTrace && 'overflowed' in browserWindow.__cod374LatencyTrace) {
    browserWindow.__cod374LatencyTrace.overflowed = false;
  }
  browserWindow.__cod374PhaseBTraceOverflowed = false;
  const startedAtMs = performance.now();
  browserWindow.__cod374PhaseBWindowStartedMs = startedAtMs;
  browserWindow.__cod374PhaseBResizeCollecting = true;
  try {
    let previousAt = startedAtMs;
    for (let index = 0; index < 50; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const now = performance.now();
      driftsMs.push(Math.max(0, now - previousAt - 20));
      previousAt = now;
    }
  } catch (error) {
    measurementError = error instanceof Error ? error.name + ':' + error.message : String(error);
  } finally {
    browserWindow.__cod374PhaseBResizeCollecting = false;
    browserWindow.__cod374PhaseBWindowEndedMs = performance.now();
    browserWindow.__cod374PhaseBWindowOverflowed =
      browserWindow.__cod374PhaseBTraceOverflowed === true ||
      browserWindow.__cod374LatencyTrace?.overflowed === true;
  }
  return {
    tickCount: driftsMs.length,
    driftsMs,
    overflowed: browserWindow.__cod374PhaseBWindowOverflowed,
    measurementError,
  };
})()`;

const BROWSER_QUIESCENCE_SNAPSHOT_EXPRESSION = String.raw`(async () => {
  const browserWindow = window;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const pendingLongTasks = browserWindow.__cod374PhaseBLongTaskObserver?.takeRecords() ?? [];
  browserWindow.__cod374PhaseBLongTasks.push(
    ...pendingLongTasks.map((entry) => ({ startTime: entry.startTime, duration: entry.duration })),
  );
  const startedAtMs = browserWindow.__cod374PhaseBWindowStartedMs;
  const endedAtMs = browserWindow.__cod374PhaseBWindowEndedMs;
  return {
    longTaskDurationsMs: browserWindow.__cod374PhaseBLongTasks
      .filter((entry) => entry.startTime >= startedAtMs && entry.startTime <= endedAtMs)
      .map((entry) => entry.duration),
    resizeCount: browserWindow.__cod374PhaseBResizeEvents.length,
    overflowed: browserWindow.__cod374PhaseBWindowOverflowed === true,
  };
})()`;

interface BrowserQuiescenceTickResult {
  tickCount: number;
  driftsMs: number[];
  overflowed: boolean;
  measurementError: string | null;
}

interface BrowserQuiescenceDiagnostics {
  longTaskDurationsMs: number[];
  resizeCount: number;
  overflowed: boolean;
}

interface BrowserQuiescenceOptions {
  pageErrors: string[];
  consoleErrors: string[];
  resetTraceDiagnostics?: () => Promise<void>;
  snapshotTraceDiagnostics?: () => Promise<{ overflowed?: boolean }>;
}

function diagnosticHash(value: unknown): string {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

function browserQuiescenceEvidence({
  tick,
  diagnostics,
  pageErrors,
  consoleErrors,
  traceOverflowed,
  measurementError,
}: {
  tick?: Partial<BrowserQuiescenceTickResult>;
  diagnostics?: Partial<BrowserQuiescenceDiagnostics>;
  pageErrors: string[];
  consoleErrors: string[];
  traceOverflowed: boolean;
  measurementError: unknown | null;
}) {
  const rawDrifts = Array.isArray(tick?.driftsMs) ? tick.driftsMs : [];
  const driftsMs = rawDrifts
    .slice(0, BROWSER_TICK_COUNT)
    .map((value) => (Number.isFinite(value) ? Math.min(60_000, Math.max(0, value)) : 0));
  const rawLongTasks = Array.isArray(diagnostics?.longTaskDurationsMs) ? diagnostics.longTaskDurationsMs : [];
  const diagnosticOverflow =
    rawLongTasks.length > MAX_BROWSER_DIAGNOSTICS ||
    pageErrors.length > MAX_BROWSER_DIAGNOSTICS ||
    consoleErrors.length > MAX_BROWSER_DIAGNOSTICS ||
    (Number.isInteger(diagnostics?.resizeCount) && diagnostics.resizeCount! > 1_000);
  const longTaskDurationsMs = rawLongTasks
    .slice(0, MAX_BROWSER_DIAGNOSTICS)
    .map((value) => (Number.isFinite(value) ? Math.min(60_000, Math.max(0, value)) : 0));
  const pageErrorHashes = pageErrors.slice(0, MAX_BROWSER_DIAGNOSTICS).map(diagnosticHash);
  const consoleErrorHashes = consoleErrors.slice(0, MAX_BROWSER_DIAGNOSTICS).map(diagnosticHash);
  const resizeCount = Number.isInteger(diagnostics?.resizeCount)
    ? Math.min(1_000, Math.max(0, diagnostics.resizeCount!))
    : 0;
  const overflowed = (tick?.overflowed ?? diagnostics?.overflowed) === true || traceOverflowed || diagnosticOverflow;
  const p95DriftMs = driftsMs.length ? nearestRankPercentile(driftsMs, 95) : 0;
  const maxDriftMs = driftsMs.length ? Math.max(...driftsMs) : 0;
  const measurementErrorHash =
    measurementError === null
      ? null
      : diagnosticHash(
          measurementError instanceof Error ? `${measurementError.name}:${measurementError.message}` : measurementError
        );
  const passed =
    measurementErrorHash === null &&
    tick?.tickCount === BROWSER_TICK_COUNT &&
    driftsMs.length === BROWSER_TICK_COUNT &&
    p95DriftMs <= BROWSER_MAX_P95_DRIFT_MS &&
    maxDriftMs <= BROWSER_MAX_DRIFT_MS &&
    longTaskDurationsMs.length === 0 &&
    pageErrorHashes.length === 0 &&
    consoleErrorHashes.length === 0 &&
    resizeCount === 0 &&
    !overflowed;
  return {
    tickCount: driftsMs.length,
    timerIntervalMs: BROWSER_TIMER_INTERVAL_MS,
    driftsMs,
    p95DriftMs,
    maxDriftMs,
    longTaskDurationsMs,
    pageErrorHashes,
    consoleErrorHashes,
    resizeCount,
    overflowed,
    measurementErrorHash,
    passed,
  };
}

export async function measureBrowserQuiescence(page: Pick<Page, 'evaluate'>, options: BrowserQuiescenceOptions) {
  let tick: BrowserQuiescenceTickResult | undefined;
  let diagnostics: BrowserQuiescenceDiagnostics | undefined;
  let traceOverflowed = false;
  let measurementError: unknown | null = null;
  try {
    await options.resetTraceDiagnostics?.();
    await page.evaluate(BROWSER_QUIESCENCE_RESET_EXPRESSION);
  } catch (error) {
    return browserQuiescenceEvidence({
      pageErrors: [],
      consoleErrors: [],
      traceOverflowed: false,
      measurementError: error,
    });
  }

  const pageErrorStart = options.pageErrors.length;
  const consoleErrorStart = options.consoleErrors.length;
  try {
    tick = await page.evaluate(BROWSER_QUIESCENCE_TICK_EXPRESSION);
    if (
      !tick ||
      !Array.isArray(tick.driftsMs) ||
      tick.tickCount !== tick.driftsMs.length ||
      tick.tickCount < 0 ||
      tick.tickCount > BROWSER_TICK_COUNT ||
      !tick.driftsMs.every((value) => Number.isFinite(value) && value >= 0 && value <= 60_000) ||
      typeof tick.overflowed !== 'boolean' ||
      (tick.measurementError !== null && typeof tick.measurementError !== 'string')
    ) {
      throw new Error('invalid browser quiescence timer result');
    }
    measurementError = tick.measurementError;
  } catch (error) {
    measurementError = error;
  }
  const pageErrorEnd = options.pageErrors.length;
  const consoleErrorEnd = options.consoleErrors.length;

  try {
    diagnostics = await page.evaluate(BROWSER_QUIESCENCE_SNAPSHOT_EXPRESSION);
    if (
      !diagnostics ||
      !Array.isArray(diagnostics.longTaskDurationsMs) ||
      !diagnostics.longTaskDurationsMs.every((value) => Number.isFinite(value) && value >= 0 && value <= 60_000) ||
      !Number.isInteger(diagnostics.resizeCount) ||
      diagnostics.resizeCount < 0 ||
      typeof diagnostics.overflowed !== 'boolean'
    ) {
      throw new Error('invalid browser quiescence diagnostics result');
    }
  } catch (error) {
    measurementError ??= error;
  }
  try {
    traceOverflowed = (await options.snapshotTraceDiagnostics?.())?.overflowed === true;
  } catch (error) {
    traceOverflowed = true;
    measurementError ??= error;
  }

  return browserQuiescenceEvidence({
    tick,
    diagnostics,
    pageErrors: options.pageErrors.slice(pageErrorStart, pageErrorEnd),
    consoleErrors: options.consoleErrors.slice(consoleErrorStart, consoleErrorEnd),
    traceOverflowed,
    measurementError,
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

export async function cpuProbe(page: Page): Promise<number[]> {
  const samples = [];
  for (let sample = 0; sample < 5; sample++) {
    samples.push(
      await page.evaluate(() => {
        const startedAt = performance.now();
        let accumulator = 0;
        for (let index = 0; index < 400_000; index++) accumulator += Math.sqrt(index + 1);
        if (accumulator === 0) throw new Error('CPU calibration loop was optimized away');
        return performance.now() - startedAt;
      })
    );
  }
  return samples;
}

async function waitUntil(label: string, probe: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function dispatchRapidKeys(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await Promise.all(
      INPUTS.flatMap((input) => {
        const upper = input.toUpperCase();
        const code = /^[a-z]$/i.test(input) ? `Key${upper}` : `Digit${input}`;
        const keyCode = upper.charCodeAt(0);
        return [
          cdp.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: input,
            code,
            text: input,
            unmodifiedText: input,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
          }),
          cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: input,
            code,
            windowsVirtualKeyCode: keyCode,
            nativeVirtualKeyCode: keyCode,
          }),
        ];
      })
    );
  } finally {
    await cdp.detach();
  }
}

function exactComposerToken(text: string): string | null {
  const matches = text
    .split('\n')
    .map((line) => line.match(/^\s*[│┃]\s+(q[A-Za-z0-9]*)\s*(?:[│┃])?\s*$/)?.[1])
    .filter((value): value is string => !!value);
  return matches.length === 1 ? matches[0] : null;
}

export async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const app = (window as unknown as { app: Record<string, any> }).app;
    const buffer = app.terminal.buffer.active;
    const lines: string[] = [];
    const viewportY = buffer.viewportY ?? buffer.baseY ?? 0;
    for (let row = 0; row < app.terminal.rows; row++)
      lines.push(buffer.getLine(viewportY + row)?.translateToString(true) ?? '');
    return lines.join('\n');
  });
}

function exactComposerRows(text: string): number[] {
  return text
    .split('\n')
    .map((line, row) => (line.includes('Ask anything') ? row : -1))
    .filter((row) => row >= 0);
}

export async function awaitPhaseBAppReadiness(
  page: Pick<Page, 'bringToFront' | 'evaluate' | 'waitForFunction'>
): Promise<void> {
  await page.bringToFront();
  try {
    await page.waitForFunction(
      () => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        return !!app?.terminal?.options && app.eventSource?.readyState === 1 && app._connectionStatus === 'connected';
      },
      undefined,
      { timeout: 20_000 }
    );
  } catch {
    const state = await page.evaluate(() => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      return {
        terminalOptions: !!app?.terminal?.options,
        eventSourceOpen: app?.eventSource?.readyState === 1,
        connected: app?._connectionStatus === 'connected',
      };
    });
    throw new Error(
      `Phase B app readiness timed out (terminalOptions=${state.terminalOptions},eventSourceOpen=${state.eventSourceOpen},connected=${state.connected})`
    );
  }
}

export async function focusPhaseBRuntime(fixture: Cod370OpenCodeFixture): Promise<void> {
  const page = fixture.phonePage!;
  await page.bringToFront();
  await page.waitForFunction(
    (sessionId) => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      return !!app?.terminal?.options && app.sessions?.has(sessionId) === true;
    },
    fixture.sessionId,
    { timeout: 20_000 }
  );
  await page.evaluate(
    (sessionId) => (window as unknown as { app: Record<string, any> }).app.selectSession(sessionId, { auto: true }),
    fixture.sessionId
  );
  await page.waitForFunction(
    (sessionId) => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      return (
        app.activeSessionId === sessionId &&
        app._wsReady === true &&
        app._wsSessionId === sessionId &&
        !!app.terminal?.buffer
      );
    },
    fixture.sessionId,
    { timeout: 20_000 }
  );
  let rowState = { paneRows: [] as number[], xtermRows: [] as number[], paneLineCount: 0, xtermLineCount: 0 };
  let stableSnapshot = '';
  let stableSnapshotCount = 0;
  try {
    await waitUntil('same visible OpenCode composer row in pane and xterm', async () => {
      const paneText = fixture.paneViewportText();
      const xtermText = await terminalText(page);
      rowState = {
        paneRows: exactComposerRows(paneText),
        xtermRows: exactComposerRows(xtermText),
        paneLineCount: paneText.split('\n').length,
        xtermLineCount: xtermText.split('\n').length,
      };
      const exactMatch =
        rowState.paneRows.length === 1 &&
        rowState.xtermRows.length === 1 &&
        rowState.paneRows[0] === rowState.xtermRows[0];
      if (!exactMatch) {
        stableSnapshot = '';
        stableSnapshotCount = 0;
        return false;
      }
      const snapshot = `${paneText}\0${xtermText}`;
      if (snapshot === stableSnapshot) stableSnapshotCount += 1;
      else {
        stableSnapshot = snapshot;
        stableSnapshotCount = 1;
      }
      return stableSnapshotCount >= 2;
    });
  } catch {
    throw new Error(
      `Visible composer rows did not converge (pane=${rowState.paneRows.join(',') || 'none'}/${rowState.paneLineCount},xterm=${rowState.xtermRows.join(',') || 'none'}/${rowState.xtermLineCount})`
    );
  }
  const screen = page.locator('#terminalContainer .xterm-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('Phone xterm screen has no bounding box');
  const composerRow = rowState.paneRows[0];
  await screen.click({
    position: { x: 30, y: ((composerRow + 0.5) * box.height) / rowState.xtermLineCount },
  });
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), undefined, {
    timeout: 2_000,
  });
  let stableSince = 0;
  await waitUntil('empty focused OpenCode composer stable for 500ms', async () => {
    const browser = await page.evaluate(() => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      return {
        activeSessionId: app.activeSessionId,
        wsReady: app._wsReady,
        wsSessionId: app._wsSessionId,
        focused: document.activeElement?.classList.contains('xterm-helper-textarea') === true,
      };
    });
    const pane = fixture.paneViewportText();
    const xterm = await terminalText(page);
    const ready =
      browser.activeSessionId === fixture.sessionId &&
      browser.wsReady === true &&
      browser.wsSessionId === fixture.sessionId &&
      browser.focused &&
      /┃\s*\n\s*┃\s+Ask anything/.test(pane) &&
      /┃\s*\n\s*┃\s+Ask anything/.test(xterm);
    if (!ready) {
      stableSince = 0;
      return false;
    }
    stableSince ||= Date.now();
    return Date.now() - stableSince >= 500;
  });
}

async function clearComposer(fixture: Cod370OpenCodeFixture): Promise<void> {
  const page = fixture.phonePage!;
  await page.keyboard.press('Control+U');
  await waitUntil('empty OpenCode composer', () => !exactComposerToken(fixture.paneText()));
}

export async function finishResizeCollection(page: Pick<Page, 'evaluate'>): Promise<Array<{ atMs: number }>> {
  return page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const browserWindow = window as any;
    browserWindow.__cod374PhaseBResizeCollecting = false;
    return browserWindow.__cod374PhaseBResizeEvents.map((atMs: number) => ({ atMs }));
  });
}

export async function captureWindow(fixture: Cod370OpenCodeFixture, secret: string | null, sampleIndex: number) {
  const page = fixture.phonePage!;
  await clearComposer(fixture);
  if (secret) await fixture.mobileTraceSnapshot(secret, true);
  await page.evaluate(() => {
    const browserWindow = window as any;
    browserWindow.__cod374PhaseBLongTasks.length = 0;
    browserWindow.__cod374PhaseBResizeEvents.length = 0;
    browserWindow.__cod374PhaseBResizeCollecting = true;
  });
  const trialId = `cod374-${Date.now().toString(36)}-${sampleIndex}`;
  const tokens = ['q', 'qz', 'qz1'];
  for (const [inputIndex, token] of tokens.entries()) {
    await armBrowserLatencyTrial(page, {
      trialId,
      inputIndex,
      token,
      tokenHash: createHash('sha256').update(token).digest('hex').slice(0, 16),
      tokenLength: token.length,
    });
  }
  const panePromise = observePaneVisibilities({
    capture: ({ signal, timeoutMs }) => fixture.capturePaneText({ signal, timeoutMs }),
    targets: tokens.map((token) => ({ id: token, isPresent: (text) => exactComposerToken(text) === token })),
    completionTargetId: tokens.at(-1)!,
    deadlineMs: 10_000,
    pollIntervalMs: 5,
  });
  await dispatchRapidKeys(page);
  await waitUntil('final browser paint', async () =>
    (await readBrowserLatencyTrace(page, trialId)).some(
      (event) => event.stage === 'browser.paint-proxy' && event.inputIndex === 2
    )
  );
  let paneResults;
  try {
    paneResults = await panePromise;
  } catch (error) {
    if (!(error instanceof PaneVisibilitiesObservationError)) throw error;
    paneResults = error.results;
  }
  await completeBrowserLatencyWindow(page, trialId);
  const browserEvents = validateBrowserLatencyTrace(await readBrowserLatencyTrace(page, trialId));
  const server = secret ? await fixture.mobileTraceSnapshot(secret) : { events: [] };
  const resizeEvents = await finishResizeCollection(page);
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const longTasks = await page.evaluate(() =>
    (window as any).__cod374PhaseBLongTasks.map((entry: { startTime: number; duration: number }) => ({
      startedMs: entry.startTime,
      durationMs: entry.duration,
    }))
  );
  const keydown = Math.min(
    ...browserEvents.filter((event) => event.stage === 'browser.keydown').map((event) => event.atMs)
  );
  const paint = Math.max(
    ...browserEvents.filter((event) => event.stage === 'browser.paint-proxy').map((event) => event.atMs)
  );
  return {
    schemaVersion: 1,
    traceOverflowed: 'overflowed' in server ? server.overflowed : false,
    browserEvents,
    serverEvents: server.events,
    paneResults: paneResults.map((result, inputIndex) => {
      const probes = result.status === 'visible' ? result.interval.probes : result.error.probes;
      return {
        inputIndex,
        tokenHash: createHash('sha256').update(tokens[inputIndex]).digest('hex').slice(0, 16),
        tokenLength: tokens[inputIndex].length,
        status: result.status,
        errorHash:
          result.status === 'visible'
            ? null
            : createHash('sha256').update(result.error.message).digest('hex').slice(0, 16),
        probes: probes.map((probe) => ({
          startedNs: probe.startedNs.toString(),
          completedNs: probe.completedNs.toString(),
          present: probe.present,
          durationMs: probe.durationMs,
          errorHash: probe.error ? createHash('sha256').update(probe.error).digest('hex').slice(0, 16) : null,
        })),
      };
    }),
    longTaskWindow: {
      startedMs: keydown,
      endedMs: paint,
      entries: longTasks.filter(
        (entry: { startedMs: number; durationMs: number }) =>
          entry.startedMs <= paint && entry.startedMs + entry.durationMs >= keydown
      ),
    },
    resizeEvents,
  };
}

export async function launchConcretePhaseBRuntime({ runtimeRoot, plan }: { runtimeRoot: string; plan: any }) {
  const launchedAt = new Date().toISOString();
  const secret = plan.config.traceEnabled ? randomBytes(24).toString('hex') : null;
  const fixture = new Cod370OpenCodeFixture({
    runtimeRoot,
    ...(secret ? { mobileTrace: { secret, capacity: 20_000 } } : {}),
  });
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  let listenersInstalled = false;
  let hooksInstalled = false;
  const onPageError = (error: Error) => pageErrors.push(error.message);
  const onConsole = (message: { type(): string; text(): string }) => {
    const type = message.type();
    const value = message.text();
    if (type === 'error' || (type === 'warning' && /(?:crash|exception|uncaught|failed|fatal)/i.test(value))) {
      consoleErrors.push(`${type}: ${value}`);
    }
  };
  try {
    await fixture.start();
    await installBrowserLatencyInitScript(fixture.phonePage!);
    await fixture.navigatePages();
    await awaitPhaseBAppReadiness(fixture.phonePage!);
    await fixture.createOpenCodeSession();
    await focusPhaseBRuntime(fixture);
    fixture.phonePage!.on('pageerror', onPageError);
    fixture.phonePage!.on('console', onConsole);
    listenersInstalled = true;
    await fixture.phonePage!.evaluate(() => {
      const browserWindow = window as any;
      browserWindow.__cod374PhaseBLongTasks = [];
      browserWindow.__cod374PhaseBResizeEvents = [];
      browserWindow.__cod374PhaseBResizeCollecting = false;
      browserWindow.__cod374PhaseBOnResize = () => {
        if (browserWindow.__cod374PhaseBResizeCollecting)
          browserWindow.__cod374PhaseBResizeEvents.push(performance.now());
      };
      window.addEventListener('resize', browserWindow.__cod374PhaseBOnResize);
      browserWindow.__cod374PhaseBResizeObserver = new ResizeObserver(browserWindow.__cod374PhaseBOnResize);
      const terminal = document.querySelector('.xterm');
      if (terminal) browserWindow.__cod374PhaseBResizeObserver.observe(terminal);
      browserWindow.__cod374PhaseBLongTaskObserver = new PerformanceObserver((list) => {
        browserWindow.__cod374PhaseBLongTasks.push(
          ...list.getEntries().map((entry) => ({ startTime: entry.startTime, duration: entry.duration }))
        );
      });
      browserWindow.__cod374PhaseBLongTaskObserver.observe({ type: 'longtask', buffered: false });
    });
    await installBrowserLatencyHooks(fixture.phonePage!);
    hooksInstalled = true;
    return {
      runtimeRoot,
      serverPid: fixture.server!.pid!,
      browserPid: fixture.chromiumPids[0],
      opencodePid: fixture.identities().opencode.pid,
      launchedAt,
      baseUrl: fixture.baseUrl,
      page: fixture.phonePage!,
      fetch,
      async opencodeVersion() {
        const { stdout } = await execFileAsync('opencode', ['--version'], { encoding: 'utf8' });
        return stdout.trim();
      },
      async identities() {
        const identities = fixture.identities();
        return {
          tmuxSession: `${identities.muxName}:${identities.tmuxSessionId}`,
          tempRoot: fixture.root,
        };
      },
      async measureBrowserQuiescence() {
        return measureBrowserQuiescence(fixture.phonePage!, {
          pageErrors,
          consoleErrors,
          ...(secret
            ? {
                resetTraceDiagnostics: async () => {
                  await fixture.mobileTraceSnapshot(secret, true);
                },
                snapshotTraceDiagnostics: async () => fixture.mobileTraceSnapshot(secret),
              }
            : {}),
        });
      },
      async captureRepetition() {
        const cells = [];
        for (const rate of plan.config.rates) {
          try {
            const cdp = await fixture.phonePage!.context().newCDPSession(fixture.phonePage!);
            try {
              await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
              const baselineSamplesMs = await cpuProbe(fixture.phonePage!);
              await cdp.send('Emulation.setCPUThrottlingRate', { rate });
              const throttledSamplesMs = await cpuProbe(fixture.phonePage!);
              const baselineMedianMs = median(baselineSamplesMs);
              const throttledMedianMs = median(throttledSamplesMs);
              const cell = {
                rate,
                realizedCpuThrottle: rate,
                cpuCalibration: {
                  baselineSamplesMs,
                  throttledSamplesMs,
                  baselineMedianMs,
                  throttledMedianMs,
                  ratio: throttledMedianMs / baselineMedianMs,
                },
                samples: [] as Array<Record<string, unknown>>,
              };
              cells.push(cell);
              for (let index = 0; index < plan.config.samplesPerCell; index++) {
                cell.samples.push(await captureWindow(fixture, secret, index));
              }
            } finally {
              await cdp.detach();
            }
          } catch (error) {
            if (error && typeof error === 'object') Object.assign(error, { partialArtifacts: cells });
            throw error;
          }
        }
        return cells;
      },
      async diagnostics() {
        fixture.identities();
        return {
          pageErrorHashes: pageErrors.map((value) => createHash('sha256').update(value).digest('hex').slice(0, 16)),
          consoleErrorHashes: consoleErrors.map((value) =>
            createHash('sha256').update(value).digest('hex').slice(0, 16)
          ),
        };
      },
      async cleanup() {
        const errors = [];
        let hooksRestored = false;
        let listenersDisposed = false;
        await removeBrowserLatencyHooks(fixture.phonePage!)
          .then(() => {
            hooksRestored = true;
          })
          .catch((error) => errors.push(error));
        await fixture
          .phonePage!.evaluate(() => {
            const browserWindow = window as any;
            browserWindow.__cod374PhaseBLongTaskObserver?.disconnect();
            browserWindow.__cod374PhaseBResizeObserver?.disconnect();
            window.removeEventListener('resize', browserWindow.__cod374PhaseBOnResize);
          })
          .catch((error) => errors.push(error));
        fixture.phonePage!.off('pageerror', onPageError);
        fixture.phonePage!.off('console', onConsole);
        listenersDisposed = true;
        await fixture.cleanup().catch((error) => errors.push(error));
        if (!hasMandatoryCleanupProof(fixture.cleanupProof)) errors.push(new Error('mandatory cleanup proof failed'));
        const cleanupProof = {
          browserClosed: fixture.cleanupProof.browserClosed,
          serverStopped: fixture.cleanupProof.launcherDead && fixture.cleanupProof.listenerDead,
          tmuxRemoved: fixture.cleanupProof.tmuxTargetAbsent,
          tempRootRemoved: fixture.cleanupProof.rootAbsent && fixture.cleanupProof.socketAbsent,
          hooksRestored,
          listenersDisposed,
        };
        if (errors.length) {
          const cleanupError = new AggregateError(errors, 'concrete Phase B runtime cleanup failed');
          Object.assign(cleanupError, { cleanupProof });
          throw cleanupError;
        }
        return cleanupProof;
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    const fixtureAllocation = fixture.resourceAllocation();
    const cleanupAllocation = {
      ...fixtureAllocation,
      hooksRestored: hooksInstalled,
      listenersDisposed: listenersInstalled,
    };
    let hooksRestored = false;
    let listenersDisposed = false;
    if (hooksInstalled && fixture.phonePage) {
      await removeBrowserLatencyHooks(fixture.phonePage)
        .then(() => {
          hooksRestored = true;
        })
        .catch((cleanupError) => failures.push(cleanupError));
    }
    if (listenersInstalled && fixture.phonePage) {
      fixture.phonePage.off('pageerror', onPageError);
      fixture.phonePage.off('console', onConsole);
      listenersDisposed = true;
    }
    await fixture.cleanup().catch((cleanupError) => failures.push(cleanupError));
    const startupError = new AggregateError(failures, 'concrete Phase B runtime startup failed');
    Object.assign(startupError, {
      postAllocation: true,
      launchedAt,
      serverDiagnostics: fixture.serverDiagnosticHashes(),
      cleanupAllocation,
      cleanupProof: {
        browserClosed: !cleanupAllocation.browserClosed || fixture.cleanupProof.browserClosed,
        serverStopped:
          !cleanupAllocation.serverStopped || (fixture.cleanupProof.launcherDead && fixture.cleanupProof.listenerDead),
        tmuxRemoved: !cleanupAllocation.tmuxRemoved || fixture.cleanupProof.tmuxTargetAbsent,
        tempRootRemoved:
          !cleanupAllocation.tempRootRemoved || (fixture.cleanupProof.rootAbsent && fixture.cleanupProof.socketAbsent),
        hooksRestored: !cleanupAllocation.hooksRestored || hooksRestored,
        listenersDisposed: !cleanupAllocation.listenersDisposed || listenersDisposed,
      },
    });
    throw startupError;
  }
}
