# Focus-First Alt Numbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Alt/Option+1–9 switch through one stable Focus-first order while keeping Focus and ordinary group rendering unchanged.

**Architecture:** Extend the pure tab-layout projection with an `altRefs` list. In vertical mode it contains all renderable Focus refs first, followed by every canonical ref in group/ungrouped order with duplicates removed; in horizontal and fallback modes it matches the existing flat order. The app uses `altRefs` as the single source for both shortcut activation and badges, while suppressing the duplicate badge on a focused item's canonical row.

**Tech Stack:** Plain browser JavaScript, TypeScript Vitest tests, jsdom, existing `CodemanTabLayout` projection helpers.

---

## File map

- `src/web/public/tab-layout-browser.js`: derive and expose the unique `altRefs` projection and lookup helper.
- `src/web/public/app.js`: resolve Alt activation and rendered badges from `altRefs`; distinguish Focus shortcuts from canonical duplicates.
- `test/tab-layout-browser.test.ts`: pure ordering, collapse, deduplication, fallback, search, and nine-key lookup coverage.
- `test/tab-layout-app.test.ts`: shipping-controller DOM badge and activation coverage for focused sessions/webviews and collapsed groups.
- `test/keyboard-shortcuts.test.ts`: pin the shortcut dispatcher to the new `altRefs` source without changing physical-key behavior.

### Task 1: Derive one Focus-first shortcut projection

**Files:**

- Modify: `src/web/public/tab-layout-browser.js`
- Test: `test/tab-layout-browser.test.ts`

- [ ] **Step 1: Write failing projection tests**

Add assertions to the existing Focus projection test showing that focused `s2`, focused `w1`, and focused `s4` lead the shortcut order, while their canonical occurrences are skipped and collapsed canonical members still consume slots:

```ts
expect(result.altRefs).toEqual([
  { kind: 'session', id: 's2' },
  { kind: 'webview', id: 'w1' },
  { kind: 'session', id: 's4' },
  { kind: 'session', id: 's1' },
  { kind: 'session', id: 's3' },
  { kind: 'webview', id: 'w2' },
]);
```

Also assert that the same layout in horizontal mode has no Focus prefix:

```ts
expect(h.project(focused, { ...options, orientation: 'horizontal' }).altRefs).toEqual([
  { kind: 'session', id: 's2' },
  { kind: 'webview', id: 'w1' },
  { kind: 'session', id: 's1' },
  { kind: 'session', id: 's3' },
  { kind: 'webview', id: 'w2' },
  { kind: 'session', id: 's4' },
]);
```

Extend fallback and filtered-search expectations so every returned projection has an explicit `altRefs`. For search, expect the unique Focus-first order of matching refs only.

- [ ] **Step 2: Run the pure test and verify RED**

Run:

```bash
npm test -- test/tab-layout-browser.test.ts
```

Expected: failures report that `altRefs` is missing from project, fallback, and filtered projections.

- [ ] **Step 3: Add the unique-ref helper and projection field**

In `tab-layout-browser.js`, add a pure helper alongside `refKey`/`stableIds`:

```js
function uniqueRefs(refsInput) {
  const refs = [];
  const seen = new Set();
  for (const ref of Array.isArray(refsInput) ? refsInput : []) {
    if (!validRef(ref)) continue;
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind: ref.kind, id: ref.id });
  }
  return refs;
}
```

After `project()` has finished `focusRefs`, `completeRefs`, and `visibleRefs`, derive the shortcut projection without consulting collapse visibility:

```js
const altRefs = uniqueRefs(orientation === 'vertical' ? [...focusRefs, ...completeRefs] : visibleRefs);
```

Return `altRefs`. In `projectFallback()`, clone the flat `visibleRefs` into `altRefs`. In `filterSessionProjection()`, derive `altRefs` from the filtered `focusRefs` followed by filtered `visibleRefs`, so search results remain unique and Focus-first.

- [ ] **Step 4: Make Alt lookup identity-aware and limited to nine keys**

Replace the index-only helper with a lookup pair that keeps the public 1-based contract:

```js
function altNumberForRef(refs, target) {
  if (!validRef(target)) return null;
  const index = (Array.isArray(refs) ? refs : []).findIndex((ref) => refKey(ref) === refKey(target));
  return index >= 0 && index < 9 ? index + 1 : null;
}

function refAtAltNumber(refs, number) {
  if (!Number.isInteger(number) || number < 1 || number > 9) return null;
  const ref = Array.isArray(refs) ? refs[number - 1] : null;
  return validRef(ref) ? { kind: ref.kind, id: ref.id } : null;
}
```

Export `altNumberForRef` beside `refAtAltNumber`, and include `altRefs` in `structureKey()` so shortcut-only order changes invalidate cached DOM.

- [ ] **Step 5: Add lookup coverage for the ninth and tenth unique refs**

Update the existing Alt-number test to build ten unique refs and assert:

```ts
expect(h.altNumberForRef(refs, refs[0])).toBe(1);
expect(h.altNumberForRef(refs, refs[8])).toBe(9);
expect(h.altNumberForRef(refs, refs[9])).toBeNull();
expect(h.refAtAltNumber(refs, 9)).toEqual(refs[8]);
expect(h.refAtAltNumber(refs, 10)).toBeNull();
```

- [ ] **Step 6: Run the pure test and verify GREEN**

Run:

```bash
npm test -- test/tab-layout-browser.test.ts
```

Expected: the file passes with no failures.

- [ ] **Step 7: Commit the pure projection slice**

```bash
git add -- src/web/public/tab-layout-browser.js test/tab-layout-browser.test.ts
git commit -m "feat(tabs): COD-372 derive Focus-first Alt order"
```

### Task 2: Use `altRefs` for activation and every visible badge

**Files:**

- Modify: `src/web/public/app.js`
- Test: `test/tab-layout-app.test.ts`
- Test: `test/keyboard-shortcuts.test.ts`

- [ ] **Step 1: Write failing app-level Focus tests**

Create a focused layout in `test/tab-layout-app.test.ts` with focused session `s1` and focused saved web tab `w1`. Render it expanded and assert this DOM behavior:

```ts
const focusTabs = [...document.querySelectorAll<HTMLElement>('[data-tab-focus-shortcut]')];
expect(focusTabs.map((tab) => tab.dataset.focusSessionId || tab.dataset.focusWebviewId)).toEqual(['w1', 's1']);
expect(focusTabs.map((tab) => tab.querySelector('.tab-number')?.textContent)).toEqual(['1', '2']);

const canonical = [...document.querySelectorAll<HTMLElement>('.session-tab:not(.tab-focus-shortcut)')];
expect(canonical.map((tab) => tab.querySelector('.tab-number')?.textContent || null)).toEqual(['3', null, null, '4']);
```

The exact canonical identities must remain in the existing visual group order; only badges change.

Collapse Focus and the named group, rerender, and assert that hidden entries still consume their original numbers. The remaining visible ungrouped `s3` must keep badge `4`, not be renumbered to `1`.

Stub `selectSession` and `openWebview`, then assert Alt+1 opens focused `w1`, Alt+2 selects focused `s1`, Alt+3 selects canonical `s2`, and Alt+4 selects ungrouped `s3` even while groups are collapsed.

- [ ] **Step 2: Pin the shipping dispatcher to `projection.altRefs`**

In `test/keyboard-shortcuts.test.ts`, replace the old visible-projection assertion with:

```ts
expect(appSource).toContain('refAtAltNumber(projection.altRefs || projection.visibleRefs, number)');
```

Keep all physical `Digit1`–`Digit9`, macOS Option, and PTY-suppression assertions unchanged.

- [ ] **Step 3: Run the app and shortcut tests and verify RED**

Run:

```bash
npm test -- test/tab-layout-app.test.ts test/keyboard-shortcuts.test.ts
```

Expected: Focus rows have no badges and Alt activation still selects from `visibleRefs`.

- [ ] **Step 4: Add one badge-rendering helper**

Add an app method near `_renderFocusShortcut` that normalizes existing source markup before inserting the authoritative badge:

```js
_renderTabShortcutNumber(sourceHtml, number) {
  if (!sourceHtml) return '';
  const template = document.createElement('template');
  template.innerHTML = sourceHtml.trim();
  const tab = template.content.firstElementChild;
  if (!tab) return '';
  tab.querySelector('.tab-number')?.remove();
  if (Number.isInteger(number) && number >= 1 && number <= 9) {
    const badge = document.createElement('span');
    badge.className = 'tab-number';
    badge.textContent = String(number);
    const dragHandle = tab.querySelector('[data-tab-ref-drag]');
    if (dragHandle) dragHandle.insertAdjacentElement('afterend', badge);
    else tab.insertBefore(badge, tab.firstChild);
  }
  return tab.outerHTML;
}
```

Change `_renderFocusShortcut(ref, sourceHtml, number)` to perform its existing identity/action cleanup, remove any source badge, and insert `number` before returning. Focus shortcuts must retain no drag controls or duplicate element IDs.

- [ ] **Step 5: Render canonical and Focus copies from the same number map**

In `_fullRenderSessionTabs()`, build:

```js
const altRefs = projection.altRefs || projection.visibleRefs;
const focusedKeys = new Set((projection.focusRefs || []).map((ref) => `${ref.kind}:${ref.id}`));
const altNumber = (ref) => window.CodemanTabLayout.altNumberForRef(altRefs, ref);
```

Pass callbacks to `renderProjection()` so canonical focused duplicates receive `null`, canonical non-Focus rows receive their `altNumber(ref)`, and Focus shortcut rows receive their `altNumber(ref)`:

```js
((ref) =>
  this._renderTabShortcutNumber(
    renderedByRef.get(`${ref.kind}:${ref.id}`) || '',
    focusedKeys.has(`${ref.kind}:${ref.id}`) ? null : altNumber(ref)
  ),
  escapeHtml,
  (ref) => this._renderFocusShortcut(ref, renderedByRef.get(`${ref.kind}:${ref.id}`) || '', altNumber(ref)));
```

This leaves group/Focus DOM order under `renderProjection()` and makes numbering a presentation of the separate shortcut order.

- [ ] **Step 6: Switch activation and incremental repair to `altRefs`**

Change `_activateVisibleTabNumber()` to:

```js
const ref = window.CodemanTabLayout.refAtAltNumber(projection.altRefs || projection.visibleRefs, number);
```

In `_renderSessionTabsImmediate()`, replace the `visibleRefs.findIndex()` repair with `altNumberForRef()` and inject only the returned 1–9 number. The incremental path already excludes layouts with Focus refs; this change also preserves skipped numbers when a collapsed ordinary group hides earlier members.

- [ ] **Step 7: Run app, shortcut, and pure tests and verify GREEN**

Run:

```bash
npm test -- test/tab-layout-browser.test.ts test/tab-layout-app.test.ts test/keyboard-shortcuts.test.ts
```

Expected: all three files pass, including Focus sessions/webviews, duplicate suppression, collapse-stable numbering, horizontal fallback, and the nine-key limit.

- [ ] **Step 8: Commit app integration**

```bash
git add -- src/web/public/app.js test/tab-layout-app.test.ts test/keyboard-shortcuts.test.ts
git commit -m "feat(tabs): COD-372 number Focus shortcuts first"
```

### Task 3: Verify the complete issue result

**Files:**

- Verify: `src/web/public/tab-layout-browser.js`
- Verify: `src/web/public/app.js`
- Verify: `test/tab-layout-browser.test.ts`
- Verify: `test/tab-layout-app.test.ts`
- Verify: `test/keyboard-shortcuts.test.ts`

- [ ] **Step 1: Run the complete focused test gate**

```bash
npm test -- test/tab-layout-browser.test.ts test/tab-layout-app.test.ts test/keyboard-shortcuts.test.ts
```

Expected: all files and tests pass with zero failures.

- [ ] **Step 2: Run static checks**

```bash
npm run typecheck
npm run lint
npm run check:frontend-syntax
npm run check:lockfile
npx prettier --check src/web/public/tab-layout-browser.js src/web/public/app.js test/tab-layout-browser.test.ts test/tab-layout-app.test.ts test/keyboard-shortcuts.test.ts docs/superpowers/plans/2026-08-23-cod-372-focus-alt-numbering.md
```

Expected: every command exits zero.

- [ ] **Step 3: Build production assets**

```bash
npm run build
```

Expected: build exits zero; the known duplicate Chinese `Idle` translation warning may remain.

- [ ] **Step 4: Verify in an isolated browser instance**

Launch the worktree on isolated instance `cod372-verify`, data directory `/tmp/codeman-cod372-verify`, tmux socket `codeman-cod372-verify`, and port `5372`. Use Playwright against that instance to assert Focus badges begin at 1, canonical duplicates have no badge, collapsed items retain their slots, and Alt+1–9 selects the matching session/web tab. Capture zero uncaught page errors and terminate only the exact isolated process.

- [ ] **Step 5: Review the final diff**

```bash
git status --short
git diff local...HEAD --check
git diff --stat local...HEAD
```

Expected: only the planned source, test, and plan files are changed; `git diff --check` exits zero.
