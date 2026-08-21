# COD-343 Per-Case Default Session Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each owner choose an existing vertical-rail group or Ungrouped as the server-authoritative default destination for future sessions in one case.

**Architecture:** Persist an owner-and-case map in `StateStore`, expose it through authenticated case routes, and resolve it inside the existing owner-locked `TabLayoutService.sessionCreated()` transaction. Desktop and mobile Case Settings load and save the shared value, while session creation preserves explicit-group and parent-lineage precedence and returns the authoritative final layout before rendering.

**Tech Stack:** TypeScript ESM, Fastify, Zod, plain browser JavaScript/HTML/CSS, Vitest, Playwright Chromium, StateStore JSON persistence.

---

### Task 1: Persist owner-and-case defaults

**Files:**

- Modify: `src/types/app-state.ts`
- Modify: `src/state-store.ts`
- Modify: `test/mocks/mock-route-context.ts`
- Test: `test/state-store.test.ts`
- Test: `test/tab-layout-persistence.test.ts`

- [x] **Step 1: Write failing StateStore tests**

Add focused cases that distinguish an unset value from intentional Ungrouped and prove owner isolation, rename/delete lifecycle, and restart persistence:

```ts
expect(store.getCaseDefaultGroup('alice', 'nzbdav')).toBeUndefined();
store.setCaseDefaultGroup('alice', 'nzbdav', 'group-nzbdav');
store.setCaseDefaultGroup('bob', 'nzbdav', null);
expect(store.getCaseDefaultGroup('alice', 'nzbdav')).toBe('group-nzbdav');
expect(store.getCaseDefaultGroup('bob', 'nzbdav')).toBeNull();

store.renameCaseDefaultGroup('alice', 'nzbdav', 'nzbdav-next');
expect(store.getCaseDefaultGroup('alice', 'nzbdav')).toBeUndefined();
expect(store.getCaseDefaultGroup('alice', 'nzbdav-next')).toBe('group-nzbdav');

store.deleteCaseDefaultGroup('alice', 'nzbdav-next');
expect(store.getCaseDefaultGroup('alice', 'nzbdav-next')).toBeUndefined();
```

In the persistence test, flush and reconstruct `StateStore`, then assert the serialized `caseDefaultGroups` field and reloaded accessor value.

- [x] **Step 2: Run tests and verify RED**

```bash
npm test -- test/state-store.test.ts test/tab-layout-persistence.test.ts
```

Expected: TypeScript/runtime failures because `caseDefaultGroups` and the four accessors do not exist.

- [x] **Step 3: Add the AppState field and serialization allowlist entry**

Add this optional backward-compatible field:

```ts
/** Owner-and-case scoped default session group. null means intentional Ungrouped. */
caseDefaultGroups?: Record<string, Record<string, string | null>>;
```

Add the hand-written `assembleStateJson()` entry immediately after `tabLayouts`:

```ts
if (this.state.caseDefaultGroups !== undefined) {
  parts.push(`"caseDefaultGroups":${JSON.stringify(this.state.caseDefaultGroups)}`);
}
```

- [x] **Step 4: Add typed StateStore accessors**

Route schemas enforce the case-name and group-ID bounds before these accessors are called. Clone each changed level
before saving:

```ts
getCaseDefaultGroup(owner: string, caseName: string): string | null | undefined {
  return this.state.caseDefaultGroups?.[owner]?.[caseName];
}

setCaseDefaultGroup(owner: string, caseName: string, groupId: string | null): void {
  const ownerDefaults = { ...(this.state.caseDefaultGroups?.[owner] ?? {}), [caseName]: groupId };
  this.state.caseDefaultGroups = { ...(this.state.caseDefaultGroups ?? {}), [owner]: ownerDefaults };
  this.save();
}

renameCaseDefaultGroup(owner: string, fromCase: string, toCase: string): void {
  const current = this.getCaseDefaultGroup(owner, fromCase);
  if (current === undefined || fromCase === toCase) return;
  const ownerDefaults = { ...(this.state.caseDefaultGroups?.[owner] ?? {}) };
  delete ownerDefaults[fromCase];
  ownerDefaults[toCase] = current;
  this.state.caseDefaultGroups = { ...(this.state.caseDefaultGroups ?? {}), [owner]: ownerDefaults };
  this.save();
}

deleteCaseDefaultGroup(owner: string, caseName: string): void {
  const existing = this.state.caseDefaultGroups?.[owner];
  if (!existing || !(caseName in existing)) return;
  const ownerDefaults = { ...existing };
  delete ownerDefaults[caseName];
  this.state.caseDefaultGroups = { ...(this.state.caseDefaultGroups ?? {}), [owner]: ownerDefaults };
  this.save();
}
```

Add matching mocks to `createMockRouteContext().store`.

- [x] **Step 5: Verify GREEN and commit**

```bash
npm test -- test/state-store.test.ts test/tab-layout-persistence.test.ts
git diff --check
git add src/types/app-state.ts src/state-store.ts test/mocks/mock-route-context.ts \
  test/state-store.test.ts test/tab-layout-persistence.test.ts
git commit -m "feat(state): COD-343 persist case group defaults"
```

Expected: both focused files pass and the commit contains only persistence/mocks/tests.

### Task 2: Add authenticated case-default APIs and lifecycle cleanup

**Files:**

- Modify: `src/web/schemas.ts`
- Modify: `src/web/routes/case-routes.ts`
- Test: `test/routes/case-routes.test.ts`

- [x] **Step 1: Write failing route tests**

Extend the case-route harness with an owner layout containing `group-nzbdav` and `group-tcc`. Add assertions for:

```ts
const read = await app.inject({ method: 'GET', url: '/api/cases/nzbdav/default-group' });
expect(read.json().data).toEqual({
  groupId: 'group-nzbdav',
  groups: [
    { id: 'group-nzbdav', name: 'nzbdav' },
    { id: 'group-tcc', name: 'tcc' },
  ],
});

const save = await app.inject({
  method: 'PUT',
  url: '/api/cases/nzbdav/default-group',
  payload: { groupId: null },
});
expect(save.statusCode).toBe(200);
expect(ctx.store.setCaseDefaultGroup).toHaveBeenCalledWith('@single', 'nzbdav', null);
```

Also test unknown group rejection without a store write, inaccessible/unknown case behavior, owner scoping, stale stored-ID clearing, case rename migration, and local/remote/Docker deletion cleanup.

- [x] **Step 2: Run the route file and verify RED**

```bash
npm test -- test/routes/case-routes.test.ts
```

Expected: 404 for the new endpoint or missing schema/store calls.

- [x] **Step 3: Add the request schema and route capability**

In `schemas.ts` add:

```ts
export const CaseDefaultGroupSchema = z.object({
  groupId: z.string().min(1).max(100).nullable(),
});
```

Import the existing `TabLayoutPort` and add it to the case-route context intersection:

```ts
export function registerCaseRoutes(
  app: FastifyInstance,
  ctx: EventPort & ConfigPort & SessionPort & TabLayoutPort
): void {
```

`TabLayoutPort` already exposes the full `TabLayoutService`; do not modify or narrow that interface.

- [x] **Step 4: Extract one accessible-case resolver**

Refactor the existing `GET /api/cases/:name` lookup into a route-local helper that returns `CaseInfo | null` for the authenticated request. It must preserve current local, linked-local, remote, Docker, admin, and multi-user behavior. Reuse it for the existing detail endpoint and both new default-group endpoints; do not duplicate ownership rules.

The helper signature is:

```ts
async function resolveAccessibleCase(req: FastifyRequest, name: string): Promise<CaseInfo | null>;
```

Invalid names still return `INVALID_INPUT`; a valid but inaccessible or absent name returns `NOT_FOUND` without disclosing foreign metadata.

- [x] **Step 5: Implement GET and PUT endpoints**

Use the authenticated layout owner and authoritative layout:

```ts
const owner = ownerLayoutKey(ownerFor(req));
const snapshot = await ctx.tabLayouts.getSnapshot(owner);
const groups = snapshot.layout.groups.map(({ id, name }) => ({ id, name }));
let groupId = ctx.store.getCaseDefaultGroup(owner, name);
if (typeof groupId === 'string' && !groups.some((group) => group.id === groupId)) {
  ctx.store.setCaseDefaultGroup(owner, name, null);
  groupId = null;
}
return { groupId: groupId ?? null, groups };
```

For PUT, parse `CaseDefaultGroupSchema`, reject a non-null ID absent from the current layout, persist the value, and return the same `{ groupId, groups }` shape.

- [x] **Step 6: Wire case rename and deletion**

After each successful local/linked/remote/Docker rename branch, call:

```ts
ctx.store.renameCaseDefaultGroup(ownerLayoutKey(ownerFor(req)), originalName, nextName);
```

After each successful local unlink/delete, remote unlink, and Docker delete branch, call:

```ts
ctx.store.deleteCaseDefaultGroup(ownerLayoutKey(ownerFor(req)), name);
```

Do not clear/migrate before the underlying case operation succeeds.

- [x] **Step 7: Verify GREEN and commit**

```bash
npm test -- test/routes/case-routes.test.ts test/ownership-scoping.test.ts
npm run typecheck
git diff --check
git add src/web/schemas.ts src/web/routes/case-routes.ts test/routes/case-routes.test.ts
git commit -m "feat(cases): COD-343 expose default group settings"
```

Expected: route and ownership tests pass with no foreign-group disclosure.

### Task 3: Apply the default inside the authoritative creation transaction

**Files:**

- Modify: `src/web/ports/session-port.ts`
- Modify: `src/web/server.ts`
- Modify: `src/tab-layout-service.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/web/public/session-ui.js`
- Test: `test/tab-layout-service.test.ts`
- Test: `test/routes/session-routes.test.ts`
- Test: `test/routes/session-routes-parent-lineage.test.ts`
- Test: `test/run-mode-ui.test.ts`

- [x] **Step 1: Write failing service precedence tests**

Extend the TabLayoutService harness store with case-default get/set spies. Cover these exact outcomes:

```ts
await service.sessionCreated('alice', 'root', { caseName: 'nzbdav' });
expect(locationOf(await service.get('alice'), 'root').groupId).toBe('group-nzbdav');

await service.sessionCreated('alice', 'explicit', {
  caseName: 'nzbdav',
  tabGroupId: 'group-tcc',
});
expect(locationOf(await service.get('alice'), 'explicit').groupId).toBe('group-tcc');

await service.sessionCreated('alice', 'child', { caseName: 'nzbdav' });
expect(locationOf(await service.get('alice'), 'child').groupId).toBe('parent-group');
```

Assert a case-default ref is not `placement: 'manual'`, an explicit ref is manual, `null` produces Ungrouped, and a deleted default is cleared then produces Ungrouped. Retain the existing rollback and concurrent-creation cases.

- [x] **Step 2: Write failing route/client propagation tests**

In `session-routes.test.ts`, require both endpoints to call:

```ts
expect(ctx.addSession).toHaveBeenCalledWith(expect.any(Session), {
  caseName: 'nzbdav',
});
```

and preserve `{ caseName: 'nzbdav', tabGroupId: 'group-tcc' }` for explicit placement. Require a case-default placement snapshot to be returned as `tabLayout`/`tabPlacements` even without request `tabGroupId`.

In `run-mode-ui.test.ts`, require local Claude and Shell bodies to contain `caseName: 'launch-case'`, and retain the existing matrix proving all seven modes plus remote/Docker routes carry the case name.

- [x] **Step 3: Run focused tests and verify RED**

```bash
npm test -- test/tab-layout-service.test.ts test/routes/session-routes.test.ts \
  test/routes/session-routes-parent-lineage.test.ts test/run-mode-ui.test.ts
```

Expected: signature/expectation failures because case identity and default resolution are not wired.

- [x] **Step 4: Replace the positional placement argument with shared typed hints**

Define the core hint beside `TabLayoutSnapshot` in `tab-layout-service.ts`:

```ts
export interface SessionPlacementHints {
  tabGroupId?: string;
  caseName?: string;
}
```

In `session-port.ts`, import that core type and expose it to route contexts without making the core service depend on
the web layer:

```ts
import type { SessionPlacementHints, TabLayoutSnapshot } from '../../tab-layout-service.js';
export type SessionCreationOptions = SessionPlacementHints;
```

Update `TabLayoutService.sessionCreated()` to accept the same object before the registration callback:

```ts
async sessionCreated(
  owner: string,
  sessionId: string,
  options: SessionPlacementHints = {},
  register?: RegisterTabLayoutSession
): Promise<TabLayoutSnapshot>
```

Update `server.ts` so `addSession(session, options)` forwards the whole options object inside the existing rollback registration transaction.

- [x] **Step 5: Resolve precedence under the owner lock**

Extend the service's store dependency pick with `getCaseDefaultGroup` and `setCaseDefaultGroup` so all default reads,
stale clears, and layout mutations occur under the same owner queue.

After reconciliation, determine whether the new session has an eligible, visible owner-valid parent already represented in the candidate layout. Resolve a target only when appropriate:

```ts
const explicitGroup = options.tabGroupId
  ? candidate.groups.find((group) => group.id === options.tabGroupId)
  : undefined;
const storedDefault = options.caseName ? this.deps.store.getCaseDefaultGroup(owner, options.caseName) : undefined;
const defaultGroup =
  typeof storedDefault === 'string' ? candidate.groups.find((group) => group.id === storedDefault) : undefined;
const targetGroup = explicitGroup ?? (!hasEligibleParent ? defaultGroup : undefined);
const placementSource = explicitGroup ? 'explicit' : targetGroup === defaultGroup ? 'case-default' : undefined;
```

If `storedDefault` is a string but `defaultGroup` is absent, clear it to `null`. Reuse the existing descendant-block move. Keep `placement: 'manual'` for explicit moves; after a default move, remove only the created ref's `placement` field while preserving its other metadata. Add optional `placementSource` to the internal snapshot so routes know when the default changed first render.

- [x] **Step 6: Pass case identity from both routes**

For `POST /api/sessions`, pass `body.caseName` when supplied. Browser local Claude/Shell launches must send both the selected `caseName` and their existing working-directory information, allowing the route's current case resolution/security checks to remain authoritative.

For Quick Start, always pass the resolved `caseName`:

```ts
const options = {
  caseName,
  ...(tabGroupId ? { tabGroupId } : {}),
};
const tabLayoutSnapshot = await ctx.addSession(session, options);
```

Return `tabLayout` and `tabPlacements` when `tabGroupId` was requested or `placementSource === 'case-default'`.

- [x] **Step 7: Verify GREEN and commit**

```bash
npm test -- test/tab-layout-service.test.ts test/routes/session-routes.test.ts \
  test/routes/session-routes-parent-lineage.test.ts test/run-mode-ui.test.ts
npm run typecheck
git diff --check
git add src/web/ports/session-port.ts src/web/server.ts src/tab-layout-service.ts \
  src/web/routes/session-routes.ts src/web/public/session-ui.js \
  test/tab-layout-service.test.ts test/routes/session-routes.test.ts \
  test/routes/session-routes-parent-lineage.test.ts test/run-mode-ui.test.ts
git commit -m "feat(launch): COD-343 apply case group defaults"
```

Expected: all precedence, route, lineage, and mode-matrix tests pass.

### Task 4: Add synchronized desktop and mobile selectors

**Files:**

- Modify: `src/web/public/index.html`
- Modify: `src/web/public/session-ui.js`
- Modify: `src/web/public/styles.css`
- Create: `test/case-default-group-ui.browser.test.ts`
- Test: `test/app-settings-structure.test.ts`

- [x] **Step 1: Write the failing browser and structure tests**

Build a Playwright fixture with two groups and mocked GET/PUT responses. Assert:

- desktop and mobile controls have labels and include `Ungrouped`, `nzbdav`, and `tcc` in layout order;
- opening either popover loads the server value;
- saving `group-nzbdav` issues one owner-scoped PUT and mirrors both controls;
- a rejected PUT restores the last confirmed value and emits an error toast;
- reopening after a group rename displays the new name for the same stable ID;
- reopening after deletion displays `Ungrouped` when the server returns a cleared stale value;
- controls are disabled during load/save.

Add structural assertions for IDs `caseDefaultGroup`, `caseDefaultGroupMobile`, their labels, and the new handlers.

- [x] **Step 2: Run tests and verify RED**

```bash
npm test -- test/app-settings-structure.test.ts
npx vitest run --config config/vitest.browser.config.ts test/case-default-group-ui.browser.test.ts
```

Expected: missing markup/method/control failures.

- [x] **Step 3: Add accessible desktop and mobile markup**

Add this control to each case-settings popover, with the mobile ID suffix on the second copy:

```html
<label class="case-setting-field" for="caseDefaultGroup">
  <span>Default session group</span>
  <select id="caseDefaultGroup" onchange="app.onCaseDefaultGroupChanged(false)" disabled>
    <option value="">Ungrouped</option>
  </select>
</label>
<span class="form-hint">Place future sessions for this case in this group</span>
```

- [x] **Step 4: Implement one shared controller path**

Add helpers in `session-ui.js` that operate on both controls:

```js
_caseDefaultGroupControls() {
  return [document.getElementById('caseDefaultGroup'), document.getElementById('caseDefaultGroupMobile')]
    .filter(Boolean);
},

_renderCaseDefaultGroupOptions(data) {
  const options = [{ id: '', name: 'Ungrouped' }, ...(data.groups || [])];
  for (const control of this._caseDefaultGroupControls()) {
    control.replaceChildren(...options.map(({ id, name }) => new Option(name, id)));
    control.value = data.groupId || '';
    control.disabled = false;
    control.dataset.confirmedValue = control.value;
  }
},
```

`loadCaseDefaultGroup(caseName)` GETs the endpoint and calls the renderer. `onCaseDefaultGroupChanged(isMobile)` disables both controls, PUTs `{ groupId: selected || null }`, renders the confirmed response, and on failure restores `dataset.confirmedValue`, reenables both controls, and calls `showToast(message, 'error')`.

Call `loadCaseDefaultGroup(caseName)` whenever either case-settings popover opens. Guard stale async responses with a monotonically increasing request token so changing cases while a request is in flight cannot paint the wrong case's groups.

- [x] **Step 5: Add scoped styling**

Use the existing popover form colors and sizing:

```css
.case-settings-popover .case-setting-field,
.case-settings-popover-mobile .case-setting-field {
  display: grid;
  gap: 4px;
  margin-top: 8px;
}

.case-setting-field select {
  min-width: 180px;
  max-width: 100%;
}
```

Do not change vertical-rail group headings, rows, or session geometry.

- [x] **Step 6: Verify GREEN and commit**

```bash
npm test -- test/app-settings-structure.test.ts test/run-mode-ui.test.ts
npx vitest run --config config/vitest.browser.config.ts test/case-default-group-ui.browser.test.ts
npm run check:frontend-syntax
git diff --check
git add src/web/public/index.html src/web/public/session-ui.js src/web/public/styles.css \
  test/case-default-group-ui.browser.test.ts test/app-settings-structure.test.ts
git commit -m "feat(ui): COD-343 select a case default group"
```

Expected: desktop/mobile behavior and frontend syntax pass.

### Task 5: Release metadata and complete verification

**Files:**

- Create: `.changeset/cod-343-default-case-group.md`
- Modify: `docs/superpowers/plans/2026-08-21-cod-343-default-case-group.md` only to check completed boxes during execution

- [x] **Step 1: Add the patch changeset**

```md
---
'aicodeman': patch
---

Add owner-scoped default session groups to Case Settings.
```

- [x] **Step 2: Run all focused regression suites**

```bash
npm test -- test/state-store.test.ts test/tab-layout-persistence.test.ts \
  test/routes/case-routes.test.ts test/ownership-scoping.test.ts \
  test/tab-layout-service.test.ts test/routes/session-routes.test.ts \
  test/routes/session-routes-parent-lineage.test.ts test/run-mode-ui.test.ts \
  test/app-settings-structure.test.ts test/tab-layout-editing.test.ts
npx vitest run --config config/vitest.browser.config.ts test/case-default-group-ui.browser.test.ts \
  test/tab-group-menu.browser.test.ts
```

Expected: zero failures. Never run bare `npm test` or unscoped Vitest in a managed Codeman session.

- [x] **Step 3: Run static and production-build gates**

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

Record warnings separately from failures.

- [x] **Step 4: Run isolated realistic smoke**

```bash
node /home/ubuntu/.codex/skills/codeman-prod-realistic-smoke/scripts/run-codeman-prod-smoke.mjs --skip-claude
```

Record the exact summary, artifacts, console/page errors, long-scrollback result, and cleanup status.

- [x] **Step 5: Commit release metadata and plan completion**

```bash
git add .changeset/cod-343-default-case-group.md \
  docs/superpowers/plans/2026-08-21-cod-343-default-case-group.md
git commit -m "chore: COD-343 document default group release"
```

### Task 6: Review, merge, push, deploy, and accept on LAN

**Files:**

- No additional feature files expected.

- [ ] **Step 1: Request independent specification and code-quality reviews**

Review `origin/local..HEAD` against the approved design. Resolve every Critical and Important finding, rerun affected tests, then request final whole-branch approval.

- [ ] **Step 2: Recheck Bitbucket and protected root state**

From `/opt/projects/Codeman`, fetch `origin local`. If `origin/local` moved from the feature base, merge it into the feature branch in the worktree, resolve conflicts without touching user-owned root changes, rerun all affected gates, and repeat final review.

Capture hashes/inventory for the root's existing `src/session.ts`, `src/web/server.ts`, and `.superpowers/` changes without printing their contents.

- [ ] **Step 3: Merge and push**

```bash
git merge --no-ff COD-343-default-case-group -m "merge: COD-343 add per-case default groups"
git push origin local
```

Confirm local and Bitbucket `origin/local` contain the merge. Never push `upstream`.

- [ ] **Step 4: Deploy with the guarded workflow**

```bash
CODEMAN_SYNC_REMOTE_REF=origin/local \
CODEMAN_SYNC_SERVICE=codeman-web \
CODEMAN_SYNC_HEALTH_URL=http://127.0.0.1:3002/ \
/home/ubuntu/.codex/skills/sync-origin-local-deploy/scripts/sync_origin_local_deploy.sh
```

If the script's immediate probe races startup, retain the failure evidence and independently verify readiness; never treat a failed build, restart, or stash reapply as success.

- [ ] **Step 5: Verify live behavior through the real UI**

Against `http://192.168.20.66:3002`:

1. Open Case Settings for `nzbdav` and select the existing `nzbdav` group.
2. Reload in a second browser context for the same owner and confirm the server value is shared.
3. Create one disposable Shell session through the ordinary toolbar without an explicit group.
4. Confirm its first authoritative render is inside the `nzbdav` group with no Ungrouped frame.
5. Use COD-320's explicit New session action from another group and confirm explicit placement wins.
6. Confirm parent/follow-parent placement remains unchanged with a focused automated/live-safe check.
7. Remove only the disposable acceptance sessions.
8. Leave `nzbdav` configured as the requested default.
9. Confirm zero page errors/serious console errors, active `codeman-web`, five local HTTP 200 responses, and five LAN HTTP 200 responses.

- [ ] **Step 6: Update Jira and clean up**

Comment on COD-343 with branch, commits, test counts, smoke artifacts, merge revision, deployment result, and LAN acceptance. Move it to Done, verify feature commits remain reachable from current Bitbucket `local`, then remove only the clean feature worktree and local feature branch.
