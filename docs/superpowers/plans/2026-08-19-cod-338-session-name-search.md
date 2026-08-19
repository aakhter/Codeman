# Vertical Tab-Rail Session-Name Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible, group-preserving session-name search to Codeman's resizable vertical tab rail.

**Architecture:** Keep the query as transient `CodemanApp` state. Build the ordinary canonical projection with collapse temporarily disabled while search is active, then pass it through one pure `filterSessionProjection` helper so collapsed matches are available without changing stored collapse state. Render the filtered projection through the existing `renderProjection` path; the separate optional session-sidebar filter remains unchanged.

**Tech Stack:** Browser JavaScript, HTML, CSS, JSDOM/Vitest, Playwright browser tests.

---

## File Map

- Modify `src/web/public/tab-layout-browser.js`: add and export the pure projection-filter helper.
- Modify `src/web/public/index.html`: add the vertical-rail search input, explicit clear button, and no-results status before the rail's session list.
- Modify `src/web/public/app.js`: own query state, derive name matches, filter the canonical projection, update controls, and clear on orientation exit.
- Modify `src/web/public/styles.css`: lay out the search control and no-results state only in vertical orientation.
- Modify `test/tab-layout-browser.test.ts`: unit-test projection filtering, order, Focus, counts, and collapse override inputs.
- Modify `test/tab-orientation.test.ts`: cover control visibility and clearing when leaving vertical orientation.
- Modify `test/tab-layout-editing.test.ts`: cover app-level live filtering and collapse-state restoration.
- Create `test/tab-rail-session-search.browser.test.ts`: exercise the user flow in Chromium.

### Task 1: Pure grouped-projection filtering

**Files:**
- Modify: `src/web/public/tab-layout-browser.js` near `project()` and the exported `global.CodemanTabLayout` object
- Test: `test/tab-layout-browser.test.ts`

- [ ] **Step 1: Write failing unit tests for the pure filter**

Add cases that construct an expanded vertical projection and assert this contract:

```js
const filtered = h.filterSessionProjection(projection, ['s2', 's4']);
expect(filtered.visibleRefs).toEqual([
  { kind: 'session', id: 's2' },
  { kind: 'session', id: 's4' },
]);
expect(filtered.sections.map(({ id, count, collapsed }) => ({ id, count, collapsed }))).toEqual([
  { id: 'core', count: 1, collapsed: false },
  { id: null, count: 1, collapsed: false },
]);
expect(filtered.focusRefs).toEqual([{ kind: 'session', id: 's2' }]);
expect(filtered.matchCount).toBe(2);
expect(filtered.searchActive).toBe(true);
expect(filtered.sessionOrder).toEqual(projection.sessionOrder);
expect(filtered.completeRefs).toEqual(projection.completeRefs);
```

Also assert that webviews are removed, empty sections are removed, duplicate Focus/canonical placement remains possible, input order is preserved, and an empty match set returns `sections: []`, `focusRefs: []`, `visibleRefs: []`, and `matchCount: 0`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- test/tab-layout-browser.test.ts`

Expected: FAIL because `filterSessionProjection` is not exported.

- [ ] **Step 3: Implement the minimal pure helper**

Add a helper with this interface and behavior:

```js
function filterSessionProjection(projection, matchingSessionIds) {
  const matches = new Set(asIds(matchingSessionIds));
  const keep = (ref) => ref?.kind === 'session' && matches.has(ref.id);
  const sections = (Array.isArray(projection?.sections) ? projection.sections : [])
    .map((section) => {
      const refs = [];
      const refIndices = [];
      (Array.isArray(section.refs) ? section.refs : []).forEach((ref, index) => {
        if (!keep(ref)) return;
        refs.push({ kind: ref.kind, id: ref.id });
        refIndices.push(section.refIndices?.[index] ?? index);
      });
      return { ...section, refs, refIndices, count: refs.length, collapsed: false };
    })
    .filter((section) => section.refs.length > 0);
  const visibleRefs = (Array.isArray(projection?.visibleRefs) ? projection.visibleRefs : [])
    .filter(keep)
    .map((ref) => ({ kind: ref.kind, id: ref.id }));
  const focusRefs = (Array.isArray(projection?.focusRefs) ? projection.focusRefs : [])
    .filter(keep)
    .map((ref) => ({ kind: ref.kind, id: ref.id }));
  return {
    ...projection,
    visibleRefs,
    focusRefs,
    focusCollapsed: false,
    sections,
    hiddenTabGroupByRef: {},
    searchActive: true,
    matchCount: new Set(visibleRefs.map((ref) => ref.id)).size,
  };
}
```

Export it on `global.CodemanTabLayout`. If tests show Focus-only matches are not present in `visibleRefs`, calculate `matchCount` from the union of `visibleRefs` and `focusRefs` while still deduplicating IDs.

- [ ] **Step 4: Run the focused unit test and verify GREEN**

Run: `npm test -- test/tab-layout-browser.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the pure behavior**

```bash
git add test/tab-layout-browser.test.ts src/web/public/tab-layout-browser.js
git commit -m "feat: COD-338 filter grouped tab projections by session"
```

### Task 2: Visible vertical-rail search controls

**Files:**
- Modify: `src/web/public/index.html` inside `#tabRail`
- Modify: `src/web/public/styles.css` in the vertical tab-rail block near `.tab-rail`
- Test: `test/tab-orientation.test.ts`

- [ ] **Step 1: Write failing structure and visibility tests**

Assert that `#tabRailSessionSearch` is inside `#tabRail`, precedes `#sessionTabs` after `applyTabOrientation()`, has accessible name `Search sessions`, and that `#tabRailSessionSearchClear` is a real button labelled `Clear session search`. Assert CSS hides the wrapper outside `html[data-tab-orientation='vertical']`.

- [ ] **Step 2: Run the focused orientation test and verify RED**

Run: `npm test -- test/tab-orientation.test.ts`

Expected: FAIL because the controls do not exist.

- [ ] **Step 3: Add semantic markup**

Insert before the resize handle:

```html
<div class="tab-rail-session-search" id="tabRailSessionSearchWrap">
  <input id="tabRailSessionSearch" class="tab-rail-session-search-input" type="search"
    placeholder="Search sessions" aria-label="Search sessions"
    autocomplete="off" spellcheck="false"
    oninput="app.setTabRailSessionSearch(this.value)">
  <button id="tabRailSessionSearchClear" class="tab-rail-session-search-clear" type="button"
    aria-label="Clear session search" title="Clear session search"
    onclick="app.clearTabRailSessionSearch()" hidden>&times;</button>
</div>
<div id="tabRailSessionSearchEmpty" class="tab-rail-session-search-empty" role="status" hidden>
  No sessions match
</div>
```

- [ ] **Step 4: Add narrowly scoped styling**

Use a hidden-by-default wrapper and reveal it only under `html[data-tab-orientation='vertical']`. Make the input fill the rail width, reserve space for the absolute-positioned clear button, retain a visible focus ring, and keep both the control and empty state outside the scrolling `#sessionTabs` list.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `npm test -- test/tab-orientation.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the visible control**

```bash
git add test/tab-orientation.test.ts src/web/public/index.html src/web/public/styles.css
git commit -m "feat: COD-338 add vertical rail session search control"
```

### Task 3: App state, name matching, and render integration

**Files:**
- Modify: `src/web/public/app.js` near constructor state, `_projectTabLayout()`, `applyTabOrientation()`, and `_fullRenderSessionTabs()`
- Test: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Write failing app-level tests**

Build sessions named `Alpha API`, `Roadmap`, and `API Review` across an expanded group, a collapsed group, Focus, and Ungrouped. Assert:

```js
app.setTabRailSessionSearch('aPi');
expect(visibleSessionNames()).toEqual(['Alpha API', 'API Review']);
expect(visibleGroupNames()).toEqual(['Focus', 'engineering', 'planning']);
expect(app.collapsedTabGroupIds).toEqual(new Set(['planning']));
expect(localStorage.getItem('codeman:tab-groups-collapsed')).toBe('["planning"]');
```

Also cover whitespace-only input, duplicate names, no results, clear-button focus restoration, count updates, live rename/add/remove/regroup/Focus rerenders, and horizontal-orientation clearing.

- [ ] **Step 2: Run the focused editing test and verify RED**

Run: `npm test -- test/tab-layout-editing.test.ts`

Expected: FAIL because the app methods and render-aware query do not exist.

- [ ] **Step 3: Add transient query state and control methods**

Initialize `_tabRailSessionSearch = ''`. Implement:

```js
setTabRailSessionSearch(value = '') {
  this._tabRailSessionSearch = String(value);
  this._lastTabStructureKey = null;
  this._fullRenderSessionTabs();
}

clearTabRailSessionSearch() {
  const input = document.getElementById('tabRailSessionSearch');
  if (input) input.value = '';
  this.setTabRailSessionSearch('');
  input?.focus();
}
```

Add one private updater that toggles the clear button and no-results status from the normalized query and filtered projection. Do not persist the query.

- [ ] **Step 4: Derive matches from displayed names and filter the projection**

In `_projectTabLayout()`, detect active search only when `_tabOrientation() === 'vertical'` and the trimmed query is non-empty. Build the base projection with `collapsedGroupIds: []` and `focusCollapsed: false` only for that active search. Derive matching IDs from live sessions using `this.getSessionName(session).toLocaleLowerCase().includes(needle)`; do not inspect working directories or webview labels. Pass the base projection and IDs to `window.CodemanTabLayout.filterSessionProjection()`.

Keep ordinary `sessionOrder`, `completeRefs`, and stored collapse members authoritative. Force a full render on query changes; do not use the unrelated `.tab-filtered-out` DOM-class path.

- [ ] **Step 5: Make search-context group headers non-collapsing**

While the active filtered projection is rendered, prevent Focus and named-group toggle handlers from mutating collapse state. Prefer rendering context headers without actionable disclosure buttons or with inert/disabled controls and truthful `aria-expanded="true"`; clearing search restores the ordinary interactive headers.

- [ ] **Step 6: Clear the query when vertical orientation is left**

In `applyTabOrientation()`, when the applied orientation is not vertical, clear `_tabRailSessionSearch`, the input value, the clear button, and the no-results state before the horizontal render. Do not change `_sidebarFilter` or optional session-sidebar behavior.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `npm test -- test/tab-layout-editing.test.ts test/tab-orientation.test.ts test/tab-layout-browser.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit app integration**

```bash
git add test/tab-layout-editing.test.ts test/tab-orientation.test.ts src/web/public/app.js src/web/public/tab-layout-browser.js
git commit -m "feat: COD-338 search sessions across vertical rail groups"
```

### Task 4: Real-browser regression

**Files:**
- Create: `test/tab-rail-session-search.browser.test.ts`

- [ ] **Step 1: Write the Chromium regression**

Follow the harness in `test/tab-focus-smart-group.browser.test.ts`. Seed a vertical layout with one collapsed group, Focus, and Ungrouped; type a mixed-case substring; assert only matching rows and their group headers are visible; select the formerly collapsed match; clear; and assert the original collapsed group is collapsed again. Assert the × button is reachable by role and focus returns to the input after activation.

- [ ] **Step 2: Run the browser test and verify behavior**

Run: `npm test -- test/tab-rail-session-search.browser.test.ts`

Expected: PASS. If Playwright cannot launch because the browser binary is unavailable, record the exact environmental error on COD-338 and run the repository's approved browser verification command in the configured beta environment.

- [ ] **Step 3: Commit browser coverage**

```bash
git add test/tab-rail-session-search.browser.test.ts
git commit -m "test: COD-338 cover vertical rail session search"
```

### Task 5: Focused verification and Jira evidence

**Files:**
- Modify only files required by formatter output

- [ ] **Step 1: Run focused automated verification**

```bash
npm test -- test/tab-layout-browser.test.ts test/tab-orientation.test.ts test/tab-layout-editing.test.ts test/tab-rail-session-search.browser.test.ts
npx tsc --noEmit
npx eslint --config config/eslint.config.js src/**/*.ts
npm run check:frontend-syntax
npx prettier --check src/web/public/tab-layout-browser.js src/web/public/app.js src/web/public/index.html src/web/public/styles.css test/tab-layout-browser.test.ts test/tab-orientation.test.ts test/tab-layout-editing.test.ts test/tab-rail-session-search.browser.test.ts
npm run build
```

Expected: all focused tests and checks PASS. Never run bare `npm test` or bare `npx vitest run` from the Codeman-managed session.

- [ ] **Step 2: Verify the running surface**

Use the configured Codeman beta instance, not production. Confirm the field appears above Focus in the resizable vertical rail, a collapsed-group match is revealed, the × clears the query, and clearing restores the original collapse state. Capture the exact URL/instance and observed results.

- [ ] **Step 3: Review the diff and repository state**

Run: `git diff --check && git status --short && git log -6 --oneline`

Expected: no whitespace errors; only intended files changed; the pre-existing untracked `.superpowers/` directory remains untouched.

- [ ] **Step 4: Post Jira evidence and stop before production deploy**

Comment on COD-338 with focused test output, build result, beta/browser verification, and commit hashes. Follow the Codeman lane rule: land on `local` only after verification and leave production deployment pending unless the user explicitly authorizes deploy.

## Plan Self-Review

- Every design requirement maps to a task.
- The target is the vertical tab rail, not the optional session sidebar.
- Collapsed matches are found from an expanded transient projection without persistence mutation.
- Display-name-only matching, group context, Focus duplication, counts, no-results, explicit clear, orientation cleanup, live updates, accessibility, and browser verification are covered.
- The plan contains no backend, persistence, or unrelated refactor work.
