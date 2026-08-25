# COD-380: Keep Mobile Session List Open During Downward Scrolling

## Problem

The mobile session-switcher sheet installs its downward-swipe listener on the entire `#mobileTabSheet`. Any touch that
moves down by more than 50px calls `toggle(false)`, including an ordinary gesture over the scrollable session list. This
closes the sheet when the user intends to browse sessions.

## Design

Give the top `.sheet-handle` sole ownership of drag-to-dismiss. Move the gesture listeners from the sheet container to
that handle and preserve the existing 50px downward threshold. A gesture must begin on the handle to qualify; starting
on the session list, search field, filters, footer, or other sheet content must never trigger swipe dismissal.

Keep the visible 36x4px grip unchanged while enlarging its invisible hit area so the gesture remains practical on a
phone. The expanded target must not cover or intercept the search field or session content. Gesture listeners remain
passive because the drag does not need to suppress browser scrolling.

The session list retains native vertical scrolling. Scrim clicks, pill toggles, Escape, and selecting a session continue
to close the sheet through the existing `toggle(false)` path, keeping the scrim, pill `aria-expanded` state, and body
overflow synchronized. Session ordering, filtering, mobile eligibility, and desktop/tablet behavior do not change.

## Verification

Extend `test/mobile/mobile-tab-pill.test.ts` with focused real-browser touch regressions at a supported phone width:

- Open the sheet, dispatch a downward gesture longer than 50px from the session list, and assert the sheet and scrim
  remain open, the pill remains expanded, and body scrolling remains locked.
- Dispatch the same gesture from the top handle and assert the sheet and scrim close, the pill becomes collapsed, and
  body overflow is restored.

Follow test-driven development: add and run the list-swipe test first and confirm it fails for the current sheet-wide
handler, then implement the handle-owned gesture and run the focused test again. Before delivery, run the targeted test,
typecheck, lint, format check, lockfile check, build, and `git diff --check`. Do not run the unscoped test suite from the
managed Codeman session.

## Delivery

Track the work in Jira COD-380. Commit only the focused source, style, test, and documentation changes; preserve the
unrelated untracked mock assets and `.superpowers/` directory already present in the checkout. Push, integration,
deployment, restart, and live mobile verification are separate steps and require their normal guarded workflow.
