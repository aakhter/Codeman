# COD-261 attachment-viewer original-file download

## Goal

Give every file opened in the shared attachment viewer one consistent, accessible Download action. The action downloads the original attachment or workspace file, never a converted preview artifact.

## Scope

Add one header action beside the existing viewer actions. It is enabled synchronously when an active preview has a valid identity. Activating it uses the existing client-side download flow: fetch the raw route, create a Blob download with the known source filename, and show a success or error toast. This preserves the viewer's existing error behavior when an attachment has expired, a file was renamed, or the server rejects the request.

The route is derived only from the identity-bearing active `filePreviewState`; it never reads metadata `previewUrl` or `url` candidates, which may name a converted render rather than the source:

- Attachment previews use `/api/sessions/:sessionId/attachments/:attachmentId/raw?download=true`.
- Workspace-file previews use `/api/sessions/:sessionId/file-raw?path=:filePath&download=true`.

The action is intentionally independent from the rendered preview URL. A DOCX/PPTX preview may render a converted PDF, but Download retrieves the DOCX/PPTX. An image preview may support Copy to Clipboard, but Download retrieves the original image source. The source filename comes from the active file path or attachment filename, not an HTTP `Content-Disposition` header.

## Behavior and safety

- Opening, closing, or replacing a preview resets the control. A valid current identity enables it without waiting for metadata or conversion; an activation rechecks that the same preview state still owns the overlay before requesting bytes.
- URL construction encodes session identifiers, attachment identifiers, file paths, and query parameters correctly. It adds `download=true` without dropping an existing query string.
- When the current preview has an observed `mtimeMs`, the raw request also carries it as a cache-busting `_t` parameter. The action remains usable before metadata returns; after a live-poll refresh, it must request the refreshed source bytes rather than a browser-cached prior version.
- The action uses the existing client-side fetch→Blob→toast behavior rather than navigating to a raw route. It does not alter preview navigation, polling, rendering, Clipboard copy, attachment history, or the existing attachment-card download links.
- The header button is `type="button"`, has a visible Download label, an `aria-label` that distinguishes it from document-export actions (for example, `Download original file`), a tooltip, and a disabled state. Failed downloads show the existing error toast.
- A stale prior preview cannot activate the control or complete a download for a newer preview. The implementation does not need metadata-derived URL validation because it constructs the route from the current encoded identity.
- The existing workspace Office footer `Download DOCX` / `Download PPTX` control is removed in favor of the single shared header action. `Export PDF` remains in the footer; attachment-card Download links remain unchanged.

## Non-goals

- No new backend endpoint, storage, conversion behavior, or export workflow.
- No changes to the embedded browser/PDF toolbar.
- No bulk-download, download-progress, or per-preview-type controls.

## Tests

Focused viewer tests will demonstrate RED then GREEN for:

1. Attachment and workspace-file identities resolving to the corresponding raw routes with `download=true`.
2. Office conversion previews downloading their original source rather than the rendered PDF, with no residual footer source-download control.
3. Image previews retaining Copy to Clipboard while exposing original-file download.
4. Synchronous enablement, reset on close/replacement, stale activation rejection, and an explicit negative assertion that metadata `previewUrl` and `url` are never read.
5. Fetch failures including expired attachment/not-found and oversized-file responses producing an error toast rather than navigation to a JSON error payload, plus a refreshed `mtimeMs` producing a cache-busting request for current bytes.
6. Existing navigation and Open in New Tab behavior staying unchanged.
7. A narrow (≤430px) viewer-header check that the new control does not overlap the existing navigation or actions.

Use a COD-261-specific test filename; do not add an incidental `.browser.test.ts` test to the CI suite. Reuse one frontend helper for safely adding `download=true` instead of introducing another inline query-string variant.

## Verification

Run the safe focused Vitest file(s), TypeScript typecheck, scoped lint, lockfile check, frontend syntax checks, public-asset checks, production build, and an isolated beta-browser check at desktop and ≤430px viewport widths. Browser verification must include original bytes/name, source-versus-rendered Office behavior, success feedback, and a failed download toast. `panels-ui.js` and `index.html` are Prettier-ignored, so frontend syntax and public-asset checks are the relevant static gates. Production is out of scope and remains untouched without explicit authorization.
