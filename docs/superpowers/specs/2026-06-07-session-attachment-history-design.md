# Session Attachment History Design

## Goal

Make attachment cards recoverable after dismissal by adding a persistent, per-session attachment history. A card dismissal should only remove the floating notification. The attachment should remain available from the session until the session is deleted.

## User Experience

Floating attachment cards keep their current behavior: new attachments appear as compact cards with thumbnail, filename, metadata, and Preview, Download, and Open actions. The dismiss button removes that floating card only.

Each session gains an Attachments entry point in the session UI. Opening it shows the session's historical attachments in newest-first order. Each row uses the same thumbnail and core metadata as the floating card:

- filename
- type
- size
- time added
- source: detected in workspace or explicitly attached
- actions: Preview, Download, Open, Re-show Card

Re-show Card recreates the floating card without creating a duplicate history record. Preview, Download, and Open use the same routes as current cards.

The history survives browser reload, browser reconnect, and Codeman server restart. Deleting a session deletes its attachment history.

## Architecture

Attachment history becomes session state, not browser-only state. The existing transient browser map remains only for currently visible floating cards.

Backend responsibilities:

1. Normalize every attachment event into a durable `SessionAttachmentHistoryItem`.
2. Persist that list on `SessionState` through the existing `StateStore`.
3. Register or re-register live attachment routes for history items when possible.
4. Expose a session-scoped list endpoint for the UI.

Frontend responsibilities:

1. Continue rendering floating cards from `attachment:detected` SSE events.
2. Treat dismiss as a UI-only action.
3. Render the session Attachments drawer/list from the backend list endpoint.
4. Use existing preview/download/open logic for both floating cards and history rows.

## Data Model

Add an optional field to `SessionState`:

```ts
attachmentHistory?: SessionAttachmentHistoryItem[];
```

Each item contains only safe metadata and route-reconstruction data:

```ts
interface SessionAttachmentHistoryItem {
  id: string;
  sessionId: string;
  fileName: string;
  extension: string;
  attachmentType: AttachmentDetectedType;
  size: number;
  mtimeMs: number;
  timestamp: number;
  source: 'detected' | 'external';
  relativePath?: string;
  externalPath?: string;
  missing?: boolean;
}
```

Detected workspace files store `relativePath`; explicit attachments store `externalPath`. The browser never receives arbitrary absolute paths. API responses convert each item into safe route URLs, using `attachmentId` routes for registered external items and existing file routes for workspace items.

## API

Add:

```http
GET /api/sessions/:id/attachments
```

Response:

```ts
{
  success: true,
  data: AttachmentHistoryViewItem[]
}
```

`AttachmentHistoryViewItem` mirrors the existing attachment card event shape:

- `sessionId`
- `filePath`
- `relativePath`
- `fileName`
- `extension`
- `attachmentType`
- `timestamp`
- `size`
- `source`
- `missing`
- `attachmentId?`
- `rawUrl?`
- `previewUrl?`
- `thumbnailUrl?`

`POST /api/sessions/:id/attachments` continues to register explicit attachments, but also appends or refreshes the matching history item.

The list endpoint should read from the active session when present and fall back to persisted session state when the session exists only as a stopped/restored record. Attachment Preview, Download, and Open actions do not require a running PTY; they only require the stored file reference to resolve safely.

## Persistence And Rehydration

History is persisted in `~/.codeman/state.json` with the session state. The list is capped to the newest 100 attachments per session to avoid unbounded state growth.

On server startup, stored sessions are already loaded as stopped state. Attachment history remains readable from state. For explicit external files, the backend lazily re-registers the item when listing history or serving an action:

- If the file still exists and metadata matches or can be refreshed, routes are returned.
- If the file no longer exists, the item remains in history with `missing: true`; Preview, Download, and Open are disabled in the UI.

Workspace-detected attachments are resolved through the session working directory and `relativePath`; if the file is missing, the item is marked missing.

## Dedupe Rules

History dedupes by session and stable source identity:

- external: resolved absolute path
- detected: session working directory plus relative path

If the same file is attached again, update size, mtime, timestamp, and routes, then move it to the top of the list. Do not create duplicate rows.

## UI Details

Add an Attachments paperclip icon to the top header as an active-session tool, near the existing response viewer, away digest, notifications, lifecycle log, and settings controls. It should show a small count badge for the active session when history exists. The panel is a drawer/list, not another floating-card stack, and its contents change when the user switches session tabs.

List states:

- Empty: compact empty state with no explanatory tutorial text.
- Loading: skeleton or small spinner.
- Missing file: subdued row, thumbnail fallback, disabled Preview/Download/Open.
- Available file: same thumbnail treatment as cards.

On desktop, clicking the paperclip opens a right-side drawer over the terminal area. On mobile, the same header utility opens a full-height sheet. The bottom toolbar is intentionally avoided because it is input/run focused and already crowded on phones.

## Security

The browser must never be able to submit or retrieve arbitrary absolute paths through history APIs. Absolute external paths stay server-side in persisted state. Browser actions use opaque attachment IDs or session-scoped relative paths that pass existing workspace validation.

Explicit external attachment routes remain per-session and are valid only after server-side registration. Unknown or missing attachment IDs continue to return 404.

## Error Handling

History listing should be best-effort. A missing or unreadable file should not fail the whole list. The item is returned with `missing: true`.

Thumbnail generation remains best-effort. Thumbnail failures use the existing file-type fallback.

If preview conversion fails, the existing inline viewer error behavior remains unchanged.

## Testing

Backend tests:

- Registering an explicit attachment appends history.
- Re-registering the same path dedupes and moves it to the top.
- `GET /api/sessions/:id/attachments` returns safe card-shaped data.
- Missing external files are returned with `missing: true`.
- History persists through `StateStore` session serialization.
- History is capped to 100 items per session.

Frontend tests:

- Dismissing a floating card does not remove history.
- The Attachments panel renders historical rows from the list endpoint.
- Re-show Card recreates a floating card from history.
- Missing rows disable Preview, Download, and Open.

## Out Of Scope

Do not add remote URL attachments, user-editable labels, global cross-session attachment search, manual permanent deletion of individual history items, or richer document metadata extraction in this pass.
