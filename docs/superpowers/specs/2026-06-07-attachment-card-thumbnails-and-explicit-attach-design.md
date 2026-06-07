# Attachment Card Thumbnails and Explicit Attach Design

## Goal

Extend COD-18 so attachment cards show a first-page preview image, and so Codex can explicitly surface an attachment card for an existing local file outside the session working directory.

## User Experience

Attachment cards keep the same compact floating-card behavior, but the type badge is replaced by a thumbnail when one can be generated. PNG cards use the image itself. PDF cards show page 1. DOCX and PPTX cards show page 1 of the LibreOffice-generated PDF preview. If preview generation fails, the card falls back to the existing file-type badge.

Codex can trigger cards in two ways:

- `codeman attach /absolute/path/to/file.pptx`
- terminal output containing `codeman://attach?path=/absolute/path/to/file.pptx`

Both paths create the same card and viewer behavior. This first pass supports `png`, `pdf`, `docx`, and `pptx`.

## Architecture

Codeman registers live external attachments per session instead of copying files into the case directory. Each registration creates a temporary attachment ID that maps to an absolute path plus metadata. Browser routes use the attachment ID, not an arbitrary path query parameter, so explicit live references do not become a general file-read endpoint.

Existing session-local file routes remain unchanged for normal file-browser and watcher flows. New attachment routes resolve either a session-local path or a registered live external attachment, then reuse common metadata, preview, raw, and thumbnail helpers.

## Data Flow

1. CLI command or terminal magic text identifies a target file and session.
2. Backend validates that the extension is supported and the target is a readable file.
3. Backend stores a live attachment registration with `attachmentId`, absolute path, display name, type, size, and timestamp.
4. Backend broadcasts `attachment:detected` with `attachmentId` and `thumbnailUrl`.
5. Browser renders a card thumbnail. On click, preview/download/open use attachment routes when `attachmentId` is present.

## Security

External live paths are only usable after explicit per-session registration. Viewer, thumbnail, raw, and download routes accept `attachmentId` for external files and reject unknown or expired IDs. They do not accept arbitrary absolute paths from the browser. Session-local paths continue to use the existing working-directory validation.

## Thumbnail Behavior

Thumbnail generation is best-effort and cached by attachment source path, size, mtime, and requested first page. Conversion failures return a fallback response instead of blocking card creation. Source files over the existing document preview size limit do not generate thumbnails.

## Out of Scope

Remote URLs, MCP blob materialization, multi-page card navigation, and persistent attachment history are out of scope for this pass.
