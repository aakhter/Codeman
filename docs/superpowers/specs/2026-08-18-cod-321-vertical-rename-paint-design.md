# COD-321: Vertical inline rename paint design

## Problem

In vertical tab-rail mode, pressing F2 opens the inline rename input for the active session, but Chromium does not visibly repaint the input text as the user types. Pressing Enter commits the value, removes the editor, and reveals the updated label. Horizontal mode is unaffected.

The rename lifecycle and persistence path are functioning. The failure begins at the visual boundary: vertical mode turns `.tab-name` into a two-line WebKit clamp box, while `startInlineRename()` inserts a native `<input>` inside that same clamped element. Chromium updates the input value but does not reliably paint the nested editor text under the clamp.

## Considered approaches

1. **Temporarily neutralize the clamp while renaming (selected).** Add an explicit rename-state class to `.tab-name` before inserting the input. A vertical-only CSS rule for that state restores a normal layout and removes line clamping until explicit rename settlement. This is the smallest change and preserves normal two-line truncation.
2. **Move the input outside `.tab-name`.** This avoids the clamp by changing the tab-row DOM structure, but it expands the rename lifecycle and layout surface unnecessarily.
3. **Use a positioned overlay editor.** This fully isolates the input from the label, but introduces positioning, resize, scroll, and focus synchronization that the bug does not require.

## Design

`startInlineRename()` will mark the selected `.tab-name` with a dedicated rename-state class before replacing its label content with the input. The state belongs to the element whose display contract changes; it will not be stored in application state.

In vertical mode only, the rename-state CSS will override the label's WebKit clamp box with `display: flex`, remove both standard and prefixed line clamping, and permit the input to occupy the available name width. The prefix span will be `flex: 0 0 auto`; the input will use `flex: 1 1 0`, `width: auto`, and `min-width: 0`. This avoids combining a non-wrapping prefix with the current sidebar input's `width: 100%` basis, which would otherwise overflow or crush the editable suffix. The ordinary `.tab-name` rule remains unchanged, so inactive labels retain two-line wrapping and ellipsis. Horizontal and mobile presentations receive no new layout rule.

Cleanup will be explicit rather than delegated to rendering. The incremental tab renderer reuses `.tab-name` and only replaces its children when the full name changes, so it cannot be relied on to remove the rename-state class. A small settlement helper will remove the class before every commit, cancellation, API-failure, and session-deletion exit. `startInlineRename()` will also settle any existing `_activeRename` before installing a new editor, ensuring repeated F2 or a direct second rename cannot strand the old input or its class. Settlement will be owned by the specific rename instance, so a late blur from the old input cannot clear the newer rename's state. No server API, persistence model, or keyboard shortcut changes are required.

## Interaction and accessibility

- Typing, deletion, selection, and replacement must repaint immediately while the input is focused.
- Enter commits through the existing blur path.
- Escape keeps its existing settlement semantics. Today it clears the editable suffix and follows the blur/commit path; changing that behavior is outside COD-321.
- IME composition guards remain unchanged.
- Generated session prefixes remain visible and non-editable beside the input.
- Focus stays on the native text input; no ARIA ownership changes are needed.

## Verification

A focused real-Chromium regression in `test/inline-rename.test.ts` will construct a production-shaped vertical `.tab-rail .session-tab`, including a generated prefix. It will enter rename mode and type through `page.keyboard.type()` rather than assigning `input.value`. Before submission it will assert that the input retains focus and the live typed value, has a non-zero rectangle, and fits within the `.tab-name` client box without clipping. It will also assert the flex allocation leaves the prefix visible and the suffix input usable.

After Enter, cancellation, API failure, and pre-emptive re-entry, the test will verify the rename-state class is absent. The settled vertical label must again report a two-line WebKit clamp. Re-entry coverage will distinguish incremental rendering from a full DOM rebuild so the test fails if cleanup merely happens to come from `innerHTML` replacement.

The reported production symptom is the primary browser observation: the native input accepts keystrokes but the glyphs appear only after Enter replaces it with the label. The relevant automated environment is Playwright's Chromium 148.0.7778.96. A reduced clamp-only fixture does not reproduce the missing glyphs by itself, so the regression deliberately uses the production stylesheet and tab ancestry; geometry and state assertions provide deterministic failure signals without depending on screenshot antialiasing.

The existing inline-rename browser suite will guard Enter, Escape/cleanup, IME, render-race, API failure, and re-entry behavior. Final verification will include the focused browser test, relevant static frontend tests, typecheck, lint, frontend syntax, lockfile, targeted Prettier, production build, and an isolated staging browser check in vertical mode.

## Scope

This issue changes only the inline session-name editor's vertical presentation and its regression coverage. It does not redesign tab naming, alter saved-webview labels, change group editing, or modify tab-rail sizing and truncation outside the active rename state.
