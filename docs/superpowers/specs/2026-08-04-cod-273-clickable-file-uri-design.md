# COD-273 Clickable `file://` URI Design

## Goal

Make supported `file://` URIs in Codex terminal output clickable and open the referenced file in Codeman's existing in-app preview, including when the Codex session runs on a saved remote SSH host.

## Approved behavior

- Render a complete supported `file://` URI as an underlined, pointer-enabled terminal link.
- Clicking the link opens Codeman's shared file-preview overlay. The browser never navigates to the raw `file://` URI.
- Resolve the URI on the originating session host. Local sessions read locally; remote sessions reuse the saved SSH configuration and generated-artifact cache.
- Decode percent-encoded path characters with the platform URL parser. A URI such as `file:///Users/saqeb/My%20Image.png` resolves to `/Users/saqeb/My Image.png` without truncation.
- Preserve terminal selection, copying, wrapped-link geometry, mouse behavior, and touch scrolling.
- Reuse an existing attachment registration when the same generated artifact was already detected from `Saved to:` output.
- Show missing, malformed, unsupported, oversized, inaccessible, and unauthorized targets as concise errors inside the preview overlay.

## Architecture

The feature adds a terminal detector, a small browser-to-server resolver flow, and deduplication in the existing generated-artifact registration path.

The xterm link provider in `src/web/public/terminal-ui.js` already stitches wrapped terminal rows, maps JavaScript offsets back to terminal cells, and opens workspace paths through `openFilePreview()`. It will gain a `file://` detector that runs before ordinary URL and path matching. The detector retains the encoded URI as visible link text, trims only terminal punctuation, rejects malformed or unsupported-looking candidates, and captures the originating session ID when the link is created.

Activation calls a new browser method for file-URI previews. That method immediately puts the shared preview overlay into its normal loading state, then posts `{ uri }` to `POST /api/sessions/:id/file-uri-preview`. On success it calls the canonical `openFilePreview(fileName, sessionId, attachmentId)` path with the returned opaque attachment ID. This preserves the existing renderer, polling, navigation, source download, Open in New Tab, and error protections.

The new route lives with the session file and attachment routes in `src/web/routes/file-routes.ts`. It uses the normal authenticated session lookup and request-origin protections, requires a Codex-mode session, converts the URI with Node's `fileURLToPath()`, and rejects non-file schemes, non-absolute paths, unsupported extensions, and malformed URLs before registration. It then calls `registerGeneratedArtifactAttachment()` with the session working directory and saved remote configuration. The response contains the existing sanitized attachment event; it never returns an absolute local or remote path.

## Security boundary

Terminal output is prompt-influenceable, and clicking a link must not turn it into an arbitrary host-file browser.

- The endpoint is session-scoped and available only for Codex-mode sessions, matching the existing generated-artifact listener boundary.
- Local paths remain limited to the session workspace, home-anchored `.codex`/`.codex-personal` generated image or artifact directories, and the existing allowed Superpowers output locations.
- Remote paths remain limited to the remote workspace or the matching remote user's home-anchored generated-artifact directories.
- Existing realpath checks, symlink-escape rejection, sensitive-path guards, supported-extension allowlist, size cap, SSH argv construction, timeout, and output cap remain authoritative.
- The browser receives only attachment IDs, filenames, types, sizes, and attachment routes. Server or SSH command diagnostics are not returned to the UI.
- A rejected link is non-destructive and does not fall back to browser `file://` navigation or an unconfined workspace route.

## Registration and deduplication

Codex already scans `Saved to: file://...` output and asynchronously registers the generated artifact so it can display an attachment card. A user may click the terminal URI before or after that registration completes.

`registerGeneratedArtifactAttachment()` will reuse an existing per-session registry record when its final local path is already registered. For a local file, the comparison uses the realpath-resolved target. For a remote file, the deterministic generated-artifact cache path is computed first and checked before another SSH fetch. The existing attachment event is reconstructed from the registry record and returned.

If no record exists, registration follows the current local or remote path and produces one. Concurrent first-time requests are allowed to resolve independently; the registry and session attachment-history upsert retain bounded state, and both results remain subject to the same validation. No client-side filename matching is used.

## Terminal link behavior

- `file://` detection runs before `http://`, `https://`, `webexteams://`, command-path, document-path, and legacy absolute-path detection.
- The link range covers the URI rather than the decoded path, including across existing soft and hard row wrapping.
- Encoded spaces remain part of the link. Literal whitespace terminates an unquoted URI, consistent with URI syntax.
- Common sentence punctuation is excluded only at the end of the candidate.
- A link activation is bound to the session that produced the terminal row, even if another session becomes active before the click completes.
- Existing hover state, pointer cursor, underline, touch-tap suppression, selection, and swipe handling are reused.
- The detector may recognize a malformed or ultimately unauthorized URI well enough to make it clickable; the server remains the source of truth and the preview overlay shows the safe rejection.

## Error handling and concurrency

The browser method owns a request identity so a slow URI-resolution response cannot replace a newer preview or reopen a closed overlay. A successful response re-enters `openFilePreview()` only when the URI request still owns the overlay.

The endpoint maps invalid input and unsupported types to a client error, missing local files to Not Found, rejected paths to Forbidden, and remote retrieval failures to a concise inaccessible-file response. It logs detailed server-side diagnostics without including SSH commands, credentials, or host configuration in the response.

If the URI request fails, the overlay title remains the visible URI and the body shows `Error: <safe message>`. No attachment card, download, browser tab, or terminal input action is triggered by that failure.

## Scope boundaries

- No browser navigation to `file://` URLs.
- No broad arbitrary-file access, new configured roots, or relaxation of attachment guards.
- No change to non-Codex session behavior.
- No change to how generated-artifact cards are automatically detected or presented.
- No support for directories, network file hosts, relative file URIs, or new preview extensions.
- No new file conversion, storage, or remote transport mechanism.

## Verification

Focused TDD will demonstrate RED then GREEN for:

1. Terminal detection of local and macOS-style `file://` URIs, percent-encoded spaces, trailing punctuation, and wrapped rows.
2. Activation posting to the originating session and opening `openFilePreview()` with the returned attachment ID.
3. Browser request ownership: a stale response cannot replace a newer preview or reopen a closed overlay.
4. Route acceptance for an allowed local Codex generated artifact and safe rejection of malformed schemes, unsupported extensions, non-Codex sessions, missing files, and paths outside the approved boundary.
5. Remote route handling through the saved SSH configuration with no local filesystem fallback.
6. Local and remote registration deduplication without filename-only matching.
7. Existing terminal URL, document-path, touch-tap, selection, and swipe behavior remaining unchanged.

Before integration, run every changed focused test file separately, then `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:lockfile`, frontend syntax/public-asset checks, `npm run build`, and `git diff --check`. Use a temporary local Codeman web instance with a real Chromium session to click a representative generated-image URI and confirm the in-app preview, network request, touch/selection behavior where applicable, and zero browser console errors.

After merging into `local`, rerun the relevant focused tests and production build, push `local` to Bitbucket, restart `codeman-web`, require an active service plus repeated HTTP 200 responses on port 3002, and verify the deployed asset contains the COD-273 resolver/link behavior before moving Jira to Done.
