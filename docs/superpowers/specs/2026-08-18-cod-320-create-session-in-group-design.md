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
- The command is available where session groups exist: the vertical tab rail. Horizontal tabs have no group overflow menu.

## Client design

### Group-menu command

`CodemanApp.createSessionInTabGroup(groupId)` validates that:

1. tab layout editing is available,
2. the group still exists, and
3. no launch is already in flight.

On success it expands the group with `toggleTabGroupCollapsed(groupId, false)` and calls the existing dispatcher as `run({ count: 1, tabGroupId: groupId })`. The method does not hold mutable global placement state. This prevents unrelated `session:created` events from an agent spawn, another browser, or a background process from being captured.

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

No placement work occurs in `_ensureCreatedSessionVisible()`. That helper remains responsible only for reconciling the POST response with the `session:created` SSE race and rendering the new tab before selection.

## Server design

### Request schemas and route context

`CreateSessionSchema` and `QuickStartSchema` accept an optional bounded `tabGroupId` string. Both session-creation routes pass it to `ctx.addSession()` with the newly constructed session.

`SessionPort.addSession` gains an optional creation-placement argument. The server still inserts the session into the live session map before invoking the tab-layout service, so the new session is present in layout metadata during reconciliation.

### Atomic layout reconciliation

Extend `TabLayoutService.sessionCreated()` to accept the created session ID and optional target group ID. Under the existing per-owner mutation queue it:

1. gathers authoritative live/persisted session metadata,
2. reconciles or migrates the current owner layout in memory so the new session ref exists,
3. checks whether the requested group exists in that owner's layout,
4. if it exists, moves the new session ref to the group's final index with manual placement semantics,
5. otherwise leaves the normal reconciled placement unchanged, and
6. commits and broadcasts at most one new layout version.

The group lookup and placement occur inside the same owner queue as reconciliation. A concurrent rename or reorder is serialized; a concurrent deletion results in the session remaining at its normal ungrouped or inherited placement.

Unknown, deleted, malformed-but-schema-valid, or other-owner group IDs do not fail session creation. They are treated as an unavailable placement hint. Because layouts are owner-scoped, a caller cannot place a session into another owner's group.

If ordinary layout reconciliation itself fails, `addSession()` preserves its existing rollback behavior by removing the session from the live map and propagating the creation error.

## Data and event flow

1. The user opens a vertical-rail group menu and selects **New session**.
2. The client verifies no launch is active, expands the group, and calls `run({ count: 1, tabGroupId })`.
3. The selected launch path sends `tabGroupId` with its normal creation request.
4. The route creates a `Session` and calls `addSession(session, { tabGroupId })`.
5. `TabLayoutService.sessionCreated()` reconciles and places the new ref in one owner-serialized layout mutation.
6. The server broadcasts the layout change and then the existing session-created event/response flow continues.
7. The browser's existing POST/SSE reconciliation renders and selects the session. The tab is already projected in the target group when the authoritative layout arrives.

## Error handling and concurrency

- A second menu click while `_runInFlight` is true produces feedback and starts nothing.
- Invalid target groups are ignored as placement hints; the session remains successfully created.
- Other sessions created during the launch are unaffected because placement is carried by the specific request rather than shared browser state.
- POST-response and SSE ordering cannot change which session is placed because the session ID and group ID meet on the server before the creation response is returned.
- Group expansion is intentionally client-local UI state and can remain expanded if session creation later fails.
- Normal launch errors and terminal ownership behavior remain unchanged.

## Accessibility

- **New session** uses the existing `role="menuitem"` button pattern.
- As the first item, it receives initial focus when the menu opens.
- Existing Arrow Up/Down wrapping, Escape dismissal, focus restoration, and outside-click dismissal continue to apply.
- Tests that previously expected **Rename group** to receive initial focus are updated deliberately.

## Test strategy

### Browser interaction tests

In `test/tab-layout-editing.test.ts`:

- assert **New session** is the first menu item and receives initial focus,
- assert selecting it calls `createSessionInTabGroup()` exactly once and closes the menu,
- assert a collapsed group expands and persists its expanded state before launch,
- assert an in-flight launch shows feedback and does not expand or start,
- preserve arrow wrapping, Escape, ARIA state, and listener-cleanup coverage.

### Launch-mode tests

In `test/run-mode-ui.test.ts`:

- assert `run({ count: 1, tabGroupId })` dispatches options to the selected mode,
- assert Claude and Shell use the one-session override without mutating their DOM count controls,
- assert local `/api/sessions` and remote/Docker `/api/quick-start` requests include `tabGroupId`,
- assert OpenCode, Codex, Gemini, Antigravity, and Pi creation requests include `tabGroupId`,
- assert ordinary toolbar launches still honor their configured counts,
- assert creation failures release `_runInFlight` and do not retain placement state.

### Server and service tests

In `test/tab-layout-service.test.ts` and the focused session-route tests:

- create a session into an existing group and assert one layout version increment with the ref at the group's end,
- cover layout reconciliation when the new ref was absent from the previous stored layout,
- cover concurrent serialized layout edits,
- assert unknown and deleted group IDs leave the session created and normally placed,
- assert an owner cannot target another owner's group,
- cover both `/api/sessions` and `/api/quick-start` propagation.

## Out of scope

- Adding group controls to horizontal tabs.
- Creating more than one session from the group menu.
- Adding a new launcher or per-group default case/tool settings.
- Moving sessions created by unrelated agents, devices, scheduled work, or APIs that did not supply `tabGroupId`.
- Changing general tab-layout drag, rename, reorder, or delete behavior.
