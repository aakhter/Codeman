# COD-374 Mobile Input Latency Instrumentation Design

## Status

Approved design for a test/benchmark-only investigation. COD-374 blocks COD-370. This work diagnoses the latency boundary; it does not include a performance optimization or production diagnostic mode.

## Problem

The complete COD-370 9px comparator failed its declared 1x performance gate. Baseline p95 was 93.6ms and candidate p95 was 154.1ms. Both candidate tails occurred on input index 7, sequence 8, while completing `qz1a2b3c` about 619ms after the typing window began.

Existing evidence places only the browser-side start of the waterfall:

- key input was accepted;
- logical and durable WebSocket frames were exact and ordered;
- logical-to-WebSocket send took 0.3-0.5ms for the slow samples;
- no typing-window resize, browser long task, process replacement, page error, or serious console error occurred;
- the final timing currently stops only when both tmux pane and xterm show the expected composer token.

That joint endpoint cannot distinguish server input, OpenCode/tmux rendering, server output batching, browser receipt, xterm parsing, or xterm rendering.

## Goals

1. Timestamp every material boundary from browser key dispatch through exact xterm visibility.
2. Bound the first time the exact cumulative token appears in the rendered tmux pane.
3. Correlate input events by the existing durable `(clientId, sequence)` identity.
4. Correlate output without storing terminal text by using event ordinals, byte counts, and bounded hashes.
5. Quantify instrumentation overhead before using traced samples for causal attribution.
6. Preserve all samples, incomplete traces, observer errors, clock uncertainty, correctness results, and cleanup results.
7. Identify the first delayed boundary before proposing any product change.

## Non-goals

- No production diagnostic UI, endpoint, logging mode, or retained telemetry.
- No terminal text, prompts, commands, paths, or responses in trace output.
- No optimization, font decision, or release decision in this issue.
- No selective reruns or removal of slow or incomplete samples.
- No replacement of the existing correctness, identity, provenance, or cleanup contracts.

## Considered Approaches

### A. Bounded test trace collector

Selected. A disposable benchmark server enables a bounded trace collector with a random per-run secret. Normal production startup does not register the collector endpoint. The browser remains instrumented through test-installed wrappers. The server collector records fixed-schema events in memory and the fixture retrieves them after each trial.

Advantages:

- no synchronous filesystem or console output on the measured hot path;
- direct timestamps at server receipt, write, ACK, PTY output, batching, and send boundaries;
- explicit buffer bounds and schema validation;
- no production data collection.

Cost:

- small guarded observer calls exist in server source;
- the benchmark must prove that the enabled observer does not materially alter p95.

### B. Structured JSONL logs

Rejected. It is simpler to implement, but stdout or filesystem writes can create the latency being measured. It also makes bounded retrieval and per-run authorization less precise.

### C. External black-box probes only

Rejected. Browser wrappers, a WebSocket proxy, and `capture-pane` could observe endpoints, but they cannot distinguish server receipt, deduplication, PTY write, terminal event receipt, batching, and actual output send.

## Architecture

### Test trace collector

A focused server module owns a fixed-size in-memory ring. It is disabled unless all of these are true:

- `NODE_ENV` is `test`;
- a disposable trace flag is present;
- a random per-run secret is present;
- the configured capacity is within a hard maximum.

When disabled, trace calls return immediately and no retrieval route is registered. When enabled, a test-only retrieval route requires the random secret, returns a snapshot, and optionally clears the ring. The fixture validates that the route is unavailable without the flag and rejects missing, truncated, overflowed, or malformed traces.

The collector records only:

- run, trial, CPU rate, input index, client ID, sequence, and event ordinal;
- event name and component-local monotonic timestamp;
- epoch timestamp as a cross-check;
- byte count and bounded non-reversible hash when needed;
- boolean delivery/deduplication state;
- ring overflow, observer error, and buffer truncation state.

It never records raw input or output text.

### Browser trace

The existing pre-page WebSocket and keydown wrappers remain the source of browser key, logical, and wire timestamps. The trace adds these boundaries:

1. capture-phase keydown using `performance.now()`;
2. xterm `onData` entry;
3. `_sendInputAsync` entry;
4. durable record allocation and sequence assignment;
5. actual WebSocket `send` entry/return;
6. input ACK receive and durable-record removal;
7. terminal output WebSocket message receipt;
8. `_onSessionTerminal` entry;
9. pending-write queue admission;
10. `terminal.write` entry/return/callback;
11. `onWriteParsed`;
12. `onRender`;
13. first exact token in the xterm buffer after parse;
14. first render event whose buffer contains the exact token;
15. a following animation-frame timestamp labelled as a paint proxy, not proof of physical pixels.

The browser trace uses the exact trial marker and cumulative token only in page memory. Published records contain its trial-local hash and length.

### Server input trace

The WebSocket input route records:

1. raw message callback entry;
2. successful parse and input-frame classification;
3. durable identity extraction;
4. deduplication decision;
5. viewer activation completion;
6. immediately before `Session.write`;
7. immediately after `Session.write`, including its boolean result;
8. immediately before and after ACK send.

Every event is keyed by `(clientId, sequence)`. A duplicate delivery is recorded but does not create a second PTY write.

### Server output trace

The interactive PTY and WebSocket path records:

1. PTY output callback receipt;
2. terminal output handler entry;
3. terminal event emission;
4. WebSocket route `onTerminal` receipt;
5. batch enqueue with size and ordinal;
6. batch flush start;
7. actual output WebSocket send entry/return.

Cursor-addressed OpenCode redraws may split or omit a literal cumulative token in an individual chunk. Therefore output events are correlated using component-local ordinals, times, byte counts, and hashes. Exact token visibility remains independently proven in the rendered pane and xterm.

### Tmux pane observer

The fixture starts an independently pre-armed pane observer before each key. It calls the existing exact-pane `capture-pane` path on a fixed interval and records, for every probe:

- probe start and completion;
- exit status or error;
- token absent/present result;
- probe duration.

Pane visibility is reported as an interval:

- lower bound: completion of the last successful absent probe;
- upper bound: completion of the first successful present probe.

The report must not present a single timestamp with greater precision than this interval. `pipe-pane` is not a substitute because it observes raw PTY output rather than the rendered pane.

## Time Domains and Correlation

Browser `performance.now()`, server `process.hrtime.bigint()`, and harness monotonic time have independent origins and must not be directly subtracted.

The primary evidence uses component-local durations:

- browser key to onData, queue, wire, ACK, output receive, parse, render, and visible;
- server receive to write, ACK, PTY receipt, terminal event, and WebSocket send;
- harness pane-visibility interval and probe cost.

Input joins use `(clientId, sequence)`. Output joins use ordinals, sizes, hashes, and temporal ordering. Repeated ping-pong calibration may estimate cross-domain offsets, but every estimate must include its round-trip uncertainty. A cross-domain conclusion is rejected when its uncertainty is material relative to the attributed delay.

## Measurement Protocol

### Calibration

Before causal profiling, run the same runtime and workload in complete tracing-off and tracing-on cohorts. The tracing design is rejected if tracing-on p95 is worse by either:

- more than 5ms; or
- more than 10%.

Pane polling cost is reported separately. If pane polling alone breaches the gate, it runs in a separate diagnostic cohort and its timestamps are not combined with the acceptance timing distribution.

### Diagnostic matrix

Use the exact frozen COD-370 baseline and candidate revisions, the same OpenCode version, lockfile, vendor assets, viewport, font, payload, and 1x/4x CPU settings. Preserve complete ABBA ordering. Each accepted repetition contains every required sample and every stage.

No sample is accepted when any of these are missing:

- durable identity;
- server receipt/write/ACK state;
- pane visibility interval;
- output receipt/send state;
- xterm parse/render/visible state;
- process identity;
- correctness evidence;
- trace-overflow and observer-error state;
- cleanup proof.

Incomplete repetitions remain in raw evidence with their failure reason and are never mixed into successful statistics.

## Causal Decision Rules

The first delayed boundary determines the next investigation:

- server receive or pre-write delay: input transport/server scheduling;
- write is early but pane is late: OpenCode, PTY, or tmux rendering;
- pane is early but server PTY/output receipt is late: capture/output propagation;
- server output send is early but browser receipt is late: WebSocket/network scheduling;
- browser receipt is early but parse is late: pending-write scheduling or xterm parsing;
- parse is early but render/visibility is late: xterm renderer/compositor path.

If stages overlap within clock or pane-probe uncertainty, the result is inconclusive. The issue must report that limitation instead of selecting a fix.

## TDD and Verification

Tests are written and observed failing before implementation for:

- disabled collector exposes no retrieval route and stores nothing;
- enabled collector rejects a wrong secret;
- ring capacity is bounded and overflow fails the run;
- raw terminal text cannot enter the record schema;
- input events preserve `(clientId, sequence)` ordering and duplicate semantics;
- server write and ACK boundaries remain ordered;
- output batching preserves event ordinals and byte counts;
- browser trace records write, parse, render, and exact first-visible order;
- pane observer reports lower/upper bounds and probe cost;
- clock domains cannot be subtracted without calibration;
- tracing overhead and incomplete-stage gates reject publication;
- cleanup removes the test route, trace state, sessions, processes, sockets, ports, browser contexts, and temporary roots.

Verification uses scoped test files only. The managed-session prohibition against a bare `npm test` remains in force.

## Deliverables

- focused collector and browser/harness tests;
- a complete trace schema and validator;
- tracing-off/on calibration evidence;
- complete baseline/candidate raw traces;
- a report identifying the first delayed boundary or explicitly concluding that attribution is inconclusive;
- a Jira comment linking commits, exact revisions, commands, raw evidence, cleanup, and review outcomes.

No production optimization, merge, push, deployment, or COD-370 release action is part of COD-374.
