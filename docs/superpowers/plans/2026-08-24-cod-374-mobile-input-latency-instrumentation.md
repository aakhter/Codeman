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

- [x] **Step 1: Write failing pure trace contracts**

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

- [x] **Step 2: Run the pure test and verify RED**

```bash
npm test -- test/cod374-latency-trace.test.ts
```

Expected: FAIL because the helper does not exist.

- [x] **Step 3: Implement pure validation and the bounded pane observer**

Add a fixture method that starts before key dispatch, polls the exact pane ID, and resolves only after the exact cumulative token appears. It records each start/completion/error and returns the interval. It must support `AbortSignal`, a fixed deadline, and cleanup that awaits the active probe before fixture teardown.

- [x] **Step 4: Write a failing real-browser trace test**

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

- [x] **Step 5: Run the real test and verify RED**

```bash
npm run test:mobile -- test/mobile/cod374-input-latency.test.ts -t "records every latency boundary"
```

Expected: FAIL with missing browser/pane/server stages while cleanup still reports all true.

- [x] **Step 6: Implement browser hooks without product-browser edits**

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

- [x] **Step 7: Verify GREEN twice and run focused regressions**

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

- [x] **Step 8: Commit Task 3**

```bash
git add test/utils/cod374-latency-trace.ts test/utils/cod370-opencode-fixture.ts \
  test/cod374-latency-trace.test.ts test/mobile/cod374-input-latency.test.ts
git commit -m "test(perf): COD-374 trace browser pane xterm latency"
```

Task 3 evidence (2026-08-24): pure REDs covered global monotonic ordering, lossless post-ACK connection joins, the full
PTY/session/WebSocket/flush output chain, monotonic server ordinals, mixed/coalesced identities, paint fencing, bounded
pane capture, and aggregate cleanup. Browser REDs exposed send retry deduplication, partial visibility before incomplete
classification, mutable context loss under overlap, Playwright's serialized typing, and Codeman's real `q` + coalesced
`z1` input frames. A final review RED also proved that separate per-token pane loops could overlap and that accepted
typing windows did not reject known long-task diagnostics. Final pure contracts passed 21/21. The real test pre-arms all cumulative contexts and one shared pane-snapshot scheduler,
enqueues all CDP key events without per-character waits, requires every keydown before the first output, and preserves
every input/output/write event while explicitly marking generations that never reached exact-token paint. Two clean
standalone rapid runs passed (12.85s and 13.36s) with exact client/sequence/coalescing evidence, lossless connection/hash/
byte/ordinal joins, the complete server output chain, and complete cleanup. The existing terminal input browser suite
passed 17/17. Typecheck, focused Prettier, and diff checks passed. One pane capture per tick evaluates every pending token
from the same snapshot, remains integer-deadline/abort-safe, and preserves per-token intervals and errored probes. Known
long-task diagnostics remain separately classified for failure evidence, but an accepted typing window requires none.

### Task 4: Calibration, Complete Diagnostic Matrix, and Attribution Report

**Files:**

- Create: `scripts/perf/cod-374-summarize.mjs`
- Create: `scripts/perf/cod-374-runner.mjs`
- Create: `scripts/perf/cod-374-playwright-runtime.ts`
- Create: `docs/reports/cod-374/README.md`
- Phase B external temp output: deterministic `attempts/attempt-NNNN.json` files and regenerated `ledger.json`
- Later evidence commit only: `docs/reports/cod-374/input-latency-attribution.md` and selected raw evidence
- Test: `test/perf-cod-374-report.test.ts`
- Test: `test/perf-cod-374-runner.test.ts`

- [x] **Step 1: Write failing report/publication contracts**

Create fixtures for complete and incomplete raw traces. The report test must reject:

- wrong runtime/tree/harness/lock/vendor provenance;
- tracing-on p95 overhead above 5ms or 10%;
- missing stages, duplicate sequence writes, missing ACKs, or absent pane/xterm token evidence;
- trace overflow, observer errors, page/console errors, process replacement, resize during typing, or incomplete cleanup;
- partial ABBA order, selective samples, or mixed harness hashes.

It must model the real Task 3 browser/server schemas and multiplicity, accept honest trace-off samples without collector
events, and label every duration component-local. Cross-domain attribution always remains inconclusive.

- [x] **Step 2: Run the report test and verify RED**

```bash
npm run test:perf -- test/perf-cod-374-report.test.ts
```

Expected: FAIL because the summarizer is absent.

- [x] **Step 3: Implement the fail-closed summarizer**

The script reconciles a deterministic external experiment root, validates every immutable attempt file and the complete
schedule before publication, writes atomically, and refuses to overwrite an existing report. It reports medians, p95,
max, every consecutive per-sample component-local duration, pane probes/intervals, trace overhead, long tasks, load,
derived correctness, errors, and cleanup.

- [x] **Step 4: Verify summarizer GREEN**

```bash
npm run test:perf -- test/perf-cod-374-report.test.ts test/perf-cod-374-runner.test.ts
node --check scripts/perf/cod-374-summarize.mjs
node --check scripts/perf/cod-374-runner.mjs
```

Expected: all contracts pass.

Phase A evidence: the initial scoped run failed because the summarizer module was absent. First-review REDs covered the
collector vocabulary, lossless evidence, provenance, overlay, ledger, median, privacy, and durable publication. The
second-review real-shape RED produced 31 expected failures in 43 tests against the incompatible schema and append ledger;
later REDs covered completed contamination, missing output identities, multi-batch output, crash-after-ledger recovery,
manifest symlinks, and clean-repository preflight proof. Final corrective REDs covered full rapid-input generation
windows and async output/write joins, honest launched-partial evidence, independently measured runtime proofs,
reconcile-before-validation, actual killed-process lock recovery, realpath containment, recursive canonical JSON, and
complete calibration/diagnostic/cleanup reporting. Independent final review then corrected real Task 3 input-received
identity, mutually exclusive generation completion, one-write paint fences, retained-sample detail in invalid reports,
and identity-bound stale-lock reclamation. The final harness accepts Task 3 browser/server multiplicity, keeps
trace-off free of server collector events, removes calibrated cross-domain causality, verifies actual runtime and clean
Git/dependency provenance, applies overlay bytes through stdin, and treats immutable attempt files as truth for an
atomically regenerated ledger. A concrete Phase B runner now launches the exact verified overlay worktree, binds served
assets and live server/browser/OpenCode process identities, adapts the actual Task 3 trace shape, measures fixed-loop CPU
ratios, retains partial/cleanup failures, and publishes through the locked transaction API. Final adversarial REDs bound
UUID client privacy, captured clocks/load/process identities, overlay launch provenance, strict post-ACK attribution,
and output-root/finalization safety. The final pre-cohort corrections reserve each exact schedule position before
capture, recover a killed reservation as a terminal rejected attempt, use the Task 3 first-ACK boundary, observe resize
contamination, bracket process start time with `/proc/uptime` uncertainty, re-read exact final process identities, and
recover after-link crashes for locks, reclaim, reports, and finalization markers. Invalid dirty/dependency/overlay
preflights publish from retained evidence without rerunning the failed prerequisite. Phase A generated no raw cohort or
attribution report. The expanded focused suites passed 98/98 before final static verification.

- [ ] **Step 5: Run tracing-off/on calibration**

The first calibration experiment `32e33dfa699bd0f7` is immutable INVALID and will never be retried. Attempt 1 hash
`d43195872fe9109a1a67aeda378c8cb19366d376f7be78858f1f213fef39c940` failed before capture because the verified
detached runtime lacked a dependency root; invalid report hash
`036a54d2813d4754186628c57475e12fd2836a6370785223cb28cfdc01338860`. The corrected harness provisions and re-verifies
the exact clean harness dependency root after overlay verification. The corrected runner binds the source device/inode
and a bounded content manifest of every installed package record, including dev Playwright and launcher packages, and
recomputes that identity before launch, after launch, and before publication. A future calibration must use a fresh
experiment.

The next fresh experiment `194d04296ddc0953` is also immutable INVALID and will never be retried. Attempt 1 hash
`231627b26f8a69c4ec8c9f443eb478806b180c7f6358a46425f1f76236e20c32` stopped before samples; ledger, report, and
finalized hashes are `18ae4b5a17091609bd731faabab333431832e1a8494537fb2110bacd11e71109`,
`43b7b593a97fb5ec0cf2e98b0891c839c5b0edcab558c49c9df04797519791b8`, and
`11124dc2170898787cabc39e17a2f67baef6c4f679ff410d115011ca0fc70e02`. Its bounded outer startup-message hash is
`4f5bcd7681299314`. The app shell's loaded marker preceded deferred animation-frame terminal initialization, and the old
runtime selected the session while terminal options were null. The correction waits for terminal plus SSE readiness
before creation, requires exact session hydration before selection, and proves active session, ready WebSocket, buffer,
pane+xterm composer, real row click/focus, and stability. The required full detached-runtime integration then exposed a
second prerequisite: generated vendor assets are ignored and absent from a Git worktree. The runner now provisions only
the exact hash-bound ignored vendor files beside the preserved tracked files and recomputes their identity at all three
runtime boundaries. It retains that proof in `provenance.runtimeVendorHash`; the plan and preflight/crash evidence use
null until a runtime is actually proven. The composer click uses independently derived, unique, equal visible tmux and
xterm viewport rows rather than a tmux scrollback index. Browser/server/tmux/root cleanup was verified; hooks/listeners
were not allocated. A future calibration requires another wholly fresh experiment after this correction is committed
and reviewed.

The third fresh experiment `381941ff3eeec967` is likewise immutable INVALID and will never be retried. Attempt 1 hash
`23dd88651bcf17641c225fcae0763a45c055f3e08b1eef689cad19242a07f545` stopped with zero cells; ledger, report, and
finalized hashes are `635f807e15fd65ef9ccd275e8e5db1f6e0fe30f6616c81bf64f57efdd2d1c903`,
`b750d8f4555c976c03ffa7a88da520b3ec83a70a7f362da6fbb35b4ce877c556`, and
`85f29237b3da049ffd074e8cbfc5ad32ca2f53e0328ea65e2c910ae428162743`. Its runtime-vendor proof is
`c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, bounded outer failure hash is
`4f5bcd7681299314`, and startup-message hashes are `0bdcf894ac84c582` and `81c304ef6ed1beb5`. Exact production-loader
reproduction proved that `node --import tsx` transformed the function callback supplied to `page.addInitScript`, leaked
a free `__name`, and caused a browser page error before `window.__cod374LatencyTrace` existed. The correction uses a
static self-contained plain-JavaScript `content` payload, verified under the production dynamic-import path to contain
no transform helpers and to create the trace state before navigation. Aggregate cleanup was complete and no retry is
permitted; another calibration requires a new experiment only after this correction is committed and reviewed.

The fourth fresh experiment `fe48f15eeb83d566` is also immutable INVALID and will never be retried. Attempt 1 hash
`12204036be0d3a25a211bf3aae20a45ca87f6246dfb3804449053cecfc0410cd` stopped with zero cells; ledger, report, and
finalized hashes are `6b8b87f3bd0a06617e585e23712d778d6106d7e45bdca8daee6a1d58ddc92129`,
`32ae41cc71fd03c6319ae8ddd11be794efe2d7e1e6bf14dd22a363831e95e9bb`, and
`53a0a450c198855f10a0a4549e50994e66e5fb914c251ad7f79b37e404eb66f6`. Its runtime-vendor proof is
`c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, bounded outer failure hash is
`4f5bcd7681299314`, and nested startup-message hash is `e9a3d8fa25ed9e27`. The static init payload and exact
session/focus readiness succeeded, then production `node --import tsx` transformed the function callback passed to
`page.evaluate` by `installBrowserLatencyHooks` and leaked a free `__name`. The corrected installer evaluates an exact
static plain-JavaScript hook expression, JSON-encoding only a validated fail-stage enum. Exact-loader tests exercise the
real init/install/arm/complete/read/resize/remove path and audit all remaining setup/capture/cleanup callbacks, allowing
transform helpers only for exact Node-local handlers. Aggregate cleanup was complete; no retry is permitted and any
future calibration requires a wholly new experiment after commit and review.

The fifth fresh experiment `6706cafd8c32f6c0` is also immutable INVALID and will never be retried. Attempt 1 hash
`193fd39b6f41d7928538c2cd2392b339941b45fbe51d043e2d2f4ded8e16b65b` stopped with zero cells; ledger, report, and
finalized hashes are `3b6100b36c06b01e113b7d01e34b20aff1b50e48b88cb36eb797f14fc8be7e99`,
`217123849a4e280f371afd796840d8b5146e663047f0ce56f32ca480429c6e3c`, and
`259e55818e3937787301463a14b3c8ca538c4236eedc73f80d4004f35798caf6`. Its runtime-vendor proof is
`c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, bounded failure hash is
`b12becd4e90bf372`, and nested startup-message hash is `dec3d9ab7735b19b`. The old verifier raw-hashed dynamic `/`
against the immutable source index hash, even though frozen `renderIndexHtml` changes the title, numeric cache-busters,
exact CLI bootstrap, and two allowlisted visibility markers. The correction preserves the source hash independently,
canonicalizes only those exact transformations before requiring full source equality, and continues to require raw
byte equality for referenced `app.js` and `styles.css`. Cleanup was complete; no retry is permitted and any future
calibration requires a wholly new experiment after commit and review.

The sixth fresh experiment `9c4d0087fa344ef1` is also immutable INVALID and will never be retried. Attempt 1 hash
`00465b54fe716a9da4792a1ba552ecd32dea42bbfdb03cfa1a85bffd55958d8a` stopped with zero cells; ledger, report, and
finalized hashes are `17ac23e5765cbf42bd5ed91920b6b241e2ee58141becec55b726cd7b84e40c85`,
`56600a0b026886afd387978bb04a86aec6fc88749ea3902a0d364b1323c46a56`, and
`b64ed63213b92931f143c40415c23c4c9684d6c730db31df20934975fa6cc703`. Its runtime-vendor proof is
`c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, bounded failure hash is
`9eea4651f2e1886f`, and nested startup-message hash is `063c9eb222973875`. Raw dynamic error text was not retained and
cannot be reconstructed uniquely, so the trigger remains indeterminate. The cleanup-accounting root cause is proven:
after cleanup nulled the runtime and overlay handles, a later proof-construction error reached the generic catch, which
incorrectly inferred all cleanup fields from null handles and discarded the completed proof and evidence prefix.
Read-only live inspection found every recorded PID dead and no attempt-owned process, tmux socket, scenario root, or
overlay root. The correction hoists explicit resource state and durable monotonic cleanup proof, preserves completed
cells/diagnostics, invokes cleanup once, and separates later `runtime-proof-failed` evidence from any
`runtime-cleanup-failed` evidence. No retry is permitted; any future calibration requires a wholly new experiment after
commit and review. A recurring real-runtime gate additionally proved a composer-row TOCTOU between the successful
readiness poll and its immediate action-time reread. The corrected barrier accepts only two consecutive identical,
exactly equal visible pane/xterm snapshots and clicks the row from that accepted snapshot, with no fixed sleep.

The seventh fresh experiment `9e070ba5a75eca90` is also immutable INVALID and will never be retried. Attempt 1 hash
`3bcea24a95da48dce284c6d45bb45bfb4766eb1e5913e24dbcaf594f18caf133` stopped with zero published samples; ledger,
report, and finalized hashes are `b7d751a3df2810e31a20a02afe9fd7fbd5cbe852080d32d3e96e5fabebb4566b`,
`dca02c5b6c15430c713f319fc775d0af295ea36ae67da4becb28609ef4eba581`, and
`3b720bf2738b06b6e39db62274fc7c4efdb6c450bf1bc0e9ebd119866e1098b2`; the bounded failure hash is
`793268f4b26a4359`. No later calibration attempt or diagnostic ABBA ran. The captured write had all four events, ruling
out missing-event and quiescence hypotheses. The validator incorrectly required write, return, callback, parsed even
though `@xterm/xterm` 6.0.0 legally calls the callback and `onWriteParsed` synchronously inside `Reflect.apply`, before
the wrapper records return. The corrected invariant is causal: write first, callback before parsed, exactly one return
either before callback or after parsed, with unchanged identity and monotonic checks. Report derivation uses the same
stable nonnegative write-to-return, write-to-callback, and callback-to-parsed intervals for both schedules. Because the old strict failure
surfaced only after cleanup, its invalid partial then failed transaction validation and was replaced by a producer-crash
sentinel. The corrected producer retains the longest schema-valid cell/sample prefix, durable cleanup proof, and safe
failure hashes before publication, so a later validation failure cannot discard them. No retry is permitted; any future
calibration requires a wholly new experiment after commit and review.

The eighth fresh experiment `c5a5074cc3710e0f` is also immutable INVALID and will never be retried. Attempt 1 hash
`72dc5e1f5d2739cb9a5b20464a6635696840a6a9dec5aabd3193bb6dba4d28f3` stopped trace-off with one retained 1x cell and
zero samples; ledger, report, and finalized hashes are
`53ed53b9dea564629dcf8ffd11140f64485f85dde3ea525271a8c52d137645d8`,
`c63d82bbe24e32e88408fb4f5fb977dba6e5ac9a43fa1a83f2a69a5179767d2d`, and
`0be60a490bbedd93016698ada387295937928666abd6be292d0c40b7cf682f3e`. The retained runtime-vendor proof is
`c1a48afcc27a693a329a4bcce1d52bbc43118c491c4ce28d2506b91733391c0a`, bounded failure hash is
`386f7e7852f75046`, and startup-message hash is `f9cc966fa89ba331`; cleanup was completely verified and no later attempt
or diagnostic ABBA ran. The exact error was `COD-374 evidence invalid: browser visibility is not joined to a parsed
write`. The real hook's selected visibility events retained generation/input identity but lacked the explicit
`attributedGeneration`/`attributedInputIndex` join because `selectAttribution` annotated only global output events;
synthetic fixtures had manually enriched these fields. The correction applies the selected context to the matching
parse-visible, render, visible, and paint chain while preserving ordinal/write identity and generation/RAF fencing. A
real-hook contract executes parse, render, and RAF and feeds its unmodified trace through the Task 3 adapter and strict
evidence derivation. This experiment remains immutable and cannot be retried; a corrected calibration requires a new
experiment after commit and review.

The ninth fresh experiment `92b2296a98c9bcf5` is also immutable INVALID and will never be retried. Attempt 1 hash
`3aae425b0b178bca40001aad5327cd2e55449e24c2846dcdec6b816d2f9a1860` stopped trace-off with zero retained cells; ledger,
report, and finalized hashes are `4281c8e515e80c202aa08280a05e727e91fb3f9c59a8a6708b54256c649f5cd5`,
`dca02c5b6c15430c713f319fc775d0af295ea36ae67da4becb28609ef4eba581`, and
`bac703d0fa329d6d8707357e8b2583f90066bfefb46c7851039ab1ed90cb43ca`; bounded failure hash is
`793268f4b26a4359`. No later calibration attempt or diagnostic ABBA ran. The immutable producer-crash fallback retained
false/unknown cleanup, which remains authoritative despite a later read-only inventory finding no matching live process,
runtime worktree, or scenario root. The exact observation mismatch was a 16px inherited computed `.xterm` font size
against the active terminal option and frozen 9px plan. The corrected probe reads only the finite positive numeric
`window.app.terminal.options.fontSize`. A publication-time observation mismatch now produces a schema-valid
`runtime-proof-failed` partial with the measured cell prefix, diagnostics, and durable cleanup proof intact; only bounded
hashes are retained, and transaction recovery cannot replace it with a producer-crash sentinel. This experiment remains
immutable and cannot be retried; a corrected calibration requires a new experiment after commit and review.

The tenth fresh experiment `ec09d0f327f75693` is also immutable INVALID and will never be retried. Attempt 1 trace-off
was accepted with 20 samples at hash `38e0b8a3c09affab7a9d39093dcbff6200892bf5be873545b91f2c57f410a981`.
Attempt 2 trace-on was rejected at hash `b0e719bc83dbc4b3a8ad07424ba7bc109482c1750b4076fc3730c659b28b0701`;
ledger, INVALID report, and finalized hashes are
`380db1ee3a9b7f4078f145b823170fa23f98f84add63031954295287a66a7d40`,
`e691ecc952690c5b4e3ea7f7abc80a0aa31cfb1ad35475c34ea75b35bfe0e843`, and
`40c9720525bdc9154f7c9ee6f910a36787202c8213c1da8d3151c0922aad9b27`. Attempt 3 and diagnostic ABBA never ran. The
exact proof error was `COD-374 evidence invalid: selected server output was not delivered`; its message and
Error-prefixed hashes are `d6ebef36d1895073` and `ca0b385822aac2f6`. The successful WebSocket output path recorded
post-send only after `socket.send` returned but failed to attach `delivered: true`; synthetic fixtures had masked the
contract defect. The correction attaches delivery only after successful return, while a throwing send records no false
post-send delivery. Corrected candidate/baseline patch hashes are
`2ac79883807576298fc13460f34ce5c418e0b4fb995470470df9e34497863a3b` and
`ec6b3e713f59c1e9869e1ec9af90b0642a3a2ea09d0b90e5cb27d2842231bd97`; corrected overlay manifest hash is
`d730f0c05ba56d852e451df9b041b5212240ee257706527d0dbea6a96c9672fa`. Attempt 2 independently retained a 56ms
browser long task with `runtime-contaminated` detail `9337373a4dd1a723`. That contamination is terminal and its impact
on tracing overhead remains indeterminate; the contract fix does not make the immutable experiment reusable or valid.
All cleanup was verified, but any future calibration requires a wholly new experiment after commit and review.

Use disposable detached worktrees and the exact candidate runtime. Run complete fixed-size cohorts with tracing disabled and enabled. Do not continue to attribution if the overhead gate fails. Preserve every raw repetition and cleanup proof.

For each fixed attempt plan, create the experiment root once with `mktemp -d /tmp/cod374-XXXXXXXX`, then invoke the
concrete producer with explicit paths (no globs):

```bash
npx tsx scripts/perf/cod-374-runner.mjs \
  --experiment-root /tmp/cod374-EXPERIMENT \
  --repository-root /opt/projects/Codeman/.worktrees/COD-370-active-viewer-terminal-sizing \
  --vendor-manifest /tmp/cod374-inputs/vendor-manifest.json \
  --repetition-plan /tmp/cod374-inputs/attempt-0001-plan.json \
  --overlay-artifact /tmp/cod374-inputs/candidate-overlay.json
```

Repeat only for schedule attempts 2 and 3 after each prior immutable attempt reconciles successfully. A rejected or
contaminated attempt stops the experiment; do not rerun it.

Expected accepted result: enabled p95 is no more than 5ms and no more than 10% worse than disabled. Otherwise publish a measurement-invalid report and stop.

- [ ] **Step 6: Run the complete baseline/candidate diagnostic matrix**

Use exact ABBA order:

1. baseline repetition 1;
2. candidate repetition 1;
3. candidate repetition 2;
4. baseline repetition 2.

Every repetition contains complete 1x and 4x cells and the same unfiltered character count. No selective rerun is allowed. A preflight failure produces zero accepted samples and remains separately disclosed.

- [ ] **Step 7: Generate and inspect the attribution report**

Run the summarizer to a new `0700` `/tmp/cod374-output-*` directory and unused report path. Inspect all component-local
durations, correctness, pane probes, diagnostics, and cleanup. The cross-domain conclusion must always remain
`INCONCLUSIVE ACROSS CLOCK DOMAINS`; COD-374 does not identify a first delayed cross-clock boundary or make a causal
product-fix recommendation.

- [ ] **Step 8: Run final scoped verification**

```bash
npm run test:perf -- test/perf-cod-374-trace.test.ts test/perf-cod-374-report.test.ts \
  test/perf-cod-374-runner.test.ts
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
