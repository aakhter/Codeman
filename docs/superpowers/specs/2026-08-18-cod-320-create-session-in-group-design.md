# COD-320: Create a Session in a Group

## Summary

Add a **New session** command to each session-group overflow menu in the vertical tab rail. The command immediately launches exactly one session using the currently selected case and run mode and places the new session at the end of that group.

The placement is part of server-side session creation. It is not inferred from client-side SSE timing and is not applied later as a separate browser layout edit.

## User experience

- **New session** is the first item in the group overflow menu.
- Selecting it closes the menu and starts one session with the current case and run mode. It does not open the welcome launcher.
- The existing toolbar values for session count and shell count are not changed.
- A collapsed target group expands before launch so the new tab is visible when it arrives. The existing collapsed-group persistence mechanism records this change.
- The new session becomes active and receives terminal focus through the existing launch flow.
- If another launch is already in progress, the command does not expand the group or capture another launch's session. It shows an informational or error toast instead of silently doing nothing.
- Existing launch failures continue through `_reportSessionLaunchError()` and do not affect later launches.
- Activating the command focuses the terminal synchronously before any asynchronous launch work, for every run mode.
- The command is available where session groups exist: the vertical tab rail. Horizontal tabs have no group overflow menu.

## Client design

### Group-menu command

`CodemanApp.createSessionInTabGroup(groupId)` validates that:

1. tab layout editing is available,
2. the group still exists, and
3. no launch is already in flight.

On success it expands the group with `toggleTabGroupCollapsed(groupId, false)`, focuses the terminal synchronously, and awaits the existing dispatcher as `run({ count: 1, tabGroupId: groupId })`. Rejections that occur outside an individual launch method's existing `try` block are caught and shown through the normal toast path. The method does not hold mutable global placement state. This prevents unrelated `session:created` events from an agent spawn, another browser, or a background process from being captured.

### Launch options

`run(options = {})` forwards a narrow launch-options object to the selected mode:

```js
{ count?: number, tabGroupId?: string }
```

The count override is used only by launch paths that support batch creation (`runClaude` and `runShell`). Their existing DOM-backed counts remain the default when no override is present. All modes include `tabGroupId` in the request that creates the session:

- local creation uses `POST /api/sessions`,
- remote and Docker creation uses `POST /api/quick-start`, and
- OpenCode, Codex, Gemini, Antigravity, and Pi pass it through their existing create or quick-start request.

The menu action always supplies `count: 1`; ordinary toolbar launches retain their current multi-session behavior.

No semantic placement edit occurs in `_ensureCreatedSessionVisible()`. For a targeted creation response, the helper adopts the authoritative layout snapshot returned by the server before upserting and rendering the session. It remains responsible for reconciling the POST response with the `session:created` SSE race and rendering the new tab before selection.

## Server design

### Request schemas and route context

`CreateSessionSchema` and `QuickStartSchema` accept an optional bounded `tabGroupId` string. Both session-creation routes pass it to `ctx.addSession()` with the newly constructed session.

`SessionPort.addSession` gains an optional creation-placement argument and returns the authoritative layout produced by reconciliation. The server still inserts the session into the live session map before invoking the tab-layout service, so the new session is present in layout metadata during reconciliation. Existing callers that do not supply placement continue to await the return value without using it.

### Atomic layout reconciliation

Extract the migration/normalization portion of `getUnlocked()` into a private, non-committing reconciliation helper that returns the stored base and reconciled candidate. `get()`, `getSnapshot()`, `put()`, and `putOperations()` continue to call through `getUnlocked()` and retain their current observable commit, version, conflict, and broadcast behavior. Regression tests pin those existing callers before the extraction.

Extend `TabLayoutService.sessionCreated()` to accept the created session ID and optional target group ID. Under the existing per-owner mutation queue it uses the non-committing helper to:

1. gather authoritative live/persisted session metadata,
2. reconcile or migrate the current owner layout in memory so the new session ref exists,
3. check whether the requested group exists in that owner's layout,
4. attempt to move the new session ref to the group's final index when it exists,
5. otherwise leave the normal reconciled placement unchanged, and
6. commit and broadcast at most one new layout version.

If there is no stored layout for the owner, reconciliation still uses the existing synthetic `version: -1` base and creates version 0. No target group can exist in that case, so the placement hint is ignored and the initial layout is committed once.

The group lookup and placement occur inside the same owner queue as reconciliation. A concurrent rename or reorder is serialized; a concurrent deletion results in the session remaining at its normal ungrouped or inherited placement.

Unknown, deleted, malformed-but-schema-valid, or other-owner group IDs do not fail session creation. They are treated as an unavailable placement hint. Because layouts are owner-scoped, a caller cannot place a session into another owner's group.

The placement attempt is isolated from ordinary reconciliation. Any placement-specific `TabLayoutValidationError`, including size or destination validation, degrades to the plain reconciled layout that COD-320 would have produced without a target. Only reconciliation failure propagates through `addSession()` and rolls back the live-map insertion.

When a request supplies both `tabGroupId` and `parentSessionId`, explicit group placement wins. Moving the child marks it as manually placed, so it does not follow future parent moves until the user selects **Follow parent again**. The group-menu launch path does not supply a parent, so ordinary menu-created sessions remain parentless.

Concurrent targeted creations are serialized by the owner queue and append to the group's end in server arrival order. Parallel request arrival order is intentionally unspecified. The group-menu path always creates exactly one session.

### Authoritative layout delivery

The single committed layout is included in the `tab:layoutChanged` SSE payload in addition to the existing owner and version fields. The browser adopts this inline snapshot immediately and retains the current GET fallback for payloads that contain only a version. Because the server emits the layout event before `session:created` on the same SSE stream, connected clients know the target container before they render the new live session.

Both targeted creation responses also include the same authoritative layout snapshot. This covers a creating browser whose SSE stream is disconnected or delayed: `_ensureCreatedSessionVisible()` adopts the response snapshot before it upserts and renders the new session. Version checks continue to reject stale snapshots, and no client synthesizes or mutates placement locally.

If ordinary layout reconciliation itself fails, `addSession()` preserves its existing rollback behavior by removing the session from the live map and propagating the creation error.

## Data and event flow

1. The user opens a vertical-rail group menu and selects **New session**.
2. The client verifies no launch is active, expands the group, and calls `run({ count: 1, tabGroupId })`.
3. The selected launch path sends `tabGroupId` with its normal creation request.
4. The route creates a `Session` and calls `addSession(session, { tabGroupId })`.
5. `TabLayoutService.sessionCreated()` non-destructively reconciles and places the new ref in one owner-serialized layout mutation, falling back to normal placement if only the hint fails.
6. The server broadcasts the inline authoritative layout and then the existing session-created event; the targeted response also carries that layout.
7. The browser adopts the SSE or response snapshot before it renders and selects the session, so the tab does not paint transiently under Ungrouped.

## Error handling and concurrency

- A second menu click while `_runInFlight` is true produces feedback and starts nothing.
- Invalid target groups are ignored as placement hints; the session remains successfully created.
- Other sessions created during the launch are unaffected because placement is carried by the specific request rather than shared browser state.
- POST-response and SSE ordering cannot change which session is placed because the session ID and group ID meet on the server before the creation response is returned.
- A placement-only validation failure commits normal reconciliation and never fails or tears down the new session.
- Inline authoritative layout delivery prevents the new tab from hopping from Ungrouped into the target group while preserving version-based stale-update rejection.
- Group expansion is intentionally client-local UI state and can remain expanded if session creation later fails.
- Normal launch errors and terminal ownership behavior remain unchanged.

## Accessibility

- **New session** uses the existing `role="menuitem"` button pattern and an accessible name of **New session in _group name_**.
- As the first item, it intentionally receives initial focus when the menu opens. Pressing Enter after opening the menu launches immediately; this matches the explicitly chosen no-confirmation behavior.
- Existing Arrow Up/Down wrapping, Escape dismissal with trigger-focus restoration, and outside-click dismissal continue to apply.
- Activation moves focus to the terminal synchronously for every run mode. Escape dismissal continues to restore focus to the menu trigger; click activation does not.
- Tests that previously treated the first item as **Rename group**, including initial-focus and arrow-wrapping/action assertions, are updated deliberately.

## Test strategy

### jsdom interaction tests

In `test/tab-layout-editing.test.ts`:

- assert **New session** is the first menu item and receives initial focus,
- assert selecting it calls `createSessionInTabGroup()` exactly once and closes the menu,
- assert a collapsed group expands and persists its expanded state before launch,
- assert an in-flight launch shows feedback and does not expand or start,
- assert terminal focus occurs synchronously for all launch modes,
- update both existing first-item assumptions while preserving arrow wrapping, Escape, ARIA state, and listener-cleanup coverage.

### Launch-mode tests

In `test/run-mode-ui.test.ts`:

- assert `run({ count: 1, tabGroupId })` dispatches options to the selected mode,
- assert Claude and Shell use the one-session override without mutating their DOM count controls,
- assert local `/api/sessions` and remote/Docker `/api/quick-start` requests include `tabGroupId`,
- assert OpenCode, Codex, Gemini, Antigravity, and Pi creation requests include `tabGroupId`,
- assert ordinary toolbar launches still honor their configured counts,
- assert creation failures release `_runInFlight`, surface pre-`try` rejections, and do not retain placement state,
- assert a targeted response layout is adopted before the new session is rendered.

### Server and service tests

In `test/tab-layout-service.test.ts` and the focused session-route tests:

- pin existing `get`, `getSnapshot`, `put`, and `putOperations` behavior across the non-committing reconciliation extraction,
- create a session into an existing group and assert one layout write, one version increment, and one inline-layout SSE broadcast with the ref at the group's end,
- cover layout reconciliation when the new ref was absent from the previous stored layout and when the owner has no stored layout,
- cover concurrent serialized layout edits,
- assert unknown and deleted group IDs leave the session created and normally placed,
- assert an owner cannot target another owner's group,
- force a placement-specific validation failure and assert the session survives with normal placement,
- assert explicit `tabGroupId` overrides `parentSessionId` with manual placement,
- cover both `/api/sessions` and `/api/quick-start` argument propagation and response snapshots,
- add a focused integration test around the real `createRouteContext().addSession` wiring, not only the mocked route context,
- assert existing non-targeted callers (`/api/run`, Ralph, and cron creation) retain normal reconciliation,
- assert inline SSE and targeted-response adoption render the new tab in the final group without an Ungrouped frame.

## Out of scope

- Adding group controls to horizontal tabs.
- Creating more than one session from the group menu.
- Adding a new launcher or per-group default case/tool settings.
- Moving sessions created by unrelated agents, devices, scheduled work, or APIs that did not supply `tabGroupId`.
- Changing general tab-layout drag, rename, reorder, or delete behavior.
