# COD-357 Frontend Initialization Crash Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Codeman browser startup so the 11 backend-restored sessions hydrate and render in the navbar.

**Architecture:** Remove the orphaned call to the superseded COD-208 Auto Copy installer while preserving the current gesture-bound Auto Copy implementation. Consolidate regression coverage in the current Auto Copy suite, then verify the built application through an authenticated browser and an unchanged tmux inventory.

**Tech Stack:** Browser JavaScript, Vitest, Node.js/TypeScript build, Playwright, tmux, guarded `codeman-ctl` deployment.

---

### Task 1: Pin and repair the frontend initialization mismatch

**Files:**
- Modify: `test/terminal-auto-copy.test.ts`
- Delete: `test/terminal-selection-autocopy.test.ts`
- Modify: `src/web/public/terminal-ui.js`

- [ ] **Step 1: Add the failing current-wiring regression**

Add this test inside `describe('Auto Copy wiring', ...)` in `test/terminal-auto-copy.test.ts`:

```ts
  it('does not call the removed timer-based selection installer during terminal initialization', () => {
    expect(terminalUi).not.toContain('_installTerminalSelectionAutoCopy');
  });
```

- [ ] **Step 2: Run the focused current suite and verify RED**

Run:

```bash
npm test -- test/terminal-auto-copy.test.ts
```

Expected: one failure because `terminal-ui.js` still contains `_installTerminalSelectionAutoCopy`.

- [ ] **Step 3: Remove the stale production call**

Change the `initTerminal()` sequence in `src/web/public/terminal-ui.js` from:

```js
    this.terminal.open(container);
    this._installTerminalSelectionAutoCopy();
    this._installMobileTapMouseGuard();
```

to:

```js
    this.terminal.open(container);
    this._installMobileTapMouseGuard();
```

- [ ] **Step 4: Retire the superseded COD-208 test file**

Delete `test/terminal-selection-autocopy.test.ts`. Its five tests invoke private methods removed by the current gesture-bound implementation; equivalent current behavior remains covered by `test/terminal-auto-copy.test.ts`.

- [ ] **Step 5: Run the focused suite and verify GREEN**

Run:

```bash
npm test -- test/terminal-auto-copy.test.ts
```

Expected: all tests pass with no failures.

- [ ] **Step 6: Check the focused diff**

Run:

```bash
git diff --check
git diff -- src/web/public/terminal-ui.js test/terminal-auto-copy.test.ts test/terminal-selection-autocopy.test.ts
```

Expected: one production-line deletion, one regression test addition, and removal of only the obsolete test file.

- [ ] **Step 7: Commit the repair**

```bash
git add -- src/web/public/terminal-ui.js test/terminal-auto-copy.test.ts test/terminal-selection-autocopy.test.ts
git commit -m "fix(web): COD-357 restore frontend initialization"
```

### Task 2: Verify the worktree result

**Files:**
- Verify: `src/web/public/terminal-ui.js`
- Verify: `test/terminal-auto-copy.test.ts`

- [ ] **Step 1: Run static quality gates**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
```

Expected: all commands exit zero; known pre-existing warnings may remain but no errors are introduced.

- [ ] **Step 2: Build production assets**

Run:

```bash
npm run build
```

Expected: build completes and the hashed `terminal-ui` asset contains no `_installTerminalSelectionAutoCopy` reference.

- [ ] **Step 3: Confirm repository cleanliness**

Run:

```bash
git status --short --branch
git diff --check
```

Expected: the branch is clean after committed changes.

### Task 3: Integrate and deploy without touching tmux sessions

**Files:**
- Integrate into: `local`
- Runtime verification: `/home/aakhter/.codeman/logs/codeman-it15.log`

- [ ] **Step 1: Recheck the shared checkout and integrate**

From `/home/aakhter/.codeman/app`, verify that `local` is clean, then cherry-pick the repair commit:

```bash
git status --short --branch
git branch --show-current
git cherry-pick fix/COD-357-frontend-init-crash
```

Expected: `local` advances by the repair commit without conflicts.

- [ ] **Step 2: Re-run focused verification on the integrated commit**

```bash
npm test -- test/terminal-auto-copy.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: focused tests and all gates pass; production assets are rebuilt before restart.

- [ ] **Step 3: Record the tmux inventory and restart only the web server**

```bash
tmux -L codeman list-sessions -F '#{session_name}|#{session_created}|#{session_windows}'
codeman-ctl restart
```

Expected: 11 sessions before restart; guarded controller reports a running HTTPS app and does not terminate tmux.

- [ ] **Step 4: Verify the browser acceptance criteria**

Use an isolated Playwright browser with the deployment's local Basic Auth credentials and `ignoreHTTPSErrors: true`. After `domcontentloaded` and SSE initialization, evaluate:

```js
({
  appSessions: window.app?.sessions?.size,
  sessionOrder: window.app?.sessionOrder,
  tabCount: document.querySelectorAll('.session-tab').length,
})
```

Expected: `appSessions === 11`, `sessionOrder.length === 11`, `tabCount === 11`, and no uncaught page exception.

- [ ] **Step 5: Confirm runtime and tmux health**

```bash
codeman-ctl status
tmux -L codeman list-sessions -F '#{session_name}|#{session_created}|#{session_windows}'
```

Expected: app and tunnel are up; the tmux inventory is byte-for-byte identical to the pre-restart inventory.

- [ ] **Step 6: Push and close out**

```bash
git push origin local
```

Add the verified result to COD-357 and transition it to Done only if external-disclosure approval is available; otherwise report that bookkeeping item separately without delaying the repaired deployment.
