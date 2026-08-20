# COD-339 Sidebar Actions and Session-Name Font Size Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Place vertical-sidebar session actions beside the session name and add a persisted 11–18px session-name-only font-size setting.

**Architecture:** Keep one tab renderer and conditionally place the existing action HTML inside `.tab-name-row` only when the applied layout is the session sidebar. Persist a bounded numeric display setting through the existing strict settings schema and expose it to CSS through a root custom property consumed only by sidebar session names.

**Tech Stack:** Plain browser JavaScript/CSS/HTML, TypeScript/Zod server schema, Vitest, JSDOM, Playwright/Chromium, Changesets.

---

### Task 1: Pin the approved behavior with failing tests

**Files:**
- Create: `test/session-sidebar-ux.test.ts`
- Create: `test/session-sidebar-ux.browser.test.ts`

- [ ] **Step 1: Write the failing structural and schema tests**

Add assertions that `SettingsUpdateSchema` accepts integer `sessionSidebarFontSize` values 11 and 18 and rejects 10,
19, 14.5, and `'14'`. Read the real public assets and require the range control, load/save/default/display-key wiring,
pre-paint custom property, sidebar-only CSS consumer, and conditional action placement in the row renderer.

- [ ] **Step 2: Run the structural test and verify RED**

Run: `npm test -- test/session-sidebar-ux.test.ts`

Expected: FAIL because `sessionSidebarFontSize`, the control, and inline sidebar action branch do not exist.

- [ ] **Step 3: Write the failing Chromium geometry test**

Render real `styles.css` with representative short and long sidebar rows. Assert the action cluster is nested in the
name row, the settings icon starts no more than 6px after the short name, the long name is narrower than its scroll
width without overlapping actions, 11px and 18px values affect `.tab-name`, and the project heading stays unchanged.

- [ ] **Step 4: Run the browser test and verify RED**

Run: `npx vitest run --config config/vitest.browser.config.ts test/session-sidebar-ux.browser.test.ts`

Expected: FAIL because the approved markup and sidebar font-size variable are absent.

### Task 2: Implement inline sidebar actions

**Files:**
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/styles.css`

- [ ] **Step 1: Create one action fragment and place it by applied layout**

In `_fullRenderSessionTabs()`, build `tabActionsHtml` once. When `isSessionSidebarActive()` is true, interpolate it
after `.tab-detached-badge` inside `.tab-name-row`; otherwise interpolate it in its existing direct-child position.
Do not duplicate controls or IDs.

- [ ] **Step 2: Add sidebar-only flex constraints**

Make sidebar `.tab-name-row` and `.tab-name` `min-width: 0`, keep `.tab-name` as a shrinking ellipsis target, and make
`.tab-actions` non-shrinking. Preserve the existing 0.25rem name-row gap and active-only action visibility.

- [ ] **Step 3: Run the structural test**

Run: `npm test -- test/session-sidebar-ux.test.ts`

Expected: action-placement assertions pass; font-setting assertions remain RED.

### Task 3: Add the persisted session-name-only font setting

**Files:**
- Modify: `src/web/schemas.ts`
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/settings-ui.js`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/i18n.js`

- [ ] **Step 1: Extend the strict schema**

Add `sessionSidebarFontSize: z.number().int().min(11).max(18).optional()` beside `sessionListLayout`.

- [ ] **Step 2: Add the Layout → Tabs control**

Add `#appSettingsSessionSidebarFontSize` as an integer range input with `min="11"`, `max="18"`, `step="1"`, and an
associated `#appSettingsSessionSidebarFontSizeValue` output. The input updates only the output until Save.

- [ ] **Step 3: Wire load, save, defaults, device scoping, and apply**

Load a bounded value (default 14) into the range/output, save it as a number, add the key to the device display-key set,
and set `--session-sidebar-name-font-size` during `applySessionListLayout()`. Extend the pre-paint settings script so a
persisted valid value is present on the first rendered frame.

- [ ] **Step 4: Scope the CSS variable and translation**

Apply `font-size: var(--session-sidebar-name-font-size, 14px)` only to expanded/sidebar `.tab-name`. Add Chinese i18n
entries for the new label and description without changing any other typography or geometry.

- [ ] **Step 5: Run RED→GREEN tests**

Run: `npm test -- test/session-sidebar-ux.test.ts test/session-list-layout.test.ts test/app-settings-structure.test.ts`

Expected: all targeted tests PASS.

Run: `npx vitest run --config config/vitest.browser.config.ts test/session-sidebar-ux.browser.test.ts`

Expected: the real Chromium geometry and font-scope assertions PASS.

### Task 4: Release note and verification

**Files:**
- Create: `.changeset/cod-339-sidebar-actions-font-size.md`

- [ ] **Step 1: Add the patch changeset**

Describe the compact inline action cluster, long-name truncation, and persisted session-name-only size control.

- [ ] **Step 2: Run repository gates**

Run individually: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:lockfile`, and
`npm run build`. Re-run the targeted structural and browser files above. Never run bare `npm test` in the managed tmux
session.

- [ ] **Step 3: Run realistic temporary-instance smoke**

Run: `node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --skip-claude`

Expected: PASS summary, zero browser/page errors, all temporary smoke sessions removed.

- [ ] **Step 4: Commit and request review**

Stage only the plan/spec, production files, focused tests, and COD-339 changeset. Commit with
`feat(sidebar): COD-339 compact actions and size session names`, then request code review against `origin/local`.

- [ ] **Step 5: Merge, push, deploy, and verify production**

After review fixes and fresh verification, merge the feature branch into `local`, push `origin/local`, run the standard
Codeman deployment workflow, verify `codeman-web` active plus repeated HTTP 200 responses on port 3002, and verify the
actual production browser geometry/settings persistence before moving COD-339 to Done.

