# COD-354 Codex Needs-Input Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore one durable Codex idle approval and yellow/orange tab alert after a real zero-agent turn without weakening COD-350 live-agent suppression.

**Architecture:** Codex adapters are intentionally outside the Claude-only watcher/process inspection path, so terminal output must leave them `not_observable` instead of promoting them to an `unknown` state that can never reconcile. Preserve normal timer, event, and terminal-epoch invalidation, then let the existing synchronous Codex `raw_idle` listener path commit the approval while keeping Claude and live-agent settlement behavior unchanged.

**Tech Stack:** TypeScript ESM, Vitest fake timers and route/listener integration tests, Fastify/SSE approval inbox, Playwright browser tests, esbuild.

---

### Task 1: Preserve non-observable Codex state across terminal output

**Files:**

- Modify: `src/session-agent-activity-coordinator.ts`
- Test: `test/session-agent-activity-coordinator.test.ts`

- [x] **Step 1: Write the failing non-observable Codex regression**

Add local and remote Codex coordinator tests showing that `onTerminalOutput()` retains `not_observable`, raw idle remains directly deliverable, and observable Claude output still becomes `unknown/checking_agents`.

```ts
coordinator.onTerminalOutput(target);
expect(coordinator.project(target).activityStatus).toBe('idle');
expect(coordinator.decisionForRawIdle(target)).toMatchObject({
  presentToHuman: true,
  autonomyBlocked: false,
  observation: 'not_observable',
});
```

- [x] **Step 2: Run the coordinator/listener tests and verify RED**

Run: `npm test -- test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/background-agent-wait.integration.test.ts`

Observed: 3 intended failures because local Codex, remote Codex, and the real coordinator-to-listener path remained `checking_agents` or lacked an approval.

- [x] **Step 3: Implement the narrow coordinator rule**

In `onTerminalOutput()`, preserve settle, receipt, decision-token, and inspection invalidation. For a non-observable Codex adapter, restore `not_observable` and return instead of entering an unresolvable `unknown` state.

```ts
if (session.mode === 'codex' && !this.isObservable(session)) {
  this.setRecordObservation(record, 'not_observable');
  return;
}
```

- [x] **Step 4: Run the focused tests and verify GREEN**

Run: `npm test -- test/session-agent-activity-contract.test.ts test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/background-agent-wait.integration.test.ts`

Observed: 125/125 tests pass.

### Task 2: Deliver the real Codex raw-idle through the approval path

**Files:**

- Modify: `src/session-agent-activity-coordinator.ts`
- Modify: `src/web/session-listener-wiring.ts` only if the decision contract cannot express direct delivery without duplication
- Test: `test/session-agent-activity-coordinator.test.ts`
- Test: `test/session-listener-wiring.test.ts`
- Test: `test/background-agent-wait.integration.test.ts`

- [x] **Step 1: Write failing coordinator and listener regressions**

Add a listener regression that uses a real `SessionAgentActivityCoordinator`, sends real terminal output through the `Session`, and verifies one `turn-end` creates exactly one Codex idle approval and one `session:idle` broadcast. Keep the existing startup `initial-ready` and Claude suppression controls.

- [x] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm test -- test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/background-agent-wait.integration.test.ts
```

Observed: the new reachable Codex assertions fail while existing Claude controls pass.

- [x] **Step 3: Implement the minimal activity-boundary change**

Keep non-observable Codex out of `unknown`, so the existing synchronous `decisionForEvent()` and unchanged `commitRawIdle()` remain the single approval/broadcast path. Keep Claude reconciliation, `stop`, `idle_prompt`, stale reconciliation, live process evidence, and visible-frame evidence unchanged.

The implementation must run after the existing invalidation operations:

```ts
record.decisionToken += 1;
record.eventReconciliations.clear();
record.reconciliationResults.clear();
this.abortInspection(record);
```

- [x] **Step 4: Run focused tests and verify GREEN**

Run the same three-file command. Expected: all tests pass with no unhandled errors.

- [x] **Step 5: Commit the behavioral fix**

```bash
git add src/session-agent-activity-coordinator.ts test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/background-agent-wait.integration.test.ts
git commit -m "fix(activity): COD-354 restore Codex needs-input alerts"
```

### Task 3: Verify persistence, browser seeding, and release safety

**Files:**

- Modify: `.changeset/cod-354-codex-needs-input.md`
- Modify: `docs/superpowers/plans/2026-08-21-cod-354-codex-needs-input.md`
- Test: existing focused approval/browser tests selected after `rg` confirms the relevant filenames

- [x] **Step 1: Add the patch changeset**

```md
---
'aicodeman': patch
---

Restore Codex needs-input approvals and tab alerts after zero-agent turns while preserving live-agent suppression.
```

- [x] **Step 2: Run the complete scoped regression and static gates**

Run only explicit files, never bare `npm test`:

```bash
npm test -- test/session-agent-activity-contract.test.ts test/session-agent-activity-coordinator.test.ts test/session-listener-wiring.test.ts test/session-agent-activity-server.test.ts test/background-agent-wait.integration.test.ts test/routes/approval-routes.test.ts test/approvals-ui-hook-propagation.test.ts
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
