/**
 * The test suites that `npm test` deliberately does NOT run, in one place.
 *
 * Why this file exists: the exclusion list used to live only in
 * config/vitest.ci.config.ts, as literals. Anything excluded there was
 * therefore reachable only by running the everything-config by hand and reading
 * past its failures — and a newly excluded file was reachable by nothing at
 * all, silently, because nothing pointed at it. Both configs now derive their
 * globs from the arrays below, so adding a suite here puts it in exactly one
 * runner and takes it out of exactly one gate.
 *
 * Adding a new test that cannot run in CI: put its glob in the array that
 * describes WHY it cannot, not in whichever one is shortest.
 */

/**
 * Playwright-driven: needs chromium and, in most cases, a live Codeman server
 * on a real port. Deterministic where the environment provides both, which is
 * why these are a runnable suite (`npm run test:browser`) rather than skipped.
 *
 * COD-346 — can this become gating? Not on the current CI. The pipeline installs
 * no browser on purpose (metered minutes), and `codex-predictive-echo` needs a
 * real codex binary on PATH, which no runner has. So it stays a LOCAL gate: run
 * `npm run test:browser` by hand before landing anything that touches terminal,
 * tab-layout, preview or mobile surfaces, and diff the FAIL list against the
 * deploy branch. That blind spot is what let this whole suite rot unnoticed.
 *
 * One known-unstable test, and it is unstable for its environment rather than
 * its subject: `codex-predictive-echo` › #219 waits on a REAL codex TUI to paint
 * `abcXYZ` within 15s. Measured on 2026-08-29: 5/5 green in isolation, red in 2
 * of 4 full-suite runs, where the machine is loaded. Its correctness assertions
 * (span count, byte identity) never even run when it fails — only the render
 * deadline does. `waitForPaneText` now carries the last captured pane into the
 * timeout message so the next occurrence can be told apart from #219 actually
 * recurring (`abc` present, `XYZ` missing) instead of being re-diagnosed blind.
 */
export const BROWSER_TEST_GLOBS = [
  'test/*.browser.test.ts',
  'test/inline-rename.test.ts',
  'test/opencode-resize.test.ts',
  'test/webgl-fallback.test.ts',
  'test/terminal-copy-shortcut.test.ts',
  'test/terminal-keycode229-recovery.browser.test.ts',
  'test/capture-load-window.browser.test.ts',
  'test/capture-geometry-retry.browser.test.ts',
  'test/codex-predictive-echo.test.ts', // also needs a real codex binary
  'test/split-pane-terminal.browser.test.ts',
  'test/terminal-tile-scroll.browser.test.ts',
  'test/shift-enter-keypress.browser.test.ts',
  'test/key-tester.browser.test.ts',
  'test/webhook-settings.browser.test.ts',
  'test/case-custom-path.browser.test.ts',
  'test/doctor-settings.browser.test.ts',
  'test/git-status.browser.test.ts',
  'test/split-pane-orchestration.browser.test.ts',
  'test/split-pane-auto-collapse.browser.test.ts',
];

/**
 * Wall-clock benchmarks. They assert on durations, so a loaded shared runner
 * fails them for reasons that have nothing to do with the diff under test.
 */
export const PERF_TEST_GLOBS = ['test/perf-*.test.ts'];

/**
 * Browser + visual regression: chromium AND environment-specific PNG baselines
 * that are generated per machine. Has its own config
 * (test/mobile/vitest.config.ts) because it needs serial execution, a longer
 * timeout and the `pretest:mobile` vendor step — run it with
 * `npm run test:mobile`, not through the configs here.
 *
 * COD-346 — can this become gating? No, and less arguably than the browser
 * suite: the PNG baselines are generated per machine, so a shared runner would
 * fail them for the machine it is, not for the diff it is testing. Local gate
 * only, same rule as above.
 */
export const MOBILE_TEST_GLOBS = ['test/mobile/**'];

/** Everything `npm test` skips. */
export const NON_CI_TEST_GLOBS = [...MOBILE_TEST_GLOBS, ...PERF_TEST_GLOBS, ...BROWSER_TEST_GLOBS];
