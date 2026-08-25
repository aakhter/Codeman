# COD-370 Mobile OpenCode Font Performance Comparator

## Question and scope

Measure whether the COD-370 OpenCode phone font change from the exact pre-feature runtime
`d080481690dc62ffc0d0d4f8e7daae2cc8bf8613` (10px) to the final branch runtime (8px, or the explicit 9px fallback only if
the complete 8px matrix fails) materially regresses phone typing performance.

This comparator intentionally connects one 390x844 iPhone-Chrome-emulated viewer to one real OpenCode session. The base
runtime predates active-viewer handoff, so desktop/phone handoff is not comparable across revisions. Handoff correctness
remains covered by the separate final-head two-viewer acceptance test. An allocated but never navigated desktop browser
context is not a connected viewer and exists only because the shared fail-closed fixture accounts for both contexts.

## Runtime and harness provenance

- Baseline runtime: a disposable detached worktree pinned to
  `d080481690dc62ffc0d0d4f8e7daae2cc8bf8613`.
- Candidate runtime: the final committed head of `COD-370-active-viewer-terminal-sizing` after the two runtime review fixes
  land.
- Harness: the same committed `test/mobile/opencode-e2e.test.ts` and
  `test/utils/cod370-opencode-fixture.ts` for every cell. The report records their Git blob IDs and SHA-256 hashes.
- Dependencies: the candidate checkout's installed dependencies drive Vitest/Playwright/tsx for both cells through an
  untracked `node_modules` symlink; the report records `package-lock.json` hashes from both runtimes and refuses a
  mismatch. Each disposable runtime receives the same ignored browser-vendor build artifacts (including the separately
  generated predictive-echo bundle), and every served vendor hash is recorded and compared across all cells.
- The fixture launches `src/index.ts web` from the selected runtime root. No product source is copied, patched, or
  overlaid into the baseline worktree.

Each raw result must record the requested runtime SHA, observed runtime SHA, dirty status, harness hashes, host identity,
timestamp, OpenCode/tmux/PID identity, viewport, CPU throttle, font size, and cleanup proof. The run fails before starting
if the runtime SHA is wrong, the worktree is dirty, the lockfiles differ, or the output path already exists.

## Matrix and ordering

Run two complete independent repetitions per runtime in ABBA order to reduce warmup/time bias:

1. baseline repetition 1
2. candidate repetition 1
3. candidate repetition 2
4. baseline repetition 2

Every repetition creates a fresh temporary Codeman server, tmux socket, browser, OpenCode session, and 390x844 phone
context. Within a repetition, run the complete 1x cell followed by the complete 4x CDP-throttled phone-page cell. Clear
the first composer payload and cross an observed empty-composer/readiness barrier before the second cell.

## Per-cell contract

Use the same fixed ten-character payloads for all runtimes and repetitions. For every character:

1. arm the keydown/visibility clock before dispatch;
2. dispatch through Playwright's keyboard path;
3. wait for the exact cumulative token in both the tmux pane and xterm;
4. retain the dispatch-to-visible sample without filtering or trimming.

Record all ten raw samples plus median, nearest-rank p95, and maximum. The long-task observer window starts before the
first dispatch and ends only after input delivery and pane/xterm convergence. Record every long task, not only tasks that
overlap a slow sample.

Also require and record:

- exact expected, logical-input, WebSocket-payload, and UTF-8 byte totals;
- exact ordered logical and durable frame arrays, unique durable client/sequence identities, and serialized WS bytes;
- exact final pane and xterm composer token once, with no duplicated prefix/suffix;
- authoritative changed-dimension event count and final pane/xterm dimensions;
- exact font size (10px baseline, 8px candidate unless the full matrix is explicitly rerun at 9px);
- a live OpenCode PID/start-time/executable/command and unchanged tmux session/window/pane identity at every checkpoint;
- no page errors or serious console errors/warnings.

There is no selective retry or sample deletion. A failed cell invalidates its whole repetition. Any 9px fallback decision
requires a new complete ABBA matrix; 8px and 9px samples must never be combined.

## Comparison and decision rule

The generated report aggregates all 20 samples for each runtime/rate and reports absolute values and candidate-minus-base
deltas for median, p95, maximum, WS bytes, dimensions, resize events, and long tasks. It also lists each repetition so
between-run spread stays visible.

The 8px candidate passes the performance non-regression gate when all correctness/cleanup contracts pass and neither 1x
nor 4x dispatch-to-visible p95 regresses by more than both 20ms and 20% versus baseline. Any new serious browser warning,
byte mismatch, duplicated/reordered input, resize storm, process replacement, or surviving resource is an unconditional
failure. A statistically noisy latency result near the threshold is reported as inconclusive rather than selectively
rerun.

## Fail-closed cleanup

Every repetition independently closes both contexts and Chromium, performs authenticated DELETE followed by GET 404 for
the exact session, proves the live OpenCode and pane PIDs dead, proves the exact tmux target/socket absent, rebinds the
exact loopback port, proves launcher/listener/fixture-tagged Chromium processes absent, and removes only the validated
temporary scenario root. Cleanup attempts continue after individual failures and aggregate errors; a missing cleanup
proof fails the repetition.

The disposable baseline worktree is removed only after all raw artifacts and the generated report are committed or their
technical blocker is reported. No Jira, push, merge, deployment, production service, or production tmux socket is touched.
