# COD-216 Webexteams Terminal Links Design

Date: 2026-07-09
Issue: `COD-216`
Branch: `cod-216-webexteams-link`

## Goal

When terminal output contains a `webexteams://...` URI, Codeman should render it as a clickable xterm link and attempt to open the Webex desktop handler when clicked.

## Scope

- Support `webexteams://...` in terminal output
- Reuse the existing xterm link provider in `src/web/public/terminal-ui.js`
- Preserve current behavior for `http://` and `https://` links

## Non-Goals

- No support for arbitrary custom URI schemes
- No changes to file-path link detection
- No server-side changes

## Current State

The terminal link provider already detects HTTP/HTTPS URLs with `urlPattern` and creates xterm links whose `activate` handler calls `window.open(text, '_blank', 'noopener,noreferrer')`.

`webexteams://...` URIs are currently plain text because the URL matcher only accepts HTTP/HTTPS.

## Recommended Approach

Extend the existing URL matcher to include `webexteams://...` and keep it in the same terminal link-provider flow.

Reasons:

- smallest change surface
- preserves link priority ordering already established in the provider
- avoids duplicating xterm link logic for a single additional scheme

## Design

### Matcher

Broaden `urlPattern` so it matches:

- `https://...`
- `http://...`
- `webexteams://...`

The pattern should keep the same termination rules as the current HTTP/HTTPS matcher so terminal punctuation and control characters do not become part of the link.

### Activation

Extract link opening into a small helper used by URL links.

Behavior:

- for `http:` and `https:` keep the existing `window.open(..., '_blank', 'noopener,noreferrer')`
- for `webexteams:` also use the browser open path from the click event so the OS protocol handler can take over

This keeps click behavior centralized without changing the non-Webex flow.

### Testing

Add focused regression coverage for:

1. `urlPattern` matches `webexteams://...`
2. the URL cleaner strips trailing punctuation from Webex links the same way it does for HTTP links
3. the activation path attempts to open a matched Webex URI

## Risks

Main risk is overmatching custom-scheme text that should stay plain. Constraining the change to the single literal scheme prefix `webexteams://` keeps that risk low.

## Verification

Targeted verification should cover:

- source-level regex tests for terminal link matching
- behavior test for the link activation callback

The existing `file-link-click` integration suite is not required for this issue because it exercises tmux-backed file-path handling rather than custom URI matching.
