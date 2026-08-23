/**
 * @fileoverview Predictive-echo E2E against the REAL installed Codex TUI (issues
 * #218/#219/#220/#222 retest scenarios + the byte-identity and simulated-RTT
 * pins). CI-EXCLUDED (needs chromium + the codex binary); a REQUIRED item of
 * the release checklist.
 *
 * Unlike the other Playwright tests this one cannot use the in-process
 * WebServer: under VITEST the mux layer is a pure in-memory mock and Session
 * spawns an echo PTY, so no real codex would ever run. The lab server is a
 * CHILD PROCESS with the VITEST markers stripped from its env, isolated via
 * CODEMAN_INSTANCE=codexlab (own data dir under the per-test fixture HOME +
 * own tmux socket) on port 3222 (3220/3221 are taken; see the port sweep in
 * the plan). Codex runs against a throwaway CODEX_HOME with a fake API key
 * (never leaves the box: the first request 401s, which is fine — every
 * scenario here is about the composer, not completions).
 *
 * Run: npx vitest run --config config/vitest.config.ts test/codex-predictive-echo.test.ts
 */
import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const PORT = 3222;
const BASE_URL = `http://localhost:${PORT}`;
const INSTANCE = 'codexlab';
const TMUX = `tmux -L codeman-${INSTANCE}`;
const ROOT = resolve(import.meta.dirname, '..');
const CODEX_BIN_DIR = `${userInfo().homedir}/.local/bin`;
const RTT_DELAY_MS = 300;

let server: ChildProcess | null = null;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let codexHome: string;
let trustedWorkdir: string;
let untrustedWorkdir: string;
let sessionId: string;
let emptyComposerRow: string;
const createdSessions: string[] = [];

interface PredictionFixtureSnapshot {
  outstanding: number;
  confirmedTotal: number;
  droppedTotal: number;
  predictHit: number;
  mismatchDrops: number;
  ttlDrops: number;
  offRowEvents: number;
  clearPredictionEvents: number;
  clearPredictionDrops: number;
}

interface ComposerResetProtocolDriver {
  proveCleanStart(): Promise<void>;
  sendSentinel(): Promise<void>;
  proveSentinelAgreement(): Promise<void>;
  clearAndProveClean(): Promise<void>;
}

interface RttInfrastructureReadiness {
  activeSessionId: string | null;
  expectedSessionId: string;
  wsReady: boolean;
  wsState: string;
  wsSessionId: string | null;
  wsOpen: boolean;
  pendingDeliveries: number;
  postDraining: boolean;
  pendingInputLength: number;
  inputFlushPending: boolean;
  renderQueueLength: number;
  writeFrameScheduled: boolean;
  delayedWritesPending: number;
  terminalInitialized: boolean;
  composerGate: boolean;
  currentHoldMs: number | null;
}

function isRttInfrastructureReady(state: RttInfrastructureReadiness): boolean {
  return (
    state.activeSessionId === state.expectedSessionId &&
    state.wsReady &&
    state.wsState === 'connected' &&
    state.wsSessionId === state.expectedSessionId &&
    state.wsOpen &&
    state.pendingDeliveries === 0 &&
    !state.postDraining &&
    state.pendingInputLength === 0 &&
    !state.inputFlushPending &&
    state.renderQueueLength === 0 &&
    !state.writeFrameScheduled &&
    state.delayedWritesPending === 0 &&
    state.terminalInitialized &&
    state.composerGate &&
    state.currentHoldMs === null
  );
}

async function withMandatoryCleanup<T>(action: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  try {
    return await action();
  } finally {
    await cleanup();
  }
}

async function runComposerResetProtocol(driver: ComposerResetProtocolDriver): Promise<void> {
  let primaryError: unknown = null;
  try {
    await driver.proveCleanStart();
    await driver.sendSentinel();
    await driver.proveSentinelAgreement();
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await driver.clearAndProveClean();
    } catch (cleanupError) {
      if (primaryError) {
        throw new AggregateError([primaryError, cleanupError], 'composer reset and fail-safe cleanup both failed');
      }
      throw cleanupError;
    }
  }
  if (primaryError) throw primaryError;
}

function hasNamedRepaintPredictionConvergence(
  baseline: PredictionFixtureSnapshot,
  current: PredictionFixtureSnapshot,
  requiredConfirmations: number
): boolean {
  const confirmations = current.confirmedTotal - baseline.confirmedTotal;
  const drops = current.droppedTotal - baseline.droppedTotal;
  const hits = current.predictHit - baseline.predictHit;
  const offRowEvents = current.offRowEvents - baseline.offRowEvents;
  const clearEvents = current.clearPredictionEvents - baseline.clearPredictionEvents;
  const clearDrops = current.clearPredictionDrops - baseline.clearPredictionDrops;
  return (
    current.outstanding === 0 &&
    confirmations >= requiredConfirmations &&
    confirmations + drops === hits &&
    drops === clearDrops &&
    clearEvents === offRowEvents &&
    (drops === 0 || offRowEvents > 0) &&
    current.mismatchDrops === baseline.mismatchDrops &&
    current.ttlDrops === baseline.ttlDrops
  );
}

function isEmptyCodexComposerRow(row: string, cursorX: number, learnedEmptyRow: string): boolean {
  const normalized = row.trimEnd();
  return cursorX === 2 && (normalized === '›' || normalized === learnedEmptyRow);
}

function hasCodex(): boolean {
  try {
    execSync(`PATH="${CODEX_BIN_DIR}:$PATH" codex --version`, { stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error('[codex-e2e] codex unavailable:', (e as Error).message.slice(0, 300));
    return false;
  }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

const paneByTail = new Map<string, string>();

function paneIdFor(workdir: string): string {
  const tail = workdir.split('/').pop()!;
  const panes = execSync(`${TMUX} list-panes -a -F '#{pane_id}'`, { encoding: 'utf8' }).trim().split('\n');
  const cached = paneByTail.get(tail);
  if (cached && panes.includes(cached)) return cached;
  for (const p of panes.filter(Boolean)) {
    const text = execSync(`${TMUX} capture-pane -p -t '${p}'`, { encoding: 'utf8' });
    if (text.includes(tail)) {
      paneByTail.set(tail, p);
      return p;
    }
  }
  throw new Error(`no pane showing workdir ${tail}; panes: ${panes.join(', ')}`);
}

/** Rendered pane text (tmux ground truth). Panes are found once by the
 *  workdir basename codex prints in its banner, then cached by pane id —
 *  the lab tmux socket is exclusive to this test. */
function capturePaneFor(workdir: string): string {
  return execSync(`${TMUX} capture-pane -p -t '${paneIdFor(workdir)}'`, { encoding: 'utf8' });
}

function capturePaneCursorStateFor(workdir: string): {
  text: string;
  row: string;
  cursorX: number;
  cursorY: number;
} {
  const paneId = paneIdFor(workdir);
  const text = execSync(`${TMUX} capture-pane -p -t '${paneId}'`, { encoding: 'utf8' });
  const [cursorX, cursorY] = execSync(`${TMUX} display-message -p -t '${paneId}' '#{cursor_x} #{cursor_y}'`, {
    encoding: 'utf8',
  })
    .trim()
    .split(/\s+/u)
    .map(Number);
  return { text, row: text.split('\n')[cursorY] ?? '', cursorX, cursorY };
}

async function createCodexSession(workingDir: string): Promise<string> {
  const created = await api('POST', '/api/sessions', {
    mode: 'codex',
    workingDir,
    envOverrides: { CODEX_HOME: codexHome },
  });
  // Tolerate both the ApiResponse envelope and the legacy raw shape
  const payload = created.data ?? created;
  const id = payload.session?.id ?? payload.id ?? payload.sessionId;
  expect(id, JSON.stringify(created).slice(0, 300)).toBeTruthy();
  createdSessions.push(id);
  return id;
}

/** Select the session in the UI and wait for the codex composer to render. */
async function openInBrowser(id: string): Promise<void> {
  await page.evaluate((sid) => (window as any).app.selectSession(sid), id);
  await page.waitForFunction(
    () => {
      const app = (window as any).app;
      const buf = app.terminal?.buffer.active;
      if (!buf) return false;
      for (let y = 0; y < app.terminal.rows; y++) {
        const t = buf.getLine(buf.baseY + y)?.translateToString(true) ?? '';
        if (/^› /.test(t)) return true;
      }
      return false;
    },
    undefined,
    { timeout: 30000 }
  );
  await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
  await page.waitForFunction(() => (window as any).app._localEchoPolicy === 'predict');
  // Wait for the exact typing precondition: the CURSOR parked on the composer
  // row (the predictWhen gate itself), not merely a composer row existing —
  // during the boot animation the cursor roams and predictions are suppressed.
  await page.waitForFunction(
    () => {
      const w = window as any;
      return w.CodemanTerminalInput.isCodexComposerRow(w.app.terminal);
    },
    undefined,
    { timeout: 20000 }
  );

  // Learn this installed Codex version's placeholder from the initial empty
  // composer. Cursor geometry plus exact tmux/xterm agreement distinguishes
  // the placeholder from typed text without hardcoding version-specific copy.
  const deadline = Date.now() + 10000;
  let last: unknown = null;
  let lastPane = '';
  while (Date.now() < deadline) {
    last = await page.evaluate(() => {
      const w = window as any;
      const terminal = w.app.terminal;
      const buf = terminal.buffer.active;
      return {
        gate: w.CodemanTerminalInput.isCodexComposerRow(terminal),
        row: buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '',
        cursorX: buf.cursorX,
        cursorY: buf.cursorY,
      };
    });
    const paneState = capturePaneCursorStateFor(trustedWorkdir);
    lastPane = paneState.text;
    const state = last as { gate: boolean; row: string; cursorX: number; cursorY: number };
    const normalized = state.row.trimEnd();
    const tmuxAgrees =
      paneState.cursorX === state.cursorX &&
      paneState.cursorY === state.cursorY &&
      paneState.row.trimEnd() === normalized;
    if (state.gate && state.cursorX === 2 && /^›(?:\s|$)/u.test(normalized) && tmuxAgrees) {
      emptyComposerRow = normalized;
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(
    `initial empty composer could not be learned: xterm=${JSON.stringify(last)} ` +
      `pane=${JSON.stringify(lastPane.slice(-1000))}`
  );
}

function predictState(): Promise<{ outstanding: number; confirmedTotal: number; droppedTotal: number }> {
  return page.evaluate(() => (window as any).app._predictiveEcho.state);
}

function predictionFixtureSnapshot(): Promise<PredictionFixtureSnapshot> {
  return page.evaluate(() => {
    const app = (window as any).app;
    const state = app._predictiveEcho.state;
    const debug = app.getEchoDebugState();
    const counts = debug.addonDebug?.counts ?? {};
    const clearPredictions = Object.entries(counts).reduce(
      (totals, [reason, count]) => {
        const match = /^clearPredictions:(\d+)$/u.exec(reason);
        if (!match) return totals;
        const occurrences = Number(count);
        totals.events += occurrences;
        totals.drops += Number(match[1]) * occurrences;
        return totals;
      },
      { events: 0, drops: 0 }
    );
    return {
      outstanding: state.outstanding,
      confirmedTotal: state.confirmedTotal,
      droppedTotal: state.droppedTotal,
      predictHit: debug.appCounts?.predictHit ?? 0,
      mismatchDrops: Object.entries(counts).reduce(
        (total, [reason, count]) => (reason.startsWith('reconcile:mismatchDrop:') ? total + Number(count) : total),
        0
      ),
      ttlDrops: counts['reconcile:ttlDrop'] ?? 0,
      offRowEvents: counts['reconcile:offRow'] ?? 0,
      clearPredictionEvents: clearPredictions.events,
      clearPredictionDrops: clearPredictions.drops,
    };
  });
}

interface RttReadinessSnapshot extends RttInfrastructureReadiness {
  timestamp: number;
  parsedCount: number;
  wsLastClose: unknown;
}

function rttReadinessSnapshot(expectedSessionId: string): Promise<RttReadinessSnapshot> {
  return page.evaluate((expected) => {
    const w = window as any;
    const app = w.app;
    const terminal = app.terminal;
    const pending = app._pendingDeliveries?.get?.(expected) ?? [];
    return {
      timestamp: performance.now(),
      parsedCount: w.__cod369ParsedTracker?.count ?? 0,
      activeSessionId: app.activeSessionId ?? null,
      expectedSessionId: expected,
      wsReady: app._wsReady === true,
      wsState: app._wsState ?? 'unknown',
      wsSessionId: app._wsSessionId ?? null,
      wsOpen: !!app._ws && app._ws.readyState === WebSocket.OPEN,
      pendingDeliveries: pending.length,
      postDraining: app._postDraining?.has?.(expected) === true,
      pendingInputLength: app._pendingInput?.length ?? 0,
      inputFlushPending: !!app._inputFlushTimeout,
      renderQueueLength:
        (app.pendingWrites?.reduce?.((total: number, chunk: string) => total + (chunk?.length ?? 0), 0) ?? 0) +
        (app.flickerFilterBuffer?.length ?? 0),
      writeFrameScheduled: app.writeFrameScheduled === true,
      delayedWritesPending: w.__cod369DelayedWritesPending ?? 0,
      terminalInitialized: !!(
        terminal?.element &&
        terminal?.textarea &&
        terminal?.buffer?.active &&
        terminal?._core?._renderService
      ),
      composerGate: !!terminal && w.CodemanTerminalInput.isCodexComposerRow(terminal),
      currentHoldMs: app._predictiveEcho?.debugState.currentHoldMs ?? null,
      wsLastClose: app._wsLastClose ?? null,
    };
  }, expectedSessionId);
}

async function waitForStableRttInfrastructure(
  expectedSessionId: string,
  stabilityMs = RTT_DELAY_MS,
  timeoutMs = 12000
): Promise<RttReadinessSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let readySince: number | null = null;
  let readyParsedCount: number | null = null;
  let current = await rttReadinessSnapshot(expectedSessionId);
  while (Date.now() < deadline) {
    current = await rttReadinessSnapshot(expectedSessionId);
    if (!isRttInfrastructureReady(current)) {
      readySince = null;
      readyParsedCount = null;
    } else if (readySince === null || readyParsedCount !== current.parsedCount) {
      readySince = current.timestamp;
      readyParsedCount = current.parsedCount;
    } else if (current.timestamp - readySince >= stabilityMs) {
      return current;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`[RTT infrastructure] readiness did not stabilize: ${JSON.stringify(current)}`);
}

async function prepareRttTrial(expectedSessionId: string): Promise<void> {
  let lastReadinessError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await waitForStableRttInfrastructure(expectedSessionId);
      await resetComposer();
      await waitForStableRttInfrastructure(expectedSessionId);
      return;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('[RTT infrastructure]')) throw error;
      lastReadinessError = error;
      if (attempt === 0) {
        await page.evaluate((expected) => {
          const app = (window as any).app;
          if (app.activeSessionId !== expected) throw new Error('active session changed before RTT retry');
          app.retryConnection();
        }, expectedSessionId);
      }
    }
  }
  throw lastReadinessError;
}

async function waitForRequiredPredictionConvergence(
  baseline: PredictionFixtureSnapshot,
  requiredConfirmations: number,
  timeoutMs = 15000
): Promise<PredictionFixtureSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let current = await predictionFixtureSnapshot();
  while (Date.now() < deadline) {
    current = await predictionFixtureSnapshot();
    if (hasNamedRepaintPredictionConvergence(baseline, current, requiredConfirmations)) return current;
    if (current.mismatchDrops !== baseline.mismatchDrops || current.ttlDrops !== baseline.ttlDrops) {
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const diagnostics = await page.evaluate(() => (window as any).app.getEchoDebugState());
  throw new Error(
    `prediction did not converge semantically: baseline=${JSON.stringify(baseline)} current=${JSON.stringify(current)} ` +
      `diagnostics=${JSON.stringify(diagnostics)}`
  );
}

async function waitForGracefullyAccountedPredictionConvergence(
  baseline: PredictionFixtureSnapshot,
  requiredConfirmations: number,
  timeoutMs = 15000
): Promise<PredictionFixtureSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let current = await predictionFixtureSnapshot();
  while (Date.now() < deadline) {
    current = await predictionFixtureSnapshot();
    if (hasNamedRepaintPredictionConvergence(baseline, current, requiredConfirmations)) return current;
    if (current.mismatchDrops !== baseline.mismatchDrops || current.ttlDrops !== baseline.ttlDrops) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  const diagnostics = await page.evaluate(() => (window as any).app.getEchoDebugState());
  throw new Error(
    `prediction did not reach accounted graceful convergence: baseline=${JSON.stringify(baseline)} ` +
      `current=${JSON.stringify(current)} diagnostics=${JSON.stringify(diagnostics)}`
  );
}

interface RttPredictionSnapshot {
  outstanding: number;
  predictHit: number;
  spanLeft: number;
  spanTop: number;
  expectedLeft: number;
  expectedTop: number;
  text: string | null;
  observedDelayMs: number;
}

async function armRttPredictionObservation(
  basePredictHit: number,
  expectedSessionId: string,
  echoDelayMs = RTT_DELAY_MS
): Promise<void> {
  await page.evaluate(
    ({ baselineHit, expectedSession, delayMs }) => {
      const w = window as any;
      let resolveHealth: (value: unknown) => void;
      let rejectHealth: (reason: Error) => void;
      w.__cod369RttInfrastructureHealth = new Promise((resolvePromise, rejectPromise) => {
        resolveHealth = resolvePromise;
        rejectHealth = rejectPromise;
      });
      w.__cod369RttObservation = new Promise((resolvePromise, rejectPromise) => {
        const onKeyDown = (event: KeyboardEvent) => {
          if (event.key !== 'h') return;
          window.removeEventListener('keydown', onKeyDown, true);
          const keydownAt = performance.now();
          let lastDiagnostics: unknown = null;
          const pollInfrastructure = () => {
            const app = w.app;
            const elapsedMs = performance.now() - keydownAt;
            const health = {
              elapsedMs,
              activeSessionId: app.activeSessionId ?? null,
              expectedSessionId: expectedSession,
              wsReady: app._wsReady === true,
              wsState: app._wsState ?? 'unknown',
              wsSessionId: app._wsSessionId ?? null,
              wsOpen: !!app._ws && app._ws.readyState === WebSocket.OPEN,
              terminalInitialized: !!(
                app.terminal?.element &&
                app.terminal?.textarea &&
                app.terminal?.buffer?.active &&
                app.terminal?._core?._renderService
              ),
              wsLastClose: app._wsLastClose ?? null,
            };
            const healthy =
              health.activeSessionId === expectedSession &&
              health.wsReady &&
              health.wsState === 'connected' &&
              health.wsSessionId === expectedSession &&
              health.wsOpen &&
              health.terminalInitialized;
            if (!healthy) {
              rejectHealth(new Error(`[RTT infrastructure] readiness dropped during trial: ${JSON.stringify(health)}`));
              return;
            }
            if (elapsedMs >= delayMs) {
              resolveHealth(health);
              return;
            }
            window.setTimeout(pollInfrastructure, 0);
          };
          const poll = () => {
            const app = w.app;
            const span = document.querySelector('.xterm-screen [data-predictive-echo] span') as HTMLElement;
            const screen = document.querySelector('.xterm-screen') as HTMLElement;
            const dims = app.terminal._core._renderService.dimensions.css.cell;
            const buf = app.terminal.buffer.active;
            const debug = app.getEchoDebugState();
            const observedDelayMs = performance.now() - keydownAt;
            lastDiagnostics = {
              observedDelayMs,
              gate: w.CodemanTerminalInput.isCodexComposerRow(app.terminal),
              state: app._predictiveEcho.state,
              appCounts: debug.appCounts,
              anchorHold: {
                currentMs: debug.addonDebug?.currentHoldMs ?? null,
                count: debug.addonDebug?.anchorHoldCount ?? 0,
                suppressions: debug.addonDebug?.counts?.anchorHold ?? 0,
              },
            };
            if (span && (debug.appCounts?.predictHit ?? 0) > baselineHit) {
              resolvePromise({
                outstanding: app._predictiveEcho.state.outstanding,
                predictHit: debug.appCounts.predictHit,
                spanLeft: span.getBoundingClientRect().left - screen.getBoundingClientRect().left,
                spanTop: span.getBoundingClientRect().top - screen.getBoundingClientRect().top,
                expectedLeft: buf.cursorX * dims.width,
                expectedTop: buf.cursorY * dims.height,
                text: span.textContent,
                observedDelayMs,
              });
              return;
            }
            if (observedDelayMs >= delayMs) {
              rejectPromise(
                new Error(
                  `prediction span did not appear before delayed echo; diagnostics=${JSON.stringify(lastDiagnostics)}`
                )
              );
              return;
            }
            window.setTimeout(poll, 0);
          };
          pollInfrastructure();
          poll();
        };
        window.addEventListener('keydown', onKeyDown, true);
      });
    },
    { baselineHit: basePredictHit, expectedSession: expectedSessionId, delayMs: echoDelayMs }
  );
}

function readRttPredictionObservation(): Promise<RttPredictionSnapshot> {
  return page.evaluate(() => (window as any).__cod369RttObservation);
}

function readRttInfrastructureTrialHealth(): Promise<unknown> {
  return page.evaluate(() => (window as any).__cod369RttInfrastructureHealth);
}

function spanCount(): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length);
}

/** Deterministic, fail-safe composer reset. The sentinel is never submitted,
 *  and its parsed echo is the production onWriteParsed barrier that releases
 *  anchorHold. Cleanup always runs, even when tmux/xterm disagree. */
async function resetComposer(): Promise<void> {
  // Codex can be mid-respawn after an exhausted 401 retry loop killed it:
  // wait for a live composer (the gate itself) before touching the keyboard.
  // If a prior request is visibly retrying, Esc is the TUI's documented
  // interrupt and lets the composer become observable again.
  const liveDeadline = Date.now() + 25000;
  let lastLivePane = '';
  let lastLiveState: unknown = null;
  let composerLive = false;
  while (Date.now() < liveDeadline) {
    lastLiveState = await page.evaluate(() => {
      const w = window as any;
      const terminal = w.app.terminal;
      const buf = terminal?.buffer.active;
      return {
        gate: !!terminal && w.CodemanTerminalInput.isCodexComposerRow(terminal),
        row: buf?.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '',
        activeSessionId: w.app.activeSessionId,
      };
    });
    if ((lastLiveState as { gate: boolean }).gate) {
      composerLive = true;
      break;
    }
    lastLivePane = capturePaneFor(trustedWorkdir);
    if (/Reconnecting|esc to interrupt/.test(lastLivePane)) await page.keyboard.press('Escape');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (!composerLive) {
    throw new Error(
      `live composer gate timed out: state=${JSON.stringify(lastLiveState)} ` +
        `pane=${JSON.stringify(lastLivePane.slice(-1000))}`
    );
  }
  await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });

  await page.evaluate(() => {
    const w = window as any;
    const terminal = w.app.terminal;
    let tracker = w.__cod369ParsedTracker;
    if (!tracker || tracker.terminal !== terminal) {
      tracker?.disposable?.dispose?.();
      tracker = { terminal, count: 0, disposable: null };
      tracker.disposable = terminal.onWriteParsed(() => tracker.count++);
      w.__cod369ParsedTracker = tracker;
    }
  });

  const resetSentinel = 'cod369-reset';
  let parsedBeforeSentinel = 0;

  const waitForAgreement = async (
    label: string,
    predicate: (state: {
      parsedCount: number;
      gate: boolean;
      row: string;
      cursorX: number;
      cursorY: number;
      outstanding: number | null;
      currentHoldMs: number | null;
    }) => boolean
  ): Promise<void> => {
    const deadline = Date.now() + 12000;
    let lastXterm: unknown = null;
    let lastPane = '';
    while (Date.now() < deadline) {
      lastXterm = await page.evaluate(() => {
        const w = window as any;
        const terminal = w.app.terminal;
        const buf = terminal.buffer.active;
        const predictor = w.app._predictiveEcho;
        return {
          parsedCount: w.__cod369ParsedTracker?.count ?? 0,
          gate: w.CodemanTerminalInput.isCodexComposerRow(terminal),
          row: buf.getLine(buf.baseY + buf.cursorY)?.translateToString(true) ?? '',
          cursorX: buf.cursorX,
          cursorY: buf.cursorY,
          outstanding: predictor?.state.outstanding ?? null,
          currentHoldMs: predictor?.debugState.currentHoldMs ?? null,
        };
      });
      const paneState = capturePaneCursorStateFor(trustedWorkdir);
      lastPane = paneState.text;
      const state = lastXterm as {
        parsedCount: number;
        gate: boolean;
        row: string;
        cursorX: number;
        cursorY: number;
        outstanding: number | null;
        currentHoldMs: number | null;
      };
      const normalized = state.row.trimEnd();
      const tmuxAgrees =
        paneState.cursorX === state.cursorX &&
        paneState.cursorY === state.cursorY &&
        paneState.row.trimEnd() === normalized;
      if (tmuxAgrees && predicate(state)) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error(
      `${label} timed out: xterm=${JSON.stringify(lastXterm)} pane=${JSON.stringify(lastPane.slice(-1000))}`
    );
  };

  await runComposerResetProtocol({
    proveCleanStart: async () => {
      // End first because Codex's Ctrl+U kills only back to line start.
      await page.keyboard.press('End');
      await page.keyboard.press('Control+u');
      await waitForAgreement('composer reset pre-clean', (state) => {
        return state.gate && isEmptyCodexComposerRow(state.row, state.cursorX, emptyComposerRow);
      });
      parsedBeforeSentinel = await page.evaluate(() => (window as any).__cod369ParsedTracker.count);
    },
    sendSentinel: async () => {
      await page.keyboard.type(resetSentinel);
    },
    proveSentinelAgreement: async () => {
      await waitForAgreement('composer reset sentinel', (state) => {
        return state.parsedCount > parsedBeforeSentinel && state.gate && state.row.trimEnd() === `› ${resetSentinel}`;
      });
    },
    clearAndProveClean: async () => {
      const parsedBeforeClear = await page.evaluate(() => (window as any).__cod369ParsedTracker.count);
      await page.keyboard.press('End');
      await page.keyboard.press('Control+u');
      await waitForAgreement('composer reset fail-safe cleanup', (state) => {
        const predictorSettled =
          state.outstanding === null || (state.outstanding === 0 && state.currentHoldMs === null);
        return (
          state.parsedCount > parsedBeforeClear &&
          state.gate &&
          isEmptyCodexComposerRow(state.row, state.cursorX, emptyComposerRow) &&
          predictorSettled
        );
      });
    },
  });

  // Reassert the exact production gate immediately before the caller types.
  await page.waitForFunction(
    () => {
      const w = window as any;
      const terminal = w.app.terminal;
      const buf = terminal.buffer.active;
      const predictor = w.app._predictiveEcho;
      return (
        w.CodemanTerminalInput.isCodexComposerRow(terminal) &&
        buf.cursorX === 2 &&
        (!predictor || (predictor.state.outstanding === 0 && predictor.debugState.currentHoldMs === null))
      );
    },
    undefined,
    { timeout: 5000 }
  );
}

/** After a submit 401s, codex sits in a Reconnecting retry loop that can eat
 *  typed input; Esc interrupts it. Wait until the retry line is gone. */
async function cancelRetryLoop(): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const pane = capturePaneFor(trustedWorkdir);
    if (!/Reconnecting|esc to interrupt/.test(pane)) break;
    await page.keyboard.press('Escape');
    await new Promise((r) => setTimeout(r, 500));
  }
  // Settle to a live composer (codex may have died at 5/5 and respawned),
  // then require it to STAY alive: the fake-key request can kill codex
  // seconds later, so a single gate-true observation is not enough.
  const stableDeadline = Date.now() + 30000;
  for (;;) {
    await resetComposer();
    let stable = true;
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const alive = await page.evaluate(() => {
        const w = window as any;
        return w.CodemanTerminalInput.isCodexComposerRow(w.app.terminal);
      });
      if (!alive) {
        stable = false;
        break;
      }
    }
    if (stable || Date.now() > stableDeadline) return;
  }
}

const CODEX_AVAILABLE = hasCodex();
const d = CODEX_AVAILABLE ? describe : describe.skip;

describe('COD-369 predictive gate contracts', () => {
  it('uses the learned installed-version placeholder without accepting typed text', () => {
    const learned = '› Version-specific placeholder';
    expect(isEmptyCodexComposerRow(learned, 2, learned)).toBe(true);
    expect(isEmptyCodexComposerRow('›', 2, learned)).toBe(true);
    expect(isEmptyCodexComposerRow('› hello', 2, learned)).toBe(false);
    expect(isEmptyCodexComposerRow(learned, 3, learned)).toBe(false);
  });

  it('does not count transient outstanding predictions as successful convergence', () => {
    const baseline: PredictionFixtureSnapshot = {
      outstanding: 0,
      confirmedTotal: 10,
      droppedTotal: 2,
      predictHit: 10,
      mismatchDrops: 1,
      ttlDrops: 1,
      offRowEvents: 2,
      clearPredictionEvents: 2,
      clearPredictionDrops: 2,
    };
    const transient: PredictionFixtureSnapshot = {
      ...baseline,
      outstanding: 5,
      predictHit: 15,
    };

    expect(hasNamedRepaintPredictionConvergence(baseline, transient, 3)).toBe(false);
  });

  it('rejects convergence reached through a mismatch or TTL drop', () => {
    const baseline: PredictionFixtureSnapshot = {
      outstanding: 0,
      confirmedTotal: 10,
      droppedTotal: 2,
      predictHit: 10,
      mismatchDrops: 1,
      ttlDrops: 1,
      offRowEvents: 2,
      clearPredictionEvents: 2,
      clearPredictionDrops: 2,
    };
    const dropped: PredictionFixtureSnapshot = {
      outstanding: 0,
      confirmedTotal: 13,
      droppedTotal: 4,
      predictHit: 15,
      mismatchDrops: 2,
      ttlDrops: 2,
      offRowEvents: 2,
      clearPredictionEvents: 2,
      clearPredictionDrops: 2,
    };

    expect(hasNamedRepaintPredictionConvergence(baseline, dropped, 3)).toBe(false);
  });

  it('clears a stranded sentinel after disagreement so the next reset succeeds', async () => {
    let composer = '';
    let failAgreement = true;
    const driver: ComposerResetProtocolDriver = {
      proveCleanStart: async () => {
        expect(composer).toBe('');
      },
      sendSentinel: async () => {
        composer += 'cod369-reset';
      },
      proveSentinelAgreement: async () => {
        if (failAgreement) throw new Error('xterm/tmux disagreement');
      },
      clearAndProveClean: async () => {
        composer = '';
      },
    };

    await expect(runComposerResetProtocol(driver)).rejects.toThrow('xterm/tmux disagreement');
    expect(composer).toBe('');
    failAgreement = false;
    await expect(runComposerResetProtocol(driver)).resolves.toBeUndefined();
    expect(composer).toBe('');
  });

  it('allows an exactly attributed off-row repaint drop during ordinary typing', () => {
    const baseline: PredictionFixtureSnapshot = {
      outstanding: 0,
      confirmedTotal: 10,
      droppedTotal: 2,
      predictHit: 10,
      mismatchDrops: 1,
      ttlDrops: 1,
      offRowEvents: 2,
      clearPredictionEvents: 2,
      clearPredictionDrops: 2,
    };
    const repaintDrop: PredictionFixtureSnapshot = {
      ...baseline,
      confirmedTotal: 14,
      droppedTotal: 3,
      predictHit: 15,
      offRowEvents: 3,
      clearPredictionEvents: 3,
      clearPredictionDrops: 3,
    };

    expect(hasNamedRepaintPredictionConvergence(baseline, repaintDrop, 3)).toBe(true);
  });

  it('does not call an unattributed generic drop graceful RTT convergence', () => {
    const baseline: PredictionFixtureSnapshot = {
      outstanding: 0,
      confirmedTotal: 10,
      droppedTotal: 2,
      predictHit: 10,
      mismatchDrops: 1,
      ttlDrops: 1,
      offRowEvents: 2,
      clearPredictionEvents: 2,
      clearPredictionDrops: 2,
    };
    const genericDrop: PredictionFixtureSnapshot = {
      ...baseline,
      confirmedTotal: 13,
      droppedTotal: 3,
      predictHit: 14,
    };

    expect(hasNamedRepaintPredictionConvergence(baseline, genericDrop, 3)).toBe(false);
  });

  it('rejects a stale composer when its production WebSocket is not ready', () => {
    const stale: RttInfrastructureReadiness = {
      activeSessionId: 'expected',
      expectedSessionId: 'expected',
      wsReady: false,
      wsState: 'reconnecting',
      wsSessionId: null,
      wsOpen: false,
      pendingDeliveries: 0,
      postDraining: false,
      pendingInputLength: 0,
      inputFlushPending: false,
      renderQueueLength: 0,
      writeFrameScheduled: false,
      delayedWritesPending: 0,
      terminalInitialized: true,
      composerGate: true,
      currentHoldMs: null,
    };

    expect(isRttInfrastructureReady(stale)).toBe(false);
  });

  it('restores the predictor after the predictor-absent byte run throws', async () => {
    let predictor: object | null = {};
    const original = predictor;
    await expect(
      withMandatoryCleanup(
        async () => {
          predictor = null;
          throw new Error('byte script failed');
        },
        async () => {
          predictor = original;
        }
      )
    ).rejects.toThrow('byte script failed');
    expect(predictor).toBe(original);
  });

  it('restores the exact local-echo setting after the kill-switch body throws', async () => {
    let localEchoEnabled: boolean | undefined = undefined;
    const original = localEchoEnabled;
    await expect(
      withMandatoryCleanup(
        async () => {
          localEchoEnabled = false;
          throw new Error('kill-switch assertion failed');
        },
        async () => {
          localEchoEnabled = original;
        }
      )
    ).rejects.toThrow('kill-switch assertion failed');
    expect(localEchoEnabled).toBe(original);
  });
});

beforeAll(async () => {
  if (!CODEX_AVAILABLE) return;
  mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
  codexHome = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-'));
  trustedWorkdir = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-work-'));
  untrustedWorkdir = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-untrusted-'));
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(resolve(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-123' }));
  writeFileSync(resolve(codexHome, 'config.toml'), `[projects."${trustedWorkdir}"]\ntrust_level = "trusted"\n`);

  // Child env: strip the vitest markers so the lab server runs REAL tmux/codex
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.VITEST;
  delete env.VITEST_MODE;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  delete env.NODE_ENV;
  env.CODEMAN_INSTANCE = INSTANCE;
  env.PATH = `${CODEX_BIN_DIR}:${env.PATH}`;

  server = spawn('npx', ['tsx', 'src/index.ts', 'web', '--port', String(PORT)], {
    cwd: ROOT,
    env: env as NodeJS.ProcessEnv,
    stdio: 'ignore',
    detached: false,
  });

  // Wait for the lab server
  const deadline = Date.now() + 30000;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/api/status`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('lab server did not start on :3222');
    await new Promise((r) => setTimeout(r, 300));
  }

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem('codeman-app-settings', JSON.stringify({ localEchoEnabled: true }));
  });
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10000 });

  sessionId = await createCodexSession(trustedWorkdir);
  await openInBrowser(sessionId);
}, 120_000);

afterAll(async () => {
  for (const id of createdSessions) {
    try {
      await api('DELETE', `/api/sessions/${id}`);
    } catch {
      /* best effort */
    }
  }
  await context?.close();
  await browser?.close();
  server?.kill('SIGTERM');
  try {
    execSync(`${TMUX} kill-server`, { stdio: 'ignore' });
  } catch {
    /* already gone */
  }
  for (const fixtureDir of [codexHome, trustedWorkdir, untrustedWorkdir]) {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  }
}, 30_000);

d('codex predictive echo E2E (real codex TUI)', () => {
  it('bundle smoke: both echo globals are defined', async () => {
    const globals = await page.evaluate(() => ({
      zerolag: typeof (window as any).LocalEchoOverlay,
      predictive: typeof (window as any).PredictiveEchoOverlay,
      instance: !!(window as any).app._predictiveEcho,
    }));
    expect(globals.zerolag).toBe('function');
    expect(globals.predictive).toBe('function');
    expect(globals.instance).toBe(true);
  });

  it('typing predicts every char and converges into the real echo', async () => {
    await resetComposer();
    const baseline = await predictionFixtureSnapshot();
    await page.keyboard.type('hello', { delay: 30 });
    // Keystrokes went through the predictor (a transient repaint may suppress
    // one or two: that is designed graceful degradation, never a ghost). Do
    // not accept transient outstanding spans as success: require real parsed
    // echo confirmations. The only allowed drop is the addon's named off-row
    // repaint path; mismatch/TTL remain test failures.
    const converged = await waitForRequiredPredictionConvergence(baseline, 3);
    expect(converged.outstanding).toBe(0);
    expect(converged.confirmedTotal - baseline.confirmedTotal).toBeGreaterThanOrEqual(3);
    expect(converged.predictHit - baseline.predictHit).toBeGreaterThanOrEqual(3);
    expect(converged.droppedTotal - baseline.droppedTotal).toBe(
      converged.clearPredictionDrops - baseline.clearPredictionDrops
    );
    expect(converged.clearPredictionEvents - baseline.clearPredictionEvents).toBe(
      converged.offRowEvents - baseline.offRowEvents
    );
    expect(converged.mismatchDrops).toBe(baseline.mismatchDrops);
    expect(converged.ttlDrops).toBe(baseline.ttlDrops);
    expect(await spanCount()).toBe(0);
    const deadline = Date.now() + 10000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('hello')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(pane).toContain('hello');
  }, 30_000);

  it('#222: slash picker filters live while predictions confirm away', async () => {
    await resetComposer();
    await page.keyboard.type('/', { delay: 30 });
    const deadline = Date.now() + 10000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (/\/model|\/skills|\/init/.test(pane)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(pane).toMatch(/\/model|\/skills|\/init/);
    await page.keyboard.type('mo', { delay: 40 });
    await page.waitForFunction(
      () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0
    );
    const filtered = capturePaneFor(trustedWorkdir);
    expect(filtered).toContain('/model');
    await page.keyboard.press('Escape'); // close the picker
    await page.keyboard.press('Control+u'); // deterministically empty the composer
    await new Promise((r) => setTimeout(r, 300));
    const s = await predictState();
    expect(s.outstanding).toBe(0);
  }, 30_000);

  it('#219: typed text + paste land in order with nothing dropped', async () => {
    await resetComposer();
    const pidBefore = execSync(`${TMUX} list-panes -a -F '#{pane_id} #{pane_pid}'`, { encoding: 'utf8' }).trim();
    await page.evaluate(() => {
      const app = (window as any).app;
      (window as any).__dbg = [];
      if (!(window as any).__origSend2) (window as any).__origSend2 = app._sendInputAsync.bind(app);
      app._sendInputAsync = (sid: string, data: string, opts?: unknown) => {
        (window as any).__dbg.push([sid.slice(0, 8), JSON.stringify(data)]);
        return (window as any).__origSend2(sid, data, opts);
      };
    });
    await page.keyboard.type('abc', { delay: 30 });
    await page.evaluate(() => (window as any).app.terminal.paste('XYZ'));
    const deadline = Date.now() + 15000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('abcXYZ')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!pane.includes('abcXYZ')) {
      const pidAfter = execSync(`${TMUX} list-panes -a -F '#{pane_id} #{pane_pid}'`, { encoding: 'utf8' }).trim();
      const dbg = await page.evaluate(() => (window as any).__dbg);
      const row = await page.evaluate(() => {
        const b = (window as any).app.terminal.buffer.active;
        return b.getLine(b.baseY + b.cursorY)?.translateToString(true);
      });
      console.log(
        'DBG219 pids-before:',
        pidBefore,
        '| pids-after:',
        pidAfter,
        '| sends:',
        JSON.stringify(dbg),
        '| app-cursor-row:',
        JSON.stringify(row)
      );
    }
    expect(pane).toContain('abcXYZ');
    expect(await spanCount()).toBe(0); // paste classified 'clear'
    await page.keyboard.press('Control+u'); // Ctrl+U: clear the composer line
  }, 30_000);

  it('#220: wrapped input renders exactly, no ghost glyphs past the edge', async () => {
    await resetComposer();
    const long = 'the quick brown fox jumps over the lazy dog and keeps running until the composer has to wrap';
    await page.keyboard.type(long, { delay: 5 });
    // Predictions on the first composer row confirm or drop; continuation
    // rows are gate-suppressed. Everything converges:
    await page.waitForFunction(
      () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0,
      undefined,
      { timeout: 10000 }
    );
    const deadline = Date.now() + 10000;
    let ok = false;
    while (Date.now() < deadline) {
      const pane = capturePaneFor(trustedWorkdir).replace(/\s+/g, ' ');
      if (pane.includes('composer has to wrap')) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(ok).toBe(true);
    await page.keyboard.press('Control+u');
    await new Promise((r) => setTimeout(r, 200));
  }, 45_000);

  it('modal ghost eliminator: zero spans while typing on the trust dialog', async () => {
    const modalSession = await createCodexSession(untrustedWorkdir);
    try {
      await page.evaluate((sid) => (window as any).app.selectSession(sid), modalSession);
      // Wait for the trust dialog (the pane may not exist for the first second)
      const deadline = Date.now() + 25000;
      let pane = '';
      while (Date.now() < deadline) {
        try {
          pane = capturePaneFor(untrustedWorkdir);
          if (pane.includes('Press enter to continue')) break;
        } catch {
          /* session still spawning */
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(pane).toContain('Press enter to continue');
      await page.waitForFunction(() => (window as any).app._localEchoPolicy === 'predict');
      await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
      await page.keyboard.type('x', { delay: 30 });
      expect(await spanCount()).toBe(0); // gate rejected: no ghost on the modal
      expect((await predictState()).outstanding).toBe(0);
    } finally {
      // Never strand later tests on the modal session
      await api('DELETE', `/api/sessions/${modalSession}`);
      await page.evaluate((sid) => (window as any).app.selectSession(sid), sessionId);
      await page.waitForFunction(() => (window as any).app._localEchoPolicy === 'predict');
      await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
    }
  }, 45_000);

  it('kill switch: localEchoEnabled OFF clears spans and typing still streams', async () => {
    const priorSettings = await page.evaluate(() => (window as any).app.loadAppSettingsFromStorage());
    await withMandatoryCleanup(
      async () => {
        await page.evaluate(() => {
          const app = (window as any).app;
          const settings = app.loadAppSettingsFromStorage();
          settings.localEchoEnabled = false;
          app.saveAppSettingsToStorage(settings);
          app._updateLocalEchoState();
        });
        expect(await page.evaluate(() => (window as any).app._localEchoPolicy)).toBe('off');
        expect(await spanCount()).toBe(0);
        await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
        await page.keyboard.press('End');
        await page.keyboard.press('Control+u');
        await page.keyboard.type('still-live', { delay: 20 });
        const deadline = Date.now() + 10000;
        let pane = '';
        while (Date.now() < deadline) {
          pane = capturePaneFor(trustedWorkdir);
          if (pane.includes('still-live')) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        expect(pane).toContain('still-live'); // 1.12.2 behavior exactly
        expect(await spanCount()).toBe(0);
      },
      async () => {
        await page.evaluate((settings) => {
          const app = (window as any).app;
          app.saveAppSettingsToStorage(settings);
          app._updateLocalEchoState();
        }, priorSettings);
        await page.keyboard.press('End');
        await page.keyboard.press('Control+u');
      }
    );
  }, 30_000);

  it('byte-identity: the wire receives the same bytes with the predictor active vs absent', async () => {
    const script = async () => {
      await resetComposer();
      await page.keyboard.type('ab', { delay: 60 });
      await page.keyboard.press('Backspace');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('c', { delay: 60 });
      await page.evaluate(() => (window as any).app.terminal.paste('PQ'));
      await new Promise((r) => setTimeout(r, 250));
      await page.keyboard.press('End');
      await page.keyboard.press('Control+u');
      await new Promise((r) => setTimeout(r, 250));
    };

    const record = () =>
      page.evaluate(() => {
        const app = (window as any).app;
        (window as any).__trace = [];
        if (!(window as any).__origSend) (window as any).__origSend = app._sendInputAsync.bind(app);
        app._sendInputAsync = (sid: string, data: string, opts?: unknown) => {
          (window as any).__trace.push(data);
          return (window as any).__origSend(sid, data, opts);
        };
      });
    const trace = () => page.evaluate(() => ((window as any).__trace as string[]).join(''));

    await record();
    await script();
    const withPredictor = await trace();

    const withoutPredictor = await withMandatoryCleanup(
      async () => {
        await page.evaluate(() => {
          (window as any).__savedPredictor = (window as any).app._predictiveEcho;
          (window as any).app._predictiveEcho = null;
        });
        await record();
        await script();
        return trace();
      },
      async () => {
        await page.evaluate(() => {
          (window as any).app._predictiveEcho = (window as any).__savedPredictor;
          delete (window as any).__savedPredictor;
        });
      }
    );
    expect(await page.evaluate(() => !!(window as any).app._predictiveEcho)).toBe(true);

    expect(withPredictor.length).toBeGreaterThan(0);
    expect(withoutPredictor).toBe(withPredictor); // the visual-only invariant, end to end
    // The same script covers insert, backspace, cursor edit, paste, and a final
    // output repaint/clear. Byte identity is insufficient unless the overlay
    // also converges completely after those boundaries.
    expect(await spanCount()).toBe(0);
    expect(await predictState()).toMatchObject({ outstanding: 0 });
  }, 60_000);

  it('#218: arrows + mid-word insert submit the exact edited text', async () => {
    await resetComposer();
    await page.keyboard.type('hello', { delay: 30 });
    await new Promise((r) => setTimeout(r, 300));
    await page.keyboard.press('ArrowLeft');
    // Nav keys clear predictions immediately (classify 'clear')
    expect(await predictState()).toMatchObject({ outstanding: 0 });
    expect(await spanCount()).toBe(0);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.type('X', { delay: 30 });
    await page.keyboard.press('Enter');
    // The submitted transcript line carries the edited text
    const deadline = Date.now() + 15000;
    let pane = '';
    while (Date.now() < deadline) {
      pane = capturePaneFor(trustedWorkdir);
      if (pane.includes('helXlo')) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(pane).toContain('helXlo');
    expect(await spanCount()).toBe(0);
    await cancelRetryLoop();
  }, 45_000);

  it('simulated 300ms RTT: instant spans with correct pixel geometry, exact convergence', async () => {
    const runTrial = async () => {
      await prepareRttTrial(sessionId);
      await page.evaluate((delayMs) => {
        const w = window as any;
        const app = w.app;
        w.__origWrite = app.terminal.write.bind(app.terminal);
        w.__cod369DelayedWritesPending = 0;
        app.terminal.write = (data: unknown, cb?: () => void) => {
          w.__cod369DelayedWritesPending++;
          return window.setTimeout(() => {
            w.__origWrite(data, () => {
              w.__cod369DelayedWritesPending--;
              cb?.();
            });
          }, delayMs);
        };
      }, RTT_DELAY_MS);

      await withMandatoryCleanup(
        async () => {
          // No fixed settle sleep: require the production socket, reliable
          // queue, renderer and parsed-output epoch to stay ready for one full
          // simulated RTT after the delayed-write wrapper is installed.
          await waitForStableRttInfrastructure(sessionId);
          const base = await predictionFixtureSnapshot();

          await armRttPredictionObservation(base.predictHit, sessionId);
          await page.keyboard.press('h');
          // Poll until the predictor records a hit AND paints its span, but
          // only within the browser keydown-relative pre-echo window.
          const snap = await readRttPredictionObservation();
          expect(snap.outstanding).toBe(1);
          expect(snap.text).toBe('h');
          expect(snap.observedDelayMs).toBeLessThan(RTT_DELAY_MS);
          expect(Math.abs(snap.spanLeft - snap.expectedLeft)).toBeLessThan(1.5);
          expect(Math.abs(snap.spanTop - snap.expectedTop)).toBeLessThan(1.5);

          await page.keyboard.type('igh rtt', { delay: 40 });
          // Transport loss is a bounded test-infrastructure retry condition,
          // never a successful predictor convergence or an allowed TTL drop.
          await readRttInfrastructureTrialHealth();

          // Every accepted hit must confirm or take the exact named off-row
          // repaint path. At least three must really confirm; mismatch and TTL
          // remain failures.
          const converged = await waitForGracefullyAccountedPredictionConvergence(base, 3);
          const deadline = Date.now() + 10000;
          let pane = '';
          while (Date.now() < deadline) {
            pane = capturePaneFor(trustedWorkdir);
            if (pane.includes('high rtt')) break;
            await new Promise((r) => setTimeout(r, 250));
          }
          expect(pane).toContain('high rtt');
          expect(converged.confirmedTotal - base.confirmedTotal + (converged.droppedTotal - base.droppedTotal)).toBe(
            converged.predictHit - base.predictHit
          );
          expect(converged.mismatchDrops).toBe(base.mismatchDrops);
          expect(converged.ttlDrops).toBe(base.ttlDrops);
          expect(converged.droppedTotal - base.droppedTotal).toBe(
            converged.clearPredictionDrops - base.clearPredictionDrops
          );
          expect(converged.clearPredictionEvents - base.clearPredictionEvents).toBe(
            converged.offRowEvents - base.offRowEvents
          );

          // #218 under RTT: arrows still edit correctly with delayed display.
          await page.keyboard.press('ArrowLeft');
          await page.keyboard.type('Z', { delay: 40 });
          await page.keyboard.press('Enter');
          const deadline2 = Date.now() + 15000;
          let pane2 = '';
          while (Date.now() < deadline2) {
            pane2 = capturePaneFor(trustedWorkdir);
            if (pane2.includes('high rtZt')) break;
            await new Promise((r) => setTimeout(r, 300));
          }
          expect(pane2).toContain('high rtZt');
        },
        async () => {
          await page.evaluate(() => {
            const w = window as any;
            if (w.__origWrite) w.app.terminal.write = w.__origWrite;
            delete w.__origWrite;
            delete w.__cod369DelayedWritesPending;
            delete w.__cod369RttObservation;
            delete w.__cod369RttInfrastructureHealth;
          });
        }
      );
    };

    let lastInfrastructureFailure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await runTrial();
        return;
      } catch (error) {
        const infrastructureFailure = error instanceof Error && error.message.includes('[RTT infrastructure]');
        if (!infrastructureFailure || attempt === 1) throw error;
        lastInfrastructureFailure = error;
      }
    }
    throw lastInfrastructureFailure;
  }, 90_000);
});
