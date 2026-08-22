# COD-356 terminal input findings

## Result

The normal typing path preserved byte identity in every recorded benchmark trial: 160/160 exact, with zero missing,
duplicate, or reordered bytes. Deterministic regression coverage also preserved logical records, serialized WebSocket
and HTTP payloads, authoritative probe PTY bytes, and visible output for repeated runs, control/Enter boundaries,
near-limit paste, CJK composition, reconnect/reload, and live-socket lost-ACK redelivery.

This means the reported repeated-character symptom is not reproduced in the ordinary transport path. The measured
failure mode is browser convergence/starvation: input reaches and is acknowledged by the server quickly, while visible
xterm convergence is delayed by browser scheduling and long tasks.

One narrower reliability gap is now explicitly characterized rather than hidden: if the server process restarts after
applying input but before the browser receives/persists its ACK, the session's in-memory dedup table is lost and the
durable browser retry can apply the same record again. The failing layer in that exceptional window is
`Session._appliedInputSeq` process lifetime, not browser serialization or normal lost-ACK redelivery. Task 5 must not
silently change that protocol contract as a performance optimization.

## Input-trace evidence

Runtime: `5b8565ab59f780478a75a806e9302eab11de94a6`

Report set: `1ea4a5ebed166d6ebe32f47d650a8442`

Raw artifacts: `/tmp/cod356-artifacts-input-trace-4OWeCr`

All values below are milliseconds. Cold is trial 1 of each recorded sample; steady is trials 2-8. Values are medians;
the parenthesized value is p95.

| Cell | Profile | Send call | Browser ACK | Probe PTY | Visible convergence | Long-task overlap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| idle-idle | cold | 4.424 (5.600) | 1.700 (2.900) | 10.819 (16.017) | 510.300 (583.500) | 1/5 |
| idle-idle | steady | 1.900 (4.924) | 0.900 (8.700) | 9.030 (21.258) | 69.500 (130.900) | 3/35 |
| idle-interactive | cold | 2.634 (2.860) | 1.500 (29.800) | 7.591 (37.671) | 90.800 (110.800) | 0/5 |
| idle-interactive | steady | 1.606 (3.488) | 0.700 (6.900) | 6.429 (17.827) | 55.700 (138.300) | 3/35 |
| cpu-idle | cold | 4.075 (6.211) | 4.400 (8.900) | 14.886 (30.687) | 666.800 (899.500) | 5/5 |
| cpu-idle | steady | 3.101 (8.245) | 2.100 (7.100) | 12.103 (26.655) | 120.500 (225.400) | 34/35 |
| cpu-interactive | cold | 6.348 (7.825) | 3.300 (6.000) | 15.652 (18.389) | 127.300 (238.400) | 5/5 |
| cpu-interactive | steady | 2.828 (5.812) | 1.600 (5.800) | 10.651 (17.581) | 176.100 (217.000) | 34/35 |

The accepted baseline's cold convergence medians were 426.8, 80.7, 884.4, and 223.6 ms for the same cell order;
steady medians were 66.9, 46.5, 109.5, and 174.6 ms. The input-trace run therefore retains the already-observed
idle cold-first variance while confirming the large Task 3 CPU ACK/probe improvement. Because this checkpoint adds
measurement wrappers and is not an input optimization, these differences are diagnostic rather than an acceptance
claim.

## Dominant cost and Task 5 decision

| Boundary | Measured result | Decision |
| --- | --- | --- |
| Reliable record creation, persistence scheduling, indicator computation, and WebSocket serialization | Browser input wrapper median 0.3-0.4 ms; p95 0.7-1.1 ms | Too small to justify transport batching or durability changes. |
| ACK handling, pending-record lookup/removal, persistence scheduling, and indicator update | Median 0.2-0.3 ms; p95 0.5-0.8 ms | Do not weaken ACK or exactly-once semantics. |
| Server parse/dedup/write plus transport to probe | Send-to-probe median 6.4-15.7 ms across cold/steady profiles | Not the dominant visible delay. |
| Terminal event handler before queued rendering | Median 0.1-0.2 ms; p95 at most 2.9 ms | Event parsing itself is not dominant. |
| Output-frame receipt to xterm flush callback / convergence | Cell median 44.1-159.1 ms; full convergence median 60.6-175.2 ms | Dominant measured input cost. |
| Browser long tasks | 78/80 CPU-loaded trials overlapped the input-to-convergence interval, versus 7/80 idle trials | Starvation strongly correlates with slow convergence. |

The smallest Task 5 experiment is a bounded small-frame fast path in `terminal-ui.js`: when a live terminal output
event begins from an empty queue and remains below a conservative byte threshold, coalesce within the current task and
flush by microtask instead of waiting for the three-way `_safeYield` race. Preserve `_safeYield`, the 32/64 KiB frame
budgets, history/load ordering, and backlog recovery for larger or already-queued output. Retain the change only if the
focused operation-count test proves one flush per bounded burst and the after-input matrix lowers convergence median or
p95 without byte-identity, CPU-condition, or opposite-cell regression.

Do not batch input records, alter control/Enter/composition boundaries, remove synchronous `pagehide` durability, or
change server-authoritative ACK/dedup semantics. If the bounded fast path does not produce a repeatable win, Task 5
should make no transport change and defer the remaining xterm/render work to Task 7.
