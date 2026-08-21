# COD-354 Codex Needs-Input Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore one durable Codex idle approval and yellow/orange tab alert after a real zero-agent turn without weakening COD-350 live-agent suppression.

**Architecture:** Treat output received after a Codex session has already reached raw `idle` as TUI repaint, so it cannot invalidate the event-bound zero-agent inspection; explicit input and a real working transition still advance the terminal epoch. At the activity decision boundary, route a fresh exact-zero Codex `raw_idle` decision through the existing listener commit path while keeping Claude and live-agent settlement behavior unchanged.

**Tech Stack:** TypeScript ESM, Vitest fake timers and route/listener integration tests, Fastify/SSE approval inbox, Playwright browser tests, esbuild.

---

### Task 1: Preserve the Codex turn-end evidence fence across idle repaint output

**Files:**

- Modify: `src/session.ts`
- Test: `test/session-agent-activity-contract.test.ts`

- [ ] **Step 1: Write the failing idle-repaint contract test**

Add a test that creates a Codex `Session`, puts it into raw idle after a working transition, calls `_handleTerminalOutput()` with a repaint frame, and asserts that `terminalActivityEpoch` does not change. In the same test, deliver `write('next turn\r')` through a stub PTY and assert that the epoch advances, proving real input still fences stale decisions.

```ts
it('does not let idle Codex repaint output invalidate a completed turn', () => {
  const session = new Session({ workingDir: '/tmp', mode: 'codex' });
  const access = contractAccess(session);
  access._markWorking();
  access._status = 'idle';
  access._isWorking = false;
  const idleEpoch = session.terminalActivityEpoch;
  access._handleTerminalOutput('idle composer repaint');
  expect(session.terminalActivityEpoch).toBe(idleEpoch);
  access.ptyProcess = { write: vi.fn() };
  expect(session.write('next turn\r')).toBe(true);
  expect(session.terminalActivityEpoch).toBe(idleEpoch + 1);
});
```

- [ ] **Step 2: Run the contract test and verify RED**

Run: `npm test -- test/session-agent-activity-contract.test.ts`

Expected: FAIL because `_handleTerminalOutput()` currently advances the terminal epoch for an idle Codex repaint.

- [ ] **Step 3: Implement the narrow repaint rule**

In `_handleTerminalOutput()`, preserve the existing invalidation for Claude, non-idle Codex output, explicit submissions, and working transitions. Skip only the epoch increment and `terminalActivity` emission when `mode === 'codex'` and raw status is already `idle`.

```ts
const idleCodexRepaint = this.mode === 'codex' && this._status === 'idle';
if (!idleCodexRepaint) {
  this._terminalActivityEpoch++;
  this.emit('terminalActivity');
}
```

- [ ] **Step 4: Run the contract test and verify GREEN**

Run: `npm test -- test/session-agent-activity-contract.test.ts`

Expected: all tests pass.

### Task 2: Deliver fresh exact-zero Codex raw-idle through the approval path

**Files:**

- Modify: `src/session-agent-activity-coordinator.ts`
- Modify: `src/web/session-listener-wiring.ts` only if the decision contract cannot express direct delivery without duplication
- Test: `test/session-agent-activity-coordinator.test.ts`
- Test: `test/session-listener-wiring.test.ts`
- Test: `test/background-agent-wait.integration.test.ts`

- [ ] **Step 1: Write failing coordinator and listener regressions**

Add a coordinator test that starts a Codex session with live watcher evidence, receives a current zero watcher snapshot, allocates `raw_idle`, reconciles exact zero, and expects one decision with `presentToHuman: true`, `autonomyBlocked: false`, and direct listener delivery rather than a derived-only settlement. Add controls proving a live process/frame remains suppressed, a stale terminal epoch is rejected, and the equivalent Claude exact-zero behavior is unchanged.

Add a listener test whose async decision represents the fresh exact-zero Codex outcome and assert exactly one idle approval with the event source sequence plus the existing `session:idle` broadcast.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/background-agent-wait.integration.test.ts
```

Expected: the new Codex direct-delivery assertions fail while existing live-agent and Claude controls pass.

- [ ] **Step 3: Implement the minimal decision-boundary change**

When `decisionForEvent()` receives fresh exact-zero evidence for a Codex `raw_idle`, settle the record to `none` without publishing the derived-idle callback, and expose the decision as direct delivery so `commitRawIdle()` remains the single approval/broadcast path. Keep `stop`, `idle_prompt`, Claude `raw_idle`, stale reconciliation, live process evidence, and visible-frame evidence on their current paths.

The implementation must keep all freshness checks already enforced by `reconciliationForEvent()`:

```ts
const directCodexRawIdle =
  event.kind === 'raw_idle' && session.mode === 'codex' && reconciliationIsFresh && exactWatcherCount === 0;
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same three-file command. Expected: all tests pass with no unhandled errors.

- [ ] **Step 5: Commit the behavioral fix**

```bash
git add src/session.ts src/session-agent-activity-coordinator.ts src/web/session-listener-wiring.ts test/session-agent-activity-contract.test.ts test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/background-agent-wait.integration.test.ts
git commit -m "fix(activity): COD-354 restore Codex needs-input alerts"
```

### Task 3: Verify persistence, browser seeding, and release safety

**Files:**

- Modify: `.changeset/cod-354-codex-needs-input.md`
- Modify: `docs/superpowers/plans/2026-08-21-cod-354-codex-needs-input.md`
- Test: existing focused approval/browser tests selected after `rg` confirms the relevant filenames

- [ ] **Step 1: Add the patch changeset**

```md
---
'aicodeman': patch
---

Restore Codex needs-input approvals and tab alerts after zero-agent turns while preserving live-agent suppression.
```

- [ ] **Step 2: Run the complete scoped regression and static gates**

Run only explicit files, never bare `npm test`:

```bash
npm test -- test/session-agent-activity-contract.test.ts test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/session-agent-activity-server.test.ts test/background-agent-wait.integration.test.ts test/approvals-api.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

Expected: zero failures; lint may retain only already documented pre-existing warnings.

- [ ] **Step 3: Run isolated realistic smoke and browser acceptance**

Use the `codeman-prod-realistic-smoke` skill to start a temporary local instance. Create only disposable Codex sessions, verify a genuine turn-end creates an idle approval, reload a second browser context and verify the same tab has `tab-alert-idle`, verify live-agent evidence suppresses the alert, then remove all disposable sessions and stop the temporary instance.

- [ ] **Step 4: Commit release metadata and completed plan**

```bash
git add .changeset/cod-354-codex-needs-input.md docs/superpowers/plans/2026-08-21-cod-354-codex-needs-input.md
git commit -m "chore: COD-354 document needs-input recovery"
```

- [ ] **Step 5: Review, integrate, push, and deploy**

Review the whole feature against the approved design. Merge current `origin/local` into the feature if it moved and rerun affected gates. In the root checkout, preserve the exact dirty tracked and untracked state, merge the feature with `--no-ff`, restore the protected state, push only `origin local`, run the guarded `sync-origin-local-deploy` workflow, and verify the user service plus repeated local and LAN HTTP 200 probes.

- [ ] **Step 6: Perform live LAN acceptance and close Jira**

On the deployed LAN site, use a uniquely named disposable Codex session to verify `/api/approvals`, the first browser context, and a reloaded/second context all show the same needs-input alert. Confirm no alert while live-agent evidence is affirmative, clean up the disposable session, attach commit/test/deploy/acceptance evidence to COD-354, and transition it to Done.
