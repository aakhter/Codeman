# COD-339 Sidebar Actions and Session-Name Font Size Design

## Problem

In the expanded vertical session sidebar, `.tab-info` consumes the row's remaining width and leaves the settings,
detach, and close action cluster at the far edge. Short session names therefore appear disconnected from their actions
and require unnecessary pointer travel.

## Approved interaction

For both simple and rich expanded sidebars, render the existing action cluster inside `.tab-name-row`, immediately
after `.tab-name`, with the existing 0.25rem row gap. Keep the action cluster as a direct child of `.session-tab` in the
header strip and legacy vertical tab rail so those layouts remain unchanged. The active-only visibility policy remains
unchanged. Long names shrink and ellipsize before the non-shrinking action cluster.

## Session-name font size

Add a device-scoped `sessionSidebarFontSize` setting under App Settings → Layout → Tabs. It accepts integer pixel values
from 11 through 18 and defaults to 14. The value is persisted through the existing local/server app-settings path and
is applied before first paint and whenever the session-list layout is reapplied.

Only `.session-sidebar .tab-name` consumes the CSS custom property. Project headings, counts, mode chips, status dots,
action icons, row geometry, touch targets, header tabs, the legacy vertical rail, and the collapsed 44px sidebar remain
unchanged.

## Compatibility and verification

- Preserve inline rename, drag/reorder, active/focus behavior, simple/rich row detail, and handheld drawer behavior.
- Validate the strict settings schema at the 11/18 boundaries and reject out-of-range, fractional, and string values.
- Use a real Chromium geometry test to prove a compact title/action gap, long-name truncation, and font-size scope.
- Run focused Vitest, browser, static, build, and realistic Codeman smoke checks before merge and deployment.
