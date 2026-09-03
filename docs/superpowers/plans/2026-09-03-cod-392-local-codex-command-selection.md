# COD-392 Local Codex Command Selection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support Default/Profile/Custom Codex commands for local cases.

**Architecture:** Owner-scoped selection map; top-level CaseInfo metadata; resolve-before-create; exact command execution.

**Tech Stack:** TypeScript ESM, Fastify, Zod, StateStore, tmux, Vitest.

---

### Task 1: State persistence

**Files:**
- Modify: `src/types/app-state.ts`
- Modify: `src/state-store.ts`
- Test: `test/state-store.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// get/set/rename/delete owner-scoped local selection; default clears entry
```
- [ ] **Step 2: Run test to verify it fails**
Run: `npm test -- test/state-store.test.ts`
Expected: FAIL
- [ ] **Step 3: Implement minimal accessors + persistence serialization**
- [ ] **Step 4: Run test to verify it passes**
Run: `npm test -- test/state-store.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add src/types/app-state.ts src/state-store.ts test/state-store.test.ts
git commit -m "feat(state): COD-392 persist local Codex command selections"
```

### Task 2: Case API lifecycle

**Files:**
- Modify: `src/types/api.ts`
- Modify: `src/web/schemas.ts`
- Modify: `src/web/routes/case-routes.ts`
- Modify: `src/web/routes/codex-command-profile-routes.ts`
- Test: `test/routes/case-routes.test.ts`
- Test: `test/routes/codex-command-profile-routes.test.ts`

- [ ] **Step 1: Write failing route tests for create/clone/link/edit/rename/delete, privileges, Docker rejection**
- [ ] **Step 2: Run to verify failure**
Run: `npm test -- test/routes/case-routes.test.ts`
Expected: FAIL
- [ ] **Step 3: Validate before mutation, persist/move/delete metadata, return top-level selection**
- [ ] **Step 4: Verify passing**
Run: `npm test -- test/routes/case-routes.test.ts test/routes/codex-command-profile-routes.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add src/types/api.ts src/web/schemas.ts src/web/routes/case-routes.ts src/web/routes/codex-command-profile-routes.ts test/routes/case-routes.test.ts test/routes/codex-command-profile-routes.test.ts
git commit -m "feat(api): COD-392 manage Codex commands for local cases"
```

### Task 3: Session resolution and execution

**Files:**
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/session.ts`
- Modify: `src/tmux-manager.ts`
- Modify: `src/web/server.ts`
- Test: `test/routes/session-routes.test.ts`
- Test: `test/tmux-manager.test.ts`

- [ ] **Step 1: Write failing tests for launch, privilege denial, missing profile, recovery**
- [ ] **Step 2: Run to verify failure**
Run: `npm test -- test/routes/session-routes.test.ts`
Expected: FAIL
- [ ] **Step 3: Resolve before creation; thread private command; execute exact text; recheck privilege on respawn/recovery**
- [ ] **Step 4: Verify passing**
Run: `npm test -- test/routes/session-routes.test.ts test/tmux-manager.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add src/web/routes/session-routes.ts src/session.ts src/tmux-manager.ts src/web/server.ts test/routes/session-routes.test.ts test/tmux-manager.test.ts
git commit -m "feat(session): COD-392 resolve and run local Codex commands"
```

### Task 4: Browser selector reuse

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/session-ui.js`
- Test: `test/codex-command-profiles.browser.test.ts`

- [ ] **Step 1: Extend browser assertions for create/edit visibility, prefill, payload, Docker exclusion**
- [ ] **Step 2: Run to verify failure**
Run: `npm run test:browser -- test/codex-command-profiles.browser.test.ts`
Expected: FAIL
- [ ] **Step 3: Generalize selector across local case forms**
- [ ] **Step 4: Verify passing**
Run: `npm run test:browser -- test/codex-command-profiles.browser.test.ts`
Expected: PASS
- [ ] **Step 5: Commit**
```bash
git add src/web/public/index.html src/web/public/session-ui.js test/codex-command-profiles.browser.test.ts
git commit -m "feat(ui): COD-392 reuse Codex command selector across cases"
```
