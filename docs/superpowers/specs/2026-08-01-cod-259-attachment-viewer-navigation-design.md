# COD-259 Attachment Viewer Previous/Next Navigation Design

## Goal

Add previous/next navigation to Codeman's shared file-preview overlay when the current file belongs to a session's attachment history. The controls must work after reloads and across browser clients without introducing browser-owned persistence or a new backend API.

## Approved behavior

- Add accessible Previous and Next buttons to the file-preview header, alongside a compact `N of M` position label.
- Use the current session's existing `GET /api/sessions/:sessionId/attachments` response as the authoritative collection.
- Preserve the order returned by that endpoint, which is also the order shown in the attachment-history drawer.
- Exclude entries marked `missing` before calculating positions or neighbors.
- Locate the current entry by `attachmentId` first. When no attachment ID is available, fall back to an exact `relativePath` match against the preview's `filePath`.
- Previous moves to the preceding entry in the filtered list; Next moves to the following entry.
- Disable Previous at the first entry and Next at the last entry. Navigation does not wrap.
- Hide the navigation group when the current preview is not in attachment history, when there is only one usable entry, or when the history request fails.
- Navigation is attachment-history scoped. Ordinary Files-panel and terminal previews that do not match a history entry retain the existing header and behavior.

## Architecture

The change is frontend-only and reuses existing server state.

`openFilePreview(filePath, sessionId, attachmentId)` remains the single document-opening path. For every open, it creates a new identity-bearing `filePreviewState`, resets the navigation UI, and starts two independent reads:

1. the existing file metadata/preview render; and
2. the existing session attachment-history list used to derive navigation.

Navigation state belongs to the same `filePreviewState` object as the preview. It contains the filtered ordered items and current index. A history response may update controls only if its captured preview state is still `this.filePreviewState`. This mirrors the existing stale-response protection for metadata and prevents a slow history response from attaching the wrong neighbors after a rapid open, navigation, or close.

No attachment-history data is written to `localStorage`. The server's persisted session history remains authoritative, so a newly loaded browser or PWA client derives the same collection.

## Header controls

The static preview header gains a navigation container with:

- Previous button: left-arrow presentation, `aria-label="Previous attachment"`, descriptive title;
- position text: `N of M`, exposed as status text but not an interactive control; and
- Next button: right-arrow presentation, `aria-label="Next attachment"`, descriptive title.

The container is hidden by default so existing previews do not flash empty or enabled controls while history is loading. It becomes visible only after a successful match with at least two usable items. Disabled buttons use the native `disabled` property and existing control styling conventions. The title remains ellipsized and must yield space to the navigation/actions without pushing the Close action out of the header.

## Navigation data flow

When attachment history resolves:

1. Read `result.data.items`; any malformed or non-array payload behaves like an empty list.
2. Filter out missing entries.
3. Find the current item by exact attachment ID. If there is no match, use exact session-relative path equality.
4. If there is no match or fewer than two usable items, leave navigation hidden.
5. Otherwise save the ordered items and current index on the current preview state, render `index + 1 of count`, and set boundary disabled states.

When a navigation button is activated, resolve the neighbor from the current preview state's snapshot and call the existing `openFilePreview()` with that item's `relativePath || fileName`, `sessionId`, and `attachmentId || null`. This deliberately re-enters the canonical open path, which tears down old polling/conversion resources, establishes a new stale-response identity, renders the new document, and re-fetches history. It does not manipulate preview content directly.

Entries that become missing between list fetch and navigation may produce the existing preview error state. The next open's history refresh will then exclude entries already marked missing; no new retry or mutation behavior is introduced.

## Close, errors, and concurrency

- `closeFilePreview()` hides the overlay and clears `filePreviewState`; a late history response fails the identity check and cannot reveal controls.
- A failed history request is non-fatal: the document preview continues normally and navigation stays hidden.
- A failed document preview does not discard valid navigation context; the user may still move to a neighbor.
- Rapid Previous/Next activation is safe because every call creates a new preview-state identity and the existing metadata/conversion guards reject stale work.
- Existing polling, annotation, resize, image fit/copy, source-download, and Office readiness behavior is unchanged.

## Scope boundaries

This issue does not add keyboard shortcuts, swipe gestures, wraparound, prefetching of neighbor content, a new backend neighbor endpoint, mutation of attachment history, or navigation across sessions. COD-260 (open in new tab) and COD-261 (consistent download) remain separate issues.

## Verification

Use focused TDD against the shipped `panels-ui.js` and preview DOM:

- RED first: an attachment preview with a three-item history has no working navigation.
- GREEN: controls show `1 of 3`, follow endpoint order, and disable only the first boundary.
- Next opens the second item's exact path/session/attachment ID; its controls update to `2 of 3` with both buttons enabled.
- Previous returns to the first item; the last item disables Next.
- Missing entries are excluded from count and neighbor selection.
- Attachment-ID matching takes precedence over duplicate filenames/paths; path fallback works when no attachment ID is supplied.
- Ordinary unmatched file previews, one-item histories, malformed responses, failed requests, and closed/stale previews keep controls hidden and do not affect document rendering.
- A delayed history response from an older preview cannot overwrite navigation for a newer preview.

Run the focused regression file plus typecheck, lint, formatting, lockfile, frontend syntax/public-asset checks, production build, and `git diff --check`. Finally, serve the candidate on the isolated beta slot and use a real Chromium check to confirm header layout, boundary states, ordering, document switching, responsive behavior, and zero page errors. Production deployment is not part of COD-259 without separate explicit authorization.
