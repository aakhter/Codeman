# COD-246 Response Viewer Attachment Links Design

Date: 2026-07-26
Issue: `COD-246`
Branch: `COD-246-response-viewer-attachment-links`

## Context

Codex session `019f9b3b-6c0e-7f71-be98-3c7f2086c6de` ended with a Markdown link to this
workspace document:

```text
/mnt/c/Users/aakhter/OneDrive - Cisco/01_Projects/Other_Strategic/Projects/Source/kb/out/falck-mads-airdc-interview-review/deliverables/2026-07-17 Falck Mads Jung Johansen-AIRDC-reviewed.docx
```

The Last Response viewer rendered the link, but clicking it did not open Codeman's shared file preview
overlay. `marked` correctly parses the angle-bracket Markdown destination and percent-encodes its spaces.
The failure occurs after rendering: `_bindResponseViewerInteractions()` leaves the local-file anchor as
ordinary browser navigation, so the browser requests `/mnt/c/...` from the Codeman web origin.

The terminal link provider already routes recognized workspace document paths to `openFilePreview()`, but
that provider applies only to xterm output. It does not participate in the response viewer's sanitized
Markdown DOM.

## Goal

A normal click on a supported session-workspace document link in Last Response or the expanded transcript
opens the existing file preview overlay for the session that produced the response.

## Scope

- Recognize explicit Markdown anchors whose decoded destinations name supported previewable files.
- Accept workspace-relative paths.
- Accept absolute paths only when they normalize beneath the originating session's working directory, then
  convert them to workspace-relative paths.
- Preserve spaces and other percent-encoded path characters during the conversion.
- Reuse `openFilePreview(relativePath, sessionId)` and the existing session-scoped backend routes.
- Cover Last Response and expanded transcript rendering through their shared delegated interaction handler.

## Non-Goals

- No changes to Markdown parsing or sanitization.
- No filesystem existence check in the browser; the existing preview request reports missing files.
- No registration of response links as external attachments.
- No change to terminal path detection.
- No interception of external URLs, fragment links, unsupported file types, or paths outside the workspace.
- No production deployment as part of this issue.

## Approaches Considered

### 1. Response-viewer resolver and delegated click routing — selected

Add a small pure resolver beside the response-viewer code and call it from the existing delegated click
handler. This is the smallest change that fixes both Last Response and expanded transcripts while retaining
the established preview overlay and backend security boundary.

### 2. Refactor terminal path normalization into shared browser infrastructure

The terminal provider and response viewer could share one normalization implementation. That reduces some
duplication, but terminal discovery has different ambiguity rules because it must infer links from
unstructured text. A response-viewer anchor is already an explicit link. Refactoring the terminal path in
the same bug would broaden the regression surface without improving this fix.

### 3. Rewrite local anchors to preview API URLs during Markdown rendering

This would make the link reach a session route, but it would bypass the shared overlay UX and couple
Markdown rendering to a particular backend endpoint. It would also complicate Office conversion readiness,
error presentation, and transcript reuse.

## Design

### Path resolution

A pure response-viewer helper will receive an anchor's raw `href` plus the session working directory and
return either a safe workspace-relative preview path or `null`.

The helper will:

1. Decode the percent-encoded `href`, failing closed on malformed encodings.
2. Reject empty values, excessive lengths, backslashes, query strings, fragments, and URI schemes.
3. Require one of the existing preview-target extensions: `pdf`, `md`, `txt`, `png`, `jpg`, `jpeg`,
   `gif`, `webp`, `docx`, `pptx`, `xlsx`, `json`, `yaml`, `yml`, `csv`, `xml`, `sh`, `py`, `ts`, or
   `js`.
4. Normalize slash-separated path segments, removing `.` and rejecting empty or `..` segments.
5. For absolute paths, normalize the working directory and require a strict descendant relationship before
   stripping the workspace prefix.
6. For relative paths, return the normalized workspace-relative value.

The browser check is a UX and early-routing boundary. The server's existing
`validateSessionFilePath()` check remains authoritative and fail-closed, including canonical containment and
symlink escape protection.

### Originating-session ownership

Each call to `_bindResponseViewerInteractions(body)` will refresh a session identifier on the body before
the idempotent listener check. The delegated listener will read that current value when a link is clicked.
This avoids capturing a stale session when the reusable response-viewer DOM is opened for a different tab.

The handler will resolve the working directory from `this.sessions.get(sessionId)`. It will intercept only
anchors for which the resolver returns a preview path. On a match it will prevent browser navigation, stop
propagation, and call:

```text
openFilePreview(relativePath, sessionId)
```

All unmatched anchors retain their current browser behavior.

### Rendering paths

No new renderer is needed:

- `toggleResponseViewer()` renders Last Response and calls `_bindResponseViewerInteractions()`.
- `_renderResponseViewerMessages()` renders expanded transcript blocks and calls the same binder.

Because both flows already converge on the delegated handler, one routing change covers both views.

### Error handling

- Malformed or unsafe destinations return `null` and are not sent to `openFilePreview()`.
- A valid in-workspace path that no longer exists still opens the overlay; its existing metadata request
  supplies the standard "File not found" error.
- Preview conversion or rendering failures remain handled by `openFilePreview()` and its existing UI.

## Testing

Development will follow a failing-regression-test-first sequence in
`test/response-viewer-behavior.test.ts`.

Focused cases will prove:

1. The exact percent-encoded Falck DOCX path resolves relative to the `kb` working directory and a click
   calls `openFilePreview()` with the originating session.
2. A relative workspace document link opens the preview.
3. The same delegated behavior works inside a rendered transcript block.
4. An absolute sibling/out-of-workspace path is not intercepted.
5. Traversal, malformed encoding, unsupported extensions, fragment links, and HTTP/HTTPS URLs are not
   passed to `openFilePreview()`.
6. Rebinding the reusable viewer body updates the originating session rather than retaining a stale one.

After the targeted regression test passes, verification will include typecheck, lint, formatting,
lockfile consistency, and the production build. The full test suite will not be run from the managed
Codeman session.

## Risks

The primary risk is incorrectly treating a normal web link as a local document. Requiring a supported
extension, rejecting URI schemes, and enforcing workspace containment for absolute paths keeps interception
narrow. The second risk is stale session ownership; storing the current session on the reusable body rather
than in the one-time listener closure addresses it directly.
