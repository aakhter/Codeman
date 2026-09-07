# COD-428: Per-session terminal font size

## Governing question

How should Codeman preserve a user-adjusted terminal font size when the user switches between session tabs, while allowing different sessions to retain different sizes?

## Audience and success criteria

The audience is Codeman users who use Ctrl/+ or the header font controls to adjust terminal readability. The fix is successful when:

- changing the font size while session A is active does not change session B's saved size;
- switching away from and back to session A restores A's selected size;
- a session with no saved preference uses the existing device/mode default;
- the preference survives a page reload in the same browser/device;
- the preference is isolated to the particular Codeman host/origin and browser profile where it was changed;
- invalid or unavailable browser storage cannot break terminal rendering.

## Approved approach

Use browser `localStorage` with a session-specific key as the primary preference store, for example `codeman-font-size:<sessionId>`. The existing shared font policy remains responsible for device/mode defaults and validation, but its storage lookup becomes session-aware.

The shared xterm instance remains unchanged. `setFontSize()` resolves the active session ID, clamps the requested value using the existing policy bounds, applies it to xterm, and writes only the active session's key. `selectSession()` and resize paths resolve the selected session's key before measuring or fitting the terminal.

The preference is intentionally local to the particular Codeman host/origin and browser profile where it was changed. It is not added to server session state or synchronized between hosts, browsers, or devices. A session's font preference is independent of its agent mode; mode-specific behavior continues to provide only the fallback policy and minimum bounds.

## Compatibility and fallback

Existing global keys remain readable as a compatibility fallback for sessions without a session-specific value. This avoids unexpectedly discarding a user's current setting after upgrade. A session-specific value takes precedence once it exists. No migration write is required; the next explicit size change creates the session-specific entry. Because both keys are browser `localStorage`, neither is sent to the server or shared with another host/origin.

If `localStorage` reads or writes throw, use the existing in-memory xterm value for the current page and fall back to the validated default when resolving a session with no available stored value. Invalid, non-integer, or out-of-range values are ignored by the existing resolver.

## Components and data flow

1. `terminal-ui.js` owns font policy resolution, application, and Ctrl/header adjustments.
2. The active session ID is included in the storage-key resolution.
3. `app.js` session selection invokes the policy for the session being activated before fit/resize work.
4. Existing fit, overlay-font refresh, display readout, and PTY resize behavior remain in place.
5. Focused tests exercise the pure resolver, direct size changes, and the actual session-switch path.

## Error handling

Storage failures are non-fatal. The terminal must still apply the requested size for the current view, and later selection must use the default or any readable session-specific value. A stale or missing session ID must not write a value under an undefined key. The implementation must not introduce cookies, server writes, or other mechanisms that broaden the preference beyond the current host/browser.

## Testing strategy

- Add a failing regression test that sets session A to a larger size, switches to session B, assigns or verifies B's independent size, and switches back to confirm A is restored.
- Test that an uncustomized session uses the existing fallback and that the legacy global key remains compatible.
- Test storage failure behavior for both reads and writes.
- Run the focused font/session tests, then repository-required typecheck, lint, formatting, lockfile, and frontend syntax checks.

## Alternatives rejected

- In-memory map: loses preferences on reload.
- Server-side session metadata: enables cross-device sync but expands the data model and exceeds the requested browser/device-local behavior.
