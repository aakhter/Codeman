# COD-321 Vertical Inline Rename Paint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make typed title text paint immediately in the focused F2 rename editor when the session rail is vertical, without changing normal label clamping or rename persistence semantics.

**Architecture:** A transient `tab-name-renaming` class changes only the active vertical `.tab-name` from a clamped label into a flex editor. Rename settlement is instance-owned and restores the old DOM directly on cancellation, so incremental rendering and repeated F2 cannot retain the class or orphan an input. A real-Chromium regression drives native keyboard input inside the production tab ancestry and checks live value, focus, geometry, prefixed layout, and clamp restoration.

**Tech Stack:** Browser JavaScript, CSS, TypeScript, Vitest, Playwright Chromium

---

## File map

- Modify `test/inline-rename.test.ts`: add the vertical live-paint regression and strengthen re-entry cleanup coverage.
- Modify `src/web/public/session-ui.js`: own each rename settlement, apply/remove the transient class, restore cancelled DOM, and expose predictable prefix/input flex hooks.
- Modify `src/web/public/styles.css`: neutralize line clamping only for the active vertical editor and allocate prefix/input width safely.

### Task 1: Add failing browser regressions

**Files:**
- Modify: `test/inline-rename.test.ts`

- [ ] **Step 1: Add a production-shaped vertical live-input test**

Add a test that uses the real `#sessionTabs` container, vertical document state, and a prefixed session. It must type through Playwright instead of assigning `input.value`:

```ts
it('Vertical rail paints native typing inside an unclamped, visible rename editor', async () => {
  await resetState();
  await page.evaluate(() => {
    document.documentElement.dataset.tabOrientation = 'vertical';
    const app = (window as unknown as {
      app: {
        sessions: Map<string, { id: string; name: string; status: string }>;
        sessionOrder: string[];
        startInlineRename: (id: string) => void;
      };
    }).app;
    const id = 'vertical-live-input';
    app.sessions.set(id, { id, name: 'w9-case: old', status: 'idle' });
    app.sessionOrder = [id];
    const container = document.getElementById('sessionTabs') as HTMLElement;
    const tab = document.createElement('div');
    tab.dataset.testTab = '1';
    tab.className = 'session-tab';
    tab.dataset.id = id;
    tab.innerHTML =
      '<span class="tab-info"><span class="tab-name-row">' +
      `<span class="tab-name" data-session-id="${id}">w9-case: old</span>` +
      '</span></span>';
    container.appendChild(tab);
    app.startInlineRename(id);
  });

  const input = page.locator('input.tab-rename-input');
  await input.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('visible title');

  const live = await page.evaluate(() => {
    const input = document.querySelector('input.tab-rename-input') as HTMLInputElement;
    const name = input.closest('.tab-name') as HTMLElement;
    const prefix = input.previousElementSibling as HTMLElement;
    const inputRect = input.getBoundingClientRect();
    const nameRect = name.getBoundingClientRect();
    const prefixRect = prefix.getBoundingClientRect();
    return {
      focused: document.activeElement === input,
      value: input.value,
      classActive: name.classList.contains('tab-name-renaming'),
      clamp: getComputedStyle(name).webkitLineClamp,
      inputWidth: inputRect.width,
      inputHeight: inputRect.height,
      prefixWidth: prefixRect.width,
      insideLeft: inputRect.left >= nameRect.left,
      insideRight: inputRect.right <= nameRect.right + 0.5,
    };
  });

  expect(live).toMatchObject({
    focused: true,
    value: 'visible title',
    classActive: true,
    clamp: 'none',
    insideLeft: true,
    insideRight: true,
  });
  expect(live.inputWidth).toBeGreaterThan(0);
  expect(live.inputHeight).toBeGreaterThan(0);
  expect(live.prefixWidth).toBeGreaterThan(0);

  await page.evaluate(() => {
    const app = (window as unknown as { app: { _activeRename: { cancel: () => void } } }).app;
    app._activeRename.cancel();
  });
  const settled = await page.evaluate(() => {
    const name = document.querySelector('.tab-name[data-session-id="vertical-live-input"]') as HTMLElement;
    return {
      classActive: name.classList.contains('tab-name-renaming'),
      inputPresent: !!name.querySelector('input'),
      clamp: getComputedStyle(name).webkitLineClamp,
    };
  });
  expect(settled).toEqual({ classActive: false, inputPresent: false, clamp: '2' });
});
```

- [ ] **Step 2: Strengthen the existing settlement tests**

In `Commit writes the confirmed name...`, return the settled label class state with the map value:

```ts
return {
  mapName: app.sessions.get('no-sse')?.name ?? null,
  classActive: document
    .querySelector('.tab-name[data-session-id="no-sse"]')
    ?.classList.contains('tab-name-renaming'),
};
```

Assert the map name is `w9-case: fresh` and `classActive` is false.

In `A rejected rename restores...`, add the same `classActive` field for `rename-500` and assert it is false. This proves the API-failure branch restores the ordinary label contract.

Capture both name nodes and assert that starting the second rename synchronously removes the first input/class while leaving only the second editor active:

```ts
return {
  firstActive,
  secondActive: app._activeRename?.sessionId,
  firstHasInput: !!document.querySelector('.tab-name[data-session-id="first-id"] input'),
  firstHasRenameClass: document
    .querySelector('.tab-name[data-session-id="first-id"]')
    ?.classList.contains('tab-name-renaming'),
  secondHasInput: !!document.querySelector('.tab-name[data-session-id="second-id"] input'),
};
```

Assert `firstHasInput` and `firstHasRenameClass` are false and `secondHasInput` is true.

- [ ] **Step 3: Run the focused suite and verify RED**

Run: `npm test -- test/inline-rename.test.ts`

Expected: FAIL because the live vertical editor lacks `tab-name-renaming`, retains a clamp of `2`, and re-entry leaves the first input behind. Existing tests should otherwise pass.

- [ ] **Step 4: Commit the failing regression**

```bash
git add -- test/inline-rename.test.ts
git commit -m "test: COD-321 cover vertical rename painting"
```

### Task 2: Implement instance-owned rename presentation and cleanup

**Files:**
- Modify: `src/web/public/session-ui.js:1900-1995`
- Modify: `src/web/public/styles.css:848-859`
- Test: `test/inline-rename.test.ts`

- [ ] **Step 1: Pre-empt an existing valid rename and apply editor hooks**

After validating the requested session and `.tab-name`, synchronously cancel any current rename, then prepare the selected label:

```js
this._activeRename?.cancel();
this._inlineRenameActive = true;
tabName.classList.add('tab-name-renaming');
```

Give the generated prefix a stable class:

```js
prefixLabel.className = 'tab-rename-prefix';
```

Use `auto` width in the sidebar because flex sizing will own the available space:

```js
const renameWidth = this.isSessionSidebarActive?.() ? 'auto' : '80px';
```

- [ ] **Step 2: Make settlement local, idempotent, and DOM-complete**

Replace the global-only double-fire guard with a local settled flag and handle identity. Cancellation must restore `originalContent` immediately before scheduling a canonical render:

```js
let settled = false;
let renameHandle = null;
const finishRename = async ({ commit }) => {
  if (settled) return;
  settled = true;
  tabName.classList.remove('tab-name-renaming');

  const ownsActiveRename = this._activeRename === renameHandle;
  if (ownsActiveRename) {
    this._inlineRenameActive = false;
    this._activeRename = null;
  }

  if (!commit) {
    tabName.textContent = originalContent;
    if (ownsActiveRename) this.renderSessionTabs();
    return;
  }

  const suffix = input.value.trim();
  const fullName = parsed ? parsed.prefix + (suffix ? ': ' + suffix : '') : suffix;
  tabName.textContent = fullName || originalContent;

  const stillExists = this.sessions.has(sessionId);
  if (stillExists && fullName !== session.name) {
    const confirmed = await this._putSessionName(sessionId, fullName);
    if (confirmed === null) {
      tabName.textContent = originalContent;
      this.showToast('Failed to rename', 'error');
    } else {
      this._applyLocalSessionName(sessionId, confirmed);
    }
  }
  if (ownsActiveRename) this.renderSessionTabs();
};

renameHandle = {
  sessionId,
  cancel: () => finishRename({ commit: false }),
};
this._activeRename = renameHandle;
```

Keep the existing IME, Enter, and Escape listeners unchanged. Only the owning handle may clear shared state or schedule a render; a late event from a settled old input becomes a no-op.

- [ ] **Step 3: Add the vertical rename-state CSS**

Place these rules directly after the ordinary vertical `.tab-name` clamp rule:

```css
html[data-tab-orientation='vertical'] .tab-rail .session-tab .tab-name.tab-name-renaming {
  display: flex;
  align-items: center;
  -webkit-line-clamp: unset;
  line-clamp: unset;
}

html[data-tab-orientation='vertical'] .tab-name-renaming .tab-rename-prefix {
  flex: 0 0 auto;
}

html[data-tab-orientation='vertical'] .tab-name-renaming .tab-rename-input {
  flex: 1 1 0;
  width: auto;
  min-width: 0;
}
```

- [ ] **Step 4: Run the focused suite and verify GREEN**

Run: `npm test -- test/inline-rename.test.ts`

Expected: PASS, including native typing, prefix geometry, explicit cancellation cleanup, clamp restoration, and re-entry.

- [ ] **Step 5: Run targeted static checks**

Run: `node --check src/web/public/session-ui.js`

Expected: exit 0.

Run: `npx prettier --check src/web/public/session-ui.js src/web/public/styles.css test/inline-rename.test.ts`

Expected: all three files pass formatting.

- [ ] **Step 6: Commit the implementation**

```bash
git add -- src/web/public/session-ui.js src/web/public/styles.css
git commit -m "fix(tabs): COD-321 repaint vertical inline rename"
```

### Task 3: Verify the complete change

**Files:**
- Verify: `src/web/public/session-ui.js`
- Verify: `src/web/public/styles.css`
- Verify: `test/inline-rename.test.ts`

- [ ] **Step 1: Run focused and related frontend tests**

Run: `npm test -- test/inline-rename.test.ts`

Expected: all inline-rename tests pass.

Run: `npm test -- test/tab-layout-editing.test.ts test/mobile/tabs.test.ts`

Expected: every selected test passes.

- [ ] **Step 2: Run repository quality gates**

Run each command separately:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 3: Inspect the final diff and worktree**

Run:

```bash
git diff origin/local...HEAD --check
git diff origin/local...HEAD --stat
git status --short
```

Expected: no whitespace errors; only the design, plan, focused test, JavaScript, and CSS are changed; the worktree is clean.

- [ ] **Step 4: Perform an isolated vertical browser check**

Run the isolated Playwright check, whose `WebServer` fixture binds test-only port 3164 and does not create a PTY/tmux session:

`npm test -- test/inline-rename.test.ts -t "Vertical rail paints native typing"`

Expected: PASS; native keyboard input retains its live value and visible geometry before settlement, the prefix has width, cancellation restores clamp `2`, and no production process, port, or runtime file is changed.

- [ ] **Step 5: Record verification for review**

Post the exact commands/results and the browser observation to COD-321. Do not transition the Jira issue to Done until the branch is landed in the project integration branch.
