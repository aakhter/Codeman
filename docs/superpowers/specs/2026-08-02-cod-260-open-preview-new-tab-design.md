# COD-260 Attachment Viewer Open-in-New-Tab Design

## Goal

Add an accessible action to Codeman's shared file-preview overlay that opens the current canonical rendered preview in a separate browser tab. Reuse the existing authenticated, same-origin preview and raw-file routes; do not add a standalone viewer page, backend endpoint, or persistent state.

## Approved behavior

- Add an `Open in new tab` button to the preview header beside Copy and Close.
- Keep the action disabled while a preview is opening and whenever no safe browser-addressable URL is available.
- Prefer the metadata response's rendered `previewUrl`. This keeps Office files aligned with the converted PDF representation shown in the overlay and opens images and PDFs through their existing preview route.
- Fall back to the metadata response's same-origin `url`, then to the existing guarded raw route for the current session and file identity.
- For Markdown and plain text, the fallback opens the raw same-origin representation because Codeman's rendered prose exists only inside the overlay and COD-260 does not add a standalone viewer page.
- Open the resolved URL with `_blank` and `noopener`. The new page must not receive an opener reference.
- Reset the action on every open, navigation, close, and failed metadata request so an old document's URL can never be used for a newer preview.
- Preserve current attachment navigation, Copy, Close, polling, image fit, document view switching, annotations, source download, and PDF export behavior.

## URL derivation and safety

`openFilePreview(filePath, sessionId, attachmentId)` remains the only entry point. Its newly created identity-bearing `filePreviewState` owns an optional `externalPreviewUrl`.

Before the metadata request begins, the header action is reset and disabled. When metadata resolves for the current state, a small helper derives candidate URLs in this order:

1. `data.previewUrl`;
2. `data.url`;
3. an attachment raw route when `attachmentId` exists; or
4. a workspace raw route containing the encoded `filePath`.

Each candidate is resolved against `window.location.href` and accepted only when it uses HTTP(S) and its origin equals `window.location.origin`. The stored value is a same-origin path, query, and fragment rather than a caller-provided absolute origin. Malformed, cross-origin, or non-HTTP(S) candidates are rejected. If no candidate is accepted, the button stays disabled.

The metadata continuation may publish the derived URL only while its captured preview state is still `this.filePreviewState`. This extends the existing stale-response identity rule: a delayed response from a previous file cannot enable the button or replace the current file's URL.

## Header interaction

The static header button uses `type="button"`, an `Open in new tab` title and ARIA label, the existing compact icon-button style, and an icon consistent with external navigation. It remains in the always-visible action group so the title and COD-259 navigation continue to yield space to Copy and Close.

Activation calls one state-based method rather than embedding a URL in inline HTML. The method exits when the current state has no approved URL. Otherwise it calls `window.open(url, '_blank', 'noopener')` and defensively clears `opened.opener` when a window object is returned. A popup-blocked `null` return is non-fatal and does not mutate the current overlay.

`closeFilePreview()` clears `filePreviewState` and disables the button. The action derives everything from the current state, so no URL is written to DOM datasets, browser storage, or server state.

## Errors and concurrency

- A metadata failure leaves the action disabled while preserving the existing preview error message.
- A malformed or cross-origin metadata URL is treated as unavailable; it is never opened.
- Rapid attachment navigation resets the action immediately. Only the latest preview's metadata may enable it.
- Polling may refresh the stored URL for the same state, but a stale poll cannot update a newer preview because the existing identity guards remain authoritative.
- Opening a new tab does not close or otherwise modify the overlay.

## Scope boundaries

COD-260 does not add a standalone Codeman viewer route, reproduce Markdown/HTML rendering in a second page, preserve overlay scroll/zoom/view-mode state across tabs, add keyboard shortcuts, change download semantics, or modify backend file authorization. COD-261 owns the separate download affordance.

## Verification

Use focused TDD against the shipped `panels-ui.js` object and preview DOM:

- RED first: the preview header has no working open-in-new-tab action.
- The action starts disabled and is reset on each new preview and close.
- A current metadata response enables the action with `previewUrl` preferred over `url`.
- Workspace and attachment previews receive their exact guarded raw fallback when metadata omits both URLs.
- Activation opens the stored URL with `_blank` and `noopener`, then clears an available opener reference.
- Cross-origin, malformed, and non-HTTP(S) candidates remain disabled and cannot call `window.open`.
- A delayed metadata response from an older preview cannot enable or replace the newer preview's action.
- Existing COD-259 navigation behavior remains green.

Run the new focused regression file, the related navigation/render-state files, typecheck, lint, Prettier, lockfile validation, frontend syntax/public-asset checks, production build, and `git diff --check`. Finally, serve the exact candidate on the isolated beta slot and use Chromium to verify the header at desktop and phone widths, the opened same-origin URL, retained overlay state, and zero page errors. Production deployment requires separate explicit authorization.
