# COD-352 Session Actions Menu Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the contextual per-session `⋯` menu trigger in both expanded vertical navigation layouts without changing horizontal, compact, or menu-action behavior.

**Architecture:** Keep the existing action markup and `openTabRailActionMenu()` data flow. Extend only the `.tab-more` CSS state selectors for the nested action-cluster shape used by expanded vertical layouts, with explicit rail/sidebar scoping, and prove the interaction through computed-style and real-click Chromium tests.

**Tech Stack:** Plain CSS, browser JavaScript, Vitest, Playwright/Chromium, Changesets.

---

## File Map

- Modify `test/session-sidebar-ux.browser.test.ts`: reproduce the invisible nested trigger in real Chromium and cover pointer, keyboard, active, and touch states.
- Modify `src/web/public/styles.css`: reveal nested `.tab-more` controls only on the two expanded vertical surfaces.
- Create `.changeset/cod-352-session-actions-menu.md`: record the user-visible patch.

### Task 1: Add the failing expanded-vertical interaction coverage

**Files:**
- Modify: `test/session-sidebar-ux.browser.test.ts`

- [ ] **Step 1: Add helpers that switch the production fixture between expanded vertical surfaces and read the trigger's computed state**

Add these helpers inside the existing `describe`, after `afterAll` and before the first test:

```ts
async function applyExpandedSurface(surface: 'sidebar' | 'rail') {
  await page.evaluate((nextSurface) => {
    const controller = (window as any).__cod339Controller;
    controller.__cod339Settings =
      nextSurface === 'sidebar'
        ? { sessionListLayout: 'sidebar', sessionSidebarFontSize: 14 }
        : { sessionListLayout: 'header', tabOrientation: 'vertical', sessionSidebarFontSize: 14 };
    controller._sidebarCollapsedOverride = false;
    controller.activeSessionId = 'short';
    document.documentElement.dataset.sessionList = nextSurface === 'sidebar' ? 'sidebar' : 'header';
    document.documentElement.dataset.sidebar = 'expanded';
    document.documentElement.dataset.tabOrientation = nextSurface === 'sidebar' ? 'horizontal' : 'vertical';
    document.documentElement.classList.remove('tab-rail-compact');
    controller._lastTabStructureKey = null;
    controller.applySessionListLayout();
    controller._fullRenderSessionTabs();
  }, surface);
}

async function tabMoreState(targetPage: Page, sessionId = 'long') {
  return targetPage.locator(`.session-tab[data-id="${sessionId}"] .tab-more`).evaluate((element) => {
    const style = getComputedStyle(element);
    return { visibility: style.visibility, pointerEvents: style.pointerEvents };
  });
}
```

- [ ] **Step 2: Add a Chromium test for inactive, hover, click, keyboard-focus, and active states on both surfaces**

Add this test after the current action-cluster placement test:

```ts
it('reveals and opens nested session actions contextually on expanded vertical surfaces', async () => {
  for (const surface of ['sidebar', 'rail'] as const) {
    await applyExpandedSurface(surface);
    const row = page.locator('.session-tab[data-id="long"]');
    const trigger = row.locator('.tab-more');

    expect.soft(await tabMoreState(page)).toEqual({ visibility: 'hidden', pointerEvents: 'none' });

    await row.hover();
    expect.soft(await tabMoreState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
    await trigger.click();
    expect.soft(await page.locator('.tab-rail-action-menu').count()).toBe(1);
    await page.evaluate(() => (window as any).__cod339Controller.closeTabRailActionMenu());

    await page.mouse.move(1200, 760);
    await row.focus();
    expect.soft(await tabMoreState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
      const controller = (window as any).__cod339Controller;
      controller.activeSessionId = 'long';
      controller._lastTabStructureKey = null;
      controller._fullRenderSessionTabs();
    });
    expect.soft(await tabMoreState(page)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
  }
});
```

- [ ] **Step 3: Add a touch-context test for the nested action cluster without hover**

Add this test immediately after the contextual desktop test:

```ts
it('keeps nested session actions reachable for coarse pointers', async () => {
  const touchContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
  const touchPage = await touchContext.newPage();
  try {
    for (const surface of ['sidebar', 'rail'] as const) {
      await applyExpandedSurface(surface);
      await touchPage.setContent(await page.content());
      expect.soft(await tabMoreState(touchPage)).toEqual({ visibility: 'visible', pointerEvents: 'auto' });
    }
  } finally {
    await touchContext.close();
  }
});
```

- [ ] **Step 4: Run the browser test and verify RED**

Run:

```bash
npm run test:browser -- test/session-sidebar-ux.browser.test.ts
```

Expected: FAIL in the new contextual test because the nested `.tab-more` remains `visibility: hidden` with `pointer-events: none`. The existing 10 tests remain green. If Chromium reports `sandbox_host_linux.cc` rather than the visibility assertion, rerun the same targeted command with the approved unsandboxed browser permission.

### Task 2: Restore scoped nested-trigger visibility

**Files:**
- Modify: `src/web/public/styles.css`
- Test: `test/session-sidebar-ux.browser.test.ts`

- [ ] **Step 1: Add expanded-sidebar and expanded-rail selectors beside the existing direct-child rules**

Keep the four existing direct-child selectors, then extend the same rule with these two explicitly scoped selector families:

```css
.session-tab:hover > .tab-actions > .tab-more,
.session-tab:focus-within > .tab-actions > .tab-more,
.session-tab.active > .tab-actions > .tab-more,
.tab-focus-shortcut > .tab-actions > .tab-more,
html[data-session-list='sidebar'][data-sidebar='expanded']
  .session-sidebar
  :is(.session-tab:hover, .session-tab:focus-within, .session-tab.active)
  .tab-name-row
  > .tab-actions
  > .tab-more,
html[data-tab-orientation='vertical']:not(.tab-rail-compact)
  .tab-rail
  :is(.session-tab:hover, .session-tab:focus-within, .session-tab.active)
  .tab-name-row
  > .tab-actions
  > .tab-more {
  visibility: visible;
  pointer-events: auto;
}
```

The nested selectors must remain scoped to the expanded sidebar and non-compact vertical rail. Do not replace them with a global `.session-tab:hover .tab-more` descendant selector.

- [ ] **Step 2: Extend the coarse-pointer rule for both nested expanded layouts**

Replace the existing single-selector coarse-pointer block with:

```css
@media (pointer: coarse) {
  .session-tab > .tab-actions > .tab-more,
  html[data-session-list='sidebar'][data-sidebar='expanded']
    .session-sidebar
    .session-tab
    .tab-name-row
    > .tab-actions
    > .tab-more,
  html[data-tab-orientation='vertical']:not(.tab-rail-compact)
    .tab-rail
    .session-tab
    .tab-name-row
    > .tab-actions
    > .tab-more {
    visibility: visible;
    pointer-events: auto;
  }
}
```

- [ ] **Step 3: Run the browser test and verify GREEN**

Run:

```bash
npm run test:browser -- test/session-sidebar-ux.browser.test.ts
```

Expected: PASS with 12 tests. Both new tests must execute; do not accept a zero-test or skipped-suite result.

- [ ] **Step 4: Run the existing action-menu behavior tests**

Run:

```bash
npm test -- test/tab-layout-editing.test.ts test/session-sidebar-ux.test.ts
```

Expected: PASS. This confirms Focus, Move to Group, action-cluster structure, and direct-child layout behavior remain intact.

- [ ] **Step 5: Commit the regression test and minimal CSS fix**

```bash
git add -- src/web/public/styles.css test/session-sidebar-ux.browser.test.ts
git commit -m "fix(nav): COD-352 restore vertical session actions"
```

### Task 3: Add release metadata and run quality gates

**Files:**
- Create: `.changeset/cod-352-session-actions-menu.md`

- [ ] **Step 1: Add the patch changeset**

Create `.changeset/cod-352-session-actions-menu.md` with exactly:

```markdown
---
'aicodeman': patch
---

Restore the contextual session actions menu in expanded vertical navigation.
```

- [ ] **Step 2: Run the complete scoped verification set**

Run each command from the COD-352 worktree:

```bash
npm run test:browser -- test/session-sidebar-ux.browser.test.ts
npm test -- test/tab-layout-editing.test.ts test/session-sidebar-ux.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

Expected: every command exits 0; the browser run reports 12 tests; the focused ordinary run reports no failures; formatting, lockfile, frontend syntax, browser exclusions, typecheck, lint, and build all pass. Never substitute bare `npm test` or `npm run test:all` in the Codeman-managed session.

- [ ] **Step 3: Review the final diff for scope**

Run:

```bash
git diff -- src/web/public/styles.css test/session-sidebar-ux.browser.test.ts .changeset/cod-352-session-actions-menu.md
git status --short --branch
```

Expected: only the scoped CSS selectors, the two Chromium regression tests/helpers, and the patch changeset are uncommitted. The design and plan commits are already present.

- [ ] **Step 4: Commit the release metadata**

```bash
git add -- .changeset/cod-352-session-actions-menu.md
git commit -m "chore: COD-352 add release metadata"
```

- [ ] **Step 5: Capture the branch handoff evidence**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: `fix/COD-352-session-actions-menu` is clean and the log contains the design, implementation, and release-metadata commits. Record the branch, commits, and verification results on COD-352 before moving the issue to Done; obtain explicit authorization before sending that external Jira update.
