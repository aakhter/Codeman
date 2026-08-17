# COD-316: Full-row Tab Activation

## Problem

The delegated drag handler captures every ordinary mouse press on a tab row before drag intent exists. Chromium retargets the resulting click to the rail, bypassing the tab activation handler. The far-right action wrapper works only because it is excluded from capture.

## Design

Separate selection and dragging into non-overlapping targets.

- The tab icon, name, status, and unused row body remain ordinary activation targets and never enter pointer capture.
- Only the dedicated tab drag handle can start a reference drag; group dragging retains its own handle.
- The drag handle is consistently available in supported horizontal and vertical desktop layouts and never activates the tab.
- Settings, close, detach, and overflow controls keep their own actions and do not activate the row.
- Existing Enter/Space activation, roving focus, active state, and full-row hover remain intact.
- Touch behavior remains handle-only, matching the explicit interaction model.

## Verification

A real Chromium regression covers session and webview activation through icon, name, and row padding because DOM emulation does not reproduce pointer-capture click retargeting. Focused DOM tests cover handle-only drag initiation, drag-without-activation, separate controls, Enter/Space behavior, and active/ARIA state. CSS assertions cover pointer, hover, active, and handle affordances.

## Scope

No backend or persisted-layout changes. Semantic move operations and the existing drag threshold remain unchanged.
