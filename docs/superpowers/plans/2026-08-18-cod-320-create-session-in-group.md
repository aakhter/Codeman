# COD-320 Create a Session in a Group Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-position **New session** group-menu command that launches exactly one session with the current case/tool and atomically places it at the end of the chosen group.

**Architecture:** Carry an optional `tabGroupId` from the browser launch options through both creation endpoints into `TabLayoutService`. Reconcile the new live session and apply the placement hint under one owner lock and one layout commit, then deliver that authoritative layout inline through SSE and the targeted POST response before the client renders the new tab.

**Tech Stack:** TypeScript ESM, Fastify, Zod, browser JavaScript, Vitest/jsdom.

---

## Task 1: Make session creation reconciliation and placement one atomic layout mutation

**Files:**

- Modify: `src/tab-layout-service.ts`
- Modify: `test/tab-layout-service.test.ts`

- [ ] **Step 1: Add characterization and placement tests**

Add focused tests that pin the current behavior of `get`, `getSnapshot`, `put`, and `putOperations` while reconciliation is extracted. Add creation tests for:

- an existing target group, asserting the new ref is last;
- exactly one `setTabLayout` call, one version increment, and one `tab:layoutChanged` broadcast;
- an inline `layout` in that broadcast;
- no stored owner layout, which still commits version `0` once;
- an unknown/deleted/other-owner group ID, which falls back to normal placement;
- a child created with both `parentSessionId` and `tabGroupId`, where the explicit group wins and the ref has `placement: 'manual'`;
- two concurrent targeted creations, which serialize and append in owner-queue order;
- a placement-only `TabLayoutValidationError`, which preserves the session's normal reconciled placement.

Use the existing harness and mutate `h.live` before calling:

```ts
const layout = await h.service.sessionCreated('alice', 'new-session', 'work');

expect(layout.groups[0].refs.at(-1)).toEqual({ kind: 'session', id: 'new-session' });
expect(h.store.setTabLayout).toHaveBeenCalledTimes(1);
expect(h.broadcast).toHaveBeenCalledWith('tab:layoutChanged', {
  owner: 'alice',
  version: 8,
  layout,
});
```

For the explicit-parent case, expect:

```ts
expect(targetGroup.refs.at(-1)).toEqual({
  kind: 'session',
  id: 'child',
  placement: 'manual',
});
```

- [ ] **Step 2: Run the focused service tests and confirm they fail**

Run:

```bash
npm test -- test/tab-layout-service.test.ts
```

Expected: failures because `sessionCreated` does not accept or apply a target and the SSE payload lacks `layout`.

- [ ] **Step 3: Extract non-committing reconciliation**

Add a private result type and split the existing `getUnlocked()` logic without changing its externally visible behavior:

```ts
interface ReconciledTabLayout {
  base: TabLayout;
  candidate: TabLayout;
  metadata: TabRefMetadata[];
}

private async reconcileUnlocked(owner: string): Promise<ReconciledTabLayout> {
  const facts = await this.facts(owner);
  const current = this.deps.store.getTabLayout(owner);
  const candidate = normalizeOrMigrateOwnerTabLayout({
    owner,
    layouts: current ? { [owner]: current } : undefined,
    sessionOrder: this.deps.store.getSessionOrder(),
    persistedSessions: facts.persisted,
    liveSessions: facts.live,
    webviews: facts.webviews,
    updatedAt: (this.deps.now ?? (() => new Date().toISOString()))(),
  }).layout;
  return {
    base: current ?? { ...candidate, version: -1 },
    candidate,
    metadata: facts.metadata,
  };
}

private async getUnlocked(owner: string): Promise<TabLayout> {
  const { base, candidate } = await this.reconcileUnlocked(owner);
  return sameLayout(base, candidate) ? base : this.commit(owner, base, candidate);
}
```

Keep all existing `get`, `getSnapshot`, `put`, and `putOperations` callers routed through `getUnlocked()`.

- [ ] **Step 4: Commit inline authoritative layouts**

Change the broadcast in `commitPrepared()` to:

```ts
this.deps.broadcast(SseEvent.TabLayoutChanged, {
  owner,
  version: stored.version,
  layout: stored,
});
```

- [ ] **Step 5: Implement targeted `sessionCreated` under the owner queue**

Replace the compatibility implementation with an owner-serialized mutation:

```ts
async sessionCreated(owner: string, sessionId: string, tabGroupId?: string): Promise<TabLayout> {
  return this.withOwner(owner, async () => {
    const { base, candidate, metadata } = await this.reconcileUnlocked(owner);
    let next = candidate;
    const targetGroup = tabGroupId
      ? candidate.groups.find((group) => group.id === tabGroupId)
      : undefined;

    if (targetGroup) {
      const target = { kind: 'session' as const, id: sessionId };
      const targetAlreadyInGroup = targetGroup.refs.some(
        (ref) => ref.kind === target.kind && ref.id === target.id
      );
      const destinationIndex = targetGroup.refs.length - (targetAlreadyInGroup ? 1 : 0);
      try {
        next = moveRef(candidate, target, { groupId: targetGroup.id, index: destinationIndex }, metadata);
      } catch (error) {
        if (!(error instanceof TabLayoutValidationError)) throw error;
        next = candidate;
      }
    }

    return sameLayout(base, next) ? base : this.commit(owner, base, next);
  });
}
```

Update existing lifecycle calls in the service tests to pass the created ID. Do not catch reconciliation failures; only the placement call is best-effort.

- [ ] **Step 6: Run the service tests**

Run:

```bash
npm test -- test/tab-layout-service.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit the service boundary**

```bash
git add -- src/tab-layout-service.ts test/tab-layout-service.test.ts
git commit -m "feat(tabs): COD-320 place created sessions atomically"
```

## Task 2: Carry the placement hint through schemas, ports, routes, and real server wiring

**Files:**

- Modify: `src/web/schemas.ts`
- Modify: `src/web/ports/session-port.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `test/mocks/mock-route-context.ts`
- Modify: `test/routes/session-routes.test.ts`
- Modify: `test/session.test.ts`

- [ ] **Step 1: Write route contract tests first**

In the focused session-route tests, configure `ctx.addSession` to return a fixed layout and add one test for each creation endpoint. Assert the second argument and targeted response:

```ts
expect(harness.ctx.addSession).toHaveBeenCalledWith(
  expect.objectContaining({ id: expect.any(String) }),
  { tabGroupId: 'work' },
);
expect(body.data.tabLayout).toEqual(authoritativeLayout);
```

Also assert an ordinary request omits `tabLayout` from the response and calls `addSession` with only the session argument. Add schema rejection coverage for empty and over-100-character IDs.

- [ ] **Step 2: Add the real `createRouteContext` integration test**

In `test/session.test.ts`, use the running real `WebServer`:

1. `GET /api/tab-layout` for the current base.
2. `PUT /api/tab-layout` with a semantic `createGroup` operation for a unique group ID.
3. `POST /api/sessions` with `workingDir`, `mode: 'shell'`, and that `tabGroupId`.
4. Assert the returned `tabLayout` contains the returned session ID at the end of the group.
5. `GET /api/tab-layout` and assert it equals the response snapshot.

This test must go through the private production `createRouteContext().addSession` wiring indirectly; do not reach into private server fields.

- [ ] **Step 3: Run the route and integration tests and confirm failure**

Run:

```bash
npm test -- test/routes/session-routes.test.ts test/session.test.ts
```

Expected: failures because schemas strip/reject the field, `addSession` returns `void`, and responses have no layout.

- [ ] **Step 4: Extend the public creation contract**

In `session-port.ts`, import `TabLayout` and define:

```ts
export interface SessionCreationOptions {
  tabGroupId?: string;
}

export interface SessionPort {
  readonly sessions: ReadonlyMap<string, Session>;
  addSession(session: Session, options?: SessionCreationOptions): Promise<TabLayout>;
  // existing members unchanged
}
```

In both schemas add:

```ts
tabGroupId: z.string().min(1).max(100).optional(),
```

- [ ] **Step 5: Return the authoritative layout from the real and mock contexts**

Change production wiring to:

```ts
addSession: async (session: Session, options = {}) => {
  this.sessions.set(session.id, session);
  try {
    return await this.tabLayouts.sessionCreated(
      session.owner ?? '@single',
      session.id,
      options.tabGroupId,
    );
  } catch (error) {
    this.sessions.delete(session.id);
    throw error;
  }
},
```

Give the mock a valid default `TabLayout` return so existing callers remain type-correct. Existing cron, Ralph, `/api/run`, and other non-targeted callers continue to ignore the returned value.

- [ ] **Step 6: Pass and return the placement snapshot in both routes**

For `POST /api/sessions`:

```ts
const tabLayout = await ctx.addSession(
  session,
  body.tabGroupId ? { tabGroupId: body.tabGroupId } : undefined,
);
// existing persistence/listener/broadcast work
return {
  session: lightState,
  ...(body.tabGroupId ? { tabLayout } : {}),
};
```

For `POST /api/quick-start`, destructure `tabGroupId`, call `addSession` with `tabGroupId ? { tabGroupId } : undefined`, and include:

```ts
return {
  sessionId: session.id,
  casePath: resolvedCasePath,
  caseName,
  ...(tabGroupId ? { tabLayout } : {}),
};
```

Keep `tabGroupId` as a placement hint only; do not use it for authorization and do not fail the request when the group is unavailable.

- [ ] **Step 7: Run focused server tests**

Run:

```bash
npm test -- test/routes/session-routes.test.ts test/session.test.ts test/quick-start.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit the server contract**

```bash
git add -- src/web/schemas.ts src/web/ports/session-port.ts src/web/server.ts src/web/routes/session-routes.ts test/mocks/mock-route-context.ts test/routes/session-routes.test.ts test/session.test.ts
git commit -m "feat(api): COD-320 accept grouped session creation"
```

## Task 3: Adopt inline authoritative layouts before rendering created sessions

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `src/web/public/session-ui.js`
- Modify: `test/tab-layout-app.test.ts`
- Modify: `test/run-mode-ui.test.ts`

- [ ] **Step 1: Add browser ordering tests**

In `test/tab-layout-app.test.ts`, extend the SSE invalidation test to assert:

```ts
app._onTabLayoutChanged({ owner: 'alice', version: 12, layout: inlineLayout });
expect(app._applyTabLayout).toHaveBeenCalledWith(inlineLayout);
expect(app._loadTabLayout).not.toHaveBeenCalled();
```

Cover both no pending edit and a pending semantic edit; `_applyTabLayout()` must let the edit coordinator adopt/rebase the external layout. Preserve the owner filter and the GET fallback for payloads without `layout`.

In `test/run-mode-ui.test.ts`, add an ordering assertion:

```ts
const calls: string[] = [];
app._applyTabLayout = vi.fn(() => calls.push('layout'));
app._onSessionCreated = vi.fn(() => calls.push('session'));
app._renderSessionTabsImmediate = vi.fn(() => calls.push('render'));

await app._ensureCreatedSessionVisible('sess-new', snapshot, authoritativeLayout);
expect(calls).toEqual(['layout', 'session', 'render']);
```

- [ ] **Step 2: Run the focused client tests and confirm failure**

Run:

```bash
npm test -- test/tab-layout-app.test.ts test/run-mode-ui.test.ts
```

Expected: failures because inline SSE payloads trigger a GET and the creation helper does not accept a layout.

- [ ] **Step 3: Adopt inline SSE payloads through the existing version gate**

Change `_onTabLayoutChanged` after the owner filter:

```js
if (data?.layout) {
  this._applyTabLayout(data.layout);
  return;
}
```

Leave the existing pending-edit invalidation and `_loadTabLayout()` fallback below it. Do not assign `tabLayout` directly; `_applyTabLayout()` owns stale-version rejection and edit-coordinator rebasing.

- [ ] **Step 4: Adopt targeted response layouts before the new session**

Change the helper signature and first operation:

```js
async _ensureCreatedSessionVisible(sessionId, sessionSnapshot, tabLayout) {
  if (!sessionId) return;
  if (tabLayout) this._applyTabLayout(tabLayout);
  // existing fetch fallback, _onSessionCreated, and immediate render
}
```

Update every creation response call site to pass `data.data.tabLayout` or `result.data.tabLayout` as the third argument.

- [ ] **Step 5: Run the client adoption tests**

Run:

```bash
npm test -- test/tab-layout-app.test.ts test/run-mode-ui.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit authoritative client adoption**

```bash
git add -- src/web/public/app.js src/web/public/session-ui.js test/tab-layout-app.test.ts test/run-mode-ui.test.ts
git commit -m "fix(tabs): COD-320 adopt creation layout before render"
```

## Task 4: Thread narrow launch options through every run mode

**Files:**

- Modify: `src/web/public/session-ui.js`
- Modify: `test/run-mode-ui.test.ts`

- [ ] **Step 1: Write dispatcher, count, and request tests**

Add tests that assert:

- `run({ count: 1, tabGroupId: 'work' })` forwards the same options to Claude, Shell, OpenCode, Codex, Gemini, Antigravity, and Pi dispatch targets;
- Claude and Shell send exactly one create request even when their DOM controls contain a larger count;
- their DOM control values are unchanged;
- local `/api/sessions` and remote/Docker `/api/quick-start` bodies carry `tabGroupId`;
- every single-session quick-start mode carries `tabGroupId`;
- `run()` without options retains existing toolbar counts;
- `_runInFlight` is released after success and failure and no placement state remains on the app.

Update the static run-method scanner to recognize option-bearing signatures:

```ts
const header = /^ {2}async (run[A-Za-z]*)\(options = \{\}\) \{$/gm;
```

- [ ] **Step 2: Run the launch tests and confirm failure**

Run:

```bash
npm test -- test/run-mode-ui.test.ts
```

Expected: failures because the dispatcher and launch methods currently accept no options and request bodies omit the target.

- [ ] **Step 3: Forward options from the dispatcher**

Use:

```js
async run(options = {}) {
  // existing lock
  const mode = this._runMode || 'claude';
  if (mode === 'opencode') return await this.runOpenCode(options);
  if (mode === 'codex') return await this.runCodex(options);
  if (mode === 'gemini') return await this.runGemini(options);
  if (mode === 'antigravity') return await this.runAntigravity(options);
  if (mode === 'pi') return await this.runPi(options);
  if (mode === 'shell') return await this.runShell(options);
  return await this.runClaude(options);
}
```

Keep the existing `try/finally`, minimum lock duration, and Run-button state unchanged.

- [ ] **Step 4: Apply count overrides without mutating controls**

Change Claude and Shell to `async runClaude(options = {})` and `async runShell(options = {})`, with:

```js
const requestedCount = options.count ?? parseInt(document.getElementById('tabCount').value);
const tabCount = Math.min(20, Math.max(1, requestedCount || 1));
```

and the equivalent using `shellCount`. Do not write back to either input.

- [ ] **Step 5: Add the placement hint to all creation bodies**

Give every `run*` method `options = {}` and add this field to each `/api/sessions` or `/api/quick-start` body:

```js
...(options.tabGroupId ? { tabGroupId: options.tabGroupId } : {}),
```

For Claude and Shell batch paths, include it in each mapped request; the group-menu caller forces `count: 1`, while ordinary toolbar batches remain unchanged.

- [ ] **Step 6: Run launch tests**

Run:

```bash
npm test -- test/run-mode-ui.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit launch option plumbing**

```bash
git add -- src/web/public/session-ui.js test/run-mode-ui.test.ts
git commit -m "feat(launch): COD-320 target a session group"
```

## Task 5: Add the accessible first-position group-menu command

**Files:**

- Modify: `src/web/public/app.js`
- Modify: `test/tab-layout-editing.test.ts`

- [ ] **Step 1: Write interaction and accessibility tests**

Update the two existing assumptions that **Rename group** is first. Add tests that assert:

- visible text is **New session**, first in the menu, initially focused;
- `aria-label` is `New session in Work` for a group named Work;
- clicking it closes the menu and invokes `createSessionInTabGroup('g1')` once;
- Arrow Up from the first item still wraps to Delete and Arrow Down wraps back;
- a collapsed target expands and persists before `run` is called;
- `_runInFlight` shows feedback and neither expands nor starts;
- a missing group/read-only layout starts nothing;
- terminal focus happens synchronously before the promise returned by `run` settles.

- [ ] **Step 2: Run the interaction tests and confirm failure**

Run:

```bash
npm test -- test/tab-layout-editing.test.ts
```

Expected: failures because the menu has no creation action or group-target helper.

- [ ] **Step 3: Implement `createSessionInTabGroup`**

Add near the other group actions:

```js
async createSessionInTabGroup(groupId) {
  if (this._runInFlight) {
    this.showToast?.('A session is already starting.', 'info');
    return false;
  }
  const group = this.tabLayout?.groups?.find((candidate) => candidate.id === groupId);
  if (this.tabLayoutReadOnly || !group) return false;

  this.toggleTabGroupCollapsed(groupId, false);
  this.terminal.focus();
  try {
    await this.run({ count: 1, tabGroupId: groupId });
    return true;
  } catch (error) {
    this.showToast?.(error?.message || 'Could not start session.', 'error');
    return false;
  }
}
```

The in-flight check must precede expansion. Terminal focus must occur before the first `await`.

- [ ] **Step 4: Make menu actions carry separate visible and accessible names**

Convert `actions` to objects and put creation first:

```js
const group = this.tabLayout.groups[groupIndex];
const actions = [
  {
    label: 'New session',
    ariaLabel: `New session in ${group.name}`,
    run: () => this.createSessionInTabGroup(groupId),
  },
  { label: 'Rename group', run: () => this.startTabGroupRename(groupId) },
  // existing move-earlier, move-later, and delete actions
];
```

In the loop set `button.textContent = action.label`, conditionally set `aria-label`, close the menu, and call `action.run()`. Keep the existing `role="menuitem"`, first-button focus, navigation, Escape, and listener cleanup.

- [ ] **Step 5: Run the interaction tests**

Run:

```bash
npm test -- test/tab-layout-editing.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit the user-facing action**

```bash
git add -- src/web/public/app.js test/tab-layout-editing.test.ts
git commit -m "feat(tabs): COD-320 add new session group action"
```

## Task 6: Verify the complete change and request review

**Files:**

- Review all files changed above

- [ ] **Step 1: Run the focused regression suite**

```bash
npm test -- test/tab-layout-service.test.ts test/routes/session-routes.test.ts test/session.test.ts test/quick-start.test.ts test/tab-layout-app.test.ts test/run-mode-ui.test.ts test/tab-layout-editing.test.ts
```

Expected: all pass. Do not run bare `npm test` in a Codeman-managed session.

- [ ] **Step 2: Run repository quality gates**

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run build
```

Expected: all commands exit `0`.

- [ ] **Step 3: Inspect the final diff and history**

```bash
git status --short
git diff origin/local...HEAD --check
git diff origin/local...HEAD --stat
git log --oneline --decorate origin/local..HEAD
```

Expected: no whitespace errors, only COD-320 files/commits, and no generated or secret files.

- [ ] **Step 4: Perform two independent reviews**

Use `superpowers:requesting-code-review` for a self/agent review against the approved design and Jira acceptance behavior. Then use `session-bridge` to ask the authenticated Cisco Enterprise Claude CLI to review the final diff, tests, concurrency behavior, accessibility, and regression risk. Resolve technically valid findings with `superpowers:receiving-code-review`, rerun affected tests, and repeat the relevant quality gates.

- [ ] **Step 5: Commit review fixes if needed**

Stage only reviewed files from the scoped list in this plan, then run:

```bash
git commit -m "fix(tabs): COD-320 address review findings"
```

- [ ] **Step 6: Re-run verification before reporting completion**

Use `superpowers:verification-before-completion` and repeat the focused tests plus all quality gates from Steps 1 and 2. Report exact commands and results; do not claim success from earlier or partial output.
