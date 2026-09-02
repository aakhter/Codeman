# COD-390 Labeled Spaced Path Design

## Goal

Make terminal references written as `Path:`, `File:`, or `Saved to:` followed by an absolute previewable path resolve as one complete link when the path contains spaces.

## Root cause

The terminal link provider recognizes unquoted absolute paths with spaces only when the path is the entire line or follows a list marker. A labeled line such as `Path: /mnt/syncthing/brain/90 Sensitive/...xlsx` falls through to whitespace token scanning. That scanner links only a tail such as `Sensitive/...xlsx`, which is then resolved relative to the session workspace and produces an incorrect file-not-found preview.

## Design

Add a narrow labeled-path pass in `findPreviewReferences()` before the generic token scanner. It accepts only case-insensitive `Path:`, `File:`, and `Saved to:` prefixes followed by one complete absolute path satisfying the existing `isSingleAbsolutePath()` safety checks.

The path is processed using the existing behavior:

- An in-workspace target is normalized and opened through the normal file preview route.
- A local-session target outside the workspace uses the existing external-attachment resolver.
- Remote and Docker sessions do not resolve external host paths.
- Invalid, ambiguous, traversal, unsupported, or unavailable candidates reserve their complete range so a later scanner cannot create a misleading relative tail.

No route, attachment-guard, or preview-renderer behavior changes.

## Testing

Extend `test/terminal-document-link-provider.test.ts` with the reported XLSX path and table-driven coverage for all three labels. Pin full-link range/text preservation, the normal workspace-relative preview activation, external-local routing, and safe no-link/no-tail behavior for rejected candidates.
