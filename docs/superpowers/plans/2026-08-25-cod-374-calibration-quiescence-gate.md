# COD-374 Calibration Quiescence Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immutable, fail-closed host and browser quiescence gates that stop COD-374 calibration before contaminated timing evidence can be collected.

**Architecture:** A focused pure module owns threshold constants, `/proc` CPU/process normalization, and exact evidence validation. The production runner measures the host before allocating runtime resources, then asks the Playwright runtime to measure browser timer drift after readiness but before CPU calibration; the existing summarizer binds both measurements into attempt validation, signatures, and reports.

**Tech Stack:** TypeScript ESM, Node.js `/proc` and `os` APIs, Playwright page evaluation, Vitest, canonical JSON/SHA-256 evidence.

---

## File Map

- Create `scripts/perf/cod-374-quiescence.mjs`: constants, host sampler, process classifier, nearest-rank drift statistics, and exact host/browser evidence validators.
- Create `test/perf-cod-374-quiescence.test.ts`: deterministic unit contracts for CPU deltas, process privacy, thresholds, cardinality, and malformed input.
- Modify `scripts/perf/cod-374-playwright-runtime.ts`: expose one pre-capture browser measurement using a helper-free browser payload.
- Modify `scripts/perf/cod-374-runner.mjs`: run host preflight before overlay allocation, run browser pre-capture before CPU calibration, retain evidence, and stop without retry.
- Modify `scripts/perf/cod-374-summarize.mjs`: validate and bind `quiescence`, render it in reports, and preserve lifecycle/crash conventions.
- Modify `test/perf-cod-374-runner.test.ts`: prove allocation/capture/cleanup behavior and exercise the real browser measurement shape.
- Modify `test/perf-cod-374-report.test.ts`: extend fixtures and adversarial schema/report/signature coverage.
- Modify `docs/reports/cod-374/README.md`: document the gate protocol and frozen thresholds.
- Modify `docs/superpowers/plans/2026-08-24-cod-374-mobile-input-latency-instrumentation.md`: append implementation evidence without rewriting prior immutable experiments.

### Task 1: Pure host and browser quiescence contracts

**Files:**

- Create: `scripts/perf/cod-374-quiescence.mjs`
- Create: `test/perf-cod-374-quiescence.test.ts`

- [ ] **Step 1: Write deterministic failing host contracts**

Add tests importing the not-yet-existing API and asserting the exact normalized boundary:

```ts
import {
  HOST_SAMPLE_COUNT,
  calculateCpuIdlePercent,
  classifyHostProcesses,
  validateHostQuiescence,
} from '../scripts/perf/cod-374-quiescence.mjs';

expect(HOST_SAMPLE_COUNT).toBe(11);
expect(calculateCpuIdlePercent({ idle: 100n, total: 200n }, { idle: 180n, total: 300n })).toBe(80);
expect(() => validateHostQuiescence(hostEvidence({ idlePercent: 79.999 }))).toThrow('host is not quiescent');
expect(() => validateHostQuiescence(hostEvidence({ firstLoad1: 4.001, cpuCount: 8 }))).toThrow('host is not quiescent');
```

Also cover malformed/decreasing counters, fewer than 11 samples, less than 5,000 ms, final load failure, and exact 80%/4.0 pass boundaries.

- [ ] **Step 2: Run the host tests and verify RED**

Run: `npm run test:perf -- test/perf-cod-374-quiescence.test.ts`

Expected: FAIL because `scripts/perf/cod-374-quiescence.mjs` does not exist.

- [ ] **Step 3: Implement constants and pure host validation**

Export these frozen values and evidence functions:

```js
export const HOST_SAMPLE_COUNT = 11;
export const HOST_SAMPLE_INTERVAL_MS = 500;
export const HOST_MIN_WINDOW_MS = 5_000;
export const HOST_MIN_IDLE_PERCENT = 80;
export const HOST_MAX_LOAD_PER_CPU = 0.5;

export function calculateCpuIdlePercent(first, last) {
  const idleDelta = last.idle - first.idle;
  const totalDelta = last.total - first.total;
  if (idleDelta < 0n || totalDelta <= 0n || idleDelta > totalDelta)
    throw new Error('COD-374 quiescence invalid: CPU counters');
  return Number((idleDelta * 100_000n) / totalDelta) / 1_000;
}
```

`validateHostQuiescence` must exact-check keys, finite bounds, count/window, both load boundaries, CPU idle, and a bounded conflict array before returning `{ ...evidence, passed }`.

- [ ] **Step 4: Add privacy-preserving process classification tests and implementation**

Tests must prove the current PID and every ancestor are retained as `allowedAncestor: true`, while unrelated Vitest/Playwright/COD-374/COD-370/Chromium records reject. Assert serialized evidence does not contain the source command or path.

```js
{
  classification: 'vitest',
  commandHash: sha256(commandBytes).slice(0, 16),
  startIdentity: parsedProcStartTicks,
  allowedAncestor: false,
}
```

Cap retained conflicts at 32 and fail closed on `/proc` parse/read errors; never retry a disappearing process.

- [ ] **Step 5: Add browser threshold RED/GREEN contracts**

Test exactly 50 drifts at 20 ms, nearest-rank p95, exact `10/25` pass boundaries, and rejection for p95/max/long-task/page/console/resize/overflow contamination.

```js
export const BROWSER_TICK_COUNT = 50;
export const BROWSER_TIMER_INTERVAL_MS = 20;
export const BROWSER_MAX_P95_DRIFT_MS = 10;
export const BROWSER_MAX_DRIFT_MS = 25;
```

The validator must retain bounded drift summary and diagnostic hashes, not raw error text.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm run test:perf -- test/perf-cod-374-quiescence.test.ts`

Expected: PASS.

```bash
git add scripts/perf/cod-374-quiescence.mjs test/perf-cod-374-quiescence.test.ts
git commit -m "test(perf): COD-374 add quiescence evidence contracts"
```

### Task 2: Real prelaunch host sampler

**Files:**

- Modify: `scripts/perf/cod-374-quiescence.mjs`
- Modify: `test/perf-cod-374-quiescence.test.ts`

- [ ] **Step 1: Write a failing injected-adapter sampler test**

Inject monotonic time, `/proc/stat`, load, inventory, and delay adapters; assert exactly 11 reads, 10 delays of 500 ms, first/final inventories only, and a 5,000 ms window. Add parse-failure and inventory-disappearance cases.

- [ ] **Step 2: Verify RED**

Run: `npm run test:perf -- test/perf-cod-374-quiescence.test.ts -t "samples the host"`

Expected: FAIL because `measureHostQuiescence` is absent.

- [ ] **Step 3: Implement the sampler**

```js
export async function measureHostQuiescence({ currentPid = process.pid, adapters = realHostAdapters } = {}) {
  const ancestorPids = await adapters.ancestorPids(currentPid);
  const samples = [];
  for (let index = 0; index < HOST_SAMPLE_COUNT; index++) {
    samples.push({ atMs: adapters.monotonicNow(), cpu: parseAggregateCpuStat(await adapters.readCpuStat()) });
    if (index < HOST_SAMPLE_COUNT - 1) await adapters.delay(HOST_SAMPLE_INTERVAL_MS);
  }
  return validateHostQuiescence(/* measured summary plus first/final inventories */);
}
```

Use `process.getuid()`, `/proc/<pid>/stat` start ticks, bounded reads, and `os.cpus().length`. Any measurement exception returns structured failed evidence with a safe `measurementErrorHash`; it must not silently pass.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm run test:perf -- test/perf-cod-374-quiescence.test.ts`

Expected: PASS.

```bash
git add scripts/perf/cod-374-quiescence.mjs test/perf-cod-374-quiescence.test.ts
git commit -m "test(perf): COD-374 measure host quiescence"
```

### Task 3: Browser pre-capture measurement

**Files:**

- Modify: `scripts/perf/cod-374-playwright-runtime.ts`
- Modify: `test/perf-cod-374-runner.test.ts`

- [ ] **Step 1: Write failing browser-runtime contracts**

Extend the exact `node --import tsx` loader test to call `measureBrowserQuiescence()`. Assert 50 sequential ticks, a clean pass, observer reset, diagnostics snapshot, and no free `__name` helper. Add injected long-task, drift, resize, overflow, page-error, and evaluation-throw cases.

- [ ] **Step 2: Verify RED**

Run: `npm run test:perf -- test/perf-cod-374-runner.test.ts -t "browser quiescence"`

Expected: FAIL because the runtime has no browser quiescence API.

- [ ] **Step 3: Implement a self-contained static browser payload**

The runtime method must reset its long-task/resize/trace diagnostics, execute 50 chained 20 ms timers, compute nonnegative drift, drain queued observer callbacks, then return the exact browser evidence shape. Pass the code to Playwright as a static content/expression payload; do not serialize a transformed TypeScript closure.

- [ ] **Step 4: Prove the gate precedes CPU calibration**

In the runtime unit fixture, record method order and assert:

```ts
expect(calls).toEqual(['measureBrowserQuiescence', 'cpuProbe:1', 'cpuProbe:rate', 'captureWindow']);
```

- [ ] **Step 5: Run GREEN and commit**

Run: `npm run test:perf -- test/perf-cod-374-runner.test.ts -t "browser quiescence|production loader"`

Expected: PASS.

```bash
git add scripts/perf/cod-374-playwright-runtime.ts test/perf-cod-374-runner.test.ts
git commit -m "test(perf): COD-374 measure browser quiescence"
```

### Task 4: Fail-closed runner lifecycle integration

**Files:**

- Modify: `scripts/perf/cod-374-runner.mjs`
- Modify: `test/perf-cod-374-runner.test.ts`

- [ ] **Step 1: Write host-failure RED**

Inject failed host evidence and spies for materialization/launch/producer. Assert immutable `host-not-quiescent`, lifecycle `preflight`, `browser: null`, zero cells/samples, and zero calls to overlay/runtime/capture.

- [ ] **Step 2: Write browser-failure RED**

Inject passing host evidence plus failed browser evidence. Assert `browser-not-quiescent`, lifecycle `partial`, zero cells/samples, `captureRepetition` never called, runtime and overlay cleanup exactly once, and cleanup-bearing provenance retained.

- [ ] **Step 3: Verify RED**

Run: `npm run test:perf -- test/perf-cod-374-runner.test.ts -t "host-not-quiescent|browser-not-quiescent"`

Expected: FAIL because the runner does not invoke either gate.

- [ ] **Step 4: Implement ordered runner calls**

Call `measureHostQuiescence` only after repository preflight and before overlay materialization. After runtime launch/provenance checks, call `runtime.measureBrowserQuiescence()` immediately before `captureRepetition()`. Attach `{ host, browser, passed }` to every result and convert measurement exceptions into the corresponding terminal rejected evidence.

- [ ] **Step 5: Prove no selective waiting or retry**

Assert each gate is called once, producer transaction records one terminal attempt, and a second producer invocation is rejected by existing schedule semantics.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm run test:perf -- test/perf-cod-374-runner.test.ts`

Expected: PASS.

```bash
git add scripts/perf/cod-374-runner.mjs test/perf-cod-374-runner.test.ts
git commit -m "test(perf): COD-374 gate calibration on quiescence"
```

### Task 5: Schema, signature, and report binding

**Files:**

- Modify: `scripts/perf/cod-374-summarize.mjs`
- Modify: `test/perf-cod-374-report.test.ts`

- [ ] **Step 1: Extend fixtures and write strict-schema REDs**

Add `quiescence` to all canonical attempt fixtures. Assert accepted attempts reject missing/failed gates; host-preflight rejects non-null browser evidence; browser partial rejects failed host evidence or cells; malformed counts/times/hashes/raw commands reject.

- [ ] **Step 2: Add signature and report REDs**

Mutating any host/browser measurement after reservation must fail the signature check. The report must include host idle/load/conflict count and browser p95/max/long-task count, or `browser not allocated`.

- [ ] **Step 3: Verify RED**

Run: `npm run test:perf -- test/perf-cod-374-report.test.ts -t "quiescence"`

Expected: FAIL because the schema and report do not know `quiescence`.

- [ ] **Step 4: Implement exact validation and lifecycle rules**

Add `quiescence` to common exact keys. Reuse validators from `cod-374-quiescence.mjs`; require both pass for accepted/completed attempts, host fail plus browser null for `host-not-quiescent`, and host pass/browser fail for `browser-not-quiescent`. Include it in `preflightSignature`/runtime evidence signatures without allowing caller assertions to replace measurements.

- [ ] **Step 5: Render the audit line**

Append a bounded report fragment such as:

```text
quiescence host idle 84.125%, load 2.1/2.4 <= 4, conflicts 0; browser drift p95 2.1ms/max 6.4ms, long-tasks 0; passed true
```

- [ ] **Step 6: Run GREEN and commit**

Run: `npm run test:perf -- test/perf-cod-374-report.test.ts`

Expected: PASS.

```bash
git add scripts/perf/cod-374-summarize.mjs test/perf-cod-374-report.test.ts
git commit -m "test(perf): COD-374 bind quiescence evidence"
```

### Task 6: Protocol documentation and manifest closure

**Files:**

- Modify: `scripts/perf/cod-374-summarize.mjs`
- Modify: `test/perf-cod-374-report.test.ts`
- Modify: `docs/reports/cod-374/README.md`
- Modify: `docs/superpowers/plans/2026-08-24-cod-374-mobile-input-latency-instrumentation.md`

- [ ] **Step 1: Update the exact harness manifest**

Add `scripts/perf/cod-374-quiescence.mjs` and `test/perf-cod-374-quiescence.test.ts` to the frozen harness file list and update manifest tests so runtime evidence cannot omit the new implementation.

- [ ] **Step 2: Document the protocol**

Record all host/browser thresholds, ordering, privacy fields, fail-closed reason codes, one-attempt/no-retry behavior, and the rule that prior invalid experiments remain immutable.

- [ ] **Step 3: Run focused docs/manifest checks and commit**

Run: `npm run test:perf -- test/perf-cod-374-report.test.ts test/perf-cod-374-runner.test.ts test/perf-cod-374-quiescence.test.ts`

Expected: PASS.

```bash
git add scripts/perf/cod-374-summarize.mjs test/perf-cod-374-report.test.ts docs/reports/cod-374/README.md docs/superpowers/plans/2026-08-24-cod-374-mobile-input-latency-instrumentation.md
git commit -m "docs: COD-374 document calibration quiescence gate"
```

### Task 7: Full scoped verification and review

**Files:**

- Verify all files changed by Tasks 1–6.

- [ ] **Step 1: Run focused performance and integration suites sequentially**

```bash
npm run test:perf -- test/perf-cod-374-quiescence.test.ts test/perf-cod-374-report.test.ts test/perf-cod-374-runner.test.ts
npm test -- test/routes/ws-routes.test.ts -t "COD-374"
npm test -- test/session-terminal-trace.test.ts test/reliable-input-dedup.test.ts
```

Expected: all scoped tests PASS; no bare full-suite command.

- [ ] **Step 2: Run real timing-sensitive gates standalone with idle checks**

```bash
npm run test:mobile -- test/mobile/cod374-input-latency.test.ts
npm run test:mobile -- test/mobile/cod374-input-latency.test.ts
npm run test:mobile -- test/mobile/terminal-input-browser.test.ts
```

Expected: each command PASS independently with exact cleanup; never overlap these processes.

- [ ] **Step 3: Run static gates**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
node --check scripts/perf/cod-374-quiescence.mjs
node --check scripts/perf/cod-374-runner.mjs
node --check scripts/perf/cod-374-summarize.mjs
git diff --check
```

Expected: zero errors; only previously documented unrelated warnings may remain.

- [ ] **Step 4: Request independent spec and quality review**

Reviewers must verify threshold math, `/proc` privacy, exact ordering before allocation/capture, lifecycle evidence, cleanup, signature/report binding, and absence of any wait/retry path. Resolve every Critical/Important finding with a new RED/GREEN cycle.

- [ ] **Step 5: Final verification commit**

```bash
git status --short
git log -1 --oneline
git diff --check HEAD~1..HEAD
```

Expected: clean worktree, conventional COD-374 commits, and no calibration artifacts or experiment roots created by this implementation.
