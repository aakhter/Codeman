# COD-248 Mobile Terminal Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep xterm and the PTY at the final mobile dimensions whenever the header utility tray changes terminal height.

**Architecture:** `toggleMobileHeaderUtilities()` already owns the CSS class change that changes `.app` padding. After that synchronous layout change it will notify the existing window resize listener. The terminal UI’s established trailing-edge resize pipeline will then perform one fit and one dimensions-aware PTY resize; no second resize implementation or observer is introduced.

**Tech Stack:** Plain browser JavaScript, xterm FitAddon, Vitest, Playwright.

---

### Task 1: Add the mobile terminal geometry regression

**Files:**
- Modify: `test/mobile/header-buttons.test.ts`

- [x] **Step 1: Write the failing browser test**

Add a phone-browser case that creates and starts a shell session through `/api/sessions`, selects it, records `window.app.terminal.rows`, opens `.mobile-header-utility-toggle`, waits 400ms, then asserts the terminal rows and `_lastResizeDims.rows` equal `window.app.fitAddon.proposeDimensions().rows`. Delete the temporary session in `finally`.

```ts
expect(after.rows).toBe(after.proposed.rows);
expect(after.lastResizeRows).toBe(after.proposed.rows);
expect(after.rows).toBeLessThan(before.rows);
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/mobile/header-buttons.test.ts -t "resizes the terminal after expanding header utilities"`

Expected: FAIL because the expanded terminal proposes fewer rows but xterm and `_lastResizeDims` retain the collapsed row count.

- [ ] **Step 3: Commit the failing test**

```bash
git add test/mobile/header-buttons.test.ts
git commit -m "test: COD-248 reproduce mobile header terminal resize"
```

### Task 2: Notify the established terminal resize pipeline

**Files:**
- Modify: `src/web/public/app.js:4618-4627`

- [x] **Step 1: Implement the minimal fix**

After the toggle applies the header, app-shell, and aria state, dispatch the browser resize event already consumed by the terminal UI:

```js
window.dispatchEvent(new Event('resize'));
```

Keep the existing 300ms trailing-edge behavior in `terminal-ui.js`; it owns fit, keyboard safeguards, dimension de-duplication, and WebSocket/HTTP PTY resize delivery.

- [x] **Step 2: Run the focused regression**

Run: `npm test -- test/mobile/header-buttons.test.ts -t "resizes the terminal after expanding header utilities"`

Expected: PASS with the live xterm and recorded resize dimensions matching the proposed mobile rows.

- [x] **Step 3: Run the full targeted mobile header file**

Run: `npm test -- test/mobile/header-buttons.test.ts`

Expected: PASS, 6 tests.

- [x] **Step 4: Commit the fix**

```bash
git add src/web/public/app.js test/mobile/header-buttons.test.ts
git commit -m "fix: COD-248 resize terminal after mobile header toggle"
```

### Task 3: Preserve the COD Jira CLI workflow and verify delivery

**Files:**
- Modify: `AGENTS.md:43-50`

- [x] **Step 1: Carry forward the approved workflow rule**

State that Jira-backed Codeman work uses `JIRA_PROFILE=work JIRA_SITE=https://aakhter.atlassian.net jira` with project `COD`, and explicitly prohibits Jira MCP, GitHub Issues, and Bitbucket Issues.

- [x] **Step 2: Run static and build checks**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: each command exits 0.

- [x] **Step 3: Commit the workflow documentation**

```bash
git add AGENTS.md docs/superpowers/plans/2026-07-27-cod-248-mobile-terminal-resize.md
git commit -m "docs: COD-248 document Jira CLI workflow"
```

- [ ] **Step 4: Integrate and deploy**

Merge the feature commits into the deploy checkout’s `local` branch, push `origin/local`, run the established sync/deploy workflow, then verify active `codeman-web`, repeated HTTP 200 from port 3002, and the live application behavior.

- [ ] **Step 5: Update Jira**

Use `JIRA_PROFILE=work JIRA_SITE=https://aakhter.atlassian.net jira` to add the branch, commits, verification, and deployment result to `COD-248`, then transition it to Done only after deployment verification.
