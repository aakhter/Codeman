# COD-280 XLSX Attachment Viewer Design

## Goal

Add a local-only, read-only XLSX preview to Codeman's shared attachment viewer. Users must be able to open a workbook, switch worksheets, inspect common spreadsheet formatting, and download the original file without sending workbook data to an external service.

This is follow-up work to COD-244. That issue added XLSX upload, registration, MIME handling, and a binary fallback, but intentionally excluded spreadsheet rendering.

## Scope

### In scope

- Preview XLSX attachments registered by attachment ID.
- Preview XLSX files opened from local and remote session workspaces.
- Display worksheet tabs, cell values, cached formula results, merged cells, common number formats, fonts, fills, borders, alignment, row heights, and column widths.
- Keep the preview responsive for large used ranges by rendering only the visible grid window plus overscan.
- Download the original workbook through the existing guarded raw routes with its original filename, official XLSX MIME type, and unchanged bytes.
- Show clear states for loading, unsupported workbook features, preview limits, malformed files, and parser failures.
- Add focused backend, browser-module, overlay-integration, and download regression tests.

### Out of scope

- Editing or saving workbooks.
- Executing formulas, macros, VBA, external links, data connections, or embedded scripts.
- Pixel-perfect reproduction of Excel.
- Full support for pivot-table interaction, slicers, charts, drawings, embedded objects, or every conditional-formatting rule.
- XLS, ODS, CSV, and other spreadsheet formats.
- Collabora Online, ONLYOFFICE, Microsoft 365, CDNs, or any other external preview service.

## User experience

Opening an XLSX uses the existing file-preview overlay. The body first shows a spreadsheet-specific loading state. Once parsing finishes, the overlay contains:

- a tab strip containing every visible worksheet in workbook order;
- a read-only grid with row and column headings;
- scrollable, virtualized cells for the selected worksheet;
- a compact notice when the workbook contains features the renderer does not reproduce; and
- the existing header-level **Download** action for the original workbook.

The first visible worksheet is selected initially. Switching tabs does not re-fetch or re-parse the workbook. Empty sheets show a clear empty state. A malformed, encrypted, unsupported, oversized, or timed-out workbook shows an error or limit message while keeping Download enabled.

## Architecture

### Backend metadata and raw bytes

XLSX remains a binary OOXML file on the server. Existing attachment and workspace raw routes remain the only file-serving surfaces:

- `/api/sessions/:id/attachments/:attachmentId/raw`
- `/api/sessions/:id/file-raw?path=...`

The metadata branches in `file-routes.ts` classify XLSX as `spreadsheet` instead of generic `binary`. Their preview URL points to the corresponding guarded raw route. No XLSX-to-HTML endpoint and no arbitrary-path endpoint are added.

Attachment-ID raw requests retain the current 50 MiB cap, path re-resolution, attachment guard, ownership checks, and content-disposition behavior. Workspace-file raw requests retain their current local and remote confinement. Download requests continue to add `download=true`; the raw route supplies the official XLSX MIME type and `Content-Disposition: attachment`.

### Local parser delivery

Add ExcelJS as a pinned production dependency. Codeman's postinstall/build asset preparation copies its minified browser bundle into `src/web/public/vendor/`, following the existing local-vendor pattern. The application never loads parser code from a CDN.

The spreadsheet module lazy-loads this local bundle only when an XLSX preview opens. Other sessions and document types pay no parser download or initialization cost.

### Worker parsing boundary

`spreadsheet-preview-worker.js` owns untrusted workbook parsing. It imports the local ExcelJS browser bundle, parses the fetched `ArrayBuffer`, and emits a normalized, structured-clone-safe workbook model. The worker never evaluates formulas. Formula cells expose only their cached result when available; otherwise the formula is displayed as inert text.

The normalized model contains:

- workbook-level feature warnings;
- sheet name, visibility, used range, row heights, and column widths;
- sparse cells keyed by row and column;
- display text and a constrained style object; and
- merged ranges.

The worker strips hyperlinks, rich HTML, external relationships, scripts, and unsupported object payloads. Cell content crosses the worker boundary as text or primitive values only.

The main thread terminates a parse that exceeds 20 seconds. Closing or replacing the overlay also terminates the active worker and revokes any temporary resources.

### Rendering module

`spreadsheet-preview.js` exposes a small lifecycle API to `panels-ui.js`: open, select sheet, resize, and dispose. It owns workbook fetch, lazy parser loading, worker coordination, tab state, viewport state, and rendering.

The renderer uses a sparse virtual grid rather than a full HTML table. It computes cumulative row and column offsets, finds the visible window from scroll position, and creates DOM nodes only for visible cells plus overscan. Merged ranges render as one positioned cell using the combined dimensions of their rows and columns. Row and column headings remain synchronized with the viewport.

Cell content is assigned with `textContent`; workbook strings never become HTML. Styles are mapped through a strict allowlist to CSS properties. Unsupported or invalid colors, fonts, borders, alignments, and dimensions fall back to Codeman defaults.

### Overlay integration

`panels-ui.js` gains a `spreadsheet` branch in `_renderFilePreviewBody`. That branch delegates to the spreadsheet module and leaves the overlay's existing identity, navigation, polling, staleness checks, and original-download action intact.

Opening another file, closing the overlay, or refreshing a changed XLSX disposes the previous spreadsheet renderer before starting a new one. The renderer checks the same preview-state identity used by other asynchronous preview branches so stale parsing cannot overwrite a newer document.

## Data flow

1. The user opens an XLSX attachment or workspace file.
2. Codeman fetches metadata and receives `type: spreadsheet`, size, mtime, raw URL, and preview URL.
3. The overlay enables original download from its existing session/file identity.
4. The spreadsheet module fetches the guarded raw URL without `download=true`.
5. The response becomes an `ArrayBuffer` and transfers to the parser worker.
6. The worker parses XLSX locally and returns the normalized workbook model.
7. The renderer displays the first visible sheet and virtualizes the current viewport.
8. Sheet switching reuses the normalized model; scrolling redraws only the visible window.
9. Download independently fetches the raw URL with `download=true` and saves the returned bytes under the original filename.

No step sends workbook bytes, parsed cells, filenames, or metadata to a third party.

## Safety and resource limits

- Preserve the server's existing 50 MiB attachment admission/raw cap.
- Refuse browser preview above 20 MiB of compressed XLSX bytes while retaining Download.
- Limit normalization to 100 worksheets, 1,000,000 populated cells per workbook, 250,000 populated cells per worksheet, 10,000 merged ranges per worksheet, and 20,000 distinct normalized styles.
- Run parsing off the main thread and terminate it after 20 seconds.
- Never evaluate formulas, macros, external links, or workbook scripts.
- Render cell text through DOM text nodes, never `innerHTML`.
- Allowlist style fields and clamp dimensions before applying CSS.
- Terminate stale workers when the preview state changes.
- Keep raw routes, ownership checks, path confinement, remote staging cleanup, and attachment guards unchanged.

These limit values will be exported constants with unit tests. When a limit is reached, the UI explains which limit prevented preview and keeps Download available.

## Error handling

- Network or authorization failure: show the existing preview error treatment and keep stale results from rendering.
- Missing local parser asset: report that spreadsheet preview is unavailable; do not fall back to an external URL.
- Invalid, encrypted, or unsupported workbook: show a workbook-specific error and retain Download.
- Parse timeout or resource limit: terminate the worker, show a limit message, and retain Download.
- Empty workbook or worksheet: show an empty-sheet state rather than a generic binary message.
- Unsupported workbook features: render supported cell content and show a non-blocking fidelity notice.

## Testing

### Backend route tests

- Attachment metadata classifies XLSX as `spreadsheet` and exposes the guarded attachment raw URL.
- Local workspace metadata classifies XLSX as `spreadsheet` and exposes the workspace raw URL.
- Remote workspace metadata uses the same spreadsheet type and staged raw-download path.
- Raw download returns the original filename, official XLSX MIME type, and byte-identical content.

### Worker and renderer tests

- Parse a small real XLSX fixture with multiple sheets, cached formula results, merges, dimensions, and common styles.
- Verify formulas and hyperlinks remain inert.
- Switch worksheet tabs without a second fetch or parse.
- Render merged cells and common style mappings through the allowlist.
- Virtualize a large sparse used range without creating a DOM node per workbook cell.
- Reject malformed, oversized, timed-out, and over-limit workbooks with deterministic messages.
- Confirm that parser assets and workbook requests are same-origin and no external request occurs.

### Overlay integration tests

- The `spreadsheet` metadata branch delegates to the spreadsheet module.
- Closing, refreshing, or opening another file disposes the active worker and blocks stale rendering.
- Attachment navigation and live-refresh semantics remain intact.
- Original download remains enabled on successful, unsupported-feature, and failed-preview states.

### Verification

Run the new focused test files plus the existing file-preview source-download and file-route tests. Before review, run typecheck, lint, formatting, frontend syntax/public-asset checks, lockfile validation, and the production build. Do not run the unscoped full Vitest suite in a Codeman-managed session.

## Fidelity contract

This viewer is intentionally a safe, local preview rather than an Excel replacement. It aims to reproduce cell-oriented workbook content and common formatting accurately enough for inspection. It does not promise pixel-perfect output for advanced Excel objects. The UI communicates that boundary without blocking access to supported cells or the original download.
