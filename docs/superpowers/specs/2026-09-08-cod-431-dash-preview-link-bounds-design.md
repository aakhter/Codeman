# COD-431 dash-led preview link bounds

## Problem

Terminal output can present a document as a dash-led bullet with a descriptive
label and a bounded path, for example:

```text
– Editable PowerPoint (out/networking-ai-era-session/deliverables/deck.pptx)
```

The preview link must cover only the document path. The label is prose and must
remain outside the clickable range.

## Decision

Extend the existing marker-preview scanner in `terminal-ui.js` to recognize
en-dash and em-dash markers in addition to the existing ASCII and bullet
markers. Reuse the current bounded-path extraction and path validation rather
than changing the fallback token scanner or the preview routes.

## Behavior

- A dash-led bullet with a parenthesized, bracketed, braced, quoted, or
  backticked supported path links only the path text.
- Existing `-`, `*`, `•`, and numbered-marker behavior remains unchanged.
- Existing path normalization, workspace confinement, extension allowlists, and
  external-attachment rules remain authoritative.
- Unrecognized or invalid candidates remain unlinked; no broader prose scan is
  introduced.

## Testing

Add a focused terminal link-provider regression test for the reported
en-dash PowerPoint line. Assert the link text, terminal range, and preview
activation target. Keep the existing ASCII bounded-marker tests as regression
coverage, then run the targeted suite plus repository static checks.
