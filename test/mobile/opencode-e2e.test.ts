import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { cpus, hostname, loadavg, platform, release } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CDPSession, Page } from 'playwright';
import * as fixtureContracts from '../utils/cod370-opencode-fixture.js';
import {
  Cod370OpenCodeFixture,
  hasMandatoryCleanupProof,
  sameLiveProcessIdentity,
  type LiveScenarioIdentity,
  type PaneIdentity,
} from '../utils/cod370-opencode-fixture.js';

type Dimensions = { cols: number; rows: number; viewportType: string };
type DurableFrame = { data: string; clientId: string; seq: number; rawBytes: number; at: number };
type BrowserTrace = {
  logical: Array<{ data: string; at: number }>;
  durable: DurableFrame[];
  resizes: Array<{ id: string; cols: number; rows: number; at: number }>;
  longTasks: Array<{ duration: number; at: number }>;
};
type VisibilityState = { visibilityState: string; hasFocus: boolean };
type RateEvidence = {
  cpuRate: number;
  payload: string;
  expectedBytes: number;
  logicalBytes: number;
  wsPayloadBytes: number;
  wsSerializedBytes: number;
  samples: number[];
  medianMs: number;
  p95Ms: number;
  phoneHandoffMs: number;
  desktopHandoffMs: number;
  phoneResizeEvents: number;
  desktopResizeEvents: number;
  phoneDims: Dimensions;
  desktopDims: Dimensions;
  longTasks: number[];
  phases: Record<string, number>;
  foreground: { desktop: VisibilityState; phone: VisibilityState };
  backgroundControl: {
    desktopFocusDisableRequested: true;
    phoneFocusEnableRequested: true;
    headlessFocusLimitation: boolean;
    desktopExplicitEvents: Array<{ type: string; at: number }>;
    desktopFrames: Array<Record<string, unknown>>;
  };
  cpuTarget: 'phone-page';
};

type FontComparatorRateEvidence = {
  cpuRate: 1 | 4;
  payload: string;
  inputs: string[];
  expectedBytes: number;
  logicalBytes: number;
  wsPayloadBytes: number;
  wsSerializedBytes: number;
  logicalFrames: BrowserTrace['logical'];
  durableFrames: DurableFrame[];
  samples: number[];
  medianMs: number;
  p95Ms: number;
  maxMs: number;
  fontSize: number;
  phoneDims: Dimensions;
  paneDims: PaneIdentity;
  resizeEvents: BrowserTrace['resizes'];
  longTasks: BrowserTrace['longTasks'];
  longTaskWindow: { startedAt: number; endedAt: number };
  paneComposerToken: string;
  xtermComposerToken: string;
  identityCheckpoints: Array<{ checkpoint: string; identity: LiveScenarioIdentity }>;
  cpuTarget: 'phone-page';
};

type FontComparatorConfig = {
  label: 'baseline' | 'candidate';
  repetition: 1 | 2;
  runtimeRoot: string;
  expectedRuntimeSha: string;
  expectedFontSize: 8 | 9 | 10;
  outputPath: string;
};

const POLL_MS = 5;
const HARNESS_ROOT = resolve(import.meta.dirname, '../..');
const FONT_COMPARATOR_ENABLED = process.env.COD370_FONT_COMPARATOR === '1';
const FONT_COMPARATOR_BASE_SHA = 'd080481690dc62ffc0d0d4f8e7daae2cc8bf8613';

function validateAcceptedPhoneGeometry(dimensions: { cols: number; rows: number }): boolean {
  return dimensions.cols === 75 && dimensions.rows >= 45;
}

function extractExactComposerToken(text: string, marker: string): string {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const candidates = text
    .split('\n')
    .map((line) => line.match(new RegExp(`^\\s*[│┃]\\s+(${escapedMarker}[A-Za-z0-9]*)\\s*(?:[│┃])?\\s*$`))?.[1])
    .filter((token): token is string => !!token);
  if (candidates.length !== 1) {
    throw new Error(`expected one ${marker} composer line, found ${candidates.length}`);
  }
  const token = candidates[0];
  const occurrences = token.split(marker).length - 1;
  if (occurrences !== 1) throw new Error(`expected one ${marker} in composer token, found ${occurrences}`);
  return token;
}

function visibilityLatencyFromArm(timing: { armedAt: number; keydownAt: number; visibleAt: number }): number {
  if (timing.keydownAt < timing.armedAt || timing.visibleAt < timing.keydownAt) {
    throw new Error('invalid visibility timing order');
  }
  return timing.visibleAt - timing.armedAt;
}

function isGenuinePhoneForeground(state: {
  desktop: { visibilityState: string; hasFocus: boolean };
  phone: { visibilityState: string; hasFocus: boolean };
}): boolean {
  return (
    state.desktop.visibilityState === 'hidden' &&
    state.desktop.hasFocus === false &&
    state.phone.visibilityState === 'visible' &&
    state.phone.hasFocus === true
  );
}

function hasNoExplicitViewerActivity(frames: Array<Record<string, unknown>>): boolean {
  return frames.every((frame) => frame.t !== 'va');
}

describe.skipIf(FONT_COMPARATOR_ENABLED)('COD-370 review contracts', () => {
  const contracts = fixtureContracts as Record<string, any>;

  it('keeps scenario acceptance predicates out of the lifecycle fixture', () => {
    expect(
      [
        'validateAcceptedPhoneGeometry',
        'extractExactComposerToken',
        'visibilityLatencyFromArm',
        'isGenuinePhoneForeground',
        'hasNoExplicitViewerActivity',
      ].filter((name) => typeof contracts[name] === 'function')
    ).toEqual([]);
  });

  it('owns independent desktop and phone browser contexts', () => {
    const fixture = new Cod370OpenCodeFixture() as unknown as Record<string, unknown>;
    expect(fixture).toHaveProperty('desktopContext', null);
    expect(fixture).toHaveProperty('phoneContext', null);
    expect(fixture).not.toHaveProperty('context');
  });

  it('binds comparator server launches to an explicit runtime root', () => {
    const fixture = new Cod370OpenCodeFixture({ runtimeRoot: '/tmp/cod370-runtime-contract' });
    expect(fixture.runtimeRoot).toBe('/tmp/cod370-runtime-contract');
  });

  it('rejects any phone geometry other than exactly 75 columns and at least 45 rows', () => {
    expect(validateAcceptedPhoneGeometry({ cols: 75, rows: 45 })).toBe(true);
    expect(validateAcceptedPhoneGeometry({ cols: 74, rows: 62 })).toBe(false);
    expect(validateAcceptedPhoneGeometry({ cols: 75, rows: 44 })).toBe(false);
  });

  it('detects a cached PID that was replaced at a new process start time', () => {
    const original = {
      pid: 101,
      startTimeTicks: '500',
      executable: '/usr/bin/opencode',
      command: 'opencode',
      parentChain: [{ pid: 99, startTimeTicks: '400' }],
      panePid: 99,
    };
    expect(sameLiveProcessIdentity(original, { ...original })).toBe(true);
    expect(sameLiveProcessIdentity(original, { ...original, startTimeTicks: '501' })).toBe(false);
  });

  it('rejects duplicated downstream composer prefixes and suffixes', () => {
    expect(extractExactComposerToken('│ QZ1a2b3 │', 'QZ')).toBe('QZ1a2b3');
    expect(() => extractExactComposerToken('│ QZ1a2b3QZ1a2b3 │', 'QZ')).toThrow();
  });

  it('measures visibility latency from the pre-dispatch arm timestamp', () => {
    expect(visibilityLatencyFromArm({ armedAt: 10, keydownAt: 12, visibleAt: 20 })).toBe(10);
  });

  it('requires a genuinely hidden and unfocused desktop behind a focused phone', () => {
    expect(
      isGenuinePhoneForeground({
        desktop: { visibilityState: 'hidden', hasFocus: false },
        phone: { visibilityState: 'visible', hasFocus: true },
      })
    ).toBe(true);
    expect(
      isGenuinePhoneForeground({
        desktop: { visibilityState: 'visible', hasFocus: true },
        phone: { visibilityState: 'visible', hasFocus: true },
      })
    ).toBe(false);
  });

  it('rejects a passive desktop interval containing any explicit viewer activity frame', () => {
    expect(hasNoExplicitViewerActivity([{ t: 'z', c: 178, r: 38, v: 'desktop' }])).toBe(true);
    expect(
      hasNoExplicitViewerActivity([
        { t: 'va', v: 'desktop' },
        { t: 'z', c: 178, r: 38, v: 'desktop' },
      ])
    ).toBe(false);
  });

  it('rejects cleanup proof when exact DELETE and GET404 could not run', () => {
    const complete = {
      desktopContextClosed: true,
      phoneContextClosed: true,
      browserClosed: true,
      sessionDeleted: true,
      sessionGet404: true,
      opencodePidDead: true,
      panePidDead: true,
      tmuxTargetAbsent: true,
      launcherDead: true,
      listenerDead: true,
      listenerWasDescendant: true,
      socketAbsent: true,
      portRebound: true,
      chromiumAbsent: true,
      taggedProcessesAbsent: true,
      rootAbsent: true,
    };
    expect(hasMandatoryCleanupProof(complete)).toBe(true);
    expect(
      hasMandatoryCleanupProof({
        ...complete,
        desktopContextClosed: undefined,
        phoneContextClosed: undefined,
        contextClosed: true,
      })
    ).toBe(false);
    expect(hasMandatoryCleanupProof({ ...complete, sessionDeleted: false })).toBe(false);
  });
});

async function waitUntil<T>(
  label: string,
  probe: () => T | false | Promise<T | false>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await probe();
      if (result !== false) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, POLL_MS));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for ${label}${detail}`);
}

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function gitOutput(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function vendorManifest(root: string): Array<{ path: string; sha256: string }> {
  const vendorRoot = resolve(root, 'src/web/public/vendor');
  return readdirSync(vendorRoot)
    .sort()
    .map((path) => ({ path, sha256: sha256(resolve(vendorRoot, path)) }));
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function readFontComparatorConfig(): FontComparatorConfig {
  const label = process.env.COD370_FONT_COMPARATOR_LABEL;
  const repetition = Number(process.env.COD370_FONT_COMPARATOR_REPETITION);
  const runtimeRootRaw = process.env.COD370_FONT_COMPARATOR_RUNTIME_ROOT;
  const expectedRuntimeSha = process.env.COD370_FONT_COMPARATOR_EXPECTED_SHA;
  const expectedFontSize = Number(process.env.COD370_FONT_COMPARATOR_EXPECTED_FONT);
  const outputRaw = process.env.COD370_FONT_COMPARATOR_OUTPUT;
  if (label !== 'baseline' && label !== 'candidate') throw new Error(`invalid comparator label: ${label}`);
  if (repetition !== 1 && repetition !== 2) throw new Error(`invalid comparator repetition: ${repetition}`);
  if (!runtimeRootRaw) throw new Error('COD370_FONT_COMPARATOR_RUNTIME_ROOT is required');
  if (!/^[0-9a-f]{40}$/.test(expectedRuntimeSha ?? '')) {
    throw new Error(`invalid comparator runtime SHA: ${expectedRuntimeSha}`);
  }
  if (expectedFontSize !== 8 && expectedFontSize !== 9 && expectedFontSize !== 10) {
    throw new Error(`invalid comparator expected font: ${expectedFontSize}`);
  }
  if (label === 'baseline' && (expectedRuntimeSha !== FONT_COMPARATOR_BASE_SHA || expectedFontSize !== 10)) {
    throw new Error('baseline comparator cell must bind exact d0804816 runtime at 10px');
  }
  if (label === 'candidate' && expectedFontSize === 10) {
    throw new Error('candidate comparator cell must bind the 8px policy or explicit 9px fallback');
  }
  if (!outputRaw || !isAbsolute(outputRaw)) throw new Error('comparator output must be an absolute path');
  const runtimeRoot = realpathSync(runtimeRootRaw);
  const outputPath = resolve(outputRaw);
  if (existsSync(outputPath)) throw new Error(`refusing to overwrite comparator output: ${outputPath}`);
  if (isWithin(runtimeRoot, outputPath) || isWithin(HARNESS_ROOT, outputPath)) {
    throw new Error(`comparator output must be outside runtime and harness roots: ${outputPath}`);
  }
  return {
    label,
    repetition,
    runtimeRoot,
    expectedRuntimeSha: expectedRuntimeSha!,
    expectedFontSize: expectedFontSize as 8 | 9 | 10,
    outputPath,
  };
}

function collectComparatorProvenance(config: FontComparatorConfig) {
  const runtimeSha = gitOutput(config.runtimeRoot, ['rev-parse', 'HEAD']);
  const runtimeTree = gitOutput(config.runtimeRoot, ['rev-parse', 'HEAD^{tree}']);
  const runtimeStatus = gitOutput(config.runtimeRoot, ['status', '--porcelain', '--untracked-files=all']);
  const harnessSha = gitOutput(HARNESS_ROOT, ['rev-parse', 'HEAD']);
  const harnessTree = gitOutput(HARNESS_ROOT, ['rev-parse', 'HEAD^{tree}']);
  const harnessStatus = gitOutput(HARNESS_ROOT, ['status', '--porcelain', '--untracked-files=all']);
  if (runtimeSha !== config.expectedRuntimeSha) {
    throw new Error(`runtime SHA mismatch: expected ${config.expectedRuntimeSha}, observed ${runtimeSha}`);
  }
  const expectedDependencyRoot = realpathSync(resolve(HARNESS_ROOT, 'node_modules'));
  if (runtimeStatus !== '?? node_modules') {
    throw new Error(`runtime worktree has changes beyond the dependency symlink:\n${runtimeStatus || '(none)'}`);
  }
  const runtimeDependencyRoot = realpathSync(resolve(config.runtimeRoot, 'node_modules'));
  if (runtimeDependencyRoot !== expectedDependencyRoot) {
    throw new Error(`runtime dependency symlink mismatch: ${runtimeDependencyRoot} != ${expectedDependencyRoot}`);
  }
  if (harnessStatus) throw new Error(`harness worktree is dirty:\n${harnessStatus}`);
  const runtimeLockHash = sha256(resolve(config.runtimeRoot, 'package-lock.json'));
  const harnessLockHash = sha256(resolve(HARNESS_ROOT, 'package-lock.json'));
  if (runtimeLockHash !== harnessLockHash) {
    throw new Error(`runtime/harness lockfile mismatch: ${runtimeLockHash} != ${harnessLockHash}`);
  }
  const runtimeVendorManifest = vendorManifest(config.runtimeRoot);
  const harnessVendorManifest = vendorManifest(HARNESS_ROOT);
  const harnessFiles = ['test/mobile/opencode-e2e.test.ts', 'test/utils/cod370-opencode-fixture.ts'].map((path) => ({
    path,
    blob: gitOutput(HARNESS_ROOT, ['hash-object', path]),
    sha256: sha256(resolve(HARNESS_ROOT, path)),
  }));
  return {
    runtime: {
      root: config.runtimeRoot,
      sha: runtimeSha,
      tree: runtimeTree,
      worktreeStatus: runtimeStatus,
      dependencyRoot: runtimeDependencyRoot,
      packageLockSha256: runtimeLockHash,
      generatedVendor: runtimeVendorManifest,
    },
    harness: {
      root: HARNESS_ROOT,
      sha: harnessSha,
      tree: harnessTree,
      packageLockSha256: harnessLockHash,
      generatedVendor: harnessVendorManifest,
      files: harnessFiles,
    },
    host: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      node: process.version,
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model ?? 'unknown',
      opencodeVersion: execFileSync('opencode', ['--version'], { encoding: 'utf8' }).trim(),
    },
  };
}

async function addWireInitScript(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const browserWindow = window as unknown as {
      __cod370Wire?: {
        durable: DurableFrame[];
        control: Array<{ frame: Record<string, unknown>; at: number }>;
        keydowns: number[];
        explicitActivity: Array<{ type: string; at: number }>;
      };
    };
    browserWindow.__cod370Wire = { durable: [], control: [], keydowns: [], explicitActivity: [] };
    document.addEventListener(
      'keydown',
      (event) => {
        browserWindow.__cod370Wire!.keydowns.push(event.timeStamp);
      },
      true
    );
    for (const type of ['pointerdown', 'touchstart', 'focus', 'focusin', 'selectionchange']) {
      document.addEventListener(
        type,
        () => browserWindow.__cod370Wire!.explicitActivity.push({ type, at: performance.now() }),
        true
      );
    }
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (raw) {
      if (typeof raw === 'string') {
        try {
          const frame = JSON.parse(raw);
          if (
            frame?.t === 'i' &&
            typeof frame.d === 'string' &&
            typeof frame.cid === 'string' &&
            Number.isInteger(frame.seq)
          ) {
            browserWindow.__cod370Wire!.durable.push({
              data: frame.d,
              clientId: frame.cid,
              seq: frame.seq,
              rawBytes: new TextEncoder().encode(raw).byteLength,
              at: performance.now(),
            });
          }
          if (frame?.t === 'z' || frame?.t === 'va') {
            browserWindow.__cod370Wire!.control.push({ frame, at: performance.now() });
          }
        } catch {
          // Non-JSON and non-input frames are outside this trace.
        }
      }
      return originalSend.call(this, raw);
    };
  });
}

async function installBehaviorTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      app: Record<string, any>;
      __cod370Wire: { durable: DurableFrame[] };
      __cod370Trace?: BrowserTrace & {
        originalInput: (...args: any[]) => unknown;
        resizeSource: EventSource;
        resizeListener: (event: MessageEvent) => void;
        longTaskObserver: PerformanceObserver | null;
      };
    };
    const app = browserWindow.app;
    const logical: BrowserTrace['logical'] = [];
    const resizes: BrowserTrace['resizes'] = [];
    const longTasks: BrowserTrace['longTasks'] = [];
    const originalInput = app._sendInputAsync.bind(app);
    app._sendInputAsync = (sessionId: string, data: string, options?: unknown) => {
      logical.push({ data, at: performance.now() });
      return originalInput(sessionId, data, options);
    };
    const resizeSource = app.eventSource as EventSource;
    const resizeListener = (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data));
        if (typeof data.id === 'string' && Number.isInteger(data.cols) && Number.isInteger(data.rows)) {
          resizes.push({ ...data, at: performance.now() });
        }
      } catch {
        // A malformed server event remains visible to the app's own error reporting.
      }
    };
    resizeSource.addEventListener('session:resized', resizeListener as EventListener);
    let longTaskObserver: PerformanceObserver | null = null;
    if (typeof PerformanceObserver === 'function') {
      try {
        longTaskObserver = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push({ duration: entry.duration, at: entry.startTime });
        });
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch {
        longTaskObserver = null;
      }
    }
    browserWindow.__cod370Trace = {
      logical,
      durable: browserWindow.__cod370Wire.durable,
      resizes,
      longTasks,
      originalInput,
      resizeSource,
      resizeListener,
      longTaskObserver,
    };
  });
}

async function uninstallBehaviorTrace(page: Page | null): Promise<void> {
  if (!page || page.isClosed()) return;
  await page.evaluate(() => {
    const browserWindow = window as unknown as { app: Record<string, any>; __cod370Trace?: any };
    const trace = browserWindow.__cod370Trace;
    if (!trace) return;
    browserWindow.app._sendInputAsync = trace.originalInput;
    trace.resizeSource.removeEventListener('session:resized', trace.resizeListener);
    trace.longTaskObserver?.disconnect();
    delete browserWindow.__cod370Trace;
  });
}

async function resetTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      __cod370Trace: BrowserTrace;
      __cod370Wire: { durable: DurableFrame[]; keydowns: number[] };
    };
    browserWindow.__cod370Trace.logical.length = 0;
    browserWindow.__cod370Trace.resizes.length = 0;
    browserWindow.__cod370Trace.longTasks.length = 0;
    browserWindow.__cod370Wire.durable.length = 0;
    browserWindow.__cod370Wire.keydowns.length = 0;
  });
}

async function armInputTiming(page: Page): Promise<number> {
  return page.evaluate(() => {
    const wire = (window as unknown as { __cod370Wire: { keydowns: number[] } }).__cod370Wire;
    wire.keydowns.length = 0;
    return performance.now();
  });
}

async function readTrace(page: Page): Promise<BrowserTrace> {
  return page.evaluate(() => {
    const trace = (window as unknown as { __cod370Trace: BrowserTrace }).__cod370Trace;
    return {
      logical: [...trace.logical],
      durable: [...trace.durable],
      resizes: [...trace.resizes],
      longTasks: [...trace.longTasks],
    };
  });
}

async function selectSession(page: Page, sessionId: string, auto: boolean): Promise<void> {
  await page.evaluate(
    ({ id, isAuto }) => (window as unknown as { app: Record<string, any> }).app.selectSession(id, { auto: isAuto }),
    { id: sessionId, isAuto: auto }
  );
  await page.waitForFunction(
    (id) => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      return app.activeSessionId === id && app._wsReady === true && app._wsSessionId === id && !!app.terminal?.buffer;
    },
    sessionId,
    { timeout: 20_000 }
  );
}

async function terminalDimensions(page: Page): Promise<Dimensions> {
  return page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.getFittedTerminalDimensions());
}

async function comparatorTerminalDimensions(page: Page): Promise<Dimensions> {
  return page.evaluate(() => {
    const terminal = (window as unknown as { app: Record<string, any> }).app.terminal;
    if (!Number.isInteger(terminal?.cols) || !Number.isInteger(terminal?.rows)) {
      throw new Error('xterm dimensions are unavailable');
    }
    return { cols: terminal.cols, rows: terminal.rows, viewportType: 'mobile' };
  });
}

async function terminalFont(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.terminal.options.fontSize);
}

async function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const terminal = (window as unknown as { app: Record<string, any> }).app.terminal;
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
    return lines.join('\n');
  });
}

async function waitForPaneDimensions(
  fixture: Cod370OpenCodeFixture,
  expected: Dimensions,
  timeoutMs = 300
): Promise<{ elapsedMs: number; identity: PaneIdentity }> {
  const startedAt = performance.now();
  const identity = await waitUntil(
    `${expected.cols}x${expected.rows} authoritative pane dimensions`,
    () => {
      const current = fixture.paneIdentity();
      return current.cols === expected.cols && current.rows === expected.rows ? current : false;
    },
    timeoutMs
  );
  return { elapsedMs: performance.now() - startedAt, identity };
}

async function activateDesktop(page: Page): Promise<void> {
  await page.bringToFront();
  await page.locator('#terminalContainer .xterm-screen').click({ position: { x: 40, y: 40 } });
}

async function activatePhone(page: Page): Promise<void> {
  await page.bringToFront();
  const screen = page.locator('#terminalContainer .xterm-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('Phone xterm screen has no bounding box');
  await screen.tap({ position: { x: 30, y: Math.max(20, box.height - 35) } });
}

async function focusPhoneKeyboard(fixture: Cod370OpenCodeFixture, page: Page): Promise<void> {
  const screen = page.locator('#terminalContainer .xterm-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('Phone xterm screen has no bounding box');
  const composerRow = await waitUntil(
    'OpenCode composer visible in phone pane and xterm',
    async () => {
      const paneLines = fixture.paneText().split('\n');
      const row = paneLines.findIndex((line) => line.includes('Ask anything'));
      return row >= 0 && (await terminalText(page)).includes('Ask anything') ? row : false;
    },
    20_000
  );
  const rows = await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.terminal.rows);
  await screen.click({ position: { x: 30, y: ((composerRow + 0.5) * box.height) / rows } });
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), undefined, {
    timeout: 2_000,
  });
}

async function focusComparatorKeyboard(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.terminal.focus());
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), undefined, {
    timeout: 2_000,
  });
}

async function waitForComparatorComposerReady(
  fixture: Cod370OpenCodeFixture,
  page: Page,
  stableMs = 500
): Promise<void> {
  let stableSince = 0;
  await waitUntil(
    `empty OpenCode composer stable for ${stableMs}ms`,
    async () => {
      const browser = await page.evaluate(() => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        const terminal = app.terminal;
        const buffer = terminal?.buffer?.active;
        const lines: string[] = [];
        if (buffer) {
          for (let row = 0; row < buffer.length; row++) lines.push(buffer.getLine(row)?.translateToString(true) ?? '');
        }
        return {
          activeSessionId: app.activeSessionId,
          wsReady: app._wsReady,
          wsSessionId: app._wsSessionId,
          activeElementIsXterm: document.activeElement?.classList.contains('xterm-helper-textarea') === true,
          text: lines.join('\n'),
        };
      });
      const paneText = fixture.paneText();
      const ready =
        browser.activeSessionId === fixture.sessionId &&
        browser.wsReady === true &&
        browser.wsSessionId === fixture.sessionId &&
        browser.activeElementIsXterm &&
        /┃\s*\n\s*┃\s+Ask anything/.test(browser.text) &&
        /┃\s*\n\s*┃\s+Ask anything/.test(paneText);
      if (!ready) {
        stableSince = 0;
        return false;
      }
      stableSince ||= Date.now();
      return Date.now() - stableSince >= stableMs;
    },
    20_000
  );
}

async function waitForExactComposerProgress(
  fixture: Cod370OpenCodeFixture,
  page: Page,
  marker: string,
  expected: string,
  armedAt: number,
  timeoutMs = 10_000
): Promise<number> {
  await waitUntil(
    `exact composer ${JSON.stringify(expected)} in pane and xterm`,
    async () => {
      const pane = fixture.paneText();
      const xterm = await terminalText(page);
      try {
        const paneToken = extractExactComposerToken(pane, marker);
        const xtermToken = extractExactComposerToken(xterm, marker);
        if (paneToken === expected && xtermToken === expected) return true;
        throw new Error(`tokens pane=${JSON.stringify(paneToken)} xterm=${JSON.stringify(xtermToken)}`);
      } catch (error) {
        const diagnostics = await page.evaluate(() => {
          const browserWindow = window as unknown as {
            app: Record<string, any>;
            __cod370Trace?: BrowserTrace;
            __cod370Wire?: { keydowns: number[] };
          };
          const app = browserWindow.app;
          return {
            activeElement: {
              id: document.activeElement?.id ?? '',
              className: document.activeElement?.className ?? '',
            },
            wsReady: app._wsReady,
            wsState: app._wsState,
            wsSessionId: app._wsSessionId,
            activeSessionId: app.activeSessionId,
            pendingInput: app._pendingInput,
            pendingDeliveries: app._pendingDeliveries.get(app.activeSessionId)?.length ?? 0,
            logical: [...(browserWindow.__cod370Trace?.logical ?? [])],
            durable: [...(browserWindow.__cod370Trace?.durable ?? [])],
            keydowns: [...(browserWindow.__cod370Wire?.keydowns ?? [])],
          };
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; pane=${JSON.stringify(
            pane.slice(-2_000)
          )}; xterm=${JSON.stringify(xterm.slice(-2_000))}; input=${JSON.stringify(diagnostics)}`
        );
      }
    },
    timeoutMs
  );
  const timing = await page.evaluate(() => {
    const wire = (window as unknown as { __cod370Wire: { keydowns: number[] } }).__cod370Wire;
    return { keydownAt: wire.keydowns[0], visibleAt: performance.now() };
  });
  if (!Number.isFinite(timing.keydownAt)) throw new Error(`no keydown timestamp for ${expected}`);
  return visibilityLatencyFromArm({ armedAt, keydownAt: timing.keydownAt, visibleAt: timing.visibleAt });
}

async function pageLifecycle(page: Page): Promise<VisibilityState> {
  return page.evaluate(() => ({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() }));
}

function sessionResizeCount(trace: BrowserTrace, sessionId: string): number {
  return trace.resizes.filter((event) => event.id === sessionId).length;
}

async function runRate(
  fixture: Cod370OpenCodeFixture,
  phoneCdp: CDPSession,
  desktopCdp: CDPSession,
  cpuRate: number,
  payload: string,
  marker: string,
  baselineIdentity: LiveScenarioIdentity
): Promise<RateEvidence> {
  const desktop = fixture.desktopPage!;
  const phone = fixture.phonePage!;
  const phases: Record<string, number> = {};
  await phoneCdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  try {
    await phoneCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await desktopCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await activateDesktop(desktop);
    const desktopDims = await terminalDimensions(desktop);
    expect(desktopDims).toMatchObject({ cols: 178, rows: 38, viewportType: 'desktop' });
    const desktopBaseline = await waitForPaneDimensions(fixture, desktopDims);
    expect(desktopBaseline.identity).toMatchObject({ cols: desktopDims.cols, rows: desktopDims.rows });
    expect(fixture.identities()).toEqual(baselineIdentity);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    await resetTrace(phone);

    const phoneDims = await terminalDimensions(phone);
    expect(await terminalFont(phone)).toBe(9);
    expect(validateAcceptedPhoneGeometry(phoneDims)).toBe(true);
    expect(phoneDims.cols).toBe(75);
    expect(phoneDims.rows).toBeGreaterThanOrEqual(45);
    phases.windowStartedAt = performance.now();
    const backgroundCursors = await desktop.evaluate(() => {
      const wire = (
        window as unknown as {
          __cod370Wire: { control: unknown[]; explicitActivity: Array<{ type: string; at: number }> };
        }
      ).__cod370Wire;
      return { control: wire.control.length, explicitActivity: wire.explicitActivity.length };
    });
    await desktopCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await phoneCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const phoneStartedAt = performance.now();
    phases.phoneActivationArmedAt = phoneStartedAt;
    await activatePhone(phone);
    const phoneHandoff = await waitForPaneDimensions(fixture, phoneDims);
    const phoneHandoffMs = performance.now() - phoneStartedAt;
    phases.phoneAuthoritativeAt = performance.now();
    expect(phoneHandoffMs).toBeLessThanOrEqual(300);
    expect(phoneHandoff.elapsedMs).toBeLessThanOrEqual(300);
    expect(phoneHandoff.identity).toMatchObject({ cols: 75, rows: phoneDims.rows });
    expect(fixture.identities()).toEqual(baselineIdentity);
    const foreground = { desktop: await pageLifecycle(desktop), phone: await pageLifecycle(phone) };
    const headlessFocusLimitation = !isGenuinePhoneForeground(foreground);
    expect(foreground.phone).toEqual({ visibilityState: 'visible', hasFocus: true });
    phases.phoneForegroundProvenAt = performance.now();
    await waitUntil(
      'one phone authoritative resize event',
      async () => {
        const events = (await readTrace(phone)).resizes.filter((event) => event.id === fixture.sessionId);
        return events.some((event) => event.cols === phoneDims.cols && event.rows === phoneDims.rows);
      },
      2_000
    );
    let trace = await readTrace(phone);
    const phoneResizeEvents = sessionResizeCount(trace, fixture.sessionId);
    expect(phoneResizeEvents).toBeLessThanOrEqual(1);

    await desktop.evaluate(
      ({ c, r }) => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        app._ws.send(JSON.stringify({ t: 'z', c, r, v: 'desktop' }));
      },
      { c: desktopDims.cols, r: desktopDims.rows }
    );
    phases.passiveDesktopResizeSentAt = performance.now();
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    expect(fixture.paneIdentity()).toMatchObject({ cols: phoneDims.cols, rows: phoneDims.rows });
    expect(fixture.identities()).toEqual(baselineIdentity);
    expect({ desktop: await pageLifecycle(desktop), phone: await pageLifecycle(phone) }).toEqual(foreground);
    const passiveWindow = await desktop.evaluate((cursors) => {
      const wire = (
        window as unknown as {
          __cod370Wire: {
            control: Array<{ frame: Record<string, unknown> }>;
            explicitActivity: Array<{ type: string; at: number }>;
          };
        }
      ).__cod370Wire;
      return {
        frames: wire.control.slice(cursors.control).map((entry) => entry.frame),
        explicitEvents: wire.explicitActivity.slice(cursors.explicitActivity),
      };
    }, backgroundCursors);
    const passiveFrames = passiveWindow.frames;
    expect(passiveFrames).toEqual([{ t: 'z', c: desktopDims.cols, r: desktopDims.rows, v: 'desktop' }]);
    expect(hasNoExplicitViewerActivity(passiveFrames)).toBe(true);
    expect(passiveWindow.explicitEvents).toEqual([]);
    expect(sessionResizeCount(await readTrace(phone), fixture.sessionId)).toBe(phoneResizeEvents);

    await focusPhoneKeyboard(fixture, phone);
    const samples: number[] = [];
    let cumulative = '';
    const inputs = [marker, ...payload.slice(marker.length)];
    const typingCursor = await readTrace(phone);
    phases.typingStartedAt = performance.now();
    for (const input of inputs) {
      cumulative += input;
      const armedAt = await armInputTiming(phone);
      await phone.keyboard.type(input);
      samples.push(await waitForExactComposerProgress(fixture, phone, marker, cumulative, armedAt));
    }
    phases.typingVisibleAt = performance.now();
    await phone.waitForFunction(
      () => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        return !app._pendingInput && (app._pendingDeliveries.get(app.activeSessionId)?.length ?? 0) === 0;
      },
      undefined,
      { timeout: 10_000 }
    );
    trace = await readTrace(phone);
    const payloadLogical = trace.logical.slice(typingCursor.logical.length);
    const payloadDurable = trace.durable.slice(typingCursor.durable.length);
    const logical = payloadLogical.map((entry) => entry.data).join('');
    const durable = payloadDurable.map((entry) => entry.data).join('');
    expect(payloadLogical.map((entry) => entry.data)).toEqual(inputs);
    expect(payloadDurable.map((entry) => entry.data)).toEqual(inputs);
    expect(logical).toBe(payload);
    expect(durable).toBe(payload);
    expect(payloadDurable).toHaveLength(inputs.length);
    expect(new Set(payloadDurable.map((entry) => `${entry.clientId}:${entry.seq}`)).size).toBe(inputs.length);
    expect(extractExactComposerToken(fixture.paneText(), marker)).toBe(payload);
    expect(extractExactComposerToken(await terminalText(phone), marker)).toBe(payload);
    expect(fixture.identities()).toEqual(baselineIdentity);

    const desktopResizeCursor = trace.resizes.length;
    const desktopStartedAt = performance.now();
    phases.desktopActivationArmedAt = desktopStartedAt;
    await phoneCdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await desktopCdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await activateDesktop(desktop);
    const desktopHandoff = await waitForPaneDimensions(fixture, desktopDims);
    const desktopHandoffMs = performance.now() - desktopStartedAt;
    phases.desktopAuthoritativeAt = performance.now();
    expect(desktopHandoffMs).toBeLessThanOrEqual(300);
    expect(desktopHandoff.elapsedMs).toBeLessThanOrEqual(300);
    expect(desktopHandoff.identity).toMatchObject({ cols: desktopDims.cols, rows: desktopDims.rows });
    expect(fixture.identities()).toEqual(baselineIdentity);
    await waitUntil(
      'one desktop authoritative resize event',
      async () => {
        const current = (await readTrace(phone)).resizes.slice(desktopResizeCursor);
        return current.some(
          (event) =>
            event.id === fixture.sessionId && event.cols === desktopDims.cols && event.rows === desktopDims.rows
        );
      },
      2_000
    );
    trace = await readTrace(phone);
    const desktopResizeEvents = trace.resizes
      .slice(desktopResizeCursor)
      .filter((event) => event.id === fixture.sessionId).length;
    expect(desktopResizeEvents).toBeLessThanOrEqual(1);

    const expectedBytes = Buffer.byteLength(payload);
    const logicalBytes = Buffer.byteLength(logical);
    const wsPayloadBytes = Buffer.byteLength(durable);
    expect(logicalBytes).toBe(expectedBytes);
    expect(wsPayloadBytes).toBe(expectedBytes);
    return {
      cpuRate,
      payload,
      expectedBytes,
      logicalBytes,
      wsPayloadBytes,
      wsSerializedBytes: payloadDurable.reduce((total, entry) => total + entry.rawBytes, 0),
      samples,
      medianMs: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      phoneHandoffMs,
      desktopHandoffMs,
      phoneResizeEvents,
      desktopResizeEvents,
      phoneDims,
      desktopDims,
      longTasks: trace.longTasks.map((entry) => entry.duration),
      phases,
      foreground,
      backgroundControl: {
        desktopFocusDisableRequested: true,
        phoneFocusEnableRequested: true,
        headlessFocusLimitation,
        desktopExplicitEvents: passiveWindow.explicitEvents,
        desktopFrames: passiveFrames,
      },
      cpuTarget: 'phone-page',
    };
  } finally {
    await phoneCdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
}

async function runFontComparatorRate(
  fixture: Cod370OpenCodeFixture,
  page: Page,
  cdp: CDPSession,
  cpuRate: 1 | 4,
  payload: string,
  marker: string,
  expectedFontSize: number,
  baselineIdentity: LiveScenarioIdentity
): Promise<FontComparatorRateEvidence> {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
  try {
    await focusComparatorKeyboard(page);
    await resetTrace(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())))
    );
    const phoneDims = await comparatorTerminalDimensions(page);
    const fontSize = await terminalFont(page);
    expect(fontSize).toBe(expectedFontSize);
    const paneDims = (await waitForPaneDimensions(fixture, phoneDims, 2_000)).identity;
    expect(paneDims).toMatchObject({ cols: phoneDims.cols, rows: phoneDims.rows });
    expect(fixture.identities()).toEqual(baselineIdentity);

    const inputs = [marker, ...payload.slice(marker.length)];
    const samples: number[] = [];
    const identityCheckpoints: FontComparatorRateEvidence['identityCheckpoints'] = [
      { checkpoint: 'before-dispatch', identity: fixture.identities() },
    ];
    let cumulative = '';
    const longTaskStartedAt = await page.evaluate(() => performance.now());
    for (const input of inputs) {
      cumulative += input;
      const armedAt = await armInputTiming(page);
      await page.keyboard.type(input);
      samples.push(await waitForExactComposerProgress(fixture, page, marker, cumulative, armedAt));
      const identity = fixture.identities();
      expect(identity).toEqual(baselineIdentity);
      identityCheckpoints.push({ checkpoint: `visible:${cumulative}`, identity });
    }
    await page.waitForFunction(
      () => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        return !app._pendingInput && (app._pendingDeliveries.get(app.activeSessionId)?.length ?? 0) === 0;
      },
      undefined,
      { timeout: 10_000 }
    );
    const longTaskEndedAt = await page.evaluate(() => performance.now());
    await page.evaluate(
      () =>
        new Promise<void>((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())))
    );
    const trace = await readTrace(page);
    const logicalFrames = trace.logical;
    const durableFrames = trace.durable;
    const logical = logicalFrames.map((entry) => entry.data).join('');
    const durable = durableFrames.map((entry) => entry.data).join('');
    expect(logicalFrames.map((entry) => entry.data)).toEqual(inputs);
    expect(durableFrames.map((entry) => entry.data)).toEqual(inputs);
    expect(logical).toBe(payload);
    expect(durable).toBe(payload);
    expect(durableFrames).toHaveLength(inputs.length);
    expect(new Set(durableFrames.map((entry) => `${entry.clientId}:${entry.seq}`)).size).toBe(inputs.length);
    const paneComposerToken = extractExactComposerToken(fixture.paneText(), marker);
    const xtermComposerToken = extractExactComposerToken(await terminalText(page), marker);
    expect(paneComposerToken).toBe(payload);
    expect(xtermComposerToken).toBe(payload);
    const finalIdentity = fixture.identities();
    expect(finalIdentity).toEqual(baselineIdentity);
    identityCheckpoints.push({ checkpoint: 'after-delivery-drain', identity: finalIdentity });

    const expectedBytes = Buffer.byteLength(payload);
    const logicalBytes = Buffer.byteLength(logical);
    const wsPayloadBytes = Buffer.byteLength(durable);
    expect(logicalBytes).toBe(expectedBytes);
    expect(wsPayloadBytes).toBe(expectedBytes);
    const longTasks = trace.longTasks.filter((entry) => entry.at >= longTaskStartedAt && entry.at <= longTaskEndedAt);
    return {
      cpuRate,
      payload,
      inputs,
      expectedBytes,
      logicalBytes,
      wsPayloadBytes,
      wsSerializedBytes: durableFrames.reduce((total, entry) => total + entry.rawBytes, 0),
      logicalFrames,
      durableFrames,
      samples,
      medianMs: percentile(samples, 0.5),
      p95Ms: percentile(samples, 0.95),
      maxMs: Math.max(...samples),
      fontSize,
      phoneDims,
      paneDims,
      resizeEvents: trace.resizes,
      longTasks,
      longTaskWindow: { startedAt: longTaskStartedAt, endedAt: longTaskEndedAt },
      paneComposerToken,
      xtermComposerToken,
      identityCheckpoints,
      cpuTarget: 'phone-page',
    };
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
}

describe.skipIf(FONT_COMPARATOR_ENABLED)('COD-370 real OpenCode active-viewer acceptance', () => {
  it('preserves one OpenCode pane while phone and desktop hand off sizing at 1x and 4x CPU', async () => {
    const fixture = new Cod370OpenCodeFixture();
    const failures: Error[] = [];
    const pageErrors: string[] = [];
    const seriousConsoleErrors: string[] = [];
    const evidence: RateEvidence[] = [];
    let phoneCdp: CDPSession | null = null;
    let desktopCdp: CDPSession | null = null;
    try {
      await fixture.start();
      for (const page of [fixture.desktopPage!, fixture.phonePage!]) {
        page.on('pageerror', (error) => pageErrors.push(error.message));
        page.on('console', (message) => {
          const text = message.text();
          if (
            message.type() === 'error' ||
            (message.type() === 'warning' && /(?:crash|exception|uncaught|failed|fatal)/i.test(text))
          ) {
            seriousConsoleErrors.push(`${message.type()}: ${text}`);
          }
        });
        await addWireInitScript(page);
      }
      await fixture.navigatePages();
      await fixture.createOpenCodeSession();
      const baselineIdentity = fixture.identities();
      expect(fixture.paneCount()).toBe(1);
      const sessions = await fixture.api('GET', '/api/sessions');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe(fixture.sessionId);
      expect(fixture.serverIdentity?.pid).toBeGreaterThan(1);
      expect(fixture.listenerIdentity?.pid).toBeGreaterThan(1);
      expect(fixture.listenerIdentity?.pid).not.toBe(fixture.serverIdentity?.pid);

      await selectSession(fixture.desktopPage!, fixture.sessionId, false);
      await selectSession(fixture.phonePage!, fixture.sessionId, true);
      await installBehaviorTrace(fixture.phonePage!);
      await waitUntil('real OpenCode TUI output', () => fixture.paneText().trim().length > 20, 20_000);
      expect(await terminalFont(fixture.phonePage!)).toBe(9);
      phoneCdp = await fixture.phoneContext!.newCDPSession(fixture.phonePage!);
      desktopCdp = await fixture.desktopContext!.newCDPSession(fixture.desktopPage!);

      evidence.push(await runRate(fixture, phoneCdp, desktopCdp, 1, 'qz1a2b3c4d', 'q', baselineIdentity));

      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
      await activatePhone(fixture.phonePage!);
      await fixture.phonePage!.keyboard.press('Control+u');
      await waitUntil('first payload cleared from OpenCode composer', () => !fixture.paneText().includes('qz1a2b3c4d'));
      await activateDesktop(fixture.desktopPage!);
      await waitForPaneDimensions(fixture, await terminalDimensions(fixture.desktopPage!));
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));

      evidence.push(await runRate(fixture, phoneCdp, desktopCdp, 4, 'wx5e6f7g8h', 'w', baselineIdentity));
      expect(fixture.identities()).toEqual(baselineIdentity);
      expect(fixture.paneCount()).toBe(1);
      expect(pageErrors).toEqual([]);
      expect(seriousConsoleErrors).toEqual([]);
      process.stdout.write(
        `COD370_EVIDENCE ${JSON.stringify({
          sessionId: fixture.sessionId,
          launcherPid: fixture.serverIdentity!.pid,
          listenerPid: fixture.listenerIdentity!.pid,
          ...baselineIdentity,
          rates: evidence,
          pageErrors,
          seriousConsoleErrors,
        })}\n`
      );
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (phoneCdp) {
        try {
          await phoneCdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
          await phoneCdp.detach();
        } catch (error) {
          failures.push(new Error(`CDP cleanup: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (desktopCdp) {
        try {
          await desktopCdp.detach();
        } catch (error) {
          failures.push(new Error(`desktop CDP cleanup: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      try {
        await uninstallBehaviorTrace(fixture.phonePage);
      } catch (error) {
        failures.push(new Error(`trace cleanup: ${error instanceof Error ? error.message : String(error)}`));
      }
      try {
        await fixture.cleanup();
        expect(hasMandatoryCleanupProof(fixture.cleanupProof)).toBe(true);
        process.stdout.write(`COD370_CLEANUP ${JSON.stringify(fixture.cleanupProof)}\n`);
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (failures.length) throw new AggregateError(failures, 'COD-370 real OpenCode acceptance failed');
  }, 180_000);
});

describe.runIf(FONT_COMPARATOR_ENABLED)('COD-370 mobile OpenCode font comparator', () => {
  it('records one complete 1x and 4x phone-viewer repetition', async () => {
    const config = readFontComparatorConfig();
    const provenance = collectComparatorProvenance(config);
    const fixture = new Cod370OpenCodeFixture({ runtimeRoot: config.runtimeRoot });
    const failures: Error[] = [];
    const pageErrors: string[] = [];
    const consoleWarningsAndErrors: Array<{ type: string; text: string }> = [];
    const seriousConsoleErrors: string[] = [];
    const rates: FontComparatorRateEvidence[] = [];
    const startedAt = new Date().toISOString();
    const startedLoadAverage = loadavg();
    let phoneCdp: CDPSession | null = null;
    let baselineIdentity: LiveScenarioIdentity | null = null;
    let initialResizeEvents: BrowserTrace['resizes'] = [];
    let observedFontSize: number | null = null;
    let observedPhoneDimensions: Dimensions | null = null;
    let failureDiagnostics: Record<string, unknown> | null = null;
    try {
      await fixture.start();
      const phone = fixture.phonePage!;
      phone.on('pageerror', (error) => pageErrors.push(error.message));
      phone.on('console', (message) => {
        const type = message.type();
        const text = message.text();
        if (type === 'error' || type === 'warning') consoleWarningsAndErrors.push({ type, text });
        if (type === 'error' || (type === 'warning' && /(?:crash|exception|uncaught|failed|fatal)/i.test(text))) {
          seriousConsoleErrors.push(`${type}: ${text}`);
        }
      });
      await addWireInitScript(phone);
      await phone.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
      await phone.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, { timeout: 20_000 });
      await installBehaviorTrace(phone);
      await fixture.createOpenCodeSession();
      await selectSession(phone, fixture.sessionId, false);
      await waitUntil('real OpenCode TUI output', () => fixture.paneText().trim().length > 20, 20_000);
      observedFontSize = await terminalFont(phone);
      expect(observedFontSize).toBe(config.expectedFontSize);
      observedPhoneDimensions = await comparatorTerminalDimensions(phone);
      await waitForPaneDimensions(fixture, observedPhoneDimensions, 2_000);
      baselineIdentity = fixture.identities();
      expect(fixture.paneCount()).toBe(1);
      const sessions = await fixture.api('GET', '/api/sessions');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.id).toBe(fixture.sessionId);
      initialResizeEvents = (await readTrace(phone)).resizes;
      await focusComparatorKeyboard(phone);
      await waitForComparatorComposerReady(fixture, phone);
      expect(fixture.identities()).toEqual(baselineIdentity);
      phoneCdp = await fixture.phoneContext!.newCDPSession(phone);

      rates.push(
        await runFontComparatorRate(
          fixture,
          phone,
          phoneCdp,
          1,
          'qz1a2b3c4d',
          'q',
          config.expectedFontSize,
          baselineIdentity
        )
      );
      await phone.keyboard.press('Control+u');
      await waitUntil('1x comparator payload cleared', () => !fixture.paneText().includes('qz1a2b3c4d'));
      await waitForComparatorComposerReady(fixture, phone);
      expect(fixture.identities()).toEqual(baselineIdentity);
      rates.push(
        await runFontComparatorRate(
          fixture,
          phone,
          phoneCdp,
          4,
          'wx5e6f7g8h',
          'w',
          config.expectedFontSize,
          baselineIdentity
        )
      );
      expect(fixture.identities()).toEqual(baselineIdentity);
      expect(fixture.paneCount()).toBe(1);
      expect(pageErrors).toEqual([]);
      expect(seriousConsoleErrors).toEqual([]);
    } catch (error) {
      try {
        const phone = fixture.phonePage;
        if (phone && !phone.isClosed()) {
          failureDiagnostics = {
            browser: await phone.evaluate(() => {
              const browserWindow = window as unknown as {
                app?: Record<string, any>;
                cjkActive?: boolean;
                __cod370Trace?: BrowserTrace;
                __cod370Wire?: { keydowns: number[] };
              };
              const active = document.activeElement;
              const cjk = document.getElementById('cjkInput');
              return {
                activeElement: { id: active?.id ?? '', className: active?.className ?? '' },
                cjkActive: !!browserWindow.cjkActive,
                cjkVisible: !!cjk?.classList.contains('cjk-input-visible'),
                wsReady: browserWindow.app?._wsReady,
                wsState: browserWindow.app?._wsState,
                wsSessionId: browserWindow.app?._wsSessionId,
                activeSessionId: browserWindow.app?.activeSessionId,
                pendingInput: browserWindow.app?._pendingInput,
                pendingDeliveries: browserWindow.app?._pendingDeliveries?.get(browserWindow.app?.activeSessionId)
                  ?.length,
                trace: browserWindow.__cod370Trace
                  ? {
                      logical: [...browserWindow.__cod370Trace.logical],
                      durable: [...browserWindow.__cod370Trace.durable],
                      resizes: [...browserWindow.__cod370Trace.resizes],
                      longTasks: [...browserWindow.__cod370Trace.longTasks],
                    }
                  : null,
                keydowns: [...(browserWindow.__cod370Wire?.keydowns ?? [])],
              };
            }),
            paneText: fixture.pane ? fixture.paneText() : null,
            identity: fixture.pane ? fixture.identities() : null,
          };
        }
      } catch (diagnosticError) {
        failureDiagnostics = {
          diagnosticError: diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError),
        };
      }
      failures.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (phoneCdp) {
        try {
          await phoneCdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
          await phoneCdp.detach();
        } catch (error) {
          failures.push(new Error(`CDP cleanup: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      try {
        await uninstallBehaviorTrace(fixture.phonePage);
      } catch (error) {
        failures.push(new Error(`trace cleanup: ${error instanceof Error ? error.message : String(error)}`));
      }
      try {
        await fixture.cleanup();
        if (!hasMandatoryCleanupProof(fixture.cleanupProof)) {
          throw new Error(`incomplete cleanup proof: ${JSON.stringify(fixture.cleanupProof)}`);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const endedAt = new Date().toISOString();
    const result = {
      schemaVersion: 1,
      config: {
        label: config.label,
        repetition: config.repetition,
        expectedRuntimeSha: config.expectedRuntimeSha,
        expectedFontSize: config.expectedFontSize,
        connectedViewers: ['phone'],
        desktopContextNavigated: false,
        viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
        cpuRates: [1, 4],
      },
      provenance,
      timing: {
        startedAt,
        endedAt,
        durationMs: Date.parse(endedAt) - Date.parse(startedAt),
        loadAverage: { before: startedLoadAverage, after: loadavg() },
      },
      session: {
        id: fixture.sessionId,
        launcherPid: fixture.serverIdentity?.pid ?? null,
        listenerPid: fixture.listenerIdentity?.pid ?? null,
        identity: baselineIdentity,
      },
      observedFontSize,
      observedPhoneDimensions,
      initialResizeEvents,
      rates,
      pageErrors,
      consoleWarningsAndErrors,
      seriousConsoleErrors,
      failureDiagnostics,
      cleanup: fixture.cleanupProof,
      passed: failures.length === 0,
      failures: failures.map((error) => ({ name: error.name, message: error.message, stack: error.stack })),
    };
    try {
      writeFileSync(config.outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      process.stdout.write(
        `COD370_FONT_COMPARATOR ${config.label} repetition=${config.repetition} output=${config.outputPath} passed=${
          failures.length === 0
        }\n`
      );
    } catch (error) {
      failures.push(new Error(`raw evidence write failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (failures.length) throw new AggregateError(failures, 'COD-370 font comparator repetition failed');
  }, 180_000);
});
