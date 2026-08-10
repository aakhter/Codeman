# COD-288 Numbered External Path Preview Design

## Outcome

When terminal output contains a supported absolute file path after a narrow list marker such as `1. `, `- `, or `* `,
Codeman will link the complete path. An in-workspace path will continue to open through the session file viewer. A deliberate
click on an out-of-workspace path will register it through the existing explicit attachment endpoint and then open it in the
shared attachment viewer.

This extends COD-288 without restoring the malformed trailing-fragment behavior that COD-288 removed.

## Root Cause

`registerFilePathLinkProvider()` recognizes an unquoted spaced absolute path only when the trimmed terminal line starts with
`/`. The reported output starts with `1. `, so the whole-path rule is skipped. The generic scanner then splits on whitespace
and can treat a trailing fragment as a valid workspace-relative file path. Activation sends that fragment to
`openFilePreview()`, which targets a file that does not exist in the session workspace.

## Browser Design

The terminal path scanner will recognize only these line-leading decorations before an unquoted absolute path:

- ordered-list markers: one or more digits followed by `.` or `)`;
- unordered-list markers: `-`, `*`, or `•`;
- whitespace between the marker and the path.

The candidate must consume the remainder of the logical terminal line after trailing sentence punctuation is removed. This
keeps ordinary prose ambiguous by design and avoids greedily merging multiple paths.

The scanner will distinguish two valid targets:

1. **Workspace target:** path normalization proves the absolute path is inside the session working directory. Activation
   calls the existing `openFilePreview(relativePath, sessionId)` flow.
2. **External target:** the candidate is an absolute, normalized, traversal-free path with a supported preview extension,
   but it is outside the workspace. Activation calls a new browser helper with the complete absolute path and originating
   session ID.

The helper will `POST /api/sessions/:id/attachments` with `{ path }`. On success it will call
`openFilePreview(fileName, sessionId, attachmentId)`, using the opaque attachment ID and viewer routes returned by the server.
It will surface the server's safe error message when registration fails.

## Security Boundary

Terminal output alone will not register or read a file. Registration occurs only after a user activates the link. The
existing explicit attachment endpoint remains authoritative: it resolves symlinks, rejects sensitive and configured blocked
paths, enforces supported extensions and any enabled workspace-confinement policy, and returns opaque attachment routes.
Existing viewer routes retain their byte-serving limits. No filesystem-picker root is added, no raw absolute path is placed
in a browser preview URL, and passive `codeman://attach` confinement is unchanged.

## Error Handling

- Unsupported, malformed, traversal-containing, or multi-path candidates are not linked.
- A missing, blocked, oversized, or otherwise rejected external target leaves the viewer closed and displays an error toast.
- A malformed success response without an attachment ID is treated as a registration failure.
- Existing in-workspace preview behavior does not gain a network registration round trip.

## Tests

Focused browser-unit coverage will prove:

- the exact numbered Webex archive PDF path is emitted as one link;
- activation passes the complete path and originating session ID to the external-preview helper;
- ordered and unordered markers are recognized without absorbing the marker into the link range;
- an equivalent in-workspace list item still calls the existing relative-path viewer;
- prose, multiple paths, traversal, unsupported extensions, and COD-288 own-line suppression do not regress;
- the external-preview helper posts to the explicit attachment endpoint and opens the returned attachment ID;
- registration errors fail closed and surface a toast.

Verification will include the focused terminal-link and preview-helper tests plus typecheck, lint, formatting, lockfile, public
asset validation, and production build.
