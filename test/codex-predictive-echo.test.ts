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
const SCENARIO_SETUP_TIMEOUT_MS = 60_000;
const SCENARIO_CLEANUP_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_HEADROOM_MS = 5_000;
const FILE_BACKSTOP_TIMEOUT_MS = 35_000;

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
type TerminalInputModes = {
  applicationCursorKeysMode: boolean;
  bracketedPasteMode: boolean;
  insertMode: boolean;
};
type BrowserReadiness = Omit<ReadinessSnapshot, 'expectedSessionId' | 'paneAlive' | 'cursorMatches' | 'rowMatches'> & {
  cursorX: number;
  cursorY: number;
  cursorRow: string;
  inputModes: TerminalInputModes;
};
type Scenario = {
  id: string;
  muxName: string;
  paneId: string;
  page: Page;
  identity: ScenarioIdentity;
  inputModes: TerminalInputModes;
  capturePane: () => PaneState;
};
type ScenarioOptions = {
  trusted?: boolean;
  composer?: 'empty' | 'modal';
  predictor?: 'active' | 'absent';
  expectedInputModes?: TerminalInputModes;
};
type DurableInputEnvelope = {
  transport: 'ws' | 'http';
  data: string;
  clientId: string;
  seq: number;
};
type InputTrace = { logical: string[]; durable: DurableInputEnvelope[] };

class PortCollisionError extends Error {}

type LedgerResource = {
  key: string;
  context: BrowserContext | null;
  sessionId: string | null;
  muxName: string | null;
  identity: ScenarioIdentity;
};

class ScenarioResourceLedger {
  readonly entries = new Set<LedgerResource>();
  tainted = false;

  assertCanStart(): void {
    if (this.tainted) throw new Error('COD-369 lab is tainted; file-level backstop cleanup is required');
    if (this.entries.size > 0) throw new Error('a prior scenario resource is still live');
  }

  begin(resource: LedgerResource): void {
    this.assertCanStart();
    this.entries.add(resource);
  }

  finish(resource: LedgerResource, errors: unknown[], backstop = false): void {
    if (errors.length > 0) {
      this.tainted = true;
      return;
    }
    if (this.tainted && !backstop) return;
    this.entries.delete(resource);
    if (backstop && this.entries.size === 0) this.tainted = false;
  }
}

function scenarioTestTimeout(fixtureCount: number, bodyTimeoutMs: number): number {
  if (!Number.isInteger(fixtureCount) || fixtureCount < 1) throw new Error('fixture count must be a positive integer');
  if (!Number.isFinite(bodyTimeoutMs) || bodyTimeoutMs < 0) throw new Error('body timeout must be non-negative');
  return (
    fixtureCount * (SCENARIO_SETUP_TIMEOUT_MS + SCENARIO_CLEANUP_TIMEOUT_MS) + bodyTimeoutMs + TEST_TIMEOUT_HEADROOM_MS
  );
}

function fileTeardownTimeout(): number {
  return SCENARIO_CLEANUP_TIMEOUT_MS + FILE_BACKSTOP_TIMEOUT_MS + TEST_TIMEOUT_HEADROOM_MS;
}

function expectedByteIdentityPayloads(modes: TerminalInputModes): string[] {
  const cursorPrefix = modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[';
  const paste = modes.bracketedPasteMode ? '\x1b[200~PQ\x1b[201~' : 'PQ';
  return ['a', 'b', '\x7f', `${cursorPrefix}D`, 'c', paste, `${cursorPrefix}F`, '\x15'];
}

function hasExactSessionSocketUrl(rawUrl: string, sessionId: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return (
      (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === `/ws/sessions/${encodeURIComponent(sessionId)}/terminal`
    );
  } catch {
    return false;
  }
}

async function waitForServerReadiness(
  probe: () => Promise<boolean>,
  exit: Promise<never>,
  timeoutMs: number
): Promise<void> {
  let stopped = false;
  const poll = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (!stopped && Date.now() < deadline) {
      if (await probe()) return;
      await Promise.race([new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS)), exit]);
    }
    if (!stopped) throw new Error(`server readiness timed out after ${timeoutMs}ms`);
  })();
  try {
    await Promise.race([poll, exit]);
  } finally {
    stopped = true;
  }
}

async function waitForOwnedServerReadiness(
  ownedListenMarker: Promise<void>,
  statusProbe: (remainingMs: number) => Promise<boolean>,
  exit: Promise<never>,
  childAlive: () => boolean,
  timeoutMs: number,
  stableMs = READY_STABLE_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await runBeforeDeadline(() => Promise.race([ownedListenMarker, exit]), timeoutMs);
  let stableSince = 0;
  await waitForServerReadiness(
    async () => {
      if (!childAlive()) throw new Error('spawned server child exited before stable readiness');
      if (!(await statusProbe(Math.max(1, deadline - Date.now())))) {
        stableSince = 0;
        return false;
      }
      if (stableSince === 0) stableSince = Date.now();
      return Date.now() - stableSince >= stableMs;
    },
    exit,
    Math.max(1, deadline - Date.now())
  );
}

function classifyLabServerExit(attemptLog: string, diagnostic: string): Error {
  return /EADDRINUSE|address already in use/i.test(attemptLog)
    ? new PortCollisionError(diagnostic)
    : new Error(diagnostic);
}

type ScenarioCleanupOperations = {
  closeContext: (resource: LedgerResource, timeoutMs: number) => Promise<void>;
  deleteSession: (resource: LedgerResource, timeoutMs: number) => Promise<void>;
  verifySessionAbsent: (resource: LedgerResource, timeoutMs: number) => Promise<void>;
  verifyMuxAbsent: (resource: LedgerResource, timeoutMs: number) => Promise<void>;
  removeDirectory: (resource: LedgerResource, timeoutMs: number) => Promise<void>;
  verifyDirectoryAbsent: (resource: LedgerResource, timeoutMs: number) => Promise<void>;
};

async function runBeforeDeadline<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) throw new Error('timed out');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cleanupLedgerResource(
  ledger: ScenarioResourceLedger,
  resource: LedgerResource,
  operations: ScenarioCleanupOperations,
  backstop = false,
  timeoutMs = SCENARIO_CLEANUP_TIMEOUT_MS
): Promise<void> {
  const errors: Error[] = [];
  const deadline = Date.now() + timeoutMs;
  const cleanupSteps: Array<[string, (resource: LedgerResource, timeoutMs: number) => Promise<void>]> = [
    ['close browser context', operations.closeContext],
    ['delete session', operations.deleteSession],
    ['verify session 404', operations.verifySessionAbsent],
    ['verify tmux target absent', operations.verifyMuxAbsent],
    ['remove scenario directory', operations.removeDirectory],
    ['verify scenario directory absent', operations.verifyDirectoryAbsent],
  ];
  const attempt = async (label: string, operation: () => Promise<void>, operationTimeoutMs: number) => {
    try {
      await runBeforeDeadline(operation, operationTimeoutMs);
    } catch (error) {
      errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  };
  for (const [index, [label, operation]] of cleanupSteps.entries()) {
    const remainingSteps = cleanupSteps.length - index;
    const remaining = Math.max(0, deadline - Date.now());
    const operationTimeoutMs = Math.max(1, Math.floor(remaining / remainingSteps));
    await attempt(label, () => operation(resource, operationTimeoutMs), operationTimeoutMs);
  }
  ledger.finish(resource, errors, backstop);
  if (errors.length > 0) throw new AggregateError(errors, `cleanup failed for ${resource.key}`);
}

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
  if (!hasExactSessionSocketUrl(snapshot.wsUrl, snapshot.expectedSessionId)) failures.push('socket-url');
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
  const appendCleanupError = (label: string, error: unknown): void => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) appendCleanupError(label, nested);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    errors.push(new Error(`${label}: ${message}`, { cause: error }));
  };
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup.run();
    } catch (error) {
      if (error instanceof AggregateError) {
        for (const nested of error.errors) errors.push(nested);
      } else {
        appendCleanupError(cleanup.label, error);
      }
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

  it('keeps the actual scenario ledger tainted until backstop cleanup proves every resource absent', async () => {
    const ledger = new ScenarioResourceLedger();
    const identity = createScenarioIdentity('/tmp/lab', 'failure path', 1);
    const resource: LedgerResource = {
      key: identity.key,
      context: null,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      muxName: 'codeman-12345678',
      identity,
    };
    ledger.begin(resource);
    const failingOperations: ScenarioCleanupOperations = {
      closeContext: async () => {
        throw new Error('context close failed');
      },
      deleteSession: async () => {},
      verifySessionAbsent: async () => {},
      verifyMuxAbsent: async () => {
        throw new Error('tmux survived');
      },
      removeDirectory: async () => {
        throw new Error('directory remove failed');
      },
      verifyDirectoryAbsent: async () => {
        throw new Error('directory survived');
      },
    };

    const failure = await runIsolatedLifecycle(
      async (defer) => {
        defer('scenario cleanup', async () => cleanupLedgerResource(ledger, resource, failingOperations));
        return resource;
      },
      async () => {
        throw new Error('body failed');
      }
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      'body failed',
      'close browser context: context close failed',
      'verify tmux target absent: tmux survived',
      'remove scenario directory: directory remove failed',
      'verify scenario directory absent: directory survived',
    ]);
    expect(ledger.tainted).toBe(true);
    expect(ledger.entries.has(resource)).toBe(true);
    expect(() => ledger.assertCanStart()).toThrow('lab is tainted');

    const successfulOperations = Object.fromEntries(
      Object.keys(failingOperations).map((key) => [key, async () => {}])
    ) as ScenarioCleanupOperations;
    await cleanupLedgerResource(ledger, resource, successfulOperations, true);
    expect(ledger.tainted).toBe(false);
    expect(ledger.entries.size).toBe(0);
    expect(() => ledger.assertCanStart()).not.toThrow();
  });

  it('bounds a hanging cleanup operation, continues later cleanup, and aggregates the timeout with later failures', async () => {
    const ledger = new ScenarioResourceLedger();
    const identity = createScenarioIdentity('/tmp/lab', 'cleanup deadline', 1);
    const resource: LedgerResource = {
      key: identity.key,
      context: null,
      sessionId: '12345678-1234-1234-1234-123456789abc',
      muxName: 'codeman-12345678',
      identity,
    };
    ledger.begin(resource);
    const events: string[] = [];
    const operations: ScenarioCleanupOperations = {
      closeContext: async () => new Promise<void>(() => {}),
      deleteSession: async () => void events.push('delete-session'),
      verifySessionAbsent: async () => {
        events.push('verify-session');
        throw new Error('404 proof failed');
      },
      verifyMuxAbsent: async () => void events.push('verify-mux'),
      removeDirectory: async () => void events.push('remove-directory'),
      verifyDirectoryAbsent: async () => void events.push('verify-directory'),
    };

    const startedAt = performance.now();
    const failure = await (
      cleanupLedgerResource as unknown as (
        ledger: ScenarioResourceLedger,
        resource: LedgerResource,
        operations: ScenarioCleanupOperations,
        backstop: boolean,
        timeoutMs: number
      ) => Promise<void>
    )(ledger, resource, operations, false, 120).catch((error: unknown) => error);

    expect(performance.now() - startedAt).toBeLessThan(400);
    expect(events).toEqual(['delete-session', 'verify-session', 'verify-mux', 'remove-directory', 'verify-directory']);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
      'close browser context: timed out',
      'verify session 404: 404 proof failed',
    ]);
    expect(ledger.tainted).toBe(true);
    expect(ledger.entries.has(resource)).toBe(true);
  }, 1_000);

  it('rejects child readiness immediately when the child exits', async () => {
    const startedAt = performance.now();
    await expect(
      waitForServerReadiness(async () => false, Promise.reject(new Error('child exited with code 1')), 30_000)
    ).rejects.toThrow('child exited with code 1');
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it('retries a dynamic port only for bounded address collisions', async () => {
    const allocated = [31001, 31002];
    const attempted: number[] = [];
    const selected = await retryPortCollision(
      async () => allocated.shift()!,
      async (candidate) => {
        attempted.push(candidate);
        if (candidate === 31001) {
          throw classifyLabServerExit(
            'listen EADDRINUSE: address already in use 127.0.0.1:31001',
            'listen EADDRINUSE: address already in use 127.0.0.1:31001'
          );
        }
        return candidate;
      },
      3
    );
    expect(selected).toBe(31002);
    expect(attempted).toEqual([31001, 31002]);
    await expect(
      retryPortCollision(
        async () => 31003,
        async () => {
          throw new Error('child exited for another reason');
        }
      )
    ).rejects.toThrow('another reason');
  });

  it('never accepts a foreign compatible status response before the exact spawned child owns the port', async () => {
    const allocated = [31011, 31012];
    const cleaned: number[] = [];
    const accepted: number[] = [];
    const probed: number[] = [];
    const selected = await retryPortCollision(
      async () => allocated.shift()!,
      async (candidate) => {
        let rejectExit!: (error: Error) => void;
        const exit = new Promise<never>((_resolve, reject) => {
          rejectExit = reject;
        });
        void exit.catch(() => {});
        const marker = candidate === 31011 ? new Promise<void>(() => {}) : Promise.resolve();
        if (candidate === 31011) {
          queueMicrotask(() =>
            rejectExit(
              classifyLabServerExit(
                'listen EADDRINUSE: foreign Codeman owns 31011',
                'listen EADDRINUSE: foreign Codeman owns 31011'
              )
            )
          );
        }
        try {
          await waitForOwnedServerReadiness(
            marker,
            async () => {
              probed.push(candidate);
              return true;
            },
            exit,
            () => candidate === 31012,
            500,
            20
          );
          accepted.push(candidate);
          return candidate;
        } catch (error) {
          cleaned.push(candidate);
          throw error;
        }
      }
    );

    expect(selected).toBe(31012);
    expect(cleaned).toEqual([31011]);
    expect(accepted).toEqual([31012]);
    expect(probed).not.toContain(31011);
    expect(probed).toContain(31012);
  });

  it('does not classify an unrelated second child exit from the first attempt cumulative collision log', async () => {
    const allocated = [31021, 31022, 31023];
    const attempted: number[] = [];
    const failure = await retryPortCollision(
      async () => allocated.shift()!,
      async (candidate) => {
        attempted.push(candidate);
        if (candidate === 31021) {
          throw classifyLabServerExit('listen EADDRINUSE: address already in use 31021', 'attempt1 EADDRINUSE');
        }
        throw classifyLabServerExit(
          'configuration failed on attempt2',
          'attempt1 EADDRINUSE\nconfiguration failed on attempt2'
        );
      }
    ).catch((error: unknown) => error);

    expect((failure as Error).message).toContain('configuration failed on attempt2');
    expect(attempted).toEqual([31021, 31022]);
  });

  it('passes the remaining readiness deadline to every status probe', async () => {
    const observedBudgets: number[] = [];
    let rejectExit!: (error: Error) => void;
    const exit = new Promise<never>((_resolve, reject) => {
      rejectExit = reject;
    });
    void exit.catch(() => {});
    setTimeout(() => rejectExit(new Error('child exited')), 20);

    await expect(
      waitForOwnedServerReadiness(
        Promise.resolve(),
        async (remainingMs) => {
          observedBudgets.push(remainingMs);
          return false;
        },
        exit,
        () => true,
        200,
        20
      )
    ).rejects.toThrow('child exited');
    expect(observedBudgets.length).toBeGreaterThan(0);
    expect(observedBudgets.every((budget) => budget > 0 && budget <= 200)).toBe(true);
  });

  it.each([
    ['prefix path', 'ws://localhost/prefix/ws/sessions/session-1/terminal'],
    ['suffix path', 'ws://localhost/ws/sessions/session-1/terminal/extra'],
    ['wrong session', 'ws://localhost/ws/sessions/session-2/terminal'],
    ['http protocol', 'http://localhost/ws/sessions/session-1/terminal'],
    ['credentials', 'ws://user@localhost/ws/sessions/session-1/terminal'],
  ])('rejects an inexact terminal socket URL with a %s', (_label, url) => {
    expect(hasExactSessionSocketUrl(url, 'session-1')).toBe(false);
  });

  it('accepts an exact ws or wss terminal socket URL with a query string', () => {
    expect(hasExactSessionSocketUrl('ws://localhost/ws/sessions/session-1/terminal?cid=abc', 'session-1')).toBe(true);
    expect(hasExactSessionSocketUrl('wss://codeman.test/ws/sessions/session-1/terminal', 'session-1')).toBe(true);
  });

  it('budgets setup and cleanup for every fixture plus explicit body time and headroom', () => {
    expect(scenarioTestTimeout(1, 20_000)).toBe(115_000);
    expect(scenarioTestTimeout(2, 20_000)).toBe(205_000);
    expect(() => scenarioTestTimeout(0, 20_000)).toThrow('fixture count');
    expect(() => scenarioTestTimeout(1, -1)).toThrow('body timeout');
  });

  it('leaves enforced headroom for one worst-case ledger cleanup and every file backstop', () => {
    expect(fileTeardownTimeout()).toBeGreaterThan(
      SCENARIO_CLEANUP_TIMEOUT_MS + 10_000 + 10_000 + 5_000 + TEST_TIMEOUT_HEADROOM_MS
    );
  });

  it('derives the complete exact-byte script from the stable terminal input modes', () => {
    expect(
      expectedByteIdentityPayloads({ applicationCursorKeysMode: false, bracketedPasteMode: false, insertMode: false })
    ).toEqual(['a', 'b', '\x7f', '\x1b[D', 'c', 'PQ', '\x1b[F', '\x15']);
    expect(
      expectedByteIdentityPayloads({ applicationCursorKeysMode: true, bracketedPasteMode: true, insertMode: false })
    ).toEqual(['a', 'b', '\x7f', '\x1bOD', 'c', '\x1b[200~PQ\x1b[201~', '\x1bOF', '\x15']);
  });

  it('deduplicates physical retransmissions by client and sequence without hiding payload conflicts', () => {
    const trace: InputTrace = {
      logical: ['a'],
      durable: [
        { transport: 'ws', data: 'a', clientId: 'client-1', seq: 7 },
        { transport: 'http', data: 'a', clientId: 'client-1', seq: 7 },
      ],
    };
    expect(durablePayloads(trace)).toEqual(['a']);
    expect(() =>
      durablePayloads({
        logical: ['a'],
        durable: [
          { transport: 'ws', data: 'a', clientId: 'client-1', seq: 7 },
          { transport: 'http', data: 'different', clientId: 'client-1', seq: 7 },
        ],
      })
    ).toThrow('conflicting payloads');
  });

  it.each([
    ['session', { activeSessionId: 'other' }],
    ['socket ready flag', { wsReady: false }],
    ['socket ready state', { wsState: 0 }],
    ['socket session', { wsSessionId: 'other' }],
    ['socket URL', { wsUrl: 'ws://localhost/ws/sessions/other/terminal' }],
    ['reliable queue', { reliableQueueSize: 1 }],
    ['post queue', { postQueueSize: 1 }],
    ['input queue', { pendingInputSize: 1 }],
    ['terminal queue', { terminalRenderQueueSize: 1 }],
    ['terminal initialization', { terminalReady: false }],
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
const scenarioLedger = new ScenarioResourceLedger();

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

function remainingTime(deadline: number, label: string, capMs = Number.POSITIVE_INFINITY): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} exceeded its internal deadline`);
  return Math.min(remaining, capMs);
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

async function retryPortCollision<T>(
  allocate: () => Promise<number>,
  attempt: (port: number) => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let lastCollision: unknown;
  for (let index = 0; index < maxAttempts; index++) {
    const candidate = await allocate();
    try {
      return await attempt(candidate);
    } catch (error) {
      if (!(error instanceof PortCollisionError)) throw error;
      lastCollision = error;
    }
  }
  throw new Error(`dynamic port collided ${maxAttempts} times`, { cause: lastCollision });
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

async function createCodexSession(identity: ScenarioIdentity, timeoutMs = 10_000): Promise<string> {
  const response = await request(
    'POST',
    '/api/sessions',
    {
      mode: 'codex',
      workingDir: identity.workingDir,
      envOverrides: { CODEX_HOME: identity.codexHome },
    },
    timeoutMs
  );
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
      const modes = terminal?.modes ?? {};
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
        inputModes: {
          applicationCursorKeysMode: !!modes.applicationCursorKeysMode,
          bracketedPasteMode: !!modes.bracketedPasteMode,
          insertMode: !!modes.insertMode,
        },
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
  composer: 'empty' | 'modal',
  expectedInputModes?: TerminalInputModes,
  timeoutMs = SCENARIO_SETUP_TIMEOUT_MS
): Promise<BrowserReadiness> {
  const deadline = Date.now() + timeoutMs;
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
    if (expectedInputModes && JSON.stringify(client.inputModes) !== JSON.stringify(expectedInputModes)) {
      lastFailures.push('input-modes');
    }
    const fingerprint = JSON.stringify(snapshot);
    if (lastFailures.length === 0) {
      if (fingerprint !== stableFingerprint) {
        stableFingerprint = fingerprint;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= READY_STABLE_MS) {
        return client;
      }
    } else {
      stableFingerprint = '';
      stableSince = 0;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, POLL_INTERVAL_MS));
  }
  throw new Error(`readiness never stabilized for ${sessionId.slice(0, 8)}: ${lastFailures.join(', ')}`);
}

function actualCleanupOperations(): ScenarioCleanupOperations {
  return {
    closeContext: async (resource) => {
      if (!resource.context) return;
      await resource.context.close();
      resource.context = null;
    },
    deleteSession: async (resource, timeoutMs) => {
      if (!resource.sessionId) return;
      const deleted = await request('DELETE', `/api/sessions/${resource.sessionId}`, undefined, timeoutMs);
      if (deleted.status !== 200 && deleted.status !== 404) throw new Error(`unexpected status ${deleted.status}`);
    },
    verifySessionAbsent: async (resource, timeoutMs) => {
      if (!resource.sessionId) return;
      const sessionId = resource.sessionId;
      await waitUntil(
        `session ${sessionId.slice(0, 8)} to return 404`,
        async () =>
          (await request('GET', `/api/sessions/${sessionId}`, undefined, Math.max(1, Math.min(timeoutMs, 2_000))))
            .status === 404
            ? true
            : false,
        timeoutMs
      );
      resource.sessionId = null;
    },
    verifyMuxAbsent: async (resource, timeoutMs) => {
      if (!resource.muxName) return;
      const muxName = resource.muxName;
      await waitUntil(`tmux target ${muxName} to disappear`, () => (!muxExists(muxName) ? true : false), timeoutMs);
      resource.muxName = null;
    },
    removeDirectory: async (resource) => {
      rmSync(resource.identity.root, { recursive: true, force: true });
    },
    verifyDirectoryAbsent: async (resource) => {
      if (existsSync(resource.identity.root)) throw new Error(`${resource.identity.root} still exists`);
    },
  };
}

async function withCodexScenario(
  name: string,
  options: ScenarioOptions,
  body: (scenario: Scenario) => Promise<void>
): Promise<void> {
  scenarioLedger.assertCanStart();
  const identity = createScenarioIdentity(labRoot, name, ++scenarioOrdinal);
  const resource: LedgerResource = {
    key: identity.key,
    context: null,
    sessionId: null,
    muxName: null,
    identity,
  };
  const setupDeadline = Date.now() + SCENARIO_SETUP_TIMEOUT_MS;
  await runIsolatedLifecycle(async (defer) => {
    scenarioLedger.begin(resource);
    defer('scenario cleanup', async () => cleanupLedgerResource(scenarioLedger, resource, actualCleanupOperations()));
    mkdirSync(identity.codexHome, { recursive: true });
    mkdirSync(identity.workingDir, { recursive: true });
    writeFileSync(resolve(identity.codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test-123' }));
    const config = options.trusted === false ? '' : `[projects."${identity.workingDir}"]\ntrust_level = "trusted"\n`;
    writeFileSync(resolve(identity.codexHome, 'config.toml'), config);

    resource.context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await resource.context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('codeman-app-settings', JSON.stringify({ localEchoEnabled: true }));
    });
    await page.goto(baseUrl, {
      waitUntil: 'domcontentloaded',
      timeout: remainingTime(setupDeadline, `${identity.key} page navigation`, 15_000),
    });
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'), undefined, {
      timeout: remainingTime(setupDeadline, `${identity.key} app load`, 15_000),
    });

    const sessionId = await createCodexSession(
      identity,
      remainingTime(setupDeadline, `${identity.key} session creation`, 10_000)
    );
    resource.sessionId = sessionId;
    const muxName = `codeman-${sessionId.slice(0, 8)}`;
    resource.muxName = muxName;
    const started = await request(
      'POST',
      `/api/sessions/${sessionId}/interactive`,
      undefined,
      remainingTime(setupDeadline, `${identity.key} interactive start`, 15_000)
    );
    expect(started.status, JSON.stringify(started.json).slice(0, 500)).toBe(200);
    const paneId = await waitUntil(
      `tmux pane for ${muxName}`,
      async () => {
        const pane = resolvePaneId(muxName);
        if (pane) return pane;
        const detail = await request(
          'GET',
          `/api/sessions/${sessionId}`,
          undefined,
          remainingTime(setupDeadline, `${identity.key} session detail`, 5_000)
        );
        throw new Error(
          `session=${JSON.stringify(detail.json).slice(0, 1200)} tmux=${JSON.stringify(
            tmux(['list-sessions'], { ignoreError: true })
          )} server=${serverLog.slice(-3000)}`
        );
      },
      remainingTime(setupDeadline, `${identity.key} tmux pane`, 20_000)
    );
    await page.evaluate(
      (id) => (window as unknown as { app: { selectSession: (sid: string) => unknown } }).app.selectSession(id),
      sessionId
    );
    await page.locator('#terminalContainer').click({ position: { x: 200, y: 200 } });
    const ready = await waitForReadiness(
      page,
      sessionId,
      paneId,
      options.composer ?? 'empty',
      options.expectedInputModes,
      remainingTime(setupDeadline, `${identity.key} readiness`)
    );
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
      inputModes: ready.inputModes,
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

function countSubmissionStateMarkers(text: string): number {
  return text.match(/Reconnecting|esc to interrupt|401|Unauthorized/gi)?.length ?? 0;
}

async function waitForSubmissionTransition(
  scenario: Scenario,
  beforeSubmit: PaneState,
  submittedText: string,
  timeoutMs: number
): Promise<void> {
  const markersBefore = countSubmissionStateMarkers(beforeSubmit.text);
  await waitUntil(
    `submission of ${JSON.stringify(submittedText)} to leave the composer or enter retry/error state`,
    async () => {
      const pane = scenario.capturePane();
      const changed =
        pane.text !== beforeSubmit.text ||
        pane.cursorX !== beforeSubmit.cursorX ||
        pane.cursorY !== beforeSubmit.cursorY;
      if (!changed || !pane.text.includes(submittedText)) return false;
      const client = await scenario.page.evaluate(() => {
        const app = (window as unknown as { app: Record<string, any> }).app;
        const terminal = app.terminal;
        const buffer = terminal.buffer.active;
        return {
          composerCleared: !!window.CodemanTerminalInput?.isCodexComposerRow?.(terminal) && buffer.cursorX <= 2,
        };
      });
      const enteredNewRetryState = countSubmissionStateMarkers(pane.text) > markersBefore;
      const promptTransitioned = pane.cursorY !== beforeSubmit.cursorY || pane.row !== beforeSubmit.row;
      return enteredNewRetryState || (client.composerCleared && promptTransitioned);
    },
    timeoutMs
  );
}

async function installInputTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    const browserWindow = window as unknown as {
      app: Record<string, any>;
      __cod369Trace?: InputTrace;
      __cod369OriginalSend?: (sessionId: string, data: string, options?: unknown) => unknown;
      __cod369OriginalWsSend?: (data: unknown) => void;
      __cod369OriginalFetch?: typeof window.fetch;
    };
    const app = browserWindow.app;
    browserWindow.__cod369Trace = { logical: [], durable: [] };
    browserWindow.__cod369OriginalSend = app._sendInputAsync.bind(app);
    app._sendInputAsync = (sessionId: string, data: string, options?: unknown) => {
      browserWindow.__cod369Trace!.logical.push(data);
      return browserWindow.__cod369OriginalSend!(sessionId, data, options);
    };
    const socket = app._ws as WebSocket;
    browserWindow.__cod369OriginalWsSend = socket.send.bind(socket);
    socket.send = ((raw: unknown) => {
      try {
        const envelope = JSON.parse(String(raw));
        if (
          envelope?.t === 'i' &&
          typeof envelope.d === 'string' &&
          typeof envelope.cid === 'string' &&
          Number.isInteger(envelope.seq)
        ) {
          browserWindow.__cod369Trace!.durable.push({
            transport: 'ws',
            data: envelope.d,
            clientId: envelope.cid,
            seq: envelope.seq,
          });
        }
      } catch {
        // Non-JSON frames are outside durable terminal input.
      }
      browserWindow.__cod369OriginalWsSend!(raw);
    }) as typeof socket.send;
    browserWindow.__cod369OriginalFetch = window.fetch.bind(window);
    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (/\/api\/sessions\/[^/]+\/input(?:\?|$)/.test(url) && typeof init?.body === 'string') {
          const envelope = JSON.parse(init.body);
          if (
            typeof envelope?.input === 'string' &&
            typeof envelope.clientId === 'string' &&
            Number.isInteger(envelope.seq)
          ) {
            browserWindow.__cod369Trace!.durable.push({
              transport: 'http',
              data: envelope.input,
              clientId: envelope.clientId,
              seq: envelope.seq,
            });
          }
        }
      } catch {
        // Trace instrumentation must not affect transport.
      }
      return browserWindow.__cod369OriginalFetch!(input, init);
    }) as typeof window.fetch;
  });
}

async function readInputTrace(page: Page): Promise<InputTrace> {
  return page.evaluate(() => {
    const trace = (window as unknown as { __cod369Trace?: InputTrace }).__cod369Trace;
    return trace ? { logical: [...trace.logical], durable: [...trace.durable] } : { logical: [], durable: [] };
  });
}

function durablePayloads(trace: InputTrace): string[] {
  const deliveries = new Map<string, string>();
  for (const entry of trace.durable) {
    const identity = `${entry.clientId}\0${entry.seq}`;
    const prior = deliveries.get(identity);
    if (prior !== undefined && prior !== entry.data) {
      throw new Error(`durable delivery ${entry.clientId}:${entry.seq} has conflicting payloads`);
    }
    if (prior === undefined) deliveries.set(identity, entry.data);
  }
  return [...deliveries.values()];
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

async function launchLabServer(candidatePort: number, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const candidateServer = spawn(
    process.execPath,
    [
      resolve(ROOT, 'node_modules/tsx/dist/cli.mjs'),
      'src/index.ts',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      String(candidatePort),
    ],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: false }
  );
  const ownedListenText = `Codeman web interface running at http://127.0.0.1:${candidatePort}`;
  let attemptLog = '';
  let resolveOwnedListen!: () => void;
  const ownedListenMarker = new Promise<void>((resolveMarker) => {
    resolveOwnedListen = resolveMarker;
  });
  const appendLog = (chunk: Buffer) => {
    const text = chunk.toString();
    attemptLog = `${attemptLog}${text}`.slice(-20_000);
    serverLog = `${serverLog}${text}`.slice(-20_000);
    if (attemptLog.includes(ownedListenText)) resolveOwnedListen();
  };
  candidateServer.stdout?.on('data', appendLog);
  candidateServer.stderr?.on('data', appendLog);
  let earlyExitReject!: (error: Error) => void;
  const onEarlyExit = (code: number | null, signal: NodeJS.Signals | null) => {
    earlyExitReject(
      classifyLabServerExit(
        attemptLog,
        `lab server exited before readiness code=${code ?? 'null'} signal=${signal ?? 'null'}\n${serverLog}`
      )
    );
  };
  const earlyExit = new Promise<never>((_resolve, reject) => {
    earlyExitReject = reject;
    candidateServer.once('exit', onEarlyExit);
  });
  if (candidateServer.exitCode !== null || candidateServer.signalCode !== null) {
    onEarlyExit(candidateServer.exitCode, candidateServer.signalCode);
  }
  try {
    await waitForOwnedServerReadiness(
      ownedListenMarker,
      async (remainingMs) => {
        try {
          return (
            await fetch(`http://127.0.0.1:${candidatePort}/api/status`, {
              signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs, 1_000))),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      earlyExit,
      () => candidateServer.exitCode === null && candidateServer.signalCode === null,
      30_000
    );
    return candidateServer;
  } catch (error) {
    candidateServer.kill('SIGTERM');
    try {
      await waitForServerExit(candidateServer, 1_000);
    } catch {
      candidateServer.kill('SIGKILL');
      await waitForServerExit(candidateServer, 1_000);
    }
    candidateServer.stdout?.removeListener('data', appendLog);
    candidateServer.stderr?.removeListener('data', appendLog);
    throw error;
  } finally {
    candidateServer.off('exit', onEarlyExit);
  }
}

const CODEX_AVAILABLE = !process.env.COD369_CONTRACT_ONLY && hasCodex();
const realDescribe = CODEX_AVAILABLE ? describe : describe.skip;

realDescribe('codex predictive echo E2E (real codex TUI)', () => {
  beforeAll(
    async () => {
      mkdirSync(resolve(ROOT, 'tmp'), { recursive: true });
      labRoot = mkdtempSync(resolve(ROOT, 'tmp', 'codexlab-isolated-'));
      dataDir = resolve(labRoot, 'data');
      mkdirSync(dataDir, { recursive: true });
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
      server = await retryPortCollision(allocatePort, async (candidatePort) => {
        const candidateServer = await launchLabServer(candidatePort, env as NodeJS.ProcessEnv);
        port = candidatePort;
        baseUrl = `http://127.0.0.1:${candidatePort}`;
        return candidateServer;
      });
      browser = await chromium.launch({ headless: true });
    },
    scenarioTestTimeout(1, 20_000)
  );

  afterAll(async () => {
    const errors: Error[] = [];
    const teardownDeadline = Date.now() + fileTeardownTimeout() - TEST_TIMEOUT_HEADROOM_MS;
    const backstop = async (label: string, operation: () => Promise<void>, capMs: number) => {
      try {
        await runBeforeDeadline(operation, remainingTime(teardownDeadline, label, capMs));
      } catch (error) {
        errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      }
    };
    for (const resource of [...scenarioLedger.entries]) {
      await backstop(
        `clean ledgered scenario ${resource.key}`,
        async () => cleanupLedgerResource(scenarioLedger, resource, actualCleanupOperations(), true),
        SCENARIO_CLEANUP_TIMEOUT_MS
      );
    }
    if (browser) await backstop('close Chromium', async () => browser!.close(), 10_000);
    browser = null;
    if (server) {
      const exactServer = server;
      exactServer.kill('SIGTERM');
      await backstop(
        'terminate lab server',
        async () => {
          try {
            await waitForServerExit(exactServer, 5_000);
          } catch {
            exactServer.kill('SIGKILL');
            await waitForServerExit(exactServer, 5_000);
          }
          exactServer.stdout?.removeAllListeners();
          exactServer.stderr?.removeAllListeners();
          exactServer.removeAllListeners();
        },
        10_000
      );
      server = null;
    }
    if (port) await backstop('verify dynamic port released', async () => verifyPortReleased(port), 5_000);
    if (socketName) {
      await backstop(
        'stop disposable tmux socket',
        async () => {
          tmux(['kill-server'], { ignoreError: true });
          if (tmux(['list-sessions'], { ignoreError: true }).trim())
            throw new Error('tmux sessions survived kill-server');
          const exactSocketPath = tmuxSocketPath(socketName);
          rmSync(exactSocketPath, { force: true });
          if (existsSync(exactSocketPath)) throw new Error(`${exactSocketPath} survived teardown`);
        },
        5_000
      );
    }
    if (labRoot) {
      await backstop(
        'remove lab root',
        async () => {
          rmSync(labRoot, { recursive: true, force: true });
          if (existsSync(labRoot)) throw new Error(`${labRoot} still exists`);
        },
        5_000
      );
    }
    if (errors.length) throw new AggregateError(errors, `COD-369 file teardown failed\n${serverLog}`);
  }, fileTeardownTimeout());

  it(
    'bundle smoke and basic typing converge in one isolated scenario',
    async () => {
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
    },
    scenarioTestTimeout(1, 20_000)
  );

  it(
    '#222: slash picker filters live while predictions confirm away',
    async () => {
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
    },
    scenarioTestTimeout(1, 20_000)
  );

  it(
    '#219: typed text and paste land in order with nothing dropped',
    async () => {
      await withCodexScenario('typed text and paste', {}, async (scenario) => {
        const { page } = scenario;
        await installInputTrace(page);
        await page.keyboard.type('abc', { delay: 30 });
        await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app.terminal.paste('XYZ'));
        expect(await waitForPaneText(scenario, 'abcXYZ', 15_000)).toContain('abcXYZ');
        expect(await spanCount(page)).toBe(0);
        const trace = await readInputTrace(page);
        expect(trace.logical.join('')).toContain('abcXYZ');
        expect(durablePayloads(trace)).toEqual(trace.logical);
      });
    },
    scenarioTestTimeout(1, 20_000)
  );

  it(
    '#220: wrapped input renders exactly without ghost glyphs past the edge',
    async () => {
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
    },
    scenarioTestTimeout(1, 20_000)
  );

  it(
    'modal ghost eliminator keeps zero spans on the trust dialog',
    async () => {
      await withCodexScenario('untrusted modal', { trusted: false, composer: 'modal' }, async (scenario) => {
        const { page } = scenario;
        expect(scenario.capturePane().text).toContain('Press enter to continue');
        await page.keyboard.type('x', { delay: 30 });
        expect(await spanCount(page)).toBe(0);
        expect((await predictState(page)).outstanding).toBe(0);
      });
    },
    scenarioTestTimeout(1, 20_000)
  );

  it(
    'kill switch clears spans while typing continues to stream',
    async () => {
      await withCodexScenario('kill switch', {}, async (scenario) => {
        const { page } = scenario;
        await page.evaluate(() => {
          const app = (window as unknown as { app: Record<string, any> }).app;
          const settings = app.loadAppSettingsFromStorage();
          settings.localEchoEnabled = false;
          app.saveAppSettingsToStorage(settings);
          app._updateLocalEchoState();
        });
        expect(
          await page.evaluate(() => (window as unknown as { app: Record<string, any> }).app._localEchoPolicy)
        ).toBe('off');
        expect(await spanCount(page)).toBe(0);
        await page.keyboard.type('still-live', { delay: 20 });
        expect(await waitForPaneText(scenario, 'still-live')).toContain('still-live');
        expect(await spanCount(page)).toBe(0);
      });
    },
    scenarioTestTimeout(1, 20_000)
  );

  it(
    'byte identity is exact in two sequential isolated scenarios',
    async () => {
      let withPredictor: InputTrace | null = null;
      let withoutPredictor: InputTrace | null = null;
      let commonModes: TerminalInputModes | undefined;
      await withCodexScenario('byte identity predictor active', {}, async ({ page, inputModes }) => {
        commonModes = inputModes;
        const expectedPayloads = expectedByteIdentityPayloads(inputModes);
        await installInputTrace(page);
        await runByteIdentityScript(page);
        withPredictor = await readInputTrace(page);
        expect(withPredictor.logical).toEqual(expectedPayloads);
        expect(durablePayloads(withPredictor)).toEqual(expectedPayloads);
        expect(withPredictor.durable).toEqual(
          expect.arrayContaining(
            expectedPayloads.map((data) =>
              expect.objectContaining({ data, clientId: expect.any(String), seq: expect.any(Number) })
            )
          )
        );
        expect(await spanCount(page)).toBe(0);
        expect(await predictState(page)).toMatchObject({ outstanding: 0, droppedTotal: 0 });
      });
      expect(commonModes).toBeDefined();
      await withCodexScenario(
        'byte identity predictor absent',
        { predictor: 'absent', expectedInputModes: commonModes },
        async ({ page, inputModes }) => {
          expect(inputModes).toEqual(commonModes);
          const expectedPayloads = expectedByteIdentityPayloads(inputModes);
          await installInputTrace(page);
          await runByteIdentityScript(page);
          withoutPredictor = await readInputTrace(page);
          expect(withoutPredictor.logical).toEqual(expectedPayloads);
          expect(durablePayloads(withoutPredictor)).toEqual(expectedPayloads);
          expect(withoutPredictor.durable).toEqual(
            expect.arrayContaining(
              expectedPayloads.map((data) =>
                expect.objectContaining({ data, clientId: expect.any(String), seq: expect.any(Number) })
              )
            )
          );
          expect(await spanCount(page)).toBe(0);
        }
      );
      expect(withPredictor).not.toBeNull();
      expect(withoutPredictor!.logical).toEqual(withPredictor!.logical);
      expect(durablePayloads(withoutPredictor!)).toEqual(durablePayloads(withPredictor!));
    },
    scenarioTestTimeout(2, 20_000)
  );

  it(
    '#218: arrows and mid-word insert submit the exact edited text',
    async () => {
      await withCodexScenario('mid word edit', {}, async (scenario) => {
        const { page } = scenario;
        await installInputTrace(page);
        await page.keyboard.type('hello', { delay: 30 });
        await waitForPaneText(scenario, 'hello');
        await page.keyboard.press('ArrowLeft');
        expect(await predictState(page)).toMatchObject({ outstanding: 0 });
        expect(await spanCount(page)).toBe(0);
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.type('X', { delay: 30 });
        const beforeSubmit = scenario.capturePane();
        await page.keyboard.press('Enter');
        await waitForSubmissionTransition(scenario, beforeSubmit, 'helXlo', 20_000);
        const trace = await readInputTrace(page);
        expect(trace.logical.at(-1)).toBe('\r');
        expect(durablePayloads(trace)).toEqual(trace.logical);
        expect(await spanCount(page)).toBe(0);
      });
    },
    scenarioTestTimeout(1, 30_000)
  );

  it(
    'simulated 300ms RTT gives instant exact spans and converges',
    async () => {
      await withCodexScenario('simulated RTT', {}, async (scenario) => {
        const { page } = scenario;
        await installInputTrace(page);
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
        const beforeSubmit = scenario.capturePane();
        await page.keyboard.press('Enter');
        await waitForSubmissionTransition(scenario, beforeSubmit, 'high rtZt', 20_000);
        const trace = await readInputTrace(page);
        expect(trace.logical.at(-1)).toBe('\r');
        expect(durablePayloads(trace)).toEqual(trace.logical);
        expect(await spanCount(page)).toBe(0);
      });
    },
    scenarioTestTimeout(1, 60_000)
  );
});
