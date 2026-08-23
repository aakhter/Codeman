# COD-365 Move Menu Labels Design

## Goal

Use the concise labels **Move up** and **Move down** for reorder commands in both the group overflow menu and the session overflow menu.

## Scope

- Change the group menu labels from **Move group earlier** / **Move group later** to **Move up** / **Move down**.
- Change the session/ref move labels from **Move earlier** / **Move later** to **Move up** / **Move down**.
- Update the existing keyboard shortcut helpers that select the session move actions by label so they continue to invoke the same destinations.
- Preserve action ordering, boundary-based availability, subtree-aware destination indexes, focus handling, keyboard navigation, and ARIA semantics.

No API, persistence, layout, styling, or deployment change is included.

## Approaches considered

1. **Rename the existing action labels and their internal lookup strings (selected).** This is the smallest coherent change and preserves the current action model.
2. Add stable action IDs and decouple internal lookup from display copy. This is architecturally cleaner, but expands a copy-only task into a refactor without a demonstrated need.
3. Transform the labels only at render time. This leaves conflicting internal and rendered vocabulary and makes tests harder to understand.

## Testing

Add focused DOM coverage that opens both real menus and asserts the concise labels while rejecting the legacy labels. Keep the existing subtree and boundary tests, updating their label assertions to the new copy. Run the focused editing test through a verified RED→GREEN cycle, then run static checks and a production build.
