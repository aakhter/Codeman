# COD-285: XLSX Terminal Preview Link Design

## Problem

The attachment stack and shared file viewer support `.xlsx`, but the terminal document-link provider's independent
`previewExtensions` allowlist does not. An in-workspace XLSX path printed in terminal output therefore remains plain text
while equivalent DOCX and PPTX paths are clickable.

## Approved behavior

Treat `.xlsx` as a previewable terminal document. Activating the link opens the existing shared spreadsheet preview
directly, using the normalized relative path and the session that owned the terminal output.

## Boundaries

- Add only `xlsx`; legacy `.xls` remains unsupported.
- Keep absolute-path workspace confinement, traversal rejection, URL precedence, wrapped-line mapping, and path
  normalization unchanged.
- Reuse `openFilePreview`; do not introduce a new viewer, route, or attachment-card behavior.

## Verification

- First add `.xlsx` to the complete supported-extension regression matrix and prove it fails against current runtime code.
- Add an activation assertion for an XLSX path, including the originating session ID.
- Run the focused terminal link-provider and regex performance tests, followed by repository quality gates and build.

