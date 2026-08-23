# COD-370 Mobile OpenCode Font Performance Comparison

Decision: **PASS**

The exact pre-COD-370 runtime `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613` at 10px was compared with `e7b3d4d001a8ab426cc21e9eece92046040e8d40` at 8px on the same host using ABBA ordering and two complete repetitions per runtime. Each rate contains 20 unfiltered dispatch-to-pane-and-xterm-visible samples. The material-regression gate is p95 worse by both more than 20ms and more than 20%.

The comparator has one connected 390x844 phone viewer. It does not compare active-viewer handoff because the baseline predates that protocol; final-head handoff remains a separate acceptance gate.

| CPU | 10px baseline median / p95 / max | Candidate median / p95 / max |  Median delta |    p95 delta |       Max delta |
| --- | -------------------------------: | ---------------------------: | ------------: | -----------: | --------------: |
| 1x  |                32.2 / 99 / 130ms |       36.5 / 110.9 / 234.2ms | 4.3ms (13.4%) | 11.9ms (12%) | 104.2ms (80.2%) |
| 4x  |               69.2 / 88.5 / 90ms |         75.4 / 94.5 / 95.2ms |    6.2ms (9%) |   6ms (6.8%) |    5.2ms (5.8%) |

Caution: the candidate retained one isolated 1x maximum of 234.2ms versus 130ms for baseline (104.2ms, 80.2% worse). This unfiltered sample had no recorded long task; the defined p95 gate still passes.

## Per-repetition evidence

- 1x baseline: r1 33.8/130/130ms; r2 28/99/99ms.
- 1x candidate: r1 27/234.2/234.2ms; r2 36.5/110.9/110.9ms.
- 4x baseline: r1 69.9/90/90ms; r2 66.2/88.5/88.5ms.
- 4x candidate: r1 71.6/95.2/95.2ms; r2 75.4/94.5/94.5ms.

## Correctness, geometry, and load evidence

- 1x: baseline dimensions 62x49, candidate dimensions 75x62; long tasks baseline 0 (none), candidate 0 (none); typing-window resize events baseline [0, 0], candidate [0, 0].
- 4x: baseline dimensions 62x49, candidate dimensions 75x62; long tasks baseline 1 (52ms), candidate 3 (51, 51, 50ms); typing-window resize events baseline [0, 0], candidate [0, 0].
- Every cell delivered exactly 10 logical and 10 durable frames in order, with expected = logical = WebSocket payload bytes, unique durable client/sequence identities, and one exact final token in pane and xterm.
- Page errors and serious console warnings/errors: none. Cleanup: every boolean true in all four repetitions.
- Host: beelink, 8 x Intel(R) Core(TM) i3-N305, linux 6.8.0-124-generic, Node v22.22.0, OpenCode 1.18.21.

## Provenance and raw evidence

- Baseline tree: `1c3e2b5aa2adad328e86d66c08f0b941f1900b1e`.
- Candidate tree: `9b6eb20f86661ec0fe3f46dfd04ad15903af9aa0`.
- Shared lockfile SHA-256: `b8af0c8d6066ca77d68766d70dd13cfb57bbce605997006ac613ca84ab8e01d9`.
- Harness `test/mobile/opencode-e2e.test.ts`: blob `66d6d2b2cfba4f900d70e0c73c1dfe38786b864e`, SHA-256 `3262b28ac6182f98d61ccc64f129ede484a143ec0d69c03b721afc551d42f410`.
- Harness `test/utils/cod370-opencode-fixture.ts`: blob `1c9dff05f93b992fcff17e47f3cae40cf6220238`, SHA-256 `2ce6b53b4ab9ed8f41b160eab29d3a3ada651cd5d31ef38a6046e191902057fa`.
- baseline repetition 1: `docs/reports/cod-370/raw/baseline-1.json` (2026-08-23T22:16:00.762Z to 2026-08-23T22:16:13.582Z; load average 0.5/0.7/0.8 to 1.5/0.9/0.9).
- candidate repetition 1: `docs/reports/cod-370/raw/candidate-1.json` (2026-08-23T22:16:22.183Z to 2026-08-23T22:16:35.510Z; load average 1.3/0.9/0.9 to 1.6/1/0.9).
- candidate repetition 2: `docs/reports/cod-370/raw/candidate-2.json` (2026-08-23T22:16:45.099Z to 2026-08-23T22:16:58.378Z; load average 1.4/0.9/0.9 to 1.8/1/0.9).
- baseline repetition 2: `docs/reports/cod-370/raw/baseline-2.json` (2026-08-23T22:17:07.834Z to 2026-08-23T22:17:20.678Z; load average 1.5/1/0.9 to 1.8/1.1/1).

All raw samples are retained in the listed JSON files; no sample was deleted, trimmed, or selectively rerun.
