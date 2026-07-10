import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');
const indexHtml = readFileSync(join(publicDir, 'index.html'), 'utf-8');
const constantsJs = readFileSync(join(publicDir, 'constants.js'), 'utf-8');
const appJs = readFileSync(join(publicDir, 'app.js'), 'utf-8');
const panelsJs = readFileSync(join(publicDir, 'panels-ui.js'), 'utf-8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf-8');
const mobileCss = readFileSync(join(publicDir, 'mobile.css'), 'utf-8');

describe('document attachment UI wiring', () => {
  it('registers a dedicated attachment detected SSE event', () => {
    expect(constantsJs).toContain("ATTACHMENT_DETECTED: 'attachment:detected'");
    expect(appJs).toContain("[SSE_EVENTS.ATTACHMENT_DETECTED, '_onAttachmentDetected']");
  });

  it('renders detected files as attachment cards instead of image popups', () => {
    expect(panelsJs).toContain('_onAttachmentDetected(data)');
    expect(panelsJs).toContain('this.addAttachmentCard(data)');
    expect(panelsJs).toContain('addAttachmentCard(attachmentEvent)');
    expect(panelsJs).toContain('attachment-card');

    const handlerStart = panelsJs.indexOf('_onAttachmentDetected(data)');
    const handlerEnd = panelsJs.indexOf('// ═', handlerStart);
    const handlerBody = panelsJs.slice(handlerStart, handlerEnd);
    expect(handlerBody).not.toContain('openImagePopup');
  });

  it('supports opening attachment cards in the existing preview overlay by session id', () => {
    expect(panelsJs).toContain('openFilePreview(filePath, sessionId = this.activeSessionId, attachmentId = null)');
    expect(panelsJs).toContain('openAttachmentInNewTab(sessionId, filePath, attachmentId = null)');
    expect(panelsJs).toContain('file-preview?path=');
  });

  it('adds stable attachment card and document preview styling hooks', () => {
    expect(stylesCss).toContain('.attachment-card-stack');
    expect(stylesCss).toContain('.attachment-card');
    expect(stylesCss).toContain('.attachment-thumbnail');
    expect(stylesCss).toContain('.attachment-thumbnail-fallback');
    expect(stylesCss).toContain('.document-preview-frame');
    expect(stylesCss).toContain('.document-preview-image');
  });

  it('renders first-page thumbnails on attachment cards with a badge fallback', () => {
    expect(panelsJs).toContain('thumbnailUrl');
    expect(panelsJs).toContain('attachment-thumbnail');
    expect(panelsJs).toContain('attachment-thumbnail-fallback');
    expect(panelsJs).toContain('attachment-thumbnail-img');
    expect(panelsJs).toContain('attachmentThumbnailImg.onerror');
  });

  it('uses a larger slide-aspect thumbnail space without cropping widescreen slides', () => {
    expect(stylesCss).toContain('grid-template-columns: 96px minmax(0, 1fr) 24px');
    expect(stylesCss).toContain('width: 96px');
    expect(stylesCss).toContain('aspect-ratio: 16 / 9');
    expect(stylesCss).toContain('height: auto');
    expect(stylesCss).toContain('object-fit: contain');
  });

  it('uses attachment-id routes for explicitly registered live attachments', () => {
    expect(panelsJs).toContain('attachmentId');
    expect(panelsJs).toContain('/attachments/${encodeURIComponent(attachmentId)}/raw');
    expect(panelsJs).toContain('/attachments/${encodeURIComponent(attachmentId)}/preview');
  });

  it('adds a header paperclip trigger and badge for session attachment history', () => {
    expect(indexHtml).toContain('id="attachmentsHistoryBtn"');
    expect(indexHtml).toContain('onclick="app.toggleAttachmentHistory()"');
    expect(indexHtml).toContain('id="attachmentHistoryBadge"');
    expect(appJs).toContain('this.attachmentHistoryCounts = new Map()');
  });

  it('loads a historical attachment drawer with card recovery actions', () => {
    expect(panelsJs).toContain('toggleAttachmentHistory()');
    expect(panelsJs).toContain('loadAttachmentHistory(sessionId = this.activeSessionId)');
    expect(panelsJs).toContain('/api/sessions/${sessionId}/attachments');
    expect(panelsJs).toContain('reshowAttachmentCard(itemId)');
    expect(panelsJs).toContain('data-attachment-action="reshow"');
  });

  it('shows CLI-first guidance when the attachment drawer is empty', () => {
    expect(panelsJs).toContain('No attachments yet');
    expect(panelsJs).toContain('Show a file here by running:');
    expect(panelsJs).toContain('codeman attach /absolute/path/to/file.pptx');
    expect(panelsJs).toContain('Supports .pptx, .docx, .pdf, .png, .md, and .txt.');
  });

  it('previews markdown attachments as sanitized HTML and text attachments as preformatted text', () => {
    expect(panelsJs).toContain("data.type === 'markdown'");
    expect(panelsJs).toContain("data.type === 'text'");
    expect(panelsJs).toContain('this._renderMarkdown(');
  });

  it('exposes document revision review — diff + rollback — in the preview (COD-59)', () => {
    expect(panelsJs).toContain('showDocumentDiff');
    expect(panelsJs).toContain('exitDocumentDiff');
    expect(panelsJs).toContain('rollbackDocument');
    expect(panelsJs).toContain('/documents/diff');
    expect(panelsJs).toContain('/documents/rollback');
    // diff is rendered with ins/del runs in a dedicated container
    expect(panelsJs).toContain('document-preview-diff');
    expect(stylesCss).toContain('.document-preview-diff');
  });

  it('collects selected-passage annotations into a review tray with two send modes (COD-60/69)', () => {
    expect(panelsJs).toContain('commentOnSelection');
    expect(panelsJs).toContain('window.getSelection');
    // composer adds to a tray instead of sending immediately
    expect(panelsJs).toContain('addAnnotation');
    expect(panelsJs).toContain('annotation-tray');
    // two send modes: consolidated prompt, or a written review file
    expect(panelsJs).toContain('sendAnnotationsAsPrompt');
    expect(panelsJs).toContain('saveAnnotationsToReviewFile');
    expect(panelsJs).toContain('/documents/review');
    expect(panelsJs).toContain('/input');
    expect(panelsJs).toContain('useMux');
    expect(stylesCss).toContain('.annotation-tray');
  });

  it('offers a PDF/HTML/Changes view switcher with annotation on .docx previews (COD-66/68)', () => {
    expect(panelsJs).toContain('switchDocxView');
    expect(panelsJs).toContain('document-view-switch');
    expect(panelsJs).toContain('document-preview-html');
    expect(panelsJs).toContain('/documents/html');
    expect(stylesCss).toContain('.document-preview-html');
  });

  it('styles source-preserved Word highlights in the selectable HTML view (COD-218)', () => {
    expect(stylesCss).toContain('.docx-highlight');
    expect(stylesCss).toContain('.docx-highlight--red');
    expect(stylesCss).toContain('--docx-highlight-color: #f00');
    expect(stylesCss).toContain('.docx-comment-marker');
    expect(stylesCss).toContain('.docx-comment-card');
    expect(panelsJs).toContain('_bindDocxCommentInspector');
    expect(stylesCss).toContain('.docx-comments');
  });

  it('makes the preview overlay resizable and persists the size (COD-67)', () => {
    expect(stylesCss).toContain('resize: both');
    expect(panelsJs).toContain('_restorePreviewSize');
    expect(panelsJs).toContain('codeman.filePreviewSize');
  });

  it('live-refreshes the open preview when the underlying file changes (COD-58)', () => {
    // Renders via an extracted body renderer (reused by both initial open and refresh).
    expect(panelsJs).toContain('_renderFilePreviewBody');
    // Polls a cheap metadata signature and re-renders in place on change.
    expect(panelsJs).toContain('_pollFilePreview');
    expect(panelsJs).toContain('mtimeMs');
    // Polling is torn down when the preview closes (no leaked interval).
    const closeStart = panelsJs.indexOf('closeFilePreview() {');
    const closeBody = panelsJs.slice(closeStart, closeStart + 400);
    expect(closeBody).toContain('_stopFilePreviewPolling');
  });

  it('styles the attachment history as a desktop drawer and mobile sheet', () => {
    expect(stylesCss).toContain('.attachment-history-drawer');
    expect(stylesCss).toContain('.attachment-history-item');
    expect(stylesCss).toContain('.attachment-history-thumb');
    expect(mobileCss).toContain('.attachment-history-drawer');
    expect(mobileCss).toContain('height: 100dvh');
  });

  it('has a go-to-session button on attachment cards that switches without dismissing (COD-217)', () => {
    // Button class must exist in the card markup
    expect(panelsJs).toContain('attachment-go-session-btn');
    // The button handler must call selectSession — verified by finding the listener block
    const goHandlerIdx = panelsJs.indexOf("querySelector('.attachment-go-session-btn')");
    expect(goHandlerIdx).toBeGreaterThan(-1);
    const goHandlerBody = panelsJs.slice(goHandlerIdx, goHandlerIdx + 200);
    expect(goHandlerBody).toContain('selectSession(sessionId)');
    // The go-session handler must NOT close the card
    expect(goHandlerBody).not.toContain('closeAttachmentCard');
  });
});
