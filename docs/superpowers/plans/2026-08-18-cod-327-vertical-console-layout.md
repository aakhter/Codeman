# COD-327 Vertical Console Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep vertically oriented session tabs in the left rail when the session-list layout reapplies after startup.

**Architecture:** Preserve the single `#sessionTabs` node and resolve its owner from both applied layout dimensions: the dedicated sidebar takes precedence, then the vertical rail, then the horizontal header host. Keep the DOM owner and `aria-orientation` synchronized in the same method.

**Tech Stack:** Browser JavaScript, TypeScript/Vitest, JSDOM

---

### Task 1: Capture the misplaced-tab regression

**Files:**
- Modify: `test/session-list-layout.test.ts`

- [ ] **Step 1: Extend the layout harness with the rail API and host**

Add `applyTabOrientation(): void` to `LayoutApp` and add the real rail host immediately inside `.main`:

```html
<div class="tab-rail" id="tabRail"></div>
```

- [ ] **Step 2: Write the failing regression test**

```ts
it('preserves vertical rail ownership when the session-list layout reapplies', () => {
  const { win, app } = boot({ stored: { sessionListLayout: 'header', tabOrientation: 'vertical' } });

  app.applySessionListLayout();
  app.applyTabOrientation();
  expect(tabsEl(win).parentElement?.id).toBe('tabRail');

  app.applySessionListLayout();

  expect(tabsEl(win).parentElement?.id).toBe('tabRail');
  expect(tabsEl(win).getAttribute('aria-orientation')).toBe('vertical');
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm test -- test/session-list-layout.test.ts`

Expected: the new test fails because the second `applySessionListLayout()` moves `#sessionTabs` to `#sessionTabsHost`.

### Task 2: Preserve the resolved tab owner

**Files:**
- Modify: `src/web/public/app.js`
- Test: `test/session-list-layout.test.ts`

- [ ] **Step 1: Resolve the rail before selecting the host**

In `applySessionListLayout()`, replace the unconditional header fallback with:

```js
const rail = document.getElementById('tabRail');
const railOwnsTabs =
  mode === 'header' && document.documentElement.getAttribute('data-tab-orientation') === 'vertical';
const host = mode === 'sidebar' ? sidebarList : railOwnsTabs && rail ? rail : headerHost;
```

- [ ] **Step 2: Derive accessibility orientation from the resolved owner**

Replace the mode-only ARIA assignment with:

```js
tabsEl.setAttribute('aria-orientation', host === headerHost ? 'horizontal' : 'vertical');
```

- [ ] **Step 3: Run the focused test and verify GREEN**

Run: `npm test -- test/session-list-layout.test.ts`

Expected: 27 tests pass with no failures.

- [ ] **Step 4: Commit the regression fix**

```bash
git add -- src/web/public/app.js test/session-list-layout.test.ts
git commit -m "fix(tabs): COD-327 preserve vertical rail placement"
```

### Task 3: Verify the completed change

**Files:**
- Verify: `src/web/public/app.js`
- Verify: `test/session-list-layout.test.ts`

- [ ] **Step 1: Re-run the regression test from a clean process**

Run: `npm test -- test/session-list-layout.test.ts`

Expected: 27 tests pass with no failures.

- [ ] **Step 2: Run repository quality gates**

Run each command separately:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: every command exits with status 0.

- [ ] **Step 3: Inspect the final patch**

Run:

```bash
git diff --check origin/local...HEAD
git status --short --branch
```

Expected: no whitespace errors; the branch contains only the COD-327 spec, plan, test, and implementation commits.
