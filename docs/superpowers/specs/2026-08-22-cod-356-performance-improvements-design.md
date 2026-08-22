# COD-356 Performance Improvements Design

**Date:** 2026-08-22  
**Issue:** COD-356  
**Status:** Awaiting written-spec review

## Problem

Codeman becomes visibly less responsive as the number of managed sessions grows. Users experience delayed terminal input and, under pressure, apparent repeated characters. Current production evidence points to main-thread starvation rather than proven duplicate browser input delivery:

- Fifteen external CLI sessions each poll tmux every two seconds.
- A poll currently uses `captureActivePaneBuffer()`, which performs three synchronous tmux subprocesses.
- One observed polling pass launched 45 subprocesses and occupied about 503 ms.
- Production event-loop stalls averaged about 1.8 seconds and reached 4.4 seconds.
- Existing focused input ordering, deduplication, WebSocket, and predictor tests pass, so repeated characters must be measured end to end before changing delivery semantics.
- Fresh-browser startup is also expensive: the investigated LAN load requested 69 resources, transferred about 2 MB, decoded about 4.1 MB, and created roughly 3,564 DOM nodes.

The work therefore needs both a high-confidence backend correction and measured investigation of the browser input and startup paths.

## Goals

1. Remove synchronous per-session tmux polling from the Node.js event loop.
2. Reduce polling subprocess volume while preserving Codex and OpenCode working/idle detection and needs-input alerts.
3. Measure and improve terminal keystroke delivery without weakening ordering, deduplication, reconnect, mobile, or predictive-echo behavior.
4. Reduce browser startup and rendering cost where profiling identifies material, low-risk waste.
5. Produce reproducible before-and-after evidence under idle-host and simulated-background-CPU conditions.
6. Keep each optimization independently reviewable, measurable, and reversible.

## Non-goals

- Replacing tmux, xterm.js, or the existing transport architecture wholesale.
- Treating a visual repeated character as proof of duplicate PTY bytes without wire and PTY evidence.
- Reimplementing archived optimizations that already exist, such as state serialization caching, hidden-tab write filtering, frontend layout read/write batching, or build compression.
- Running load generation against the deployed LAN service.
- Optimizing unmeasured code solely because it appears theoretically expensive.

## Delivery Shape

The work will use one isolated branch, `COD-356-performance-improvements`, with staged commits:

1. Benchmark harness and baseline evidence.
2. Asynchronous, bounded tmux activity polling.
3. Terminal input hot-path improvements supported by trace evidence.
4. Browser startup, bundle, and rendering improvements supported by profile evidence.
5. Final benchmark comparison, regression verification, and release notes.

This structure permits bisecting both performance gains and regressions while retaining a single issue and integration target.

## Benchmark Design

### Isolation

Benchmarks run against a temporary local development instance and disposable sessions. The production/LAN service is observed only through read-only health checks and is never the load target. Each run records commit, Node version, browser version, CPU topology, run configuration, and artifact paths.

### Matrix

Every baseline and final comparison uses the same four scenarios:

| Host condition   | Application condition              | Purpose                                   |
| ---------------- | ---------------------------------- | ----------------------------------------- |
| Idle             | Sessions idle                      | Background polling and startup floor      |
| Idle             | Controlled terminal/input activity | Normal interactive latency                |
| Bounded CPU load | Sessions idle                      | Scheduler and event-loop resilience       |
| Bounded CPU load | Controlled terminal/input activity | Worst representative interactive behavior |

Simulated load is bounded, time-limited, and cleaned up by PID. The default profile runs at most `logical CPUs - 1` workers at a 70% duty cycle for 60 seconds, leaving at least one logical CPU outside the worker set for the application and browser. The harness records any platform-driven adjustment and must refuse an unbounded or production-target configuration.

### Measurement protocol

- Run a warm-up before recorded samples.
- Take at least five samples per scenario unless a longer trace supplies statistically stronger evidence.
- Report median, p95, minimum, and maximum, not only a single best run.
- Preserve raw JSON and browser trace artifacts so summaries can be audited.
- Use identical fixtures, viewport, session count, terminal payload, and typing sequence before and after.
- Compare against the branch-point baseline, not a moving deployed service.

### Metrics

Backend and system metrics:

- Node CPU and RSS.
- Event-loop delay median, p95, p99, and maximum.
- `/api/status` and representative session API latency.
- tmux subprocess count, duration, overlap, and failure count.
- terminal broadcast/flush latency and backlog where observable.

Interactive metrics:

- Browser input event to WebSocket send.
- WebSocket receive to PTY write and acknowledgement.
- End-to-end keystroke-to-terminal convergence.
- Wire bytes versus PTY bytes for deterministic repeated-character and burst sequences.
- Missing, duplicate, reordered, and unresolved predicted characters.
- Reconnect and server-restart deduplication outcomes.

Frontend metrics:

- Navigation-to-app-ready and navigation-to-interactive time.
- Resource count, transferred bytes, and decoded bytes.
- Main-thread long-task count and maximum duration.
- DOM node count, layout/paint work, and scripting time.
- First terminal hydration, reload, tab-switch, and long-scrollback readiness.

### Acceptance principle

Correctness is a hard gate. An optimization is rejected if it introduces duplicate, missing, or reordered input; stale activity state; incorrect alerts; terminal corruption; or lifecycle leaks. Performance changes must improve the metric they target without a material regression in the other matrix scenarios. Final reporting will include exact numbers rather than a predetermined percentage claim that the baseline has not justified.

## Backend Activity Polling

### Current flow

Each external CLI session owns a two-second interval. The callback synchronously discovers the active pane, captures styled pane content, and queries pane metadata. With many sessions, these callbacks align and block the single Node.js event loop in a subprocess burst.

### Proposed flow

Introduce an asynchronous plain-text capture capability for activity detection. A shared polling coordinator will:

1. Maintain eligible sessions and their next due time.
2. Stagger due times to avoid synchronized bursts.
3. Apply a small global concurrency limit.
4. Skip a session while its previous capture is still pending.
5. Capture only the bounded recent plain-text lines required by working-frame detection.
6. Deliver results only if the session and poll generation remain current.
7. Back off transient failures without changing the last authoritative activity state.

Styled full-history capture remains available for routes and features that actually require it. Activity polling must not call the three-command full-buffer path.

### Lifecycle and correctness

- Registration starts only for eligible external CLI sessions.
- Stop, delete, respawn, mux replacement, and mode changes invalidate pending generations.
- A late capture cannot update a stopped or replaced session.
- The idle confirmation path reuses the same asynchronous capture mechanism rather than reintroducing a synchronous call.
- Codex and OpenCode frame detection semantics remain unchanged unless a focused test demonstrates a required correction.
- Capture errors are contained and observable; they do not crash the session or create unhandled promise rejections.

## Terminal Input Investigation and Optimization

The browser-to-PTY path will first receive correlation instrumentation in the benchmark harness. A deterministic input sequence will identify each logical input operation and compare:

```text
browser input -> predictor -> WebSocket frame -> server receive -> PTY write -> terminal output -> predictor convergence
```

Implementation changes will be selected from measured costs. Likely candidates include:

- Removing redundant serialization or state/storage work from the immediate input handler.
- Coalescing only operations whose boundaries do not affect terminal semantics.
- Moving noncritical persistence or UI updates out of the keystroke task.
- Bounding acknowledgement bookkeeping and reconnect replay work.
- Correcting a predictor convergence race only if traces reproduce it.

Raw terminal input ordering is never coalesced across control sequences, paste boundaries, Enter, composition events, or protocol-sensitive input. Server-authoritative deduplication remains the correctness boundary across reconnects.

Focused tests cover repeated keys, rapid mixed input, control sequences, paste, CJK composition, mobile fallback, reconnect, delayed acknowledgements, and server restart. Wire and PTY assertions distinguish duplicate transmission from duplicate rendering.

## Frontend Startup and Rendering

Chrome traces and the build manifest will identify the largest startup and main-thread contributors before edits. Candidate improvements include:

- Deferring optional features and modal/controller initialization until first use.
- Loading heavy feature assets only when their feature is opened.
- Reducing redundant session-list DOM construction and layout reads.
- Avoiding terminal creation or hydration until a session becomes visible.
- Splitting independent browser bundles where caching and request overhead produce a net gain.
- Reducing duplicate startup API work that current generation guards do not cover.

Changes preserve desktop and mobile layouts, first load, refresh, reconnect, tab switching, terminal history, document preview, and optional feature entry points. Bundle changes must pass browser syntax/exclusion checks and production build verification.

## Error Handling and Observability

- Benchmark failures retain partial results and state which phase failed.
- Every spawned load worker, browser, server, tmux session, and temporary directory is registered for cleanup.
- Poll coordinator failures use bounded logging/metrics to avoid creating a new hot path.
- Performance instrumentation is test/harness scoped or disabled by default in production.
- Abort and timeout paths are explicit so a hung tmux command cannot accumulate work.

## Test Strategy

Development follows focused test-driven changes because the repository runs inside a managed tmux session and the full suite is unsafe there.

Backend coverage:

- Async capture success, timeout, failure, and stale-generation fencing.
- Global concurrency and per-session overlap limits.
- Staggering and lifecycle cleanup.
- Codex and OpenCode working/idle transitions and needs-input alerts.
- Proof that activity polling no longer invokes synchronous full-buffer capture.

Input coverage:

- Existing ordering, CJK, predictor, reliable deduplication, and route delivery tests.
- New deterministic repeated-character and burst-input byte-identity tests.
- Browser tests for composition, mobile fallback, delayed ACK, reconnect, and visible convergence.

Frontend coverage:

- Startup request and initialization ordering.
- Lazy-feature activation and failure fallback.
- First terminal render, reload, tab switch, and long-scrollback behavior.
- Desktop and mobile browser checks with no page errors or serious console errors.

Repository gates include targeted Vitest files, typecheck, lint, format, lockfile, frontend syntax, browser exclusion, build, and `git diff --check`. The full Vitest suite will not be run from the managed session.

## Rollout and Verification

Before integration, the branch must provide:

1. Auditable baseline and post-change benchmark artifacts for all four scenarios.
2. A table of before/after median and p95 values with environment metadata.
3. Scoped regression results and repository quality gates.
4. A realistic temporary-instance browser smoke with cleanup evidence.
5. Review confirming activity and input correctness boundaries.

Merge, push, deployment, LAN health, and live browser acceptance remain separate steps. No deployment is implied by completing the branch.
