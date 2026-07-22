# COD-244: XLSX Attachment Upload Design

## Summary

Codeman will accept modern Excel workbooks (`.xlsx`) through the existing attachment upload workflow. An uploaded workbook will be copied into the session's `.codeman-attachments/` directory, registered in attachment history, surfaced on an attachment card, and inserted into the terminal's `[Attachments: ...]` block for the agent. Users can open, download, and remove it.

XLSX remains a binary attachment. Selecting Preview will use the existing binary-file experience and state that the file cannot be previewed. This change does not add spreadsheet rendering or conversion.

## Goals

- Accept `.xlsx` from the file picker and drag-and-drop document path.
- Apply the existing upload size, CSRF, rate-limit, filename, path-confinement, and symlink protections.
- Reject content that does not have a ZIP/OOXML-compatible signature.
- Support the existing local and remote session upload flows.
- Record XLSX uploads in attachment history and broadcast the normal attachment event.
- Support Open, Download, and Remove from the existing attachment UI.
- Send raw XLSX responses with the standard XLSX MIME type.

## Non-goals

- Inline workbook or worksheet rendering.
- LibreOffice or PDF conversion.
- Workbook parsing, formula evaluation, or content extraction.
- Legacy `.xls` support.
- Changes to attachment size or batch limits.

## Design

### Upload acceptance

The frontend document allowlist and hidden file input will include `xlsx`. The attachment drawer's empty-state copy will list `.xlsx` among supported formats. The selected workbook will continue through the existing multipart upload and terminal insertion flow without a new endpoint or UI.

The server upload allowlist will include `xlsx`. Because XLSX is an OOXML ZIP container, its byte-signature validation will use the same accepted ZIP prefixes as DOCX and PPTX. The extension and raw bytes remain independently checked; MIME headers remain untrusted.

### Attachment registration and metadata

The attachment registry will accept `xlsx`. `getAttachmentType('xlsx')` will return the existing `binary` type rather than `document`, preventing the preview UI from attempting DOCX/PPTX conversion. `AttachmentDetectedType` will be extended with `binary` so the type is explicit through events, history, API metadata, and frontend rendering.

The raw MIME map will return `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` for XLSX files.

### User experience

After upload, Codeman will insert the generated workspace-relative path in the same `[Attachments: "..."]` block used for other documents. The attachment drawer and transient attachment card will show the XLSX filename and type label.

- **Open** opens the raw attachment URL using normal browser/OS handling.
- **Download** downloads the original XLSX bytes.
- **Remove** uses the existing uploaded-attachment deletion route.
- **Preview** opens the existing binary state with file size, `Cannot preview`, and an Open action.

No spreadsheet-specific toolbar, thumbnail, or conversion request will be introduced.

## Security and error handling

All existing document-upload controls remain unchanged. XLSX only extends the extension and signature allowlists. A renamed non-ZIP file is rejected with HTTP 415. Registration failures continue to roll back the written local file; remote transfer and local-cache failures retain their current error behavior.

The registry and raw routes continue to resolve attachments by server-issued ID, re-check attachment guards, and enforce the existing by-ID response-size limit. The change does not expose absolute paths to the browser.

## Testing

Focused regression coverage will verify:

- The pure upload allowlist includes `xlsx` but not `xls`.
- XLSX accepts supported ZIP signatures and rejects mismatched bytes.
- A multipart XLSX upload succeeds, writes the file, registers `source: upload`, and reports `attachmentType: binary`.
- Attachment metadata and raw routing preserve the XLSX extension and MIME type.
- The frontend picker and drag/drop allowlist include XLSX.
- Attachment drawer support copy includes `.xlsx`.
- The preview renderer uses the binary `Cannot preview` branch and does not start Office conversion.

Verification will use targeted Vitest files plus typecheck, lint, formatting, lockfile, frontend syntax, and production build checks. The full test suite will not be run from a Codeman-managed tmux session.
