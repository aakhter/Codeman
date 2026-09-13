# COD-436 Remote Generated-Artifact Path Preview

## Problem

A remote Codex terminal can print a generated PNG both as `file:///...` and as a plain absolute macOS path. The URI uses the guarded remote generated-artifact resolver. The plain path instead uses the local-only external-attachment route, which checks the Codeman host and reports that the existing remote file is missing.

## Decision

For a plain absolute path activated from a remote **Codex** session, the browser will encode that path as a local `file:` URI and delegate to the existing `openFileUriPreview()` flow. No new route, remote filesystem browser, or broad attachment authority is introduced.

Local sessions and non-Codex remote sessions retain the existing external-path behavior. The server remains the enforcement point: `file-uri-preview` accepts only Codex sessions and only generated artifacts or workspace files allowed by its existing validation and remote materialization safeguards.

## Data flow

`terminal plain path click` -> `openExternalPathPreview(path, sessionId)` -> remote Codex guard -> `openFileUriPreview(pathToFileUri(path), sessionId)` -> authenticated `file-uri-preview` endpoint -> existing remote inspection, bounded transfer, opaque attachment ID -> existing in-app preview.

## Failure handling

Rejected paths, unavailable remote hosts, unsupported types, and files that disappear continue to show the resolver's sanitized error. The client must not fall back to the local-only attachment route after a remote Codex resolution failure.

## Verification

Add a UI regression test that proves a remote Codex absolute macOS PNG path calls the file-URI endpoint with correctly percent-encoded input, and that local/non-Codex callers preserve the existing attachment endpoint. Run the focused suite, typecheck, lint, format check, lockfile check, and production build before review.
