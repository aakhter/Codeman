# COD-371 Mobile Pill Large-Phone Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the mobile session-switcher pill on every supported phone below 600px while preserving the old tab strip at the 600px tablet boundary.

**Architecture:** Keep the fix local to `MobileTabSheet._isEnabled()` so shared device detection and unrelated responsive layouts do not change. Prove the boundary in a dedicated real-browser test that loads the production page, seeds a tab count, invokes the pill update, and inspects computed visibility.

**Tech Stack:** Plain browser JavaScript, TypeScript, Vitest, Playwright Chromium, Fastify test server.

---

### Task 1: Add the failing large-phone boundary regression

**Files:**
- Modify: `test/mobile/helpers/constants.ts`
- Create: `test/mobile/mobile-tab-pill.test.ts`

- [ ] **Step 1: Reserve a dedicated mobile test port**

Add `MOBILE_TAB_PILL: 3210` to `PORTS` in `test/mobile/helpers/constants.ts` so this browser test cannot collide with another mobile suite.

- [ ] **Step 2: Write the failing browser test**

Create `test/mobile/mobile-tab-pill.test.ts`. Start `WebServer` on `PORTS.MOBILE_TAB_PILL`; open Chromium contexts at 430, 440, 599, and 600px with touch enabled; load the real page; seed twelve session IDs in `window.app.sessionOrder`; call `window.MobileTabSheet.updatePill()`; and assert this matrix:

```ts
const cases = [
  { width: 430, expectedEnabled: true, expectedPillDisplay: 'flex', expectedStripDisplay: 'none' },
  { width: 440, expectedEnabled: true, expectedPillDisplay: 'flex', expectedStripDisplay: 'none' },
  { width: 599, expectedEnabled: true, expectedPillDisplay: 'flex', expectedStripDisplay: 'none' },
  { width: 600, expectedEnabled: false, expectedPillDisplay: 'none', expectedStripDisplay: 'flex' },
];
```

Use computed styles rather than inline attributes so the test covers the rendered behavior the user sees.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
npm run test:mobile -- test/mobile/mobile-tab-pill.test.ts
```

Expected: 430px and 600px pass; 440px and 599px fail because `_isEnabled()` returns false and the pill remains hidden.

- [ ] **Step 4: Commit the regression test**

```bash
git add test/mobile/helpers/constants.ts test/mobile/mobile-tab-pill.test.ts
git commit -m "test(mobile): COD-371 cover large-phone tab pill"
```

### Task 2: Implement the minimal eligibility fix

**Files:**
- Modify: `src/web/public/mobile-tabs.js`

- [ ] **Step 1: Replace the split 430px eligibility logic**

Implement the approved local boundary:

```js
_isEnabled() {
  return window.innerWidth < 600;
},
```

Do not change global `MobileDetection`, pill count policy, rendering, sheet behavior, or tablet CSS.

- [ ] **Step 2: Run the focused test and verify GREEN**

Run:

```bash
npm run test:mobile -- test/mobile/mobile-tab-pill.test.ts
```

Expected: all four boundary cases pass.

- [ ] **Step 3: Run frontend and repository checks**

Run these commands separately:

```bash
npm run check:frontend-syntax
npm run check:public-assets
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 4: Commit the implementation**

```bash
git add src/web/public/mobile-tabs.js
git commit -m "fix(mobile): COD-371 show tab pill on large phones"
```

### Task 3: Review, integrate, deploy, and verify

**Files:**
- No additional source files expected.

- [ ] **Step 1: Review the focused diff and branch history**

Confirm only the approved spec, plan, port constant, focused test, and `mobile-tabs.js` logic changed. Preserve `.superpowers/` and the three untracked iPhone pill mock images.

- [ ] **Step 2: Merge and push to Bitbucket local**

Fetch `origin/local`, merge it into the feature branch if needed, rerun the focused test after any merge, push the feature branch, switch to `local`, merge `COD-371-mobile-pill-large-phones` with a merge commit, and push `local` to `origin/local`.

- [ ] **Step 3: Deploy through the guarded workflow**

From `local`, run:

```bash
CODEMAN_SYNC_REMOTE_REF=origin/local \
CODEMAN_SYNC_SERVICE=codeman-web \
CODEMAN_SYNC_HEALTH_URL=http://127.0.0.1:3002/ \
~/.codex/skills/sync-origin-local-deploy/scripts/sync_origin_local_deploy.sh
```

Expected: unrelated untracked files are stashed and restored, build succeeds, `codeman-web` restarts, and the health probe returns HTTP 200. If the probe races startup, independently verify the active unit and three consecutive HTTP 200 responses before proceeding.

- [ ] **Step 4: Verify the deployed browser boundary**

Load `http://127.0.0.1:3002/` with Playwright Chromium at exact widths 430, 440, and 600px. Seed twelve session IDs and invoke `MobileTabSheet.updatePill()`. Expected results:

- 430px: pill visible, old strip hidden.
- 440px: pill visible, old strip hidden.
- 600px: pill hidden, old strip visible.

Also confirm the served HTML references the newly hashed `mobile-tabs` asset and that its bytes match `dist/web/public/`.

- [ ] **Step 5: Update Jira COD-371**

Comment with branch, test and implementation commits, merge commit, pushed remote, verification commands, deployment restart time, live hashed asset, and browser results. Transition COD-371 to Done only after all evidence is present.
