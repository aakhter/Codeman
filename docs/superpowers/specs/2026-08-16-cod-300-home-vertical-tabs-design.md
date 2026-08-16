# COD-300: Homepage Sessions with Vertical Tabs

## Problem

The persistent vertical tab rail and the homepage `Open Tabs` rail are both anchored to the left edge of `.main`. The
persistent rail has the higher stacking order, so it obscures most of the homepage rail. At a 1600 x 900 viewport with
a 320px persistent rail, 320px of the 400px homepage rail is covered.

## Decision

Keep the homepage rail in horizontal mode, where it adds useful age, path, and state metadata without competing with
the primary tab navigation. Hide it whenever the effective tab orientation is vertical because the persistent rail
already supplies session and web-tab navigation, ordering, status, badges, and actions.

## Design

- Make `shouldShowHomeSessions()` return `false` when the root element's effective `data-tab-orientation` is
  `vertical`.
- Re-evaluate homepage visibility after `applyTabOrientation()` changes the effective orientation so switching modes
  takes effect without a reload.
- Add a CSS selector keyed to `data-tab-orientation='vertical'` as a no-overlap backstop while JavaScript state is
  settling.
- Preserve the existing solo-window, phone-overview, and desktop-width gates.

## Testing

- Add focused unit coverage proving the homepage rail is rejected in vertical mode and retained in horizontal mode.
- Cover the orientation-change hook and CSS backstop with source-contract tests.
- Run the focused test file plus typecheck, lint, formatting, lockfile, and production build checks.

## Out of Scope

- Removing the homepage rail globally.
- Changing the content or layout of either rail.
- Changing the vertical rail's configured width.
