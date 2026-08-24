# COD-374 Mobile Input Latency Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a test-only, bounded trace that identifies the first delayed boundary between mobile keyboard dispatch and exact OpenCode composer rendering.

**Architecture:** A disabled-by-default server trace collector records fixed-schema input/output boundary events in memory and exposes them only through a secret-protected route registered by disposable test servers. A separate mobile Playwright harness records browser and xterm stages plus a bounded tmux pane-visibility interval, validates tracing overhead, and runs complete baseline/candidate cohorts without optimizing runtime behavior.

**Tech Stack:** TypeScript ESM, Fastify, Vitest, Playwright/Chromium, xterm.js, tmux, Node `performance`/`hrtime`, existing COD-370 disposable OpenCode fixture.

---

## Fixed Revisions and Safety Rules

- Worktree: `/opt/projects/Codeman/.worktrees/COD-370-active-viewer-terminal-sizing`.
- Plan base: `41770a9c` plus this plan commit.
- Baseline runtime: `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613`.
- Candidate runtime under diagnosis: `f3851229167a5078a15ae398c006cc2756690296`.
- Never run bare `npm test` or raw unscoped Vitest from the managed session.
- Do not push, merge, deploy, expose LAN, or modify COD-370 product behavior.
- Preserve every accepted and rejected trace repetition and every cleanup result.
- Do not propose or implement an optimization until the trace identifies the first delayed boundary outside measurement uncertainty.

## File Structure

- Create `src/perf/mobile-input-trace.ts`: fixed trace schema, disabled/enabled collector, bounds, hashing, snapshot, clear.
- Create `src/web/routes/perf-trace-routes.ts`: secret-protected test-only snapshot/clear route.
- Modify `src/web/server.ts`: register the route only when the collector is explicitly enabled under `NODE_ENV=test`.
- Modify `src/web/routes/ws-routes.ts`: input receipt/write/ACK and terminal output batching/send events.
- Modify `src/session.ts`: PTY receipt, terminal handler, and terminal emission events.
- Create `test/perf-cod-374-trace.test.ts`: collector and schema contracts.
- Create `test/routes/perf-trace-routes.test.ts`: route absence/auth/snapshot/clear contracts.
- Modify `test/routes/ws-routes.test.ts`: exact server-stage ordering and duplicate semantics.
- Create `test/session-terminal-trace.test.ts`: focused Session PTY/output trace ordering contracts.
- Create `test/utils/cod374-latency-trace.ts`: browser event types, pane interval observer, trace validation, clock uncertainty, overhead gate.
- Create `test/cod374-latency-trace.test.ts`: pure validation, ordering, interval, overhead, and publication-gate contracts.
- Create `test/mobile/cod374-input-latency.test.ts`: real disposable OpenCode trace and calibration runner.
- Create `scripts/perf/cod-374-summarize.mjs`: fail-closed report generation from complete raw cohorts.
- Create `docs/reports/cod-374/README.md`: measurement protocol and command ledger.
- Generate `docs/reports/cod-374/raw/*.json` and `docs/reports/cod-374/input-latency-attribution.md` only after all instrumentation reviews pass.

### Task 1: Bounded Test Trace Collector

**Files:**

- Create: `src/perf/mobile-input-trace.ts`
- Create: `src/web/routes/perf-trace-routes.ts`
- Modify: `src/web/server.ts`
- Test: `test/perf-cod-374-trace.test.ts`
- Test: `test/routes/perf-trace-routes.test.ts`

- [ ] **Step 1: Write the failing collector contracts**

Define the wished-for public API in the test:

```ts
import { createMobileInputTraceCollector, type MobileInputTraceEvent } from '../src/perf/mobile-input-trace.js';

it('is disabled without the complete disposable test environment', () => {
  const trace = createMobileInputTraceCollector({ nodeEnv: 'production', secret: 's', capacity: 8 });
  expect(trace.enabled).toBe(false);
  expect(trace.record({ stage: 'server.input.received', monoNs: '1' })).toBe(false);
  expect(trace.snapshot()).toEqual({ enabled: false, overflowed: false, events: [] });
});

it('fails closed at the fixed capacity and never accepts raw text fields', () => {
  const trace = createMobileInputTraceCollector({ nodeEnv: 'test', secret: 'secret', capacity: 1 });
  expect(trace.record({ stage: 'server.input.received', monoNs: '1', clientId: 'c', seq: 1 })).toBe(true);
  expect(trace.record({ stage: 'server.input.pre-write', monoNs: '2', clientId: 'c', seq: 1 })).toBe(false);
  expect(trace.snapshot().overflowed).toBe(true);
  expect(() => trace.record({ stage: 'server.input.received', monoNs: '3', raw: 'secret' } as never)).toThrow(
    /unknown trace field/i
  );
});
```

Add schema tests that accept only enumerated stages, safe scalar fields, bounded IDs/hashes, nonnegative byte counts, and integer ordinals/sequences.

- [ ] **Step 2: Run the collector test and verify RED**

Run:

```bash
npm run test:perf -- test/perf-cod-374-trace.test.ts
```

Expected: FAIL because `src/perf/mobile-input-trace.ts` does not exist.

- [ ] **Step 3: Implement the minimal fixed-schema collector**

Implement a bounded collector with this shape:

```ts
export type MobileInputTraceStage =
  | 'server.input.received'
  | 'server.input.parsed'
  | 'server.input.deduped'
  | 'server.input.activated'
  | 'server.input.pre-write'
  | 'server.input.post-write'
  | 'server.input.pre-ack'
  | 'server.input.post-ack'
  | 'server.output.pty-received'
  | 'server.output.handler-enter'
  | 'server.output.terminal-emitted'
  | 'server.output.ws-received'
  | 'server.output.batch-enqueued'
  | 'server.output.flush-start'
  | 'server.output.pre-send'
  | 'server.output.post-send';

export interface MobileInputTraceEvent {
  stage: MobileInputTraceStage;
  monoNs: string;
  epochMs?: number;
  sessionHash?: string;
  clientId?: string;
  seq?: number;
  ordinal?: number;
  bytes?: number;
  valueHash?: string;
  applied?: boolean;
  delivered?: boolean;
}
```

Use `performance.timeOrigin + performance.now()` for `epochMs`, `process.hrtime.bigint().toString()` for `monoNs`, and SHA-256 truncated to 16 hexadecimal characters for identifiers/content supplied to the trace helper. Export one process-global collector configured from `CODEMAN_TEST_MOBILE_TRACE_SECRET` and `CODEMAN_TEST_MOBILE_TRACE_CAPACITY`, but keep `createMobileInputTraceCollector` injectable for tests. Capacity must be `1..20_000` and default to 4,096.

- [ ] **Step 4: Write the failing route contracts**

Test these behaviors with Fastify injection:

```ts
it('does not register when tracing is disabled', async () => {
  registerPerfTraceRoutes(app, disabledTrace);
  expect((await app.inject({ method: 'GET', url: '/__test/perf/mobile-input' })).statusCode).toBe(404);
});

it('requires the exact secret and clears only after an authenticated request', async () => {
  registerPerfTraceRoutes(app, enabledTrace);
  expect((await app.inject({ method: 'GET', url: '/__test/perf/mobile-input' })).statusCode).toBe(404);
  const response = await app.inject({
    method: 'GET',
    url: '/__test/perf/mobile-input?clear=1',
    headers: { 'x-codeman-test-trace-secret': 'exact-secret' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().events).toHaveLength(1);
  expect(enabledTrace.snapshot().events).toHaveLength(0);
});
```

Wrong or missing secrets return 404, not 401/403, to avoid advertising the route.

- [ ] **Step 5: Run the route test and verify RED**

Run:

```bash
npm test -- test/routes/perf-trace-routes.test.ts
```

Expected: FAIL because the route module is absent.

- [ ] **Step 6: Implement conditional route registration**

Register `registerPerfTraceRoutes` from `src/web/server.ts` only when the global collector is enabled. The route must not be present in a normal test, development, or production server without all enabling variables.

- [ ] **Step 7: Verify GREEN and static gates**

Run:

```bash
npm run test:perf -- test/perf-cod-374-trace.test.ts
npm test -- test/routes/perf-trace-routes.test.ts
npm run typecheck
npx prettier --check src/perf/mobile-input-trace.ts src/web/routes/perf-trace-routes.ts src/web/server.ts test/perf-cod-374-trace.test.ts test/routes/perf-trace-routes.test.ts
git diff --check
```

Expected: all commands exit 0; route tests prove absence and secret fencing.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/perf/mobile-input-trace.ts src/web/routes/perf-trace-routes.ts src/web/server.ts \
  test/perf-cod-374-trace.test.ts test/routes/perf-trace-routes.test.ts
git commit -m "test(perf): COD-374 add bounded latency trace collector"
```

### Task 2: Server Input and Output Boundary Events

**Files:**

- Modify: `src/web/routes/ws-routes.ts`
- Modify: `src/session.ts`
- Modify: `test/routes/ws-routes.test.ts`
- Create or modify: `test/session-terminal-trace.test.ts`

- [ ] **Step 1: Write failing WebSocket route ordering tests**

Inject an enabled collector into the route registration through an optional dependency that defaults to the process-global collector. Assert this exact stage order for one tagged input:

```ts
expect(stagesFor('client-1', 7)).toEqual([
  'server.input.received',
  'server.input.parsed',
  'server.input.deduped',
  'server.input.activated',
  'server.input.pre-write',
  'server.input.post-write',
  'server.input.pre-ack',
  'server.input.post-ack',
]);
```

Add separate tests proving:

- duplicate `(clientId, seq)` records `applied:false`, performs no second write, and still ACKs;
- failed write records `delivered:false`, sends no ACK, and allows retry;
- malformed/oversized frames never create a successful write event;
- disabled tracing leaves existing behavior and event count unchanged.

- [ ] **Step 2: Run the focused route test and verify RED**

```bash
npm test -- test/routes/ws-routes.test.ts -t "COD-374"
```

Expected: FAIL because no trace events are emitted.

- [ ] **Step 3: Add minimal input boundary calls**

Add trace calls immediately around the existing operations; do not change delivery order, error handling, ACK behavior, or protocol. Hash the session ID and do not hash/store `msg.d` on the input path. Use the parsed client ID and sequence only after validation.

- [ ] **Step 4: Write failing terminal-output stage tests**

Use the Session test factory to call the existing PTY-output handler with a harmless ANSI chunk and assert:

```ts
expect(outputStages).toEqual([
  'server.output.pty-received',
  'server.output.handler-enter',
  'server.output.terminal-emitted',
  'server.output.ws-received',
  'server.output.batch-enqueued',
  'server.output.flush-start',
  'server.output.pre-send',
  'server.output.post-send',
]);
```

Assert monotonically increasing ordinals, exact byte counts, 16-character hashes, a single flush for a micro-batch, and no raw output text in the snapshot.

- [ ] **Step 5: Run the output tests and verify RED**

```bash
npm test -- test/session-terminal-trace.test.ts test/routes/ws-routes.test.ts -t "COD-374"
```

Expected: FAIL because Session/output route boundaries are not instrumented.

- [ ] **Step 6: Add minimal output boundary calls**

Record PTY callback receipt at each interactive PTY `onData` entry, handler entry and terminal emission in Session, and WebSocket route receipt/enqueue/flush/send. Use a per-session output ordinal generated by the collector and a bounded hash/byte count. Do not change the 8ms batching timer or terminal output bytes.

- [ ] **Step 7: Verify GREEN and regression gates**

```bash
npm run test:perf -- test/perf-cod-374-trace.test.ts
npm test -- test/session-terminal-trace.test.ts test/routes/ws-routes.test.ts test/reliable-input-dedup.test.ts
npm run typecheck
npm run lint
npx prettier --check src/perf/mobile-input-trace.ts src/session.ts src/web/routes/ws-routes.ts \
  test/session-terminal-trace.test.ts test/routes/ws-routes.test.ts
git diff --check
```

Expected: all focused tests and static gates exit 0; any existing lint warning is reported with its unchanged file/line.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/session.ts src/web/routes/ws-routes.ts test/session-terminal-trace.test.ts test/routes/ws-routes.test.ts
git commit -m "test(perf): COD-374 trace server input output boundaries"
```

### Task 3: Browser, Xterm, and Tmux Pane Observers

**Files:**

- Create: `test/utils/cod374-latency-trace.ts`
- Create: `test/cod374-latency-trace.test.ts`
- Create: `test/mobile/cod374-input-latency.test.ts`
- Modify: `test/utils/cod370-opencode-fixture.ts`

- [ ] **Step 1: Write failing pure trace contracts**

Define and test these pure interfaces:

```ts
export interface PaneProbe {
  startedNs: bigint;
  completedNs: bigint;
  present: boolean;
  durationMs: number;
  error?: string;
}

export interface PaneVisibilityInterval {
  lastAbsentCompletedNs: bigint | null;
  firstPresentStartedNs: bigint;
  firstPresentCompletedNs: bigint;
  widthMs: number;
  probes: PaneProbe[];
}

export function tracingOverheadGate(
  offP95: number,
  onP95: number
): {
  passed: boolean;
  deltaMs: number;
  deltaPercent: number;
};
```

Tests require both `deltaMs <= 5` and `deltaPercent <= 10`, reject empty/negative/nonfinite values, reject missing stages, reject cross-clock subtraction without calibration, and require every pane probe including errors to remain in the result.

- [ ] **Step 2: Run the pure test and verify RED**

```bash
npm test -- test/cod374-latency-trace.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement pure validation and the bounded pane observer**

Add a fixture method that starts before key dispatch, polls the exact pane ID, and resolves only after the exact cumulative token appears. It records each start/completion/error and returns the interval. It must support `AbortSignal`, a fixed deadline, and cleanup that awaits the active probe before fixture teardown.

- [ ] **Step 4: Write a failing real-browser trace test**

The test installs hooks before the measured key and requires this browser order for each character:

```ts
expect(browserStages).toEqual([
  'browser.keydown',
  'browser.xterm-on-data',
  'browser.logical',
  'browser.durable-queued',
  'browser.ws-input-send',
  'browser.ws-input-ack',
  'browser.ws-output-receive',
  'browser.output-handler',
  'browser.write-queued',
  'browser.xterm-write',
  'browser.xterm-parsed',
  'browser.xterm-render',
  'browser.xterm-visible',
  'browser.paint-proxy',
]);
```

The test also requires a nonempty pane interval, exact final pane/xterm token, exact one logical/durable identity, zero trace overflow, no page/serious console errors, and all mandatory fixture cleanup booleans.

- [ ] **Step 5: Run the real test and verify RED**

```bash
npm run test:mobile -- test/mobile/cod374-input-latency.test.ts -t "records every latency boundary"
```

Expected: FAIL with missing browser/pane/server stages while cleanup still reports all true.

- [ ] **Step 6: Implement browser hooks without product-browser edits**

Install all browser hooks from the test through `addInitScript` or after stable fixture readiness:

- capture `keydown` with `performance.now()`;
- subscribe to xterm `onData`;
- wrap `_sendInputAsync`, `_reliableSend`, and `_drainSession` only to observe entry/assigned sequence/send;
- observe ACKs through the app ACK method;
- observe WebSocket output messages without consuming them;
- wrap `_onSessionTerminal`, `batchTerminalWrite`, and `terminal.write` while preserving return values, callbacks, and `this`;
- subscribe to `onWriteParsed` and `onRender`;
- inspect the xterm buffer only for the current test token;
- stamp the next animation frame as `paint-proxy`.

Every wrapper is restored in `finally`, and listener/disposable counts must be zero after teardown.

- [ ] **Step 7: Verify GREEN twice and run focused regressions**

```bash
npm test -- test/cod374-latency-trace.test.ts
npm run test:mobile -- test/mobile/cod374-input-latency.test.ts -t "records every latency boundary"
npm run test:mobile -- test/mobile/cod374-input-latency.test.ts -t "records every latency boundary"
npm run test:browser -- test/terminal-input-performance.browser.test.ts
npm run typecheck
npx prettier --check test/utils/cod374-latency-trace.ts test/utils/cod370-opencode-fixture.ts \
  test/cod374-latency-trace.test.ts test/mobile/cod374-input-latency.test.ts
git diff --check
```

Expected: both real runs pass independently with complete cleanup; the existing browser performance suite remains green.

- [ ] **Step 8: Commit Task 3**

```bash
git add test/utils/cod374-latency-trace.ts test/utils/cod370-opencode-fixture.ts \
  test/cod374-latency-trace.test.ts test/mobile/cod374-input-latency.test.ts
git commit -m "test(perf): COD-374 trace browser pane xterm latency"
```

### Task 4: Calibration, Complete Diagnostic Matrix, and Attribution Report

**Files:**

- Create: `scripts/perf/cod-374-summarize.mjs`
- Create: `docs/reports/cod-374/README.md`
- Generate: `docs/reports/cod-374/raw/*.json`
- Generate: `docs/reports/cod-374/input-latency-attribution.md`
- Test: `test/perf-cod-374-report.test.ts`

- [ ] **Step 1: Write failing report/publication contracts**

Create fixtures for complete and incomplete raw traces. The report test must reject:

- wrong runtime/tree/harness/lock/vendor provenance;
- tracing-on p95 overhead above 5ms or 10%;
- missing stages, duplicate sequence writes, missing ACKs, or absent pane/xterm token evidence;
- trace overflow, observer errors, excessive clock uncertainty, page/console errors, process replacement, resize during typing, or incomplete cleanup;
- partial ABBA order, selective samples, or mixed harness hashes.

It must accept a complete synthetic matrix and label each duration as component-local or calibrated with uncertainty.

- [ ] **Step 2: Run the report test and verify RED**

```bash
npm run test:perf -- test/perf-cod-374-report.test.ts
```

Expected: FAIL because the summarizer is absent.

- [ ] **Step 3: Implement the fail-closed summarizer**

The script takes explicit input paths and an unused output path, validates everything before publication, writes atomically through an adjacent temporary file, and refuses to overwrite an existing report. It reports medians, p95, max, complete per-sample stage durations, pane interval widths, poll cost, trace overhead, long tasks, load, correctness, errors, and cleanup.

- [ ] **Step 4: Verify summarizer GREEN**

```bash
npm run test:perf -- test/perf-cod-374-report.test.ts
node --check scripts/perf/cod-374-summarize.mjs
```

Expected: all contracts pass.

- [ ] **Step 5: Run tracing-off/on calibration**

Use disposable detached worktrees and the exact candidate runtime. Run complete fixed-size cohorts with tracing disabled and enabled. Do not continue to attribution if the overhead gate fails. Preserve every raw repetition and cleanup proof.

Expected accepted result: enabled p95 is no more than 5ms and no more than 10% worse than disabled. Otherwise publish a measurement-invalid report and stop.

- [ ] **Step 6: Run the complete baseline/candidate diagnostic matrix**

Use exact ABBA order:

1. baseline repetition 1;
2. candidate repetition 1;
3. candidate repetition 2;
4. baseline repetition 2.

Every repetition contains complete 1x and 4x cells and the same unfiltered character count. No selective rerun is allowed. A preflight failure produces zero accepted samples and remains separately disclosed.

- [ ] **Step 7: Generate and inspect the attribution report**

Run the summarizer to a new report path. Confirm the first delayed component or mark the result inconclusive when intervals/uncertainty overlap. Do not include a product fix recommendation unless the boundary is causally demonstrated.

- [ ] **Step 8: Run final scoped verification**

```bash
npm run test:perf -- test/perf-cod-374-trace.test.ts test/perf-cod-374-report.test.ts
npm test -- test/routes/perf-trace-routes.test.ts test/session-terminal-trace.test.ts \
  test/routes/ws-routes.test.ts test/cod374-latency-trace.test.ts
npm run test:mobile -- test/mobile/cod374-input-latency.test.ts
npm run test:browser -- test/terminal-input-performance.browser.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

Expected: all scoped tests and static/build gates exit 0; known unchanged warnings are identified by exact file/line.

- [ ] **Step 9: Commit Task 4 evidence**

```bash
git add scripts/perf/cod-374-summarize.mjs test/perf-cod-374-report.test.ts \
  docs/reports/cod-374/README.md docs/reports/cod-374/raw docs/reports/cod-374/input-latency-attribution.md
git commit -m "test(perf): COD-374 record input latency attribution"
```

- [ ] **Step 10: Review and Jira handoff**

Request independent spec and quality reviews. Fix every Critical or Important finding and rerun the affected gates. Post a Jira COD-374 comment with branch, commits, exact revisions, commands, trace overhead, raw/report paths, causal conclusion or uncertainty, cleanup, and review results. Keep COD-370 and COD-374 open unless the evidence and any separately approved fix satisfy their respective acceptance gates.
