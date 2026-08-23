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

const POLL_MS = 5;

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

describe('COD-370 review contracts', () => {
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

async function focusPhoneKeyboard(page: Page): Promise<void> {
  const screen = page.locator('#terminalContainer .xterm-screen');
  const box = await screen.boundingBox();
  if (!box) throw new Error('Phone xterm screen has no bounding box');
  await screen.click({ position: { x: 30, y: Math.max(20, box.height - 35) } });
  await page.waitForFunction(() => document.activeElement?.classList.contains('xterm-helper-textarea'), undefined, {
    timeout: 2_000,
  });
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
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; pane=${JSON.stringify(
            pane.slice(-2_000)
          )}; xterm=${JSON.stringify(xterm.slice(-2_000))}`
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
    expect(await terminalFont(phone)).toBe(8);
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

    await focusPhoneKeyboard(phone);
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

describe('COD-370 real OpenCode active-viewer acceptance', () => {
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
      expect(await terminalFont(fixture.phonePage!)).toBe(8);
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
