# COD-357 Frontend Initialization Crash Repair

## Problem

The production backend restores all 11 tmux sessions and returns them from authenticated `GET /api/status`, but the browser navbar remains empty. An authenticated browser reproduction shows that `CodemanApp.initTerminal()` throws before SSE initialization because `terminal-ui.js` calls the nonexistent `_installTerminalSelectionAutoCopy()` method. Consequently, `handleInit()` never hydrates `app.sessions` or renders the tab layout.

The stale call belongs to the older COD-208 copy-on-selection implementation. The current Auto Copy implementation, added later, already wires `terminal.onSelectionChange` and a gesture-bound `_flushAutoCopySelection()` handler. Restoring COD-208's removed timer-based method would duplicate clipboard behavior and violate the current requirement to copy within the user's activation gesture.

## Design

Remove the stale `_installTerminalSelectionAutoCopy()` invocation from `initTerminal()`. Keep the current `_flushAutoCopySelection()` implementation unchanged.

Retire `test/terminal-selection-autocopy.test.ts`, which tests the superseded COD-208 private methods, and extend `test/terminal-auto-copy.test.ts` to assert that terminal initialization contains the current Auto Copy wiring and no reference to the removed legacy hook. This makes the source mismatch fail before deployment while preserving behavioral coverage of current Auto Copy.

No backend, tmux, session persistence, tab-layout, authentication, or clipboard behavior changes are in scope.

## Verification

1. The focused Auto Copy test file passes.
2. Typecheck, lint, formatting, lockfile, and production build checks pass.
3. The rebuilt server starts without terminating tmux sessions.
4. An authenticated headless browser loads without uncaught exceptions, reports 11 hydrated sessions, and renders 11 session tabs.
5. The tmux inventory is identical before and after the guarded web-server restart.

## Failure Handling

If the browser still fails after the stale call is removed, stop and collect the next uncaught exception rather than adding guards. If session hydration succeeds but tab rendering does not, inspect the tab-layout projection separately; do not mutate persisted layout state as part of this repair.
