# COD-374 Calibration Quiescence Gate Design

## Purpose

Prevent COD-374 performance calibration from starting or continuing when host or browser contention can invalidate input-latency evidence. The gate is normalized to the host CPU count, records every observation in immutable attempt evidence, and fails closed without selective retry.

The gate does not salvage or reinterpret prior experiments. In particular, experiments `ec09d0f327f75693` and `12d34b38dcd01822` remain terminally invalid.

## Scope

This change extends only the COD-374 diagnostic runner, report schema, tests, and protocol documentation. It does not change Codeman product behavior, terminal transport, WebSocket framing, xterm rendering, or the ABBA acceptance thresholds.

No calibration or ABBA run is part of implementation verification. A new experiment may be authorized only after the gate implementation is committed, independently reviewed, and fully verified.

## Chosen Architecture

The runner applies two ordered gates:

1. A prelaunch host gate before browser/server/runtime allocation.
2. A pre-capture browser gate after the exact runtime is ready but before CPU calibration or sample collection.

Both gates use fixed, pre-registered normalized thresholds. They produce structured measurements rather than caller-supplied booleans. A failed gate creates immutable rejected evidence and stops the experiment schedule.

### Rejected alternatives

- Host-specific fixed load limits are simpler but bind the protocol to the current eight-CPU machine.
- Adaptive or rolling baselines are portable but make acceptance depend on mutable history and can normalize a persistently overloaded host.
- Silently waiting until the host becomes idle would permit selective timing and is therefore forbidden.

## Prelaunch Host Gate

The runner samples the host for five seconds before allocating the overlay runtime, server, browser, tmux session, or OpenCode process.

### Sampling

- Collect 11 monotonic samples at 500 ms intervals, covering at least 5,000 ms from the first to final sample.
- Read aggregate CPU counters from `/proc/stat` for every sample.
- Read `os.loadavg()` at the first and final sample.
- Enumerate current-UID processes at the first and final sample from `/proc`, retaining only bounded hashed identities and classifications.
- Record CPU count from `os.cpus().length`.

### Thresholds

The host gate passes only when all conditions hold:

- Aggregate CPU idle percentage across the complete sample window is at least 80%.
- Both observed one-minute load values are no greater than `cpuCount * 0.5`.
- No unrelated conflicting process exists at either inventory boundary.

Conflicting processes are current-UID processes classified as Vitest, Playwright test runner, COD-374 runner, COD-370/COD-374 disposable runtime, or Chromium launched by such a runner. The current runner PID and its ancestor chain are allowed. An explicitly reserved runtime from the same attempt is impossible at this stage and therefore never allowlisted.

The process evidence contains only classification, a SHA-256/16 command identity, PID start identity, and whether the process is an allowed ancestor. Raw command lines and filesystem paths are forbidden.

### Failure behavior

A host-gate failure produces a rejected `preflight` attempt with:

- failure code `host-not-quiescent`;
- structured quiescence evidence;
- zero cells and samples;
- no runtime allocation claims;
- no cleanup claims for unallocated resources;
- the normal clean-repository preflight proof when that proof was already established.

The runner must not allocate product/runtime resources, wait for a better window, or invoke the producer again.

## Pre-capture Browser Gate

After the exact runtime reaches its existing readiness barrier and tracing hooks are installed, the runner measures browser scheduling health before CPU calibration and input sampling.

### Sampling

- Reset the browser long-task observer before the gate.
- Schedule 50 sequential 20 ms timers using `setTimeout` and `performance.now()`.
- Record nonnegative timer drift for every tick as `actualIntervalMs - 20`.
- Observe browser long tasks over the same gate window.
- Snapshot page and serious-console diagnostics immediately after the final tick.

### Thresholds

The browser gate passes only when all conditions hold:

- Timer-drift p95 is at most 10 ms using the existing nearest-rank p95 convention.
- Maximum timer drift is at most 25 ms.
- No browser long task is observed.
- No page error, serious console error, resize event, or trace overflow is observed.

### Failure behavior

A browser-gate failure produces a rejected `partial` attempt with:

- failure code `browser-not-quiescent`;
- complete host- and browser-gate evidence;
- zero cells and samples;
- exact runtime/process provenance measured up to failure;
- aggregate cleanup proof for every allocated resource.

The runner performs cleanup once, publishes the rejected attempt, and stops the schedule. It must not begin CPU calibration, collect a sample, or retry the gate.

## Evidence Schema

Every attempt receives a `quiescence` object with exact keys:

- `host`: CPU count, monotonic start/end, sample count, aggregate idle percentage, first/final one-minute load, and bounded conflicting-process records.
- `browser`: nullable for host-preflight rejection; otherwise timer interval, tick count, p95 drift, maximum drift, long-task entries, and bounded diagnostic hashes.
- `passed`: true only when every required gate passed.

Accepted launched attempts require complete passing host and browser evidence. A host-preflight rejection requires complete failed host evidence and `browser: null`. A browser-gate partial requires passing host evidence and complete failed browser evidence.

All numbers must be finite, nonnegative, and bounded. CPU idle is limited to 0–100; sample/tick counts and timing windows are exact; arrays have fixed maximum cardinalities. Canonical JSON and report rendering include the gate evidence. Attempt signatures bind the evidence so it cannot be substituted between reservations or repetitions.

## Report Behavior

The Markdown report adds a quiescence line to every attempt audit:

- host idle percentage and load limit/result;
- conflict count;
- browser drift p95/max and long-task count, or `not allocated`;
- overall gate result.

An invalid quiescence result is reported as measurement-invalid evidence. It never contributes latency samples or overhead statistics.

## Error Handling and Recovery

- `/proc` read or parse failure is a host-gate failure, not permission to proceed.
- A process that disappears during inventory is retained as a bounded observation and does not cause an unbounded retry.
- Browser evaluation failure is a browser-gate failure followed by normal aggregate cleanup.
- Cleanup failure is recorded independently from the primary gate failure.
- Transaction crash recovery and append-only experiment semantics remain unchanged.
- No gate may sleep until conditions improve, discard an observation, or create a replacement attempt under the same experiment.

## Testing Strategy

TDD starts with focused failing contracts:

1. Host sampler computes normalized CPU idle from deterministic `/proc/stat` counter deltas.
2. Host gate rejects idle below 80%, either load boundary above `cpuCount * 0.5`, conflicting processes, malformed counters, and incomplete timing/cardinality.
3. Current runner ancestors are allowlisted while unrelated matching processes are rejected without retaining raw commands.
4. Browser gate accepts exactly 50 clean timer samples and rejects p95 above 10 ms, max above 25 ms, any long task, diagnostics, resize, or overflow.
5. Host failure proves zero runtime allocation and publishes immutable rejected preflight evidence.
6. Browser failure proves no CPU calibration/sample capture, performs cleanup once, and publishes cleanup-bearing partial evidence.
7. Accepted attempts without complete passing quiescence evidence fail strict validation.
8. Reports render the exact gate measurements and rejected reason.
9. Crash recovery, schedule order, provenance binding, and prior accepted/rejected attempt contracts remain green.

Verification remains scoped per repository safety rules: focused Vitest files, COD-374 performance suites, two standalone real mobile trace runs, browser regression, typecheck, lint, format, lockfile, syntax, diff checks, and independent review. No bare full-suite command is permitted.

## Acceptance Criteria

- The gate uses measured host/browser state, not plan values or caller assertions.
- Thresholds are normalized and exactly enforced.
- Failure is immutable, fail-closed, and terminal for the experiment.
- No selective wait or retry path exists.
- No raw command, path, terminal content, or secret is retained.
- Existing calibration and ABBA behavior is unchanged after both gates pass.
- All focused, real-browser, static, and independent review gates pass before any new experiment is authorized.
