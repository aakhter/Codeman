# COD-357 Duplicate Repository-Status Route Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Codeman production startup without removing repository-status functionality.

**Architecture:** Retain one canonical `GET /api/system/repo-status` registration in the existing system route module. Exercise the full route registrar in a focused Fastify injection test so any duplicate method/path registration fails during harness creation.

**Tech Stack:** TypeScript ESM, Fastify, Vitest, esbuild, tmux-backed Codeman deployment.

---

### Task 1: Pin the startup regression

**Files:**
- Modify: `test/routes/system-routes.test.ts`
- Test: `test/routes/system-routes.test.ts`

- [ ] **Step 1: Write the failing test**

Mock `getRepositoryStatus()` and add a focused `GET /api/system/repo-status` test that expects HTTP 200 and the mocked response. The suite's `beforeEach` registers the complete system route module, so the current source must fail first with Fastify's duplicate-route error.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- test/routes/system-routes.test.ts`

Expected: FAIL during route registration with `Method 'GET' already declared for route '/api/system/repo-status'`.

### Task 2: Remove only the duplicate registration

**Files:**
- Modify: `src/web/routes/system-routes.ts:426-452`
- Test: `test/routes/system-routes.test.ts`

- [ ] **Step 1: Write the minimal implementation**

Delete the earlier duplicate registration and its redundant comment, leaving the established registration after the update route unchanged:

```ts
// Repository status: ahead/behind + incoming-commit summary vs the upstream
// and the maintainer's own fork. Informational; does a read-only git fetch.
app.get('/api/system/repo-status', async () => getRepositoryStatus());
```

- [ ] **Step 2: Run the focused test to verify it passes**

Run: `npm test -- test/routes/system-routes.test.ts`

Expected: PASS, including the repository-status endpoint assertion.

- [ ] **Step 3: Run repository verification**

Run each command from the worktree:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit the repair**

```bash
git add -- src/web/routes/system-routes.ts test/routes/system-routes.test.ts docs/superpowers/specs/2026-08-22-cod-357-duplicate-repo-status-design.md docs/superpowers/plans/2026-08-22-cod-357-duplicate-repo-status.md
git commit -m "fix(server): COD-357 remove duplicate repo-status route"
```

### Task 3: Deploy and verify production recovery

**Files:**
- Modify through cherry-pick: shared `local` checkout
- Runtime verification: `/home/aakhter/.codeman/logs/codeman-it15.log`

- [ ] **Step 1: Apply the verified commit to `local`**

Confirm the shared checkout is still on `local` and clean, then cherry-pick the COD-357 commit.

- [ ] **Step 2: Build before starting the server**

Run: `npm run build`

Expected: build exits 0 and `dist/index.js` is newer than the previous web-server PID start time.

- [ ] **Step 3: Restart through the guarded controller**

Run: `codeman-ctl restart`

Expected: readiness probe reports HTTPS 200, 401, or 429 and a new managed PID.

- [ ] **Step 4: Verify live-session restoration**

Compare `tmux -L codeman list-sessions` with startup log entries. Expected: all live tmux sessions remain present and the log reports each restored and attached session without duplicate-route errors.

- [ ] **Step 5: Update Jira**

Add the branch, commit, root cause, and verification results to COD-357, then move it to Done only after production recovery is confirmed.
