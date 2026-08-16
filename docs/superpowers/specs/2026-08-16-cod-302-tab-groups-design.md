# COD-302: Tab Groups in the Vertical Session Rail

## Summary

Codeman will support named, ordered groups in the vertical tab rail. Each session or saved webview belongs to at most one group. Groups can be expanded or collapsed, reordered, renamed, and deleted. Group names, membership, and ordering persist on the server per owner and sync across that owner's devices. Collapse state remains local to each browser.

When a group is collapsed, Codeman hides its inactive tabs but continues to show the active tab—the tab whose content is currently displayed. Selecting a hidden member through a keyboard shortcut makes that member active and therefore visible without expanding the group.

Session Bridge-created sessions inherit their parent's placement. An unpinned child and its descendants remain directly after the parent as a preorder subtree and follow the parent when it moves. Moving a child independently pins it in its new location; the user can later choose **Follow parent again**.

## Goals

- Create, name, rename, reorder, collapse, expand, and delete tab groups.
- Group both agent sessions and saved webviews in one vertical-rail layout.
- Keep an item in no more than one group and render ungrouped items last.
- Persist shared layout per owner across server restarts and devices.
- Keep collapse preferences per device.
- Preserve access to the active tab when its group is collapsed.
- Keep Session Bridge-created descendants with their parent unless explicitly moved.
- Preserve useful flat behavior in horizontal and phone layouts.

## Non-goals

- Synchronizing whether a saved webview is currently open on a device.
- Supporting nested user-created groups.
- Showing group headers in the horizontal or phone tab strip.
- Replacing `parentSessionId` with a second parent/child model.
- Automatically moving a pinned or dangling child back to a restored parent.

## Data Model

The server stores layouts by authenticated owner. Single-user installations use the reserved `@single` key.

```ts
type TabRefKind = 'session' | 'webview';

interface TabRef {
  kind: TabRefKind;
  id: string;
  pinned?: true;
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

`ungrouped` is a real ordered array, not a synthetic group. A ref may occur once across all group arrays and `ungrouped`. Session and webview namespaces remain distinct through `kind`.

The server validates a maximum of 32 groups, group names of 1–60 trimmed characters, unique group IDs, unique refs, known ref kinds, and a total ref ceiling derived from configured session and webview limits plus bounded migration headroom. Invalid writes fail atomically.

## Ownership and Persistence

The authenticated username selects the layout in multiuser mode. Routes and events never accept a different owner key from the client. Light-state responses omit other owners' layouts, and layout SSE notifications are sent only to clients for the affected owner.

`StateStore.buildPartialJson` must explicitly serialize `tabLayouts`; a restart round-trip test protects the handwritten allowlist. The server—not clients—removes refs when sessions or saved webviews are permanently deleted. It also prunes invalid refs during normalization so obsolete `sessionOrder` entries cannot accumulate again.

Migration is idempotent:

1. If an owner already has a layout, keep and normalize it.
2. Otherwise, copy valid session IDs from the owner's existing `sessionOrder` into `ungrouped` in order.
3. Append remaining visible sessions deterministically by creation time.
4. Add saved webview refs according to their current saved order.
5. Retain `sessionOrder` for one compatibility release, then remove its writers and readers in a follow-up cleanup.

## Server API and Concurrency

The server is authoritative for the shared layout.

- `GET /api/tab-layout` returns the authenticated owner's normalized `TabLayout`.
- `PUT /api/tab-layout` accepts the desired layout plus `baseVersion`.
- A matching `baseVersion` validates and stores the layout, increments `version`, and publishes an owner-scoped `tab:layoutChanged` event.
- A stale `baseVersion` returns HTTP 409 with the current normalized layout.

The client applies an edit optimistically. On a 409, it replaces its base with the returned layout, rebases the original semantic intent once, and retries. It does not silently merge whole arrays or continue retrying. If the intent no longer applies—for example, the target group was deleted—the client restores server state and reports the failure.

Session creation appends a new root session to `ungrouped`. Child placement is derived from `parentSessionId`, so creating a Session Bridge child does not duplicate it in a stored group array. Deletion and pruning are server operations to ensure all devices converge.

## Ordering and Parent/Child Inheritance

One pure module, `src/tab-layout.ts`, owns normalization, semantic transforms, and flattening. Both DOM rendering and Alt+number shortcuts consume the same flattened result.

For every stored root or pinned ref, flattening emits the ref followed by its unpinned descendants in preorder depth-first order. Sibling order uses an explicit stored override when present and otherwise session creation time. The relationship is derived from `parentSessionId`; the server does not persist a second static copy of an inherited child's position.

Rules for descendants:

- The parent must exist in the same owner's visible session set and layout.
- An unpinned child inherits the parent's group and moves with the entire subtree.
- Moving a child independently writes `pinned: true` at the selected location.
- **Follow parent again** removes the pinned placement, allowing derived placement to resume.
- A visited set breaks malformed parent cycles deterministically.
- If a parent disappears, its child stays at its current independently normalized placement and is not automatically re-adopted if that parent later returns.
- Ownership is checked again when resolving every parent edge.

Moving a parent therefore moves one contiguous descendant block. Drag previews and keyboard moves show and operate on that block, preventing descendants from appearing to be left behind.

## Vertical Rail Experience

Each group has a header with an expand/collapse button, its editable name, an item count, a drag handle, and an actions menu. The active group may also receive a subtle active indicator. Group names use `data-i18n-skip` because they are user content.

Expanded groups show all locally renderable members. Collapsed groups show the header and, if applicable, the single active member. Other members remain in the logical flattened order but are absent from the visible DOM. Choosing a hidden member with Alt+number makes it active and visible while the group remains collapsed.

The ungrouped section follows all named groups. It has a stable label but is not collapsible and cannot be renamed or deleted.

Create and rename use inline editing. Deleting a group moves its directly stored refs to `ungrouped` without deleting sessions or webviews. Pointer-event drag and drop supports explicit zones before, inside, and after groups. Menus and keyboard commands expose equivalent move and reorder actions.

## Collapse and Lineage Rendering

Collapsed group IDs are stored locally under `codeman:tab-groups-collapsed`. The client removes IDs for groups that no longer exist. This state is intentionally excluded from server persistence and SSE.

If a session-lineage connection ends at a hidden tab, its visual endpoint is proxied to that group's header and drawn dimmed or dotted. If both endpoints proxy to the same header, no line is drawn. Layout invalidation includes the server layout version and a hash of collapsed IDs so incremental rendering cannot retain stale geometry.

## Saved Webviews

Saved webview placement is shared because the layout stores its `webview` ref. Whether that webview is open remains local to the device. Rendering intersects server refs with locally open webviews:

- Open saved webviews render in their shared position.
- Unopened saved webviews retain their server placement but do not render or receive Alt+number indices.
- Opening one restores it to its shared position.
- Permanently deleting one removes its ref server-side.

## Horizontal and Phone Behavior

Horizontal and phone layouts do not show group headers or collapse controls. They use the same flattened grouped order, followed by ungrouped refs, and preserve existing tab-strip interactions. Device-local collapse state has no effect there. Mobile behavior must be checked manually because relevant mobile tests are excluded from the normal CI path.

## Accessibility

The tablist owns only actual tabs. Group headers are buttons outside the tablist or inside presentation-only wrappers, avoiding invalid ARIA nesting. Tabs retain roving `tabindex`; hidden collapsed members are removed from the focus sequence. Header buttons expose `aria-expanded`, names, counts, and action labels. All pointer drag operations have menu and keyboard equivalents, and focus returns predictably after rename, delete, and move operations.

## Error Handling

- Validation errors leave the optimistic UI edit reverted and display a concise error.
- A version conflict is rebased once; a second conflict stops and adopts server state.
- Unknown refs are pruned only by server normalization, never silently invented by clients.
- Malformed ancestry cannot block rendering: cycles break at the repeated node and dangling children remain independently placeable.
- A failed localStorage read or write falls back to all groups expanded without blocking layout use.

## Security and Privacy

- Resolve ownership exclusively from the authenticated request context.
- Filter initial state, route results, and SSE events consistently.
- Reject refs to sessions or webviews the owner cannot access.
- Escape group names as text and never interpret them as HTML.
- Apply existing request-body and rate limits to layout updates.

## Testing Strategy

Pure unit tests cover normalization, limits, deduplication, flattening, numbering, semantic edits, preorder subtrees, pin/unpin behavior, cycles, and dangling parents. Route tests use `app.inject()` for authentication, ownership, version conflicts, validation, pruning, create/delete integration, and multiuser event isolation. State tests perform migration and full restart round trips. Frontend tests cover rendering, collapse persistence, active-tab visibility, webview intersection, drag/drop intent, keyboard equivalents, ARIA, and incremental invalidation. Horizontal and phone layouts receive focused automated coverage plus a manual mobile check.

## Delivery Slices

1. [COD-308](https://aakhter.atlassian.net/browse/COD-308) — pure tab-layout model and transforms.
2. [COD-304](https://aakhter.atlassian.net/browse/COD-304) — owner-scoped persistence and migration.
3. [COD-303](https://aakhter.atlassian.net/browse/COD-303) — authoritative API, conflicts, pruning, and SSE.
4. [COD-306](https://aakhter.atlassian.net/browse/COD-306) — vertical rendering and flat fallbacks.
5. [COD-305](https://aakhter.atlassian.net/browse/COD-305) — device-local collapse and lineage proxies.
6. [COD-307](https://aakhter.atlassian.net/browse/COD-307) — accessible editing and drag/drop.
7. [COD-309](https://aakhter.atlassian.net/browse/COD-309) — Session Bridge descendant inheritance and pinning.
8. [COD-310](https://aakhter.atlassian.net/browse/COD-310) — saved webviews, compatibility, accessibility, and cleanup.

The slices are independently reviewable but should land in model/persistence/API order before interaction work. The parent tracking epic is [COD-302](https://aakhter.atlassian.net/browse/COD-302).

## Review Record

The architecture was reviewed by Claude Opus through a temporary Codeman Session Bridge child. The final design incorporates its required changes: explicit owner scoping, real optimistic concurrency, server-owned deletion and pruning, restart serialization coverage, separation of shared webview placement from local open state, one canonical flatten function, derived descendant placement, accessible group semantics, and collapse-aware lineage rendering.
