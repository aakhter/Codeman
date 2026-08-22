# COD-356 terminal input findings

## Result

The corrected input trace preserved byte identity in all 160/160 recorded trials: 5 samples × 8 trials in each of
four idle/CPU and idle/interactive cells, with zero missing, duplicate, or reordered PTY bytes. The deterministic
regressions additionally cover repeated runs, printable/control/Enter record boundaries, near-limit paste, real CJK
composition, delayed and lost ACK redelivery, socket reconnect, reload, HTTP fallback, and predictive-echo edits.

Repeated characters are therefore not reproduced in the ordinary browser-record, serialized-frame, or PTY transport
layers. Steady input-to-first-visible medians are 11.3-15.9 ms. The remaining large tail is a cold idle-session
lifecycle cost, not normal transport duplication and not evidence for weakening durable delivery semantics.

One narrower correctness gap remains explicitly characterized: if the server restarts after applying input but before
the browser receives/persists its ACK, process-local `Session._appliedInputSeq` state is lost and a durable retry can
apply a second PTY copy. The restart regression records that boundary; it does not claim exactly-once delivery across
server restart. Normal reconnect/reload and delayed/lost ACK paths remain exactly once at the PTY.

## Input-trace evidence

Runtime and harness revision: `f329e930e33340c65cdb32a585ac36200d8d9e1e`

Report set: `74561fcebc6182099da168e8ed9e7d3b`

Raw artifacts: `/tmp/cod356-artifacts-input-trace-GsKXYV`

All values are milliseconds. Cold is trial 1 of each recorded sample; steady is trials 2-8. Each value is median
(p95). `convergence` is WebSocket send to the first successful, pre-armed current-token observation in the real xterm
buffer. The observer runs on `onWriteParsed`; a unique token and pre-send absence check isolate each trial without
resetting client state independently of the tmux pane.

| Cell             | Profile |  Send call | Browser ACK |   Probe PTY |   Convergence | Receipt → output start | Output duration | Output end → visible | Long-task overlap |
| ---------------- | ------- | ---------: | ----------: | ----------: | ------------: | ---------------------: | --------------: | -------------------: | ----------------: |
| idle-idle        | cold    |  1.8 (2.1) |   0.7 (1.9) |   6.1 (6.3) | 302.5 (358.0) |          292.1 (345.0) |       0.0 (0.1) |           1.6 (16.6) |               0/5 |
| idle-idle        | steady  |  1.6 (2.7) |   0.7 (1.3) |   6.0 (9.3) |   12.1 (28.0) |              0.4 (0.9) |       0.2 (0.3) |            0.8 (1.9) |              0/35 |
| idle-interactive | cold    |  2.1 (2.3) |   1.1 (2.3) |   6.9 (7.5) |   17.0 (57.7) |              0.7 (7.3) |       0.3 (0.5) |           1.4 (26.2) |               0/5 |
| idle-interactive | steady  |  1.6 (3.4) |   0.7 (4.3) |  5.8 (11.1) |   11.3 (52.2) |              0.3 (0.7) |       0.1 (0.2) |            0.5 (2.1) |              0/35 |
| cpu-idle         | cold    |  4.0 (7.6) |   4.2 (7.1) | 16.3 (24.2) | 434.1 (448.6) |          370.9 (397.5) |       0.1 (0.1) |          40.7 (50.1) |               0/5 |
| cpu-idle         | steady  |  2.8 (5.2) |   2.5 (9.1) | 12.6 (23.7) |   15.1 (44.1) |             0.8 (17.7) |       0.2 (0.7) |            0.8 (6.0) |              4/35 |
| cpu-interactive  | cold    | 8.9 (15.0) | 10.0 (11.6) | 33.8 (42.3) |   36.4 (92.5) |              3.5 (4.7) |       0.3 (0.7) |           5.2 (72.7) |               1/5 |
| cpu-interactive  | steady  |  3.0 (6.9) |   2.2 (7.5) | 13.3 (21.8) |   15.9 (37.1) |              0.7 (2.4) |       0.2 (0.4) |            0.9 (4.4) |              2/35 |

The synchronous input, ACK, terminal-handler, flush, and direct-write wrapper durations are instrumented upper bounds:
they include the original call plus measurement overhead. The xterm write callback normally precedes `onWriteParsed`,
so the signed visible-to-drain values are negative; drain is reported separately and is never substituted for first
visibility.

All five idle-idle and five CPU-idle cold trials used the direct-terminal-write boundary; every other recorded trial
used `flushPendingWrites`. The cold idle-session delay is overwhelmingly receipt-to-direct-write start (292.1 ms idle,
370.9 ms under CPU load). Output-call duration itself is at most 0.1 ms median, and none of those ten slow cold trials
overlapped a browser long task. Across the entire matrix only 7/160 trials overlapped a long task. The corrected
boundaries therefore do not support the earlier `_safeYield` or general browser-starvation causal claim.

The two CPU cohorts each started all 7/7 fixed workers and met the hard 60-second deadline. Their remaining margins
were 9,662.8 ms (CPU-idle) and 7,727.9 ms (CPU-interactive). All page-error and serious-console arrays were empty.
Cleanup reported no surviving exact PID, no disposable session, a closed browser, matched generated assets and
provenance, and no warning or error.

## Benchmark validity correction

The rejected trace cleared only the browser xterm between trials while tmux continued producing incremental screen
deltas. In the minimal real-probe reproduction, the probe event, WebSocket terminal payload, terminal handler, and
queued xterm write all contained the exact trial-2 token. The payload then applied `ESC[2S ESC[A` against the locally
cleared screen, and the `onWriteParsed` buffer contained only the ACK. The failing boundary was benchmark-induced
client/pane state divergence, not transport loss. The corrected harness preserves the authoritative screen state and
uses unique tokens plus trace indices. It passed 24 sequential actual-probe observations and 24 alternating queued/direct
write observations with zero misses and no retained observer listener or timer.

## Dominant cost and Task 5 decision

Do not add an input batching change, weaken ACK persistence, or add the previously proposed `_safeYield` microtask fast
path: steady rendering is already 11.3-15.9 ms median, flush/output calls are sub-millisecond, and the slow cold trials
do not correlate with long tasks.

The smallest evidence-backed Task 5 performance target is the cold active-session buffer-load lifecycle. Instrument and
then eliminate the late full-buffer/direct-write replay that holds first live output for roughly 292-371 ms after the
terminal handler has already received it. The first experiment should be narrowly generation-scoped: prove whether an
auto-selected already-active session returns input-ready while its canonical buffer load is still in flight, and prevent
that load from overtaking the first live output without asymmetrically clearing, reordering, or duplicating pane data.
Retain a runtime change only if a focused lifecycle regression preserves history/live-output ordering and a fresh
after-input matrix lowers cold idle convergence without regressing steady, interactive, CPU, or byte-identity results.

Treat the server-restart dedup window as a separate correctness task: define a persisted dedup epoch/high-water mark and
prove crash/restart boundaries against a disposable process and PTY. It must not be folded into the performance change.

## Scoped regression evidence

- `npm test -- test/input-send-order.test.ts test/reliable-input-dedup.test.ts test/routes/session-input-delivery.test.ts`
  passes 3 files and 37 tests.
- `npm run test:browser -- test/codex-predictive-echo.test.ts test/terminal-input-performance.browser.test.ts` passes
  2 files and 24 tests.
- `npm run test:perf -- test/perf-cod-356-harness.test.ts` passes 1 file and 92 tests.
- The browser regression starts a disposable Codeman child and real tmux-backed probe, drives production input and CJK
  handlers, observes real WebSocket and HTTP endpoints, reads authoritative PTY bytes, and inspects the actual xterm
  buffer. It uses no in-page transport, server-dedup, PTY, or visible-output substitute.
