# COD-395 Recovery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make temporary smoke and deployment verification reliable while covering explicit reboot-recovery UI behavior and expected shutdown races.

**Architecture:** Keep application cleanup changes in the Codeman repository and operational smoke/deploy tooling in their installed skill scripts. The smoke creates only temporary, smoke-prefixed records and sessions; deployment health checking retries only HTTP readiness after a successful restart.

**Tech Stack:** TypeScript, Vitest, Node/Playwright temporary smoke harness, Bash, systemd user service.

---

### Task 1: COD-396 Codex trust-prompt compatibility

**Files:**
- Modify: `/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs:685-702,969-975`
- Test: `/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/test-trust-prompt.mjs`

- [ ] **Step 1: Write a failing helper regression**

Create a Node test that imports an extracted `trustPromptAction(visible)` helper and expects the current prompt to return `confirm-numbered`:

```js
assert.equal(trustPromptAction('Trust the contents of this directory?\n1. Yes, continue\n2. No, quit'), 'confirm-numbered');
```

- [ ] **Step 2: Run RED**

Run: `node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/test-trust-prompt.mjs`

Expected: failure because the helper/action does not exist.

- [ ] **Step 3: Add the minimal prompt classifier and action**

Classify legacy `Press t to trust all`, modal escape text, and exact numbered directory-trust text. In `acceptCodexTrustPromptIfPresent`, send `1\r` only for the numbered prompt, wait for redraw, and retain the existing safe legacy behavior. The final assertion must consider all recognized prompts uncleared until absent.

- [ ] **Step 4: Run GREEN and syntax checks**

Run: `node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/test-trust-prompt.mjs && node --check /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs`

Expected: passing helper checks and valid script syntax.

- [ ] **Step 5: Record COD-396 evidence**

Comment on COD-396 with the exact command and result; global skill changes are not committed to Bitbucket.

### Task 2: COD-397 explicit Recovery Queue temporary smoke

**Files:**
- Modify: `/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs`
- Test: `/home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/test-recovery-smoke.mjs`

- [ ] **Step 1: Write failing recovery scenario contract tests**

Test an extracted `recoverySmokeAssertions`/API helper with mocked API calls. Require the following ordering:

```js
assert.deepEqual(calls, [
  ['GET', '/api/session-recoveries'],
  ['POST', '/api/session-recoveries/smoke-resumable/resume'],
  ['POST', '/api/session-recoveries/smoke-manual/dismiss'],
]);
```

The initial manager-open operation must not issue `/resume`.

- [ ] **Step 2: Run RED**

Run: `node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/test-recovery-smoke.mjs`

Expected: failure because the recovery scenario helper/flag does not exist.

- [ ] **Step 3: Implement opt-in smoke scenario**

Add `--include-recovery-smoke`. Seed only `smoke-*` local resumable and manual-required records through isolated test state/API seams, open the manager in Chromium, assert distinct queue rows and no action from opening, resume only the resumable record after browser confirmation, verify one returned replacement session, then dismiss smoke records in `finally`. If remote smoke environment is absent, mark owned-remote coverage skipped explicitly; never call a real reboot.

- [ ] **Step 4: Run helper GREEN and full opt-in temporary smoke**

Run helper test, then:

```bash
node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --include-recovery-smoke
```

Expected: all smoke assertions pass, a `SUMMARY` is emitted, and all smoke-prefixed sessions/records are cleaned up.

- [ ] **Step 5: Record COD-397 evidence**

Comment the artifact directory, pass/fail summary, and explicit remote coverage status on COD-397.

### Task 3: COD-398 startup-aware deploy health retries

**Files:**
- Modify: `/home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/sync_origin_local_deploy.sh:4-39`
- Test: `/home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/test-health-check.sh`

- [ ] **Step 1: Write a failing delayed-listener regression**

Create a Bash test that sources the health helper with `HEALTH_ATTEMPTS=3`, mocks `curl` to fail twice then succeed, and asserts three invocations plus `Health check OK ... on attempt 3/3`.

- [ ] **Step 2: Run RED**

Run: `bash /home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/test-health-check.sh`

Expected: failure because one-shot health checking has no attempt behavior.

- [ ] **Step 3: Implement bounded health retry**

Add positive integer defaults `CODEMAN_SYNC_HEALTH_ATTEMPTS=6` and `CODEMAN_SYNC_HEALTH_INTERVAL_SECONDS=2`. Probe configured URLs each attempt; print failures only after the final attempt; sleep only between attempts. Keep merge/build/restart behavior unchanged.

- [ ] **Step 4: Run GREEN and shell syntax check**

Run: `bash /home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/test-health-check.sh && bash -n /home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/sync_origin_local_deploy.sh`

Expected: retry test and syntax check pass.

- [ ] **Step 5: Record COD-398 evidence**

Comment exact test output and retry defaults on COD-398.

### Task 4: COD-399 expected ESRCH session shutdown

**Files:**
- Modify: `src/session.ts:4840-4893`
- Test: `test/session-stop.test.ts`

- [ ] **Step 1: Write failing session-stop tests**

Stub `process.kill` so direct PID and negative process-group calls throw an error with `code = 'ESRCH'`. Assert `await session.stop()` resolves and `console.warn` is not called. Add a distinct `EPERM` case that remains warned.

- [ ] **Step 2: Run RED**

Run: `npm test -- test/session-stop.test.ts`

Expected: warning assertions fail because `stop()` logs all kill errors.

- [ ] **Step 3: Implement errno-aware warning filtering**

Use a narrow local predicate equivalent to `error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'`. Skip only that warning; do not skip mux cleanup, state cleanup, or non-ESRCH diagnostics.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- test/session-stop.test.ts`

Expected: ESRCH is quiet and EPERM remains visible.

- [ ] **Step 5: Commit and record COD-399 evidence**

Commit repository changes with `fix: COD-399 quiet expected exited-process cleanup`; comment branch, commit, and test result on COD-399.

### Task 5: Integration verification and Jira parent

**Files:**
- Verify: `test/session-recovery.test.ts`, `test/server-reboot-recovery.test.ts`, `test/routes/session-recovery-routes.test.ts`, `test/session-manager-recovery-ui.test.ts`, `test/session-stop.test.ts`

- [ ] **Step 1: Run static checks**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile && git diff --check`

Expected: zero errors; document any established warning separately.

- [ ] **Step 2: Run scoped application suite**

Run: `npm test -- test/session-recovery.test.ts test/server-reboot-recovery.test.ts test/routes/session-recovery-routes.test.ts test/session-manager-recovery-ui.test.ts test/session-stop.test.ts`

Expected: every listed file passes. Never run bare `npm test`.

- [ ] **Step 3: Run global-tooling checks**

Run both global helper tests, `node --check` for the smoke script, and `bash -n` for the deploy script.

- [ ] **Step 4: Update Jira**

Comment verification and commits on COD-396 through COD-399; link each completion to COD-395. Do not mark issues Done, push, merge, deploy, or restart without separate user approval.
