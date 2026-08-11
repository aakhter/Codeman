# COD-291 Touch and Trackpad History Reliability Design

## Problem

Production Chrome on `w10-tcc` exposes two independent client failures. Fractional pixel-wheel deltas cross the mirror-history threshold with a fractional carry such as `3.2`; `_enterHistoryView` passes that value to xterm's integer-only `scrollLines`, which throws and exits history. On iPhone, the terminal touch handlers are a semantic merge of the gesture-state and mobile-tap implementations: `touchstart` reads an undeclared `touch`, while move/end read an undeclared `touchGesture`, so no touch scroll intent is produced.

The remote history backend is healthy (`mux-full-history`, 1,011 lines, not truncated), so the repair stays in browser input handling.

## Design

1. Normalize the history landing carry at the xterm boundary. `_enterHistoryView` will truncate a positive fractional carry to whole rows before calling `terminal.scrollLines`. Thresholding and prefetch behavior remain unchanged.
2. Restore one gesture-state lifecycle in the touch listeners. Create `touchGesture` once; begin it on `touchstart`; derive the tracked touch from that helper; update it on `touchmove`; end it on `touchend`; and cancel it on `touchcancel`.
3. Preserve the newer mobile-tap behavior. Touch start still caches tap classification and suppresses unwanted compatibility focus. A valid unmoved gesture still routes through `_handleMobileTerminalTap`; moved or cancelled gestures never activate a tap.
4. Restore complete per-gesture cleanup for velocity, pending animation work, the gesture state, and the scrolling CSS class.

## Testing

- Add a regression guard proving the history landing passes only an integer to xterm.
- Add touch-listener source/lifecycle guards that fail on undeclared `touch` or `touchGesture` integration.
- Run the focused mirror-history and terminal-touch suites, frontend syntax/assets, typecheck, lint, formatting, lockfile, and production build.
- In production Chrome on `w10-tcc`, verify one mouse notch and small fractional trackpad sequences enter and retain frozen history without console errors.
- In iPhone emulation on `w10-tcc`, dispatch a real touch drag and verify it reaches scroll intent, loads history, and produces no page errors.

## Non-goals

- No pointer-event rewrite.
- No change to the three-line history threshold or 300 ms entry window.
- No changes to remote capture, tmux, or session classification.
