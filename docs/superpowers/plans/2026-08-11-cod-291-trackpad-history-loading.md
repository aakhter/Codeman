# COD-291 Trackpad History Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent MacBook trackpad direction-reversal tails from canceling the initial frozen-history load.

**Architecture:** Reuse the existing monotonic history-load generation as a precise pending-load token. The scroll funnel suppresses only automatic bottom exit while that token matches the active generation; explicit exits and post-load bottom scrolling remain unchanged.

**Tech Stack:** Browser JavaScript, xterm.js, Vitest static contract tests, Playwright production smoke.

---

### Task 1: Add the failing history-loading regression contract

**Files:**
- Modify: `test/mirror-history-view.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that requires `app.js` to initialize, assign, clear, and reset `_historyInitialLoadGen`, and requires the `_handleUserScrollIntent` bottom-exit condition to compare it with `_historyLoadGen`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/mirror-history-view.test.ts`

Expected: FAIL because `_historyInitialLoadGen` does not yet exist.

### Task 2: Implement the generation-token guard

**Files:**
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/terminal-ui.js`
- Test: `test/mirror-history-view.test.ts`

- [ ] **Step 1: Initialize and assign the token**

Initialize `this._historyInitialLoadGen = 0`. Immediately after allocating a generation in `_enterHistoryView`, assign that generation to the token.

- [ ] **Step 2: Clear the token after installation and on exit**

After the synchronized history write passes its generation/view guard, clear the token before landing the viewport. Also clear it in `_exitHistoryView`.

- [ ] **Step 3: Guard automatic bottom exit**

Require `this._historyInitialLoadGen !== this._historyLoadGen` before a positive scroll at the bottom can call `_exitHistoryView`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- test/mirror-history-view.test.ts`

Expected: PASS with 18 tests.

### Task 3: Verify, review, and integrate

**Files:**
- Verify all modified files from Tasks 1 and 2.

- [ ] **Step 1: Run focused and repository checks**

Run:
- `npm test -- test/mirror-history-view.test.ts`
- `npm run check:frontend-syntax`
- `npm run check:public-assets`
- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm run check:lockfile`
- `npm run build`

Expected: every command exits 0.

- [ ] **Step 2: Run realistic smoke**

Run: `node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --skip-claude`

Expected: final summary passes and cleanup completes.

- [ ] **Step 3: Commit and review**

Stage only the spec, plan, source, and test files. Commit with a COD-291 conventional subject and perform pre-merge code review.

- [ ] **Step 4: Push, create/merge the Bitbucket PR, and deploy**

Push the feature branch, merge it into `local` through Bitbucket, update the production checkout from `origin/local`, build, restart `codeman-web`, and verify health.

- [ ] **Step 5: Verify production behavior and update Jira**

Run the delayed-history plus opposite-wheel-tail browser reproduction against port 3002. Confirm the view remains in history and the pill becomes frozen, then comment on COD-291 with branch, PR, commits, checks, deployment, and live evidence.
