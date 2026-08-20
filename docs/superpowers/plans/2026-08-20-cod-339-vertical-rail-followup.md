# COD-339 Vertical Rail Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make COD-339 font sizing and compact inline actions work in the production `header + vertical` side rail as well as the newer left sidebar.

**Architecture:** Resolve inline action placement from the applied DOM layout, including compact-width state, while retaining one shared action template. Extend the existing session-name CSS variable to the vertical rail and rebuild rows whenever a rail resize crosses the compact threshold.

**Tech Stack:** Plain browser JavaScript/CSS, TypeScript configuration, Vitest, Playwright Chromium, Fastify production bundle.

---

### Task 1: Pin the production vertical-rail failure

**Files:**

- Modify: `test/session-sidebar-ux.browser.test.ts`
- Modify: `test/session-sidebar-ux.test.ts`

- [ ] **Step 1: Add a vertical-rail browser fixture and assertions**

Extend the current controller fixture so `loadAppSettingsFromStorage()` reads mutable test settings. Add a test that applies:

```js
controller.__cod339Settings = {
  sessionListLayout: 'header',
  tabOrientation: 'vertical',
  sessionSidebarFontSize: 11,
};
document.documentElement.dataset.sessionList = 'header';
document.documentElement.dataset.sidebar = 'expanded';
document.documentElement.dataset.tabOrientation = 'vertical';
document.documentElement.classList.remove('tab-rail-compact');
controller.applySessionListLayout();
controller._fullRenderSessionTabs();
```

Assert that `.tab-actions` is inside `.tab-name-row`, the short-name gap is at most 6 px, the long name does not overlap the actions, and 11/18 values produce 11/18 px computed `.tab-name` sizes.

- [ ] **Step 2: Cover layouts that must remain unchanged**

In the same Chromium file, assert that horizontal header tabs and `html.tab-rail-compact` vertical tabs keep `.tab-actions` as a direct `.session-tab` child. Add a compact-to-full-width transition assertion that expects action placement to rebuild when the compact class changes.

- [ ] **Step 3: Add structural coverage for the shared resolver and scoped CSS**

Update `test/session-sidebar-ux.test.ts` to require:

```js
shouldInlineSessionActions();
```

and CSS selectors that apply `--session-sidebar-name-font-size` to both:

```css
html[data-session-list='sidebar'] .session-sidebar .tab-name
html[data-tab-orientation='vertical'] .tab-rail .session-tab .tab-name
```

- [ ] **Step 4: Run the tests and verify RED**

Run:

```bash
npm test -- test/session-sidebar-ux.test.ts
npx vitest run --config config/vitest.browser.config.ts test/session-sidebar-ux.browser.test.ts
```

Expected: the vertical-rail font, inline-action, and compact-threshold lifecycle assertions fail while existing sidebar assertions stay green.

### Task 2: Share inline placement across expanded vertical layouts

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `src/web/public/tab-rail-resize.js`
- Modify: `src/web/public/styles.css`
- Test: `test/session-sidebar-ux.browser.test.ts`
- Test: `test/session-sidebar-ux.test.ts`

- [ ] **Step 1: Add one applied-layout resolver**

Add this method beside the existing sidebar layout helpers in `app.js`:

```js
shouldInlineSessionActions() {
  if (this.isSessionSidebarActive()) return !this.isSessionSidebarCollapsed();
  return this._tabOrientation() === 'vertical' &&
    !document.documentElement.classList.contains('tab-rail-compact');
}
```

Replace the sidebar-only render predicate with:

```js
const inlineSessionActions = this.shouldInlineSessionActions();
```

Keep `tabActionsHtml` single-sourced and preserve the existing detached-badge and subagent-badge ordering.

- [ ] **Step 2: Rebuild when rail density crosses the compact threshold**

In `_setTabRailWidth()` in `tab-rail-resize.js`, compare the old and new `tab-rail-compact` states:

```js
const wasCompact = root.classList.contains('tab-rail-compact');
const compact = resolved < 240;
root.classList.toggle('tab-rail-compact', compact);
if (wasCompact !== compact) this._fullRenderSessionTabs?.();
```

This moves actions back to a direct tab child when the rail becomes compact and moves them inline again when it expands.

- [ ] **Step 3: Extend only session-name and action flex rules**

Add the vertical rail to the existing variable rule without changing headings, chips, badges, icons, or rows:

```css
html[data-tab-orientation='vertical'] .tab-rail .session-tab .tab-name {
  font-size: var(--session-sidebar-name-font-size, 14px);
}

html[data-tab-orientation='vertical'] .tab-rail .session-tab .tab-name-row > .tab-actions {
  flex-shrink: 0;
}
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
npm test -- test/session-sidebar-ux.test.ts test/session-list-layout.test.ts test/app-settings-structure.test.ts
npx vitest run --config config/vitest.browser.config.ts test/session-sidebar-ux.browser.test.ts
```

Expected: all focused structural/layout/settings tests and every COD-339 Chromium case pass.

- [ ] **Step 5: Commit the corrective implementation**

```bash
git add src/web/public/app.js src/web/public/tab-rail-resize.js src/web/public/styles.css \
  test/session-sidebar-ux.test.ts test/session-sidebar-ux.browser.test.ts
git commit -m "fix(rail): COD-339 apply session sizing to vertical rail"
```

### Task 3: Release metadata and verification

**Files:**

- Create: `.changeset/cod-339-vertical-rail-followup.md`

- [ ] **Step 1: Add the patch changeset**

```md
---
'aicodeman': patch
---

Apply session-name sizing and compact inline actions to the full-width vertical side rail.
```

- [ ] **Step 2: Run scoped and static gates**

```bash
npm test -- test/session-sidebar-ux.test.ts test/session-list-layout.test.ts test/app-settings-structure.test.ts
npx vitest run --config config/vitest.browser.config.ts test/session-sidebar-ux.browser.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

Expected: zero failures. A pre-existing lint warning or duplicate i18n key warning must be reported separately and not attributed to this change.

- [ ] **Step 3: Run realistic smoke**

```bash
node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --skip-claude
```

Record all pass/fail results. Do not hide the known long-scrollback viewport-marker failure if it reproduces.

- [ ] **Step 4: Commit release metadata**

```bash
git add .changeset/cod-339-vertical-rail-followup.md
git commit -m "chore: COD-339 document vertical rail correction"
```

### Task 4: Review, integrate, deploy, and verify the original symptom

**Files:**

- No additional production files expected.

- [ ] **Step 1: Request independent code review**

Review `origin/local..HEAD` against the approved spec. Resolve every Critical or Important finding and rerun the affected checks.

- [ ] **Step 2: Merge and push**

From `/opt/projects/Codeman`, preserve the unrelated dirty files, merge `COD-339-vertical-rail-followup` into `local`, and push:

```bash
git merge --no-ff COD-339-vertical-rail-followup -m "merge: COD-339 support the production vertical rail"
git push origin local
```

- [ ] **Step 3: Deploy with the guarded origin/local workflow**

```bash
CODEMAN_SYNC_REMOTE_REF=origin/local \
CODEMAN_SYNC_SERVICE=codeman-web \
CODEMAN_SYNC_HEALTH_URL=http://127.0.0.1:3002/ \
/home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/sync_origin_local_deploy.sh
```

Confirm the unrelated `src/session.ts`, `src/web/server.ts`, and `.superpowers/` state is restored exactly.

- [ ] **Step 4: Verify the user's saved production configuration**

Use Chromium against `http://192.168.20.66:3002` without forcing the newer sidebar. Confirm the server-provided settings remain:

```json
{
  "sessionListLayout": "header",
  "tabOrientation": "vertical"
}
```

Change the session-name setting through the real Settings Save flow and verify 11 px and 18 px computed names, a title/action gap no greater than 6 px, long-name truncation, intact group-heading size, no page/console errors, active `codeman-web`, and repeated LAN HTTP 200 responses.

- [ ] **Step 5: Update Jira and clean up**

Once `JIRA_PROFILE=work` is reauthenticated, comment on COD-339 with commits and verification, move it back to Done, then remove the merged worktree and feature branch.
