# Active Session Pointer Implementation Plan

> **For agentic workers:** Execute inline using superpowers:executing-plans. User approved option A.

**Goal:** Identify the selected session without relying on color (COD-522).

**Architecture:** Add a decorative span to the existing session renderer and style it from `.active`. Existing selection logic remains authoritative; no new state or event handlers.

**Tech Stack:** Browser JavaScript, CSS, Vitest, Playwright.

### Task 1: Regression coverage

- [x] Extend `test/tab-harness-logo.test.ts` with assertions that all rendered session rows have one empty, aria-hidden `.tab-active-indicator`, and incremental selection updates `aria-selected` without replacing the indicator.
- [x] Extend `test/tab-active-indicator.browser.test.ts` with real CSS visibility, geometry and theme checks for vertical/grouped/compact, horizontal/mobile and sidebar layouts.
- [x] Run `npm test -- test/tab-harness-logo.test.ts` and `npm run test:browser -- test/tab-active-indicator.browser.test.ts`; confirm missing-marker failures before implementation.

### Task 2: Implementation

- [x] In `src/web/public/app.js`, add `<span class="tab-active-indicator" aria-hidden="true"></span>` before `.tab-number`; update `aria-selected` from `isActive` during the incremental pass.
- [x] In `src/web/public/styles.css`, reserve a non-shrinking 8px marker slot, use `background: var(--text)` and triangle clip-path, hide with `visibility: hidden`, reveal with `.session-tab.active`, and use `pointer-events: none`. Point right for vertical rails/sidebar and down otherwise. Account for collapsed sidebar without row wrapping or badge overlap.
- [x] Run targeted suites, typecheck, lint, format and lockfile checks. Capture a real Chromium screenshot; review overlap, row shifts, status/attention conflicts and theme contrast.
- [x] Review the diff, commit explicit paths on `feat/COD-522-active-session`, and record implementation and verification on COD-522. Preserve the main checkout's documentation edits.

## Verification receipts

- 31 renderer, layout and accessibility tests passed across three targeted files.
- 11 Chromium cases passed: vertical/grouped/compact, horizontal, phone strip, sidebar, collapsed sidebar with task badge, and mobile drawers across light/dark skins.
- Typecheck, lint, formatting and lockfile checks passed. Independent source review found two edge cases (incremental insertion order and collapsed badge overlap); both were fixed and covered.
- The preexisting tab-activation browser suite has stale wrapper/drag-grip assertions and an incomplete controller fixture; it remains unchanged. New marker coverage lives in a separate focused suite.
