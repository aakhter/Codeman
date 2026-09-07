# COD-429 marker preview link bounds

## Governing question

How should terminal document-link detection handle a bullet or marker line that
contains descriptive prose followed by a bounded relative file path?

## Observed behavior

The terminal link provider treats the entire marker remainder as one relative
path. For a line such as `- Partner outline (out/.../outline.md)`, the link
range includes `Partner outline (` and activation sends that combined string to
the file preview. The resulting preview cannot resolve the intended file.

## Design

Keep the existing marker scanner and its security gates, but identify a bounded
trailing relative path before applying `isSingleRelativePath` when the marker
remainder contains descriptive prose. Supported boundaries are the existing
label delimiter (`Label: path`) and a matching wrapper such as parentheses or
quotes around the path. The extracted candidate keeps its exact source range;
the prose and wrapper remain ordinary terminal text.

Explicit marker paths that begin with `/`, standalone paths, quoted paths,
wrapped xterm rows, and external-path handling retain their current branches and
behavior. If no bounded suffix can be identified, the existing complete-marker
path branch remains in force rather than adding a new partial-path guess.

## Components and data flow

The change is limited to `registerFilePathLinkProvider()` in
`src/web/public/terminal-ui.js`:

1. The marker scanner receives the complete marker remainder.
2. It extracts an explicitly bounded trailing relative path, if present.
3. Existing normalization and workspace/external resolution run on that path.
4. `addPreviewLink` creates the link using only the extracted path range.
5. Activation continues to call `openFilePreview` with the originating session.

No route or server changes are required because the current file-preview route
already enforces workspace containment.

## Error handling and security

Malformed, unsupported, traversal, ambiguous, or unbounded candidates remain
unlinked. The extracted suffix must pass the existing extension allowlist and
path normalization checks. The parser must not widen the accepted filesystem
scope or create a link from the prose prefix.

## Testing

Add a focused terminal link-provider regression test for:

- `- Partner outline (out/.../outline.md)` linking only the path suffix;
- activation passing the workspace-relative path and originating session;
- a bounded path with spaces remaining intact when wrapped;
- an existing complete marker path remaining unchanged.

Run the targeted provider test, then the repository verification checks required
by `AGENTS.md`: typecheck, lint, format check, lockfile check, and the relevant
browser/functional check if the implementation changes the browser surface.
