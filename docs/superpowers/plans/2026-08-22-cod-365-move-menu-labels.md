# COD-365 Move Menu Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename reorder commands to Move up and Move down in both group and session menus without changing behavior.

**Architecture:** Keep the existing menu/action construction and reorder operations intact. Change only the four visible action labels and the two internal shortcut lookups that currently identify session movement by the old labels.

**Tech Stack:** Plain browser JavaScript, TypeScript/Vitest DOM tests, Prettier, ESLint, esbuild.

---

### Task 1: Prove the requested menu copy is missing

**Files:**

- Modify: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Add a focused menu-copy test**

Open the real group menu and session action menu, assert both contain `Move up` and `Move down`, and assert none of `Move group earlier`, `Move group later`, `Move earlier`, or `Move later` remain.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/tab-layout-editing.test.ts -t "uses Move up and Move down in group and session menus"`

Expected: FAIL because the menus still expose the legacy labels.

### Task 2: Rename the menu actions without changing destinations

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Make the minimal production change**

Replace the group labels with `Move up` / `Move down`, replace the session/ref labels with `Move up` / `Move down`, and update `moveActiveTabLeft()` / `moveActiveTabRight()` to find those renamed actions.

- [ ] **Step 2: Update existing label-specific assertions**

Change existing boundary and action test expectations from `Move later` to `Move down` where they describe the rendered session menu.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run: `npm test -- test/tab-layout-editing.test.ts`

Expected: 1 file passes with all tests green.

### Task 3: Verify and commit

**Files:**

- Verify: `src/web/public/app.js`
- Verify: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Run repository gates**

Run `npm run typecheck`, `npm run lint`, `npm run check:frontend-syntax`, `npm run check:lockfile`, `npx prettier --check src/web/public/app.js test/tab-layout-editing.test.ts docs/superpowers/specs/2026-08-22-cod-365-move-menu-labels-design.md docs/superpowers/plans/2026-08-22-cod-365-move-menu-labels.md`, and `npm run build`.

- [ ] **Step 2: Inspect the final diff**

Confirm the product diff contains only the requested label changes and matching internal lookups, with no reorder-operation changes.

- [ ] **Step 3: Commit**

Commit with a COD-365 Conventional Commit subject and post the verification evidence to Jira.
