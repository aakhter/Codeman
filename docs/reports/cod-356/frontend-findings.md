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
