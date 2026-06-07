import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(process.cwd(), 'src/web/public');
const constantsJs = readFileSync(join(publicDir, 'constants.js'), 'utf-8');
const appJs = readFileSync(join(publicDir, 'app.js'), 'utf-8');
const panelsJs = readFileSync(join(publicDir, 'panels-ui.js'), 'utf-8');
const stylesCss = readFileSync(join(publicDir, 'styles.css'), 'utf-8');

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

  it('uses attachment-id routes for explicitly registered live attachments', () => {
    expect(panelsJs).toContain('attachmentId');
    expect(panelsJs).toContain('/attachments/${encodeURIComponent(attachmentId)}/raw');
    expect(panelsJs).toContain('/attachments/${encodeURIComponent(attachmentId)}/preview');
  });
});
