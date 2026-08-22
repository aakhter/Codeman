# COD-358 Upstream Vertical Session Rail Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct Codeman's flat, resizable vertical session rail on current `upstream/master` without importing the
downstream tab-group model.

**Architecture:** Keep one `#sessionTabs` node and move it among the existing header, existing session sidebar, and new
vertical rail according to applied layout policy. Keep preferred device settings separate from viewport-constrained
effective layout, and preserve upstream's flat tab model while porting only the rail's presentation and interaction
dependencies.

**Tech Stack:** TypeScript/Zod, browser JavaScript, HTML/CSS, Vitest/JSDOM, Playwright Chromium, esbuild.

---

## Working Boundary and File Map

Execute from `/home/aakhter/.codeman/app/.worktrees/cod-358-upstream-vertical-rail` on branch
`cod-358-upstream-vertical-rail`, based on `upstream/master` at `88bb98de` or a later explicitly rebased upstream head.
Historical downstream commits are read-only behavioral references; do not cherry-pick them.

Core responsibilities:

- `src/web/public/constants.js`: pure orientation, width, and keyboard-resize policy.
- `src/web/public/tab-rail-resize.js`: DOM sizing, pointer/keyboard interaction, preferred-width persistence, and settled
  terminal resize.
- `src/web/public/settings-ui.js`: settings hydration/save and single-node orientation placement.
- `src/web/public/app.js`: startup ordering, flat full-label rendering, action placement, overflow suppression, sidebar
  ownership, and rename lifecycle.
- `src/web/public/index.html`: pre-paint orientation/font state, settings controls, rail, handle, and script wiring.
- `src/web/public/styles.css`: rail layout, complete-label clamp, rename override, action visibility, and responsive modal.
- `src/web/public/home-sessions.js`: duplicate homepage-navigation suppression.
- `src/web/public/session-lineage.js`: vertical gutter routing.
- `src/web/public/terminal-ui.js`: suppress generic ResizeObserver churn during an owned rail resize.
- `src/web/schemas.ts`: strict persisted setting validation.
- `scripts/build.mjs`: ship the new browser asset.
- Focused tests under `test/`: policy/DOM contracts and real Chromium geometry/interaction.

Do not add `src/tab-layout*.ts`, tab-layout routes, tab-group API calls, group markup, Focus groups, tree roles, group menus,
or grouped-rendering tests.

### Task 1: Add orientation policy and the single-node rail shell

**Files:**

- Modify: `src/web/public/constants.js`
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/settings-ui.js`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/schemas.ts`
- Create: `test/tab-orientation.test.ts`

- [ ] **Step 1: Write failing orientation policy and DOM-placement tests**

Add focused tests that evaluate `constants.js` in a VM and inspect the shipping markup/settings method:

```ts
expect(policy.resolveTabOrientation({ deviceType: 'desktop', setting: 'vertical' })).toBe('vertical');
expect(policy.resolveTabOrientation({ deviceType: 'tablet', setting: 'vertical' })).toBe('vertical');
expect(policy.resolveTabOrientation({ deviceType: 'mobile', setting: 'vertical' })).toBe('horizontal');
expect(policy.resolveTabOrientation({ deviceType: 'desktop', setting: 'sideways' })).toBe('horizontal');
expect(indexHtml).toContain('id="tabRail"');
expect(indexHtml.indexOf('id="tabRail"')).toBeLessThan(indexHtml.indexOf('id="terminalContainer"'));
expect(settingsJs).toMatch(/applyTabOrientation\(options = \{\}\)/);
expect(settingsJs).toContain('rail.appendChild(tabsEl)');
expect(settingsJs).toContain('headerHost.appendChild(tabsEl)');
```

- [ ] **Step 2: Run the test and confirm the missing policy/shell failure**

Run: `npm test -- test/tab-orientation.test.ts`

Expected: FAIL because `resolveTabOrientation`, `#tabRail`, and `applyTabOrientation()` do not exist.

- [ ] **Step 3: Implement the pure policy, schema, setting, markup, and placement**

Add this policy and export it through the existing `window.CodemanTabOverflow` object:

```js
function resolveTabOrientation(input) {
  if (!input || input.setting !== 'vertical') return 'horizontal';
  if (input.deviceType === 'mobile') return 'horizontal';
  return 'vertical';
}
```

Add `tabOrientation: z.enum(['horizontal', 'vertical']).optional()` to `SettingsUpdateSchema`; add a Horizontal/Vertical
select under App Settings → Layout → Tabs; default it to `horizontal`; and include it in the device display-key list.

Add an empty sibling rail before `#terminalContainer`:

```html
<aside class="tab-rail" id="tabRail" aria-label="Session navigation"></aside>
```

Implement `applyTabOrientation(options = {})` so the existing `#sessionTabs` node moves to `#tabRail` only when the
session-sidebar layout is inactive and effective orientation is vertical. Otherwise restore it to `#sessionTabsHost`.
Set `data-tab-orientation` and `aria-orientation` from that same resolved owner. On a real orientation change, clear stale
auto-wrap, refit xterm, rerender tabs, redraw connection lines, and refresh homepage visibility.

Call `applySessionListLayout()` first and `applyTabOrientation()` second during startup and settings application. In
`updateTabOverflowMode()`, remove `tabs-auto-wrap` and return when the applied orientation is vertical.

Add vertical rail CSS as a non-shrinking `.main` child with a vertical, scrollable `.session-tabs`; keep horizontal styles
unchanged and force the rail hidden in effective horizontal mode.

- [ ] **Step 4: Run orientation and existing layout tests**

Run:

```bash
npm test -- test/tab-orientation.test.ts test/session-list-layout.test.ts
```

Expected: both files PASS; sidebar mode still owns `#sessionTabs` ahead of the rail.

- [ ] **Step 5: Commit the orientation foundation**

```bash
git add src/web/public/constants.js src/web/public/index.html src/web/public/settings-ui.js src/web/public/app.js src/web/public/styles.css src/web/schemas.ts test/tab-orientation.test.ts
git commit -m "feat(tabs): COD-358 add vertical rail foundation"
```

### Task 2: Add resizable preferred-width behavior and complete labels

**Files:**

- Create: `src/web/public/tab-rail-resize.js`
- Modify: `src/web/public/constants.js`
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/settings-ui.js`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/terminal-ui.js`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/schemas.ts`
- Modify: `scripts/build.mjs`
- Create: `test/tab-rail-resize.test.ts`
- Create: `test/tab-rail-resize.browser.test.ts`

- [ ] **Step 1: Write failing pure-width, persistence, label, and breakpoint tests**

Cover fixed bounds and preferred/effective separation:

```ts
expect(policy.resolveWidth({ width: 100 })).toBe(208);
expect(policy.resolveWidth({ width: 999 })).toBe(360);
expect(policy.resolveWidth({ width: 360, viewportWidth: 700 })).toBe(280);
expect(policy.resolveWidth({ width: 360 })).toBe(360);
expect(railResizeJs).toContain('_scheduleTabRailSettle(resolved, preferred)');
expect(appJs).toContain('class="tab-name-prefix"');
expect(stylesCss).toMatch(/data-tab-orientation='vertical'[\s\S]{0,140}\.tab-name-prefix/);
```

Add a DOM/Chromium case that saves 360px, narrows until effective width is below 360px, widens again, and expects 360px
without another storage write. Add desktop → phone → desktop coverage that expects horizontal placement on phone and the
saved vertical orientation plus preferred width when desktop returns.

- [ ] **Step 2: Run the focused tests and confirm missing resize behavior**

Run: `npm test -- test/tab-rail-resize.test.ts test/tab-orientation.test.ts`

Expected: FAIL because width policy, asset wiring, handle markup, complete-prefix markup, and resize lifecycle are absent.

- [ ] **Step 3: Implement pure width policy**

Add and export these constants/functions:

```js
const TAB_RAIL_MIN_WIDTH = 208;
const TAB_RAIL_DEFAULT_WIDTH = 256;
const TAB_RAIL_MAX_WIDTH = 360;

function resolveTabRailWidth(input = {}) {
  const limits = [TAB_RAIL_MAX_WIDTH];
  if (Number.isFinite(Number(input.viewportWidth)) && Number(input.viewportWidth) > 0) {
    limits.push(Math.floor(Number(input.viewportWidth) * 0.4));
  }
  if (Number.isFinite(Number(input.mainWidth)) && Number.isFinite(Number(input.minTerminalWidth))) {
    limits.push(Math.floor(Number(input.mainWidth) - Number(input.minTerminalWidth)));
  }
  const effectiveMax = Math.max(TAB_RAIL_MIN_WIDTH, Math.min(...limits));
  const requested = Number.isFinite(Number(input.width)) ? Number(input.width) : TAB_RAIL_DEFAULT_WIDTH;
  return Math.round(Math.min(effectiveMax, Math.max(TAB_RAIL_MIN_WIDTH, requested)));
}
```

Add keyboard policy: Home=208, End=360, Enter=256, ArrowLeft/Right=8px, Shift+Arrow=32px, all passed through
`resolveTabRailWidth()`.

- [ ] **Step 4: Implement the resize controller without group actions**

Create `tab-rail-resize.js` as a `CodemanApp.prototype` mixin. It must:

```js
applyTabRailWidth(options = {}) {
  const settings = this.loadAppSettingsFromStorage();
  const requested = settings.tabRailWidth ?? window.CodemanTabRail.DEFAULT_WIDTH;
  const preferred = window.CodemanTabRail.resolveWidth({ width: requested });
  if (options.settle) this._claimTabRailResize();
  const effective = this._setTabRailWidth(preferred);
  if (options.persist !== false && requested !== preferred) this._persistTabRailWidth(preferred);
  if (options.settle) this._scheduleTabRailSettle(effective, preferred);
  return effective;
}
```

`_setTabRailWidth()` applies viewport/main/40-column constraints only to `--tab-rail-width`, ARIA values, and compact
state. `_scheduleTabRailSettle(effective, preferred)` persists `preferred`, never the temporary effective clamp. Pointer
drag uses capture plus a full-page shield, one animation-frame write, terminal-dimension rejection below 40 columns, and
one debounced `sendResize()`/`fit()` after settlement. Keyboard and double-click use the same policy. The window resize
handler reapplies both `applyTabOrientation()` and `applyTabRailWidth({ persist: false })`, so crossing device breakpoints
changes placement without changing the stored orientation or preferred width.

Do not copy the downstream group/search/action-menu additions from the current `local` version of this file. Reference
commit `1c8a50df` only for the original resize lifecycle.

- [ ] **Step 5: Wire settings, asset, handle, and terminal ownership**

Add `tabRailWidth: z.number().int().min(208).max(360).optional()`, default 256, display-key persistence, and preset options
208/256/320/360 plus a disabled custom label. Add `#tabRailResizeHandle` with separator role, horizontal orientation,
`aria-valuemin`, `aria-valuemax`, `aria-valuenow`, and keyboard focus. Add `#tabRailResizeShield` after `.main`.

Load `tab-rail-resize.js` after `app.js` and add it to `scripts/build.mjs`. Call `initTabRailResize()` after orientation but
before terminal creation. In the generic terminal ResizeObserver callback, return while `_tabRailResizeOwnsObserver` is
true so one drag does not create competing resize writes.

- [ ] **Step 6: Preserve complete generated labels in the flat renderer**

Keep `parseSessionPrefix(name)` and the full name tooltip, but render both pieces:

```js
const tabLabel = parsedName?.suffix
  ? `<span class="tab-name-prefix">${escapeHtml(parsedName.prefix)}: </span>${escapeHtml(parsedName.suffix)}`
  : escapeHtml(name);
```

Horizontal mode continues hiding `.tab-name-prefix`; vertical mode reveals it and allows the settled `.tab-name` to wrap
to two clamped lines. Apply the same markup in full and incremental render paths.

- [ ] **Step 7: Run unit and real-browser resize tests**

Run:

```bash
npm test -- test/tab-rail-resize.test.ts test/tab-orientation.test.ts
npm run test:file -- test/tab-rail-resize.browser.test.ts
```

Expected: policy/contract tests PASS; Chromium proves pointer/keyboard resize, preferred-width restoration, breakpoint
transitions, complete two-line labels, and one settled terminal resize.

- [ ] **Step 8: Commit resize and label behavior**

```bash
git add src/web/public/tab-rail-resize.js src/web/public/constants.js src/web/public/index.html src/web/public/settings-ui.js src/web/public/app.js src/web/public/terminal-ui.js src/web/public/styles.css src/web/schemas.ts scripts/build.mjs test/tab-rail-resize.test.ts test/tab-rail-resize.browser.test.ts test/tab-orientation.test.ts
git commit -m "feat(tabs): COD-358 resize vertical rail without losing preferences"
```

### Task 3: Suppress duplicate home navigation and route lineage vertically

**Files:**

- Modify: `src/web/public/home-sessions.js`
- Modify: `src/web/public/session-lineage.js`
- Modify: `src/web/public/constants.js`
- Modify: `src/web/public/styles.css`
- Modify: `test/home-sessions.test.ts`
- Modify: `test/session-lineage-lines.test.ts`

- [ ] **Step 1: Write failing home and lineage regressions**

```ts
document.documentElement.dataset.tabOrientation = 'vertical';
expect(app.shouldShowHomeSessions()).toBe(false);

expect(resolveLinePath({ orientation: 'vertical', parent, child })).toEqual(
  expect.objectContaining({ axis: 'y', gutterSide: 'right' })
);
```

Also assert horizontal mode retains the existing homepage and lineage behavior.

- [ ] **Step 2: Run the focused tests and confirm vertical cases fail**

Run: `npm test -- test/home-sessions.test.ts test/session-lineage-lines.test.ts`

Expected: existing cases PASS and the new vertical cases FAIL.

- [ ] **Step 3: Implement the two geometry gates**

In `shouldShowHomeSessions()`, return false when effective `data-tab-orientation` is vertical. Call the existing homepage
refresh after orientation changes and add a CSS visibility backstop for startup races.

Extend the pure lineage route helper with an explicit orientation input. For vertical tabs, anchor parent/child lines at
the tab rows' right gutter and route the shared segment vertically; preserve horizontal header routing byte-for-byte.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/home-sessions.test.ts test/session-lineage-lines.test.ts test/tab-orientation.test.ts`

Expected: all focused files PASS.

```bash
git add src/web/public/home-sessions.js src/web/public/session-lineage.js src/web/public/constants.js src/web/public/styles.css test/home-sessions.test.ts test/session-lineage-lines.test.ts
git commit -m "fix(tabs): COD-358 align home and lineage with vertical rail"
```

### Task 4: Preserve ownership and accessibility across settings refreshes

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `src/web/public/settings-ui.js`
- Modify: `test/session-list-layout.test.ts`

- [ ] **Step 1: Add failing owner-resolution tests**

Build the harness with `#sessionTabsHost`, `#sessionSidebarList`, and `#tabRail`, then assert:

```ts
app.applySessionListLayout();
expect(sessionTabs.parentElement).toBe(tabRail);
expect(sessionTabs.getAttribute('aria-orientation')).toBe('vertical');

settings.sessionListLayout = 'sidebar';
app.applySessionListLayout();
expect(sessionTabs.parentElement).toBe(sessionSidebarList);
expect(sessionTabs.getAttribute('aria-orientation')).toBe('vertical');
```

Add horizontal restoration and repeated asynchronous-refresh cases.

- [ ] **Step 2: Run and observe the refresh regression**

Run: `npm test -- test/session-list-layout.test.ts`

Expected: the new header+vertical refresh case FAILS because upstream moves the list back to the header host.

- [ ] **Step 3: Resolve owner and ARIA state atomically**

In `applySessionListLayout()`, choose owner in this order: active session sidebar; vertical rail when configured layout is
header and applied orientation is vertical; header host. Set `aria-orientation` from the chosen owner. Keep
`applyTabOrientation()` responsible for orientation-policy changes, but ensure both methods converge on the same owner.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- test/session-list-layout.test.ts test/tab-orientation.test.ts`

Expected: both files PASS.

```bash
git add src/web/public/app.js src/web/public/settings-ui.js test/session-list-layout.test.ts
git commit -m "fix(tabs): COD-358 preserve vertical rail ownership"
```

### Task 5: Neutralize the label clamp during inline rename

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `src/web/public/styles.css`
- Modify: `test/inline-rename.test.ts`

- [ ] **Step 1: Add failing Chromium rename-state coverage**

Use the production stylesheet and vertical rail ancestry. Start F2 rename on a prefixed session, type through
`page.keyboard.type()`, and assert:

```ts
expect(await input.inputValue()).toBe('edited title');
expect(await input.evaluate((node) => document.activeElement === node)).toBe(true);
expect(await label.evaluate((node) => node.classList.contains('tab-name-renaming'))).toBe(true);
expect(await input.evaluate((node) => node.getBoundingClientRect().width)).toBeGreaterThan(0);
```

After Enter, cancellation, API rejection, session deletion, and replacement by a second rename, assert
`tab-name-renaming` is absent and computed `-webkit-line-clamp` is `2` again.

- [ ] **Step 2: Run the focused browser test and confirm rename state is absent**

Run: `npm run test:file -- test/inline-rename.test.ts`

Expected: FAIL because the nested input remains inside the settled two-line clamp and no owned cleanup state exists.

- [ ] **Step 3: Implement rename ownership and vertical-only CSS**

Before installing the native input, add `tab-name-renaming` to that `.tab-name`. Use a settlement helper owned by the
specific rename instance; it removes the class on every exit and cannot let a late blur from an old input clear a newer
rename.

```css
html[data-tab-orientation='vertical'] .tab-rail .tab-name.tab-name-renaming {
  display: flex;
  -webkit-box-orient: initial;
  -webkit-line-clamp: unset;
  line-clamp: unset;
  overflow: visible;
}
html[data-tab-orientation='vertical'] .tab-name-renaming .tab-name-prefix {
  flex: 0 0 auto;
}
html[data-tab-orientation='vertical'] .tab-name-renaming .tab-rename-input {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
}
```

Preserve upstream Enter, Escape, IME composition, API, and rename persistence semantics.

- [ ] **Step 4: Verify and commit**

Run: `npm run test:file -- test/inline-rename.test.ts`

Expected: all inline-rename cases PASS in Chromium.

```bash
git add src/web/public/app.js src/web/public/styles.css test/inline-rename.test.ts
git commit -m "fix(tabs): COD-358 repaint vertical inline rename"
```

### Task 6: Add session-name density and restore expanded actions

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/settings-ui.js`
- Modify: `src/web/public/styles.css`
- Modify: `src/web/public/i18n.js`
- Modify: `src/web/schemas.ts`
- Create: `test/session-sidebar-ux.test.ts`
- Create: `test/session-sidebar-ux.browser.test.ts`

- [ ] **Step 1: Write failing schema, markup, and browser interaction tests**

```ts
for (const value of [11, 14, 18])
  expect(SettingsUpdateSchema.safeParse({ sessionSidebarFontSize: value }).success).toBe(true);
for (const value of [10, 19, 14.5, '14'])
  expect(SettingsUpdateSchema.safeParse({ sessionSidebarFontSize: value }).success).toBe(false);
```

In Chromium, cover expanded sidebar and expanded vertical rail: inactive trigger hidden at rest, visible on hover/focus,
active trigger visible, touch/coarse-pointer trigger visible, and click opens the existing action menu. Cover compact rail
and horizontal mode retaining the direct-child action cluster.

- [ ] **Step 2: Run focused tests and confirm missing density/action behavior**

Run: `npm test -- test/session-sidebar-ux.test.ts`

Expected: FAIL because the setting/schema and layout-aware action placement are absent.

- [ ] **Step 3: Implement the device-scoped font setting**

Add `sessionSidebarFontSize: z.number().int().min(11).max(18).optional()`, default 14, a range control from 11 through 18,
translated label/value text, pre-paint CSS variable hydration, settings save/hydration, and display-key persistence. Apply
the variable only to `.session-sidebar .tab-name` and vertical `.tab-rail .tab-name`; do not resize headings, chips,
badges, or icons.

- [ ] **Step 4: Implement layout-aware action placement**

Create a resolver that returns true only for expanded session sidebar or expanded non-compact vertical rail. Use one
`tabActionsHtml` string; insert it after `.tab-name` when inline, otherwise keep it as a direct child of `.session-tab`.
Rebuild rows whenever sidebar collapse or rail compact state changes.

Add nested `.tab-more` selectors scoped to expanded sidebar and expanded non-compact vertical rail for inactive-rest,
hover, focus-within, active, and coarse-pointer states. Preserve all direct-child selectors used by horizontal and compact
layouts. Do not add group actions or Move-to-Group items; the menu contains only actions already available upstream.

- [ ] **Step 5: Run structural and Chromium tests**

Run:

```bash
npm test -- test/session-sidebar-ux.test.ts
npm run test:file -- test/session-sidebar-ux.browser.test.ts
```

Expected: schema/contract and real computed-style/click tests PASS.

- [ ] **Step 6: Commit density and action restoration**

```bash
git add src/web/public/app.js src/web/public/index.html src/web/public/settings-ui.js src/web/public/styles.css src/web/public/i18n.js src/web/schemas.ts test/session-sidebar-ux.test.ts test/session-sidebar-ux.browser.test.ts
git commit -m "feat(nav): COD-358 size names and restore vertical actions"
```

### Task 7: Correct Session Options responsive layout

**Files:**

- Modify: `src/web/public/styles.css`
- Modify: `config/vitest.ci.config.ts`
- Modify: `test/session-options-structure.test.ts`
- Create: `test/session-options-responsive.browser.test.ts`

- [ ] **Step 1: Add failing structure and Chromium overflow cases**

At 974px, assert `#context-tab` has one column and its `scrollWidth === clientWidth`. At 1440px, assert the modal expands,
the panel has two `minmax(0, 1fr)` columns, heading/blurb span both, and no horizontal overflow.

- [ ] **Step 2: Run focused tests and confirm the 974px overflow**

Run:

```bash
npm test -- test/session-options-structure.test.ts
npm run test:file -- test/session-options-responsive.browser.test.ts
```

Expected: the new 974px Chromium geometry assertion FAILS under the current 680px viewport breakpoint.

- [ ] **Step 3: Make the document width authoritative**

Remove the old 680px two-column rule. Keep one column by default. At `min-width: 1200px`, widen only Session Options to
1120px and set `#context-tab { grid-template-columns: repeat(2, minmax(0, 1fr)); }`; make its heading and intro span both
tracks. Do not hide overflow or change other settings modals.

Register the browser file in the existing CI browser-test exclusion list.

- [ ] **Step 4: Verify and commit**

Run the same two commands from Step 2.

Expected: both files PASS at 974px and 1440px.

```bash
git add src/web/public/styles.css config/vitest.ci.config.ts test/session-options-structure.test.ts test/session-options-responsive.browser.test.ts
git commit -m "fix(settings): COD-358 contain responsive session options"
```

### Task 8: Release metadata and complete verification

**Files:**

- Create: `.changeset/cod-358-upstream-vertical-rail.md`
- Review: every file changed on `cod-358-upstream-vertical-rail`

- [ ] **Step 1: Add the user-facing changeset**

```md
---
'aicodeman': minor
---

Add an optional resizable vertical session rail with responsive layout, complete labels, accessible controls, and stable inline rename.
```

- [ ] **Step 2: Run all focused unit/DOM files together**

```bash
npm test -- test/tab-orientation.test.ts test/tab-rail-resize.test.ts test/home-sessions.test.ts test/session-lineage-lines.test.ts test/session-list-layout.test.ts test/session-sidebar-ux.test.ts test/session-options-structure.test.ts
```

Expected: every selected file PASS with zero failures.

- [ ] **Step 3: Run browser files individually**

```bash
npm run test:file -- test/tab-rail-resize.browser.test.ts
npm run test:file -- test/inline-rename.test.ts
npm run test:file -- test/session-sidebar-ux.browser.test.ts
npm run test:file -- test/session-options-responsive.browser.test.ts
```

Expected: each command PASS. Running individually preserves the managed-session safety boundary.

- [ ] **Step 4: Run repository gates**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
git diff --check upstream/master...HEAD
```

Expected: every command exits zero. Record any pre-existing warnings separately; do not describe warnings as clean output.

- [ ] **Step 5: Audit the upstream boundary**

```bash
git diff --name-only upstream/master...HEAD
git diff -U0 upstream/master...HEAD -- src test | rg 'tabGroup|tab-layout|Move to Group|Focus group'
```

Expected: only the files in this plan plus the changeset are present. The second command exits 1 with no matches because no
group model, persistence, route, menu, or tree semantics were introduced.

- [ ] **Step 6: Commit release metadata**

```bash
git add .changeset/cod-358-upstream-vertical-rail.md
git commit -m "chore: COD-358 document vertical rail foundation"
```

- [ ] **Step 7: Review before external delivery**

Use `superpowers:requesting-code-review`, resolve findings with `superpowers:receiving-code-review`, rerun the relevant
focused test after each correction, then repeat Task 8 Steps 2–5. Push only with:

```bash
git push -u origin cod-358-upstream-vertical-rail
```

Do not push to `upstream` or `fork`, and do not deploy this upstream-review branch to production.
