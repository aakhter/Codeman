# COD-327 Vertical Console Layout Design

## Problem

When the user selects the vertical tab rail, the session list can be re-parented into the header after startup while
`data-tab-orientation="vertical"` remains active. Vertical tab styles then make the header as tall as the tab list, pushing
the main terminal area into a short strip at the bottom of the viewport.

The failure is visible after the asynchronous settings refresh. Initial startup correctly applies the session-list layout
and then the tab orientation, but the refresh later calls only `applySessionListLayout()`. In header-list mode, that method
unconditionally takes `#sessionTabs` back from `#tabRail` and places it in `#sessionTabsHost`.

## Design

`applySessionListLayout()` will respect the already-applied tab orientation when it chooses the owner of the single
`#sessionTabs` node:

- The dedicated session sidebar owns the node whenever session-list mode is `sidebar`.
- The vertical tab rail owns the node whenever session-list mode is `header` and the applied tab orientation is
  `vertical`.
- The header host owns the node only when session-list mode is `header` and the applied tab orientation is horizontal.

The method will set `aria-orientation` from the resolved owner so the DOM placement, visual direction, and accessibility
state cannot disagree. `applyTabOrientation()` remains responsible for recalculating orientation when settings or device
class change and will update `aria-orientation` when it moves the tab list. This fix prevents an unrelated session-list
refresh from undoing its settled placement or leaving stale accessibility state.

## Scope

The change is limited to session-tab ownership and its regression coverage. It does not change rail width, sidebar
collapse behavior, tab rendering, terminal sizing, CSS, or settings persistence.

## Testing

Extend `test/session-list-layout.test.ts` with the vertical rail in its DOM harness. The regression test will:

1. Configure header session-list mode and vertical tab orientation.
2. Apply the normal placement sequence so `#sessionTabs` is in `#tabRail`.
3. Reapply `applySessionListLayout()` as the asynchronous settings refresh does.
4. Assert that `#sessionTabs` remains in `#tabRail` and retains `aria-orientation="vertical"`.

A second test will switch tab orientation in both directions and assert that the host and `aria-orientation` agree
immediately after each `applyTabOrientation()` call.

Existing session-list tests continue to verify sidebar precedence, horizontal header placement, collapse behavior, and
the invariant that the same DOM node moves between owners.

## Acceptance Criteria

- A session-list refresh cannot move vertically oriented tabs into the header.
- The header remains one row tall and the main terminal fills the available viewport height.
- Sidebar mode continues to take precedence over the vertical rail.
- Horizontal mode continues to place tabs in the header host.
- `aria-orientation` matches the resolved tab-list owner.
- Focused regression tests, typecheck, lint, formatting, lockfile validation, and the production build pass.
