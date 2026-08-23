# COD-356 final performance comparison

## Status

This is the approved Task 8 release-evidence report for branch `COD-356-performance-improvements` at runtime revision
`cc15b5931283167d4819c10eef3227f06b164955`. Specification and quality reviews are approved with no remaining findings.
The benchmark,
scoped regressions, repository gates, and realistic-smoke coverage completed. The smoke gate is qualified: two
installed-run branch smokes failed the same two shell
viewport-navigation checks, an installed-run exact-source control passed, and one unchanged-branch diagnostic run passed
all original 132 assertions without entering its added condition-poll path. No push, merge, deploy, restart, or production
mutation has been made.

The retained product changes are deliberately narrow:

- `4a149c42` adds bounded asynchronous recent-pane text capture without changing styled/full-history capture.
- `ecd182f4` replaces per-session synchronous working-frame timers with one shared coordinator, a global capture
  concurrency cap of two, per-session non-overlap, fairness/backoff, and generation-fenced late-result handling.
- Task 4 retains correctness tests and benchmark instrumentation. Tasks 5, 6, and 7 retain no product optimization;
  their measured candidates were explicitly reverted.

The corrected final matrix supports a strong backend-tail improvement, but it does **not** establish a universal speedup.
Event-loop and API p95 improved in every cell, while idle-idle event-loop median, tmux duration, several input measures,
and multiple browser metrics did not. The browser results are longitudinal and host-noise-sensitive; because no frontend
optimization remains,
they are reported as observations rather than attributed to the retained backend changes.

## Benchmark protocol and provenance

Command:

```bash
COD356_RUNTIME_REVISION=$(git rev-parse HEAD)
npm run perf:cod356 -- --phase after --conditions idle,cpu --samples 5 --runtime-revision "$COD356_RUNTIME_REVISION"
```

| Evidence            | Baseline                                                           | Final                                                              |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Runtime revision    | `a445cdaf645309ce51d8b1431733afa8f0bc55ac`                         | `cc15b5931283167d4819c10eef3227f06b164955`                         |
| Report set          | `10fb75599cf4c6d11e4996b97624fe7a`                                 | `83fdab0c977da9be702afc2f41a201b2`                                 |
| Summary SHA-256     | `91ccb739a7756d3fd35339d51187d00731e7170177abc9246922ade2ce8d9683` | `f1611d81a5d092d8e32702930e51788fbd2c578ce5e56f8c174a516c2bf60d86` |
| Environment SHA-256 | `62a4c3684551e557dc084d23512cd2e8f296a41e6a7bd0a5711d1519e1e396b9` | `c78d05ddc77030fe31a38f4ba2876274cd17de0c0804d77c90fd2f7acef41bfd` |
| Raw artifacts       | `/tmp/cod356-artifacts-before-8BAYB1`                              | `/tmp/cod356-artifacts-after-Yhuw1P`                               |
| Recorded coverage   | 4 cells x 5 samples, plus one warmup/cell                          | 4 cells x 5 samples, plus one warmup/cell                          |
| CPU load            | fixed 7-worker, 70% duty-cycle cohorts                             | fixed 7-worker, 70% duty-cycle cohorts                             |
| Protocol            | 45 fixed API offers/sample; 8 sequential input trials/sample       | identical accepted protocol/hash                                   |
| Generated assets    | matched before/after                                               | matched before/after and again before publication                  |
| Harness identity    | `d96677535fb5c145...`; dirty only for the accepted overlay         | same hash; committed/clean                                         |
| Cleanup             | clean/stable; listener/process/port proof passed                   | clean/stable; listener/process/port proof passed                   |

Both compact pairs pass `validatePairedReports`. Both raw directories remain present with 24 cell JSON files plus
`cleanup.json` and `server.log`. All CPU samples held 7/7 workers and met the fixed 60-second deadline. Final API failures
and timeouts were zero. Page-error and serious-console arrays were empty in every cell. The corrected cleanup registered
the authenticated listener and its process tree using Linux PID/start-time identities, terminated descendants before the
launcher, and required captured PIDs absent, listener owners absent, and the loopback port closed before publication.
Baseline cleanup proved PIDs `1179806/1179817/1179835` absent and port `46787` closed; final proved
`1203310/1203327/1203347` absent and port `40939` closed. Neither run needed `SIGKILL`.

The first detached comparison invocation stopped at provenance preflight, before server launch or any matrix cell, because
ignored generated vendor assets were absent. The assets were generated/copied from the final checkout, the one tracked
build output was restored to `a445cdaf`, and runtime diff/untracked checks were empty before the complete matrix was run.
The detached worktree and its parent directory were removed after hash-verified report transfer; raw artifacts remain.
During the final run, the publication guard necessarily loaded the still-committed original baseline pair (report set
`4163bef9ae5cba2276daba4369e1acca`) for its generated-asset and protocol binding. The regenerated baseline was copied
into this worktree only after final publication completed. Its generated-asset manifest and protocol match, and the
regenerated baseline/final reports independently share the corrected harness content hash above.

The repository's actual branch base is `a5ec3ce4830ff671e686568c72cd966a8cd4c52b`. The intervening `d7278c60` design
and `a445cdaf` plan commits modify documentation only; their runtime trees are identical. Accordingly, `a445cdaf` is the
benchmark comparison revision, not the branch base.

### Quality-remediation harness TDD

Quality review found that the old registry tracked only the spawned `tsx` PID even though target ownership recorded a
distinct listener/process tree. Focused RED runs demonstrated each missing contract:

- owned-tree registry: 1 failed / 99 skipped, `TypeError: registry.registerOwnedProcessTree is not a function`;
- PID/start-time termination and verification helpers: 3 failed / 99 skipped;
- actual-branch-base/comparison-revision provenance contract: 1 failed / 102 skipped;
- closed-registration signal-race fallback: 1 failed / 103 skipped.

The minimal correction snapshots `{pid,parentPid,startTimeTicks,depth}` from `/proc`, signals only start-time-matching
non-root descendants deepest-first, lets exact launcher cleanup terminate the root, and uses `SIGKILL` only if the first
identity/listener/port verification remains dirty. A signal that starts cleanup before post-proof registration invokes
the same exact resource fallback; no process group or broad kill is used. Final GREEN was 104/104 harness tests, followed
by the two-file asset-report/harness result of 111/111. The correction and the unquestionably detached COD-181/182 orphan
JSDoc removal are isolated in `cc15b593` (`test(perf): COD-356 verify listener cleanup`).

## Backend responsiveness

Values are baseline -> final and percent change. Lower is better. The event-loop rows summarize the distribution of
per-interval p95 measurements; API rows use the equivalent fixed-offer per-sample population.

| Cell                   |           Event-loop median |                Event-loop p95 |                   API median |                        API p95 |
| ---------------------- | --------------------------: | ----------------------------: | ---------------------------: | -----------------------------: |
| Idle / idle app        | 10.289 -> 10.682 ms (+3.8%) |  31.949 -> 16.310 ms (-48.9%) |    4.863 -> 4.571 ms (-6.0%) |   39.892 -> 29.118 ms (-27.0%) |
| Idle / interactive app | 10.445 -> 10.273 ms (-1.6%) |  63.799 -> 22.282 ms (-65.1%) |   4.314 -> 3.832 ms (-11.2%) |   74.951 -> 61.270 ms (-18.3%) |
| CPU / idle app         | 11.583 -> 11.510 ms (-0.6%) | 104.661 -> 23.101 ms (-77.9%) | 15.015 -> 11.274 ms (-24.9%) | 175.019 -> 150.156 ms (-14.2%) |
| CPU / interactive app  | 11.796 -> 11.633 ms (-1.4%) | 115.802 -> 23.167 ms (-80.0%) | 17.489 -> 13.585 ms (-22.3%) |  191.725 -> 54.920 ms (-71.4%) |

| Cell                   |                 Scheduling p95 |                            Node CPU median / p95 |                                    RSS median / p95 |             tmux count median / p95 |                            tmux duration median / p95 |
| ---------------------- | -----------------------------: | -----------------------------------------------: | --------------------------------------------------: | ----------------------------------: | ----------------------------------------------------: |
| Idle / idle app        |   25.517 -> 17.820 ms (-30.2%) |  7.488 / 7.899 -> 7.462 / 9.052 (-0.3% / +14.6%) | 285.9 / 310.2 -> 252.8 / 276.0 MB (-11.6% / -11.0%) |        7 / 8 -> 7 / 8 (0.0% / 0.0%) |   4.913 / 7.877 -> 5.672 / 8.757 ms (+15.4% / +11.2%) |
| Idle / interactive app |   39.745 -> 34.746 ms (-12.6%) | 9.025 / 11.138 -> 8.726 / 8.929 (-3.3% / -19.8%) | 324.4 / 331.1 -> 278.4 / 286.6 MB (-14.2% / -13.4%) |  25 / 36 -> 24 / 33 (-4.0% / -8.3%) |    4.908 / 8.249 -> 5.392 / 9.288 ms (+9.9% / +12.6%) |
| CPU / idle app         | 229.002 -> 126.533 ms (-44.7%) |   8.517 / 8.924 -> 7.737 / 8.264 (-9.2% / -7.4%) | 334.0 / 335.4 -> 287.6 / 291.4 MB (-13.9% / -13.1%) |  27 / 29 -> 25 / 27 (-7.4% / -6.9%) | 8.652 / 15.493 -> 9.582 / 18.527 ms (+10.8% / +19.6%) |
| CPU / interactive app  | 232.044 -> 143.719 ms (-38.1%) |  8.881 / 9.300 -> 7.884 / 8.693 (-11.2% / -6.5%) | 339.2 / 341.6 -> 290.6 / 291.3 MB (-14.3% / -14.7%) | 29 / 32 -> 27 / 28 (-6.9% / -12.5%) | 8.982 / 17.478 -> 10.137 / 18.956 ms (+12.9% / +8.5%) |

Directly causal outcomes are structural rather than inferred from noisy timing: the working-state path no longer invokes
synchronous pane capture, the coordinator owns one shared scheduler, and observed capture overlap never exceeded its cap
of two. The timing deltas support those changes but remain a longitudinal comparison.

API scheduler missed slots improved in aggregate from 127 to 70, with zero failures and zero timeouts in both runs. The
idle/interactive cell was the exception: its missed-slot count increased from 7 to 8 and is retained as a non-improvement.

## Input identity and latency

All final numeric-matrix trials were exact within their measured scope: 160/160 steady-state WebSocket trials,
5,760/5,760 expected/received bytes, and zero duplicate, missing, or reordered bytes. These numbers do **not** measure HTTP,
retransmit, reconnect, or reload flows. Separate focused real-browser/server regressions prove normal HTTP input, delayed and
lost ACK retransmission, reconnect, and reload while the server process remains live. Values are pooled median / p95.

| Cell                   |                                                Send |                                           Browser ACK |                                           Probe receipt |                                      Visible convergence |
| ---------------------- | --------------------------------------------------: | ----------------------------------------------------: | ------------------------------------------------------: | -------------------------------------------------------: |
| Idle / idle app        |  2.101 / 5.010 -> 2.039 / 3.273 ms (-3.0% / -34.7%) |     0.850 / 2.500 -> 0.800 / 2.300 ms (-5.9% / -8.0%) |   7.985 / 17.775 -> 7.038 / 11.226 ms (-11.9% / -36.8%) | 13.100 / 263.000 -> 12.650 / 291.800 ms (-3.4% / +11.0%) |
| Idle / interactive app |  1.447 / 2.603 -> 1.528 / 3.652 ms (+5.6% / +40.3%) |  0.650 / 21.500 -> 0.800 / 6.000 ms (+23.1% / -72.1%) |    6.578 / 36.727 -> 6.235 / 18.078 ms (-5.2% / -50.8%) |  11.550 / 51.100 -> 13.000 / 38.600 ms (+12.6% / -24.5%) |
| CPU / idle app         |  2.667 / 7.065 -> 3.063 / 7.630 ms (+14.8% / +8.0%) |  2.750 / 28.800 -> 1.900 / 6.700 ms (-30.9% / -76.7%) |  12.452 / 62.774 -> 12.120 / 26.792 ms (-2.7% / -57.3%) | 15.350 / 461.100 -> 15.100 / 350.100 ms (-1.6% / -24.1%) |
| CPU / interactive app  | 3.745 / 6.316 -> 3.037 / 5.542 ms (-18.9% / -12.2%) | 2.400 / 67.900 -> 1.750 / 10.900 ms (-27.1% / -83.9%) | 18.308 / 74.888 -> 13.720 / 27.640 ms (-25.1% / -63.1%) | 17.950 / 101.900 -> 15.200 / 27.000 ms (-15.3% / -73.5%) |

The measured live-server input transport was instrumented and locked down, not optimized in the retained runtime. In
particular, idle-interactive send median/p95 and ACK median, CPU-idle send median/p95, idle-idle visible p95, and
idle-interactive visible median did not improve.

Release limitation: a server restart after PTY application but before the browser receives/persists its ACK loses the
process-local server dedup state. The durable retry can therefore deliver one duplicate PTY record. This pre-existing
boundary is deliberately asserted by `test/terminal-input-performance.browser.test.ts`, is tracked separately as
COD-363, and was not changed by COD-356. The exact-byte result above must not be read as exactly-once delivery across a
server restart.

## Longitudinal browser observations

No Task 5, 6, or 7 product candidate remains. These values therefore must not be described as causal frontend wins.

| Cell                   |                                             Navigation median / p95 |                                              App-ready median / p95 |                                       First-terminal median / p95 |      Long-task count median / p95 |              Long-task duration median / p95 |
| ---------------------- | ------------------------------------------------------------------: | ------------------------------------------------------------------: | ----------------------------------------------------------------: | --------------------------------: | -------------------------------------------: |
| Idle / idle app        |           480.186 / 500.871 -> 501.178 / 506.849 ms (+4.4% / +1.2%) |           591.218 / 614.494 -> 622.716 / 626.071 ms (+5.3% / +1.9%) |         512.636 / 631.179 -> 525.054 / 590.602 ms (+2.4% / -6.4%) |  4 / 4 -> 5 / 5 (+25.0% / +25.0%) |      93 / 136 -> 99 / 138 ms (+6.5% / +1.5%) |
| Idle / interactive app |          481.397 / 574.670 -> 496.798 / 507.606 ms (+3.2% / -11.7%) |          591.586 / 703.122 -> 614.719 / 631.799 ms (+3.9% / -10.1%) | 1,219.497 / 2,753.784 -> 1,120.168 / 2,739.541 ms (-8.1% / -0.5%) |  4 / 4 -> 5 / 5 (+25.0% / +25.0%) |    90.5 / 138 -> 89 / 148 ms (-1.7% / +7.2%) |
| CPU / idle app         |    1,118.845 / 1,136.158 -> 973.515 / 1,052.261 ms (-13.0% / -7.4%) |  1,336.140 / 1,356.893 -> 1,172.372 / 1,292.311 ms (-12.3% / -4.8%) | 1,296.550 / 1,489.394 -> 990.997 / 1,245.852 ms (-23.6% / -16.4%) | 21 / 23 -> 21 / 22 (0.0% / -4.3%) |     76 / 240 -> 75 / 272 ms (-1.3% / +13.3%) |
| CPU / interactive app  | 1,235.974 / 1,411.090 -> 1,011.006 / 1,022.830 ms (-18.2% / -27.5%) | 1,444.743 / 1,615.820 -> 1,227.193 / 1,264.005 ms (-15.1% / -21.8%) | 1,942.354 / 1,992.312 -> 1,803.477 / 1,916.534 ms (-7.1% / -3.8%) | 23 / 26 -> 23 / 24 (0.0% / -7.7%) | 76.5 / 241 -> 80.5 / 269 ms (+5.2% / +11.6%) |

Non-improvements include idle-host navigation/app-ready medians, idle-idle first-terminal median, idle-host long-task
counts, long-task-duration p95 in every cell, and CPU-interactive long-task-duration median. Resource count,
transfer/decoded bytes, and DOM nodes were broadly unchanged, as expected with no retained frontend split.

## Checkpoint and rejected experiment evidence

### Task 3 after-poller checkpoint

The inherited untracked `after-poller` report pair is valid and retained as partial/negative evidence:

- runtime `ecd182f4baa4fa87e974c6f97669ff633e15d59f` is reachable from the branch;
- report set `96e0bf52c3144a204fda118082753b2a` and environment hash
  `0fd7d6c9ad527d73ca96511d86b642b516f9229b741c1937342bb004c14b13f4` validate;
- all four cells contain five samples plus a warmup, 7/7 CPU workers met deadline, all 160 steady-state WebSocket trials
  were exact, capture overlap was at most two, and cleanup/provenance/assets were clean;
- raw artifacts remain at `/tmp/cod356-artifacts-after-poller-ZWpnam`.

Task 3 Step 8 remains unchecked because its explicit gate was not fully met against the then-accepted historical
baseline: idle-idle event-loop p95 improved 38.666 -> 18.399 ms, but API p95 regressed
38.246 -> 44.190 ms (+15.5%). CPU-idle improved on both measures. Those values are checkpoint history, not the corrected
final-pair baseline above.

### Tasks 5-7

| Task             | Candidate  | Revert     | Outcome                                                                                                                 |
| ---------------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------- |
| Input hot path   | `f58f3ea9` | `02bfc38a` | No material cold-owner improvement; steady p95 regressions. No runtime retained.                                        |
| Frontend startup | `ef38287c` | `ddf16027` | Smaller optional asset, but app-ready/long-task retention gate failed. No runtime retained.                             |
| Rendering        | `6ca0598d` | `6890c8a4` | Removed a measured redundant rebuild, but immutable-parent end-to-end tails/CPU medians regressed. No runtime retained. |

Candidate-specific lazy/render tests were removed with their non-shipping behavior and were not recreated for Task 8.
The retained negative reports and findings remain part of the audit trail.

## Regressions and repository gates

Planned Node inventory found nine runnable files. `test/frontend-lazy-loading.test.ts` and
`test/frontend-render-budget.test.ts` are absent after their explicit candidate reverts; `test/terminal-flush-budget.test.ts`
is retained and was run.

- Eight-file Task 2/3/4 Node command: 8 files passed, 158 passed, 1 intentional skip.
- Retained terminal flush budget: 1 file passed, 7 passed.
- Required browser command: 4 files passed, 42 passed.
- Product regression aggregate: 13 files passed, 207 assertions passed, 1 skipped.
- Fresh performance-infrastructure suites (`test/perf-cod-356-asset-report.test.ts` and
  `test/perf-cod-356-harness.test.ts`): 2 files passed, 111 passed.
- Combined verification inventory: 15 files passed, 318 assertions passed, 1 skipped.

| Gate                             | Result                                                                |
| -------------------------------- | --------------------------------------------------------------------- |
| `npm run typecheck`              | exit 0                                                                |
| `npm run lint`                   | exit 0; one unchanged `src/web/server.ts:1549` explicit-`any` warning |
| `npm run format:check`           | exit 0                                                                |
| `npm run check:lockfile`         | exit 0; `1.19.11` in sync                                             |
| `npm run check:frontend-syntax`  | exit 0; 39 files parse                                                |
| `npm run check:browser-excludes` | exit 0; all 29 browser files excluded from CI collection              |
| `npm run build`                  | exit 0; unchanged duplicate Chinese `Idle` key warning in `i18n.js`   |
| `git diff --check`               | exit 0                                                                |

The warning source files have no COD-356 diff from `origin/local`.

## Realistic smoke: qualified equivalent pass

The default skill script was run without `--base`; production was never addressed. Every run used a free loopback port,
temporary `HOME`, unique tmux socket, real Codex and Claude (preflight passed), two shell sessions, repeated tab switches,
reload/replay, and 100,120 logical history lines over the configured 100,000-line scrollback.

| Runtime                               | Artifact                                                                 | Result           | Browser diagnostics                     |
| ------------------------------------- | ------------------------------------------------------------------------ | ---------------- | --------------------------------------- |
| Branch `72da85a0`, run 1              | `/tmp/codeman-dev-smoke-artifacts-2026-08-22T23-54-35-972Z/summary.json` | 130 pass, 2 fail | 0 page errors, 0 serious console errors |
| Exact-source control `ca11a1d7`       | `/tmp/codeman-dev-smoke-artifacts-2026-08-23T00-00-16-321Z/summary.json` | 132 pass, 0 fail | 0 page errors, 0 serious console errors |
| Branch `72da85a0`, run 2              | `/tmp/codeman-dev-smoke-artifacts-2026-08-23T00-03-24-573Z/summary.json` | 130 pass, 2 fail | 0 page errors, 0 serious console errors |
| Branch `72da85a0`, observational copy | `/tmp/codeman-dev-smoke-artifacts-2026-08-23T00-20-00-635Z/summary.json` | 132 pass, 0 fail | 0 page errors, 0 serious console errors |

Both installed-run branch runs failed:

1. `shell viewport scroll-down returns to late replayed history after reload`;
2. `shell viewport scroll-up reveals text before dashed divider after reload`.

The first failure occurs after the backend and full browser buffer both prove first/last history retention. In each failed
run, the helper's bottom jump did not expose the final marker at its one fixed 300 ms observation, after which its fallback
scrolled away for 120 steps; the second check inherited that viewport. A later bottom jump in the same run succeeded. The
detached `ca11a1d7` control passed all checks, and
`git diff ca11a1d7..72da85a0 -- src packages package.json package-lock.json config` is empty. The later `cc15b593`
harness correction changes benchmark-only files and removes one detached orphan JSDoc block from `src/session.ts`; it
does not change executable runtime or browser behavior, so the realistic smoke was not rerun.

To test whether the fixed wait observed a correct xterm buffer before DOM rows repainted, one temporary copy added a
read-only state observation plus a bounded condition poll before the existing fallback. The copy was
`/tmp/cod356-smoke-diagnostic-MxxklB/run-codeman-prod-smoke-diagnostic.mjs` (SHA-256
`7e6edce616d567baeee754f15d14f8148eb7138d04c16ba6e1d2dcae6bbc6122`); the installed runner remained unchanged at
SHA-256 `2c651f104f7cd00dcc776765a4e729c4819a2fd1ac849fa34991fa64f9eab8f6`. The diagnostic run preserved the workload and
all 132 original assertions. Its old fixed-300 ms condition passed (`steps=jump`, `viewportY=48409`), so the added poll
never executed and the persisted `diagnostics` array is empty. This is an equivalent unchanged-branch 132/132 pass, but
it did **not** reproduce the two failures, confirm the renderer-lag hypothesis, or establish a smoke-skill fix. The
diagnostic stdout is retained at `/tmp/cod356-smoke-diagnostic-MxxklB/run.log`. With those qualifications, Task 8 Step 4
is satisfied for review.

All four summaries contain no page errors or serious console errors. They do contain the skill's filtered WebGL/GPU-stall,
canvas-fallback, deferred-write, and long-task diagnostics. Cleanup also logged benign `ESRCH` warnings when already-dead
processes/process groups were targeted.

Every smoke session cleanup endpoint returned 200 and each temporary server stopped. The script left only its unserved
unique tmux socket path; each was checked for no listener/server/session and then unlinked. All temporary homes/workdirs,
exact session processes, sockets, and the detached control worktree are absent. Diagnostic port `40457` has no listener,
and its four recorded PTY PIDs are absent. Screenshot artifacts were retained only under the four artifact directories
above.

## Commit ledger

| Commit                                                                                                                             | Role                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `d7278c60`                                                                                                                         | approved design                                                                |
| `a445cdaf`                                                                                                                         | implementation plan / comparison revision                                      |
| `ddf717da`                                                                                                                         | benchmark harness and initial baseline                                         |
| `4a149c42`                                                                                                                         | retained async tmux capture                                                    |
| `0ed28530`                                                                                                                         | comparison-revision provenance support                                         |
| `ecd182f4`                                                                                                                         | retained shared async activity polling                                         |
| `3c81576e`, `bb46dac3`                                                                                                             | stabilized harness and corrected baseline evidence                             |
| `5b8565ab`, `f1f3dd8d`, `0989dd85`, `f329e930`, `5984fed2`, `5993b59f`, `5076b402`, `c0a38ae6`, `f4454c6a`, `a53be09c`, `23796559` | retained input tracing, correlation, lifecycle tests, and evidence corrections |
| `f58f3ea9`, `02bfc38a`, `063880d7`                                                                                                 | rejected/reverted input candidate and negative evidence                        |
| `ef38287c`, `ddf16027`, `ca11a1d7`                                                                                                 | rejected/reverted frontend candidate and negative evidence                     |
| `6ca0598d`, `6890c8a4`, `72da85a0`                                                                                                 | rejected/reverted render candidate and negative evidence                       |
| `cc15b593`                                                                                                                         | identity-safe listener/process-tree cleanup harness and provenance correction  |

## Release decision

Specification and quality reviews are approved with no remaining findings. The quality review's Important findings were
remediated with TDD, the isolated `cc15b593` harness commit, and a newly matched comparison/final pair. Release bookkeeping
must preserve the negative Task 3/5/6/7 evidence, the longitudinal-browser caveat, both failed installed-run branch
smokes, the diagnostic non-reproduction, and the explicit absence of push, merge, and deployment authorization. Jira
comment `21576` records that evidence; COD-356 remains `To Do` with no transition performed.
