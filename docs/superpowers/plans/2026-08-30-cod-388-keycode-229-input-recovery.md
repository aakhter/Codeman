# COD-388 keyCode 229 Input Recovery Implementation Plan

> **For agentic workers:** Execute each task with red-green TDD and verify evidence before proceeding.

**Goal:** Recover explicit non-composing keyCode 229 printable and Enter input exactly once without changing genuine
IME handling.

**Architecture:** A lifecycle-owned browser controller waits behind xterm's canonical textarea diff, invokes the
existing Codeman terminal-data handler only when xterm emits nothing, and suppresses a delayed matching canonical event
only when it is attributable to the same key token.

**Tech Stack:** Plain browser JavaScript, xterm.js, Vitest, Playwright/Chromium, TypeScript ESM test harnesses.

---

## File Map

- Create: `src/web/public/terminal-keycode229-recovery.js`
- Modify: `src/web/public/index.html`
- Modify: `scripts/build.mjs`
- Modify: `src/web/public/terminal-ui.js`
- Create: `test/terminal-keycode229-recovery.test.ts`
- Modify: `test/terminal-copy-shortcut.test.ts`

### Task 1: Pin the recovery state machine with failing unit tests

- [ ] Add a VM harness for the shipped browser module with controlled microtasks, timers, clock, and textarea events.
- [ ] Cover printable/Enter recovery, canonical cancellation, late exact-once suppression, repeated keys, ordinary
      same-character keys, ineligible events, and destruction.
- [ ] Run `npm test -- test/terminal-keycode229-recovery.test.ts` and confirm failure because the module is absent.

### Task 2: Implement the standalone recovery controller

- [ ] Implement event eligibility and controller lifecycle without importing application state.
- [ ] Queue fallback after xterm's own keydown work and keep all recovery/deduplication state bounded.
- [ ] Re-run `npm test -- test/terminal-keycode229-recovery.test.ts` until green.

### Task 3: Pin and implement terminal integration

- [ ] Add a real-browser regression that dispatches the production 229/no-mutation sequence and initially observes no
      terminal data.
- [ ] Load/minify/hash the module before `terminal-ui.js`.
- [ ] Initialize/destroy the controller with xterm and route both canonical and recovered data through one existing
      application handler.
- [ ] Re-run the focused browser test and preserve the existing Chinese IME punctuation test.

### Task 4: Review and focused verification

- [ ] Run the focused unit test and `npm run test:browser -- test/terminal-copy-shortcut.test.ts`.
- [ ] Run `git diff --check`, inspect all changed paths, and complete an independent code review.
- [ ] Address every correctness issue and re-run affected tests.

### Task 5: Release and delivery gates

- [ ] Add a patch changeset, consume it with `npm run version-packages`, update the documented version, and explicitly
      stage only COD-388 files.
- [ ] Run typecheck, lint, format check, lockfile check, frontend syntax, public-assets, browser-excludes, targeted tests,
      and `npm run build` without running the managed-session-unsafe full suite.
- [ ] Commit implementation and release metadata with COD-388 subjects.

### Task 6: Merge, push, deploy, and verify

- [ ] Merge the feature branch into the production `local` checkout while preserving its unrelated untracked files.
- [ ] Push only Bitbucket `origin/local`; do not write to GitHub/upstream.
- [ ] Build, restart `codeman-web`, and verify the user service, repeated HTTP 200 responses, deployed asset/version, and
      delayed readiness.
- [ ] Run the exact production `w1-home-mon` Chromium/tmux smoke test, remove the marker, inspect console/transport
      evidence, update COD-388 with branch/commits/tests/deployment, and transition it to Done only if live typing passes.
