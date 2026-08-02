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

function loadPanelsUiPrototype(contextOverrides: Record<string, unknown> = {}): Proto {
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
    // COD-239: docx/pptx previews fetch the same-origin preview URL as an
    // abortable readiness probe before rendering the iframe, so the vm needs an
    // AbortController.
    AbortController,
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    ...contextOverrides,
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as { __proto: Proto }).__proto;
}

function previewElement(): PreviewElement {
  return { innerHTML: '', textContent: '', querySelector: vi.fn(() => null) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
    _renderOfficeConversionPreview: proto._renderOfficeConversionPreview,
    _renderOfficePreviewError: proto._renderOfficePreviewError,
    _teardownOfficePreviewResources: proto._teardownOfficePreviewResources,
  };
  return { body, footer, downloadWorkspaceFile, host };
}

function iframeSrc(html: string): string {
  const match = html.match(/<iframe[^>]+src="([^"]+)"/);
  if (!match) throw new Error(`missing iframe in ${html}`);
  return match[1];
}

// COD-239: docx/pptx previews fetch the same-origin preview URL as a readiness
// probe; the body is never read. This is the "conversion succeeded" response.
function okPreviewProbe(): { ok: true; body: { cancel: () => void } } {
  return { ok: true, body: { cancel: () => {} } };
}

function diffHost(
  proto: Proto,
  state: Record<string, unknown>,
  body: PreviewElement,
  footer: PreviewElement,
  metadata: Record<string, unknown>
) {
  return {
    filePreviewState: state,
    filePreviewContent: '',
    $: vi.fn((id: string) => (id === 'filePreviewBody' ? body : id === 'filePreviewFooter' ? footer : null)),
    formatFileSize: vi.fn(() => '31 KB'),
    _documentParams: proto._documentParams,
    _renderDocumentDiff: proto._renderDocumentDiff,
    _renderFilePreviewBody: proto._renderFilePreviewBody,
    _renderExportPdfControl: proto._renderExportPdfControl,
    _renderOfficeConversionPreview: proto._renderOfficeConversionPreview,
    _renderOfficePreviewError: proto._renderOfficePreviewError,
    _teardownOfficePreviewResources: proto._teardownOfficePreviewResources,
    _applyCommentHighlights: vi.fn(),
    _fetchFilePreviewMetadata: vi.fn(async () => metadata),
    _filePreviewSignature: proto._filePreviewSignature,
  };
}

describe('COD-238 Files-panel source download', () => {
  it('does not let a pending attachment diff overwrite a newer Files-panel preview', async () => {
    const versionsRequest = deferred<Record<string, unknown>>();
    // Office previews fetch the converted PDF; version/diff calls hit the same
    // global fetch, so route by URL: preview -> PDF blob, everything else -> the
    // deferred versions request under test.
    const proto = loadPanelsUiPrototype({
      fetch: vi.fn((url: string) =>
        /preview/.test(url) ? Promise.resolve(okPreviewProbe()) : versionsRequest.promise
      ),
    });
    const body = previewElement();
    const footer = previewElement();
    const attachmentState = {
      sessionId: 'attachment-a',
      filePath: 'Attachment A.docx',
      attachmentId: 'att-a',
      metadataUrl: '/api/sessions/attachment-a/attachments/att-a',
      signature: '1:1',
      docxView: 'pdf',
      mode: 'preview',
    };
    const filesPath = 'deliverables/Files B.docx';
    const filesMetadata = {
      type: 'document',
      extension: 'docx',
      size: 31_000,
      mtimeMs: 2,
      url: `/api/sessions/files-b/file-raw?path=${encodeURIComponent(filesPath)}`,
      previewUrl: `/api/sessions/files-b/file-preview?path=${encodeURIComponent(filesPath)}`,
    };
    const host = diffHost(proto, attachmentState, body, footer, filesMetadata);

    const pendingDiff = proto.showDocumentDiff.call(host);
    const filesState = {
      sessionId: 'files-b',
      filePath: filesPath,
      attachmentId: null,
      metadataUrl: `/api/sessions/files-b/file-content?path=${encodeURIComponent(filesPath)}`,
      signature: '2:31000',
      docxView: 'pdf',
      mode: 'preview',
    };
    host.filePreviewState = filesState;
    await proto._renderFilePreviewBody.call(
      host,
      filesMetadata,
      { sessionId: 'files-b', filePath: filesPath, attachmentId: null },
      filesState
    );
    // COD-239: rendering is now async (the office loader probes readiness first);
    // wait for the same-origin preview iframe to land.
    await (filesState as { previewRenderPromise?: Promise<void> }).previewRenderPromise;

    versionsRequest.resolve({ ok: true, json: async () => ({ data: { versions: [] } }) });
    await pendingDiff;

    // The newer Files-panel preview, not the stale attachment diff, wins.
    expect(iframeSrc(body.innerHTML)).toContain('files-b');
    expect(iframeSrc(body.innerHTML)).toContain(encodeURIComponent(filesPath));
    expect(body.innerHTML).not.toContain('document-preview-diff');
    expect(footer.innerHTML).toContain('Download DOCX');
  });

  it.each(['success', 'error'] as const)(
    'does not re-enter Changes after exit when the pending diff request ends in %s',
    async (outcome) => {
      const versionsRequest = deferred<Record<string, unknown>>();
      const proto = loadPanelsUiPrototype({
        fetch: vi.fn((url: string) =>
          /preview/.test(url) ? Promise.resolve(okPreviewProbe()) : versionsRequest.promise
        ),
      });
      const body = previewElement();
      const footer = previewElement();
      const filePath = 'Published Brief.docx';
      const metadata = {
        type: 'document',
        extension: 'docx',
        size: 31_000,
        mtimeMs: 3,
        url: '/api/sessions/attachment-owner/attachments/att-brief/raw',
        previewUrl: '/api/sessions/attachment-owner/attachments/att-brief/preview',
      };
      const state = {
        sessionId: 'attachment-owner',
        filePath,
        attachmentId: 'att-brief',
        metadataUrl: '/api/sessions/attachment-owner/attachments/att-brief',
        signature: '2:30000',
        docxView: 'pdf',
        mode: 'preview',
      };
      const host = diffHost(proto, state, body, footer, metadata);

      const pendingDiff = proto.showDocumentDiff.call(host);
      await proto.exitDocumentDiff.call(host);
      // COD-239: exit re-renders the live document; rendering is now async (the
      // office loader probes readiness first), so wait for the iframe to land.
      await (state as { previewRenderPromise?: Promise<void> }).previewRenderPromise;
      expect(state.mode).toBe('preview');
      expect(iframeSrc(body.innerHTML)).toContain('/attachments/att-brief/preview');

      if (outcome === 'success') {
        versionsRequest.resolve({ ok: true, json: async () => ({ data: { versions: [] } }) });
      } else {
        versionsRequest.reject(new Error('versions unavailable'));
      }
      await pendingDiff;

      expect(state.mode).toBe('preview');
      expect(iframeSrc(body.innerHTML)).toContain('/attachments/att-brief/preview');
      expect(body.innerHTML).not.toContain('document-preview-diff');
      expect(body.innerHTML).not.toContain('versions unavailable');
    }
  );

  it('keeps the displayed preview and source button on the latest out-of-order open', async () => {
    const proto = loadPanelsUiPrototype({ fetch: vi.fn(async () => okPreviewProbe()) });
    const firstPath = 'deliverables/First Draft.docx';
    const secondPath = 'deliverables/Approved Final.docx';
    const firstMetadata = deferred<Record<string, unknown>>();
    const secondMetadata = deferred<Record<string, unknown>>();
    const body = previewElement();
    const footer = previewElement();
    const title = previewElement();
    const overlay = { classList: { add: vi.fn() } };
    const downloadWorkspaceFile = vi.fn();
    const startFilePreviewPolling = vi.fn();
    const host = {
      filePreviewState: null as Record<string, unknown> | null,
      filePreviewContent: '',
      _annotations: [],
      downloadWorkspaceFile,
      formatFileSize: vi.fn(() => '31 KB'),
      $: vi.fn((id: string) => {
        if (id === 'filePreviewOverlay') return overlay;
        if (id === 'filePreviewTitle') return title;
        if (id === 'filePreviewBody') return body;
        if (id === 'filePreviewFooter') return footer;
        return null;
      }),
      _restorePreviewSize: vi.fn(),
      _closeAnnotationTray: vi.fn(),
      _stopFilePreviewPolling: proto._stopFilePreviewPolling,
      _hideFilePreviewNavigation: proto._hideFilePreviewNavigation,
      _loadFilePreviewNavigation: proto._loadFilePreviewNavigation,
      _startFilePreviewPolling: startFilePreviewPolling,
      _fetchFilePreviewMetadata: vi.fn((url: string) =>
        url.includes('first-session') ? firstMetadata.promise : secondMetadata.promise
      ),
      _filePreviewSignature: proto._filePreviewSignature,
      _renderFilePreviewBody: proto._renderFilePreviewBody,
      _renderExportPdfControl: proto._renderExportPdfControl,
      _renderOfficeConversionPreview: proto._renderOfficeConversionPreview,
      _renderOfficePreviewError: proto._renderOfficePreviewError,
      _teardownOfficePreviewResources: proto._teardownOfficePreviewResources,
      _documentParams: proto._documentParams,
    };

    const firstOpen = proto.openFilePreview.call(host, firstPath, 'first-session', null);
    const secondOpen = proto.openFilePreview.call(host, secondPath, 'second-session', null);

    secondMetadata.resolve({
      type: 'document',
      extension: 'docx',
      size: 31_000,
      mtimeMs: 2,
      url: `/api/sessions/second-session/file-raw?path=${encodeURIComponent(secondPath)}`,
      previewUrl: `/api/sessions/second-session/file-preview?path=${encodeURIComponent(secondPath)}`,
    });
    await secondOpen;

    firstMetadata.resolve({
      type: 'document',
      extension: 'docx',
      size: 30_000,
      mtimeMs: 1,
      url: `/api/sessions/first-session/file-raw?path=${encodeURIComponent(firstPath)}`,
      previewUrl: `/api/sessions/first-session/file-preview?path=${encodeURIComponent(firstPath)}`,
    });
    await firstOpen;

    // COD-239: rendering is now async (readiness probe first); wait for the
    // winning preview's same-origin iframe before asserting the final body.
    await (host.filePreviewState as { previewRenderPromise?: Promise<void> } | null)?.previewRenderPromise;

    expect(title.textContent).toBe(secondPath);
    // The latest open won: the second session's same-origin preview is shown,
    // polling started once, and the state + source download both point at the
    // second session (the first open returned early and never rendered).
    expect(iframeSrc(body.innerHTML)).toContain('second-session');
    expect(iframeSrc(body.innerHTML)).toContain(encodeURIComponent(secondPath));
    expect(iframeSrc(body.innerHTML)).not.toContain('first-session');
    expect(startFilePreviewPolling).toHaveBeenCalledOnce();
    expect(host.filePreviewState).toMatchObject({ sessionId: 'second-session', filePath: secondPath });

    proto.downloadFilePreviewSource.call(host);
    expect(downloadWorkspaceFile).toHaveBeenCalledWith('second-session', secondPath);
  });

  it.each([
    ['document', 'docx', 'deliverables/Market Story Final.docx', 'Download DOCX'],
    ['presentation', 'pptx', 'deliverables/Executive Brief Final.pptx', 'Download PPTX'],
  ])(
    'makes the original %s source primary while the converted PDF remains the preview',
    async (type, extension, filePath, sourceLabel) => {
      const proto = loadPanelsUiPrototype({ fetch: vi.fn(async () => okPreviewProbe()) });
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
      // COD-239: rendering is now async (readiness probe first); the iframe still
      // targets the same-origin converted-PDF preview URL with #toolbar=0.
      await (state as { previewRenderPromise?: Promise<void> }).previewRenderPromise;

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
    const proto = loadPanelsUiPrototype({ fetch: vi.fn(async () => okPreviewProbe()) });
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
    // COD-239: rendering is now async (readiness probe first); wait for it. The
    // attachment preview keeps its same-origin URL with no workspace fragment.
    await (state as { previewRenderPromise?: Promise<void> }).previewRenderPromise;

    expect(iframeSrc(body.innerHTML)).toContain('/attachments/att_123/preview');
    expect(new URL(iframeSrc(body.innerHTML), 'https://codeman.test').hash).toBe('');
    expect(footer.innerHTML).not.toContain('document-source-download-btn');
    expect(footer.innerHTML).toContain('document-view-switch');
  });
});
