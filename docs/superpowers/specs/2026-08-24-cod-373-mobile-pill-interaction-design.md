# COD-373: Mobile Session Pill Interaction and Full Label

## Problem

At supported phone widths, the session-switcher pill is visible but does not open its bottom sheet. The page pre-renders `#mobileTabPill`, while `MobileTabSheet._createElements()` only assigns a click handler when it creates a missing pill. The pre-rendered button therefore has no handler.

The active session name is also cropped even when the header has room. `updatePill()` truncates every name to eight characters and CSS caps `.pill-mini` at 70px, so `w1-Codeman` is rendered as `w1-Codem`.

## Design

Make pill binding a single idempotent operation that runs for both the pre-rendered button and any pill recreated after a header mutation. The handler will call `toggle()` without a forced state, so repeated pill clicks open and close the sheet while keeping the scrim and `aria-expanded` synchronized.

Render the complete active session name in the DOM. Replace the fixed 70px label cap with a flexible pill that may use the header's available space and only ellipsizes when the viewport genuinely cannot accommodate the full control.

No sheet contents, session ordering, filtering, mobile eligibility boundary, or desktop/tablet behavior will change.

## Verification

Extend the focused real-browser mobile pill test at 440px. Seed an active session named `w1-Codeman`, update the pill, and assert the full text is rendered and visible. Click the actual pill and assert the sheet, scrim, and `aria-expanded` open state; click again and assert all three close.

After implementation, run the focused test, frontend/public asset checks, typecheck, lint, formatting, lockfile validation, production build, and `git diff --check`. After deployment, repeat the same interaction and label checks against the live service at 440px.

## Delivery

Track the work in Jira COD-373. Commit and push the focused branch, integrate it into Bitbucket `local`, rebuild and restart `codeman-web` through the guarded deployment workflow, then report tests, integration, deployment, and live verification separately.
