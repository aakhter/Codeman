# Document Preview & Attachments

A cluster of backend modules turns files a session touches into **previewable,
exportable, diffable documents** with revision history — the "watch the agent
revise a doc" authoring loop. Shipped across COD-58 (live preview), COD-59
(revision history), COD-61 (PDF export), and COD-66 (text extraction for diff).

All endpoints are registered in `src/web/routes/file-routes.ts`. The heavy
lifting (LibreOffice/pandoc) is done by small modules with **pure helpers split
out** so format/branch logic is unit-tested without shelling out.

## Module map

| Module | Responsibility |
|--------|----------------|
| `document-preview-cache.ts` | Shared **disk cache** of expensive Office→PDF renders. `getOfficePreviewPdfPath(file, ext)` shells `soffice --convert-to pdf`, caches the result, and returns the cached PDF path. `getPreviewPdfDownloadName()` derives a sane download filename. `clearDocumentPreviewCache()` resets it. |
| `document-pdf-export.ts` | One-click **Export PDF** (COD-61). `classifyExportBranch(ext)` → `office` (docx/pptx, reuse the preview cache) \| `text` (md/markdown/txt → HTML → PDF) \| `unsupported`. `wrapStandaloneHtml()` builds a minimal printable HTML doc; markdown is rendered via pandoc (vendored `marked` fallback), then the HTML is converted to PDF by the **same** `soffice --convert-to pdf`. PDF is the only supported format today (DOCX/templates deferred). |
| `document-text-extract.ts` | **Diffable text** extraction (COD-66). `isDiffableDocExtension(ext)` → `md`/`txt`/`docx`; `isBinaryDocExtension(ext)` → `docx`. `convertDocxToHtml()` / docx→markdown via pandoc so the existing word-diff runs on prose, not XML. |
| `document-version-store.ts` | In-memory **revision history** (COD-59). `DocumentVersionStore` keeps a bounded ring (default **50** versions) of `DocumentVersion` snapshots keyed by `(sessionId, filePath)`. `record()` is a no-op when content is unchanged (returns `null`). Stores diffable `content` plus optional raw `Buffer` for byte-perfect rollback of binary docs. |
| `document-thumbnailer.ts` | Best-effort first-page **thumbnails** for attachment cards. |
| `attachment-registry.ts` | In-memory registry minting **stable IDs** for live external document references, so browser requests never carry arbitrary absolute paths. `attachmentRegistry` singleton; `isSupportedAttachmentExtension()`, `getAttachmentType()`, `registerExternalAttachment()`, `AttachmentRegistrationError`. |
| `attachment-magic.ts` | Parses terminal **magic links** into attachment cards. |
| `session-attachment-history.ts` | Bounded (**100-item**) per-session log of detected attachments (`ATTACHMENT_HISTORY_LIMIT`). |

## Revision-history capture (the clever bit)

There is **no backend file watcher**. Versions are captured **lazily off the
live-preview poll** (COD-58): each time the browser polls the preview of a
text/markdown file and the on-disk content has changed, `DocumentVersionStore.record()`
snapshots it. So the authoring loop — open a preview, let the agent revise the
file, watch it update — naturally accumulates a diffable, rollback-able history
with zero extra machinery.

**In-memory only.** History lives for the server run and is dropped on restart or
when the session is cleaned up. Persisting snapshots is a deliberate follow-up:
full document bodies in `state.json` would bloat it. (`raw` buffers for `.docx`
rollback make this doubly true.)

## Why IDs instead of paths (security)

`attachment-registry.ts` exists so the frontend never sends an **arbitrary
absolute filesystem path** to the server. External documents are registered once
and addressed by a minted ID (`/api/sessions/:id/attachments/:attachmentId/...`).
Session-local workspace files keep using the existing workspace-scoped file
routes (path-allowlist validated). Standalone export HTML is converted to PDF
**locally by LibreOffice and never served to a browser**, so the HTML-wrapping
path escapes its body fragment for well-formedness, not XSS defense.

## API (all in `file-routes.ts`)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/sessions/:id/file-preview` | Render a preview (Office→PDF via cache, or text/markdown) |
| `GET` | `/api/sessions/:id/file-thumbnail` | First-page thumbnail |
| `GET` | `/api/sessions/:id/file-raw` | Raw bytes |
| `GET`/`POST` | `/api/sessions/:id/attachments` | List / register attachments |
| `GET`/`DELETE` | `/api/sessions/:id/attachments/:attachmentId` | Fetch / remove a registered attachment |
| `GET` | `/api/sessions/:id/attachments/:attachmentId/{raw,preview,thumbnail}` | Attachment bytes / preview / thumbnail |
| `GET` | `/api/sessions/:id/documents/versions` | List revision metadata (no content body) |
| `GET` | `/api/sessions/:id/documents/diff` | Word-diff between two versions |
| `POST` | `/api/sessions/:id/documents/rollback` | Restore a prior version |
| `GET` | `/api/sessions/:id/documents/html` | Rendered HTML of a document |
| `GET` | `/api/sessions/:id/documents/export` | Export PDF (`classifyExportBranch`) |
| `GET` | `/api/sessions/:id/documents/review` | Review/compare view |

Frontend touchpoints live in `app.js` / `panels-ui.js` / `terminal-ui.js` /
`session-ui.js` (preview panels, version drawer, export button), with HTML
sanitized via `sanitize-html.js`.

## External tool dependencies

- **LibreOffice (`soffice`)** — Office→PDF preview/export and HTML→PDF. On WSL,
  `aicodeman doctor` resolves the Windows-side install via interop. Advisory, not
  hard-required — preview/export degrade gracefully when absent.
- **pandoc** — docx→markdown/HTML for diffing and markdown export (vendored
  `marked` is the markdown fallback when pandoc is missing).

Run `aicodeman doctor` (or `npx tsx src/index.ts doctor`) to see whether the
office/preview tools are detected.

## Related

- `CLAUDE.md` → Architecture → **Documents** row, and the **Document preview /
  attachments** Key Pattern.
- COD-58 (live preview / lazy capture), COD-59 (version store), COD-61 (PDF
  export), COD-66 (text extraction for diff).
