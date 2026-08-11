# COD-291 MacBook Trackpad History Loading Design

## Problem

A Codex live-mirror session enters frozen history after enough negative wheel travel. The history capture is asynchronous. While it is pending, the terminal still contains the live mirror with zero scrollback, so it reports that the viewport is at the bottom. A small positive wheel tail from a MacBook trackpad therefore triggers the ordinary scroll-to-bottom exit, increments the history load generation, and causes the pending capture response to be discarded.

The iPhone path does not reproduce this because touch momentum is cleared when the history-entry funnel returns `entered-history`.

## Design

Use the existing history generation mechanism to mark only the initial history load that is currently active:

- Add `_historyInitialLoadGen`, initialized to `0`.
- When `_enterHistoryView` allocates a new `_historyLoadGen`, store that generation in `_historyInitialLoadGen`.
- While `_historyInitialLoadGen === _historyLoadGen`, ignore the automatic “positive scroll while at bottom” exit in `_handleUserScrollIntent`.
- After the first history buffer has been written and the generation/view checks still pass, clear `_historyInitialLoadGen` before applying the landing scroll.
- Clear it in `_exitHistoryView` as hygiene. Incrementing `_historyLoadGen` already invalidates stale asynchronous work, so a stale promise cannot clear or affect a newer load.

Explicit exit actions such as Escape, typing, and PageDown remain unchanged. Once the initial buffer is installed, positive scrolling to the bottom resumes the live mirror exactly as before.

## Files

- `src/web/public/app.js`: initialize and manage the initial-load generation token.
- `src/web/public/terminal-ui.js`: suppress only the automatic wheel/touch bottom exit during the matching initial-load generation.
- `test/mirror-history-view.test.ts`: pin the token lifecycle and the guarded bottom-exit condition.

## Verification

1. Run the new focused regression test and confirm it fails before production code changes.
2. Implement the minimal generation-token guard and confirm the focused test passes.
3. Run frontend syntax, public-asset, type, lint, format, lockfile, and build checks.
4. Run the realistic Codeman temporary-instance smoke.
5. After deployment, reproduce the production MacBook-trackpad event sequence with a delayed initial capture and an opposite-direction wheel tail. The pill must progress from loading to frozen history without returning to live mode.
