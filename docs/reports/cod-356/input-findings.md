# COD-356 terminal input findings

## Result

The corrected input trace preserved byte identity in all 160/160 recorded trials: 5 samples × 8 trials in each of
four idle/CPU and idle/interactive cells, with zero missing, duplicate, or reordered PTY bytes. The deterministic
regressions additionally cover repeated runs, printable/control/Enter record boundaries, near-limit paste, real CJK
composition, delayed and lost ACK redelivery, socket reconnect, reload, HTTP fallback, and predictive-echo edits.

Repeated characters are therefore not reproduced in the ordinary browser-record, serialized-frame, or PTY transport
layers. Steady input-to-first-visible medians are 12.0-16.3 ms. The remaining large tail is a cold idle-session
lifecycle cost, not normal transport duplication and not evidence for weakening durable delivery semantics.

One narrower correctness gap remains explicitly characterized: if the server restarts after applying input but before
the browser receives/persists its ACK, process-local `Session._appliedInputSeq` state is lost and a durable retry can
apply a second PTY copy. The restart regression records that boundary; it does not claim exactly-once delivery across
server restart. Normal reconnect/reload and delayed/lost ACK paths remain exactly once at the PTY.

## Input-trace evidence

Runtime and harness revision: `c0a38ae67006f3eaa0520d0e4aec16d634c31c7b`

Report set: `6d839b4d536f06d07f195e84b4915ff7`

Raw artifacts: `/tmp/cod356-artifacts-input-trace-0KNC4W`

All values are milliseconds. Cold is trial 1 of each recorded sample; steady is trials 2-8. Each value is median
(p95). `convergence` is WebSocket send to the first successful, pre-armed current-token observation in the real xterm
buffer. The observer runs on `onWriteParsed`; a unique token and pre-send absence check isolate each trial without
resetting client state independently of the tmux pane.

| Cell             | Profile | Send call | Browser ACK |   Probe PTY |   Convergence | Receipt → output start | Output duration | Output end → visible | Long-task overlap |
| ---------------- | ------- | --------: | ----------: | ----------: | ------------: | ---------------------: | --------------: | -------------------: | ----------------: |
| idle-idle        | cold    | 3.1 (4.7) |   0.9 (5.1) |  7.4 (16.1) | 360.7 (393.0) |          337.7 (376.5) |       0.1 (0.2) |           2.0 (18.8) |               0/5 |
| idle-idle        | steady  | 1.5 (3.0) |   0.6 (2.8) |  6.1 (13.4) |   12.0 (35.6) |              0.4 (0.9) |       0.1 (0.3) |            0.6 (2.4) |              0/35 |
| idle-interactive | cold    | 2.4 (2.7) |   1.0 (1.2) |  7.9 (36.5) |   20.9 (33.0) |              0.8 (8.0) |       0.3 (0.5) |            1.5 (1.8) |               0/5 |
| idle-interactive | steady  | 1.7 (3.4) |  0.7 (27.2) |  7.3 (34.4) |   12.3 (88.2) |              0.4 (1.2) |       0.1 (0.3) |            0.7 (2.0) |              0/35 |
| cpu-idle         | cold    | 4.9 (7.4) |  4.4 (11.0) | 16.9 (32.4) | 397.0 (545.5) |          378.1 (522.5) |       0.2 (0.6) |          10.0 (18.0) |               0/5 |
| cpu-idle         | steady  | 3.3 (8.0) |   2.8 (8.3) | 14.6 (28.9) |   16.3 (28.2) |              1.2 (9.0) |       0.2 (0.5) |            1.0 (5.5) |              2/35 |
| cpu-interactive  | cold    | 4.9 (8.1) |   3.3 (5.2) | 23.2 (30.8) |   32.8 (33.8) |             9.2 (16.7) |       0.6 (0.8) |            4.3 (8.4) |               0/5 |
| cpu-interactive  | steady  | 3.3 (8.8) |   2.3 (5.6) | 13.2 (25.9) |   15.5 (21.2) |              0.8 (4.1) |       0.2 (0.7) |            0.9 (5.2) |              1/35 |

The synchronous input, ACK, terminal-handler, flush, and direct-write wrapper durations are instrumented upper bounds:
they include the original call plus measurement overhead. The xterm write callback normally precedes `onWriteParsed`,
so the signed visible-to-drain values are negative; drain is reported separately and is never substituted for first
visibility.

All five idle-idle and five CPU-idle cold trials used the direct-terminal-write boundary; every other recorded trial
used `flushPendingWrites`. The cold idle-session delay is overwhelmingly receipt-to-direct-write start (337.7 ms idle,
378.1 ms under CPU load). Output-call duration itself is at most 0.2 ms median, and none of those ten slow cold trials
overlapped a browser long task. Across the entire matrix only 3/160 trials overlapped a long task. The corrected
boundaries therefore do not support the earlier `_safeYield` or general browser-starvation causal claim.

The two CPU cohorts each started all 7/7 fixed workers and met the hard 60-second deadline. Their remaining margins
were 4,664.0 ms (CPU-idle) and 5,197.8 ms (CPU-interactive). All page-error and serious-console arrays were empty.
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
Every recorded timeline also carries bounded hashes, byte lengths, timestamps, and the exact current correlation token
for its selected output frame and terminal write. Exact selection is time-ordered and fails closed rather than borrowing
an adjacent terminal event; all 160 raw timelines pass that audit.

## Dominant cost and Task 5 decision

### Hot-path decision table

The table separates directly instrumented upper bounds from code-derived allocation and call frequency. Browser timings
are medians across the accepted 160-trial matrix unless a range is shown. The measured input payload is consistently
36 bytes. Its recorded reliable WebSocket envelope is 90-92 bytes in the input-trace matrix and 90-91 bytes in the final
after-input matrix; the sequence-number/envelope digit width accounts for the variation.

| Boundary                                    | Measured time / allocation                                                                                                                                                        | Frequency                                                                                                     | Decision                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Reliable queue record + WebSocket JSON      | Included in the 1.5-4.9 ms `_sendInputAsync` call medians; one six-field in-memory record and one 90-92-byte observed JSON frame for a 36-byte payload                            | Once per raw input record; retry only after an ACK timeout/reconnect                                          | Keep: sub-frame and required for ordered durable delivery                              |
| localStorage enqueue / ACK persistence      | Enqueue schedules one 250 ms debounced snapshot; an ACK that empties the queue writes one bounded `{seqs,pending}` JSON snapshot immediately                                      | At most four scheduled writes/second while typing, plus the final ACK and synchronous `pagehide`/hidden flush | Keep: not on the observed 338-378 ms boundary; immediate unload durability is required |
| Connection descriptor / indicator           | Included in input and ACK handler bounds; descriptor is allocation-only and identical tuples skip DOM writes                                                                      | Once on enqueue and once on ACK                                                                               | Keep: input and ACK medians remain below one frame                                     |
| WebSocket parse + ACK handling              | ACK handler medians are 0.6-4.4 ms across the four cells (CPU included)                                                                                                           | One parse and ACK per reliable record                                                                         | Keep: sub-frame and server-authoritative delivery depends on it                        |
| Server dedup lookup + PTY write             | Send-to-probe medians are 6.1-16.9 ms; exact probe bytes were 5,760/5,760                                                                                                         | Once per new `(clientId, seq)`; retries dedup                                                                 | Keep: exact and below the cold replay delay                                            |
| Predictor reconciliation + xterm live write | Steady convergence is 12.0-16.3 ms; terminal receipt, flush, and output-call medians are 0.1-1.2 ms                                                                               | Once per output frame, with render-budgeted flushes                                                           | Keep: steady controls are already within one frame                                     |
| Cold canonical buffer lifecycle             | Live output receipt precedes the direct full-buffer write by 337.7 ms idle and 378.1 ms under CPU load; the selection path contains one fixed 400 ms TUI resize-settle allocation | Once on the first auto-selected session load; absent from awaited interactive controls                        | Optimize: this is the only material contributor                                        |

### Root-cause boundary

The late-replay hypothesis is confirmed. Boot restoration starts `selectSession(..., { auto: true })`, publishes
`activeSessionId`, and opens the WebSocket before its fixed 400 ms TUI resize-settle and canonical terminal fetch have
completed. Input and live output can therefore advance while the original selection still owns a full-buffer replay.
That replay contains the new live token and becomes its first visible render hundreds of milliseconds after the live
terminal event was received. The interactive control performs a real awaited tab switch and has no such overlap.

An intermediate trace incorrectly attributed the late replay to the external CLI's 3-second startup
`needsRefresh`. The final pinned trace disproves that ownership: in idle-idle sample 1, trial 1, input was sent at
1,151.1 ms, live output was received at 1,165.6 ms, and a 1,630-byte direct full-buffer write began at 1,487.3 ms.
This operation occurs about 1.5 seconds after page start, before the 3-second server event can fire. It is the original
selection's canonical replay, not a startup-refresh response.

### Rejected Task 5 experiment

Runtime `f58f3ea9eda937373de89ded6620e08b7ef70b59` tagged only the external CLI's startup refresh with a startup generation
and fenced that replay per browser client and selection generation. Focused tests proved that an active client skipped
or discarded a stale tagged replay, a passive client retained one full history replay, two clients diverged correctly,
tab switches fenced stale responses, and legacy untagged backpressure recovery remained unconditional. The earlier
same-selection waiter, cancel-on-input experiment, and unbounded 250 ms grace were removed before this final run.

The one final 160-trial matrix (5 samples x 8 trials in each of four cells) was mechanically valid but did not improve
the actual cold owner, so the runtime was rejected and reverted by `02bfc38a`. No Task 5 runtime optimization is retained.

Runtime measured: `f58f3ea9eda937373de89ded6620e08b7ef70b59`

Report set: `b623aa38519d3f365957c4adbcecf765`

Raw artifacts: `/tmp/cod356-artifacts-after-input-uSH5gZ`

#### Task 5 run ledger

Every Task 5 benchmark attempt is listed below. Only the final complete `uSH5gZ` run supplies the comparison table and
canonical after-input report pair. None of the first three attempts contributes a sample to the final metrics, and no
selective samples were combined across runs.

| Raw directory                              | Runtime revision                           | Hypothesis                                                                | Recorded coverage                                                     | Outcome                                                                                                                                  |
| ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/tmp/cod356-artifacts-after-input-mGfPUv` | `0b3e99681ff3baf52ce97257f7f423739f733c15` | Same-active selection waits for its in-flight canonical load              | Complete: 20 recorded samples, 160 trials                             | Rejected: cold idle direct replay remained; no material target improvement                                                               |
| `/tmp/cod356-artifacts-after-input-juV0bz` | `d06a581b1e9b3cf63b415bef10e82435e521fba5` | Input cancels the pending startup refresh before it is emitted            | Complete: 20 recorded samples, 160 trials                             | Rejected: idle cold changed only 360.7 to 335.7 ms and CPU cold regressed from 397.0 to 437.6 ms                                         |
| `/tmp/cod356-artifacts-after-input-vSPxlT` | `fa75cc5d4fcf50b6c00408722663bd22e67334d4` | Add an unbounded 250 ms startup-refresh grace                             | Incomplete: 3 of 20 recorded samples, 24 of 160 trials, all idle-idle | Interrupted with SIGINT/exit 130 at the architecture checkpoint; the timing-only grace was rejected without a report or metric claim     |
| `/tmp/cod356-artifacts-after-input-uSH5gZ` | `f58f3ea9eda937373de89ded6620e08b7ef70b59` | Generation-tag and client-fence only the 3-second `initial-ready` refresh | Complete: 20 recorded samples, 160 trials                             | Rejected: correct lifecycle semantics, but it did not own or materially improve the measured cold replay; runtime reverted by `02bfc38a` |

| Cell             | Profile | Before convergence median (p95) | Rejected after convergence median (p95) | Decision                                                      |
| ---------------- | ------- | ------------------------------: | --------------------------------------: | ------------------------------------------------------------- |
| idle-idle        | cold    |                   360.7 (393.0) |                           337.6 (388.8) | No material improvement; direct replay remained in 5/5 trials |
| idle-idle        | steady  |                     12.0 (35.6) |                             12.9 (57.9) | p95 regressed                                                 |
| idle-interactive | cold    |                     20.9 (33.0) |                             20.0 (29.5) | Control unchanged                                             |
| idle-interactive | steady  |                     12.3 (88.2) |                             11.7 (47.3) | No regression                                                 |
| cpu-idle         | cold    |                   397.0 (545.5) |                           397.9 (447.0) | Median unchanged; direct replay remained in 4/5 trials        |
| cpu-idle         | steady  |                     16.3 (28.2) |                             15.2 (93.7) | p95 regressed materially                                      |
| cpu-interactive  | cold    |                     32.8 (33.8) |                             32.8 (35.3) | Control unchanged                                             |
| cpu-interactive  | steady  |                     15.5 (21.2) |                             15.4 (90.4) | p95 regressed materially                                      |

All 160/160 trials retained exact byte identity: 5,760/5,760 expected PTY bytes, with zero missing, duplicate, or
reordered bytes. Both CPU cohorts started 7/7 fixed workers and met their 60-second deadline with 8,720.1 ms and
7,997.2 ms remaining. Page-error and serious-console arrays were empty. Cleanup reported no surviving exact PID or
disposable session, a closed browser, matched generated assets and provenance, and no warning or error.

Rejected hypotheses and experiments:

- queue serialization, localStorage/ACK persistence, connection indicators, WebSocket parsing, server dedup, predictor
  reconciliation, and xterm live writes remain non-material based on their sub-frame steady measurements;
- joining the same-active selection did not remove the cold delay in the first experiment;
- cancelling an unsent startup refresh on input did not remove a refresh already in flight;
- a 250 ms grace moved timing without a protocol bound and was rejected before evidence;
- generation-tagging the 3-second startup refresh is lifecycle-correct but does not own the measured 1.5-second replay.

Do not add an input batching change, weaken ACK persistence, or add the previously proposed `_safeYield` microtask fast
path: steady rendering is already 12.0-16.3 ms median, flush/output calls are sub-millisecond, and the slow cold trials
do not correlate with long tasks.

Future work should target the original auto-selection's canonical buffer lifecycle and prove its ownership independently
before changing runtime behavior. That work is deferred beyond Task 5: this task will not make another architecture
attempt or rerun the after-input matrix. Any future change must preserve history/live ordering and demonstrate a cold
idle improvement without regressing steady, interactive, CPU, or byte-identity results.

Treat the server-restart dedup window as a separate correctness task: define a persisted dedup epoch/high-water mark and
prove crash/restart boundaries against a disposable process and PTY. It must not be folded into the performance change.

## Scoped regression evidence

- `npm test -- test/input-send-order.test.ts test/reliable-input-dedup.test.ts test/routes/session-input-delivery.test.ts`
  passes 3 files and 37 tests.
- `npm run test:browser -- test/codex-predictive-echo.test.ts test/terminal-input-performance.browser.test.ts` passes
  2 files and 25 tests on the reverted retained runtime.
- `npm run test:perf -- test/perf-cod-356-harness.test.ts` passes 1 file and 94 tests.
- The browser regression starts a disposable Codeman child and real tmux-backed probe, drives production input and CJK
  handlers, observes real WebSocket and HTTP endpoints, reads authoritative PTY bytes, and inspects the actual xterm
  buffer. It uses no in-page transport, server-dedup, PTY, or visible-output substitute.
