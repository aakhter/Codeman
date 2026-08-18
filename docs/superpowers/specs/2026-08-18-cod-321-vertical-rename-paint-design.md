# COD-321: Vertical inline rename paint design

## Problem

In vertical tab-rail mode, pressing F2 opens the inline rename input for the active session, but Chromium does not visibly repaint the input text as the user types. Pressing Enter commits the value, removes the editor, and reveals the updated label. Horizontal mode is unaffected.

The rename lifecycle and persistence path are functioning. The failure begins at the visual boundary: vertical mode turns `.tab-name` into a two-line WebKit clamp box, while `startInlineRename()` inserts a native `<input>` inside that same clamped element. Chromium updates the input value but does not reliably paint the nested editor text under the clamp.

## Considered approaches

1. **Temporarily neutralize the clamp while renaming (selected).** Add an explicit rename-state class to `.tab-name` before inserting the input. A vertical-only CSS rule for that state restores a normal layout and removes line clamping until the next canonical tab render. This is the smallest change and preserves normal two-line truncation.
2. **Move the input outside `.tab-name`.** This avoids the clamp by changing the tab-row DOM structure, but it expands the rename lifecycle and layout surface unnecessarily.
3. **Use a positioned overlay editor.** This fully isolates the input from the label, but introduces positioning, resize, scroll, and focus synchronization that the bug does not require.

## Design

`startInlineRename()` will mark the selected `.tab-name` with a dedicated rename-state class before replacing its label content with the input. The state belongs to the element whose display contract changes; it will not be stored in application state.

In vertical mode only, the rename-state CSS will override the label's WebKit clamp box with a normal flex layout, remove both standard and prefixed line clamping, and permit the input to occupy the available name width. The ordinary `.tab-name` rule remains unchanged, so inactive labels retain two-line wrapping and ellipsis. Horizontal and mobile presentations receive no new layout rule.

The existing settle paths continue to own cleanup. Commit, cancellation, API failure, session deletion, and render replacement all restore the canonical tab DOM, which naturally removes the transient class with the editor. No server API, persistence model, or keyboard shortcut changes are required.

## Interaction and accessibility

- Typing, deletion, selection, and replacement must repaint immediately while the input is focused.
- Enter commits through the existing blur path.
- Escape keeps its existing cancellation behavior.
- IME composition guards remain unchanged.
- Generated session prefixes remain visible and non-editable beside the input.
- Focus stays on the native text input; no ARIA ownership changes are needed.

## Verification

A focused real-Chromium regression in `test/inline-rename.test.ts` will construct a production-shaped vertical session tab, enter rename mode, type through Playwright's native keyboard path, and assert the editor has escaped the line-clamp display contract while retaining the live value and focus before submission. The test will also confirm the ordinary label returns to its clamped presentation after settlement.

The existing inline-rename browser suite will guard Enter, Escape/cleanup, IME, render-race, API failure, and re-entry behavior. Final verification will include the focused browser test, relevant static frontend tests, typecheck, lint, frontend syntax, lockfile, targeted Prettier, production build, and an isolated staging browser check in vertical mode.

## Scope

This issue changes only the inline session-name editor's vertical presentation and its regression coverage. It does not redesign tab naming, alter saved-webview labels, change group editing, or modify tab-rail sizing and truncation outside the active rename state.
