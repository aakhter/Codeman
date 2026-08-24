# COD-370 Mobile OpenCode Font Performance Comparison

Decision: **FAIL: material p95 regression at 1x, 4x**

The exact pre-COD-370 runtime `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613` at 10px was compared with `4cb8bcd3b2c5c923ebb46328e1c0baa67c0b6862` at 8px on the same host using ABBA ordering and two complete repetitions per runtime. Each rate contains 20 unfiltered dispatch-to-pane-and-xterm-visible samples. The material-regression gate is p95 worse by both more than 20ms and more than 20%.

The comparator has one connected 390x844 phone viewer. It does not compare active-viewer handoff because the baseline predates that protocol; final-head handoff remains a separate acceptance gate.

| CPU | 10px baseline median / p95 / max | Candidate median / p95 / max |  Median delta |      p95 delta |      Max delta |
| --- | -------------------------------: | ---------------------------: | ------------: | -------------: | -------------: |
| 1x  |             33.3 / 102 / 151.7ms |       38.4 / 153.2 / 186.9ms | 5.1ms (15.3%) | 51.2ms (50.2%) | 35.2ms (23.2%) |
| 4x  |               78.6 / 93 / 96.4ms |       86.5 / 114.4 / 114.7ms | 7.9ms (10.1%) |   21.4ms (23%) |   18.3ms (19%) |

## Per-repetition evidence

- 1x baseline: r1 33.2/151.7/151.7ms; r2 35.3/102/102ms.
- 1x candidate: r1 39.6/186.9/186.9ms; r2 36.7/153.2/153.2ms.
- 4x baseline: r1 75.5/93/93ms; r2 81.5/96.4/96.4ms.
- 4x candidate: r1 84.2/95.8/95.8ms; r2 91.5/114.7/114.7ms.

## Correctness, geometry, and load evidence

- 1x: baseline dimensions 62x49, candidate dimensions 75x62; long tasks baseline 0 (none), candidate 0 (none); typing-window resize events baseline [0, 0], candidate [0, 0].
- 4x: baseline dimensions 62x49, candidate dimensions 75x62; long tasks baseline 1 (51ms), candidate 11 (51, 55, 55, 55, 59, 69, 50, 52, 57, 56, 56ms); typing-window resize events baseline [0, 0], candidate [0, 0].
- Every cell delivered exactly 10 logical and 10 durable frames in order, with expected = logical = WebSocket payload bytes, unique durable client/sequence identities, and one exact final token in pane and xterm.
- Page errors and serious console warnings/errors: none. Cleanup: every boolean true in all four repetitions.
- Host: beelink, 8 x Intel(R) Core(TM) i3-N305, linux 6.8.0-124-generic, Node v22.22.0, OpenCode 1.18.21.

## Provenance and raw evidence

- Baseline tree: `1c3e2b5aa2adad328e86d66c08f0b941f1900b1e`.
- Candidate tree: `81c387a9cb86c6dae33294b68b472138ed811238`.
- Shared lockfile SHA-256: `b8af0c8d6066ca77d68766d70dd13cfb57bbce605997006ac613ca84ab8e01d9`.
- Harness `test/mobile/opencode-e2e.test.ts`: blob `956622203c8a74baaa86157cb229396d072da5ea`, SHA-256 `3109e293edc1ee8cdd71e9ceccbdc76fdf0feb541764dcfc38e61831aa84931d`.
- Harness `test/utils/cod370-opencode-fixture.ts`: blob `1c9dff05f93b992fcff17e47f3cae40cf6220238`, SHA-256 `2ce6b53b4ab9ed8f41b160eab29d3a3ada651cd5d31ef38a6046e191902057fa`.
- baseline repetition 1: `docs/reports/cod-370/raw/baseline-1.json` (2026-08-24T00:01:04.559Z to 2026-08-24T00:01:18.021Z; load average 1.9/2.1/2.3 to 2.2/2.1/2.3).
- candidate repetition 1: `docs/reports/cod-370/raw/candidate-1.json` (2026-08-24T00:01:26.892Z to 2026-08-24T00:01:41.241Z; load average 2.4/2.2/2.4 to 2.4/2.2/2.4).
- candidate repetition 2: `docs/reports/cod-370/raw/candidate-2.json` (2026-08-24T00:01:54.563Z to 2026-08-24T00:02:08.620Z; load average 2.1/2.2/2.3 to 2.5/2.2/2.4).
- baseline repetition 2: `docs/reports/cod-370/raw/baseline-2.json` (2026-08-24T00:02:20.351Z to 2026-08-24T00:02:35.000Z; load average 2.2/2.2/2.3 to 2.3/2.2/2.3).

All raw samples are retained in the listed JSON files; no sample was deleted, trimmed, or selectively rerun.
