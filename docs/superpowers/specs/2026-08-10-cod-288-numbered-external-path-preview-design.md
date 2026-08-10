# COD-288 Numbered External Path Preview Design

## Outcome

When local-session terminal output contains one supported absolute file path after a narrow list marker such as `1. `,
`- `, or `* `, Codeman will link the complete path. An in-workspace path will continue to open through the session file
viewer. A deliberate click on an out-of-workspace path will register it through the existing explicit attachment endpoint
and then open it in the shared attachment viewer.

This extends COD-288 without restoring the malformed trailing-fragment behavior that COD-288 removed.

## Root Cause

`registerFilePathLinkProvider()` recognizes an unquoted spaced absolute path only when the trimmed terminal line starts with
`/`. The reported output starts with `1. `, so the whole-path rule is skipped. The generic scanner then splits on whitespace
and can treat a trailing fragment as a valid workspace-relative file path. Activation sends that fragment to
`openFilePreview()`, which targets a file that does not exist in the session workspace.

COD-288's early return also does not suppress the later legacy absolute-path scanner. That scanner can recreate a broken
link for roots such as `/home`, `/tmp`, `/var`, `/etc`, or `/opt` even after document scanning rejects the whole candidate.

## Candidate Grammar

The terminal scanner will recognize only these line-leading decorations before an unquoted absolute path:

- ordered-list markers: one or more digits followed by `.` or `)`;
- unordered-list markers: `-`, `*`, or `•`;
- at least one space or tab between the marker and the path.

The post-marker remainder must satisfy a conservative, linear single-path check:

- it begins with `/`, is at most 1,000 characters, and contains no control characters, quotes, backticks, backslashes,
  URI scheme, or second space-prefixed `/`;
- after trailing sentence punctuation is removed, it ends in one of the terminal viewer's preview extensions;
- it contains no prose boundary (` — `, ` – `, ` → `, ` => `, or ` -> `);
- no earlier whitespace-delimited chunk, after surrounding punctuation is removed, ends in an extension-like suffix. This
  deliberately rejects more than the viewer allowlist so a non-preview file such as `report.zip` cannot anchor greedy prose.

The last condition rejects greedy candidates such as `/path/report.docx — see notes.md`, where accepting the entire remainder
would both create a dead link and suppress the real path. Ambiguous candidates fail closed. The marker is never included in
the link range.

The scanner will return structured results: preview references plus path ranges that later file scanners must suppress.
Ordinary URL detection retains first priority. External marker references and hard suppression ranges are reserved first;
command and Bash links retain their established live-log precedence over workspace documents; workspace documents then claim
their ranges before the legacy absolute-path fallback. Rejected candidates block only ambiguous relative fragments while
allowing complete absolute paths, or later document references after a complete leading file token, to retain existing behavior.

## Target Classification

The scanner will distinguish two valid targets:

1. **Workspace target:** path normalization proves the absolute path is inside the session working directory. Activation
   calls the existing `openFilePreview(relativePath, sessionId)` flow with no registration request. It retains the terminal
   viewer's broader 20-extension set.
2. **External local-host target:** the candidate passes the single-path grammar and attachment extension allowlist but is
   outside the workspace. It must additionally end in one of the attachment registry's 11 supported extensions: `png`,
   `jpg`, `jpeg`, `gif`, `webp`, `pdf`, `docx`, `pptx`, `xlsx`, `md`, or `txt`. This target is available only when the
   originating session has neither `remote` nor `docker` metadata. Activation calls a new browser helper with the complete
   absolute path and originating session ID.

For remote and Docker sessions, an out-of-workspace candidate is not linked and its range remains suppressed. This prevents
an agent-side path from being resolved accidentally against the Codeman host. Remote materialization and container-path
resolution are separate features and are not added here.

## External Preview Helper

The helper will mirror `openFileUriPreview()`:

1. Open the shared preview overlay in a loading state and show the complete absolute path as the title.
2. Establish an ownership token and abandon every later result if the user has opened another preview.
3. Deduplicate concurrent activations of the same `(sessionId, absolutePath)` so double-clicking produces one request.
4. `POST /api/sessions/:id/attachments` with `{ path }`.
5. Validate an HTTP success envelope containing non-empty string `fileName` and `attachmentId` values.
6. Call `openFilePreview(fileName, sessionId, attachmentId, { displayPath: absolutePath })`. The viewer uses `displayPath`
   while creating its own new preview state and title, so the resolver never performs an unowned title write afterward.

Network failures, invalid responses, and server rejections render a bounded, escaped error inside the overlay. The helper
does not open the attachment viewer after it loses ownership.

Successful registration intentionally persists an attachment-history item, broadcasts the existing attachment event, and
may surface an attachment card. Registry path deduplication makes repeated later clicks reuse the existing record.

## Server Boundary

`POST /api/sessions/:id/attachments` will pass the Fastify request to `findSessionOrFail(ctx, id, req)`, matching the adjacent
file-URI endpoint and read routes. In multi-user mode, a caller therefore cannot register an attachment against another
user's session.

The explicit attachment endpoint remains authoritative: it resolves symlinks, rejects sensitive and configured blocked
paths, enforces the attachment extension allowlist and any enabled workspace-confinement policy, and returns opaque
attachment routes. Existing viewer routes retain their byte-serving limits. No filesystem-picker root is added, no raw
absolute path is placed in a browser preview URL, and passive `codeman://attach` confinement is unchanged.

Click-gated registration can reveal whether a local path is missing, blocked, or unsupported through bounded error text.
That is the existing explicit-attachment behavior and is acceptable for an authenticated, deliberate same-host action.

## Error Handling

- Unsupported, malformed, traversal-containing, prose-like, multi-path, remote, or Docker external candidates are not linked
  and cannot fall through to a partial path link.
- Missing, blocked, oversized-at-serve-time, or otherwise rejected external targets leave the overlay in an error state.
- A malformed success response without both a file name and attachment ID is treated as a registration failure.
- Existing in-workspace preview behavior does not gain a network registration round trip.

## Tests

Focused browser-unit coverage will prove:

- the exact numbered Webex archive PDF path is emitted as one link whose range excludes the marker;
- ordered and unordered markers, multi-space/tab separators, wide characters, and wrapped logical lines map correctly;
- non-markers, prose-tailed paths, multiple paths, traversal, unsupported extensions, and invalid syntax fail closed;
- rejected marker candidates do not reappear through generic token, command, Bash, or legacy absolute-path scanning;
- an equivalent in-workspace list item calls the existing relative-path viewer without fetching;
- remote and Docker out-of-workspace candidates remain inert;
- scanning remains linear for long marker-prefixed lines;
- the helper posts an encoded session route with the exact spaced path and opens the returned attachment ID;
- malformed success responses, HTTP errors, and network errors render bounded errors without opening a viewer;
- duplicate activation produces one request and stale completion cannot replace a newer preview.

Focused route coverage will prove:

- a foreign multi-user session returns 404 during explicit attachment registration;
- sensitive paths and symlinks resolving into blocked trees remain rejected;
- missing and unsupported files retain their current safe failures.

Verification will include the focused terminal-link, preview-helper, and route tests plus typecheck, lint, formatting, lockfile,
public asset validation, and production build.
