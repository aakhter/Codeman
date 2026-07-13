/**
 * @fileoverview COD-238 — Files-panel Office previews must make the original
 * DOCX/PPTX the primary download while keeping the converted PDF as an inline
 * preview. Native PDFs and attachment-card previews retain their existing PDF
 * viewer behavior.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

type PreviewElement = {
  innerHTML: string;
  textContent: string;
  querySelector: ReturnType<typeof vi.fn>;
};

function loadPanelsUiPrototype(): Proto {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console,
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    fetch: vi.fn(),
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Proto }).__proto;
}

function previewElement(): PreviewElement {
  return { innerHTML: '', textContent: '', querySelector: vi.fn(() => null) };
}

function renderHost(
  proto: Proto,
  state: { sessionId: string; filePath: string; attachmentId: string | null; docxView: string }
) {
  const body = previewElement();
  const footer = previewElement();
  const downloadWorkspaceFile = vi.fn();
  const host = {
    filePreviewState: state,
    filePreviewContent: '',
    formatFileSize: vi.fn(() => '31 KB'),
    downloadWorkspaceFile,
    $: vi.fn((id: string) => (id === 'filePreviewBody' ? body : id === 'filePreviewFooter' ? footer : null)),
    _renderExportPdfControl: proto._renderExportPdfControl,
    _documentParams: proto._documentParams,
  };
  return { body, footer, downloadWorkspaceFile, host };
}

function iframeSrc(html: string): string {
  const match = html.match(/<iframe[^>]+src="([^"]+)"/);
  if (!match) throw new Error(`missing iframe in ${html}`);
  return match[1];
}

describe('COD-238 Files-panel source download', () => {
  it.each([
    ['document', 'docx', 'deliverables/Market Story Final.docx', 'Download DOCX'],
    ['presentation', 'pptx', 'deliverables/Executive Brief Final.pptx', 'Download PPTX'],
  ])(
    'makes the original %s source primary while the converted PDF remains the preview',
    async (type, extension, filePath, sourceLabel) => {
      const proto = loadPanelsUiPrototype();
      const state = { sessionId: 'tree-owner-session', filePath, attachmentId: null, docxView: 'pdf' };
      const { body, footer, downloadWorkspaceFile, host } = renderHost(proto, state);

      await proto._renderFilePreviewBody.call(
        host,
        {
          type,
          extension,
          size: 31_000,
          mtimeMs: 123,
          url: `/api/sessions/tree-owner-session/file-raw?path=${encodeURIComponent(filePath)}`,
          previewUrl: `/api/sessions/tree-owner-session/file-preview?path=${encodeURIComponent(filePath)}`,
        },
        { sessionId: 'tree-owner-session', filePath, attachmentId: null }
      );

      const previewUrl = new URL(iframeSrc(body.innerHTML), 'https://codeman.test');
      expect(previewUrl.pathname).toBe('/api/sessions/tree-owner-session/file-preview');
      expect(previewUrl.searchParams.get('path')).toBe(filePath);
      expect(previewUrl.hash).toBe('#toolbar=0');
      expect(footer.innerHTML).toContain(`class="btn-icon-sm document-source-download-btn"`);
      expect(footer.innerHTML).toContain(sourceLabel);
      expect(footer.innerHTML).toContain('Export PDF');

      expect(proto.downloadFilePreviewSource).toBeTypeOf('function');
      proto.downloadFilePreviewSource.call(host);
      expect(downloadWorkspaceFile).toHaveBeenCalledWith('tree-owner-session', filePath);
    }
  );

  it('leaves a native PDF in the normal PDF viewer with its PDF download toolbar', async () => {
    const proto = loadPanelsUiPrototype();
    const filePath = 'deliverables/Final Report.pdf';
    const state = { sessionId: 'tree-owner-session', filePath, attachmentId: null, docxView: 'pdf' };
    const { body, footer, host } = renderHost(proto, state);

    await proto._renderFilePreviewBody.call(
      host,
      {
        type: 'pdf',
        extension: 'pdf',
        size: 31_000,
        mtimeMs: 123,
        url: `/api/sessions/tree-owner-session/file-raw?path=${encodeURIComponent(filePath)}`,
      },
      { sessionId: 'tree-owner-session', filePath, attachmentId: null }
    );

    expect(new URL(iframeSrc(body.innerHTML), 'https://codeman.test').hash).toBe('');
    expect(footer.innerHTML).not.toContain('document-source-download-btn');
  });

  it('does not alter the existing attachment-card DOCX viewer behavior', async () => {
    const proto = loadPanelsUiPrototype();
    const filePath = 'Published Brief.docx';
    const state = { sessionId: 'attachment-owner', filePath, attachmentId: 'att_123', docxView: 'pdf' };
    const { body, footer, host } = renderHost(proto, state);

    await proto._renderFilePreviewBody.call(
      host,
      {
        type: 'document',
        extension: 'docx',
        size: 31_000,
        mtimeMs: 123,
        url: '/api/sessions/attachment-owner/attachments/att_123/raw',
        previewUrl: '/api/sessions/attachment-owner/attachments/att_123/preview',
      },
      { sessionId: 'attachment-owner', filePath, attachmentId: 'att_123' }
    );

    expect(new URL(iframeSrc(body.innerHTML), 'https://codeman.test').hash).toBe('');
    expect(footer.innerHTML).not.toContain('document-source-download-btn');
    expect(footer.innerHTML).toContain('document-view-switch');
  });
});
