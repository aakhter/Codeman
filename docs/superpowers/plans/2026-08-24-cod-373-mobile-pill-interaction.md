# COD-373 Mobile Pill Interaction Fix Implementation Plan

**Goal:** Make the mobile session pill toggle its bottom sheet and show the full active session name whenever header space permits.

**Architecture:** Keep the change inside the existing `MobileTabSheet` component and its mobile pill styles. Use one idempotent binding helper for both the server-rendered and dynamically recreated pill, render the unmodified session name, and allow the label to consume flexible header space before ellipsizing.

**Tech Stack:** Plain browser JavaScript, CSS, TypeScript, Vitest, Playwright Chromium, Fastify test server.

### Task 1: Add the failing interaction and label regression

**Files:**
- Modify: `test/mobile/mobile-tab-pill.test.ts`

- [ ] Add a 440px real-browser case with twelve sessions and active name `w1-Codeman`.
- [ ] Assert the pill text equals the complete name and is not visually clipped.
- [ ] Click the pill and assert sheet/scrim open plus `aria-expanded=true`.
- [ ] Click again and assert sheet/scrim close plus `aria-expanded=false`.
- [ ] Run `npm run test:mobile -- test/mobile/mobile-tab-pill.test.ts` and verify RED.
- [ ] Commit the regression test.

### Task 2: Implement the focused fix

**Files:**
- Modify: `src/web/public/mobile-tabs.js`
- Modify: `src/web/public/mobile.css`

- [ ] Add an idempotent pill-binding helper and call it whenever elements are ensured.
- [ ] Remove the creation-only forced-open handler.
- [ ] Render the full active session name without an eight-character slice.
- [ ] Replace the fixed 70px label cap with a flexible, viewport-bounded pill layout.
- [ ] Run the focused browser test and verify GREEN.
- [ ] Run frontend syntax, public assets, typecheck, lint, format, lockfile, build, and diff checks.
- [ ] Commit the implementation.

### Task 3: Integrate, deploy, and verify

- [ ] Review the focused diff and preserve unrelated root worktree files.
- [ ] Fetch `origin/local`, reconcile any advance, push the feature branch, merge to `local`, and push Bitbucket.
- [ ] Deploy with the guarded `sync_origin_local_deploy.sh` workflow.
- [ ] Verify the live service at 440px: complete name, first click opens, second click closes.
- [ ] Comment on Jira COD-373 with commits, checks, deployment, and live evidence; transition to Done.
