/**
 * @fileoverview Real-browser, real-server terminal byte tracing for COD-356.
 *
 * A disposable Codeman child owns a unique data directory and tmux socket. A
 * PATH-first Codex shim runs the benchmark input probe inside the real PTY.
 * Each assertion correlates the production browser record, serialized WS/HTTP
 * frame, probe-received PTY bytes, and xterm-visible output.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { MAX_INPUT_LENGTH } from '../src/config/terminal-limits.js';
import {
  armFirstVisibleObservation,
  prepareInputTrialObservation,
  withInputTrialObservation,
} from '../scripts/perf/cod-356-browser.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const PROBE = resolve(ROOT, 'scripts/perf/cod-356-input-probe.mjs');
const USERNAME = 'cod356-input-test';
const PASSWORD = 'cod356-input-password';

let testRoot: string;
let dataDir: string;
let probeLog: string;
let socketName: string;
let port: number;
let baseUrl: string;
let server: ChildProcess | null = null;
let serverLog = '';
let browser: Browser;
let context: BrowserContext;
let page: Page;
let sessionId: string;

function authorization(): string {
  return `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
}

async function choosePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const candidate = createServer();
    candidate.once('error', reject);
    candidate.listen(0, '127.0.0.1', () => {
      const address = candidate.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      candidate.close((error) => (error ? reject(error) : resolvePort(selected)));
    });
  });
}

async function verifyPortReleased(): Promise<void> {
  await new Promise<void>((resolvePort, rejectPort) => {
    const candidate = createServer();
    candidate.once('error', rejectPort);
    candidate.listen(port, '127.0.0.1', () => candidate.close((error) => (error ? rejectPort(error) : resolvePort())));
  });
}

async function waitForStatus(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null) throw new Error(`Codeman child exited early:\n${serverLog.slice(-4_000)}`);
    try {
      const response = await fetch(`${baseUrl}/api/status`, { headers: { Authorization: authorization() } });
      if (response.ok) return;
    } catch {
      // Child is still binding.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Codeman child did not become ready:\n${serverLog.slice(-4_000)}`);
}

async function startServer(): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_MODE;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  delete env.NODE_ENV;
  Object.assign(env, {
    CODEMAN_INSTANCE: `cod356-input-${process.pid}`,
    CODEMAN_DATA_DIR: dataDir,
    CODEMAN_HOST: '127.0.0.1',
    CODEMAN_PORT: String(port),
    CODEMAN_USERNAME: USERNAME,
    CODEMAN_PASSWORD: PASSWORD,
    CODEMAN_TMUX_SOCKET: socketName,
    COD356_PROBE_LOG: probeLog,
    PATH: `${join(testRoot, 'bin')}:${process.env.PATH ?? ''}`,
  });
  server = spawn(
    join(ROOT, 'node_modules/.bin/tsx'),
    ['src/index.ts', 'web', '--host', '127.0.0.1', '--port', String(port)],
    {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  server.stdout?.on('data', (chunk) => (serverLog += chunk.toString()));
  server.stderr?.on('data', (chunk) => (serverLog += chunk.toString()));
  await waitForStatus();
}

async function stopServer(): Promise<void> {
  const child = server;
  server = null;
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit, rejectExit) => {
    let reapTimeout: ReturnType<typeof setTimeout> | undefined;
    const terminateTimeout = setTimeout(() => {
      child.kill('SIGKILL');
      reapTimeout = setTimeout(() => rejectExit(new Error('Codeman child did not exit after SIGKILL')), 5_000);
    }, 5_000);
    child.once('exit', () => {
      clearTimeout(terminateTimeout);
      if (reapTimeout) clearTimeout(reapTimeout);
      resolveExit();
    });
  });
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: authorization(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  const payload = await response.json();
  return payload.data ?? payload;
}

function readProbeEvents(): Array<Record<string, any>> {
  const content = readFileSync(probeLog, 'utf8');
  const completeContent = content.endsWith('\n') ? content : content.slice(0, content.lastIndexOf('\n') + 1);
  return completeContent
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForProbeBytes(startIndex: number, expected: Buffer, expectedCopies = 1): Promise<Buffer> {
  const deadline = Date.now() + 20_000;
  const targetLength = expected.length * expectedCopies;
  let bytes = Buffer.alloc(0);
  while (Date.now() < deadline) {
    bytes = Buffer.concat(
      readProbeEvents()
        .slice(startIndex)
        .filter((event) => event.type === 'stdin')
        .map((event) => Buffer.from(event.base64, 'base64'))
    );
    if (bytes.length >= targetLength) return bytes;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`probe timed out: expected ${targetLength} bytes, received ${bytes.length}`);
}

async function installPageTrace(): Promise<void> {
  await page.evaluate(() => {
    const trace = ((window as any).__cod356InputTrace ??= {
      logical: [],
      terminal: [],
      flushCalls: [],
      xtermWrites: [],
    });
    trace.logical = [];
    trace.terminal = [];
    trace.flushCalls ??= [];
    trace.xtermWrites ??= [];
    const app = (window as any).app;
    if (!app.__cod356InputWrapped) {
      const originalInput = app._sendInputAsync.bind(app);
      app._sendInputAsync = (id: string, data: string, options?: unknown) => {
        trace.logical.push({ id, data, timestamp: performance.now() });
        return originalInput(id, data, options);
      };
      const originalTerminal = app._onSessionTerminal.bind(app);
      app._onSessionTerminal = (event: { id: string; data: string }) => {
        trace.terminal.push({ ...event, timestamp: performance.now() });
        return originalTerminal(event);
      };
      app.__cod356InputWrapped = true;
    }
    if (!app.__cod356FlushWrapped) {
      let activeFlushId: number | null = null;
      let nextFlushId = 1;
      const originalWrite = app.terminal.write.bind(app.terminal);
      app.terminal.write = (data: string, callback?: () => void) => {
        const text = typeof data === 'string' ? data : '';
        const entry = {
          flushId: activeFlushId,
          startedAt: performance.now(),
          completedAt: null as number | null,
          drainedAt: null as number | null,
          byteLength: new TextEncoder().encode(text).byteLength,
          sample: `${text.slice(0, 128)}${text.slice(-128)}`,
        };
        trace.xtermWrites.push(entry);
        const result = originalWrite(data, () => {
          entry.drainedAt = performance.now();
          callback?.();
        });
        entry.completedAt = performance.now();
        return result;
      };
      const originalFlush = app.flushPendingWrites.bind(app);
      app.flushPendingWrites = (...args: unknown[]) => {
        const entry = { id: nextFlushId++, startedAt: performance.now(), completedAt: null as number | null };
        trace.flushCalls.push(entry);
        activeFlushId = entry.id;
        try {
          return originalFlush(...args);
        } finally {
          entry.completedAt = performance.now();
          activeFlushId = null;
        }
      };
      app.__cod356FlushWrapped = true;
    }
  });
}

async function openSession(): Promise<void> {
  await page.evaluate((id) => (window as any).app.selectSession(id), sessionId);
  await page.waitForFunction(
    (id) => {
      const app = (window as any).app;
      return app.activeSessionId === id && app._wsReady === true && app._wsSessionId === id && !!app.terminal?.buffer;
    },
    sessionId,
    { timeout: 20_000 }
  );
  await installPageTrace();
}

type TraceCursor = {
  probeIndex: number;
  wsIndex: number;
  httpIndex: number;
  logicalIndex: number;
  terminalIndex: number;
};

type ImePreviewMetrics = {
  pendingFrames: number;
  maxPendingFrames: number;
  pendingTimers: number;
  provisionalRenders: number;
  committedRenders: number;
  provisionalValues: string[];
  committedValues: string[];
  commitTransitions: Array<{ data: string; consumed: boolean; committed: boolean; latest: string }>;
  authoritativeTransitions: Array<{ beforeCommitted: boolean; afterCommitted: boolean }>;
  latestPreview: string;
  lastUpdateAt: number;
  lastRenderAt: number;
  dispatchElapsedMs: number;
  maxHandlerMs: number;
};

type ImeBurstSynchronousBudget = { dispatchElapsedMs: number; maxHandlerMs: number };

function isImeBurstWithinSynchronousBudget(
  metrics: Pick<ImePreviewMetrics, 'dispatchElapsedMs' | 'maxHandlerMs'>,
  budget: ImeBurstSynchronousBudget
): boolean {
  return metrics.dispatchElapsedMs <= budget.dispatchElapsedMs && metrics.maxHandlerMs <= budget.maxHandlerMs;
}

async function installMobileImePreviewTrace(): Promise<void> {
  await page.evaluate(() => {
    const app = (window as any).app;
    const api = (window as any).MobileImePreview;
    app._destroyMobileImePreview();
    const textarea = app.terminal.textarea;

    const metrics: ImePreviewMetrics = {
      pendingFrames: 0,
      maxPendingFrames: 0,
      pendingTimers: 0,
      provisionalRenders: 0,
      committedRenders: 0,
      provisionalValues: [],
      committedValues: [],
      commitTransitions: [],
      authoritativeTransitions: [],
      latestPreview: '',
      lastUpdateAt: 0,
      lastRenderAt: 0,
      dispatchElapsedMs: 0,
      maxHandlerMs: 0,
    };
    const activeTextareaListeners = new Map<EventListenerOrEventListenerObject, { type: string; capture: boolean }>();
    const activeWindowListeners = new Map<EventListenerOrEventListenerObject, string>();
    const removedWindowListeners: Array<{ type: string; listener: EventListenerOrEventListenerObject }> = [];
    const originalTextareaAdd = textarea.addEventListener.bind(textarea);
    const originalTextareaRemove = textarea.removeEventListener.bind(textarea);
    const originalWindowAdd = window.addEventListener.bind(window);
    const originalWindowRemove = window.removeEventListener.bind(window);
    const trackedTextareaTypes = new Set([
      'compositionstart',
      'compositionupdate',
      'input',
      'compositionend',
      'keydown',
      'blur',
    ]);
    const capture = (options?: boolean | AddEventListenerOptions) =>
      options === true || (typeof options === 'object' && options?.capture === true);
    textarea.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (trackedTextareaTypes.has(type)) activeTextareaListeners.set(listener, { type, capture: capture(options) });
      return originalTextareaAdd(type, listener, options);
    }) as typeof textarea.addEventListener;
    textarea.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      const tracked = activeTextareaListeners.get(listener);
      if (tracked?.type === type && tracked.capture === capture(options)) activeTextareaListeners.delete(listener);
      return originalTextareaRemove(type, listener, options);
    }) as typeof textarea.removeEventListener;
    window.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === 'offline' || type === 'pagehide') activeWindowListeners.set(listener, type);
      return originalWindowAdd(type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions
    ) => {
      if (activeWindowListeners.get(listener) === type) {
        activeWindowListeners.delete(listener);
        removedWindowListeners.push({ type, listener });
      }
      return originalWindowRemove(type, listener, options);
    }) as typeof window.removeEventListener;
    (window as any).__cod368 = {
      metrics,
      localEcho: { enabled: app._localEchoEnabled, policy: app._localEchoPolicy },
      seams: {
        textarea,
        originalTextareaAdd,
        originalTextareaRemove,
        originalWindowAdd,
        originalWindowRemove,
        activeTextareaListeners,
        activeWindowListeners,
        removedWindowListeners,
      },
    };

    const originalCreate = api.create;
    const originalEligibility = api.isIosWebKitTouch;
    api.isIosWebKitTouch = () => true;
    api.create = (options: Record<string, any>) => {
      const scheduled = new Map<number, boolean>();
      const scheduledTimers = new Map<number, boolean>();
      const controller = originalCreate({
        ...options,
        scheduleFrame(callback: FrameRequestCallback) {
          metrics.pendingFrames += 1;
          metrics.maxPendingFrames = Math.max(metrics.maxPendingFrames, metrics.pendingFrames);
          const id = requestAnimationFrame((timestamp) => {
            if (scheduled.delete(id)) metrics.pendingFrames -= 1;
            callback(timestamp);
          });
          scheduled.set(id, true);
          return id;
        },
        cancelFrame(id: number) {
          if (scheduled.delete(id)) metrics.pendingFrames -= 1;
          cancelAnimationFrame(id);
        },
        setTimer(callback: () => void, delay: number) {
          const id = window.setTimeout(() => {
            if (scheduledTimers.delete(id)) metrics.pendingTimers -= 1;
            callback();
          }, delay);
          scheduledTimers.set(id, true);
          metrics.pendingTimers += 1;
          return id;
        },
        clearTimer(id: number) {
          if (scheduledTimers.delete(id)) metrics.pendingTimers -= 1;
          clearTimeout(id);
        },
        render(value: { text: string; phase: 'provisional' | 'committed' }) {
          metrics.lastRenderAt = performance.now();
          metrics.latestPreview = value.text;
          if (value.phase === 'provisional') {
            metrics.provisionalRenders += 1;
            metrics.provisionalValues.push(value.text);
          } else {
            metrics.committedRenders += 1;
            metrics.committedValues.push(value.text);
          }
          return options.render(value);
        },
      });
      const originalConsume = controller.consumeTerminalData.bind(controller);
      controller.consumeTerminalData = (data: string) => {
        const consumed = originalConsume(data);
        const state = controller.state;
        if (consumed)
          metrics.commitTransitions.push({ data, consumed, committed: state.committed, latest: state.latest });
        return consumed;
      };
      const originalAuthoritative = controller.noteAuthoritativeOutput.bind(controller);
      controller.noteAuthoritativeOutput = () => {
        const beforeCommitted = controller.state.committed;
        originalAuthoritative();
        metrics.authoritativeTransitions.push({
          beforeCommitted,
          afterCommitted: controller.state.committed,
        });
      };
      return controller;
    };
    try {
      app._initMobileImePreview();
    } finally {
      api.create = originalCreate;
      api.isIosWebKitTouch = originalEligibility;
    }
    if (!app._mobileImePreview) throw new Error('mobile IME preview did not initialize');
    (window as any).__cod368.registrations = {
      textarea: activeTextareaListeners.size,
      window: activeWindowListeners.size,
    };
  });
}

async function destroyMobileImePreviewTrace(): Promise<void> {
  if (!page || page.isClosed()) return;
  await page.evaluate(async () => {
    const app = (window as any).app;
    const textarea = app.terminal.textarea;
    const trace = (window as any).__cod368;
    if (!trace) {
      app._destroyMobileImePreview();
      return;
    }
    const seams = trace.seams;
    try {
      if (app._mobileImePreview?.state?.composing) {
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
        await new Promise((resolveTask) => setTimeout(resolveTask, 0));
      }
      const before = {
        provisional: trace.metrics.provisionalRenders,
        committed: trace.metrics.committedRenders,
      };
      app._destroyMobileImePreview();
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'after-destroy' }));
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '' }));
      const detachedWindowTarget = new EventTarget();
      for (const { type, listener } of seams.removedWindowListeners) {
        detachedWindowTarget.addEventListener(type, listener);
      }
      detachedWindowTarget.dispatchEvent(new Event('offline'));
      detachedWindowTarget.dispatchEvent(new PageTransitionEvent('pagehide'));
      await new Promise((resolveFrame) => requestAnimationFrame(() => resolveFrame(undefined)));
      await new Promise((resolveTask) => setTimeout(resolveTask, 0));
      trace.cleanup = {
        controller: app._mobileImePreview,
        previewCount: document.querySelectorAll('.codeman-ime-preview').length,
        pendingFrames: trace.metrics.pendingFrames,
        pendingTimers: trace.metrics.pendingTimers,
        activeTextareaListeners: seams.activeTextareaListeners.size,
        activeWindowListeners: seams.activeWindowListeners.size,
        detachedWindowEvents: seams.removedWindowListeners.length,
        provisionalRendersAfterDestroy: trace.metrics.provisionalRenders - before.provisional,
        committedRendersAfterDestroy: trace.metrics.committedRenders - before.committed,
      };
    } finally {
      textarea.addEventListener = seams.originalTextareaAdd;
      textarea.removeEventListener = seams.originalTextareaRemove;
      window.addEventListener = seams.originalWindowAdd;
      window.removeEventListener = seams.originalWindowRemove;
      app._localEchoEnabled = trace.localEcho.enabled;
      app._localEchoPolicy = trace.localEcho.policy;
      app._initMobileImePreview();
    }
  });
}

function readProbeBytes(startIndex: number): Buffer {
  return Buffer.concat(
    readProbeEvents()
      .slice(startIndex)
      .filter((event) => event.type === 'stdin')
      .map((event) => Buffer.from(event.base64, 'base64'))
  );
}

type SerializedInputRecord = { data: string; seq: number; clientId: string };

async function readInputLayers(
  before: TraceCursor
): Promise<{ logical: string[]; ws: SerializedInputRecord[]; http: SerializedInputRecord[] }> {
  return page.evaluate((cursor) => {
    const trace = (window as any).__cod356InputTrace;
    const wire = (window as any).__cod356Wire;
    return {
      logical: trace.logical.slice(cursor.logicalIndex).map((entry: any) => entry.data),
      ws: wire.ws
        .slice(cursor.wsIndex)
        .filter((entry: any) => entry.frame?.t === 'i')
        .map((entry: any) => ({ data: entry.frame.d, seq: entry.frame.seq, clientId: entry.frame.cid })),
      http: wire.http
        .slice(cursor.httpIndex)
        .filter((entry: any) => typeof entry.body?.input === 'string')
        .map((entry: any) => ({
          data: entry.body.input,
          seq: entry.body.seq,
          clientId: entry.body.clientId,
        })),
    };
  }, before);
}

async function resetTrace(): Promise<TraceCursor> {
  const counts = await page.evaluate(() => {
    return {
      wsIndex: (window as any).__cod356Wire.ws.length,
      httpIndex: (window as any).__cod356Wire.http.length,
      logicalIndex: (window as any).__cod356InputTrace.logical.length,
      terminalIndex: (window as any).__cod356InputTrace.terminal.length,
    };
  });
  return { probeIndex: readProbeEvents().length, ...counts };
}

async function terminalContains(token: string): Promise<boolean> {
  return page.evaluate((value) => {
    const terminal = (window as any).app.terminal;
    const buffer = terminal?.buffer?.active;
    if (!buffer) return false;
    let rendered = '';
    for (let row = 0; row < buffer.length; row++) rendered += buffer.getLine(row)?.translateToString(false) ?? '';
    return rendered.includes(value);
  }, token);
}

async function withForcedHttp<T>(transport: 'ws' | 'http', operation: () => Promise<T>): Promise<T> {
  if (transport === 'ws') return operation();
  const current = await page.evaluate(() => {
    const app = (window as any).app;
    const active = app._wsSessionId;
    app._wsSessionId = '__cod356_force_http__';
    return active;
  });
  try {
    return await operation();
  } finally {
    await page.evaluate((active) => {
      const app = (window as any).app;
      if (app._wsSessionId === '__cod356_force_http__') app._wsSessionId = active;
    }, current);
  }
}

async function restoreAckDelivery(): Promise<void> {
  if (!page || page.isClosed()) return;
  await page.evaluate(() => {
    const app = (window as any).app;
    const original = (window as any).__cod356OriginalAckDelivery ?? (window as any).__cod356SavedAckDelivery;
    if (app && original) app._ackDelivery = original;
    delete (window as any).__cod356OriginalAckDelivery;
    delete (window as any).__cod356SavedAckDelivery;
    delete (window as any).__cod356DelayedAcks;
    delete (window as any).__cod356ReconnectAcks;
  });
}

async function assertCurrentLayers(
  before: TraceCursor,
  inputs: readonly string[],
  transport: 'ws' | 'http' = 'ws',
  serializedCopies?: number
): Promise<void> {
  const visibleTokens = readProbeEvents()
    .slice(before.probeIndex)
    .filter((event) => event.type === 'stdin')
    .map((event) => event.base64 as string);
  expect(visibleTokens.length).toBeGreaterThan(0);
  await page.waitForFunction(
    ({ terminalIndex, tokens }) => {
      const output = (window as any).__cod356InputTrace.terminal
        .slice(terminalIndex)
        .map((entry: any) => entry.data)
        .join('');
      return tokens.every((token) => output.includes(token.slice(-48)));
    },
    { terminalIndex: before.terminalIndex, tokens: visibleTokens },
    { timeout: 10_000 }
  );
  const layers = await page.evaluate(
    ({ before, transport }) => ({
      logical: (window as any).__cod356InputTrace.logical.slice(before.logicalIndex).map((entry: any) => entry.data),
      serialized:
        transport === 'ws'
          ? (window as any).__cod356Wire.ws
              .slice(before.wsIndex)
              .filter((entry: any) => entry.frame?.t === 'i')
              .map((entry: any) => ({ data: entry.frame.d, seq: entry.frame.seq, clientId: entry.frame.cid }))
          : (window as any).__cod356Wire.http
              .slice(before.httpIndex)
              .filter((entry: any) => typeof entry.body?.input === 'string')
              .map((entry: any) => ({
                data: entry.body.input,
                seq: entry.body.seq,
                clientId: entry.body.clientId,
              })),
      terminal: (window as any).__cod356InputTrace.terminal.slice(before.terminalIndex),
    }),
    { before, transport }
  );
  expect(layers.logical).toEqual(inputs);
  expect(layers.serialized.length).toBeGreaterThanOrEqual(inputs.length);
  if (serializedCopies !== undefined) expect(layers.serialized).toHaveLength(inputs.length * serializedCopies);
  const records = new Map<string, string>();
  for (const record of layers.serialized) {
    expect(record).toMatchObject({ data: expect.any(String), seq: expect.any(Number), clientId: expect.any(String) });
    const key = `${record.clientId}:${record.seq}`;
    const prior = records.get(key);
    if (prior !== undefined) expect(record.data).toBe(prior);
    else records.set(key, record.data);
  }
  expect([...records.values()]).toEqual(inputs);
  const terminalOutput = layers.terminal.map((entry: any) => entry.data).join('');
  for (const token of visibleTokens) expect(terminalOutput).toContain(token.slice(-48));
  await expect.poll(() => terminalContains(visibleTokens.at(-1)!.slice(-48)), { timeout: 10_000 }).toBe(true);
}

async function deliverAndTrace(transport: 'ws' | 'http', inputs: readonly string[]): Promise<void> {
  const before = await resetTrace();
  const expected = Buffer.from(inputs.join(''));
  await withForcedHttp(transport, async () => {
    await page.evaluate(
      ({ id, records }) => {
        const app = (window as any).app;
        for (const data of records) app._sendInputAsync(id, data);
      },
      { id: sessionId, records: inputs }
    );

    expect(await waitForProbeBytes(before.probeIndex, expected)).toEqual(expected);
    await page.waitForFunction(
      ({ index, transport, count }) => {
        const entries =
          transport === 'ws'
            ? (window as any).__cod356Wire.ws.slice(index).filter((entry: any) => entry.frame?.t === 'i')
            : (window as any).__cod356Wire.http
                .slice(index)
                .filter((entry: any) => typeof entry.body?.input === 'string');
        return entries.length >= count;
      },
      { index: transport === 'ws' ? before.wsIndex : before.httpIndex, transport, count: inputs.length },
      { timeout: 10_000 }
    );
    await page.waitForFunction(() => (window as any).app._pendingDeliveries.size === 0, undefined, { timeout: 10_000 });
    await assertCurrentLayers(before, inputs, transport);
  });
}

beforeAll(async () => {
  testRoot = mkdtempSync(join(tmpdir(), 'cod356-input-browser-'));
  dataDir = join(testRoot, 'data');
  probeLog = join(testRoot, 'probe.jsonl');
  socketName = `cod356-input-${process.pid}-${Date.now()}`;
  mkdirSync(join(testRoot, 'bin'), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(probeLog, '');
  const shim = join(testRoot, 'bin', 'codex');
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${PROBE}"\n`);
  chmodSync(shim, 0o700);
  port = await choosePort();
  baseUrl = `http://127.0.0.1:${port}`;
  await startServer();

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    httpCredentials: { username: USERNAME, password: PASSWORD },
  });
  page = await context.newPage();
  await page.addInitScript(() => {
    const wire = ((window as any).__cod356Wire = { ws: [], http: [] });
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      let frame = null;
      if (typeof data === 'string') {
        try {
          frame = JSON.parse(data);
        } catch {}
      }
      wire.ws.push({ data, frame, timestamp: performance.now() });
      return originalSend.call(this, data);
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (/\/api\/sessions\/[^/]+\/input$/.test(url)) {
        let body = null;
        try {
          body = JSON.parse(String(init?.body));
        } catch {}
        wire.http.push({ url, body, timestamp: performance.now() });
      }
      return originalFetch(input, init);
    };
  });
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, { timeout: 20_000 });

  const created = await api('POST', '/api/sessions', {
    mode: 'codex',
    workingDir: testRoot,
    name: 'cod356-input-probe',
  });
  sessionId = created.session?.id ?? created.id ?? created.sessionId;
  expect(sessionId).toBeTruthy();
  await openSession();
  const readyDeadline = Date.now() + 20_000;
  while (!readProbeEvents().some((event) => event.type === 'ready')) {
    if (Date.now() >= readyDeadline) throw new Error('input probe did not become ready');
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
}, 120_000);

afterAll(async () => {
  if (sessionId && server) await api('DELETE', `/api/sessions/${sessionId}`).catch(() => undefined);
  await context?.close();
  await browser?.close();
  await stopServer();
  try {
    execFileSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
  } catch {
    // Exact disposable server already exited.
  }
  if (testRoot) rmSync(testRoot, { recursive: true, force: true });
}, 60_000);

afterEach(async () => {
  await restoreAckDelivery();
});

const payloadCases = [
  ['500 identical printable characters', ['x'.repeat(500)]],
  ['repeated runs', ['aaabbb111___']],
  ['rapid printable/control/Enter boundaries', ['ab', '\x03', 'cd', '\x1b', 'ef', '\r']],
  // Leave room for the reliable-delivery JSON envelope so the HTTP fallback's
  // keepalive request remains below Chromium's 64 KiB serialized-body cap.
  ['paste near the configured input limit', ['p'.repeat(MAX_INPUT_LENGTH - 1024)]],
] as const;

describe('terminal input real browser/server/probe correlation', () => {
  it.each(['ws', 'http'] as const)(
    '%s preserves deterministic payloads at every production layer',
    async (transport) => {
      for (const [_label, inputs] of payloadCases) await deliverAndTrace(transport, inputs);
    },
    120_000
  );

  it.each(['ws', 'http'] as const)(
    '%s sends one real CJK composition commit without intermediates',
    async (transport) => {
      const before = await resetTrace();
      await withForcedHttp(transport, async () => {
        await page.evaluate(() => {
          const app = (window as any).app;
          const cjk = document.querySelector<HTMLTextAreaElement>('#cjkInput')!;
          // app.js declares CjkInput as a global lexical binding rather than a
          // window property. Direct eval reaches that exact production helper.
          const cjkInput = eval('CjkInput');
          cjkInput.init({ send: (text: string) => app._handleCjkInput(text) });
          cjk.value = '\u200b';
          cjk.dispatchEvent(new CompositionEvent('compositionstart'));
          cjk.value = '\u200b你';
          cjk.dispatchEvent(new InputEvent('input', { data: '你', inputType: 'insertCompositionText' }));
          cjk.value = '\u200b你好';
          cjk.dispatchEvent(new InputEvent('input', { data: '你好', inputType: 'insertCompositionText' }));
          cjk.dispatchEvent(new CompositionEvent('compositionend', { data: '你好' }));
          cjk.dispatchEvent(new InputEvent('input', { data: '你好', inputType: 'insertFromComposition' }));
        });
        const expected = Buffer.from('你好');
        expect(await waitForProbeBytes(before.probeIndex, expected)).toEqual(expected);
        await page.waitForFunction(() => (window as any).app._pendingDeliveries.size === 0, undefined, {
          timeout: 10_000,
        });
        await new Promise((resolveWait) => setTimeout(resolveWait, 200));
        const bytes = Buffer.concat(
          readProbeEvents()
            .slice(before.probeIndex)
            .filter((event) => event.type === 'stdin')
            .map((event) => Buffer.from(event.base64, 'base64'))
        );
        expect(bytes).toEqual(expected);
        await assertCurrentLayers(before, ['你好'], transport);
      });
    }
  );

  it('holds a five-second mobile composition visually without sending provisional PTY bytes', async () => {
    const before = await resetTrace();
    const committedText = 'held-mobile-composition';
    let stableLayers: Awaited<ReturnType<typeof readInputLayers>> | undefined;
    let stableBytes: Buffer | undefined;
    let previewInstallAttempted = false;
    try {
      previewInstallAttempted = true;
      await installMobileImePreviewTrace();
      expect(await page.evaluate(() => (window as any).__cod368.registrations)).toEqual({ textarea: 6, window: 2 });
      await page.evaluate(async () => {
        const app = (window as any).app;
        app._localEchoEnabled = false;
        app._localEchoPolicy = 'off';
        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart'));
        for (let index = 1; index <= 20; index++) {
          const value = index === 20 ? 'held-mobile-composition' : `held-mobile-${index}`;
          textarea.value = value;
          (window as any).__cod368.metrics.lastUpdateAt = performance.now();
          textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: value }));
          await new Promise((resolveUpdate) => setTimeout(resolveUpdate, 250));
        }
      });
      await expect.poll(() => page.locator('.codeman-ime-preview').textContent()).toBe(committedText);
      await expect.poll(() => page.locator('.codeman-ime-preview').getAttribute('data-phase')).toBe('provisional');

      expect(readProbeBytes(before.probeIndex)).toEqual(Buffer.alloc(0));
      expect(await readInputLayers(before)).toEqual({ logical: [], ws: [], http: [] });

      await page.evaluate((text) => {
        const app = (window as any).app;
        const textarea = app.terminal.textarea;
        textarea.value = text;
        textarea.dispatchEvent(new CompositionEvent('compositionend', { data: text }));
      }, committedText);

      expect(await waitForProbeBytes(before.probeIndex, Buffer.from(committedText))).toEqual(
        Buffer.from(committedText)
      );
      await page.waitForFunction(() => (window as any).app._pendingDeliveries.size === 0, undefined, {
        timeout: 10_000,
      });
      await assertCurrentLayers(before, [committedText]);
      await page.waitForTimeout(200);
      stableBytes = readProbeBytes(before.probeIndex);
      stableLayers = await readInputLayers(before);
      expect(stableBytes).toEqual(Buffer.from(committedText));
      expect(stableLayers.logical).toEqual([committedText]);
      expect(stableLayers.http).toEqual([]);
      expect(stableLayers.ws.length).toBeGreaterThanOrEqual(1);
      expect(stableLayers.ws.every((record) => record.data === committedText)).toBe(true);
      expect(new Set(stableLayers.ws.map((record) => `${record.clientId}:${record.seq}`)).size).toBe(1);

      const settled = await page.evaluate(() => ({
        metrics: (window as any).__cod368.metrics as ImePreviewMetrics,
        state: (window as any).app._mobileImePreview?.state,
        preview: document.querySelector('.codeman-ime-preview')?.textContent ?? null,
      }));
      expect(settled.metrics.commitTransitions).toEqual([
        { data: committedText, consumed: true, committed: true, latest: committedText },
      ]);
      expect(settled.metrics.committedRenders).toBeLessThanOrEqual(1);
      expect(settled.metrics.committedValues).toEqual(settled.metrics.committedRenders === 1 ? [committedText] : []);
      if (settled.metrics.committedRenders === 0) {
        expect(settled.metrics.authoritativeTransitions).toContainEqual({
          beforeCommitted: true,
          afterCommitted: false,
        });
      }
      expect(settled).toMatchObject({
        state: {
          committed: false,
          framePending: false,
          timerPending: false,
        },
        preview: '',
      });
    } finally {
      if (previewInstallAttempted) await destroyMobileImePreviewTrace();
    }

    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__cod368.cleanup)).toEqual({
      controller: null,
      previewCount: 0,
      pendingFrames: 0,
      pendingTimers: 0,
      activeTextareaListeners: 0,
      activeWindowListeners: 0,
      detachedWindowEvents: 2,
      provisionalRendersAfterDestroy: 0,
      committedRendersAfterDestroy: 0,
    });
    expect(readProbeBytes(before.probeIndex)).toEqual(stableBytes);
    expect(await readInputLayers(before)).toEqual(stableLayers);
  }, 30_000);

  it.each([
    ['unthrottled desktop viewport', 1, { width: 1280, height: 800 }, 500],
    ['4x CPU throttling at keyboard-sized mobile viewport', 4, { width: 390, height: 520 }, 2_000],
  ] as const)('collapses a 500-update IME burst under %s', async (_label, cpuRate, viewport, dispatchBudgetMs) => {
    const before = await resetTrace();
    const originalViewport = page.viewportSize() ?? { width: 1280, height: 800 };
    let cdp: Awaited<ReturnType<BrowserContext['newCDPSession']>> | undefined;
    let previewInstallAttempted = false;
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
      await page.setViewportSize(viewport);
      await page.waitForFunction(
        ({ width, height }) => window.innerWidth === width && window.innerHeight === height,
        viewport
      );
      expect(await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))).toEqual(viewport);
      previewInstallAttempted = true;
      await installMobileImePreviewTrace();
      expect(await page.evaluate(() => (window as any).__cod368.registrations)).toEqual({ textarea: 6, window: 2 });
      await page.evaluate(() => {
        const app = (window as any).app;
        const textarea = app.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart'));
        const dispatchStartedAt = performance.now();
        let maxHandlerMs = 0;
        for (let index = 1; index <= 500; index++) {
          (window as any).__cod368.metrics.lastUpdateAt = performance.now();
          const handlerStartedAt = performance.now();
          textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: `value-${index}` }));
          maxHandlerMs = Math.max(maxHandlerMs, performance.now() - handlerStartedAt);
        }
        (window as any).__cod368.metrics.dispatchElapsedMs = performance.now() - dispatchStartedAt;
        (window as any).__cod368.metrics.maxHandlerMs = maxHandlerMs;
      });
      await expect.poll(() => page.locator('.codeman-ime-preview').textContent()).toBe('value-500');
      const metrics = await page.evaluate(() => (window as any).__cod368.metrics as ImePreviewMetrics);
      expect(metrics.maxPendingFrames).toBe(1);
      expect(metrics.provisionalRenders).toBeLessThanOrEqual(2);
      expect(metrics.provisionalValues.at(-1)).toBe('value-500');
      expect(metrics.latestPreview).toBe('value-500');
      expect(metrics.lastRenderAt - metrics.lastUpdateAt).toBeLessThanOrEqual(100);
      // Total wall time includes host descheduling and CDP's deliberate slowdown,
      // so scale it with the throttle rate. The per-handler ceiling remains fixed
      // to catch synchronous application work independently of host contention.
      expect(
        isImeBurstWithinSynchronousBudget(metrics, {
          dispatchElapsedMs: dispatchBudgetMs,
          maxHandlerMs: 50,
        })
      ).toBe(true);
      expect(readProbeBytes(before.probeIndex)).toEqual(Buffer.alloc(0));
      expect(await readInputLayers(before)).toEqual({ logical: [], ws: [], http: [] });
    } finally {
      try {
        if (previewInstallAttempted) await destroyMobileImePreviewTrace();
      } finally {
        try {
          if (cdp) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
        } finally {
          try {
            if (cdp) await cdp.detach();
          } finally {
            await page.setViewportSize(originalViewport);
          }
        }
      }
    }
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__cod368.cleanup)).toEqual({
      controller: null,
      previewCount: 0,
      pendingFrames: 0,
      pendingTimers: 0,
      activeTextareaListeners: 0,
      activeWindowListeners: 0,
      detachedWindowEvents: 2,
      provisionalRendersAfterDestroy: 0,
      committedRendersAfterDestroy: 0,
    });
    expect(readProbeBytes(before.probeIndex)).toEqual(Buffer.alloc(0));
    expect(await readInputLayers(before)).toEqual({ logical: [], ws: [], http: [] });
  });

  it('rejects a multi-second synchronous IME handler backlog even under 4x throttling', () => {
    const throttledBudget = { dispatchElapsedMs: 2_000, maxHandlerMs: 50 };
    expect(isImeBurstWithinSynchronousBudget({ dispatchElapsedMs: 1_999, maxHandlerMs: 49 }, throttledBudget)).toBe(
      true
    );
    expect(isImeBurstWithinSynchronousBudget({ dispatchElapsedMs: 5_000, maxHandlerMs: 50 }, throttledBudget)).toBe(
      false
    );
    expect(isImeBurstWithinSynchronousBudget({ dispatchElapsedMs: 100, maxHandlerMs: 5_000 }, throttledBudget)).toBe(
      false
    );
  });

  it('restores the real WebSocket target when an HTTP-scoped assertion fails', async () => {
    const active = await page.evaluate(() => (window as any).app._wsSessionId);
    await expect(
      withForcedHttp('http', async () => {
        expect(await page.evaluate(() => (window as any).app._wsSessionId)).toBe('__cod356_force_http__');
        throw new Error('intentional cleanup probe');
      })
    ).rejects.toThrow('intentional cleanup probe');
    expect(await page.evaluate(() => (window as any).app._wsSessionId)).toBe(active);
  });

  it('scopes current-trial traces without clearing the shared real-session terminal', async () => {
    await page.evaluate(() => {
      const terminal = (window as any).app.terminal;
      (window as any).__cod356OriginalTerminalClear = terminal.clear.bind(terminal);
      terminal.clear = () => {
        throw new Error('shared terminal clear is forbidden');
      };
    });
    try {
      await expect(resetTrace()).resolves.toEqual({
        probeIndex: expect.any(Number),
        wsIndex: expect.any(Number),
        httpIndex: expect.any(Number),
        logicalIndex: expect.any(Number),
        terminalIndex: expect.any(Number),
      });
    } finally {
      await page.evaluate(() => {
        const terminal = (window as any).app.terminal;
        terminal.clear = (window as any).__cod356OriginalTerminalClear;
        delete (window as any).__cod356OriginalTerminalClear;
      });
    }
  });

  it('records first-visible convergence before a separately observed xterm drain callback', async () => {
    const before = await resetTrace();
    const input = 'visible-boundary';
    const token = `COD356_ECHO:${Buffer.from(input).toString('base64')}`;
    const visibleObservation = await armFirstVisibleObservation(page, token);
    const sentAt = await page.evaluate(
      ({ id, data }) => {
        const timestamp = performance.now();
        (window as any).app._sendInputAsync(id, data);
        return timestamp;
      },
      { id: sessionId, data: input }
    );
    expect(await waitForProbeBytes(before.probeIndex, Buffer.from(input))).toEqual(Buffer.from(input));
    const visibleDetectedAt = await visibleObservation.wait();
    const xtermDrainAt = await page.evaluate(
      () =>
        new Promise<number>((resolveDrain) =>
          (window as any).app.terminal.write('', () => resolveDrain(performance.now()))
        )
    );
    const productionBoundaries = await page.evaluate((value) => {
      const trace = (window as any).__cod356InputTrace;
      const write = trace.xtermWrites?.find((entry: any) => entry.sample.includes(value));
      const flush = trace.flushCalls?.find((entry: any) => entry.id === write?.flushId);
      return { write: write ?? null, flush: flush ?? null };
    }, token);
    expect(productionBoundaries.flush).toMatchObject({
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
    });
    expect(productionBoundaries.write).toMatchObject({ startedAt: expect.any(Number), drainedAt: expect.any(Number) });
    expect(productionBoundaries.flush!.startedAt).toBeLessThanOrEqual(productionBoundaries.flush!.completedAt);
    expect(productionBoundaries.flush!.startedAt).toBeLessThanOrEqual(visibleDetectedAt);
    expect(visibleDetectedAt).toBeGreaterThanOrEqual(sentAt);
    expect(xtermDrainAt).toBeGreaterThanOrEqual(visibleDetectedAt);
    expect(visibleDetectedAt - sentAt).toBeLessThanOrEqual(xtermDrainAt - sentAt);
    await assertCurrentLayers(before, [input]);
  });

  it('pre-arms deterministic current-token observation across queued and direct writes', async () => {
    const isolatedPage = await context.newPage();
    try {
      await isolatedPage.setContent('<div id="terminal"></div>');
      await isolatedPage.addScriptTag({ url: `${baseUrl}/vendor/xterm.min.js` });
      await isolatedPage.evaluate(() => {
        const terminal = new (window as any).Terminal({ cols: 80, rows: 24 });
        terminal.open(document.getElementById('terminal'));
        (window as any).app = {
          terminal,
          pendingWrites: [] as string[],
          flushPendingWrites() {
            const joined = this.pendingWrites.join('');
            this.pendingWrites = [];
            this.terminal.write(joined);
          },
        };
      });
      for (let iteration = 0; iteration < 24; iteration++) {
        const source = iteration % 2 === 0 ? 'queued-flush' : 'direct-write';
        const token = `COD356_OBSERVER:${source}:${iteration}`;
        const observation = await armFirstVisibleObservation(isolatedPage, token);
        const writeStartedAt = await isolatedPage.evaluate(
          ({ value, selectedSource }) => {
            const app = (window as any).app;
            const startedAt = performance.now();
            if (selectedSource === 'queued-flush') {
              app.pendingWrites.push(value);
              app.flushPendingWrites();
            } else {
              app.terminal.write(value);
            }
            return startedAt;
          },
          { value: token, selectedSource: source }
        );
        const detectedAt = await observation.wait();
        expect(detectedAt).toBeGreaterThanOrEqual(writeStartedAt);
        expect(
          await isolatedPage.evaluate((value) => {
            const buffer = (window as any).app.terminal.buffer.active;
            let rendered = '';
            for (let row = 0; row < buffer.length; row++) {
              rendered += buffer.getLine(row)?.translateToString(false) ?? '';
            }
            return rendered.includes(value);
          }, token)
        ).toBe(true);
        expect(
          await isolatedPage.evaluate(() => ({
            listenerRetained: Boolean((window as any).__cod356VisibleObservation?.disposable),
            timerRetained: Boolean((window as any).__cod356VisibleObservation?.timeoutId),
          }))
        ).toEqual({ listenerRetained: false, timerRetained: false });
      }

      await expect(
        withInputTrialObservation(isolatedPage, 'COD356_OBSERVER:cleanup-failure', async () => {
          throw new Error('intentional post-arm failure');
        })
      ).rejects.toThrow('intentional post-arm failure');
      expect(
        await isolatedPage.evaluate(() => ({
          listenerRetained: Boolean((window as any).__cod356VisibleObservation?.disposable),
          timerRetained: Boolean((window as any).__cod356VisibleObservation?.timeoutId),
        }))
      ).toEqual({ listenerRetained: false, timerRetained: false });

      await armFirstVisibleObservation(isolatedPage, 'COD356_OBSERVER:timeout-cleanup', { timeoutMs: 20 });
      await isolatedPage.waitForTimeout(50);
      expect(
        await isolatedPage.evaluate(() => ({
          listenerRetained: Boolean((window as any).__cod356VisibleObservation?.disposable),
          timerRetained: Boolean((window as any).__cod356VisibleObservation?.timeoutId),
        }))
      ).toEqual({ listenerRetained: false, timerRetained: false });
    } finally {
      await isolatedPage.close();
    }
  });

  it('preserves authoritative screen alignment across repeated real probe trials', async () => {
    for (let iteration = 0; iteration < 24; iteration++) {
      const input = `probe-observer-${iteration}:aaabbb111___`;
      const token = `COD356_ECHO:${Buffer.from(input).toString('base64')}`;
      const beforeProbe = readProbeEvents().length;
      const observation = await prepareInputTrialObservation(page, token);
      await page.evaluate(({ id, data }) => (window as any).app._sendInputAsync(id, data), {
        id: sessionId,
        data: input,
      });
      expect(await waitForProbeBytes(beforeProbe, Buffer.from(input))).toEqual(Buffer.from(input));
      expect(await observation.waitForDetection()).toMatchObject({
        token,
        timestamp: expect.any(Number),
        snapshot: {
          active: { containsToken: true },
        },
      });
      expect(
        await page.evaluate(() => ({
          listenerRetained: Boolean((window as any).__cod356VisibleObservation?.disposable),
          timerRetained: Boolean((window as any).__cod356VisibleObservation?.timeoutId),
        }))
      ).toEqual({ listenerRetained: false, timerRetained: false });
    }
  });

  it('restores an ACK delivery override through the shared cleanup helper', async () => {
    await page.evaluate(() => {
      const app = (window as any).app;
      (window as any).__cod356OriginalAckDelivery = app._ackDelivery.bind(app);
      app._ackDelivery = () => {
        throw new Error('leaked ACK override');
      };
    });
    await restoreAckDelivery();
    await expect(page.evaluate(() => (window as any).app._ackDelivery('__missing__', -1))).resolves.toBeUndefined();
    expect(await page.evaluate(() => (window as any).__cod356OriginalAckDelivery)).toBeUndefined();
  });

  it('redelivers while an ACK is delayed but writes the real PTY exactly once', async () => {
    const before = await resetTrace();
    await page.evaluate((id) => {
      const app = (window as any).app;
      (window as any).__cod356SavedAckDelivery = app._ackDelivery.bind(app);
      (window as any).__cod356DelayedAcks = [];
      app._ackDelivery = (targetId: string, seq: number) => {
        (window as any).__cod356DelayedAcks.push([targetId, seq]);
      };
      app._sendInputAsync(id, 'delayed-ack');
    }, sessionId);
    expect(await waitForProbeBytes(before.probeIndex, Buffer.from('delayed-ack'))).toEqual(Buffer.from('delayed-ack'));
    expect(await page.evaluate(() => (window as any).app._pendingDeliveries.size)).toBe(1);
    await page.waitForFunction(() => (window as any).__cod356DelayedAcks.length >= 1, undefined, { timeout: 10_000 });
    await page.evaluate((id) => {
      const app = (window as any).app;
      app._pendingDeliveries.get(id)[0].sentAt = Date.now() - app._reliableAckTimeoutMs - 1;
      app._wsLastRecvAt = Date.now();
      app._redeliverSweep();
    }, sessionId);
    await page.waitForFunction(
      (index) =>
        (window as any).__cod356Wire.ws.slice(index).filter((entry: any) => entry.frame?.d === 'delayed-ack').length ===
        2,
      before.wsIndex,
      { timeout: 10_000 }
    );
    await page.waitForFunction(() => (window as any).__cod356DelayedAcks.length >= 2, undefined, { timeout: 10_000 });
    const bytes = Buffer.concat(
      readProbeEvents()
        .slice(before.probeIndex)
        .filter((event) => event.type === 'stdin')
        .map((event) => Buffer.from(event.base64, 'base64'))
    );
    expect(bytes).toEqual(Buffer.from('delayed-ack'));
    await assertCurrentLayers(before, ['delayed-ack'], 'ws', 2);
    await page.evaluate(() => {
      const app = (window as any).app;
      const delayedAck = (window as any).__cod356DelayedAcks[0];
      app._ackDelivery = (window as any).__cod356SavedAckDelivery;
      app._ackDelivery(delayedAck[0], delayedAck[1]);
    });
    expect(await page.evaluate(() => (window as any).app._pendingDeliveries.size)).toBe(0);
  });

  it('lost ACK redelivery serializes twice but reaches the real PTY exactly once', async () => {
    const before = await resetTrace();
    await page.evaluate((id) => {
      const app = (window as any).app;
      const original = app._ackDelivery.bind(app);
      (window as any).__cod356OriginalAckDelivery = original;
      let dropped = false;
      app._ackDelivery = (targetId: string, seq: number) => {
        if (!dropped) {
          dropped = true;
          return;
        }
        app._ackDelivery = original;
        return original(targetId, seq);
      };
      app._sendInputAsync(id, 'lost-ack-once');
    }, sessionId);
    expect(await waitForProbeBytes(before.probeIndex, Buffer.from('lost-ack-once'))).toEqual(
      Buffer.from('lost-ack-once')
    );
    await page.evaluate((id) => {
      const app = (window as any).app;
      app._pendingDeliveries.get(id)[0].sentAt = Date.now() - app._reliableAckTimeoutMs - 1;
      app._wsLastRecvAt = Date.now();
      app._redeliverSweep();
    }, sessionId);
    await page.waitForFunction(() => (window as any).app._pendingDeliveries.size === 0, undefined, { timeout: 10_000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const bytes = Buffer.concat(
      readProbeEvents()
        .slice(before.probeIndex)
        .filter((event) => event.type === 'stdin')
        .map((event) => Buffer.from(event.base64, 'base64'))
    );
    expect(bytes).toEqual(Buffer.from('lost-ack-once'));
    await assertCurrentLayers(before, ['lost-ack-once'], 'ws', 2);
  });

  it('reconnects a pending durable record over a real socket with one PTY write', async () => {
    const before = await resetTrace();
    await page.evaluate((id) => {
      const app = (window as any).app;
      (window as any).__cod356SavedAckDelivery = app._ackDelivery.bind(app);
      (window as any).__cod356ReconnectAcks = [];
      app._ackDelivery = (...args: unknown[]) => (window as any).__cod356ReconnectAcks.push(args);
      app._sendInputAsync(id, 'socket-reconnect');
      app._persistReliableNow();
    }, sessionId);
    expect(await waitForProbeBytes(before.probeIndex, Buffer.from('socket-reconnect'))).toEqual(
      Buffer.from('socket-reconnect')
    );
    await assertCurrentLayers(before, ['socket-reconnect']);
    await page.evaluate(() => {
      (window as any).app._ws.close();
    });
    await page.waitForFunction(
      (wsIndex) =>
        (window as any).app._wsReady === true &&
        (window as any).__cod356Wire.ws
          .slice(wsIndex)
          .filter((entry: any) => entry.frame?.t === 'i' && entry.frame.d === 'socket-reconnect').length === 2 &&
        (window as any).__cod356ReconnectAcks.length >= 2,
      before.wsIndex,
      { timeout: 20_000 }
    );
    await page.evaluate(() => {
      const app = (window as any).app;
      const original = (window as any).__cod356SavedAckDelivery;
      app._ackDelivery = original;
      original(...(window as any).__cod356ReconnectAcks[0]);
    });
    await page.waitForFunction(() => (window as any).app._pendingDeliveries.size === 0);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const bytes = Buffer.concat(
      readProbeEvents()
        .slice(before.probeIndex)
        .filter((event) => event.type === 'stdin')
        .map((event) => Buffer.from(event.base64, 'base64'))
    );
    expect(bytes).toEqual(Buffer.from('socket-reconnect'));
    await assertCurrentLayers(before, ['socket-reconnect'], 'ws', 2);
  });

  it('reloads a pending durable record and server dedup keeps PTY bytes exactly once', async () => {
    const before = await resetTrace();
    const identity = await page.evaluate((id) => {
      const app = (window as any).app;
      const clientId = app._clientId;
      (window as any).__cod356OriginalAckDelivery = app._ackDelivery.bind(app);
      app._ackDelivery = () => {};
      app._sendInputAsync(id, 'reload-pending');
      app._persistReliableNow();
      return clientId;
    }, sessionId);
    expect(await waitForProbeBytes(before.probeIndex, Buffer.from('reload-pending'))).toEqual(
      Buffer.from('reload-pending')
    );
    await assertCurrentLayers(before, ['reload-pending']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, { timeout: 20_000 });
    await openSession();
    await page.waitForFunction(() => (window as any).app._pendingDeliveries.size === 0, undefined, { timeout: 20_000 });
    expect(await page.evaluate(() => (window as any).app._clientId)).toBe(identity);
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const bytes = Buffer.concat(
      readProbeEvents()
        .slice(before.probeIndex)
        .filter((event) => event.type === 'stdin')
        .map((event) => Buffer.from(event.base64, 'base64'))
    );
    expect(bytes).toEqual(Buffer.from('reload-pending'));
    expect(
      await page.evaluate(() => ({
        logical: (window as any).__cod356InputTrace.logical.map((entry: any) => entry.data),
        serialized: [
          ...(window as any).__cod356Wire.ws
            .filter((entry: any) => entry.frame?.d === 'reload-pending')
            .map((entry: any) => entry.frame.d),
          ...(window as any).__cod356Wire.http
            .filter((entry: any) => entry.body?.input === 'reload-pending')
            .map((entry: any) => entry.body.input),
        ],
      }))
    ).toEqual({ logical: [], serialized: ['reload-pending'] });
    await expect
      .poll(() => terminalContains(Buffer.from('reload-pending').toString('base64')), { timeout: 10_000 })
      .toBe(true);
  }, 60_000);

  it('identifies process-local server dedup as the restart-before-ACK duplicate layer', async () => {
    const before = await resetTrace();
    await page.evaluate((id) => {
      const app = (window as any).app;
      (window as any).__cod356OriginalAckDelivery = app._ackDelivery.bind(app);
      app._ackDelivery = () => {};
      app._sendInputAsync(id, 'restart-window');
      app._persistReliableNow();
    }, sessionId);
    expect(await waitForProbeBytes(before.probeIndex, Buffer.from('restart-window'))).toEqual(
      Buffer.from('restart-window')
    );
    await assertCurrentLayers(before, ['restart-window']);
    await stopServer();
    await verifyPortReleased();
    const tmuxSessions = execFileSync('tmux', ['-L', socketName, 'list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
    });
    expect(tmuxSessions.split('\n')).toContain(`codeman-${sessionId.slice(0, 8)}`);
    await startServer();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, { timeout: 20_000 });
    await openSession();
    const duplicated = await waitForProbeBytes(before.probeIndex, Buffer.from('restart-window'), 2);
    expect(duplicated).toEqual(Buffer.from('restart-windowrestart-window'));
    expect(await page.evaluate(() => (window as any).app._pendingDeliveries.size)).toBe(0);
    expect(
      await page.evaluate(() => ({
        logical: (window as any).__cod356InputTrace.logical.map((entry: any) => entry.data),
        serialized: [
          ...(window as any).__cod356Wire.ws
            .filter((entry: any) => entry.frame?.d === 'restart-window')
            .map((entry: any) => entry.frame.d),
          ...(window as any).__cod356Wire.http
            .filter((entry: any) => entry.body?.input === 'restart-window')
            .map((entry: any) => entry.body.input),
        ],
      }))
    ).toEqual({ logical: [], serialized: ['restart-window'] });
  }, 60_000);
});
