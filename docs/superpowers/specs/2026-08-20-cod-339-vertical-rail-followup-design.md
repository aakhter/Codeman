# COD-339 Vertical Rail Follow-up Design

## Problem and root cause

Production stores two independent layout settings. `sessionListLayout: "sidebar"` selects the newer left session
sidebar, while `sessionListLayout: "header"` plus `tabOrientation: "vertical"` moves the shared tab list into the
older vertical side rail. The approved COD-339 implementation and its browser tests forced only the first layout.
The user's live settings use the second layout, so the saved `sessionSidebarFontSize` value and inline action
placement do not affect the interface shown in the original report.

## Approved behavior

Treat both expanded vertical session-list surfaces as one UX scope:

- The existing **Session Name Font Size** setting applies to session-name text in the newer left sidebar and the
  vertical side rail. It remains an integer device setting from 11 through 18 px.
- In a full-width vertical side rail, the existing settings, detach, and close cluster follows the session name with
  the same compact gap used by the newer sidebar. Long names truncate before the fixed action cluster.
- The legacy compact-width rail keeps its overflow-menu behavior and direct-child action wrapper; moving the full
  cluster into its name row would starve the compact label and regress touch/keyboard access.
- Horizontal header tabs, project/group headings and counts, status/mode chips, badges, icons, row geometry, and
  touch targets remain unchanged.

## Implementation shape

`app.js` will resolve whether actions belong inline from the applied DOM layout rather than from
`isSessionSidebarActive()` alone. The resolver will return true for an expanded left sidebar and for a full-width
vertical side rail, but false for the collapsed left rail, compact vertical rail, and horizontal header strip. The
existing single `tabActionsHtml` source remains shared, preserving action semantics and accessibility.

`styles.css` will extend the session-name font variable and name/action flex constraints to the vertical rail. The
selectors will stay scoped to session names, so headings and other labels do not inherit the configured size.
No schema, persistence format, or server migration changes are required because production already saves the value
correctly.

## Verification

- Add Chromium coverage for the production configuration: `sessionListLayout: "header"`,
  `tabOrientation: "vertical"`.
- Prove 11 px and 18 px values change only `.tab-name` in the vertical rail.
- Prove a short name has a compact title/action gap and a long name truncates before the actions.
- Prove compact vertical rail actions and horizontal header markup remain in their previous direct-child location.
- Retain the existing expanded/collapsed newer-sidebar, detached-session, and incremental-subagent coverage.
- Run focused tests, static checks, production build, realistic browser smoke, and a live LAN verification using the
  server's actual saved vertical-rail settings before merge and redeployment.
