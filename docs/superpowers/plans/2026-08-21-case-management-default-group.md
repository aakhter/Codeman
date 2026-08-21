# Case Management Default Session Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the per-case default session group control from quick-start toolbar settings into the Case Management Edit Case flow.

**Architecture:** The existing owner-and-case persistence and launch precedence remain unchanged. Edit Case fetches the existing group value from the existing endpoint and includes an optional `defaultGroupId` in its normal case-update request; the case route validates it against the owner layout and writes it after the case's final name is determined. A shared Edit Case field avoids case-type-specific copies, while the former toolbar controls and handlers are removed.

**Tech Stack:** TypeScript, Fastify, Zod, browser JavaScript, Vitest, Playwright.

---

### Task 1: Extend the case update contract and route tests

**Files:**
- Modify: `src/web/schemas.ts:578-594`
- Modify: `src/web/routes/case-routes.ts:1398-1553`
- Test: `test/routes/case-routes.test.ts`

- [ ] **Step 1: Write failing route tests for a valid group, Ungrouped, renamed cases, and unknown group rejection.**

```ts
const response = await app.inject({
  method: 'PUT',
  url: '/api/cases/nzbdav',
  payload: { name: 'nzbdav-next', defaultGroupId: 'group-nzbdav' },
});
expect(response.statusCode).toBe(200);
expect(store.getCaseDefaultGroup(owner, 'nzbdav-next')).toBe('group-nzbdav');
expect(store.getCaseDefaultGroup(owner, 'nzbdav')).toBeUndefined();
```

```ts
const response = await app.inject({
  method: 'PUT',
  url: '/api/cases/nzbdav',
  payload: { defaultGroupId: 'missing-group' },
});
expect(response.statusCode).toBe(400);
expect(JSON.parse(response.body).error).toContain('Default group does not exist');
```

- [ ] **Step 2: Run the focused route test and confirm it fails because `defaultGroupId` is rejected or ignored.**

Run: `npm test -- test/routes/case-routes.test.ts`

Expected: failures for the new default-group update assertions.

- [ ] **Step 3: Add `defaultGroupId` as an optional nullable field and validate it once against the authoritative owner layout.**

```ts
defaultGroupId: z.string().min(1).max(100).nullable().optional(),
```

```ts
if (update.defaultGroupId !== undefined) {
  const snapshot = await ctx.tabLayouts.getSnapshot(owner);
  if (update.defaultGroupId !== null && !snapshot.layout.groups.some((group) => group.id === update.defaultGroupId)) {
    return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Default group does not exist');
  }
}
```

After each existing `renameCaseDefaultGroup(owner, originalName, nextName)` call, set the explicitly supplied value under `nextName`:

```ts
ctx.store.renameCaseDefaultGroup(owner, originalName, nextName);
if (update.defaultGroupId !== undefined) ctx.store.setCaseDefaultGroup(owner, nextName, update.defaultGroupId);
```

- [ ] **Step 4: Run the focused route test and confirm it passes.**

Run: `npm test -- test/routes/case-routes.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the route contract.**

```bash
git add src/web/schemas.ts src/web/routes/case-routes.ts test/routes/case-routes.test.ts
git commit -m "feat(cases): COD-343 save default group from case edit"
```

### Task 2: Move the UI to Edit Case

**Files:**
- Modify: `src/web/public/index.html:744-766,789-807,2948-3195`
- Modify: `src/web/public/session-ui.js:2434-2629,3939-4078`
- Test: `test/app-settings-structure.test.ts`

- [ ] **Step 1: Write failing structural assertions for one shared Edit Case select and the absence of both toolbar selects.**

```ts
expect(html).toContain('id="caseEditDefaultGroup"');
expect(html).not.toContain('id="caseDefaultGroup"');
expect(html).not.toContain('id="caseDefaultGroupMobile"');
expect(sessionUi).toContain('loadCaseEditDefaultGroup(name)');
expect(sessionUi).toContain('defaultGroupId: this._caseEditDefaultGroupId()');
```

- [ ] **Step 2: Run the structural test and confirm it fails.**

Run: `npm test -- test/app-settings-structure.test.ts`

Expected: failure until the Edit Case field and controller are added.

- [ ] **Step 3: Add the shared Edit Case selector and its request lifecycle.**

Place this field in the editable Case Management surface so it remains visible regardless of the selected local, linked-local, remote, or Docker edit tab:

```html
<label class="case-setting-field" for="caseEditDefaultGroup">
  <span>Default session group</span>
  <select id="caseEditDefaultGroup" disabled><option value="">Ungrouped</option></select>
</label>
<span class="form-hint">Place future sessions for this case in this group.</span>
```

On `editCase(name)`, reset and disable the select, fetch `GET /api/cases/:name/default-group`, populate group options, and enable it only for the current edit token. Include `defaultGroupId: select.value || null` in every `updatePayload`. Remove `toggleCaseSettings`, mobile equivalents, their HTML popovers, and their default-group handlers without affecting the unrelated Agent Teams and 1M context case settings.

- [ ] **Step 4: Run the structural test and confirm it passes.**

Run: `npm test -- test/app-settings-structure.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the UI move.**

```bash
git add src/web/public/index.html src/web/public/session-ui.js test/app-settings-structure.test.ts
git commit -m "feat(ui): COD-343 configure default group in case management"
```

### Task 3: Verify browser behavior and regressions

**Files:**
- Modify: `test/case-default-group-ui.browser.test.ts`
- Test: `test/routes/session-routes.test.ts`
- Test: `test/tab-layout-service.test.ts`

- [ ] **Step 1: Write browser coverage that opens Edit Case, loads the group list, changes it, submits the case form, and checks the `PUT /api/cases/:name` payload.**

```ts
await page.evaluate(() => (window as any).app.editCase('nzbdav'));
await expect.poll(() => page.locator('#caseEditDefaultGroup').inputValue()).toBe('group-tcc');
await page.selectOption('#caseEditDefaultGroup', 'group-nzbdav');
await page.evaluate(() => (window as any).app.updateCase());
await expect.poll(() => updateBodies).toContainEqual({ defaultGroupId: 'group-nzbdav', name: 'nzbdav' });
```

- [ ] **Step 2: Run the focused browser test and confirm it fails before the mocked Edit Case request path is implemented.**

Run: `npm test -- test/case-default-group-ui.browser.test.ts`

Expected: failure until the browser mock and edit controller use the new path.

- [ ] **Step 3: Update the browser fixture to mock the case-update request and assert error handling retains the edit modal and selected value.**

- [ ] **Step 4: Run all relevant focused tests.**

Run: `npm test -- test/case-default-group-ui.browser.test.ts test/routes/case-routes.test.ts test/routes/session-routes.test.ts test/tab-layout-service.test.ts test/app-settings-structure.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit verification coverage.**

```bash
git add test/case-default-group-ui.browser.test.ts
git commit -m "test: COD-343 cover case management default groups"
```

### Task 4: Final validation and delivery

**Files:**
- Verify: `src/web/schemas.ts`, `src/web/routes/case-routes.ts`, `src/web/public/index.html`, `src/web/public/session-ui.js`

- [ ] **Step 1: Run repository checks without the unsafe full test suite.**

Run: `npm run typecheck && npm run lint && npm run format:check && npm run check:lockfile`

Expected: all commands exit 0.

- [ ] **Step 2: Build the deployable bundle.**

Run: `npm run build`

Expected: exit 0 and refreshed `dist/` output.

- [ ] **Step 3: Inspect the staged diff and confirm unrelated files remain unstaged.**

Run: `git diff --check && git status --short`

Expected: only COD-343 implementation files are committed; pre-existing modifications to `src/session.ts`, `src/web/server.ts`, and `.superpowers/` are untouched.
