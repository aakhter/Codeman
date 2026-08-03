/** @fileoverview COD-261 — shared viewer download always retrieves the original source. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

function loadPrototype(overrides: Record<string, unknown> = {}): Proto {
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
    URL,
    URLSearchParams,
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), hidden: false },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    ...overrides,
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Proto }).__proto;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('COD-261 original viewer download', () => {
  it('derives encoded attachment and workspace raw URLs from identity, never metadata URLs', () => {
    const proto = loadPrototype();
    const host = Object.create(proto) as Record<string, unknown>;

    const attachmentState = {
      sessionId: 'session / one',
      attachmentId: 'attachment / one',
      filePath: 'converted.pdf',
      mtimeMs: 123,
    };
    Object.defineProperties(attachmentState, {
      previewUrl: {
        get: () => {
          throw new Error('metadata previewUrl must not be read');
        },
      },
      url: {
        get: () => {
          throw new Error('metadata url must not be read');
        },
      },
    });
    expect(proto._filePreviewOriginalDownloadUrl.call(host, attachmentState)).toBe(
      '/api/sessions/session%20%2F%20one/attachments/attachment%20%2F%20one/raw?download=true&_t=123'
    );
    expect(
      proto._filePreviewOriginalDownloadUrl.call(host, {
        sessionId: 'session two',
        attachmentId: null,
        filePath: 'deliverables/Market Story Final.docx',
      })
    ).toBe('/api/sessions/session%20two/file-raw?path=deliverables%2FMarket%20Story%20Final.docx&download=true');
  });

  it('enables synchronously from identity and resets the header control when the preview closes', async () => {
    const proto = loadPrototype();
    const metadata = deferred<Record<string, unknown>>();
    const button = { disabled: true };
    const overlay = { classList: { add: vi.fn(), remove: vi.fn() } };
    const title = { textContent: '' };
    const body = { innerHTML: '' };
    const footer = { textContent: '' };
    const host = Object.assign(Object.create(proto), {
      filePreviewState: null,
      _annotations: [],
      $: vi.fn((id: string) =>
        id === 'filePreviewDownloadOriginal'
          ? button
          : id === 'filePreviewOverlay'
            ? overlay
            : id === 'filePreviewTitle'
              ? title
              : id === 'filePreviewBody'
                ? body
                : id === 'filePreviewFooter'
                  ? footer
                  : null
      ),
      _restorePreviewSize: vi.fn(),
      _hideFilePreviewNavigation: vi.fn(),
      _loadFilePreviewNavigation: vi.fn(),
      _closeAnnotationTray: vi.fn(),
      _fetchFilePreviewMetadata: vi.fn(() => metadata.promise),
      _renderFilePreviewBody: vi.fn(async () => true),
      _startFilePreviewPolling: vi.fn(),
      _teardownOfficePreviewResources: vi.fn(),
    });

    const opening = proto.openFilePreview.call(host, 'report.docx', 'session-1', 'attachment-1') as Promise<void>;
    expect(button.disabled).toBe(false);
    proto._stopFilePreviewPolling.call(host);
    expect(button.disabled).toBe(true);
    metadata.resolve({ type: 'document', mtimeMs: 123 });
    await opening;
  });

  it('uses refreshed mtimeMs after polling and keeps image clipboard state independent', async () => {
    const proto = loadPrototype();
    const state = {
      sessionId: 'session-1',
      attachmentId: null,
      filePath: 'image.png',
      metadataUrl: '/metadata',
      signature: '100:10',
      mtimeMs: 100,
      previewKind: 'image',
      previewCopyUrl: '/preview.png',
    };
    const host = Object.assign(Object.create(proto), {
      filePreviewState: state,
      _filePreviewPolling: false,
      $: vi.fn((id: string) => (id === 'filePreviewOverlay' ? { classList: { contains: () => true } } : null)),
      _fetchFilePreviewMetadata: vi.fn(async () => ({ mtimeMs: 200, size: 10 })),
      _filePreviewSignature: proto._filePreviewSignature,
    });

    await proto._pollFilePreview.call(host);
    expect(proto._filePreviewOriginalDownloadUrl.call(host, state)).toBe(
      '/api/sessions/session-1/file-raw?path=image.png&download=true&_t=200'
    );
    expect(state.previewKind).toBe('image');
    expect(state.previewCopyUrl).toBe('/preview.png');
  });

  it('fetches an original Blob silently on success and reports failures without navigation', async () => {
    const createObjectURL = vi.fn(() => 'blob:download');
    const revokeObjectURL = vi.fn();
    const anchor = { click: vi.fn(), remove: vi.fn(), href: '', download: '', rel: '' };
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => new Blob(['original']) }));
    const proto = loadPrototype({
      fetch,
      URL: { createObjectURL, revokeObjectURL },
      document: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        hidden: false,
        body: { appendChild: vi.fn() },
        createElement: vi.fn(() => anchor),
      },
    });
    const host = Object.assign(Object.create(proto), {
      filePreviewState: { sessionId: 's', attachmentId: 'a', filePath: 'Original.docx' },
      showToast: vi.fn(),
    });

    await proto.downloadFilePreviewOriginal.call(host);

    expect(fetch).toHaveBeenCalledWith('/api/sessions/s/attachments/a/raw?download=true');
    expect(anchor.download).toBe('Original.docx');
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(host.showToast).not.toHaveBeenCalled();
  });

  it('does not download a stale preview and shows an error toast for a failed request', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'Attachment expired' }) }));
    const proto = loadPrototype({ fetch });
    const state = { sessionId: 's', attachmentId: 'a', filePath: 'Original.docx' };
    const host = Object.assign(Object.create(proto), { filePreviewState: state, showToast: vi.fn() });

    await proto.downloadFilePreviewOriginal.call(host, { ...state });
    expect(fetch).not.toHaveBeenCalled();
    await proto.downloadFilePreviewOriginal.call(host);
    expect(host.showToast).toHaveBeenCalledWith('Attachment expired', 'error');
  });

  it('ships an initially-disabled accessible header control and narrow icon-only CSS', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile.css'), 'utf8');
    const button = html.match(/<button\b[^>]*id="filePreviewDownloadOriginal"[^>]*>/)?.[0] || '';

    expect(button).toContain('type="button"');
    expect(button).toContain('onclick="app.downloadFilePreviewOriginal()"');
    expect(button).toContain('aria-label="Download original file"');
    expect(button).toContain('disabled');
    expect(css).toMatch(/@media \(max-width: 430px\)[\s\S]*filePreviewDownloadOriginal/);
  });
});
