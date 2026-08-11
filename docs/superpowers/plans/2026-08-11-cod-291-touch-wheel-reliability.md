# COD-291 Touch and Trackpad History Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mirror-history entry reliable for fractional Chrome trackpad input and restore iPhone terminal touch scrolling.

**Architecture:** Keep the existing mirror-history and mobile-tap designs. Normalize fractional carry only where xterm requires integer rows, and reconnect the existing touch gesture-state helpers to the touch listeners without changing routing or thresholds.

**Tech Stack:** Plain browser JavaScript, xterm.js, Vitest source guards, Playwright/Chromium production probes.

---

### Task 1: Trackpad integer landing regression

**Files:**
- Modify: `test/mirror-history-view.test.ts`
- Modify: `src/web/public/app.js`

- [ ] Add a test requiring `_enterHistoryView` to derive a non-negative integer carry and pass that value to `terminal.scrollLines`.
- [ ] Run `npm test -- test/mirror-history-view.test.ts` and confirm the new assertion fails against `scrollLines(-carryLines)`.
- [ ] Truncate the positive carry to whole rows immediately before the history landing scroll.
- [ ] Rerun the focused test and confirm it passes.

### Task 2: Touch gesture lifecycle regression

**Files:**
- Modify: `test/terminal-touch-tap.test.ts`
- Modify: `src/web/public/terminal-ui.js`

- [ ] Add structural lifecycle assertions requiring `touchGesture` creation, `_beginTerminalTouchGesture` on touch start, and cancellation on touch cancel.
- [ ] Run `npm test -- test/terminal-touch-tap.test.ts` and confirm the assertion fails because the merged listener has undeclared references.
- [ ] Integrate the gesture-state helpers with the newer tap classification/focus behavior and restore cleanup.
- [ ] Rerun the focused test and confirm it passes.

### Task 3: Verification and integration

**Files:**
- Verify all modified source, tests, docs, and built assets.

- [ ] Run the two focused suites plus frontend syntax/assets, typecheck, lint, format check, lockfile check, build, and `git diff --check`.
- [ ] Run the realistic browser smoke against an isolated dev instance and inspect console/page errors.
- [ ] Commit with COD-291, push the feature branch, fast-forward `origin/local`, and deploy `codeman-web`.
- [ ] Repeat production Chrome mouse/trackpad and iPhone touch probes against `w10-tcc`.
- [ ] Update COD-291 with the corrected RCA, commits, checks, deployment, and live evidence; move it to Done only after production verification.
