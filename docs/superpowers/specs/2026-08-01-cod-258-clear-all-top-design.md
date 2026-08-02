# COD-258: Keep Attachment “Clear all” Above the Card Stack

## Problem

Attachment cards are prepended to `#attachmentCardStack`. The stack-level `Clear all` button is also prepended when the
second card creates it, but later refreshes only unhide the existing button. Adding a third or later card therefore places
that card above the button and leaves `Clear all` in the middle of the stack.

## Approved behavior

The Jira summary and screenshot define the placement: whenever `Clear all` is visible, it is the first child of the
attachment-card stack, above every attachment card. Existing behavior remains unchanged otherwise:

- The control is hidden or absent with zero or one card and visible with two or more cards.
- Newest-first card ordering is preserved.
- Per-card dismissal, per-session dismissal, and bulk dismissal retain their current behavior.
- The control is not sticky, duplicated, or moved into an individual card.

## Design

Keep `_refreshAttachmentClearAll()` as the single owner of the control. After lazily creating or finding the button, and
when at least two cards exist, prepend that same node to the stack before showing it. DOM `prepend()` moves an existing
node rather than cloning it, so this restores the invariant after every add without duplicate listeners or controls.

This is preferred over teaching every card insertion about a sibling control or adding a new wrapper/header structure:
it is localized, uses the existing refresh boundary, and does not change CSS or stack teardown.

## Verification plan

1. Add a focused regression that creates at least three cards and asserts the visible control is the stack’s first child,
   remains unique, and leaves the cards in newest-first order.
2. Run the test before implementation and observe the ordering assertion fail.
3. Apply the minimal refresh correction and re-run the focused attachment tests.
4. Run frontend syntax, public-asset formatting, repository quality gates, and the production build.
5. Verify the served candidate in an isolated beta browser with three cards, asserting one visible top control and no page
   errors. Do not deploy production.
