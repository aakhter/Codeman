# COD-356 Performance Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before each completion claim.

**Goal:** Make Codeman remain responsive while typing and switching sessions by removing synchronous tmux polling from the Node event loop, reducing measured input-path work, and deferring measured noncritical frontend startup work, with auditable before/after results on an idle host and under bounded CPU load.

**Architecture:** A standalone benchmark runner owns a disposable Codeman instance, disposable shell probes, bounded CPU workers, browser tracing, statistics, artifacts, and cleanup. Runtime activity detection moves from per-session synchronous timers to one shared asynchronous coordinator with bounded concurrency and stale-result fencing. Input and frontend changes are selected from the baseline traces, then protected by byte-identity, lifecycle, and browser regressions.

**Tech Stack:** TypeScript ESM, Node.js child processes and `perf_hooks`, tmux, Fastify WebSockets, plain browser JavaScript, Playwright Chromium, Vitest, esbuild.

**Safety:** `$CODEMAN_MUX=1` may be set. Never run bare `npm test`, raw unscoped Vitest, `tmux kill-session`, `pkill tmux`, or `pkill node`. Benchmark only a disposable instance on a non-production port and clean up exact registered PIDs/session IDs.

---

## Task 1: Add the reproducible benchmark harness

**Files:**

- Create: `scripts/perf/cod-356-benchmark.mjs`
- Create: `scripts/perf/cod-356-cpu-worker.mjs`
- Create: `scripts/perf/cod-356-input-probe.mjs`
- Create: `scripts/perf/cod-356-metrics.mjs`
- Create: `test/perf-cod-356-harness.test.ts`
- Modify: `package.json`
- Create after measurement: `docs/reports/cod-356/baseline-summary.json`
- Create after measurement: `docs/reports/cod-356/baseline-environment.json`

- [x] **Step 1: Write failing harness-policy and statistics tests**

Cover these pure contracts in `test/perf-cod-356-harness.test.ts`:

- reject port `3002`, non-loopback hosts, unbounded duration, zero samples, and load worker counts that consume every logical CPU;
- accept only `idle` and `cpu` host conditions and `idle` and `interactive` application conditions;
- calculate minimum, median, p95, p99, maximum, and sample count deterministically;
- preserve raw samples in the summary;
- derive at most `logical CPUs - 1` workers, 70% duty cycle, and a 60-second maximum default load window;
- register and clean up exact child PIDs, temporary data directories, browsers, and disposable session IDs;
- refuse to run if the target reports the production instance identity.

- [x] **Step 2: Run the focused test and observe RED**

Run:

```bash
npm run test:perf -- test/perf-cod-356-harness.test.ts
```

Expected: FAIL because the metrics and safety modules do not exist.

- [x] **Step 3: Implement the minimal metrics and safety layer**

`cod-356-metrics.mjs` owns validation, percentile calculation, environment metadata, artifact serialization, and an explicit cleanup registry. `cod-356-cpu-worker.mjs` alternates bounded busy and idle intervals and exits on its deadline or parent disconnect. Do not use broad process matching for cleanup.

- [x] **Step 4: Implement the disposable benchmark runner**

The runner must:

1. create a temporary Codeman data directory and choose an unused loopback port other than `3002`;
2. launch the current checkout with a distinct instance name;
3. place deterministic lightweight `codex` and `opencode` probe shims first in the disposable instance's `PATH`, then create the same 15 external-CLI session fixtures used for every phase without invoking a real agent account;
4. run a warm-up and five recorded samples for the four approved matrix cells;
5. use the input probe to record exact received bytes and framed acknowledgements;
6. use Playwright to record navigation, resources, decoded/transfer sizes, DOM nodes, long tasks, input send/ack/convergence, and page/console errors;
7. sample Node CPU/RSS, `monitorEventLoopDelay`, API latency, and tmux subprocess metrics;
8. emit raw per-run JSON plus compact summary/environment JSON;
9. clean up only its registered resources on success, failure, signal, and timeout.

Add a package script:

```json
"perf:cod356": "node scripts/perf/cod-356-benchmark.mjs"
```

- [x] **Step 5: Run harness tests and dry-run cleanup verification**

Run:

```bash
npm run test:perf -- test/perf-cod-356-harness.test.ts
npm run perf:cod356 -- --dry-run
```

Expected: tests pass; dry run prints the resolved matrix and cleanup plan without starting load or a server.

- [x] **Step 6: Capture the branch-point baseline**

Run:

```bash
npm run perf:cod356 -- --phase before --conditions idle,cpu --samples 5
```

Expected: all four cells complete, compact baseline files are written under `docs/reports/cod-356/`, raw artifacts are stored in the reported temporary artifact directory, and post-run checks show no remaining benchmark server, CPU worker, browser, or disposable session.

- [x] **Step 7: Review baseline evidence before optimizing**

Record in the summary:

- event-loop delay median/p95/p99/max;
- API latency median/p95;
- Node CPU/RSS;
- tmux capture subprocess count, overlap, and duration;
- input send, ACK, and convergence median/p95;
- exact expected/received input bytes and duplicate/missing/reordered counts;
- navigation/app-ready time, long tasks, resource count, transfer/decoded size, DOM nodes, and first-terminal readiness.

If the harness cannot reproduce correct byte identity or stable cleanup, fix the harness before continuing.

- [x] **Step 8: Commit benchmark harness and baseline**

```bash
git add package.json scripts/perf test/perf-cod-356-harness.test.ts docs/reports/cod-356
git commit -m "test(perf): COD-356 establish responsiveness baseline"
```

## Task 2: Add a one-command asynchronous pane-text capture

**Files:**

- Modify: `src/mux-interface.ts`
- Modify: `src/tmux-manager.ts`
- Create: `test/tmux-capture-text.test.ts`

- [x] **Step 1: Write failing async-capture tests**

Test that the new API:

- returns `Promise<string | null>`;
- targets the session's active pane with one plain `capture-pane -p` command;
- does not request styles, cursor geometry, repaint reconstruction, or full history;
- applies a bounded recent-line capture;
- returns `null` for invalid targets, timeout, nonzero exit, and oversized output;
- never invokes `execSync` or `captureActivePaneBuffer`;
- settles asynchronously so a delayed child does not block a zero-delay event-loop sentinel.

- [x] **Step 2: Run the focused test and observe RED**

```bash
npm test -- test/tmux-capture-text.test.ts
```

Expected: FAIL because `capturePaneTextAsync` is absent.

- [x] **Step 3: Implement the minimal async API**

Add this optional interface method:

```ts
capturePaneTextAsync?(muxName: string, opts?: { lastLines?: number; signal?: AbortSignal }): Promise<string | null>;
```

Implement it in `TmuxManager` with an asynchronous child process, a fixed timeout, a small bounded buffer, validated tmux target, and `capture-pane -p -S -N -t <session>`. Targeting the session directly lets tmux select its active pane and avoids the existing `list-panes` lookup. Treat a dead or renamed pane as an ordinary `null` result.

- [x] **Step 4: Run focused verification**

```bash
npm test -- test/tmux-capture-text.test.ts test/tmux-capture-full-history.test.ts
npm run typecheck
```

Expected: async text tests pass and styled/full-history capture remains unchanged.

- [x] **Step 5: Commit the capture primitive**

```bash
git add src/mux-interface.ts src/tmux-manager.ts test/tmux-capture-text.test.ts
git commit -m "perf(tmux): COD-356 add async activity capture"
```

## Task 3: Replace per-session synchronous polling with a shared coordinator

**Files:**

- Create: `src/working-frame-poll-coordinator.ts`
- Modify: `src/session.ts`
- Create: `test/working-frame-poll-coordinator.test.ts`
- Modify: `test/codex-working-detection.test.ts`
- Modify: `test/opencode-working-detection.test.ts`
- Modify: `test/session-cleanup.test.ts`

- [ ] **Step 1: Write failing coordinator tests**

With fake time and controlled promises, require:

- one shared scheduler rather than one interval per session;
- deterministic staggering across the two-second window;
- global concurrency of two captures;
- no overlap for the same session;
- fair progress when more sessions are due than the concurrency cap;
- bounded failure backoff and recovery;
- unregister/stop invalidates late results;
- no unhandled rejection when capture fails;
- a scheduler with zero registrations owns no live timer.

- [ ] **Step 2: Write failing Session integration tests**

Extend Codex and OpenCode coverage to prove:

- activity polling awaits `capturePaneTextAsync`, never `captureActivePaneBuffer`;
- a working frame still calls `_noteExternalWorkingFrame()`;
- a late result after stop, respawn, mux replacement, or generation change is ignored;
- Codex idle confirmation uses the async capture and re-arms on working/unknown frames;
- an input-ready frame emits exactly one turn-end idle event;
- remote-wrapper and local external sessions remain eligible;
- timer cleanup unregisters from the coordinator.

- [ ] **Step 3: Run focused tests and observe RED**

```bash
npm test -- test/working-frame-poll-coordinator.test.ts test/codex-working-detection.test.ts test/opencode-working-detection.test.ts test/session-cleanup.test.ts
```

Expected: new coordinator and async lifecycle assertions fail.

- [ ] **Step 4: Implement the shared coordinator**

`WorkingFramePollCoordinator` owns registrations keyed by stable session identity. It schedules the nearest due item, uses deterministic ID-based offsets, caps active captures at two, and advances due times after settlement. Registration callbacks carry a generation token; unregistering makes every pending completion stale.

- [ ] **Step 5: Integrate Session lifecycle**

Replace `_workingFramePollTimer` with a coordinator registration and a generation-fenced async frame helper. Convert the Codex idle confirmation capture to the same helper. Preserve existing frame classifiers and state-transition semantics. Do not alter route/full-history capture call sites.

- [ ] **Step 6: Run focused verification**

```bash
npm test -- test/working-frame-poll-coordinator.test.ts test/codex-working-detection.test.ts test/opencode-working-detection.test.ts test/session-cleanup.test.ts test/session-listener-wiring.test.ts test/background-agent-wait.integration.test.ts
npm run typecheck
npm run lint
git diff --check
```

- [ ] **Step 7: Run a backend checkpoint benchmark**

```bash
npm run perf:cod356 -- --phase after-poller --conditions idle,cpu --samples 5
```

Require zero synchronous activity captures, no per-session poll overlap, no more than two concurrent captures, and lower event-loop/API p95 in both idle-session cells. If the coordinator regresses interactive metrics materially, stop and diagnose before continuing.

- [ ] **Step 8: Commit the polling change**

```bash
git add src/working-frame-poll-coordinator.ts src/session.ts test/working-frame-poll-coordinator.test.ts test/codex-working-detection.test.ts test/opencode-working-detection.test.ts test/session-cleanup.test.ts docs/reports/cod-356
git commit -m "perf(activity): COD-356 remove blocking tmux polling"
```

## Task 4: Instrument and lock down terminal input byte identity

**Files:**

- Modify: `scripts/perf/cod-356-benchmark.mjs`
- Modify: `scripts/perf/cod-356-input-probe.mjs`
- Modify: `test/input-send-order.test.ts`
- Modify: `test/reliable-input-dedup.test.ts`
- Modify: `test/routes/session-input-delivery.test.ts`
- Modify: `test/codex-predictive-echo.test.ts`
- Create: `test/terminal-input-performance.browser.test.ts`
- Modify: `config/test-suites.ts`

- [ ] **Step 1: Add failing deterministic regression cases**

Cover these exact classes through both WebSocket and HTTP fallback:

- 500 identical printable characters;
- alternating repeated runs such as `aaabbb111___`;
- rapid printable/control/Enter boundaries;
- paste payloads near the configured input limit;
- CJK composition commit without intermediate duplicate sends;
- delayed and lost ACK redelivery with exactly-once PTY bytes;
- reconnect and reload with pending durable records;
- server restart between send and client persistence;
- predictive echo convergence after insert, backspace, cursor edit, and output repaint.

The browser test must compare browser logical input records, serialized WebSocket frames, probe-received PTY bytes, and visible terminal convergence. It must identify which layer duplicated or lost data rather than relying on screenshots.

- [ ] **Step 2: Run focused tests and capture RED or the confirmed invariant**

```bash
npm test -- test/input-send-order.test.ts test/reliable-input-dedup.test.ts test/routes/session-input-delivery.test.ts
npm run test:browser -- test/codex-predictive-echo.test.ts test/terminal-input-performance.browser.test.ts
```

If every new byte-identity test passes, record that repeated characters are a rendering/convergence or starvation symptom and do not change transport semantics speculatively.

- [ ] **Step 3: Add correlation measurements without production hot-path logging**

Use Playwright init scripts to wrap browser input, `WebSocket.send`, ACK handling, and terminal output receipt. The disposable input probe provides authoritative PTY byte timestamps and framed output. Store correlation data only in benchmark artifacts; production logging stays unchanged.

- [ ] **Step 4: Re-run the input-only benchmark checkpoint**

```bash
npm run perf:cod356 -- --phase input-trace --conditions idle,cpu --samples 5 --only input
```

Document the dominant measured input cost and select the smallest optimization in Task 5. Update the plan's Task 5 decision note before editing runtime code.

- [ ] **Step 5: Commit the input evidence and regressions**

```bash
git add scripts/perf test/input-send-order.test.ts test/reliable-input-dedup.test.ts test/routes/session-input-delivery.test.ts test/codex-predictive-echo.test.ts test/terminal-input-performance.browser.test.ts config/test-suites.ts docs/reports/cod-356
git commit -m "test(input): COD-356 trace terminal byte delivery"
```

## Task 5: Optimize the measured terminal input hot path

**Files:**

- Modify as justified: `src/web/public/app.js`
- Modify as justified: `src/web/public/terminal-ui.js`
- Modify as justified: `src/web/routes/ws-routes.ts`
- Modify as justified: `src/session.ts`
- Modify: focused tests selected in Task 4
- Modify: `docs/reports/cod-356/input-findings.md`

- [ ] **Step 1: Record the evidence-backed optimization decision**

Before code, add a short decision table to `input-findings.md` with measured time/allocation/frequency for:

- reliable queue record creation and JSON serialization;
- localStorage persistence on enqueue and ACK;
- connection-indicator updates;
- WebSocket parsing and ACK creation;
- session dedup lookup and PTY write;
- predictor reconciliation and xterm rendering.

Select only contributors that materially affect median or p95. Preserve immediate `pagehide` durability and server-authoritative exactly-once semantics.

- [ ] **Step 2: Write the focused failing test for the selected change**

Examples, chosen only when supported by the trace:

- collapse redundant indicator rendering into one animation-frame update;
- serialize durable state once per bounded burst while retaining synchronous `pagehide` flush;
- avoid scanning all pending deliveries for every single ACK;
- move noncritical predictor/UI reconciliation out of the input task;
- fix a reproduced predictor convergence race without changing wire bytes.

The failing test must assert the avoided operation count and all correctness invariants.

- [ ] **Step 3: Implement the minimal optimization and observe GREEN**

Run the exact focused Node/browser files from Task 4. Do not batch raw input across control, Enter, paste, composition, or protocol boundaries.

- [ ] **Step 4: Benchmark and retain only a demonstrated win**

```bash
npm run perf:cod356 -- --phase after-input --conditions idle,cpu --samples 5 --only input
```

Keep the change only if byte identity remains exact and the targeted median or p95 improves without a material opposite-condition regression.

- [ ] **Step 5: Commit the input optimization**

```bash
git add src/web/public/app.js src/web/public/terminal-ui.js src/web/routes/ws-routes.ts src/session.ts test docs/reports/cod-356/input-findings.md
git commit -m "perf(input): COD-356 reduce typing hot-path work"
```

## Task 6: Profile and defer noncritical frontend startup work

**Files:**

- Create: `scripts/perf/cod-356-asset-report.mjs`
- Modify: `scripts/perf/cod-356-benchmark.mjs`
- Modify: `src/web/public/index.html`
- Create if needed: `src/web/public/lazy-feature-loader.js`
- Modify as justified: optional feature entry modules under `src/web/public/`
- Modify: `scripts/build.mjs`
- Create: `test/frontend-lazy-loading.test.ts`
- Modify: `test/perf-browser.test.ts`
- Modify: `docs/reports/cod-356/frontend-findings.md`

- [ ] **Step 1: Capture the startup profile and asset table**

Report raw, gzip, and Brotli bytes; request start/end; parse/evaluate time; long-task attribution; and whether each module is required before `app-loaded`. Measure desktop and 390px mobile contexts with cold and warm caches.

- [ ] **Step 2: Write failing lazy-loading contract tests**

For each selected optional feature, assert:

- its script is absent from the critical initial request set;
- its first user action loads it once and then executes the original action;
- simultaneous first actions share one promise;
- load failure restores usable UI and reports an actionable error;
- keyboard and inline-handler entry points remain functional;
- core terminal, settings, session creation, and reconnect scripts stay eager.

- [ ] **Step 3: Run focused tests and observe RED**

```bash
npm test -- test/frontend-lazy-loading.test.ts
npm run test:perf -- test/perf-browser.test.ts
```

Expected: selected optional assets are currently requested eagerly.

- [ ] **Step 4: Implement the smallest dependency-safe loader**

Move only profile-proven optional feature modules behind a promise-cached loader. Do not infer dependency order: encode it explicitly and keep a small eager bootstrap for existing global/inline entry points. Update the hash manifest in `scripts/build.mjs` for every changed asset.

- [ ] **Step 5: Verify feature entry and startup behavior**

```bash
npm test -- test/frontend-lazy-loading.test.ts test/app-settings-structure.test.ts test/run-mode-ui.test.ts
npm run test:perf -- test/perf-browser.test.ts
npm run check:frontend-syntax
npm run build
```

- [ ] **Step 6: Benchmark the frontend checkpoint**

```bash
npm run perf:cod356 -- --phase after-frontend --conditions idle,cpu --samples 5 --only frontend
```

Require a lower critical request/decoded-byte or parse/evaluate cost and improved app-ready/long-task metrics. Revert any lazy split whose extra requests make both cold and warm startup worse.

- [ ] **Step 7: Commit frontend startup improvements**

```bash
git add scripts/perf src/web/public scripts/build.mjs test/frontend-lazy-loading.test.ts test/perf-browser.test.ts docs/reports/cod-356/frontend-findings.md
git commit -m "perf(web): COD-356 defer optional startup work"
```

## Task 7: Reduce measured rendering/layout work

**Files:**

- Modify as justified: `src/web/public/app.js`
- Modify as justified: `src/web/public/session-ui.js`
- Modify as justified: `src/web/public/terminal-ui.js`
- Create: `test/frontend-render-budget.test.ts`
- Modify: `test/perf-browser.test.ts`
- Modify: `docs/reports/cod-356/frontend-findings.md`

- [ ] **Step 1: Identify a concrete render bottleneck**

Use the profile to rank session-list rebuilding, terminal initialization/hydration, forced layout, and repeated DOM writes. Record invocation count and main-thread duration. Do not optimize already-batched connection-line reads or already-hidden terminal writes without contrary current evidence.

- [ ] **Step 2: Write a failing operation-count or lifecycle regression**

The test must exercise 15 sessions, tab switches, live updates, and a 100k-line replay. Assert the selected redundant DOM construction/layout/terminal work occurs once per required state change rather than once per unrelated event.

- [ ] **Step 3: Implement and verify the minimal render change**

Preserve focus, selection, scroll intent, group ordering, needs-input styling, desktop/mobile layouts, reload, and stale-generation fencing.

Run:

```bash
npm test -- test/frontend-render-budget.test.ts test/terminal-flush-budget.test.ts test/terminal-scroll-intent.test.ts test/session-sidebar-ux.test.ts
npm run test:browser -- test/tab-activation.browser.test.ts test/session-sidebar-ux.browser.test.ts
npm run check:frontend-syntax
```

- [ ] **Step 4: Benchmark and commit only a demonstrated improvement**

```bash
npm run perf:cod356 -- --phase after-render --conditions idle,cpu --samples 5 --only frontend
git add src/web/public test docs/reports/cod-356/frontend-findings.md
git commit -m "perf(render): COD-356 reduce redundant browser work"
```

## Task 8: Run final before/after verification

**Files:**

- Modify: `docs/reports/cod-356/final-comparison.md`
- Create: `docs/reports/cod-356/final-summary.json`
- Create: `.changeset/cod-356-performance-improvements.md`
- Modify: this plan's checkboxes only

- [ ] **Step 1: Run the identical final matrix**

```bash
npm run perf:cod356 -- --phase after --conditions idle,cpu --samples 5
```

Compare branch-point baseline and final results by matrix cell. Report median/p95 deltas, raw artifact locations, byte identity, cleanup, and any metric that did not improve.

- [ ] **Step 2: Run scoped regressions**

Run the union of touched focused suites, explicitly including:

```bash
npm test -- test/tmux-capture-text.test.ts test/working-frame-poll-coordinator.test.ts test/codex-working-detection.test.ts test/opencode-working-detection.test.ts test/session-cleanup.test.ts test/input-send-order.test.ts test/reliable-input-dedup.test.ts test/routes/session-input-delivery.test.ts test/frontend-lazy-loading.test.ts test/frontend-render-budget.test.ts test/terminal-flush-budget.test.ts
npm run test:browser -- test/codex-predictive-echo.test.ts test/terminal-input-performance.browser.test.ts test/tab-activation.browser.test.ts test/session-sidebar-ux.browser.test.ts
```

- [ ] **Step 3: Run repository gates**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

- [ ] **Step 4: Run realistic temporary-instance smoke**

Use the `codeman-prod-realistic-smoke` skill against the built branch. Require realistic Codex and shell input, tab switching, reload/replay, long scrollback, no page errors or serious console errors, and exact cleanup evidence.

- [ ] **Step 5: Request specification and quality review**

Review the complete branch against the approved design, performance evidence, input correctness, lifecycle safety, and cleanup. Resolve every Critical or Important finding and rerun affected measurements/tests.

- [ ] **Step 6: Add release metadata and commit verification**

```bash
git add docs/reports/cod-356 .changeset/cod-356-performance-improvements.md docs/superpowers/plans/2026-08-22-cod-356-performance-improvements.md
git commit -m "chore: COD-356 document performance release"
```

- [ ] **Step 7: Update Jira without marking Done prematurely**

Comment with branch commits, exact benchmark deltas, test/gate output, smoke artifacts, warnings, and cleanup. Leave COD-356 out of Done until the separately authorized merge/push/deploy and live LAN acceptance complete.
