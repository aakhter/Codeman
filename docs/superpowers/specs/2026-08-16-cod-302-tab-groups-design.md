# COD-302: Tab Groups in the Vertical Session Rail

## Summary

Codeman will support named, ordered groups in the vertical tab rail. Each session or saved webview belongs to at most one group. Groups can be expanded or collapsed, reordered, renamed, and deleted. Group names, membership, and ordering persist on the server per owner and sync across that owner's devices. Collapse state remains local to each browser.

When a group is collapsed, Codeman hides its inactive tabs but continues to show the active tab: the highlighted tab whose content is currently displayed. If a webview is highlighted, a background session does not count as active even though `activeSessionId` remains set internally.

Session Bridge-created sessions inherit their parent's placement. Every child keeps one stored layout ref, but an automatically placed child is normalized directly after its parent subtree and follows that subtree when it moves. Moving a child independently changes its placement to `manual`; the user can later choose **Follow parent again**.

## Goals

- Create, name, rename, reorder, collapse, expand, and delete tab groups.
- Group both agent sessions and saved webviews in one vertical-rail layout.
- Keep an item in no more than one group and render ungrouped items last.
- Persist shared layout per owner across server restarts and devices.
- Keep collapse preferences per device.
- Preserve access to the highlighted tab when its group is collapsed.
- Keep Session Bridge-created descendants with their parent unless explicitly moved.
- Preserve useful flat behavior and compatibility consumers in horizontal and phone layouts.

## Non-goals

- Synchronizing whether a saved webview is currently open on a device.
- Supporting nested user-created groups.
- Showing group headers in the horizontal or phone tab strip.
- Replacing `parentSessionId` with a second parent/child model.
- Automatically moving a manually placed or orphaned child back to a restored parent.
- Removing legacy `sessionOrder` in the same release.

## Data Model

The server stores layouts by authenticated owner. Single-user installations use the reserved `@single` key.

```ts
type TabRefKind = 'session' | 'webview';

interface TabRef {
  kind: TabRefKind;
  id: string;
  placement?: 'manual';
}

interface TabGroup {
  id: string;
  name: string;
  refs: TabRef[];
}

interface TabLayout {
  version: number;
  groups: TabGroup[];
  ungrouped: TabRef[];
  updatedAt: string;
}

interface AppState {
  tabLayouts?: Record<string, TabLayout>;
}
```

`ungrouped` is a real ordered array, not a synthetic group. Every owner-owned session and saved webview has exactly one stored ref across the group arrays and `ungrouped`; flattening reorders refs but never synthesizes a second copy. Session and webview namespaces remain distinct through `kind`. `placement: 'manual'` means that lineage does not control the ref's placement. The name intentionally avoids collision with `Session.pinned`, which means that a killed session survives as a stopped record.

The server validates a maximum of 32 groups, group names of 1–60 trimmed characters, unique group IDs, unique refs, known ref kinds, and a bounded total ref ceiling. The ceiling accounts for the configured session cap, the configured webview cap, persisted stopped sessions, and limited migration headroom. Current defaults include `MAX_CONCURRENT_SESSIONS = 50` globally and `MAX_WEBVIEWS = 50` per owner. Invalid writes fail atomically.

## Ownership, Persistence, and Migration

The authenticated username selects the layout in multiuser mode. Routes never accept an owner key from the client. Even administrators may place only refs owned by their own layout owner; administrative visibility does not permit cross-owner layout membership.

Owner layouts are never included in the shared cached light-state object. The client fetches its layout through `GET /api/tab-layout` after initial state load. `StateStore.buildPartialJson` must explicitly serialize `tabLayouts`; a restart round-trip test protects the handwritten allowlist.

A valid session ref is one present in the live `this.sessions` map or in persisted `store.state.sessions`, including a pinned stopped session. Startup must await `restoreMuxSessions()` before any reconciliation that could classify a ref as orphaned. Reads and boot-time normalization never delete unknown refs. Pruning occurs only from explicit, owner-resolved deletion and cleanup paths after restoration, including `removeSession`, `demoteOrRemoveSession`, `cleanupStaleSessions`, and saved-webview deletion. A demoted pinned session remains valid.

Migration is idempotent:

1. If an owner already has a layout, keep it and normalize ordering without pruning refs.
2. Otherwise, filter the single global `sessionOrder` to sessions owned by that layout owner and copy those refs into `ungrouped` in order.
3. Append remaining valid owner sessions deterministically by creation time.
4. Mark every migrated session with a live `parentSessionId` as `placement: 'manual'` so the upgrade preserves the user's existing order. The user may later select **Follow parent again**.
5. Add saved webview refs in server store order. Browser-local open-tab order cannot seed a server migration.
6. Treat the new layout as authoritative. During the compatibility release, `this.sessionOrder` is a derived flattened session projection and `PUT /api/session-order` becomes read-only with a migration response directing callers to `/api/tab-layout`; there are not two independent writers.

Legacy removal is tracked separately in [COD-312](https://aakhter.atlassian.net/browse/COD-312).

## Server API, Events, and Concurrency

The server is authoritative for the shared layout.

- `GET /api/tab-layout` returns the authenticated owner's normalized `TabLayout`.
- `PUT /api/tab-layout` accepts the desired layout plus `baseVersion`.
- Any `baseVersion !== current.version`, whether lower or higher, returns HTTP 409 with the current normalized layout.
- A matching version validates and stores the layout, increments `version`, and publishes `tab:layoutChanged` with `{ version }` only.
- `deriveSseHint` handles the `tab:` prefix explicitly and returns `{ username: owner, sessionScoped: true }`.
- The event never contains groups, names, or refs. The receiving client refetches `GET /api/tab-layout`; an administrator receiving a broader event learns only a version and cannot overwrite another owner.

The client applies a semantic edit optimistically. The pure model defines `moveRef`, `createGroup`, `renameGroup`, `deleteGroup`, `reorderGroup`, `setManualPlacement`, and `followParent` operations. On a 409, the client replaces its base with the returned layout, reapplies the original operation once, and retries. It does not silently merge arrays or retry indefinitely. If the operation no longer applies, the client adopts server state and reports the failure.

Every server-side mutation—including root or child session creation, session removal, orphan materialization, saved-webview deletion, and post-restore cleanup—increments the layout version and emits the version-only event. This prevents a stale client from restoring a deleted ref.

## Ordering and Parent/Child Inheritance

One framework-independent module, `src/tab-layout.ts`, owns validation, normalization, semantic operations, and flattening. DOM rendering, compatibility order, lineage geometry, and keyboard navigation consume its results rather than implementing their own order rules.

Every visible ref is stored exactly once. For each non-manual child whose `parentSessionId` resolves to a same-owner parent, normalization relocates that stored ref to the parent's group and directly after the parent's existing descendant subtree. Flattening emits a preorder depth-first subtree without duplicating refs. Sibling order follows their stored order; a newly created child is inserted after the parent's current subtree.

Rules for descendants:

- The parent must exist in the same owner's valid session set and layout.
- A child without manual placement inherits the parent's group and moves with the entire subtree.
- Moving a child independently writes `placement: 'manual'` at the selected location.
- **Follow parent again** removes manual placement and immediately normalizes the subtree.
- A visited set breaks malformed parent cycles deterministically; refs on the broken edge become manual in their current position.
- When a parent is explicitly removed after restoration, each direct non-manual child is materialized in its current stored location with manual placement in the same versioned server mutation.
- A dangling child is not automatically re-adopted if a session with the former parent ID later returns.
- Ownership is checked when resolving every parent edge.

Moving a parent moves one contiguous descendant block. Drag previews and keyboard moves show and operate on that block.

## Vertical Rail Experience

Each group has a header with an expand/collapse button, its editable name, an item count, a drag handle, and an actions menu. The group containing the highlighted tab may receive a subtle active indicator. Group names use `data-i18n-skip` because they are user content.

Expanded groups show all locally renderable members. Collapsed groups show the header and, when applicable, the single highlighted member. Other members remain in the complete flattened order but are absent from the visible DOM.

Alt+1–9 numbers only the visible, locally renderable tab order, preserving the invariant that each number matches a painted badge. Hidden members are reached by expanding the group, the command palette, or Alt+`[`/`]`. Previous/next traversal uses the complete locally renderable flattened order, including collapsed members; selecting a hidden target makes it the highlighted visible member without expanding the group.

The ungrouped section follows all named groups. It has a stable label but is not collapsible and cannot be renamed or deleted.

Create and group rename reuse the existing `_inlineRenameActive` guard so debounced rendering cannot destroy an input mid-keystroke. Deleting a group moves its stored refs to `ungrouped` without deleting sessions or webviews. COD-307 replaces the existing HTML5 session-tab drag listeners with one pointer-event drag system for the shared container, including touch support and explicit zones before, inside, and after groups. Menus and keyboard commands expose equivalent move and reorder operations.

## Rendering and Compatibility Order

The renderer derives two lists from the pure model:

- The complete flattened owner-session order includes members hidden only by collapse. It remains available as `this.sessionOrder` during the compatibility release for the command palette, home cards, mobile overview, terminal cleanup, lineage, and session switching.
- The visible flattened ref order intersects the complete layout with live sessions and locally open webviews, then removes collapsed inactive members. It drives DOM identity, Alt+1–9 badges, and roving focus.

Incremental rendering compares the ordered visible ref list, not session-ID sets. Its cache key includes layout version, a stable hash of collapsed group IDs, orientation, and locally open webview IDs. A pure reorder therefore invalidates the DOM, while unchanged layouts retain incremental updates.

## Collapse and Lineage Rendering

Collapsed group IDs are stored locally under `codeman:tab-groups-collapsed`. The client removes IDs for groups that no longer exist. This state is intentionally excluded from server persistence and SSE. A failed localStorage read or write falls back to all groups expanded.

If a lineage connection ends at a hidden tab, its visual endpoint is proxied to that group's header and drawn dimmed or dotted. If both endpoints proxy to the same header, no line is drawn. Geometry invalidation uses the same layout, collapse, orientation, and open-webview cache key as tab rendering.

## Saved Webviews

Saved webview placement is shared because the server layout stores its `webview` ref. Whether that webview is open remains local to the device. Rendering intersects server refs with locally open webviews:

- Open saved webviews render in their shared position.
- Unopened saved webviews retain their server placement but do not render or receive Alt+number indices.
- Opening one restores it to its shared position.
- Permanently deleting one removes its ref in a versioned server mutation.

The existing `codeman-webview-order` array is migrated once into a device-local open set; its order does not seed the server layout. New code persists openness under `codeman-webview-open` and uses the server layout for order.

## Horizontal and Phone Behavior

Horizontal and phone layouts do not show group headers or collapse controls. They use the complete flattened grouped order followed by ungrouped refs. Device-local collapse state has no effect there. `applyTabOrientation` triggers a structural rerender so headers disappear when the single `#sessionTabs` container moves back to the header. Mobile behavior must be checked manually because relevant mobile tests are excluded from the normal CI path.

## Accessibility

The outer `#sessionTabs` container no longer owns `role="tablist"`. In vertical mode, each group section contains a header button followed by an inner tablist containing only actual tabs; the ungrouped section follows the same structure without collapse controls. In horizontal and phone modes, the rendered flat tabs use one inner tablist.

This feature introduces roving `tabindex`; current tabs all use `tabindex="0"`. Hidden collapsed members are removed from the focus sequence. Vertical Up/Down traverses visible headers and tabs, horizontal Left/Right traverses tabs, and Home/End use the current orientation's interactive sequence. Header buttons expose `aria-expanded`, names, counts, and action labels. All pointer operations have menu and keyboard equivalents, and focus returns predictably after rename, delete, and move operations.

## Error Handling

- Validation errors revert the optimistic edit and display a concise error.
- A version conflict is rebased once; a second conflict stops and adopts server state.
- Reads do not destructively prune unknown refs. Explicit deletion and post-restore cleanup are server-owned and versioned.
- Malformed ancestry cannot block rendering: cycles break at the repeated edge and dangling children become manually placeable.
- Local collapse or open-webview storage failures do not block the server layout.

## Security and Privacy

- Resolve ownership exclusively from authenticated request context.
- Fetch layouts only from the owner-scoped route; do not include them in shared light state.
- Route version-only SSE hints by authenticated username and include no private layout content.
- Reject refs not owned by the layout owner, including for administrators.
- Escape group names as text and never interpret them as HTML.
- Set an explicit route body limit and coalesce rapid writes per owner; the application has no general existing request rate limiter to reuse.

## Testing Strategy

Pure unit tests cover the every-ref-stored invariant, limits, deduplication, semantic operations, preorder normalization, stable sibling order, manual/follow-parent behavior, cycles, orphan materialization, visible and complete flattening, and numbering. Route tests use `app.inject()` for authentication, owner-only refs, exact version equality, conflict rebase inputs, body limits, version-only SSE hints, create/delete version increments, pruning hooks, and multiuser isolation. State tests cover global-order filtering, migration-preserved child positions, the handwritten serialization allowlist, and full restart round trips. Frontend tests cover structural and incremental rendering, collapse persistence, highlighted-tab visibility, visible-only badges, complete previous/next traversal, webview intersection, inline rename, pointer drag intent, keyboard equivalents, ARIA, orientation changes, and compatibility consumers. Horizontal and phone layouts receive focused automated coverage plus a manual mobile check.

## Delivery Slices and Dependencies

1. [COD-308](https://aakhter.atlassian.net/browse/COD-308) — schema, semantic operations, descendant normalization, cycle handling, and pure flattening.
2. [COD-304](https://aakhter.atlassian.net/browse/COD-304) — owner-keyed persistence, serialization, restart coverage, and non-destructive migration.
3. [COD-303](https://aakhter.atlassian.net/browse/COD-303) — ownership, exact version concurrency, version-only SSE, and versioned deletion/pruning hooks.
4. [COD-306](https://aakhter.atlassian.net/browse/COD-306) — vertical rendering, visible/complete order, compatibility projection, and flat fallbacks.
5. [COD-305](https://aakhter.atlassian.net/browse/COD-305) — device-local collapse, highlighted-tab visibility, and lineage proxies.
6. [COD-307](https://aakhter.atlassian.net/browse/COD-307) — accessible editing, roving focus, and replacement pointer drag/drop.
7. [COD-309](https://aakhter.atlassian.net/browse/COD-309) — independent child move, **Follow parent again**, subtree drag preview, and orphan UI.
8. [COD-310](https://aakhter.atlassian.net/browse/COD-310) — saved-webview shared placement and device-local open state.
9. [COD-312](https://aakhter.atlassian.net/browse/COD-312) — later removal of the compatibility `sessionOrder` surface; intentionally outside the epic delivery path.

Blocking order is `COD-308 → {COD-304, COD-303, COD-306, COD-309}`, `COD-303 → COD-306`, and `COD-306 → {COD-305, COD-307, COD-310}`. The recommended landing sequence is COD-308, COD-304, COD-303, COD-306, COD-305, COD-307, COD-309, and COD-310. The parent tracking epic is [COD-302](https://aakhter.atlassian.net/browse/COD-302).

## Review Record

Claude Opus reviewed the architecture twice through temporary Codeman Session Bridge children. The second pass cross-checked the committed design against the implementation and required the every-visible-ref-stored invariant, non-destructive startup, owner-safe layout fetch and version-only SSE, manual-placement terminology, visible-only numeric badges, explicit compatibility consumers, replacement pointer drag/drop, and revised Jira boundaries. This revision incorporates those findings.
