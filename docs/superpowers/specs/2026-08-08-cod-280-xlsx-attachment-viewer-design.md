# COD-280 XLSX Attachment Viewer Design

## Goal

Add a local-only, read-only XLSX preview to Codeman's shared attachment viewer. Users must be able to open a workbook, switch worksheets, inspect common spreadsheet formatting, and download the original file without sending workbook data to an external service.

This is follow-up work to COD-244. That issue added XLSX upload, registration, MIME handling, and a binary fallback, but intentionally excluded spreadsheet rendering.

## Scope

### In scope

- Preview XLSX attachments registered by attachment ID.
- Preview XLSX files opened from local and remote session workspaces.
- Display visible worksheet tabs, cell values, cached formula results, merged cells, an enumerated set of common number formats, fonts, fills, borders, alignment, row heights, and column widths.
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
- Editing, cell selection, clipboard copy, frozen panes, and formula recalculation.

## User experience

Opening an XLSX uses the existing file-preview overlay. The body first shows a spreadsheet-specific loading state. Once parsing finishes, the overlay contains:

- a tab strip containing every visible worksheet in workbook order;
- a read-only grid with row and column headings;
- scrollable, virtualized cells for the selected worksheet;
- a compact notice when the workbook contains features the renderer does not reproduce; and
- the existing header-level **Download** action for the original workbook.

The first visible worksheet is selected initially. Switching tabs does not re-fetch or re-parse the workbook. Hidden and `veryHidden` sheets are not shown or normalized. If every sheet is hidden, the viewer shows a no-visible-sheets state. Empty sheets show a clear empty state. A malformed, encrypted, unsupported, oversized, or timed-out workbook shows an error or limit message while keeping Download enabled.

On phones, the grid keeps native two-axis touch scrolling and momentum. The tab strip scrolls horizontally without shrinking sheet names into unusable targets. All viewer-owned labels and messages use the existing `i18n.js` English and Chinese catalogs. The grid and tab-strip containers each receive `data-i18n-skip` once; the current translator uses `closest(SKIP_SELECTOR)`, so dynamically inserted sheet names and cells inherit the skip without per-cell mutation work.

## Architecture

### Backend metadata and raw bytes

XLSX remains a binary OOXML file on the server. Existing attachment and workspace raw routes remain the only file-serving surfaces:

- `/api/sessions/:id/attachments/:attachmentId/raw`
- `/api/sessions/:id/file-raw?path=...`

The metadata branches in `file-routes.ts` classify XLSX as `spreadsheet` instead of generic `binary`. Their preview URL points to the corresponding guarded raw route with `preview=true`. No XLSX-to-HTML endpoint and no arbitrary-path endpoint are added. Unknown preview types continue through the existing generic-binary fallback so an older cached frontend does not attempt to render an unsupported type.

Attachment-ID raw requests retain the current 50 MiB cap, path re-resolution, attachment guard, ownership checks, and content-disposition behavior. Workspace-file raw requests retain their current local and remote confinement. For XLSX requests with `preview=true`, both raw routes verify the current file size and reject files above the 10 MiB browser-preview limit before opening a local stream or staging a remote file. Metadata size is an early UI hint, not the security boundary. Download requests continue to add `download=true`; the raw route supplies the official XLSX MIME type and `Content-Disposition: attachment`.

The implementation audits all metadata-type consumers. Attachment cards, history, thumbnails, the overlay, and unknown-type fallbacks must accept `spreadsheet`; XLSX remains absent from the editable-file allowlist. Remote preview performs one bounded staging operation only after the current remote size passes the preview limit, and its existing close/error cleanup remains authoritative. Download is a separate user action and may stage the original again.

### Local parser delivery

Add ExcelJS 4.4.0 and fflate 0.8.2 as pinned production dependencies. Codeman's postinstall/build asset preparation copies their minified browser bundles into `src/web/public/vendor/`, following the existing local-vendor pattern. The copy step verifies npm lockfile integrity, strips off-site `sourceMappingURL` comments, and records expected output filenames and a 1.1 MiB combined raw-size budget in the public-asset checks. Generated vendor files remain covered by the existing Git and Prettier ignores; `scripts/build.mjs` produces the production copies directly from locked dependencies, and explicit resolver usage keeps dependency analysis aware of both. The application never loads parser code from a CDN.

The spreadsheet module lazy-loads these local bundles only when an XLSX preview opens. Other sessions and document types pay no parser download or initialization cost. Worker and vendor URLs carry an explicit `SPREADSHEET_ASSET_VERSION` query so the static server's one-year immutable cache cannot pin an older implementation. A build/public-asset check hashes `spreadsheet-preview-worker.js` plus both production vendor bundles and fails unless the truncated digest equals `SPREADSHEET_ASSET_VERSION`; a worker or dependency change therefore cannot ship without a version bump. These assets are not separately pre-cached under an unversioned service-worker key.

The worker is a classic, same-origin `new Worker('/spreadsheet-preview-worker.js?v=...')` and loads same-origin fflate and ExcelJS bundles with versioned `importScripts(...)` calls. Codeman's CSP already declares `worker-src 'self' blob:`; this design uses only `'self'`. A feasibility spike against ExcelJS 4.4.0 passed in headless Chromium under `default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'`: the bundle wrote and parsed a workbook inside the worker, and the only requests were the page, main script, worker, and local vendor bundle. The bundle's guarded string-callback `new Function` fallback is never invoked; a CSP regression test keeps that assumption explicit.

### Worker parsing boundary

`spreadsheet-preview-worker.js` owns untrusted workbook parsing. Before ExcelJS receives bytes, it reads the ZIP end record and central directory. ZIP64 sentinels are refused as unsupported rather than misread. It then runs every entry through fflate's streaming inflater with a counting sink. That pass enforces actual emitted-byte and compression-ratio budgets, aborts before retaining oversized output, and incrementally scans bounded worksheet/style XML for cell, merge, worksheet, and style counts. Declared central-directory values remain an early rejection signal but never the final memory boundary. The same pass detects unsupported OOXML parts such as charts, drawings, pivot caches, external links, and VBA so the fidelity notice is evidence-based. A CFB/OLE signature (`D0 CF 11 E0`) produces the encrypted-workbook state; other extension/content mismatches are malformed XLSX.

After admission, the worker imports the local ExcelJS browser bundle and parses the transferred `ArrayBuffer`. It never evaluates formulas. Formula cells expose only their cached result when available; otherwise they display inert formula text with a visible formula indicator so it cannot be mistaken for a literal value.

The parsed workbook stays inside the worker. The main thread receives only workbook metadata and viewport tiles, avoiding a structured clone of the full model. Metadata contains:

- workbook-level feature warnings;
- visible sheet IDs and names;
- a sparse extent derived from populated cells and merges rather than untrusted worksheet-dimension declarations;
- default dimensions plus sparse row-height and column-width overrides, with hidden rows/columns represented as zero-size overrides;
- the bounded normalized style table that resolves style IDs returned by tiles; and
- feature warnings and limit status.

The renderer requests tiles for the current viewport. Every request carries a monotonically increasing request ID and sheet ID; the worker echoes both, and the renderer drops a response unless both still match the latest requested viewport. A tile response contains only intersecting cells, style IDs resolved by the metadata style table, and merged ranges. Merges are indexed by row and column interval; a merge whose anchor is outside the viewport is still returned when it intersects the viewport, and covered non-anchor cells are suppressed. Cell content crosses the worker boundary as text or primitive values only. The worker strips hyperlinks, rich HTML, external relationships, scripts, and unsupported object payloads.

Number formatting has an explicit owner and boundary. A pure formatter supports General, integer and fixed decimals, thousands separators, percent, the common `$`, `€`, `£`, and `¥` currency forms, and common date/time patterns with the workbook's 1900/1904 date system. Multi-section conditions, locale directives, fractions, accounting padding, and unknown formats fall back to a safe raw or cached value and add a fidelity warning.

The 20-second timeout starts only after the complete, server-capped `ArrayBuffer` transfers to a ready worker; it does not include network transfer or worker/vendor loading. The timeout value is injectable in tests. `onerror`, `onmessageerror`, timeout, and unexpected worker exit all become a deterministic parser-failure state. Closing or replacing the overlay aborts the in-flight fetch, terminates the active worker, and revokes temporary resources. A successfully parsed workbook keeps one worker-owned model until the overlay closes; no second full model exists on the main thread.

### Rendering module

`spreadsheet-preview.js` exposes a small lifecycle API to `panels-ui.js`: open, select sheet, resize, and dispose. It owns workbook fetch, lazy parser loading, worker coordination, tab state, viewport state, and rendering.

The renderer uses a sparse virtual grid rather than a full HTML table. Geometry uses default dimensions plus sorted sparse overrides and run-length segments; it never allocates arrays proportional to a declared million-row range. Pure, injectable viewport math maps scroll offsets to row/column windows and creates DOM nodes only for visible cells plus overscan. The physical scroll spacer is clamped to an engine-safe maximum and maps proportionally to the logical sheet extent, avoiding multi-million-row pixel heights on mobile. Merged ranges returned by the worker render as one positioned cell using combined dimensions. Row and column headings remain synchronized with the viewport.

Cell content is assigned with `textContent`; workbook strings never become HTML. Styles are deduplicated into a bounded set of CSS classes generated from a strict property allowlist rather than repeated per-cell inline declarations. Unsupported or invalid colors, fonts, borders, alignments, and dimensions fall back to Codeman defaults. Column widths convert from Excel character units using the renderer's measured default font; row heights convert from points to CSS pixels. Hidden rows and columns consume zero geometry.

### Overlay integration

`panels-ui.js` gains a `spreadsheet` branch in `_renderFilePreviewBody`. That branch delegates to the spreadsheet module and leaves the overlay's existing identity, navigation, polling, staleness checks, and original-download action intact.

Opening another file, closing the overlay, or refreshing a changed XLSX disposes the previous spreadsheet renderer before starting a new one. Every fetch, worker message, tile response, and render captures the exact `filePreviewState` object created by `openFilePreview` and no-ops unless object identity still matches. This is the same staleness contract used by the existing Office preview branches.

## Data flow

1. The user opens an XLSX attachment or workspace file.
2. Codeman fetches metadata and receives `type: spreadsheet`, size, mtime, raw URL, and preview URL.
3. The overlay enables original download from its existing session/file identity.
4. If metadata already exceeds 10 MiB, the UI refuses preview without fetching; otherwise the spreadsheet module fetches the guarded raw URL with `preview=true`. The server rechecks current size before local streaming or remote staging.
5. The response becomes an `ArrayBuffer` and transfers to the parser worker.
6. The worker performs ZIP admission, parses XLSX locally, and returns only sheet metadata and warnings.
7. The renderer requests the first viewport tile for the first visible sheet.
8. Sheet switching and scrolling request tiles from the existing worker-owned workbook without a second fetch or parse.
9. Download keeps the existing guarded preview-download implementation, which fetches the raw URL with `download=true`, verifies the response, and saves byte-identical content under the original preview filename. Replacing that established fetch/error-toast contract with navigation is outside COD-280.

No step sends workbook bytes, parsed cells, filenames, or metadata to a third party.

## Safety and resource limits

- Preserve the server's existing 50 MiB attachment admission/raw cap and add a 10 MiB `preview=true` cap to both XLSX raw paths before local streaming or remote staging.
- Before ExcelJS parsing, refuse ZIP64, ZIPs with more than 5,000 entries, more than 64 MiB actual streamed uncompressed bytes, any actual entry above 32 MiB, or any actual entry above a 100:1 compression ratio. Declared sizes may reject earlier but cannot admit a file on their own.
- During the same streaming XML pass, incrementally refuse the whole preview above 50 visible worksheets, 250,000 populated cells per workbook, 100,000 populated cells per worksheet, 5,000 merged ranges per worksheet, or 5,000 `cellXfs` style definitions. The post-parse normalized style table has the same 5,000-entry cap. ExcelJS runs only after the streaming guards pass.
- Reject coordinates outside Excel's XLSX bounds (1,048,576 rows and 16,384 columns), derive extents from populated cells/merges, and store dimension overrides sparsely.
- Run parsing off the main thread and terminate parsing after 20 seconds measured from worker-ready byte transfer.
- Never evaluate formulas, macros, external links, or workbook scripts.
- Render cell text through DOM text nodes, never `innerHTML`.
- Allowlist style fields and clamp dimensions before applying CSS.
- Terminate stale workers when the preview state changes.
- Keep raw routes, ownership checks, path confinement, remote staging cleanup, and attachment guards unchanged.

These limit values are exported constants with unit tests. Every safety/resource limit refuses the entire preview rather than silently truncating workbook content; the message names the exceeded limit and keeps Download available. Unsupported features that do not exceed a resource limit render supported cells with a non-blocking fidelity notice.

## Error handling

- Network or authorization failure: show the existing preview error treatment and keep stale results from rendering.
- Missing local parser asset: report that spreadsheet preview is unavailable; do not fall back to an external URL.
- CFB/OLE signature: show an encrypted-workbook message and retain Download. Other malformed ZIPs and XLSX content mismatches show a malformed-workbook message.
- Parse timeout or resource limit: terminate the worker, show a limit message, and retain Download.
- Empty workbook or worksheet: show an empty-sheet state rather than a generic binary message.
- Unsupported workbook features: render supported cell content and show a non-blocking fidelity notice.

## Testing

### Backend route tests

- Attachment metadata classifies XLSX as `spreadsheet` and exposes the guarded attachment raw URL.
- Local workspace metadata classifies XLSX as `spreadsheet` and exposes the workspace raw URL.
- Remote workspace metadata uses the same spreadsheet type and staged raw-download path.
- Raw download returns the original filename, official XLSX MIME type, and byte-identical content.
- Local `preview=true` rejects an XLSX that grew beyond 10 MiB after metadata, before opening a stream.
- Remote `preview=true` rejects an over-limit XLSX before remote staging begins.
- `download=true` remains exempt from the 10 MiB preview cap and retains the existing raw-route limit and cleanup behavior.

### Worker and renderer tests

- Parse a small real XLSX fixture with multiple sheets, cached formula results, merges, dimensions, and common styles.
- Verify formulas and hyperlinks remain inert.
- Preflight central-directory limits, compression-ratio checks, CFB detection, and OOXML feature detection as pure Node tests.
- Switch worksheet tabs without a second fetch or parse.
- Render merged cells and common style mappings through the allowlist.
- Test pure, injectable viewport math against large sparse ranges and merges anchored outside the viewport.
- Verify tile messages remain bounded and never clone the full workbook model.
- Verify stale tile responses are rejected by request ID and sheet ID within the same preview state.
- Reject malformed, oversized, timed-out, and over-limit workbooks with deterministic messages.
- Verify the enumerated number-format matrix, including 1900/1904 dates and safe fallbacks.
- Confirm in Playwright that the versioned worker/vendor assets run under Codeman CSP and no external request occurs.
- Verify the public-asset content hash and version constant cannot drift.

### Overlay integration tests

- The `spreadsheet` metadata branch delegates to the spreadsheet module.
- Closing, refreshing, or opening another file disposes the active worker and blocks stale rendering.
- Attachment navigation and live-refresh semantics remain intact.
- Original download remains enabled on successful, unsupported-feature, and failed-preview states.
- Mobile browser coverage verifies two-axis touch scrolling, horizontally scrollable tabs, and untranslated workbook content.
- i18n coverage verifies that ancestor-level `data-i18n-skip` protects dynamically inserted tabs and cells.

### Verification

Pure ZIP admission, number formatting, viewport math, route behavior, worker protocol, and overlay lifecycle run in the normal Node/Vitest CI path. Playwright covers actual Worker/CSP/network behavior and mobile interaction; this repository does not currently run browser tests in `test:ci`, so those tests are required locally and documented as a non-CI verification gap rather than misrepresented as a CI gate.

Run the new focused test files plus the existing file-preview source-download and file-route tests. Before review, run typecheck, lint, formatting, frontend syntax/public-asset checks, lockfile validation, and the production build. Do not run the unscoped full Vitest suite in a Codeman-managed session.

## Fidelity contract

This viewer is intentionally a safe, local preview rather than an Excel replacement. It aims to reproduce cell-oriented workbook content and common formatting accurately enough for inspection. It does not promise pixel-perfect output for advanced Excel objects. The UI communicates that boundary without blocking access to supported cells or the original download.
