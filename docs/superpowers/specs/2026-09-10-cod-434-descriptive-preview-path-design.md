# COD-434 descriptive marker preview-path bounds

## Governing question

How should terminal document-link detection handle a marker-led line that
contains descriptive prose followed by one final relative document path?

## Observed behavior

The terminal link provider already handles complete marker paths and explicitly
bounded paths such as parenthesized or labeled references. It does not handle a
plain descriptive marker such as `• Updated out/.../plan.docx.`: the marker
scanner treats the prose prefix, path, and sentence punctuation as one relative
candidate. The resulting link range is wider than the document path and sends
the wrong text to preview activation.

## Decision

Extend the existing marker scanner with a conservative final-path extraction
branch. When a marker remainder is not already handled by an absolute path,
label, or explicit wrapper, inspect its final whitespace-delimited token. Treat
that token as a candidate only when all of the following are true:

- the token contains a path separator and ends in an extension already accepted
  by the existing preview-extension allowlist;
- the token passes the existing relative-path normalization and validation
  gates after sentence punctuation is trimmed;
- the prose before the token is exactly one non-space descriptor token, with no
  slash or filename-like extension, so an ambiguous line with multiple
  document references does not silently select a suffix;
- the extracted range is non-empty and remains within the marker remainder.

The extraction is deliberately deterministic: trim the same sentence
punctuation already accepted by the marker scanner, split at the final
whitespace boundary, and use the suffix only when it contains `/` and passes
`isSingleRelativePath(candidate, true)`. The prefix must be one non-space token,
must contain no `/`, and must not look like a filename; this rejects earlier
paths, bare filenames, and URL-like prose without trying to classify arbitrary
natural language. Unwrapped spaced paths remain on the existing complete-marker
branch rather than being shortened to a suffix.

The existing wrapper and `Label: path` branches retain priority. If the new
candidate fails any gate, the current complete-marker behavior remains in force
and no partial suffix is linkified.

## Components and data flow

The change is limited to `registerFilePathLinkProvider()` in
`src/web/public/terminal-ui.js`:

1. The marker scanner receives the complete marker remainder.
2. Existing absolute, labeled, and explicitly bounded-path extraction runs
   first.
3. The new branch identifies one final relative path token only when the
   preceding prose is path-free.
4. Existing normalization resolves the candidate against the workspace or pane
   cwd, preserving the current local, remote, Docker, and external-preview
   behavior.
5. The link range uses the candidate's exact source offsets; prose and trailing
   punctuation remain outside the link.

No route, attachment, or preview activation changes are required.

## Error handling and security

The extraction branch does not widen accepted filesystem scope. Existing path
normalization, traversal rejection, extension allowlists, workspace
containment, remote/Docker restrictions, and external attachment registration
remain authoritative. Ambiguous lines with another path-like segment in their
prefix fail closed for the new branch and are still available to the provider's
existing complete-reference recovery logic where that behavior already
applies.

## Testing

Add focused provider coverage for:

- a status-word marker followed by a relative document path and sentence
  punctuation, asserting exact link text and terminal range;
- activation resolving the extracted path through the existing preview callback
  with the originating session;
- an existing explicitly bounded path with spaces, confirming the new branch
  does not displace that behavior; unwrapped paths with spaces remain outside
  the whitespace-delimited branch;
- an ambiguous marker containing an earlier path-like segment, asserting that
  the new branch does not manufacture a link whose text is only the final
  suffix;
- an unwrapped spaced marker path, asserting that it remains a complete path
  rather than being shortened to its final component;
- an earlier bare filename in marker prose, asserting that it does not permit a
  later suffix target;
- existing bounded-marker, labeled-path, and complete-marker regressions.

Run the focused provider suite first, followed by typecheck, lint, format,
lockfile, frontend syntax, and relevant browser checks before completion.
