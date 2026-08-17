# Focus Smart Group Design

## Summary

Add a manual, persistent Focus flag for session tabs and saved web tabs. Focused tabs remain in their canonical real group or Ungrouped location and also appear as shortcuts in a derived Focus smart group at the top of the vertical tab rail.

“Focus” is the user-facing and internal feature term. Existing `activeSessionId` and `activeWebviewId` continue to mean the one currently selected tab; the new flag must not overload that meaning.

## Goals

- Let users add or remove Focus from session and saved web tabs.
- Synchronize Focus flags across restarts, browsers, and devices for the same owner.
- Show renderable focused tabs in a fixed, collapsible Focus smart group above real groups in the vertical rail.
- Preserve canonical placement, ordering, numbering, traversal, drag/drop, and lineage behavior.
- Keep every representation of a tab synchronized and accessible.

## Non-goals

- Automatically infer Focus from working, idle, alert, or selected state.
- Render the Focus smart group in horizontal or phone layouts.
- Make Focus a real layout container, drag destination, or independently reorderable list.
- Add a separate Focus ordering system.
- Rename, delete, or reorder the Focus group.

## Data model

Extend the canonical stored tab reference with one optional property:

```ts
interface TabRef {
  kind: 'session' | 'webview';
  id: string;
  placement?: 'manual';
  focus?: true;
}
```

The absence of `focus` means unfocused. Validators accept only literal `true` when the property is present; `false`, other booleans, and other values are invalid. Serializers omit the property for unfocused references.

There is still exactly one stored reference for each `(kind, id)`. Focus does not add a group or reference, does not count against group or reference limits, and does not weaken duplicate-reference validation.

Every operation that clones or relocates a reference must preserve `focus`, including normalization, manual moves, group deletion, Session Bridge parent following, conflict recovery, and browser optimistic replay. Removing the canonical reference through session or saved-webview deletion removes its Focus state naturally.

Closed saved web tabs keep their canonical reference and therefore retain Focus. They are not renderable while closed and reappear in Focus when reopened. Metadata-unknown references retain the stored flag under the existing non-destructive normalization rule but do not render until they become renderable again.

## Semantic operation and API behavior

Add a semantic layout operation:

```ts
{
  type: 'setFocus';
  ref: {
    kind: 'session' | 'webview';
    id: string;
  }
  focused: boolean;
}
```

The operation uses the existing owner-scoped, versioned tab-layout PUT path. The server validates that the operation is well formed and that the canonical reference exists in the authenticated owner's layout. It sets `focus: true` when `focused` is true and removes the property when false.

The operation is idempotent. Applying the requested value to an already matching reference produces no semantic layout change, no version bump, and no SSE event. Stale-base behavior, advisory recovery-prefix inference, one-conflict client rebase, ownership checks, and malformed-request 400 versus stale-valid 409 behavior remain consistent with existing semantic operations.

A successful mutation persists through `StateStore` and broadcasts through the existing owner-routed tab-layout SSE event. No new endpoint, event type, or storage file is required.

## Projection and ordering

The canonical layout projection continues to produce the complete and visible reference orders used by numbering, Alt-number activation, next/previous traversal, command palette, home/mobile views, lineage, cleanup, and placement operations.

For vertical rendering only, projection additionally derives `focusRefs` by scanning canonical groups in order followed by Ungrouped and selecting renderable references with `focus: true`. This preserves the tab's existing overall layout order without storing another list.

`focusRefs` must not be inserted into canonical `visibleRefs`, complete session order, group sections, lineage endpoint maps, or drag/drop indexes. A focused tab therefore appears once in every behavioral ordering and may have one additional visual shortcut.

The derived Focus section and its shortcut copies are vertical-only. Horizontal desktop and phone projections remain flat and contain no Focus group or shortcut duplicates. The Focus flag remains manageable from each canonical row's existing action menu in every layout, and canonical rows may show the small Focus marker in every layout so the persisted state is understandable.

## Vertical rail rendering

When at least one focused reference is currently renderable, render a fixed Focus section above all real named groups and Ungrouped. When none are renderable, omit the section.

The Focus header:

- is named `Focus` and is not user-editable;
- displays the number of currently rendered shortcuts;
- supports the same expand/collapse control and `aria-expanded` behavior as other group headers;
- has no overflow menu or drag handle;
- cannot receive drops or participate in group reorder operations.

Its collapsed state is stored locally using a reserved dedicated collapse identity that cannot collide with a real group ID. Stale real-group collapse cleanup must not remove that preference while focused references exist. Collapsing Focus hides every shortcut; it does not use the real-group selected-member exception because the selected canonical row remains available in its true location.

Each Focus shortcut reuses the underlying tab's icon, name, status, load/alert/placement badges, and activation behavior. It omits the Alt-number badge and drag handle. Its overflow menu contains exactly one action: `Remove from Focus`. Settings, detach, close, move, placement, and other destructive or structural actions remain available only from the canonical row.

The canonical row displays a small, non-interactive Focus marker. Its overflow and Shift+F10 action menus show `Add to Focus` or `Remove from Focus` according to authoritative or optimistic state.

## Selection, keyboard, and accessibility

Canonical rows remain the sole `role="tab"` representations and preserve the single `aria-selected="true"` invariant. Focus shortcuts are explicitly labeled shortcut controls rather than duplicate tabs. Their accessible names include `Focus shortcut`, and Enter or Space activates the underlying tab.

When the underlying tab is currently selected, the shortcut receives a subtler current-target visual treatment and `aria-current="page"`; it does not receive canonical selected-tab semantics. The canonical row keeps the existing strong active treatment.

Focus shortcuts may participate in the vertical tree's roving DOM focus so keyboard users can reach and activate them. They do not participate in application next/previous tab traversal, Alt-number activation, or complete session ordering. The Focus header supports the same Left/Right collapse navigation as other headers.

Duplicate-sensitive updates must operate on every representation of a `(kind, id)`, not the first matching node. This includes name, icon, status, task/load/alert/placement badges, Focus marker/menu label, selected/current styling, deletion, and accessibility attributes. Shortcut DOM must use representation-specific identity attributes and must not duplicate unique element IDs.

## Editing and failure behavior

Selecting `Add to Focus` or `Remove from Focus` queues the semantic operation through the existing edit coordinator. The UI may optimistically add or remove the shortcut and marker. The accepted server response atomically adopts both canonical layout and derived Focus projection.

On a single 409, the coordinator adopts the authoritative response and replays the semantic intent once using the existing recovery protocol. A terminal validation, ownership, network, or repeated-conflict failure restores the last authoritative Focus state, leaves no local-only flag, and uses the existing tab-layout edit error surface.

An owner-routed SSE update adopts the newer authoritative state and rebases any pending ordinary and Focus operations with the same generation protections used by other edits. A change from another browser therefore appears without reload and cannot overwrite a newer local navigation selection.

## Lifecycle interactions

- Moving a focused tab between real groups preserves Focus.
- Deleting a real group moves its references to Ungrouped and preserves Focus.
- Session Bridge inherited placement, manual placement, and Follow parent preserve Focus.
- Deleting a session or saved webview prunes its canonical reference and Focus state transactionally.
- Closing a saved web tab hides its shortcut but preserves Focus; reopening restores it in canonical-order position.
- A tab selected through a Focus shortcut behaves exactly like selection through its canonical row.
- Focus shortcuts are never lineage endpoints and never alter connection-line geometry.

## Testing

### Model and service

- Parse, validate, serialize, and normalize `focus: true`; reject invalid values.
- Preserve Focus through every clone/move/group-delete/manual/follow-parent path.
- Remove Focus with canonical deletion and retain it for closed saved web tabs.
- Prove `setFocus` true/false, missing-reference rejection, idempotency without version/event changes, owner isolation, limits, malformed exact-base 400, and stale-valid 409 behavior.
- Cover conflict-prefix recovery when Focus is mixed with ordinary and Follow-parent operations.

### Browser coordinator and rendering

- Optimistic add/remove, accepted adoption, one-conflict replay, failure rollback, unload recovery, stale response suppression, and SSE synchronization.
- Focus ordering follows canonical group/Ungrouped order after moves and never changes canonical numbering or traversal.
- Vertical Focus section placement, empty omission, fixed header controls, collapse persistence, shortcut activation, marker/menu state, and no drag/drop targets.
- Duplicate updates synchronize both representations without duplicate IDs or first-match bugs.
- Canonical row alone owns selected-tab semantics; shortcut current treatment and keyboard activation are accessible.
- Closed/reopened saved web tabs and deleted session/webview behavior.
- Horizontal desktop and phone layouts contain no Focus section or shortcut duplicates.

### Real browser and staging

- Chromium exercises mouse and keyboard flag toggling, shortcut activation, collapse/focus restoration, current styling, and canonical numbering/traversal.
- Multi-context staging verifies same-owner synchronization and different-owner isolation.
- Restart staging verifies persistence; saved-webview close/reopen verifies retained Focus.
- Production verification, when deployment is separately authorized, checks deployed asset hashes, live Focus behavior, and zero uncaught page errors.

## Rollout and compatibility

The field is optional, so existing layouts migrate without a rewrite and remain unfocused by default. Older clients that parse references through strict reconstruction would drop Focus if allowed to write; therefore all shipping server and browser parsers/writers must land atomically in the same deployment, and compatibility tests must prove no legacy writer remains.

No version bump, production deployment, or Jira disposition is implied by this design document. Those actions follow the repository's normal implementation and deployment workflow.
