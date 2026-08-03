# COD-261 attachment-viewer original-file download

## Goal

Give every file opened in the shared attachment viewer one consistent, accessible Download action. The action downloads the original attachment or workspace file, never a converted preview artifact.

## Scope

Add one header action beside the existing viewer actions. It is enabled only while the active preview has a valid, same-origin raw-file route. Activating it opens that route with `download=true`, allowing the server to retain its existing filename and content-disposition behavior.

The route is derived from the identity-bearing active `filePreviewState`:

- Attachment previews use `/api/sessions/:sessionId/attachments/:attachmentId/raw?download=true`.
- Workspace-file previews use `/api/sessions/:sessionId/file-raw?path=:filePath&download=true`.

The action is intentionally independent from the rendered preview URL. A DOCX/PPTX preview may render a converted PDF, but Download retrieves the DOCX/PPTX. An image preview may support Copy to Clipboard, but Download retrieves the original image source.

## Behavior and safety

- Opening, closing, or replacing a preview clears the derived download URL and disables the action until the current preview state is valid.
- The resolver accepts only same-origin HTTP(S) URLs and returns a path-relative URL, consistent with the existing Open in New Tab action.
- URL construction encodes session identifiers, attachment identifiers, file paths, and query parameters correctly. It adds `download=true` without dropping an existing query string.
- The action opens the download route in a separate browsing context. It does not alter preview navigation, polling, rendering, Clipboard copy, attachment history, or the existing attachment-card download links.
- A stale metadata response or prior preview state cannot enable or activate the control for a newer preview.

## Non-goals

- No new backend endpoint, storage, conversion behavior, or export workflow.
- No changes to the embedded browser/PDF toolbar.
- No bulk-download, download-progress, or per-preview-type controls.

## Tests

Focused viewer tests will demonstrate RED then GREEN for:

1. Attachment and workspace-file identities resolving to the corresponding raw routes with `download=true`.
2. Office conversion previews downloading their original source rather than the rendered PDF.
3. Image previews retaining Copy to Clipboard while exposing original-file download.
4. Disabled/reset behavior for close, invalid identity, unsafe candidate URLs, and stale preview transitions.
5. Existing navigation and Open in New Tab behavior staying unchanged.

## Verification

Run the safe focused Vitest file(s), TypeScript typecheck, scoped lint, Prettier on changed files, lockfile check, frontend syntax checks, production build, and an isolated beta-browser check. Production is out of scope and remains untouched without explicit authorization.
