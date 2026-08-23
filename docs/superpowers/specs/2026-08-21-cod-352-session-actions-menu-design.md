# COD-352: Restore Session Actions in Expanded Vertical Navigation

## Problem

The per-session actions menu still exists and still contains actions such as Focus and Move to Group, but its `⋯` trigger is
not visible in expanded vertical navigation. COD-339 moved `.tab-actions` from a direct child of `.session-tab` into the
`.tab-name-row` so controls could sit beside the session name. The visibility selectors still require the direct-child shape:
`.session-tab:hover > .tab-actions > .tab-more`. They therefore no longer match the expanded grouped rail or expanded sidebar.

Existing Chromium coverage verifies that the action cluster is beside the name and remains within the row, but it does not
inspect the trigger's computed visibility. That allowed the DOM relocation and visibility contract to drift apart.

## Desired Behavior

The expanded grouped vertical rail and expanded sidebar use the same contextual behavior:

- An inactive session's `⋯` trigger is hidden at rest.
- Hovering a session row reveals its trigger.
- Keyboard focus within a session row reveals its trigger.
- The active session's trigger remains visible.
- Coarse-pointer and touch layouts keep the trigger visible without relying on hover.

The menu opens through the existing `openTabRailActionMenu()` path. Its contents and behaviors, including Focus, placement,
Move to Group, session settings, detach, and close, do not change.

## Implementation Boundary

Update only the CSS visibility selectors for `.tab-more` so they recognize both supported action-cluster shapes:

1. Direct-child `.session-tab > .tab-actions`, used by the horizontal header and compact vertical rail.
2. Nested `.session-tab .tab-name-row > .tab-actions`, used by expanded vertical layouts.

Preserve the existing direct-child rules. Scope the new nested rules specifically to the expanded grouped rail and expanded
sidebar through their existing root/layout attributes; do not create a generic descendant rule that could change a future
horizontal layout. Keep every selector anchored to the action cluster and trigger. Do not broadly reveal all row controls,
change action markup, alter group-header menus, modify Focus shortcuts, or replace the existing right-click inline-rename
behavior.

No new error path is required because this is a presentation-state correction. Menu actions retain their existing persistence
and error handling.

## Testing

Extend `test/session-sidebar-ux.browser.test.ts` with real Chromium assertions against the shipping HTML, JavaScript, and CSS.
The regression test must inspect computed `visibility` and `pointer-events`, then click the revealed trigger and assert that the
existing action menu opens. Merely asserting that `.tab-more` exists is insufficient.

Cover both expanded vertical layouts and verify the relevant states: inactive at rest, hovered, keyboard-focused, and active.
Use a touch-enabled Playwright context to verify the coarse-pointer rule against the nested action-cluster shape without
simulating hover. Existing tab-layout action tests remain the source of truth for menu contents and the Focus and Move to Group
operations.

Run the dedicated browser test with the browser-suite configuration, then run the focused structural tests and repository
quality gates. Do not run the bare full test suite from the Codeman-managed session.

## Non-Goals

- Making the trigger permanently visible on all desktop rows.
- Changing gear, detach, or close visibility.
- Adding a row-wide context menu.
- Redesigning session groups, Focus, or tab-layout persistence.
- Changing compact or horizontal navigation behavior beyond preserving it.
