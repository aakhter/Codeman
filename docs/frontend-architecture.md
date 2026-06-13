# Frontend Architecture

The browser frontend is **plain JS/CSS/HTML** under `src/web/public/` — no
framework, no bundler at runtime. Modules are loaded as ordinary `<script>` tags
in a fixed order and communicate through a shared `app` object and SSE events.

This document holds the full module map, load order, z-index contract, header-button
opt-in mechanics, and the gesture-control overlay. `CLAUDE.md` keeps only the
keyboard shortcuts and respawn presets inline (frequently referenced); everything
else lives here.

## Module map

`app.js` (~4.2K lines) is the core. Around it:

| Group | Modules |
|-------|---------|
| **Infra (6)** | `constants.js`, `sanitize-html.js`, `mobile-handlers.js`, `voice-input.js`, `notification-manager.js`, `keyboard-accessory.js` |
| **Domain (7)** | `terminal-ui.js`, `respawn-ui.js`, `ralph-panel.js`, `orchestrator-panel.js`, `settings-ui.js`, `panels-ui.js`, `session-ui.js` |
| **Feature (5)** | `ralph-wizard.js`, `api-client.js`, `subagent-windows.js`, `input-cjk.js`, `image-input.js` |
| **Other** | `sw.js` (service worker) |

Every module has an `@fileoverview` with `@dependency`/`@loadorder` tags —
`grep -l '@fileoverview' src/web/public/*.js` lists them. Read the header before
diving in.

### Local packages consumed by the frontend

- `packages/xterm-zerolag-input/` — local-echo overlay; single-source, bundled to
  the gitignored `src/web/public/vendor/xterm-zerolag-input.js` and consumed by
  `app.js` via `new LocalEchoOverlay(terminal)`. See `CLAUDE.md` → Common Gotchas
  and `docs/local-echo-overlay-plan.md`.
- `packages/gesture-control/` (`codeman-gesture-control`) — hand-tracking overlay;
  built to `src/web/public/gesture/gesture-codeman.js` via `npm run build:gesture`.
  See **Gesture control** below.

## Load order

Scripts load in this exact order (the number is the `@loadorder` tag):

```
constants.js (1) → mobile-handlers.js (2) → voice-input.js (3) →
notification-manager.js (4) → keyboard-accessory.js (5) → input-cjk.js (5.5) →
sanitize-html.js (5.7) → app.js (6) → terminal-ui.js (7) → respawn-ui.js (8) →
ralph-panel.js (9) → orchestrator-panel.js (9.5) → settings-ui.js (10) →
panels-ui.js (11) → session-ui.js (12) → ralph-wizard.js (13) →
api-client.js (14) → subagent-windows.js (15) → image-input.js (16)
```

`input-cjk.js` handles CJK IME composition via an always-visible textarea below
the terminal (`window.cjkActive` blocks xterm's `onData` while composing).

## Z-index layers

| Layer | z-index |
|-------|---------|
| local echo overlay | 7 |
| subagent windows | 1000 |
| plan agents | 1100 |
| mobile/tablet fixed header (`mobile.css`) | 1200 |
| modals on ≤768px | 1300 — **must beat the fixed header** or the modal close button is buried (bug fixed in `b8cb467`) |
| log viewers | 2000 |
| image popups | 3000 |

## Header buttons (opt-in, hidden by default)

Both of these header buttons ship hidden and are enabled under **App Settings →
Display**. The hide/show mechanism is a **marker CSS class**, not inline style,
because the base rules use `!important`.

### Multi-monitor button

- Setting: **Header Displays → "Multi-monitor Button"** (`showMultiMonitorButton`).
- `app.launchMultiMonitor()` (in `panels-ui.js`) POSTs `/api/system/span-displays`,
  which spawns `scripts/span-codeman.sh` — a fresh, maximized browser `--app`
  window sized to the union of all displays (macOS; needs "Displays have separate
  Spaces" **OFF**). Supports dragging the gesture layer's floating session panels
  across the physical monitor seam.
- Template ships the button with `btn-multimonitor--hidden`. `renderIndexHtml`
  **strips that class at render** when the setting is on (a unique class token, not
  a brittle aria-label/style match); `applyHeaderVisibilitySettings()` toggles the
  same class live on save. Solo (detached) windows hide it via `body.solo-mode`.
- The notification bell beside it stays hidden — notifications live in Settings →
  Notifications.

### Response-viewer (eye) button

- Setting: **Response Viewer** (`showResponseViewer`). Purely client-side (no
  `renderIndexHtml` step): the template ships `btn-response-viewer-header--hidden`
  and `applyHeaderVisibilitySettings()` (settings-ui.js) toggles it after settings
  load. The base rule is `display:inline-flex !important`, so hiding **must** go
  through that marker class — an inline style can't override it.
- `showResponseViewer` is in the `displayKeys` per-device set (settings-ui.js), so
  it does **not** sync across devices.

## Gesture control (camera hand-tracking overlay)

**Opt-in, default OFF**, under App Settings → Display → **Input**
(`gestureControlEnabled`).

### Availability vs. enablement

- `CODEMAN_GESTURE=1` makes the feature *available* on the instance (CSP widening
  + `/gesture/` assets) and sets `window.__codemanGestureAvailable` (the Input
  settings section only shows when set).
- The overlay bundle is injected by `renderIndexHtml` **only when the setting is
  enabled**, so that method is `async` and reads `settings.json` via
  `readSettings(true)` — the `true` forces a **fresh** read (bypassing the 2s
  `_settingsCache`), because a post-save reload happens within that TTL and the
  cached value would otherwise render the pre-toggle state.
- Toggling the setting reloads the page (the bundle is render-injected).

### Source and build

Source lives in-repo at `packages/gesture-control/` (workspace package
`codeman-gesture-control`, formerly the standalone `Ark0N/codeman-gesture-control`
repo):

- Transport-agnostic core: `src/gesture/*` (MediaPipe GestureRecognizer →
  One-Euro-filtered cursor → pinch state machine).
- Codeman consumer: `src/codeman/entry.ts` maps grab/drag/drop onto real
  `.session-tab`/toolbar buttons and is the bundle entry. It mounts
  `window.__codemanGesture = new GestureBridge()` idempotently at module-eval.

**Edit there, then run `npm run build:gesture`** (`scripts/build-gesture-bundle.mjs`
→ esbuild bundles `entry.ts`, MediaPipe JS included, into
`src/web/public/gesture/gesture-codeman.js`) and **commit the regenerated bundle** —
the committed bundle is what dev/`tsx` serves (no runtime bundler), and
`scripts/build.mjs` reruns the same step so prod always reflects current source.

The MediaPipe **wasm + model** are NOT bundled — loaded at runtime from same-origin
`/gesture/wasm` + `/gesture/gesture_recognizer.task`, fetched by
`scripts/fetch-gesture-assets.mjs` (gitignored). ⚠️ Keep `MP_VERSION` in
`fetch-gesture-assets.mjs` in sync with `@mediapipe/tasks-vision` in
`packages/gesture-control/package.json`.

A standalone vite playground (`npm run dev` **in** the package — fake tabs, no
Codeman) lets you iterate on gesture *feel* in isolation.

## Cache-busting (why a normal reload is enough)

The production server caches static files for 1 year `immutable` (`maxAge: '1y'`
in `server.ts`). `renderIndexHtml` runs `cacheBustAssets(html)` — appending
`?v=<mtime>` to **every same-origin `.js`/`.css`** `<script>`/`<link>` reference
(mtime memoized ~1s). Because `index.html` is served `no-cache`, a **normal reload
picks up edited modules/styles — no hard refresh needed**. The gesture bundle is
injected separately with its own `?v=`. An asset referenced by an *absolute* URL or
from JS (not a `<script>/<link>` tag) won't be auto-busted.

## Related

- `CLAUDE.md` → Architecture (core-file map, key patterns) and the inline keyboard
  shortcuts + respawn presets.
- `docs/local-echo-overlay-plan.md`, `docs/terminal-anti-flicker.md`,
  `docs/browser-testing-guide.md`.
