# COD-235 Files Header Toggle Design

## Goal

Add a session-scoped folder button to the desktop header so the active session's Files panel can be opened or closed in one click. The button must reflect the panel's real state and coexist with the App Settings and Session Manager entry points.

The Jira issue's proposed implementation and acceptance criteria are the approved product design for this autonomous loop cycle.

## Considered approaches

1. **Canonical toggle plus derived state sync (selected).** Add `toggleFileBrowserPanel()` and a small `updateFileBrowserHeaderButton()` helper. Reuse the existing canonical `showFileBrowserPanel(sessionId)` and `closeFileBrowserPanel()` mechanics, and derive button state from `activeSessionId` plus the panel's `visible` class. This keeps one source of truth and makes every entry point converge.
2. **Inline DOM toggle in `index.html`.** Directly add/remove `visible` from the button's `onclick`. This is smaller initially, but duplicates panel cleanup, drag-listener, settings, and load behavior and would drift from existing entry points.
3. **Generic header-panel controller.** Introduce shared infrastructure for every header toggle. This could reduce future duplication, but COD-235 does not need it and the refactor would expand regression risk across unrelated panels.

## Selected design

### Markup and mobile policy

- Add `#fileBrowserBtn` beside the related Sources and Library controls.
- Use the existing `.btn-icon-header` pattern with a folder SVG, `title="Files"`, `aria-label="Open files panel"`, and `aria-expanded="false"`.
- Give it the distinguishing `.btn-files` class.
- Start disabled because the page begins without a selected session.
- Hide `.btn-files` at phone widths alongside the other nonessential desktop header controls. This follows the repository's explicit mobile-header policy; existing mobile Files access remains unchanged.

### Behavior and state

- `toggleFileBrowserPanel()` does nothing without an active session.
- When the panel is open, it calls `closeFileBrowserPanel()` so cleanup and setting behavior remain canonical.
- When closed, it calls `showFileBrowserPanel(activeSessionId)` so loading, ownership, and drag wiring remain canonical.
- `updateFileBrowserHeaderButton()` derives:
  - `disabled` from the absence of `activeSessionId`;
  - `active` and `aria-expanded="true"` only when an active session exists and the Files panel has `visible`.
- `showFileBrowserPanel()` and `closeFileBrowserPanel()` invoke the synchronizer after changing visibility.
- The session-tab render path invokes the synchronizer, covering session selection, Home/no-session state, and session removal without adding state writes at every call site.
- App Settings' direct hide path invokes the synchronizer after removing `visible`; Session Manager already routes through `showFileBrowserPanel()`.

The panel DOM remains the visibility source of truth. No independent boolean is introduced, so external entry points cannot desynchronize the header button.

## Error and edge behavior

- A missing button or panel remains a safe no-op, matching existing defensive DOM access.
- A header click with no active session cannot open or load a panel.
- Switching sessions while the panel is open keeps the button active; it does not implicitly reload the panel for the new session because existing Files-panel ownership intentionally remains bound to the session that opened it.
- Existing close cleanup and `showFileBrowser` setting persistence remain unchanged.

## Verification design

Focused tests will prove:

- the header markup, accessible state, folder control, and explicit mobile-visibility decision;
- no-session disabled/no-load behavior;
- closed → open routes the active session through `showFileBrowserPanel()`;
- open → closed routes through `closeFileBrowserPanel()`;
- `active` and `aria-expanded` synchronize on canonical show/close and App Settings hide;
- Session Manager's existing entry point still routes through `showFileBrowserPanel()`;
- session-state rendering enables/disables the control predictably.

The final gate also includes existing Files-panel reveal tests, frontend syntax/public-asset checks, typecheck, formatting, lockfile validation, build, independent spec and quality reviews, and a real Chromium check against the isolated beta instance.

## Out of scope

- Files-panel search/performance work (COD-236).
- Persisting a separate header-button preference.
- Changing which session owns an already-open Files panel.
- Refactoring other header controls into shared infrastructure.
