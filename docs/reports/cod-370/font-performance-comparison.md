# COD-370 Mobile OpenCode Font Performance Comparison

Decision: **FAIL: material p95 regression at 1x**

Release status: **NOT VALIDATED — DO NOT RELEASE.** The complete 9px fallback matrix failed the required performance gate despite passing all correctness and cleanup contracts.

The exact pre-COD-370 runtime `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613` at 10px was compared with `f3851229167a5078a15ae398c006cc2756690296` at 9px on the same host using ABBA ordering and two complete repetitions per runtime. Each rate contains 20 unfiltered dispatch-to-pane-and-xterm-visible samples. The material-regression gate is p95 worse by both more than 20ms and more than 20%.

The comparator has one connected 390x844 phone viewer. It does not compare active-viewer handoff because the baseline predates that protocol; final-head handoff remains a separate acceptance gate.

| CPU | 10px baseline median / p95 / max | Candidate median / p95 / max | Median delta |      p95 delta |      Max delta |
| --- | -------------------------------: | ---------------------------: | -----------: | -------------: | -------------: |
| 1x  |             31.6 / 93.6 / 95.7ms |       32.8 / 154.1 / 167.3ms | 1.2ms (3.8%) | 60.5ms (64.6%) | 71.6ms (74.8%) |
| 4x  |             69.5 / 79.6 / 83.1ms |             73 / 89.3 / 97ms |   3.5ms (5%) |  9.7ms (12.2%) | 13.9ms (16.7%) |

## Per-repetition evidence

- 1x baseline: r1 30.2/93.6/93.6ms; r2 35.7/95.7/95.7ms.
- 1x candidate: r1 32.1/167.3/167.3ms; r2 33.2/154.1/154.1ms.
- 4x baseline: r1 68.2/83.1/83.1ms; r2 70.1/78.2/78.2ms.
- 4x candidate: r1 71.4/85.8/85.8ms; r2 75.4/97/97ms.

## Correctness, geometry, and load evidence

- 1x: baseline dimensions 62x49, candidate dimensions 75x52; long tasks baseline 0 (none), candidate 0 (none); typing-window resize events baseline [0, 0], candidate [0, 0].
- 4x: baseline dimensions 62x49, candidate dimensions 75x52; long tasks baseline 0 (none), candidate 1 (53ms); typing-window resize events baseline [0, 0], candidate [0, 0].
- Every cell delivered exactly 10 logical and 10 durable frames in order, with expected = logical = WebSocket payload bytes, unique durable client/sequence identities, and one exact final token in pane and xterm.
- Page errors and serious console warnings/errors: none. Cleanup: every boolean true in all four repetitions.
- Host: beelink, 8 x Intel(R) Core(TM) i3-N305, linux 6.8.0-124-generic, Node v22.22.0, OpenCode 1.18.21.

## Provenance and raw evidence

- Baseline tree: `1c3e2b5aa2adad328e86d66c08f0b941f1900b1e`.
- Candidate tree: `608989a703ae9fd7ac692c41d0a2e3f733e192c3`.
- Shared lockfile SHA-256: `b8af0c8d6066ca77d68766d70dd13cfb57bbce605997006ac613ca84ab8e01d9`.
- Harness `test/mobile/opencode-e2e.test.ts`: blob `bbfaf65ce306d955b59c2f2316cdee839047db81`, SHA-256 `52d957f0f4c9e3fd175a0b45ea664b42dd9806c5ac62d69c4e7053cecb21c313`.
- Harness `test/utils/cod370-opencode-fixture.ts`: blob `1c9dff05f93b992fcff17e47f3cae40cf6220238`, SHA-256 `2ce6b53b4ab9ed8f41b160eab29d3a3ada651cd5d31ef38a6046e191902057fa`.
- baseline repetition 1: `docs/reports/cod-370/raw/baseline-1.json` (2026-08-24T00:23:46.894Z to 2026-08-24T00:24:00.003Z; load average 0.5/0.8/1.3 to 0.6/0.8/1.3).
- candidate repetition 1: `docs/reports/cod-370/raw/candidate-1.json` (2026-08-24T00:24:10.535Z to 2026-08-24T00:24:23.938Z; load average 0.8/0.8/1.3 to 1.8/1/1.4).
- candidate repetition 2: `docs/reports/cod-370/raw/candidate-2.json` (2026-08-24T00:24:36.462Z to 2026-08-24T00:24:49.497Z; load average 1.5/1/1.3 to 1.4/1/1.3).
- baseline repetition 2: `docs/reports/cod-370/raw/baseline-2.json` (2026-08-24T00:25:02.228Z to 2026-08-24T00:25:15.167Z; load average 1.2/1/1.3 to 1.1/1/1.3).

All raw samples are retained in the listed JSON files; no sample was deleted, trimmed, or selectively rerun.
