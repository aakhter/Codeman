# COD-371: Mobile Session-Switcher Pill on Large Phones

## Problem

The mobile session-switcher pill is visible at a 430px viewport but hidden at 431px and above. Codeman's supported device matrix classifies several 432-448px devices as large phones, including the 440px iPhone 16 Pro Max. Those devices therefore retain the old horizontal tab strip even after receiving the current application bundle.

The failure is in `MobileTabSheet._isEnabled()`: it special-cases widths through 430px and then delegates to `MobileDetection.isMobile()`, whose phone classification is narrower than the supported large-phone matrix.

## Design

Change only the session-switcher's eligibility boundary. `MobileTabSheet` will consider viewports below 600px eligible, matching the repository's existing large-phone category while leaving the 600px small-tablet boundary unchanged.

No global `MobileDetection` breakpoint, shared responsive class, sheet layout, session ordering, filtering, or switch behavior will change. The pill's current session-count visibility policy also remains unchanged.

## Verification

Add a focused automated regression around the switcher's eligibility boundary and prove it fails before the production edit. The required cases are:

- 430px remains eligible.
- 440px becomes eligible, covering the iPhone 16 Pro Max.
- 599px remains eligible as the largest large-phone width.
- 600px remains ineligible as the small-tablet boundary.

After implementation, run the focused test, frontend syntax checks, typecheck, lint, formatting, lockfile validation, and production build. After deployment, verify the live hashed asset and browser behavior at 430px, 440px, and 600px.

## Delivery

Track the work in Jira COD-371. Commit and push the focused branch, integrate it into Bitbucket `local`, rebuild and restart `codeman-web`, then report tests, integration, deployment, and live verification as separate states.
