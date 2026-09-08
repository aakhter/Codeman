# COD-431 preview link bounds with sentence punctuation

## Problem

Terminal output can present a document as a dash-led bullet with a descriptive
label, a bounded path, and sentence punctuation after the closing delimiter, for
example:

```text
– Editable PowerPoint (out/networking-ai-era-session/deliverables/deck.pptx).
```

The preview link must cover only the document path. The label and the sentence
punctuation are prose and must remain outside the clickable range.

## Decision

Preserve the closing bound when sentence punctuation follows it, so the
existing marker-preview scanner can still extract the bounded path. Reuse the
current bounded-path extraction and path validation rather than changing the
fallback token scanner or the preview routes.

## Behavior

- A marker-led bullet with a parenthesized, bracketed, braced, quoted, or
  backticked supported path followed by sentence punctuation links only the
  path text.
- Existing marker behavior remains unchanged when no sentence punctuation is
  present.
- Existing path normalization, workspace confinement, extension allowlists, and
  external-attachment rules remain authoritative.
- Unrecognized or invalid candidates remain unlinked; no broader prose scan is
  introduced.

## Testing

Add a focused terminal link-provider regression test for the reported
PowerPoint line with trailing sentence punctuation. Assert the link text,
terminal range, and preview activation target. Keep the existing bounded-marker
tests as regression coverage, then run the targeted suite plus repository static
checks.
