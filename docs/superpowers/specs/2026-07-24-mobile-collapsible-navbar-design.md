# Mobile Collapsible Navbar Design

## Problem

At mobile and tablet widths up to 768px, the fixed Codeman header renders the session tab and every enabled utility
button in one row. Around 430–440 CSS pixels, the 44px tablet buttons crowd and clip the active session tab. The header
has no current collapse control.

## Approved Interaction

The mobile header loads collapsed. Its primary row contains the Codeman brand, session tabs, and a trailing menu toggle.
Activating the toggle reveals the existing header utilities in a second row; activating it again collapses them. The
toggle exposes its state through `aria-expanded` and references the utility row with `aria-controls`.

Desktop widths above 768px retain the current layout and do not show the toggle.

## Implementation

- Add one semantic button beside the session tabs in `src/web/public/index.html`.
- Add a small `CodemanApp` controller in `src/web/public/app.js` that toggles an expanded class and synchronizes
  `aria-expanded`.
- Extend the existing mobile breakpoints in `src/web/public/mobile.css` so the utility cluster is hidden by default,
  becomes a wrapped second row when expanded, and reserves enough app-shell space for the taller fixed header.
- Keep every existing utility button and click handler unchanged.

The expanded state is page-local and defaults to collapsed after a reload. No setting or server persistence is added.

## Accessibility and Failure Handling

The toggle has a stable accessible name, uses `aria-expanded`, and points to `#headerRight`. With JavaScript unavailable,
the utilities remain collapsed on mobile; desktop remains unaffected because its existing CSS layout is unchanged.

## Verification

Targeted Playwright coverage will assert:

- a 430px large-phone viewport starts collapsed;
- the toggle expands and collapses the utility row and updates `aria-expanded`;
- expanding increases the fixed-header content offset;
- a desktop-class viewport hides the toggle and retains visible utilities.

Run the focused mobile test, frontend syntax check, typecheck, lint, format check, lockfile check, production build, and a
real-browser smoke before merge and deployment.
