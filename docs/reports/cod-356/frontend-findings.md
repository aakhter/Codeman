# COD-356 frontend startup findings

## Decision: reject and revert

The Ralph wizard split was rejected. Candidate runtime `ef38287c116fda7d467c417a1db8403150f52eb7` removed a
deterministic 39,223 decoded bytes from the initial graph, but the exact-revision five-sample profiles showed material
startup regressions. Commit `ddf16027` explicitly reverts the candidate. No lazy-loading runtime or candidate-specific
contract-test change is retained, and the final product runtime/build and candidate-test tree matches pre-Task6 revision
`063880d7` exactly. The retained benchmark-harness test is evidence infrastructure.

No further Task6 split should be attempted without a new profile-proven candidate and a new plan: the only dependency-safe
optional module found was too small relative to the eager loader and scheduling cost on this unbundled page.

## Candidate and dependency analysis

The initial profile ranked `vendor/xterm.min.js`, `app.js`, `terminal-ui.js`, `i18n.js`, `panels-ui.js`,
`settings-ui.js`, and `session-ui.js` as the largest eager contributors. They were rejected because they provide core
terminal creation/input, app bootstrap/reconnect, pre-app localization, startup/SSE, settings/layout, or session creation.
The WebGL addon was already asynchronous and desktop-only.

`ralph-wizard.js` was the only optional candidate before `app-loaded`. Code inspection found its explicit Start Ralph
entry, background plan SSE through `handlePlanSubagentEvent`, and monitor cancellation through `cancelPlanGeneration`.
The non-shipping candidate used eager facades for those methods and `showRalphWizard`. Its unit contracts directly proved
one deferred request, original-action forwarding with a literal `keyboard` argument, concurrent load sharing, request
failure reporting/retry, and facade function presence. Its browser contract used programmatic button activation on desktop
and mobile; it did not directly exercise keyboard activation or background-event forwarding. Facade-install failure
handling was inspected in code, not established by the retained contract evidence. These observations do not offset the
measured regression, so the candidate implementation and its tests were reverted.

## Five-sample desktop/mobile cold/warm profile

The profiler launched a disposable loopback Codeman instance and real Chromium contexts for desktop 1365x768 and mobile
390x844. Cold and independently primed warm variants each contain five samples. The complete committed JSON records every
asset's raw/gzip/Brotli size, request start/end, traced parse/evaluate work, required-before-`app-loaded` classification,
raw samples, aggregate median/p95/min/max, browser long tasks, page/console errors, exact revision, and verified cleanup:

- `frontend-assets-before.json`: `063880d7`, 20 page/console-error-free navigations.
- `frontend-assets-after.json`: rejected candidate `ef38287c`, 20 page/console-error-free navigations.

Each capture ran from a detached worktree with `--samples 5 --runtime-root <worktree> --runtime-revision <full-sha>`.
Before browser launch the profiler fail-closed verified the supplied full SHA against that worktree's `HEAD`, required the
tracked tree to be clean, and recorded the verified commit and tree (`724eca0b` before, `c6868030` candidate). Untracked
files were excluded from this cleanliness check by design. The profiler emitted the report only after verified browser,
child-process, and temporary-root cleanup.

Schema 3 also binds the profiler implementation and dependencies. Both reports record profiler manifest SHA-256
`2ac1946d280d4e67a597076407764196e0b5edc39afb789a63948c56cb4e1229`, including exact bytes and hashes for the
profiler, `package.json`, and `package-lock.json`, plus Node `v22.22.0` and Playwright `1.60.0`. The tool checkout was at
`f536b599`/tree `881fffac`; its tracked changes are enumerated in each report, and untracked files are explicitly excluded
by design. The profiler manifest, rather than checkout cleanliness, binds the exact executed profiler bytes.

Before, `ralph-wizard.js` was 41,371 raw / 9,931 gzip / 9,442 Brotli bytes. The candidate loader was 2,148 raw /
950 gzip / 855 Brotli bytes. Both were required before `app-loaded` in 5/5 samples; the candidate deferred the wizard.

| Profile      | App-loaded median / p95 before -> candidate | Decoded median before -> candidate | Long tasks median / p95 before -> candidate | Navigation + 500ms post-ready long-task ms median / p95 before -> candidate | Asset response-end median before -> candidate | Asset parse median before -> candidate |
| ------------ | ------------------------------------------: | ---------------------------------: | ------------------------------------------: | --------------------------------------------------------------------------: | --------------------------------------------: | -------------------------------------: |
| Desktop cold |              537.1 / 550.4 -> 555.6 / 571.2 |             5,077,508 -> 5,038,285 |                              3 / 3 -> 3 / 4 |                                                      264 / 280 -> 286 / 348 |                             289.1 -> 236.3 ms |                      0.146 -> 0.159 ms |
| Desktop warm |              425.6 / 446.8 -> 449.9 / 479.5 |             5,077,508 -> 5,038,285 |                              1 / 1 -> 1 / 1 |                                                         79 / 85 -> 85 / 102 |                             330.7 -> 263.4 ms |                      0.173 -> 0.238 ms |
| Mobile cold  |              506.9 / 509.1 -> 527.8 / 554.7 |             4,829,587 -> 4,790,364 |                              2 / 3 -> 3 / 3 |                                                      199 / 251 -> 265 / 288 |                             274.9 -> 237.3 ms |                      0.148 -> 0.144 ms |
| Mobile warm  |              409.5 / 450.7 -> 445.7 / 454.2 |             4,829,587 -> 4,790,364 |                              1 / 1 -> 1 / 1 |                                                          84 / 87 -> 86 / 88 |                             320.2 -> 268.8 ms |                      0.198 -> 0.243 ms |

The smaller asset completed earlier in all four medians, but its own parse/evaluate median improved once and worsened in
three profiles, while page-level app-ready and long-task distributions were broadly worse. Long-task values use a
navigation plus 500ms post-ready observation window; they are not bounded at `app-loaded`. Chromium exposed attribution
as `unknown`; the reports preserve that result rather than inventing script ownership. Per-URL traced work remains in each
raw sample.

## Longitudinal fixed 4x5 matrix

The final measurement used five recorded samples plus one warmup in every idle/CPU x idle/interactive cell, with the
baseline's fixed input workload and seven-worker 70% CPU cohort. Its baseline is branch point `a445cdaf`, not pre-Task6
`063880d7`; this longitudinal comparison is confounded by intervening Task 2 and Task 3 changes and does not isolate the
lazy split. The paired reports share report set `564e59e5693cd07d1dffe2e9cb99d5e3`. Causal rejection relies on the exact
`063880d7` versus `ef38287c` 5x4 profiles above; the matrix below is supporting operational context only.

| Cell                   | App-ready median before -> candidate | App-ready p95 before -> candidate | Decoded median before -> candidate | Long tasks median before -> candidate | Long-task duration median before -> candidate |
| ---------------------- | -----------------------------------: | --------------------------------: | ---------------------------------: | ------------------------------------: | --------------------------------------------: |
| Idle / idle app        |                587.761 -> 646.811 ms |             664.628 -> 690.514 ms |             5,113,698 -> 5,072,402 |                                3 -> 4 |                               119 -> 110.5 ms |
| Idle / interactive app |                596.682 -> 680.905 ms |           640.350 -> 1,068.427 ms |             5,115,625 -> 5,072,800 |                                4 -> 7 |                                   92 -> 78 ms |
| CPU / idle app         |            1,230.882 -> 1,227.067 ms |         1,392.891 -> 1,268.847 ms |             5,114,031 -> 5,072,681 |                              27 -> 10 |                                 71.5 -> 87 ms |
| CPU / interactive app  |            1,437.657 -> 1,342.926 ms |         1,536.566 -> 1,476.095 ms |             5,114,053 -> 5,072,912 |                              30 -> 11 |                                 76 -> 88.5 ms |

Across the longitudinal matrix, idle app-ready moved +10.0% and +14.1%, with long-task counts rising. CPU app-ready moved
-0.3% and -6.6%, while long-task duration medians increased. These values are not attributed solely to the candidate.
The exact paired profiles independently fail the retention gate for a 39,223-byte win. There was no extra critical request
(loader replaced wizard), so the explicit cold/warm gate about extra requests was not triggered; the broader exact-profile
app-ready/long-task gate still failed.

The final raw directory is `/tmp/cod356-artifacts-after-frontend-t0hRsO`. Both CPU cells used all seven fixed workers and
met the 60-second deadline. Cleanup was stable: all 15 disposable sessions were removed, no exact child PIDs survived,
the browser closed, the tmux socket and temporary root were removed, page/console warning and error arrays were empty,
and generated-asset hashes matched `f583a889dd91980030849f0c474baf4f0b5a2197a38e6097be92ec0bb12bc268`.
Runtime provenance was pinned to `ef38287c116fda7d467c417a1db8403150f52eb7`.

## Run ledger and harness correction

- Initial candidate unit and browser contracts were observed RED before implementation, then GREEN. They are not retained.
- Three early full attempts failed cleanly because cached `pid=null` caused a redundant attach and unfiltered HTTP 409;
  they published no report. An ineffective 1.1-second delay was removed.
- A first two-cell smoke and 4x5 run completed, but review found authoritative readiness was checked after selection, so
  `/tmp/cod356-artifacts-after-frontend-mq66kf` was rejected as invalid evidence.
- A one-sample corrected smoke was rejected before launch because it did not match the fixed 5x8 input profile.
- The first corrected five-sample smoke exposed genuinely stopped `idle/pid=null`: it must attach before it can become
  ready, unlike exact `busy/pid=null`, which must wait before selection. It failed cleanly and published no report.
- Contracts distinguish exact already-attaching, genuinely stopped, and foreign-target states. The corrected 99-test
  harness passed. The next two-cell five-sample idle smoke passed with stable cleanup at
  `/tmp/cod356-artifacts-after-frontend-smoke-ZPuQ7g`; its temporary reports were removed.
- One fresh full matrix then produced the committed paired reports and final raw directory above. No selective sample was
  rerun or relabeled.

## Task 7 render candidate: reject and revert

Task 7 found a real redundant render path, but the candidate failed the end-to-end retention gate. Runtime commit
`6ca0598dbb5ac25e4e8400cdff1077dbb32efd08` was explicitly reverted by `6890c8a4`; no Task 7 product or candidate-only
test change remains. The deterministic operation-count result is useful diagnostic evidence, but it does not justify
shipping a change whose immutable immediate-parent comparison has material startup and long-task regressions. Do not
attempt another speculative render change without the architecture checkpoint required by the plan.

### Ranked causal profile and lifecycle regression

A real Chromium profile exercised 15 sessions, four visible tab switches, 20 live session updates, and a 100,000-line
(2,088,890-byte) canonical replay. Before the candidate, the ranked measured paths were:

| Path                               | Calls | Main-thread duration |
| ---------------------------------- | ----: | -------------------: |
| Required terminal canonical replay |     1 |             473.3 ms |
| Incremental session-list updates   |    17 |              29.4 ms |
| Full session-list rebuilds         |     3 |              13.1 ms |
| Active-tab forced layout           |     6 |              10.1 ms |
| Terminal fit                       |    20 |               9.9 ms |
| Repeated bounding-rect reads       |    12 |               9.3 ms |
| Session-list overflow layout       |    21 |               8.8 ms |

The canonical replay was dominant but required and occurred once, so it was not optimized. The concrete redundant path
was the active session identifier in `_tabStructureKey`: every otherwise presentation-only visible selection change made
the structure key differ and rebuilt all 15 rows even though `_updateActiveTabImmediate` already updated selection. Exact
visible reference comparison still made a rebuild necessary when collapsed-group visibility changed.

The jsdom regression imported the shipping controller and terminal writer, rendered 15 actual rows, performed four tab
switch reconciliations and three debounced live updates, and replayed exactly 100,000 lines. RED was the expected four
calls to `_fullRenderSessionTabs` versus a budget of zero. The one-line structural-key candidate went GREEN (1/1): four
switch rebuilds became zero, the same DOM node objects survived, order and single selection stayed exact, and joined
terminal writes were byte-identical. The required unit suite passed 25/25, required browser suite 17/17, and frontend
syntax, typecheck, lint, format, lockfile, and diff gates passed. Lint retained only the pre-existing
`src/web/server.ts:1549` explicit-`any` warning. Two unrelated command-palette whitespace assertions in
`test/tab-layout-app.test.ts` also failed at clean parent `ca11a1d`; the candidate-relevant collapsed-group cases and all
25 `tab-layout-browser` cases passed.

The follow-up identical Chromium workload confirmed the local win: full rebuilds fell 3 -> 1 and 13.1 -> 4.0 ms (the
remaining call was explicit setup), script time fell 230.968 -> 214.013 ms, and layout duration fell
24.748 -> 22.016 ms. Incremental updates were 17 -> 17, the canonical replay remained 1 -> 1, and terminal fit stayed
20 -> 20. Other forced-layout counts fell, but their durations did not consistently improve; style-recalculation time
rose 114.686 -> 119.993 ms. This profile establishes the removed operation, not an end-to-end retention result.

### Immutable immediate-parent retention matrix

Because the required `after-render` report compares with branch point `a445cdaf`, an additional fresh control measured
immediate parent `ca11a1d` under the same current harness and accepted protocol. Both runs contain one warmup plus five
recorded samples in every idle/CPU x idle/interactive cell. Values below are parent -> candidate and percentage changes
are median / p95; negative is faster or fewer.

| Cell               |                                            App-ready median / p95 |                                 First-terminal-ready median / p95 |  Long-task count median / p95 |           Long-task duration median / p95 |
| ------------------ | ----------------------------------------------------------------: | ----------------------------------------------------------------: | ----------------------------: | ----------------------------------------: |
| Idle / idle        |         582.744 / 599.621 -> 581.283 / 615.926 ms (-0.3% / +2.7%) |         505.925 / 515.208 -> 519.768 / 523.472 ms (+2.7% / +1.6%) |      3 / 4 -> 3 / 4 (0% / 0%) |   95 / 129 -> 97 / 128 ms (+2.1% / -0.8%) |
| Idle / interactive |        608.289 / 623.927 -> 605.707 / 706.958 ms (-0.4% / +13.3%) |   998.914 / 1,207.627 -> 1,015.911 / 1,229.034 ms (+1.7% / +1.8%) |  3 / 4 -> 3 / 5 (0% / +25.0%) | 100 / 137 -> 98 / 187 ms (-2.0% / +36.5%) |
| CPU / idle         |  960.176 / 1,097.563 -> 1,068.345 / 1,201.471 ms (+11.3% / +9.5%) |         758.523 / 859.008 -> 828.022 / 870.006 ms (+9.2% / +1.3%) | 8 / 10 -> 8 / 9 (0% / -10.0%) | 75.5 / 262 -> 83 / 264 ms (+9.9% / +0.8%) |
| CPU / interactive  | 1,137.970 / 1,151.065 -> 1,118.701 / 1,212.119 ms (-1.7% / +5.3%) | 1,430.631 / 1,533.011 -> 1,569.455 / 1,601.344 ms (+9.7% / +4.5%) |    9 / 10 -> 9 / 10 (0% / 0%) |   81 / 270 -> 85 / 294 ms (+4.9% / +8.9%) |

The candidate's idle/interactive app-ready p95 (+13.3%), long-task-count p95 (+25.0%), and long-task-duration p95
(+36.5%), plus CPU/idle app-ready median (+11.3%) and CPU terminal-ready medians (+9.2% and +9.7%), are material. No
selective sample was rerun. These direct results fail retention even though the micro-profile operation count improved.

### Required longitudinal matrix and evidence integrity

For completeness, the required report's comparator is branch point `a445cdaf`, so this table is longitudinal across
intervening tasks and is not used as causal evidence. Values are branch point -> candidate; changes are median / p95.

| Cell               |                                              App-ready median / p95 |                                  First-terminal-ready median / p95 |        Long-task count median / p95 |             Long-task duration median / p95 |
| ------------------ | ------------------------------------------------------------------: | -----------------------------------------------------------------: | ----------------------------------: | ------------------------------------------: |
| Idle / idle        |           587.761 / 664.628 -> 581.283 / 615.926 ms (-1.1% / -7.3%) |          490.236 / 500.909 -> 519.768 / 523.472 ms (+6.0% / +4.5%) |            3 / 4 -> 3 / 4 (0% / 0%) |  119 / 143 -> 97 / 128 ms (-18.5% / -10.5%) |
| Idle / interactive |          596.682 / 640.350 -> 605.707 / 706.958 ms (+1.5% / +10.4%) |   981.312 / 1,095.130 -> 1,015.911 / 1,229.034 ms (+3.5% / +12.2%) |    4 / 6 -> 3 / 5 (-25.0% / -16.7%) |    92 / 135 -> 98 / 187 ms (+6.5% / +38.5%) |
| CPU / idle         | 1,230.882 / 1,392.891 -> 1,068.345 / 1,201.471 ms (-13.2% / -13.7%) |      949.644 / 1,451.588 -> 828.022 / 870.006 ms (-12.8% / -40.1%) |  27 / 29 -> 8 / 9 (-70.4% / -69.0%) | 71.5 / 191 -> 83 / 264 ms (+16.1% / +38.2%) |
| CPU / interactive  | 1,437.657 / 1,536.566 -> 1,118.701 / 1,212.119 ms (-22.2% / -21.1%) | 1,705.647 / 1,882.677 -> 1,569.455 / 1,601.344 ms (-8.0% / -14.9%) | 30 / 31 -> 9 / 10 (-70.0% / -67.7%) |   76 / 238 -> 85 / 294 ms (+11.8% / +23.5%) |

Candidate report set `3b37cb61caafe1158cbb2caec9f9ede5` pins runtime `6ca0598d`; parent-control report
set `6bc2c1687e0a8bc0e50664c7e364ca4b` pins `ca11a1d`. Both bind the identical harness content hash
`f36d06cc112379d5aa674984f8e30a76509b071a24a4826773c8f8facd47234b` and generated-asset manifest
`f583a889dd91980030849f0c474baf4f0b5a2197a38e6097be92ec0bb12bc268`. Every cell has five recorded samples,
both CPU cells used the fixed seven-worker cohort within deadline, and every page/serious-console array is empty. Both
runs completed stable cleanup with zero remaining sessions or exact child PIDs, a closed browser, matched post-run
assets, and matched post-run provenance. Raw artifacts are `/tmp/cod356-artifacts-after-render-RJNL0p` and
`/tmp/cod356-artifacts-render-parent-control-Q2Lwhi`. The compact candidate and control report pairs are retained; no
product runtime is retained.

After the explicit revert, the product and candidate-test diff against `ca11a1d` is empty. The remaining required unit
tests passed 24/24 (the candidate-only render-budget test was removed), the required browser tests passed 17/17, and
frontend syntax, typecheck, lint, format, lockfile, report-pair hash, JSON, and diff checks passed. As a supplementary
check, the unchanged `test/perf-browser.test.ts` passed 27/28; its unrelated session-options tab timing exceeded the
pre-existing 200 ms threshold at 255.6 ms and again at 203.5 ms when focused. This occurs on the exact parent-equivalent
product/test tree and is not a retained Task 7 regression, but it remains an explicit verification concern.
