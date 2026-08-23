# COD-370 Mobile OpenCode Font Performance Comparison

Decision: **PASS**

The exact pre-COD-370 runtime `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613` at 10px was compared with `1b1c7ecf088895baab4e17c1a72e29052f2ff1ec` at 8px on the same host using ABBA ordering and two complete repetitions per runtime. Each rate contains 20 unfiltered dispatch-to-pane-and-xterm-visible samples. The material-regression gate is p95 worse by both more than 20ms and more than 20%.

The comparator has one connected 390x844 phone viewer. It does not compare active-viewer handoff because the baseline predates that protocol; final-head handoff remains a separate acceptance gate.

| CPU | 10px baseline median / p95 / max | Candidate median / p95 / max |   Median delta |      p95 delta |      Max delta |
| --- | -------------------------------: | ---------------------------: | -------------: | -------------: | -------------: |
| 1x  |           42.7 / 132.6 / 135.6ms |        54.6 / 67.6 / 216.1ms | 11.9ms (27.9%) |   -65ms (-49%) | 80.5ms (59.4%) |
| 4x  |             98.3 / 117 / 137.2ms |        118 / 132.7 / 146.8ms |   19.7ms (20%) | 15.7ms (13.4%) |     9.6ms (7%) |

Caution: the candidate retained one isolated 1x maximum of 216.1ms versus 135.6ms for baseline (80.5ms, 59.4% worse). This unfiltered sample had no recorded long task; the defined p95 gate still passes.

## Per-repetition evidence

- 1x baseline: r1 39/135.6/135.6ms; r2 43.2/132.6/132.6ms.
- 1x candidate: r1 59.5/216.1/216.1ms; r2 47.7/67.6/67.6ms.
- 4x baseline: r1 98.3/137.2/137.2ms; r2 92.6/105.1/105.1ms.
- 4x candidate: r1 114.8/132/132ms; r2 122.7/146.8/146.8ms.

## Correctness, geometry, and load evidence

- 1x: baseline dimensions 62x49, candidate dimensions 75x62; long tasks baseline 0 (none), candidate 0 (none); typing-window resize events baseline [0, 0], candidate [0, 0].
- 4x: baseline dimensions 62x49, candidate dimensions 75x62; long tasks baseline 15 (60, 53, 68, 53, 88, 50, 54, 58, 59, 56, 60, 61, 53, 51, 50ms), candidate 20 (70, 71, 64, 58, 68, 71, 66, 64, 64, 69, 68, 66, 74, 67, 65, 65, 67, 66, 73, 71ms); typing-window resize events baseline [0, 0], candidate [0, 0].
- Every cell delivered exactly 10 logical and 10 durable frames in order, with expected = logical = WebSocket payload bytes, unique durable client/sequence identities, and one exact final token in pane and xterm.
- Page errors and serious console warnings/errors: none. Cleanup: every boolean true in all four repetitions.
- Host: beelink, 8 x Intel(R) Core(TM) i3-N305, linux 6.8.0-124-generic, Node v22.22.0, OpenCode 1.18.21.

## Provenance and raw evidence

- Baseline tree: `1c3e2b5aa2adad328e86d66c08f0b941f1900b1e`.
- Candidate tree: `7b2f59c84e4b03f80cdcd6249f98d697e99f423e`.
- Shared lockfile SHA-256: `b8af0c8d6066ca77d68766d70dd13cfb57bbce605997006ac613ca84ab8e01d9`.
- Harness `test/mobile/opencode-e2e.test.ts`: blob `956622203c8a74baaa86157cb229396d072da5ea`, SHA-256 `3109e293edc1ee8cdd71e9ceccbdc76fdf0feb541764dcfc38e61831aa84931d`.
- Harness `test/utils/cod370-opencode-fixture.ts`: blob `1c9dff05f93b992fcff17e47f3cae40cf6220238`, SHA-256 `2ce6b53b4ab9ed8f41b160eab29d3a3ada651cd5d31ef38a6046e191902057fa`.
- baseline repetition 1: `docs/reports/cod-370/raw/baseline-1.json` (2026-08-23T23:29:20.125Z to 2026-08-23T23:29:36.188Z; load average 2.2/1.6/1.7 to 3.1/1.8/1.8).
- candidate repetition 1: `docs/reports/cod-370/raw/candidate-1.json` (2026-08-23T23:29:50.988Z to 2026-08-23T23:30:10.593Z; load average 2.9/1.9/1.8 to 4.6/2.3/1.9).
- candidate repetition 2: `docs/reports/cod-370/raw/candidate-2.json` (2026-08-23T23:30:19.782Z to 2026-08-23T23:30:36.997Z; load average 4.3/2.3/1.9 to 5.7/2.7/2.1).
- baseline repetition 2: `docs/reports/cod-370/raw/baseline-2.json` (2026-08-23T23:30:50.714Z to 2026-08-23T23:31:07.050Z; load average 5/2.7/2.1 to 5/2.8/2.1).

All raw samples are retained in the listed JSON files; no sample was deleted, trimmed, or selectively rerun.
