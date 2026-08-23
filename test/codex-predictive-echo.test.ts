/**
 * @fileoverview Predictive-echo E2E against a real Codex TUI. The file shares
 * only a disposable Codeman server and Chromium process. Every semantic case
 * owns a fresh browser context/page, CODEX_HOME, workdir, Codex session, and
 * exact tmux pane so one failed case cannot poison another.
 *
 * CI-EXCLUDED (needs Chromium + the Codex binary); required release gate.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const ROOT = resolve(import.meta.dirname, '..');
const CODEX_BIN_DIR = `${userInfo().homedir}/.local/bin`;
const POLL_INTERVAL_MS = 25;
const READY_STABLE_MS = 300;

type ScenarioIdentity = { key: string; root: string; codexHome: string; workingDir: string };
type ReadinessSnapshot = {
  activeSessionId: string | null;
  expectedSessionId: string;
  wsReady: boolean;
  wsState: number;
  wsSessionId: string | null;
  wsUrl: string;
  reliableQueueSize: number;
  postQueueSize: number;
  pendingInputSize: number;
  terminalRenderQueueSize: number;
  terminalReady: boolean;
  paneAlive: boolean;
  cursorMatches: boolean;
  rowMatches: boolean;
  composerEmpty: boolean;
  predictorAnchorHeld: boolean;
};
type PaneState = { id: string; cursorX: number; cursorY: number; row: string; text: string };
type BrowserReadiness = Omit<ReadinessSnapshot, 'expectedSessionId' | 'paneAlive' | 'cursorMatches' | 'rowMatches'> & {
  cursorX: number;
  cursorY: number;
  cursorRow: string;
};
type Scenario = {
  id: string;
  muxName: string;
  paneId: string;
  page: Page;
  identity: ScenarioIdentity;
  capturePane: () => PaneState;
};
type ScenarioOptions = { trusted?: boolean; composer?: 'empty' | 'modal'; predictor?: 'active' | 'absent' };

function createScenarioIdentity(root: string, name: string, ordinal: number): ScenarioIdentity {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  const key = `${String(ordinal).padStart(2, '0')}-${slug || 'scenario'}`;
  const scenarioRoot = resolve(root, key);
  return {
    key,
    root: scenarioRoot,
    codexHome: resolve(scenarioRoot, 'codex-home'),
    workingDir: resolve(scenarioRoot, 'work'),
  };
}

function readinessFailures(snapshot: ReadinessSnapshot): string[] {
  const failures: string[] = [];
  if (snapshot.activeSessionId !== snapshot.expectedSessionId) failures.push('active-session');
  if (!snapshot.wsReady || snapshot.wsState !== 1) failures.push('socket-open');
  if (snapshot.wsSessionId !== snapshot.expectedSessionId) failures.push('socket-session');
  if (!snapshot.wsUrl.includes(`/ws/sessions/${snapshot.expectedSessionId}/terminal`)) failures.push('socket-url');
  if (snapshot.reliableQueueSize !== 0) failures.push('reliable-queue');
  if (snapshot.postQueueSize !== 0) failures.push('post-queue');
  if (snapshot.pendingInputSize !== 0) failures.push('input-queue');
  if (snapshot.terminalRenderQueueSize !== 0) failures.push('terminal-render-queue');
  if (!snapshot.terminalReady) failures.push('terminal');
  if (!snapshot.paneAlive) failures.push('pane');
  if (!snapshot.cursorMatches) failures.push('cursor');
  if (!snapshot.rowMatches) failures.push('row');
  if (!snapshot.composerEmpty) failures.push('composer');
  if (snapshot.predictorAnchorHeld) failures.push('predictor-anchor');
  return failures;
}

async function runIsolatedLifecycle<T>(
  setup: (defer: (label: string, cleanup: () => Promise<void>) => void) => Promise<T>,
  body: (resource: T) => Promise<void>
): Promise<void> {
  const cleanups: Array<{ label: string; run: () => Promise<void> }> = [];
  let primaryError: unknown;
  try {
    const resource = await setup((label, cleanup) => cleanups.push({ label, run: cleanup }));
    await body(resource);
  } catch (error) {
    primaryError = error;
  }
  const errors: unknown[] = primaryError === undefined ? [] : [primaryError];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup.run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(new Error(`${cleanup.label}: ${message}`, { cause: error }));
    }
  }
  if (errors.length > 1) throw new AggregateError(errors, 'scenario lifecycle failed');
  if (errors.length === 1) throw errors[0];
}

describe('COD-369 isolated scenario fixture contracts', () => {
  it('allocates unique filesystem identities for every scenario', () => {
    const first = createScenarioIdentity('/tmp/lab', 'basic typing', 1);
    const second = createScenarioIdentity('/tmp/lab', 'basic typing', 2);
    expect(first.key).not.toBe(second.key);
    expect(first.codexHome).not.toBe(second.codexHome);
    expect(first.workingDir).not.toBe(second.workingDir);
  });

  it('unwinds resources registered before partial setup failure', async () => {
    const events: string[] = [];
    await expect(
      runIsolatedLifecycle(
        async (defer) => {
          defer('context', async () => void events.push('close-context'));
          throw new Error('page setup failed');
        },
        async () => void events.push('body')
      )
    ).rejects.toThrow('page setup failed');
    expect(events).toEqual(['close-context']);
  });

  it('cleans every resource after the scenario body fails', async () => {
    const events: string[] = [];
    await expect(
      runIsolatedLifecycle(
        async (defer) => {
          defer('directory', async () => void events.push('remove-directory'));
          defer('session', async () => void events.push('delete-session'));
          return 'ready';
        },
        async () => {
          events.push('body');
          throw new Error('assertion failed');
        }
      )
    ).rejects.toThrow('assertion failed');
    expect(events).toEqual(['body', 'delete-session', 'remove-directory']);
  });

  it('preserves body and cleanup failures in an AggregateError', async () => {
    const failure = await runIsolatedLifecycle(
      async (defer) => {
        defer('context', async () => {
          throw new Error('context close failed');
        });
        defer('session', async () => {
          throw new Error('session delete failed');
        });
        return 'ready';
      },
      async () => {
        throw new Error('body failed');
      }
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      'body failed',
      'session: session delete failed',
      'context: context close failed',
    ]);
  });

  it.each([
    ['session', { activeSessionId: 'other' }],
    ['socket session', { wsSessionId: 'other' }],
    ['socket URL', { wsUrl: 'ws://localhost/ws/sessions/other/terminal' }],
    ['reliable queue', { reliableQueueSize: 1 }],
    ['post queue', { postQueueSize: 1 }],
    ['input queue', { pendingInputSize: 1 }],
    ['terminal queue', { terminalRenderQueueSize: 1 }],
    ['pane', { paneAlive: false }],
    ['cursor', { cursorMatches: false }],
    ['row', { rowMatches: false }],
    ['composer', { composerEmpty: false }],
    ['predictor anchor', { predictorAnchorHeld: true }],
  ])('rejects readiness when the %s predicate is wrong', (_label, override) => {
    const sessionId = '12345678-1234-1234-1234-123456789abc';
    const ready: ReadinessSnapshot = {
      activeSessionId: sessionId,
      expectedSessionId: sessionId,
      wsReady: true,
      wsState: 1,
      wsSessionId: sessionId,
      wsUrl: `ws://localhost/ws/sessions/${sessionId}/terminal`,
      reliableQueueSize: 0,
      postQueueSize: 0,
      pendingInputSize: 0,
      terminalRenderQueueSize: 0,
      terminalReady: true,
      paneAlive: true,
      cursorMatches: true,
      rowMatches: true,
      composerEmpty: true,
      predictorAnchorHeld: false,
      ...override,
    };
    expect(readinessFailures(ready)).not.toEqual([]);
  });
});

let labRoot = '';
let dataDir = '';
let port = 0;
let baseUrl = '';
let socketName = '';
let server: ChildProcess | null = null;
let browser: Browser | null = null;
let scenarioOrdinal = 0;
let serverLog = '';
const liveContexts = new Set<BrowserContext>();
const liveSessions = new Set<string>();
const liveScenarioDirs = new Set<string>();

function hasCodex(): boolean {
  try {
    execFileSync('codex', ['--version'], {
      env: { ...process.env, PATH: `${CODEX_BIN_DIR}:${process.env.PATH ?? ''}` },
      stdio: 'pipe',
    });
    return true;
  } catch (error) {
    console.error('[codex-e2e] codex unavailable:', (error as Error).message.slice(0, 300));
    return false;
  }
}

function tmux(args: string[], options: { ignoreError?: boolean } = {}): string {
  try {
    return execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (options.ignoreError) return '';
    throw error;
  }
}

function tmuxSocketPath(name: string): string {
  const socketRoot = process.env.TMUX_TMPDIR ?? '/tmp';
  return resolve(socketRoot, `tmux-${userInfo().uid}`, name);
}

function muxExists(muxName: string): boolean {
  try {
    execFileSync('tmux', ['-L', socketName, 'has-session', '-t', muxName], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolvePaneId(muxName: string): string | null {
  if (!muxExists(muxName)) return null;
  return tmux(['list-panes', '-t', muxName, '-F', '#{pane_id}']).trim().split('\n').filter(Boolean)[0] ?? null;
}

function capturePaneState(paneId: string): PaneState {
  const values = tmux(['display-message', '-p', '-t', paneId, '#{pane_id}\t#{cursor_x}\t#{cursor_y}'])
    .trim()
    .split('\t');
  const text = tmux(['capture-pane', '-p', '-t', paneId]).replace(/\r/g, '');
  const cursorY = Number(values[2]);
  return {
    id: values[0],
    cursorX: Number(values[1]),
    cursorY,
    row: (text.split('\n')[cursorY] ?? '').trimEnd(),
    text,
  };
}

async function waitUntil<T>(
  description: string,
  check: () => Promise<T | null | false> | T | null | false,
  timeoutMs: number
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value !== null && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
  }
  throw new Error(`timed out waiting for ${description}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      if (!address || typeof address === 'string') {
        listener.close();
        reject(new Error('failed to allocate dynamic port'));
        return;
      }
      const selected = address.port;
      listener.close((error) => (error ? reject(error) : resolvePort(selected)));
    });
  });
}

async function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: response.status, json };
}

async function createCodexSession(identity: ScenarioIdentity): Promise<string> {
  const response = await request('POST', '/api/sessions', {
    mode: 'codex',
    workingDir: identity.workingDir,
    envOverrides: { CODEX_HOME: identity.codexHome },
  });
  expect(response.status, JSON.stringify(response.json).slice(0, 500)).toBe(200);
  const envelope = response.json as { data?: unknown };
  const payload = (envelope.data ?? response.json) as {
    session?: { id?: string };
    id?: string;
    sessionId?: string;
  };
  const id = payload.session?.id ?? payload.id ?? payload.sessionId;
  expect(id, JSON.stringify(response.json).slice(0, 500)).toBeTruthy();
  return id!;
}

async function browserReadiness(page: Page, sessionId: string, composer: 'empty' | 'modal'): Promise<BrowserReadiness> {
  return page.evaluate(
    ({ expectedId, expectedComposer }) => {
      const app = (window as unknown as { app: Record<string, any> }).app;
      const terminal = app?.terminal;
      const buffer = terminal?.buffer?.active;
      const cursorRow = buffer?.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) ?? '';
      let modalPresent = false;
      for (let y = 0; buffer && y < terminal.rows; y++) {
        const row = buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '';
        if (row.includes('Press enter to continue')) modalPresent = true;
      }
      const terminalRenderQueueSize =
        (app?.pendingWrites?.length ?? 0) +
        (app?._loadBufferQueue?.length ?? 0) +
        (app?.writeFrameScheduled ? 1 : 0) +
        (app?._terminalRepaintScheduled ? 1 : 0) +
        (app?.flickerFilterActive || app?.flickerFilterBuffer ? 1 : 0);
      const composerEmpty =
        expectedComposer === 'modal'
          ? modalPresent
          : !!window.CodemanTerminalInput?.isCodexComposerRow?.(terminal) && buffer.cursorX <= 2;
      return {
        activeSessionId: app?.activeSessionId ?? null,
        wsReady: app?._wsReady === true,
        wsState: app?._ws?.readyState ?? -1,
        wsSessionId: app?._wsSessionId ?? null,
        wsUrl: app?._ws?.url ?? '',
        reliableQueueSize: app?._pendingDeliveries?.get(expectedId)?.length ?? 0,
        postQueueSize: app?._postDraining?.has(expectedId) ? 1 : 0,
        pendingInputSize: app?._pendingInput?.length ?? 0,
        terminalRenderQueueSize,
        terminalReady: !!(
          document.querySelector('#terminalContainer .xterm') &&
          terminal?.textarea &&
          buffer &&
          terminal?._core?._renderService &&
          app?._localEchoPolicy === 'predict'
        ),
        cursorX: buffer?.cursorX ?? -1,
        cursorY: buffer?.cursorY ?? -1,
        cursorRow: cursorRow.trimEnd(),
        composerEmpty,
        predictorAnchorHeld: app?._predictiveEcho?.debugState?.currentHoldMs != null,
      };
    },
    { expectedId: sessionId, expectedComposer: composer }
  );
}

async function waitForReadiness(
  page: Page,
  sessionId: string,
  paneId: string,
  composer: 'empty' | 'modal'
): Promise<void> {
  const deadline = Date.now() + 45_000;
  let stableSince = 0;
  let stableFingerprint = '';
  let lastFailures: string[] = ['not-observed'];
  while (Date.now() < deadline) {
    let pane: PaneState | null = null;
    try {
      pane = capturePaneState(paneId);
    } catch {
      pane = null;
    }
    const client = await browserReadiness(page, sessionId, composer);
    const snapshot: ReadinessSnapshot = {
      ...client,
      expectedSessionId: sessionId,
      paneAlive: pane?.id === paneId,
      cursorMatches: !!pane && client.cursorX === pane.cursorX && client.cursorY === pane.cursorY,
      rowMatches: !!pane && client.cursorRow === pane.row,
    };
    lastFailures = readinessFailures(snapshot);
    const fingerprint = JSON.stringify(snapshot);
    if (lastFailures.length === 0) {
      if (fingerprint !== stableFingerprint) {
        stableFingerprint = fingerprint;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= READY_STABLE_MS) {
        return;
      }
    } else {
      stableFingerprint = '';
      stableSince = 0;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
  }
  throw new Error(`readiness never stabilized for ${sessionId.slice(0, 8)}: ${lastFailures.join(', ')}`);
}

async function cleanupScenario(
  context: BrowserContext | null,
  sessionId: string | null,
  muxName: string | null,
  identity: ScenarioIdentity
): Promise<void> {
  const errors: Error[] = [];
  const attempt = async (label: string, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  };
  if (context) {
    await attempt('close browser context', async () => {
      await context.close();
      liveContexts.delete(context);
    });
  }
  if (sessionId) {
    await attempt('delete session', async () => {
      const deleted = await request('DELETE', `/api/sessions/${sessionId}`);
      if (deleted.status !== 200 && deleted.status !== 404) throw new Error(`unexpected status ${deleted.status}`);
    });
    await attempt('verify session 404', async () => {
      await waitUntil(
        `session ${sessionId!.slice(0, 8)} to return 404`,
        async () => ((await request('GET', `/api/sessions/${sessionId}`)).status === 404 ? true : false),
        10_000
      );
      liveSessions.delete(sessionId!);
    });
  }
  if (muxName) {
    await attempt('verify tmux target absent', async () => {
      await waitUntil(`tmux target ${muxName} to disappear`, () => (!muxExists(muxName!) ? true : false), 10_000);
    });
  }
  await attempt('remove scenario directory', async () => {
    rmSync(identity.root, { recursive: true, force: true });
    if (existsSync(identity.root)) throw new Error(`${identity.root} still exists`);
    liveScenarioDirs.delete(identity.root);
  });
  if (errors.length) throw new AggregateError(errors, `cleanup failed for ${identity.key}`);
}

async function withCodexScenario(
  name: string,
  options: ScenarioOptions,
  body: (scenario: Scenario) => Promise<void>
): Promise<void> {
  expect(liveSessions.size, 'a prior scenario session is still live').toBe(0);
  const identity = createScenarioIdentity(labRoot, name, ++scenarioOrdinal);
  let context: BrowserContext | null = null;
  let sessionId: string | null = null;
  let muxName: string | null = null;
  await runIsolatedLifecycle(async (defer) => {
    liveScenarioDirs.add(identity.root);
    defer('scenario cleanup', async () => cleanupScenario(context, sessionId, muxName, identity));
    mkdirSync(identity.codexHome, { recursive: true });
    mkdirSync(identity.workingDir, { recursive: true });
    writeFileSync(resolve(identity.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-123' }));
    const config = options.trusted === false ? '' : `[projects."${identity.workingDir}"]\ntrust_level = "trusted"\n`;
    writeFileSync(resolve(identity.codexHome, 'config.toml'), config);

    context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
    liveContexts.add(context);
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('codeman-app-settings', JSON.stringify({ localEchoEnabled: true }));
    });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, { timeout: 15_000 });

    sessionId = await createCodexSession(identity);
    liveSessions.add(sessionId);
    muxName = `codeman-${sessionId.slice(0, 8)}`;
    const started = await request('POST', `/api/sessions/${sessionId}/interactive`);
    expect(started.status, JSON.stringify(started.json).slice(0, 500)).toBe(200);
    const paneId = await waitUntil(
      `tmux pane for ${muxName}`,
      async () => {
        const pane = resolvePaneId(muxName!);
        if (pane) return pane;
        const detail = await request('GET', `/api/sessions/${sessionId}`);
        throw new Error(
          `session=${JSON.stringify(detail.json).slice(0, 1200)} tmux=${JSON.stringify(
            tmux(['list-sessions'], { ignoreError: true })
          )} server=${serverLog.slice(-3000)}`
        );
      },
      20_000
    );
    await page.evaluate(
      (id) => (window as unknown as { app: { selectSession: (sid: string) => unknown } }).app.selectSession(id),
      sessionId
    );
    await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
    await waitForReadiness(page, sessionId, paneId, options.composer ?? 'empty');
    if (options.predictor === 'absent') {
      await page.evaluate(() => {
        (window as unknown as { app: Record<string, unknown> }).app._predictiveEcho = null;
      });
    }
    return {
      id: sessionId,
      muxName,
      paneId,
      page,
      identity,
      capturePane: () => capturePaneState(paneId),
    } satisfies Scenario;
  }, body);
}

async function predictState(
  page: Page
): Promise<{ outstanding: number; confirmedTotal: number; droppedTotal: number }> {
  return page.evaluate(() => (window as unknown as { app: Record<string, any> }).app._predictiveEcho.state);
}

async function spanCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length);
}

async function waitForPaneText(scenario: Scenario, text: string, timeoutMs = 10_000): Promise<string> {
  return waitUntil(
    `tmux pane to contain ${JSON.stringify(text)}`,
    () => {
      const pane = scenario.capturePane().text;
      return pane.includes(text) ? pane : false;
    },
    timeoutMs
  );
}

async function waitForPaneMatch(scenario: Scenario, pattern: RegExp, timeoutMs = 10_000): Promise<string> {
  return waitUntil(
    `tmux pane to match ${pattern}`,
    () => {
      const pane = scenario.capturePane().text;
      return pattern.test(pane) ? pane : false;
    },
    timeoutMs
  );
}

async function installInputTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      app: Record<string, any>;
      __cod369Trace?: string[];
      __cod369OriginalSend?: (sessionId: string, data: string, options?: unknown) => unknown;
    };
    const app = browserWindow.app;
    browserWindow.__cod369Trace = [];
    browserWindow.__cod369OriginalSend = app._sendInputAsync.bind(app);
    app._sendInputAsync = (sessionId: string, data: string, options?: unknown) => {
      browserWindow.__cod369Trace!.push(data);
      return browserWindow.__cod369OriginalSend!(sessionId, data, options);
    };
  });
}

async function readInputTrace(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __cod369Trace?: string[] }).__cod369Trace?.join('') ?? '');
}

async function runByteIdentityScript(page: Page): Promise<void> {
  await page.keyboard.type('ab', { delay: 60 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('c', { delay: 60 });
  await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.terminal.paste('PQ'));
  await page.keyboard.press('End');
  await page.keyboard.press('Control+u');
  await page.waitForFunction(() => {
    const app = (window as unknown as { app: Record<string, any> }).app;
    return !app._pendingInput && (app._pendingDeliveries.get(app.activeSessionId)?.length ?? 0) === 0;
  });
  await waitForNoSpans(page);
}

async function waitForNoSpans(page: Page, timeoutMs = 15_000): Promise<void> {
  await page.waitForFunction(
    () => document.querySelectorAll('.xterm-screen [data-predictive-echo] span').length === 0,
    undefined,
    { timeout: timeoutMs }
  );
}

async function waitForServerExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit();
    };
    child.once('exit', onExit);
  });
}

async function verifyPortReleased(portNumber: number): Promise<void> {
  await waitUntil(
    `port ${portNumber} to be bindable`,
    () =>
      new Promise<true | false>((resolveReleased) => {
        const listener = createServer();
        listener.once('error', () => resolveReleased(false));
        listener.listen(portNumber, '127.0.0.1', () =>
          listener.close((error) => resolveReleased(error ? false : true))
        );
      }),
    5_000
  );
}

const CODEX_AVAILABLE = !process.env.COD369_CONTRACT_ONLY && hasCodex();
const realDescribe = CODEX_AVAILABLE ? describe : describe.skip;

realDescribe('codex predictive echo E2E (real codex TUI)', () => {
  beforeAll(async () => {
    mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
    labRoot = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-isolated-'));
    dataDir = resolve(labRoot, 'data');
    mkdirSync(dataDir, { recursive: true });
    port = await allocatePort();
    baseUrl = `http://127.0.0.1:${port}`;
    socketName = `codeman-cod369-${process.pid}-${Date.now().toString(36)}`;
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.VITEST;
    delete env.VITEST_MODE;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    delete env.NODE_ENV;
    env.CODEMAN_INSTANCE = `cod369-${process.pid}`;
    env.CODEMAN_DATA_DIR = dataDir;
    env.CODEMAN_TMUX_SOCKET = socketName;
    env.PATH = `${CODEX_BIN_DIR}:${env.PATH ?? ''}`;
    server = spawn(
      process.execPath,
      [
        resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'),
        'src/index.ts',
        'web',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: ROOT,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      }
    );
    const appendLog = (chunk: Buffer) => {
      serverLog = `${serverLog}${chunk.toString()}`.slice(-20_000);
    };
    server.stdout?.on('data', appendLog);
    server.stderr?.on('data', appendLog);
    await waitUntil(
      'disposable Codeman server readiness',
      async () => {
        if (!server || server.exitCode !== null || server.signalCode !== null) {
          throw new Error(`lab server exited early\n${serverLog}`);
        }
        try {
          return (await fetch(`${baseUrl}/api/status`)).ok ? true : false;
        } catch {
          return false;
        }
      },
      30_000
    );
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    const errors: Error[] = [];
    const backstop = async (label: string, operation: () => Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };
    for (const context of [...liveContexts]) {
      await backstop('close leaked context', async () => context.close());
      liveContexts.delete(context);
    }
    for (const id of [...liveSessions]) {
      await backstop(`delete leaked session ${id}`, async () => {
        await request('DELETE', `/api/sessions/${id}`);
        await waitUntil(
          `leaked session ${id.slice(0, 8)} to return 404`,
          async () => ((await request('GET', `/api/sessions/${id}`)).status === 404 ? true : false),
          10_000
        );
        const muxName = `codeman-${id.slice(0, 8)}`;
        await waitUntil(
          `leaked tmux target ${muxName} to disappear`,
          () => (!muxExists(muxName) ? true : false),
          10_000
        );
      });
      liveSessions.delete(id);
    }
    if (browser) await backstop('close Chromium', async () => browser!.close());
    browser = null;
    if (server) {
      const exactServer = server;
      exactServer.kill('SIGTERM');
      await backstop('terminate lab server', async () => {
        try {
          await waitForServerExit(exactServer, 5_000);
        } catch {
          exactServer.kill('SIGKILL');
          await waitForServerExit(exactServer, 5_000);
        }
        exactServer.stdout?.removeAllListeners();
        exactServer.stderr?.removeAllListeners();
        exactServer.removeAllListeners();
      });
      server = null;
    }
    if (port) await backstop('verify dynamic port released', async () => verifyPortReleased(port));
    if (socketName) {
      await backstop('stop disposable tmux socket', async () => {
        tmux(['kill-server'], { ignoreError: true });
        if (tmux(['list-sessions'], { ignoreError: true }).trim())
          throw new Error('tmux sessions survived kill-server');
        const exactSocketPath = tmuxSocketPath(socketName);
        rmSync(exactSocketPath, { force: true });
        if (existsSync(exactSocketPath)) throw new Error(`${exactSocketPath} survived teardown`);
      });
    }
    for (const directory of [...liveScenarioDirs]) {
      await backstop(`remove leaked fixture ${directory}`, async () => {
        rmSync(directory, { recursive: true, force: true });
      });
      liveScenarioDirs.delete(directory);
    }
    if (labRoot) {
      await backstop('remove lab root', async () => {
        rmSync(labRoot, { recursive: true, force: true });
        if (existsSync(labRoot)) throw new Error(`${labRoot} still exists`);
      });
    }
    if (errors.length) throw new AggregateError(errors, `COD-369 file teardown failed\n${serverLog}`);
  }, 30_000);

  it('bundle smoke and basic typing converge in one isolated scenario', async () => {
    await withCodexScenario('basic typing', {}, async (scenario) => {
      const { page } = scenario;
      const globals = await page.evaluate(() => ({
        zerolag: typeof window.LocalEchoOverlay,
        predictive: typeof window.PredictiveEchoOverlay,
        instance: !!(window as unknown as { app: Record<string, unknown> }).app._predictiveEcho,
      }));
      expect(globals.zerolag).toBe('function');
      expect(globals.predictive).toBe('function');
      expect(globals.instance).toBe(true);
      await page.keyboard.type('hello', { delay: 30 });
      await page.waitForFunction(() => {
        const state = (window as unknown as { app: Record<string, any> }).app._predictiveEcho.state;
        return state.confirmedTotal + state.outstanding >= 3;
      });
      await waitForNoSpans(page);
      const state = await predictState(page);
      expect(state.confirmedTotal).toBeGreaterThanOrEqual(3);
      expect(state.droppedTotal).toBe(0);
      expect(await waitForPaneText(scenario, 'hello')).toContain('hello');
    });
  }, 60_000);

  it('#222: slash picker filters live while predictions confirm away', async () => {
    await withCodexScenario('slash picker', {}, async (scenario) => {
      const { page } = scenario;
      await page.keyboard.type('/', { delay: 30 });
      expect(await waitForPaneMatch(scenario, /\/model|\/skills|\/init/)).toMatch(/\/model|\/skills|\/init/);
      await page.keyboard.type('mo', { delay: 40 });
      await waitForNoSpans(page);
      expect(scenario.capturePane().text).toContain('/model');
      const state = await predictState(page);
      expect(state.outstanding).toBe(0);
      expect(state.droppedTotal).toBe(0);
    });
  }, 60_000);

  it('#219: typed text and paste land in order with nothing dropped', async () => {
    await withCodexScenario('typed text and paste', {}, async (scenario) => {
      const { page } = scenario;
      await installInputTrace(page);
      await page.keyboard.type('abc', { delay: 30 });
      await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.terminal.paste('XYZ'));
      expect(await waitForPaneText(scenario, 'abcXYZ', 15_000)).toContain('abcXYZ');
      expect(await spanCount(page)).toBe(0);
      expect(await readInputTrace(page)).toContain('abcXYZ');
    });
  }, 60_000);

  it('#220: wrapped input renders exactly without ghost glyphs past the edge', async () => {
    await withCodexScenario('wrapped input', {}, async (scenario) => {
      const { page } = scenario;
      const long = 'the quick brown fox jumps over the lazy dog and keeps running until the composer has to wrap';
      await page.keyboard.type(long, { delay: 5 });
      await waitForNoSpans(page);
      const pane = await waitForPaneText(scenario, 'composer has to wrap', 15_000);
      expect(pane.replace(/\s+/g, ' ')).toContain('composer has to wrap');
      // Predictions on the first composer row may drop when Codex advances to
      // continuation rows; the required invariant is complete convergence.
      expect(await predictState(page)).toMatchObject({ outstanding: 0 });
    });
  }, 60_000);

  it('modal ghost eliminator keeps zero spans on the trust dialog', async () => {
    await withCodexScenario('untrusted modal', { trusted: false, composer: 'modal' }, async (scenario) => {
      const { page } = scenario;
      expect(scenario.capturePane().text).toContain('Press enter to continue');
      await page.keyboard.type('x', { delay: 30 });
      expect(await spanCount(page)).toBe(0);
      expect((await predictState(page)).outstanding).toBe(0);
    });
  }, 60_000);

  it('kill switch clears spans while typing continues to stream', async () => {
    await withCodexScenario('kill switch', {}, async (scenario) => {
      const { page } = scenario;
      await page.evaluate(() => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        const settings = app.loadAppSettingsFromStorage();
        settings.localEchoEnabled = false;
        app.saveAppSettingsToStorage(settings);
        app._updateLocalEchoState();
      });
      expect(await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app._localEchoPolicy)).toBe(
        'off'
      );
      expect(await spanCount(page)).toBe(0);
      await page.keyboard.type('still-live', { delay: 20 });
      expect(await waitForPaneText(scenario, 'still-live')).toContain('still-live');
      expect(await spanCount(page)).toBe(0);
    });
  }, 60_000);

  it('byte identity is exact in two sequential isolated scenarios', async () => {
    let withPredictor = '';
    let withoutPredictor = '';
    await withCodexScenario('byte identity predictor active', {}, async ({ page }) => {
      await installInputTrace(page);
      await runByteIdentityScript(page);
      withPredictor = await readInputTrace(page);
      expect(await spanCount(page)).toBe(0);
      expect(await predictState(page)).toMatchObject({ outstanding: 0, droppedTotal: 0 });
    });
    await withCodexScenario('byte identity predictor absent', { predictor: 'absent' }, async ({ page }) => {
      await installInputTrace(page);
      await runByteIdentityScript(page);
      withoutPredictor = await readInputTrace(page);
      expect(await spanCount(page)).toBe(0);
    });
    expect(withPredictor.length).toBeGreaterThan(0);
    expect(withoutPredictor).toBe(withPredictor);
  }, 120_000);

  it('#218: arrows and mid-word insert submit the exact edited text', async () => {
    await withCodexScenario('mid word edit', {}, async (scenario) => {
      const { page } = scenario;
      await page.keyboard.type('hello', { delay: 30 });
      await waitForPaneText(scenario, 'hello');
      await page.keyboard.press('ArrowLeft');
      expect(await predictState(page)).toMatchObject({ outstanding: 0 });
      expect(await spanCount(page)).toBe(0);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('X', { delay: 30 });
      await page.keyboard.press('Enter');
      expect(await waitForPaneText(scenario, 'helXlo', 15_000)).toContain('helXlo');
      expect(await spanCount(page)).toBe(0);
    });
  }, 60_000);

  it('simulated 300ms RTT gives instant exact spans and converges', async () => {
    await withCodexScenario('simulated RTT', {}, async (scenario) => {
      const { page } = scenario;
      await page.evaluate(() => {
        const browserWindow = window as unknown as {
          app: Record<string, any>;
          __cod369OriginalWrite?: (data: unknown, callback?: () => void) => unknown;
        };
        const app = browserWindow.app;
        browserWindow.__cod369OriginalWrite = app.terminal.write.bind(app.terminal);
        app.terminal.write = (data: unknown, callback?: () => void) =>
          setTimeout(() => browserWindow.__cod369OriginalWrite!(data, callback), 300);
      });
      const base = await predictState(page);
      await page.keyboard.press('h');
      const snap = await page.evaluate(() => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        const span = document.querySelector('.xterm-screen [data-predictive-echo] span') as HTMLElement | null;
        const screen = document.querySelector('.xterm-screen') as HTMLElement;
        const cell = app.terminal._core._renderService.dimensions.css.cell;
        const buffer = app.terminal.buffer.active;
        return span
          ? {
              outstanding: app._predictiveEcho.state.outstanding,
              spanLeft: span.getBoundingClientRect().left - screen.getBoundingClientRect().left,
              spanTop: span.getBoundingClientRect().top - screen.getBoundingClientRect().top,
              expectedLeft: buffer.cursorX * cell.width,
              expectedTop: buffer.cursorY * cell.height,
              text: span.textContent,
            }
          : null;
      });
      expect(snap).not.toBeNull();
      expect(snap!.outstanding).toBe(1);
      expect(snap!.text).toBe('h');
      expect(Math.abs(snap!.spanLeft - snap!.expectedLeft)).toBeLessThan(1.5);
      expect(Math.abs(snap!.spanTop - snap!.expectedTop)).toBeLessThan(1.5);

      await page.keyboard.type('igh rtt', { delay: 40 });
      await waitForNoSpans(page);
      expect(await waitForPaneText(scenario, 'high rtt')).toContain('high rtt');
      const after = await predictState(page);
      expect(after.confirmedTotal - base.confirmedTotal).toBeGreaterThanOrEqual(6);
      expect(after.droppedTotal - base.droppedTotal).toBe(0);

      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('Z', { delay: 40 });
      await page.keyboard.press('Enter');
      expect(await waitForPaneText(scenario, 'high rtZt', 15_000)).toContain('high rtZt');
      expect(await spanCount(page)).toBe(0);
    });
  }, 90_000);
});
