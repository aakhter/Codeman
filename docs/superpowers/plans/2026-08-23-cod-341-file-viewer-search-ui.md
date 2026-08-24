# COD-341 File Viewer Server Search UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the File Viewer's depth-limited client filter with debounced, session-safe rendering of the existing server-side file-search endpoint.

**Architecture:** Keep all runtime search and normal-tree state inside the existing File Viewer mixin, with independent monotonically increasing epochs for the two request classes and explicit ownership of the visible panel. Add narrow hooks at session selection and settings-driven panel hiding so no stale request can repaint or restore state for the wrong session, preference, query, or visibility generation.

**Tech Stack:** Browser JavaScript mixins, DOM APIs, Fetch API, TypeScript/Vitest VM-based frontend tests, Changesets.

---

## File map

- Create `test/file-browser-search.test.ts`: VM harness plus all search, ownership, epoch, control, and directory-navigation regression tests.
- Modify `src/web/public/panels-ui.js`: File Viewer state machine, tree/search request handling, rendering, navigation, resets, and control gating.
- Modify `src/web/public/app.js`: synchronously transfer File Viewer ownership immediately after `activeSessionId` changes.
- Modify `src/web/public/settings-ui.js`: use the shared File Viewer reset when settings hide the panel.
- Modify `test/file-browser-hidden.test.ts`: adapt the existing hidden-file tests to the owner-tagged tree state and forced reload contract.
- Create `.changeset/calm-files-search.md`: patch release note for the user-visible search behavior.

### Task 1: Build the search test harness and basic server-search behavior

**Files:**
- Create: `test/file-browser-search.test.ts`
- Modify: `src/web/public/panels-ui.js`

- [ ] **Step 1: Write failing debounce, URL, validation, rendering, and clear tests**

Create a VM-loaded `CodemanApp` harness modelled on `test/file-browser-hidden.test.ts`. Its fake elements must implement `innerHTML`, `textContent`, `value`, `disabled`, `classList.contains/add/remove/toggle`, `setAttribute`, and a controllable `querySelectorAll('.file-tree-item')`. Stub `fetch` with deferred responses and initialize the panel as visible with owner `session/A`, a ready normal tree, and fake timers.

Add concrete assertions equivalent to:

```ts
app.filterFileBrowser('src & docs');
await vi.advanceTimersByTimeAsync(249);
expect(requests).toHaveLength(0);
await vi.advanceTimersByTimeAsync(1);
expect(requests[0]).toBe('/api/sessions/session%2FA/files?depth=5&showHidden=false&q=src%20%26%20docs');

resolveSearch({
  success: true,
  data: {
    mode: 'search',
    matches: [
      { name: '<readme>.md', path: 'docs/<readme>.md', type: 'file', size: 12, extension: '.md' },
      { name: 'source', path: 'src/source', type: 'directory' },
    ],
    matchCount: 2,
    truncated: true,
  },
});
await flushPromises();
expect(elements.fileBrowserTree.innerHTML).toContain('&lt;readme&gt;.md');
expect(elements.fileBrowserTree.innerHTML).not.toContain('<readme>.md');
expect(elements.fileBrowserStatus.textContent).toBe('2 matches (truncated)');

app.filterFileBrowser(' '.repeat(3));
expect(elements.fileBrowserTree.innerHTML).toContain('cached.txt');
expect(requests).toHaveLength(1);
```

Cover one result/no results/truncation, preview and encoded download actions using the captured owner, 256 accepted characters, 257 rejected characters without fetch, non-2xx and unsuccessful envelopes, and strict rejection of wrong mode, non-array matches, invalid match fields, non-boolean `truncated`, and invalid `matchCount`.

- [ ] **Step 2: Run the new test file and verify red**

Run: `npm test -- test/file-browser-search.test.ts`

Expected: FAIL because `filterFileBrowser()` still renders the local cached tree and does not issue a debounced `q` request.

- [ ] **Step 3: Add lazy state initialization and basic search rendering**

In `panels-ui.js`, add `_ensureFileBrowserState()` that initializes exactly these concepts without constructor coupling:

```js
this.fileBrowserTreeEpoch ??= 0;
this.fileBrowserSearchEpoch ??= 0;
this.fileBrowserOwnerSessionId ??= this.activeSessionId || null;
this.fileBrowserView ??= 'normal';
this.fileBrowserNormalState ??= null;
this.fileBrowserTreeInFlight ??= null;
this.fileBrowserSearchMatches ??= [];
this.fileBrowserDeferredDirectory ??= null;
this.fileBrowserFilter ??= '';
```

Replace client filtering with a 250 ms debounce. Trim the query, increment `fileBrowserSearchEpoch` on every input, clear the deferred target, and handle these branches: blank switches to `normal` and renders compatible normal state; length over 256 switches to `query-error` and writes `Search queries are limited to 256 characters`; otherwise capture owner/hidden/query/epoch, switch through `search-pending`, fetch the encoded endpoint, strictly validate the full envelope, then render flat rows only if owner, active session, preference, exact input, epoch, and panel visibility remain current. On failure, render escaped `Search failed` without changing the normal cache.

Make `renderFileBrowserTree(sessionId = this.fileBrowserOwnerSessionId)` render the cached normal tree without `hasMatchingChild()` or `hidden-by-filter`, and bind preview/download actions to the supplied owner. Add `_renderFileBrowserSearchResults(matches, owner, data)` using the same row classes and output escaping. Use `textContent` for status strings.

- [ ] **Step 4: Run the basic search tests and existing route/search tests**

Run:

```bash
npm test -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts test/routes/file-search-mode.test.ts
```

Expected: PASS for debounce, URL construction, flat rendering, strict validation, clear restoration, and existing backend search behavior.

- [ ] **Step 5: Commit the basic search slice**

```bash
git add -- test/file-browser-search.test.ts src/web/public/panels-ui.js
git commit -m "feat(file-viewer): COD-341 search files via server"
```

### Task 2: Make normal-tree loads owner-tagged, epoch-safe, and deduplicated

**Files:**
- Modify: `test/file-browser-search.test.ts`
- Modify: `test/file-browser-hidden.test.ts`
- Modify: `src/web/public/panels-ui.js`

- [ ] **Step 1: Add failing tree ownership and request-race tests**

Add deferred-fetch tests that prove:

```ts
const first = app.loadFileBrowser('A');
const duplicate = app.loadFileBrowser('A');
expect(requests).toHaveLength(1);
expect(duplicate).toBe(first);

app.refreshFileBrowser();
expect(requests).toHaveLength(2);
resolveTree(0, treeFor('stale-A'));
await flushPromises();
expect(elements.fileBrowserTree.innerHTML).not.toContain('stale-A');

app.loadFileBrowser('A');
expect(requests).toHaveLength(2);
resolveTree(1, treeFor('fresh-A'));
await flushPromises();
expect(elements.fileBrowserTree.innerHTML).toContain('fresh-A');
```

Also cover overlapping A/B loads, A→B→A while the first A request is unresolved, clear before B settles, a compatible tree settling behind search without repainting it, a newer search invalidating only search responses, a new tree epoch invalidating only older tree responses, and stale completion compare-and-clear while a replacement remains pending. Update hidden-toggle expectations so toggles force a new tree epoch but preserve expanded directories.

- [ ] **Step 2: Run the focused frontend files and verify red**

Run: `npm test -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts`

Expected: FAIL because normal loads are not owner-tagged, epoch-gated, or deduplicated.

- [ ] **Step 3: Implement the normal-tree state machine**

Change `loadFileBrowser(sessionId, { force = false } = {})` to capture `sessionId`, `showHidden`, and a current or newly advanced tree epoch. Reuse an in-flight promise or settled state only when all three keys match. Immediately store `{ sessionId, showHidden, treeEpoch, phase: 'loading' }`; on completion store `ready` plus data or `error` plus a normalized message only if the captured keys remain current. Render that state only when `fileBrowserView === 'normal'` and the panel is visible.

Store the exact in-flight record:

```js
const record = { sessionId, showHidden, treeEpoch, promise: null };
record.promise = request.finally(() => {
  if (this.fileBrowserTreeInFlight === record) this.fileBrowserTreeInFlight = null;
});
this.fileBrowserTreeInFlight = record;
return record.promise;
```

Make refresh clear the input/search state, advance both epochs, clear expansions, and force-load the current owner. Ensure compatible normal `loading`, `ready`, and `error` phases have deterministic render helpers, and `fileBrowserData` mirrors only the compatible ready state for existing expand/collapse helpers.

- [ ] **Step 4: Run owner/race tests and direct existing tests**

Run:

```bash
npm test -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts test/routes/file-search-mode.test.ts
```

Expected: PASS, including request deduplication and stale-response suppression.

- [ ] **Step 5: Commit the state-machine slice**

```bash
git add -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts src/web/public/panels-ui.js
git commit -m "fix(file-viewer): COD-341 isolate tree and search ownership"
```

### Task 3: Wire session changes and both panel-hide paths

**Files:**
- Modify: `test/file-browser-search.test.ts`
- Modify: `src/web/public/panels-ui.js`
- Modify: `src/web/public/app.js`
- Modify: `src/web/public/settings-ui.js`

- [ ] **Step 1: Add failing integration tests for owner transfer and reset hooks**

Load the relevant `selectSession()` and `applyMonitorVisibility()` source in the VM or pin their executable call order with focused source assertions. Prove that after `activeSessionId = sessionId`, `_activateFileBrowserSession(sessionId)` is invoked before terminal replay awaits; an attempted query during B's delayed tree load targets B; terminal selection failure does not prevent B's load; the later idle callback deduplicates that load; close and settings-hide both call `_resetFileBrowserForHide()`; hide/reopen starts a fresh tree request and ignores the pre-hide tree/search responses.

Use assertions equivalent to:

```ts
expect(app.fileBrowserOwnerSessionId).toBe('B');
app.filterFileBrowser('needle');
await vi.advanceTimersByTimeAsync(250);
expect(requests.at(-1)).toContain('/api/sessions/B/files?');

app._resetFileBrowserForHide();
expect(app.fileBrowserView).toBe('normal');
expect(elements.fileBrowserSearch.value).toBe('');
expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
```

- [ ] **Step 2: Run the integration tests and verify red**

Run: `npm test -- test/file-browser-search.test.ts`

Expected: FAIL because session activation and settings-hide do not call shared File Viewer lifecycle hooks.

- [ ] **Step 3: Implement synchronous activation and shared hide reset**

Add `_activateFileBrowserSession(sessionId)` in the mixin. It must synchronously set the owner, increment both epochs, cancel debounce, clear the in-flight pointer, invalidate normal/search/deferred state, clear the input and row interaction, restore controls, and fire-and-forget `loadFileBrowser(sessionId)` only when the panel is visible.

Call it immediately after this assignment in `selectSession()`:

```js
this.activeSessionId = sessionId;
this._activateFileBrowserSession?.(sessionId);
```

Keep the later idle `loadFileBrowser(sessionId)` call unchanged so it exercises dedupe/reuse.

Add `_resetFileBrowserForHide()` to advance both epochs, cancel debounce, clear owner-bound state and input, restore Expand/Collapse, and clear the in-flight pointer. Call it from `closeFileBrowserPanel()` and immediately before `fileBrowserPanel.classList.remove('visible')` in the settings hide branch:

```js
this._resetFileBrowserForHide?.();
fileBrowserPanel.classList.remove('visible');
```

- [ ] **Step 4: Run integration and existing selection-related tests**

Run:

```bash
npm test -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts
npm run check:frontend-syntax
```

Expected: PASS with no browser JavaScript syntax errors.

- [ ] **Step 5: Commit the lifecycle wiring**

```bash
git add -- test/file-browser-search.test.ts src/web/public/panels-ui.js src/web/public/app.js src/web/public/settings-ui.js
git commit -m "fix(file-viewer): COD-341 reset search across lifecycle changes"
```

### Task 4: Complete hidden-toggle, controls, and directory-result navigation

**Files:**
- Modify: `test/file-browser-search.test.ts`
- Modify: `test/file-browser-hidden.test.ts`
- Modify: `src/web/public/panels-ui.js`

- [ ] **Step 1: Add failing edge-case tests**

Cover all of these explicit transitions: a valid query reruns only after the forced new-preference tree load wins; typing a newer query during that reload invalidates its continuation; two fast toggles invalidate the first; tree failure keeps the preference and stores normal error; a newer search remains visible over that error until clear; an overlength query never reruns but keeps `query-error` over the background load; Expand/Collapse is disabled and a no-op for every nonempty-query view.

Add ready/loading/error directory-result click tests. The ready case must recursively find the clicked directory and its ancestors in the cached tree, advance search epoch, cancel debounce, clear input/filter/matches/deferred state, switch to normal, restore the expand control, expand the full chain, and render. The loading case must retain results while storing `{ sessionId, showHidden, treeEpoch, searchEpoch, query, path }`, then transfer only if that exact load becomes ready and contains the path. Cover `/` and `\\` fixtures, absent directories, failed loads, and new input cancelling the deferred target.

- [ ] **Step 2: Run the frontend tests and verify red**

Run: `npm test -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts`

Expected: FAIL on hidden-toggle continuation, query-error persistence, control gating, and directory navigation.

- [ ] **Step 3: Implement the remaining transitions**

Make `toggleFileBrowserHidden()` persist and sync the new preference, capture the current trimmed query and search epoch, force-load the new normal tree, and rerun a valid query only when every captured owner/preference/tree/search/query/visibility value remains current. For invalid queries, keep `query-error`; for an empty query, keep normal ownership. If the forced tree load fails without a newer search owner, render the escaped normal error; otherwise leave it stored behind the newer search view.

Add `_syncFileBrowserExpandBtn()` and begin `toggleFileBrowserExpand()` with:

```js
if (this.fileBrowserFilter.trim()) return;
```

Set the button's `disabled` property whenever a nonempty query owns the panel.

Implement recursive `_findFileBrowserDirectory(nodes, targetPath, ancestors = [])` returning the matching node plus ancestor path list. Implement `_openFileBrowserSearchDirectory(path, capturedContext)` with the exact ready/loading/error behavior described in the design, and `_completeDeferredFileBrowserDirectory(state)` called only from the matching ready/error tree completion. All success transitions must call a single `_leaveFileBrowserSearchForDirectory(paths)` helper that explicitly clears every search field before rendering; no synthetic input events.

- [ ] **Step 4: Run the complete focused test set**

Run:

```bash
npm test -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts test/routes/file-search-mode.test.ts
```

Expected: PASS for all search, hidden toggle, lifecycle, control, directory, and backend endpoint regressions.

- [ ] **Step 5: Commit the completed interaction behavior**

```bash
git add -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts src/web/public/panels-ui.js
git commit -m "feat(file-viewer): COD-341 complete search navigation behavior"
```

### Task 5: Add release metadata and verify the upstream-sized diff

**Files:**
- Create: `.changeset/calm-files-search.md`

- [ ] **Step 1: Add the patch changeset**

Create exactly:

```markdown
---
"codeman": patch
---

Search the full session workspace from File Viewer while keeping results scoped to the active session and hidden-file preference.
```

- [ ] **Step 2: Run all focused and repository checks**

Run each command separately:

```bash
npm test -- test/file-browser-search.test.ts test/file-browser-hidden.test.ts test/routes/file-search-mode.test.ts
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run build
```

Expected: every command exits 0.

- [ ] **Step 3: Audit scope against the fetched upstream base**

Run:

```bash
git diff --check upstream/master...HEAD
git diff --stat upstream/master...HEAD
git diff --name-only upstream/master...HEAD
```

Expected changed paths: only `.changeset/calm-files-search.md`, `src/web/public/panels-ui.js`, `src/web/public/app.js`, `src/web/public/settings-ui.js`, `test/file-browser-search.test.ts`, and `test/file-browser-hidden.test.ts`. Confirm no backend route, matcher, HTML, CSS, generated bundle, or local design document is present.

- [ ] **Step 4: Commit release metadata or formatting-only corrections**

```bash
git add -- .changeset/calm-files-search.md src/web/public/panels-ui.js src/web/public/app.js src/web/public/settings-ui.js test/file-browser-search.test.ts test/file-browser-hidden.test.ts
git commit -m "chore: add COD-341 release note"
```

- [ ] **Step 5: Request final review before any push or pull request**

Provide the reviewer the upstream base SHA, branch head SHA, complete design requirements, focused verification output, and `git diff upstream/master...HEAD`. Resolve every actionable finding and rerun the affected focused test plus the full checks above before reporting the branch ready.
