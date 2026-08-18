# COD-319 Focus Smart Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner persistently flag session and saved-webview tabs as Focus and activate them from a fixed, collapsible smart section at the top of the vertical tab rail without changing canonical ordering or traversal.

**Architecture:** Store `focus: true` on the one canonical `TabRef`, mutate it through a new idempotent `setFocus` semantic operation, and keep the server authoritative through the existing versioned PUT/SSE flow. The browser derives `focusRefs` from canonical order only for vertical rendering; shortcut representations use dedicated markup and never enter canonical numbering, traversal, lineage, or drag/drop collections.

**Tech Stack:** TypeScript ESM, Fastify owner-scoped tab-layout service, plain browser JavaScript/CSS, Vitest/jsdom, Playwright Chromium.

---

### Task 1: Persist Focus on the canonical layout model

**Files:**

- Modify: `src/tab-layout.ts:14-18,99-111,155-310,421-470`
- Test: `test/tab-layout.test.ts`

- [ ] **Step 1: Write failing model tests**

Add tests that validate literal `focus: true`, reject `focus: false` and non-boolean values, preserve Focus through normalization/deduplication, moves, group deletion, manual placement, and Follow parent, and clear it only through the new model operation:

```ts
expect(validateTabLayout(layout([], [{ ...ref('focused'), focus: true }])).ungrouped[0]).toEqual({
  kind: 'session',
  id: 'focused',
  focus: true,
});
expect(() => validateTabLayout(layout([], [{ ...ref('bad'), focus: false } as never]))).toThrow(/focus/);

const focused = layout([{ id: 'g', name: 'G', refs: [{ ...ref('child'), focus: true }] }]);
expect(setTabFocus(focused, ref('child'), false).groups[0].refs[0]).toEqual(ref('child'));
expect(setTabFocus(focused, ref('child'), true)).toEqual(focused);
expect(() => setTabFocus(focused, ref('missing'), true)).toThrow(/unknown ref/);
```

- [ ] **Step 2: Run the model test and verify RED**

Run: `npm test -- test/tab-layout.test.ts`

Expected: FAIL because `TabRef.focus` and `setTabFocus` do not exist and current parsing drops or accepts the wrong shape.

- [ ] **Step 3: Implement strict parsing and the model operation**

Extend the type and parse output without serializing `false`:

```ts
export interface TabRef {
  kind: TabRefKind;
  id: string;
  placement?: 'manual';
  focus?: true;
}

if (value.focus !== undefined && value.focus !== true) {
  throw new TabLayoutValidationError(`${label}.focus must be true when present`);
}
return {
  kind: value.kind,
  id,
  ...(value.placement === 'manual' ? { placement: 'manual' as const } : {}),
  ...(value.focus === true ? { focus: true as const } : {}),
};
```

Add the idempotent transform:

```ts
export function setTabFocus(input: TabLayout, target: TabRef, focused: boolean): TabLayout {
  return mapRef(input, target, (ref) => {
    if (focused) return ref.focus === true ? ref : { ...ref, focus: true };
    if (ref.focus !== true) return ref;
    const { focus: _focus, ...rest } = ref;
    return rest;
  });
}
```

Ensure `followParent` removes only `placement`, not `focus`, by returning `{ ...ref, placement: undefined }` through an explicit helper that omits `placement` while retaining optional fields.

- [ ] **Step 4: Run model tests and verify GREEN**

Run: `npm test -- test/tab-layout.test.ts`

Expected: all model tests pass; no stored Focus field is lost by clone, normalize, move, delete-group, manual, or lineage paths.

- [ ] **Step 5: Commit the model slice**

```bash
git add -- src/tab-layout.ts test/tab-layout.test.ts
git commit -m "feat(tabs): COD-319 persist Focus on tab refs"
```

### Task 2: Add the owner-authoritative semantic operation

**Files:**

- Modify: `src/tab-layout-service.ts:50-145,300-400`
- Test: `test/tab-layout-service.test.ts`
- Test: `test/routes/tab-layout-routes.test.ts`

- [ ] **Step 1: Write failing service and route tests**

Cover session and webview refs, owner isolation, exact-base validation, stale-valid conflict handling, mixed recovery prefixes, and idempotency:

```ts
const first = await service.putOperations(
  'alice',
  [{ type: 'setFocus', ref: { kind: 'session', id: 's1' }, focused: true }],
  7
);
expect(first.status).toBe('updated');
expect(first.layout.ungrouped[0]).toMatchObject({ id: 's1', focus: true });

const unchanged = await service.putOperations(
  'alice',
  [{ type: 'setFocus', ref: { kind: 'session', id: 's1' }, focused: true }],
  first.layout.version
);
expect(unchanged.layout.version).toBe(first.layout.version);
expect(store.setTabLayout).toHaveBeenCalledTimes(1);
expect(broadcast).toHaveBeenCalledTimes(1);
```

Add route matrices proving malformed `focused`, malformed refs, and missing canonical refs return 400 at the current version, while stale well-formed requests return 409 with the current snapshot.

- [ ] **Step 2: Run focused service/route tests and verify RED**

Run: `npm test -- test/tab-layout-service.test.ts test/routes/tab-layout-routes.test.ts`

Expected: FAIL with unknown `setFocus` operation.

- [ ] **Step 3: Implement service validation and authoritative application**

Extend the union and state-independent request validator:

```ts
| { type: 'setFocus'; ref: TabRef; focused: boolean }

case 'setFocus':
  if (!validOperationRef(operation.ref) || typeof operation.focused !== 'boolean') {
    throw new TabLayoutValidationError('setFocus operation has invalid fields');
  }
  return;
```

Import `setTabFocus` and apply it in `putOperations`. Preserve existing `sameContent` idempotency so an unchanged Focus request returns the current version and emits no write/event. Include `setFocus` among ref-bearing operations checked before the switch and in recovery-prefix inference.

- [ ] **Step 4: Run service/route tests and verify GREEN**

Run: `npm test -- test/tab-layout-service.test.ts test/routes/tab-layout-routes.test.ts`

Expected: all tests pass, including one write/event for a real change and zero for an idempotent repeat.

- [ ] **Step 5: Commit the service slice**

```bash
git add -- src/tab-layout-service.ts test/tab-layout-service.test.ts test/routes/tab-layout-routes.test.ts
git commit -m "feat(tabs): COD-319 add Focus layout operation"
```

### Task 3: Mirror Focus and derive the vertical smart projection

**Files:**

- Modify: `src/web/public/tab-layout-browser.js:12-220,245-455,455-690`
- Test: `test/tab-layout-browser.test.ts`
- Test: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Write failing browser-model tests**

Add Focus to interleaved fixtures and assert all three independent outputs:

```ts
const result = h.project(focusedLayout, {
  liveSessionIds: ['s1', 's2'],
  openWebviewIds: ['w1'],
  orientation: 'vertical',
  collapsedGroupIds: ['g1'],
  focusCollapsed: false,
});
expect(result.focusRefs).toEqual([
  { kind: 'session', id: 's2' },
  { kind: 'webview', id: 'w1' },
]);
expect(result.visibleRefs).toEqual([
  { kind: 'webview', id: 'w1' },
  { kind: 'session', id: 's1' },
]);
expect(h.refAtAltNumber(result.visibleRefs, 1)).toEqual({ kind: 'webview', id: 'w1' });
```

Assert horizontal projection has `focusRefs: []`, closed saved webviews do not appear until reopened, Focus ordering follows group-then-Ungrouped canonical order, and `structureKey` changes when Focus/collapse state changes without duplicating canonical ref keys.

Add `applyOperation` RED cases for optimistic add/remove and operation recovery with ordinary and Follow-parent edits.

- [ ] **Step 2: Run browser helper tests and verify RED**

Run: `npm test -- test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts`

Expected: FAIL because normalization drops `focus`, `setFocus` is unknown, and projection has no `focusRefs`.

- [ ] **Step 3: Implement the browser semantic mirror and projection**

Preserve the optional field in `normalizedLayout`, and handle the operation with `mapStoredRef`:

```js
...(ref.focus === true ? { focus: true } : {}),

if (operation.type === 'setFocus') {
  if (!validRef(operation.ref) || typeof operation.focused !== 'boolean') operationError('invalid Focus state');
  return mapStoredRef(layout, operation.ref, (ref) => {
    if (operation.focused) return { ...ref, focus: true };
    const { focus: _focus, ...rest } = ref;
    return rest;
  });
}
```

While scanning stored refs in canonical order, collect renderable focused identities independently of collapse:

```js
const focusRefs = [];
if (orientation === 'vertical') {
  for (const { ref } of refLocations(layout)) {
    if (ref.focus === true && renderable(ref)) focusRefs.push({ kind: ref.kind, id: ref.id });
  }
}
return {
  sessionOrder: ownerSessions,
  completeRefs,
  visibleRefs,
  focusRefs,
  focusCollapsed: orientation === 'vertical' && options.focusCollapsed === true,
  sections,
  hiddenTabGroupByRef,
};
```

Include Focus keys and the reserved smart-collapse state in `structureKey`. Keep `visibleRefs`, `completeRefs`, `sessionOrder`, section `refIndices`, and operation indexes unchanged.

- [ ] **Step 4: Run browser helper tests and verify GREEN**

Run: `npm test -- test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts`

Expected: tests pass and recovery snapshots retain the `focus` field and `setFocus` intent.

- [ ] **Step 5: Commit the browser model slice**

```bash
git add -- src/web/public/tab-layout-browser.js test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts
git commit -m "feat(tabs): COD-319 derive vertical Focus refs"
```

### Task 4: Render the fixed Focus section without behavioral duplicates

**Files:**

- Modify: `src/web/public/tab-layout-browser.js:418-455`
- Modify: `src/web/public/app.js:5390-5490,5840-6110,6130-6280`
- Modify: `src/web/public/webview-tabs.js:210-250`
- Test: `test/tab-layout-browser.test.ts`
- Test: `test/tab-layout-app.test.ts`
- Test: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Write failing vertical-render integration tests**

Using the shipping jsdom app harness, assert:

```ts
expect(document.querySelector('[data-tab-focus-group]')).not.toBeNull();
expect(document.querySelector('[data-tab-focus-group] + [data-tab-group-id="g1"]')).not.toBeNull();
expect(document.querySelectorAll('[data-tab-focus-shortcut="session:s1"]')).toHaveLength(1);
expect(document.querySelector('[data-tab-focus-shortcut] .tab-number')).toBeNull();
expect(document.querySelector('[data-tab-focus-shortcut] [data-tab-ref-drag]')).toBeNull();
expect(app._visibleTabRefs).toEqual(canonicalRefs);
```

Cover empty omission, horizontal and phone flat rendering, selected shortcut `aria-current="page"`, canonical-only `aria-selected`, Enter/Space activation, roving focus, and a focused ref hidden inside a collapsed real group still appearing in Focus.

- [ ] **Step 2: Run rendering tests and verify RED**

Run: `npm test -- test/tab-layout-browser.test.ts test/tab-layout-app.test.ts test/tab-layout-editing.test.ts`

Expected: FAIL because the Focus section and shortcut representation do not exist.

- [ ] **Step 3: Add explicit shortcut render callbacks**

Extend `renderProjection` to call a fifth callback only for Focus shortcuts:

```js
function renderProjection(projection, orientation, renderRef, escapeHtml, renderFocusRef = renderRef) {
  const focusRefs = orientation === 'vertical' && Array.isArray(projection?.focusRefs) ? projection.focusRefs : [];
  const focus = focusRefs.length
    ? renderFocusSection(focusRefs, projection.focusCollapsed, renderFocusRef, escapeHtml)
    : '';
  // real sections keep using renderRef and canonical indexes exactly as before
  return `<div class="tab-layout-tree" role="tree" aria-label="Sessions">${focus}${groups}</div>...`;
}
```

The fixed header uses `data-tab-focus-group`, `data-tab-focus-toggle`, `aria-expanded`, no group ID, no group menu, no group/ref drag handle, and no drop zones. The member container is `role="group"` only while expanded.

Add `_renderFocusShortcut(ref)` to `app.js` and extend `renderWebviewTab` with a shortcut option or shared renderer. Shortcut root markup must include:

```html
<div
  class="session-tab tab-focus-shortcut"
  data-tab-focus-shortcut="session:s1"
  data-focus-session-id="s1"
  role="treeitem"
  tabindex="-1"
  aria-current="page|false"
  aria-label="Focus shortcut, NAME session"
>
  ...
</div>
```

Reuse the tab's name, icon/mode, status, loading, alert, task, and placement presentation, but omit `.tab-number`, `[data-tab-ref-drag]`, settings/detach/close/move controls, and unique IDs. Add one `.tab-more` whose action is Remove from Focus.

Update keyboard identity/activation to recognize `data-focus-session-id` and `data-focus-webview-id` while leaving `_visibleTabRefs`, Alt-number, `sessionOrder`, and next/previous unchanged.

- [ ] **Step 4: Run rendering tests and verify GREEN**

Run: `npm test -- test/tab-layout-browser.test.ts test/tab-layout-app.test.ts test/tab-layout-editing.test.ts`

Expected: all rendering, canonical-order, keyboard, and accessibility assertions pass.

- [ ] **Step 5: Commit the rendering slice**

```bash
git add -- src/web/public/tab-layout-browser.js src/web/public/app.js src/web/public/webview-tabs.js test/tab-layout-browser.test.ts test/tab-layout-app.test.ts test/tab-layout-editing.test.ts
git commit -m "feat(tabs): COD-319 render Focus shortcuts"
```

### Task 5: Persist local Focus collapse and wire exact menu actions

**Files:**

- Modify: `src/web/public/tab-layout-browser.js:15-55`
- Modify: `src/web/public/app.js:4880-5130,5280-5495`
- Modify: `src/web/public/tab-rail-resize.js:260-340`
- Modify: `src/web/public/webview-tabs.js:215-250`
- Test: `test/tab-layout-browser.test.ts`
- Test: `test/tab-layout-editing.test.ts`
- Test: `test/webview-open-state.test.ts`

- [ ] **Step 1: Write failing storage and menu tests**

Reserve a non-colliding key such as `@focus` and test restart persistence, malformed/localStorage failure fallback, and immunity from real-group stale-ID cleanup. Test exact action labels:

```ts
expect(menuLabels(canonicalFocusedSession)).toContain('Remove from Focus');
expect(menuLabels(canonicalUnfocusedSession)).toContain('Add to Focus');
expect(menuLabels(canonicalFocusedWebview)).toContain('Remove from Focus');
expect(menuLabels(focusShortcut)).toEqual(['Remove from Focus']);
```

Click each shipping menu action and assert the coordinator receives exactly:

```ts
{ type: 'setFocus', ref: { kind: 'session', id: 's1' }, focused: true }
{ type: 'setFocus', ref: { kind: 'webview', id: 'w1' }, focused: false }
```

- [ ] **Step 2: Run storage/menu tests and verify RED**

Run: `npm test -- test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts test/webview-open-state.test.ts`

Expected: FAIL because Focus collapse and menu actions are absent.

- [ ] **Step 3: Implement collapse and action helpers**

Add browser helpers that preserve the reserved ID during valid-group cleanup:

```js
const FOCUS_COLLAPSE_ID = '@focus';
const valid = new Set([...stableIds(validGroupIds), FOCUS_COLLAPSE_ID]);
```

Allow `toggleTabGroupCollapsed(FOCUS_COLLAPSE_ID)` even though it is not a real group, pass `focusCollapsed` into projection, and hide all shortcuts when collapsed without a selected-member exception.

Add shared app helpers:

```js
_tabStoredRef(ref) {
  const location = this._refLocation(ref);
  if (!location) return null;
  return location.groupId === null
    ? this.tabLayout.ungrouped[location.index]
    : this.tabLayout.groups.find((group) => group.id === location.groupId)?.refs[location.index] || null;
}
_tabRefFocused(ref) { return this._tabStoredRef(ref)?.focus === true; }
setTabRefFocus(ref, focused) {
  return this.editTabLayout({ type: 'setFocus', ref, focused }, `${ref.kind}:${ref.id}`);
}
_tabRefFocusAction(ref) {
  const focused = this._tabRefFocused(ref);
  return { label: focused ? 'Remove from Focus' : 'Add to Focus', run: () => this.setTabRefFocus(ref, !focused) };
}
```

Prepend this action to canonical session and webview menus. Give the shortcut's dedicated menu exactly the remove action; do not route shortcut Shift+F10 into move/placement actions.

- [ ] **Step 4: Run storage/menu tests and verify GREEN**

Run: `npm test -- test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts test/webview-open-state.test.ts`

Expected: all collapse and session/webview action tests pass without altering existing menu actions on canonical rows.

- [ ] **Step 5: Commit the interaction slice**

```bash
git add -- src/web/public/tab-layout-browser.js src/web/public/app.js src/web/public/tab-rail-resize.js src/web/public/webview-tabs.js test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts test/webview-open-state.test.ts
git commit -m "feat(tabs): COD-319 add Focus controls"
```

### Task 6: Synchronize duplicate representations and styling

**Files:**

- Modify: `src/web/public/app.js:1520-1545,5525-5680,6980-7040`
- Modify: `src/web/public/webview-tabs.js:250-270`
- Modify: `src/web/public/styles.css:680-900,16400-16430`
- Test: `test/tab-layout-app.test.ts`
- Test: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Write failing duplicate-update and CSS tests**

Assert two representations update together for name, status, active/current state, alert/load/placement badges, and deletion. Assert `querySelectorAll` is used for duplicate-sensitive paths and there are no duplicate `id` attributes.

Add source/CSS assertions for a non-interactive canonical marker and a subtler current shortcut treatment:

```ts
expect(css).toMatch(/\.tab-focus-marker/);
expect(css).toMatch(/\.tab-focus-shortcut\[aria-current='page'\]/);
expect(css).toMatch(/html\[data-tab-orientation='vertical'\][^}]*\.tab-layout-focus-group/s);
```

- [ ] **Step 2: Run duplicate/CSS tests and verify RED**

Run: `npm test -- test/tab-layout-app.test.ts test/tab-layout-editing.test.ts`

Expected: FAIL because existing first-match update paths and Focus styles do not cover both representations.

- [ ] **Step 3: Implement representation-safe updates and vertical styling**

Replace duplicate-sensitive single-node lookups with loops over representation attributes. Canonical rows carry `.tab-focus-marker` when focused; shortcuts carry `.tab-focus-shortcut` and `aria-current`, never `.active`/`aria-selected="true"`.

Add vertical-only layout styles for the fixed section, header, shortcut rows, marker, collapsed state, hover/focus, and current target. Keep the derived group hidden by construction in horizontal and phone output rather than CSS-only hiding.

- [ ] **Step 4: Run duplicate/CSS tests and verify GREEN**

Run: `npm test -- test/tab-layout-app.test.ts test/tab-layout-editing.test.ts`

Expected: both canonical and shortcut representations stay synchronized and accessibility semantics remain exclusive.

- [ ] **Step 5: Commit the synchronization slice**

```bash
git add -- src/web/public/app.js src/web/public/webview-tabs.js src/web/public/styles.css test/tab-layout-app.test.ts test/tab-layout-editing.test.ts
git commit -m "fix(tabs): COD-319 synchronize Focus shortcuts"
```

### Task 7: Prove real-browser behavior and lifecycle boundaries

**Files:**

- Create: `test/tab-focus-smart-group.browser.test.ts`
- Modify: `config/vitest.ci.config.ts:35-65`
- Test: `test/webview-open-state.test.ts`
- Test: `test/tab-layout-sse.test.ts`
- Test: `test/tab-layout-service.test.ts`

- [ ] **Step 1: Write failing lifecycle and Chromium tests**

The real browser test must load shipping `constants.js`, `tab-layout-browser.js`, `app.js`, `tab-rail-resize.js`, `webview-tabs.js`, and `styles.css`, then exercise:

```ts
await page.locator('[data-id="s1"] .tab-more').click();
await page.getByRole('menuitem', { name: 'Add to Focus' }).click();
await expect(page.locator('[data-tab-focus-shortcut="session:s1"]')).toBeVisible();
await page.locator('[data-tab-focus-toggle]').click();
await expect(page.locator('[data-tab-focus-shortcut="session:s1"]')).toBeHidden();
```

Also test Enter/Space activation, current styling, canonical Alt-number/next/previous invariants, webview close/reopen retention, session/webview deletion pruning, same-owner SSE adoption, different-owner isolation, and horizontal/phone omission.

- [ ] **Step 2: Run the new test and verify its pre-integration state**

Run: `npm test -- test/tab-focus-smart-group.browser.test.ts test/webview-open-state.test.ts test/tab-layout-sse.test.ts`

Expected: PASS if Tasks 1-6 fully wired the shipping scripts. If it fails, the failure must identify one already-specified requirement (menu toggle, rendering, keyboard activation, collapse, ordering, lifecycle, or layout isolation); return to that task's RED-GREEN cycle before proceeding. Do not weaken the browser assertion.

- [ ] **Step 3: Verify that the browser test exercises shipping behavior**

Confirm the harness uses the real `CodemanApp` prototype and shipping render/menu/coordinator methods. Stubs may supply external services such as the terminal, network PUT, and toasts, but must not replace `_projectTabLayout`, `_fullRenderSessionTabs`, `renderProjection`, `_tabRefFocusAction`, `setTabRefFocus`, `toggleTabGroupCollapsed`, keyboard handlers, or active/current update methods.

- [ ] **Step 4: Run lifecycle and Chromium tests and verify GREEN**

Run: `npm test -- test/tab-focus-smart-group.browser.test.ts test/webview-open-state.test.ts test/tab-layout-sse.test.ts test/tab-layout-service.test.ts`

Expected: all targeted lifecycle and real-browser tests pass.

- [ ] **Step 5: Register the browser test exclusion and commit**

Add `test/tab-focus-smart-group.browser.test.ts` to the CI exclusion list in `config/vitest.ci.config.ts`, then run `npm run check:browser-excludes` and commit:

```bash
git add -- config/vitest.ci.config.ts test/tab-focus-smart-group.browser.test.ts test/webview-open-state.test.ts test/tab-layout-sse.test.ts test/tab-layout-service.test.ts
git commit -m "test(tabs): COD-319 verify Focus lifecycle"
```

### Task 8: Cumulative verification, review, and Jira handoff

**Files:**

- No production changes unless a new failing regression test is written first.

- [ ] **Step 1: Run the complete focused regression bundle**

Run:

```bash
npm test -- test/tab-layout.test.ts test/tab-layout-service.test.ts test/routes/tab-layout-routes.test.ts test/tab-layout-browser.test.ts test/tab-layout-editing.test.ts test/tab-layout-app.test.ts test/webview-open-state.test.ts test/tab-layout-sse.test.ts test/tab-focus-smart-group.browser.test.ts
```

Expected: all listed files pass with zero failed tests.

- [ ] **Step 2: Run static and build gates**

Run each command separately and require exit 0:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run check:browser-excludes
npm run build
git diff --check
```

- [ ] **Step 3: Self-review against every design requirement**

Read `docs/superpowers/specs/2026-08-17-focus-smart-group-design.md` and verify: vertical-only smart group; one canonical stored ref; exact shortcut menu; local collapse; owner persistence/SSE; no duplicate numbering/traversal/lineage/drag/drop; closed webview retention; deletion pruning; idempotent no-bump operation; accessible keyboard behavior; and no legacy writer dropping `focus`.

- [ ] **Step 4: Request independent code review**

Use the requesting-code-review workflow against the branch diff from `953cfa83` to HEAD. Any Critical or Important finding must first receive a focused failing regression test, then a minimal fix and fresh verification.

- [ ] **Step 5: Commit review fixes and update Jira**

Commit any review-driven changes with a separate `fix(tabs): COD-319 ...` subject. Add a Jira comment containing branch, commit hashes, exact focused test counts, static/build results, and any known warning. Do not mark Done or deploy until landing and production verification are separately completed.
