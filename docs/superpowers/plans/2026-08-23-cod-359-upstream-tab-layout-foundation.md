# COD-359 Upstream Tab Layout Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the reviewed COD-303/COD-304/COD-308 tab-layout foundation onto `upstream/master` while preserving the existing browser's legacy ordering contract until COD-360.

**Architecture:** Replay the frozen historical model, persistence, service, API, lifecycle, and SSE commits first, then add the extraction-specific corrections as small test-first commits. `TabLayoutService` remains the sole layout mutation boundary; `StateStore` publishes layout and legacy-order representations together in one synchronous mutation, while a recipient-aware SSE path preserves the legacy `{ order }` wire shape without cross-user disclosure.

**Tech Stack:** TypeScript ESM, Fastify 5, Zod, Vitest, StateStore JSON persistence, server-sent events, Changesets.

---

## Working Rules and Frozen Inputs

- Work only in `/home/aakhter/.codeman/app/.worktrees/cod-359-upstream-tab-layout-foundation` on branch `cod-359-upstream-tab-layout-foundation`.
- The base is `upstream/master` at `88bb98de436472a5224ba8082189e3910a260af3`.
- Never run bare `npm test` or raw unscoped `vitest`; every test command below names files.
- Never write to `upstream` or `fork`. The only writable remote for eventual delivery is Bitbucket `origin`.
- Frozen replay commits, in order:
  - COD-308: `8d86435a`, `37d6b4d6`, `2c09de85`
  - COD-304: `7513dc89`, `d7152800`
  - COD-303: `7db0590c`, `ccaccfc1`, `d02ed887`, `b9526f09`
- The historical COD-304 commit temporarily makes legacy session ordering read-only. Do not push or request review until Task 7 restores the synchronized writable compatibility path.
- Do not introduce browser layout fetching/rendering, semantic-operation HTTP replay, recovery-base layouts, Focus flags/groups, search, case-default groups, post-cutpoint child-creation placement, Session Bridge placement, or saved-webview UI integration.

## File Responsibility Map

- `src/tab-layout.ts`: pure semantic model, validation, normalization, immutable operations, flattening.
- `src/tab-layout-persistence.ts`: owner keying, deterministic migration, authoritative live-record replacement.
- `src/tab-layout-legacy-order.ts`: pure legacy rank application and canonical global-order recomposition.
- `src/state-store.ts`, `src/types/app-state.ts`: persisted owner layouts and synchronous combined layout/order publication.
- `src/tab-layout-service.ts`: owner queues, restoration gate, reconciliation, optimistic PUT, lifecycle transactions, legacy bridge.
- `src/web/routes/tab-layout-routes.ts`: authenticated versioned GET/PUT boundary and 128 KiB limit.
- `src/web/routes/session-routes.ts`, `src/web/server.ts`: preserved legacy PUT and status projection.
- `src/web/session-order-sse.ts`, `src/web/sse-stream-manager.ts`: trusted recipient-aware legacy order dispatch.
- `src/web/tab-layout-sse.ts`, `src/web/sse-events.ts`, `src/web/public/constants.js`: minimal owner-scoped tab-layout invalidation token/routing.
- `src/web/ports/*`, `src/web/routes/index.ts`, `test/mocks/mock-route-context.ts`: typed route/service wiring.
- Session, system, Ralph, cron, and webview modules: lifecycle hooks and restoration-safe deletion coordination only.

### Task 1: Replay the COD-308 Pure Semantic Model

**Files:**
- Create: `src/tab-layout.ts`
- Create: `test/tab-layout.test.ts`

- [ ] **Step 1: Confirm the model is absent on the upstream base**

Run:

```bash
test ! -e src/tab-layout.ts
test ! -e test/tab-layout.test.ts
```

Expected: both commands exit `0`.

- [ ] **Step 2: Replay the reviewed COD-308 commits in order**

Run:

```bash
git cherry-pick 8d86435a 37d6b4d6 2c09de85
```

Expected: three clean commits ending at `fix(tabs): COD-308 guard follow-parent replay`.

- [ ] **Step 3: Verify the model contract**

Run:

```bash
npm test -- test/tab-layout.test.ts
```

Expected: `24` tests pass, including validation limits, defensive cloning, lineage normalization, immutable moves, orphan materialization, and follow-parent replay safety.

- [ ] **Step 4: Audit the replay boundary**

Run:

```bash
git diff --name-only 88bb98de..HEAD
```

Expected output contains only:

```text
src/tab-layout.ts
test/tab-layout.test.ts
```

### Task 2: Replay COD-304 Owner Persistence and Migration

**Files:**
- Create: `src/tab-layout-persistence.ts`
- Create: `test/tab-layout-persistence.test.ts`
- Modify: `src/state-store.ts`
- Modify: `src/types/app-state.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/web/server.ts`
- Modify: `test/http-contract.test.ts`
- Modify: `test/routes/session-order-routes.test.ts`

- [ ] **Step 1: Replay the reviewed COD-304 commits**

Run:

```bash
git cherry-pick 7513dc89 d7152800
```

Expected: two clean commits ending at `fix(tabs): COD-304 trust live session metadata`.

- [ ] **Step 2: Verify deterministic migration and authoritative live replacement**

Run:

```bash
npm test -- test/tab-layout-persistence.test.ts
```

Expected: `10` tests pass, including owner isolation, restart persistence, idempotent migration, and full live-record replacement.

- [ ] **Step 3: Verify the frozen historical HTTP checkpoint**

Run:

```bash
npm test -- test/routes/session-order-routes.test.ts test/http-contract.test.ts
```

Expected: both files pass. At this temporary checkpoint, the route test describes the historical read-only legacy PUT; Task 7 replaces that assertion before delivery.

### Task 3: Replay COD-303 Service, API, Lifecycle, and SSE Foundation

**Files:**
- Create: `src/tab-layout-service.ts`
- Create: `src/web/ports/tab-layout-port.ts`
- Create: `src/web/routes/tab-layout-routes.ts`
- Create: `src/web/tab-layout-sse.ts`
- Create: `test/routes/tab-layout-routes.test.ts`
- Create: `test/tab-layout-service.test.ts`
- Create: `test/tab-layout-sse.test.ts`
- Create: `test/tab-layout-restore-gate.test.ts`
- Modify: `src/cron/cron-service.ts`
- Modify: `src/state-store.ts`
- Modify: `src/web/ports/index.ts`
- Modify: `src/web/ports/session-port.ts`
- Modify: `src/web/public/constants.js`
- Modify: `src/web/routes/index.ts`
- Modify: `src/web/routes/ralph-routes.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/web/routes/system-routes.ts`
- Modify: `src/web/routes/webview-routes.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/sse-events.ts`
- Modify: `test/cron-service.test.ts`
- Modify: `test/mocks/mock-route-context.ts`
- Modify: `test/routes/ralph-routes.test.ts`
- Modify: `test/routes/system-routes.test.ts`
- Modify: `test/routes/webview-routes.test.ts`
- Modify: `test/session-cleanup.test.ts`

- [ ] **Step 1: Replay the reviewed COD-303 commits**

Run:

```bash
git cherry-pick 7db0590c ccaccfc1 d02ed887 b9526f09
```

Expected: four clean commits ending at `fix(tabs): COD-303 transact stale cleanup`.

- [ ] **Step 2: Verify service, API, SSE, and restoration behavior**

Run:

```bash
npm test -- test/tab-layout-service.test.ts test/tab-layout-restore-gate.test.ts test/routes/tab-layout-routes.test.ts test/tab-layout-sse.test.ts
```

Expected: all named files pass; restoration failure remains deletion-closed and explicit test skip remains the only non-success unlock.

- [ ] **Step 3: Verify lifecycle integrations without running the full suite**

Run:

```bash
npm test -- test/session-cleanup.test.ts test/routes/ralph-routes.test.ts test/routes/webview-routes.test.ts test/cron-service.test.ts test/routes/system-routes.test.ts
```

Expected: all named files pass, including restoration-safe deletion and one-shot multi-owner stale cleanup.

### Task 4: Make PUT Reconciliation Side-Effect Free Before Version Comparison

**Files:**
- Modify: `test/tab-layout-service.test.ts`
- Modify: `test/routes/tab-layout-routes.test.ts`
- Modify: `src/tab-layout-service.ts`

- [ ] **Step 1: Add failing service regressions**

Add tests with these assertions to `test/tab-layout-service.test.ts`:

```ts
it('does not initialize, persist, or broadcast before rejecting a stale direct-first PUT', async () => {
  const harness = createHarness({ storedLayout: null });
  const result = await harness.service.put(OWNER, emptyLayout(0), 99);

  expect(result.status).toBe('conflict');
  expect(harness.store.setTabLayout).not.toHaveBeenCalled();
  expect(harness.broadcast).not.toHaveBeenCalled();
});

it('does not persist normalization before rejecting a stale PUT', async () => {
  const harness = createHarness({ storedLayout: layoutWithStaleRef(4) });
  const result = await harness.service.put(OWNER, emptyLayout(4), 3);

  expect(result.status).toBe('conflict');
  expect(harness.store.setTabLayout).not.toHaveBeenCalled();
  expect(harness.broadcast).not.toHaveBeenCalled();
});

it('folds direct-first reconciliation and a matching PUT into one commit', async () => {
  const harness = createHarness({ storedLayout: null });
  const result = await harness.service.put(OWNER, layoutWithSession('s1', 0), 0);

  expect(result.status).toBe('updated');
  expect(harness.store.setTabLayout).toHaveBeenCalledTimes(1);
  expect(harness.broadcast).toHaveBeenCalledTimes(1);
  expect(result.layout.version).toBe(1);
});
```

Use the existing harness names where they differ; preserve these inputs and observable assertions.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
npm test -- test/tab-layout-service.test.ts
```

Expected: the stale direct-first and stale-normalization tests fail because historical `put()` calls mutating `getUnlocked()` before comparing `baseVersion`.

- [ ] **Step 3: Split preparation from commit**

Refactor `src/tab-layout-service.ts` around this interface:

```ts
interface PreparedOwnerLayout {
  current: TabLayout | null;
  authoritative: TabLayout;
  metadata: TabRefMetadata[];
  requiresCommit: boolean;
}

private async prepareUnlocked(owner: string): Promise<PreparedOwnerLayout> {
  const facts = await this.facts(owner);
  const current = this.deps.store.getTabLayout(owner);
  const migrated = normalizeOrMigrateOwnerTabLayout({
    owner,
    layouts: current ? { [owner]: current } : undefined,
    sessionOrder: this.deps.store.getSessionOrder(),
    persistedSessions: facts.persisted,
    liveSessions: facts.live,
    webviews: facts.webviews,
  }).layout;
  return {
    current,
    authoritative: migrated,
    metadata: facts.metadata,
    requiresCommit: current === null || !sameLayout(current, migrated),
  };
}
```

Make `getUnlocked()` commit `authoritative` only when `requiresCommit`. Make `put()` call `prepareUnlocked()`, compare `baseVersion` with `authoritative.version`, return conflict immediately on mismatch, then normalize the requested layout and commit only the final incremented result.

- [ ] **Step 4: Add the route-level no-write conflict regression**

Add to `test/routes/tab-layout-routes.test.ts`:

```ts
it('returns 409 with the authoritative prepared layout and no invalidation', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/tab-layout',
    payload: { baseVersion: 99, layout: emptyLayout(0) },
  });

  expect(response.statusCode).toBe(409);
  expect(response.json().error.code).toBe('CONFLICT');
  expect(tabLayouts.put).toHaveBeenCalledWith(expect.any(String), expect.anything(), 99);
});
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm test -- test/tab-layout-service.test.ts test/routes/tab-layout-routes.test.ts
git add -- src/tab-layout-service.ts test/tab-layout-service.test.ts test/routes/tab-layout-routes.test.ts
git commit -m "fix(tabs): COD-359 make layout conflicts side-effect free"
```

Expected: both files pass; the commit records no-write conflict and single-commit direct-first behavior.

### Task 5: Add Pure Legacy Translation and Atomic Combined Store Publication

**Files:**
- Create: `src/tab-layout-legacy-order.ts`
- Create: `test/tab-layout-legacy-order.test.ts`
- Create: `test/state-store-tab-layout.test.ts`
- Modify: `src/state-store.ts`

- [ ] **Step 1: Write failing pure translation tests**

Create `test/tab-layout-legacy-order.test.ts` with concrete cases equivalent to:

```ts
it('ranks only authoritative sessions while anchoring webviews and unknown refs', () => {
  const input = layout({
    ungrouped: [session('a'), webview('w1'), session('unknown'), session('b')],
  });
  expect(applyLegacySessionRank(input, ['b', 'a'], metadataFor('a', 'b'))).toEqual(
    layout({ ungrouped: [session('b'), webview('w1'), session('unknown'), session('a')] }),
  );
});

it('preserves group membership and marks inherited children manual', () => {
  const input = groupedLayout('G', [session('parent'), session('child'), session('other')]);
  const result = applyLegacySessionRank(input, ['child', 'other', 'parent'], [
    meta('parent'),
    meta('child', { parentSessionId: 'parent' }),
    meta('other'),
  ]);
  expect(result.groups[0].refs.map((ref) => ref.id)).toEqual(['child', 'other', 'parent']);
  expect(result.groups[0].refs[0]).toMatchObject({ id: 'child', placement: 'manual' });
});

it('recomposes one owner against the latest foreign-owner order', () => {
  const result = recomposeGlobalSessionOrder(['a1', 'b1', 'a2', 'b2'], [
    { owner: 'alice', ownedIds: ['a1', 'a2'], order: ['a2', 'a1'] },
  ]);
  expect(result).toEqual(['a2', 'b1', 'a1', 'b2']);
});
```

- [ ] **Step 2: Run the pure test and verify RED**

Run:

```bash
npm test -- test/tab-layout-legacy-order.test.ts
```

Expected: FAIL because `src/tab-layout-legacy-order.ts` does not exist.

- [ ] **Step 3: Implement the pure compatibility helpers**

Create `src/tab-layout-legacy-order.ts` with these public contracts:

```ts
export interface OwnerOrderProjection {
  owner: string;
  ownedIds: readonly string[];
  order: readonly string[];
}

export function applyLegacySessionRank(
  input: TabLayout,
  requestedOrder: readonly string[],
  metadata: readonly TabRefMetadata[],
): TabLayout;

export function recomposeGlobalSessionOrder(
  current: readonly string[],
  projections: readonly OwnerOrderProjection[],
  preferred?: readonly string[],
): string[];
```

`applyLegacySessionRank()` must clone the layout, build a rank only for owner-valid visible session metadata, mark every ranked child with an owner-valid parent as `placement: 'manual'`, sort only those session refs inside each existing container, and leave group order, group membership, webviews, and refs absent from metadata at their exact slots. Normalize once after transformation.

`recomposeGlobalSessionOrder()` must start from `mergeSessionOrder(preferred ?? current, current)`, replace each owner's existing slots with that owner's canonical sequence, append new owner IDs once, preserve all foreign/unmapped IDs, and never mutate inputs.

- [ ] **Step 4: Write failing StateStore atomicity tests**

Create `test/state-store-tab-layout.test.ts` with:

```ts
it('publishes validated layout entries and the projection together with one save schedule', () => {
  const store = createStore();
  const save = vi.spyOn(store, 'save');
  const result = store.commitTabLayoutProjection({ alice: layoutWithSession('a2', 2) }, (latest) =>
    recomposeGlobalSessionOrder(latest, [{ owner: 'alice', ownedIds: ['a1', 'a2'], order: ['a2', 'a1'] }]),
  );

  expect(store.getTabLayout('alice')?.version).toBe(2);
  expect(store.getSessionOrder()).toEqual(['a2', 'a1']);
  expect(result.sessionOrder).toEqual(['a2', 'a1']);
  expect(save).toHaveBeenCalledTimes(1);
});

it('validates every layout before changing either representation', () => {
  const store = createStore({ sessionOrder: ['a1'], tabLayouts: { alice: layoutWithSession('a1', 1) } });
  expect(() => store.commitTabLayoutProjection({ alice: invalidLayout() }, () => ['a2'])).toThrow();
  expect(store.getSessionOrder()).toEqual(['a1']);
  expect(store.getTabLayout('alice')?.version).toBe(1);
});

it('derives concurrent owner projections from the latest committed order', () => {
  const store = createStore({ sessionOrder: ['a1', 'b1', 'a2', 'b2'] });
  store.commitTabLayoutProjection({ alice: aliceLayout(2) }, (latest) => projectAlice(latest, ['a2', 'a1']));
  store.commitTabLayoutProjection({ bob: bobLayout(2) }, (latest) => projectBob(latest, ['b2', 'b1']));
  expect(store.getSessionOrder()).toEqual(['a2', 'b2', 'a1', 'b1']);
});
```

- [ ] **Step 5: Run the store test and verify RED**

Run:

```bash
npm test -- test/state-store-tab-layout.test.ts
```

Expected: FAIL because `commitTabLayoutProjection()` is missing.

- [ ] **Step 6: Implement one synchronous combined mutation**

Add this shape to `StateStore`:

```ts
commitTabLayoutProjection(
  layouts: Readonly<Record<string, TabLayout>>,
  projectOrder: (latest: readonly string[]) => readonly string[],
): { layouts: Record<string, TabLayout>; sessionOrder: string[] } {
  const validated = Object.fromEntries(
    Object.entries(layouts).map(([owner, layout]) => [owner, validateTabLayout(layout)]),
  );
  const sessionOrder = normalizeSessionOrder(projectOrder([...this.getSessionOrder()]));
  const nextLayouts = { ...(this.state.tabLayouts ?? {}), ...validated };

  this.state.tabLayouts = nextLayouts;
  this.state.sessionOrder = sessionOrder;
  this.save();
  return { layouts: structuredClone(validated), sessionOrder: [...sessionOrder] };
}
```

Keep the callback invocation and both assignments synchronous. Validate all layouts and the projected order before either assignment. Existing debounced save/retry/circuit-breaker semantics remain unchanged; do not add a false synchronous disk-acknowledgement promise.

Add `import { normalizeSessionOrder } from './session-order.js';` beside the historical tab-layout imports in `src/state-store.ts`. Reuse the historical `validateTabLayout` import added by COD-304.

- [ ] **Step 7: Run focused tests and commit**

Run:

```bash
npm test -- test/tab-layout-legacy-order.test.ts test/state-store-tab-layout.test.ts test/session-order.test.ts
git add -- src/tab-layout-legacy-order.ts src/state-store.ts test/tab-layout-legacy-order.test.ts test/state-store-tab-layout.test.ts
git commit -m "feat(tabs): COD-359 synchronize legacy layout projections"
```

Expected: all named files pass.

### Task 6: Route Every Layout and Legacy Mutation Through the Compatibility Bridge

**Files:**
- Modify: `src/tab-layout-service.ts`
- Modify: `src/web/ports/tab-layout-port.ts`
- Modify: `test/tab-layout-service.test.ts`
- Modify: `test/tab-layout-restore-gate.test.ts`

- [ ] **Step 1: Add failing regular-user bridge tests**

Add cases to `test/tab-layout-service.test.ts` that prove this sequence:

```ts
it('makes a legacy reorder authoritative for the next tab-layout GET', async () => {
  const harness = createHarness({ sessions: [owned('a'), owned('b')] });
  await harness.service.get('alice');
  const result = await harness.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['b', 'a']);
  const layout = await harness.service.get('alice');

  expect(result.order).toEqual(['b', 'a']);
  expect(flattenOwnerSessionOrder(layout)).toEqual(['b', 'a']);
});

it('rejects a regular caller attempting to rank a foreign session', async () => {
  const harness = createHarness({ sessions: [owned('a', 'alice'), owned('b', 'bob')] });
  await expect(
    harness.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['b', 'a']),
  ).rejects.toThrow('session is not owned by layout owner: b');
});

it('projects a layout PUT back into legacy order without a duplicate unchanged event', async () => {
  const harness = createHarness({ sessions: [owned('a'), owned('b')] });
  const current = await harness.service.get('alice');
  await harness.service.put('alice', reverseSessions(current), current.version);
  expect(harness.store.getSessionOrder()).toEqual(['b', 'a']);
  expect(harness.broadcastSessionOrder).toHaveBeenCalledTimes(1);
  await harness.service.get('alice');
  expect(harness.broadcastSessionOrder).toHaveBeenCalledTimes(1);
});
```

Also assert grouped/webview/unknown-slot preservation and parent/child manual placement through a subsequent `get()`.
Add a stale-version assertion after the bridge is installed: neither `commitTabLayoutProjection()` nor `broadcastSessionOrder()` is called for a conflict.

- [ ] **Step 2: Add failing concurrent-owner and admin tests**

Add cases proving:

```ts
it('does not lose either owner projection when owner preparations overlap', async () => {
  const harness = createDeferredFactsHarness();
  await Promise.all([
    harness.service.putLegacyOrder({ owner: 'alice', isAdmin: false }, ['a2', 'a1']),
    harness.service.putLegacyOrder({ owner: 'bob', isAdmin: false }, ['b2', 'b1']),
  ]);
  expect(harness.store.getSessionOrder()).toEqual(['a2', 'b2', 'a1', 'b1']);
});

it('keeps an admin cross-owner reorder globally visible when owner-relative ranks do not change', async () => {
  const harness = createHarness({ sessions: [owned('a', 'alice'), owned('b', 'bob')] });
  const result = await harness.service.putLegacyOrder({ owner: 'admin', isAdmin: true }, ['b', 'a']);
  expect(result.globalOrder).toEqual(['b', 'a']);
  expect(result.changedOwnerOrders).toEqual({});
  expect(result.globalChanged).toBe(true);
});
```

- [ ] **Step 3: Run service tests and verify RED**

Run:

```bash
npm test -- test/tab-layout-service.test.ts
```

Expected: FAIL because `putLegacyOrder()` and combined projection broadcasting are missing.

- [ ] **Step 4: Add the service result and dependency contracts**

Use these types in `src/tab-layout-service.ts` and expose the method through `TabLayoutPort`:

```ts
export interface LegacyOrderActor {
  owner: string;
  isAdmin: boolean;
}

export interface SessionOrderProjectionChange {
  changedOwnerOrders: Record<string, string[]>;
  globalOrder: string[];
  globalChanged: boolean;
}

export interface LegacyOrderPutResult extends SessionOrderProjectionChange {
  order: string[];
}
```

Extend dependencies with:

```ts
broadcastSessionOrder(change: SessionOrderProjectionChange): void;
```

- [ ] **Step 5: Implement regular and admin legacy mutations**

Implement `putLegacyOrder(actor, requested)` as follows:

```ts
async putLegacyOrder(actor: LegacyOrderActor, requested: readonly string[]): Promise<LegacyOrderPutResult> {
  if (!actor.isAdmin) {
    return this.withOwner(actor.owner, async () => this.putLegacyOrderForOwner(actor.owner, requested));
  }

  const owners = await this.ownersForAdminOrder(requested);
  return this.withOwners([...owners].sort(), async () => this.putLegacyOrderForAdmin(requested, owners));
}
```

The regular helper must prepare without intermediate persistence, validate every requested ID against authoritative owner facts, merge missing owner IDs, call `applyLegacySessionRank()`, increment only a changed layout, and publish layout plus projection with one `commitTabLayoutProjection()` callback.

The admin helper must merge against the latest global order, partition authoritative IDs by owner, prepare each owner layout under stable owner locks, apply only per-owner relative ranks, then atomically publish all changed layouts plus the canonical recomposed global order. Emit one tab-layout invalidation per changed owner. If only cross-owner interleaving changes, leave layout versions unchanged but set `globalChanged: true`.

Refactor `commitPrepared()` so GET initialization, normalization, versioned PUT, lifecycle repair, and legacy PUT all use the combined store primitive. Compare the previous and next flattened owner orders to populate `changedOwnerOrders`; compare the latest and returned global orders for `globalChanged`; call `broadcastSessionOrder()` only when either changed.

- [ ] **Step 6: Re-run restoration-gate regressions**

Run:

```bash
npm test -- test/tab-layout-service.test.ts test/tab-layout-restore-gate.test.ts
```

Expected: both pass. `failed` restoration remains deletion-closed; only `complete` and explicit test `skipped` states unlock destructive cleanup.

- [ ] **Step 7: Commit the service bridge**

Run:

```bash
git add -- src/tab-layout-service.ts src/web/ports/tab-layout-port.ts test/tab-layout-service.test.ts test/tab-layout-restore-gate.test.ts
git commit -m "feat(tabs): COD-359 bridge legacy and owner layout writes"
```

### Task 7: Restore the Legacy HTTP Contract with Recipient-Aware SSE

**Files:**
- Create: `src/web/session-order-sse.ts`
- Create: `test/session-order-sse.test.ts`
- Modify: `src/web/sse-stream-manager.ts`
- Modify: `src/web/routes/session-routes.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/ports/session-port.ts`
- Modify: `test/routes/session-order-routes.test.ts`
- Modify: `test/http-contract.test.ts`
- Modify: `test/mocks/mock-route-context.ts`

- [ ] **Step 1: Replace the historical read-only route tests with failing compatibility tests**

In `test/routes/session-order-routes.test.ts`, remove the temporary `422` expectation and add:

```ts
it('routes a regular legacy PUT through the authenticated owner layout service', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: '/api/session-order',
    payload: { order: ['b', 'a'] },
  });
  expect(response.statusCode).toBe(200);
  expect(tabLayouts.putLegacyOrder).toHaveBeenCalledWith(
    { owner: expect.any(String), isAdmin: false },
    ['b', 'a'],
  );
  expect(response.json().data.order).toEqual(['b', 'a']);
});

it('uses the machine-wide admin bridge for an admin caller', async () => {
  await injectAsAdmin({ method: 'PUT', url: '/api/session-order', payload: { order: ['b', 'a'] } });
  expect(tabLayouts.putLegacyOrder).toHaveBeenCalledWith(
    { owner: expect.any(String), isAdmin: true },
    ['b', 'a'],
  );
});
```

Add status assertions: a regular user's `/api/status.sessionOrder` contains only that user's owner slice; an admin receives the global order.

- [ ] **Step 2: Write failing recipient-dispatch tests**

Create `test/session-order-sse.test.ts` proving the pure recipient selection:

```ts
it('selects an owner slice for the matching regular user and nothing for another user', () => {
  const change = changeWith({ alice: ['a2', 'a1'] }, ['a2', 'b1', 'a1'], true);
  expect(sessionOrderPayloadFor({ username: 'alice', role: 'user' }, change)).toEqual({ order: ['a2', 'a1'] });
  expect(sessionOrderPayloadFor({ username: 'bob', role: 'user' }, change)).toBeUndefined();
});

it('selects the global projection for admins even when only interleaving changed', () => {
  const change = changeWith({}, ['b1', 'a1'], true);
  expect(sessionOrderPayloadFor({ username: 'admin', role: 'admin' }, change)).toEqual({ order: ['b1', 'a1'] });
});
```

- [ ] **Step 3: Run route and SSE tests and verify RED**

Run:

```bash
npm test -- test/routes/session-order-routes.test.ts test/session-order-sse.test.ts
```

Expected: FAIL because the route is read-only and recipient-aware dispatch is absent.

- [ ] **Step 4: Implement trusted recipient selection**

Create `src/web/session-order-sse.ts`:

```ts
import type { SessionOrderProjectionChange } from '../tab-layout-service.js';
import type { AuthUser } from '../types.js';

export function sessionOrderPayloadFor(
  identity: AuthUser | undefined,
  change: SessionOrderProjectionChange,
): { order: string[] } | undefined {
  if (!identity || identity.role === 'admin') {
    return change.globalChanged ? { order: [...change.globalOrder] } : undefined;
  }
  const order = change.changedOwnerOrders[identity.username];
  return order ? { order: [...order] } : undefined;
}
```

Add `SseStreamManager.broadcastSessionOrder(change)`. It must iterate connected clients, call `sessionOrderPayloadFor()` using each server-tracked identity, serialize the unchanged browser wire shape `event: session:orderChanged` plus `{ order }`, and skip clients for which selection returns `undefined`. Do not derive ownership from request data or an order ID.

In `test/session-order-sse.test.ts`, also register fake replies for two devices owned by Alice, one Bob device, and one admin device against `SseStreamManager`; assert both Alice frames contain only `['a2', 'a1']`, Bob receives no frame, and the admin frame contains the global order. Add a second case with `changedOwnerOrders: {}` and `globalChanged: true` that writes only the admin frame.

- [ ] **Step 5: Restore the writable route and filtered status projection**

Implement the route around the authenticated user:

```ts
app.put('/api/session-order', async (req): Promise<ApiResponse<{ order: string[] }>> => {
  const { order } = parseBody(SessionOrderUpdateSchema, req.body, 'Invalid session order');
  const user = getAuthUser(req);
  const result = await ctx.tabLayouts.putLegacyOrder(
    { owner: ownerLayoutKey(ownerFor(req)), isAdmin: user.role === 'admin' },
    order,
  );
  return { success: true, data: { order: result.order } };
});
```

Restore `sessionOrder` in the cached base light state. In `filterLightStateForUser()`, replace it with the canonical projection filtered to the authenticated user's owned session IDs; never pass the cached global array through to a regular user. Admin and single-user status retain the global projection.

Wire `TabLayoutService.broadcastSessionOrder` to the specialized SSE manager method through `WebServer` and the route ports/mocks. Do not add or change a browser handler.

- [ ] **Step 6: Run compatibility, security, and HTTP tests**

Run:

```bash
npm test -- test/routes/session-order-routes.test.ts test/session-order-sse.test.ts test/http-contract.test.ts test/tab-layout-service.test.ts
```

Expected: all named files pass, including same-owner cross-device delivery, other-user nondelivery, admin-global delivery, and filtered status.

- [ ] **Step 7: Commit the restored compatibility boundary**

Run:

```bash
git add -- src/web/session-order-sse.ts src/web/sse-stream-manager.ts src/web/routes/session-routes.ts src/web/server.ts src/web/ports/session-port.ts test/session-order-sse.test.ts test/routes/session-order-routes.test.ts test/http-contract.test.ts test/mocks/mock-route-context.ts
git commit -m "fix(tabs): COD-359 preserve legacy ordering clients"
```

### Task 8: Complete Integration Verification, Scope Audit, and Release Metadata

**Files:**
- Create: `.changeset/calm-tabs-foundation.md`
- Modify only if a focused regression exposes missing historical wiring: files already named in Tasks 1-7

- [ ] **Step 1: Run the complete focused model/service/API set**

Run:

```bash
npm test -- test/tab-layout.test.ts test/tab-layout-persistence.test.ts test/tab-layout-legacy-order.test.ts test/state-store-tab-layout.test.ts test/tab-layout-service.test.ts test/tab-layout-restore-gate.test.ts test/routes/tab-layout-routes.test.ts test/tab-layout-sse.test.ts test/routes/session-order-routes.test.ts test/session-order-sse.test.ts test/http-contract.test.ts
npm test -- test/sse-registry-parity.test.ts
```

Expected: every named file passes with no skipped COD-359 regression.

- [ ] **Step 2: Run the complete focused lifecycle set**

Run:

```bash
npm test -- test/session-cleanup.test.ts test/routes/ralph-routes.test.ts test/routes/webview-routes.test.ts test/cron-service.test.ts test/routes/system-routes.test.ts
```

Expected: every named file passes; restoration failure cannot unlock deletion and stale cleanup performs its destructive action once.

- [ ] **Step 3: Run an isolated server API smoke test**

Add or extend a named test in `test/http-contract.test.ts` so one Fastify instance proves: legacy PUT remains writable, owner-scoped GET succeeds, a direct-first matching PUT creates one version, and a stale PUT returns `409` without a store mutation or SSE event.

Run:

```bash
npm test -- test/http-contract.test.ts -t "tab layout foundation smoke"
```

Expected: PASS.

- [ ] **Step 4: Add the minor changeset**

Create `.changeset/calm-tabs-foundation.md` with exactly:

```markdown
---
"aicodeman": minor
---

Add the owner-scoped tab-layout model, persistence, API, lifecycle repair, and synchronized legacy ordering foundation.
```

- [ ] **Step 5: Run static and production gates**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run check:lockfile
npm run check:frontend-syntax
npm run build
```

Expected: every command exits `0`. If formatting alone fails, run `npm run format`, inspect the resulting diff, and repeat `npm run format:check`.

- [ ] **Step 6: Audit the frozen feature boundary**

Run:

```bash
git diff --check
git diff --name-status 88bb98de...HEAD
git diff 88bb98de...HEAD -- src/web/public/app.js src/web/public/styles.css src/web/public/index.html
rg -n "Focus|recoveryBase|caseDefault|semantic operation|Session Bridge" src/tab-layout* src/web/routes/tab-layout-routes.ts
```

Expected:

- `git diff --check` is silent.
- The browser app/CSS/HTML diff is empty; `src/web/public/constants.js` may contain only the public event token.
- The scope scan finds no post-cutpoint feature implementation.
- Every changed production file maps to the responsibility list above or a historical lifecycle integration named in Task 3.

- [ ] **Step 7: Commit release metadata and any final test-only smoke wiring**

Run:

```bash
git add -- .changeset/calm-tabs-foundation.md test/http-contract.test.ts
git commit -m "chore: COD-359 add tab layout foundation changeset"
```

If `test/http-contract.test.ts` did not change in Step 3, stage only the changeset.

- [ ] **Step 8: Verify final branch state without pushing**

Run:

```bash
git status --short
git log --oneline --decorate 88bb98de..HEAD
git diff --stat 88bb98de...HEAD
```

Expected: clean status; the nine audited historical commits, focused COD-359 correction commits, and final changeset commit are present. Stop for review. Do not push, merge, or deploy until the user explicitly selects that finishing action.
