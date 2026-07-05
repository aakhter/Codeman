# COD-208 OpenCode Selection Auto-Copy Design

## Summary

OpenCode terminal sessions currently allow users to select text with the mouse, but that selection is not copied to the system clipboard. COD-208 will add select-to-copy behavior for terminal selections by using xterm.js's selection model rather than browser-native DOM selection.

## Goals

- Copy non-empty terminal text selections to the clipboard automatically after mouse selection.
- Use xterm.js selection APIs so copied text matches the terminal selection, including wrapped terminal rows.
- Avoid repeated clipboard writes while the user drags or when the selected text has not changed.
- Fail safely when clipboard writes are denied or unavailable.

## Non-Goals

- Add a new right-click copy menu.
- Change paste handling, image paste handling, or Ctrl/Cmd+V behavior.
- Rework mobile touch selection behavior.
- Replace xterm.js's selection implementation.

## Recommended Approach

Add a small terminal auto-copy helper to `src/web/public/terminal-ui.js` and install it after `this.terminal.open(container)`. The helper subscribes to `terminal.onSelectionChange`, reads `terminal.getSelection()`, and schedules a short delayed clipboard write for the latest non-empty selection.

The helper will:

1. Ignore empty selections.
2. Track the last copied selected text and skip duplicate copies.
3. Debounce selection changes so drag updates do not spam the clipboard.
4. Prefer the existing app clipboard helper when available, falling back to `navigator.clipboard.writeText`.
5. Catch clipboard failures without breaking terminal input or rendering.
6. Dispose of any prior subscription before installing a new one, to avoid duplicate listeners if terminal initialization ever runs more than once.

## Data Flow

1. User drags in the OpenCode terminal.
2. xterm.js updates its internal selection.
3. `onSelectionChange` fires.
4. Codeman reads `terminal.getSelection()`.
5. Codeman schedules a delayed clipboard write for the latest non-empty selection.
6. If the text differs from the last successful copy, Codeman writes it to the clipboard.

## Error Handling

Clipboard writes may fail because of browser permissions, insecure contexts, or unavailable Clipboard API support. These failures will be caught and logged at most as a warning/debug signal. The user should not see an error toast for every failed selection because selection can fire frequently and clipboard permissions vary by browser.

## Testing

Add focused Vitest coverage using the existing VM harness style for `terminal-ui.js`.

Tests should verify:

- Non-empty terminal selections are copied.
- Empty selections are ignored.
- Repeated identical selections do not trigger duplicate clipboard writes.
- Rapid selection changes copy only the latest scheduled selection.
- Clipboard write rejection does not throw or break the handler.

Run only the targeted test file, not the full suite, because the full suite can disrupt managed tmux sessions.

## Jira

Issue: COD-208
