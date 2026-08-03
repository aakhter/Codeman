/** @fileoverview COD-260 — safely open the current attachment preview in a new tab. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

type PreviewButton = { disabled: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function loadPanelsUiPrototype(open = vi.fn()) {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const browserWindow = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    location: { href: 'https://codeman.test/app?view=active', origin: 'https://codeman.test' },
    open,
  };
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
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), hidden: false },
    window: browserWindow,
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return { proto: (context as unknown as { __proto: Proto }).__proto, browserWindow };
}

function makeOpenHost(
  proto: Proto,
  button: PreviewButton,
  metadata: Record<string, unknown> | Promise<Record<string, unknown>>
) {
  const overlay = { classList: { add: vi.fn(), remove: vi.fn() } };
  const title = { textContent: '' };
  const body = { innerHTML: '' };
  const footer = { textContent: '' };
  const host = Object.create(proto) as Record<string, unknown> & { filePreviewState: Record<string, unknown> | null };
  host.filePreviewState = null;
  host.filePreviewContent = '';
  host._annotations = [];
  host.$ = vi.fn((id: string) => {
    if (id === 'filePreviewOverlay') return overlay;
    if (id === 'filePreviewTitle') return title;
    if (id === 'filePreviewBody') return body;
    if (id === 'filePreviewFooter') return footer;
    if (id === 'filePreviewOpenNewTab') return button;
    return null;
  });
  host._stopFilePreviewPolling = vi.fn(() => {
    host.filePreviewState = null;
  });
  host._restorePreviewSize = vi.fn();
  host._hideFilePreviewNavigation = vi.fn();
  host._loadFilePreviewNavigation = vi.fn();
  host._closeAnnotationTray = vi.fn();
  host._fetchFilePreviewMetadata = vi.fn(() => metadata);
  host._filePreviewSignature = vi.fn(() => 'signature');
  host._renderFilePreviewBody = vi.fn(async () => true);
  host._startFilePreviewPolling = vi.fn();
  return host;
}

describe('COD-260 file preview open in new tab', () => {
  it('ships a disabled accessible header action wired to the app method', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../src/web/public/index.html'), 'utf8');
    const match = html.match(/<button\b[^>]*id="filePreviewOpenNewTab"[^>]*>/);

    expect(match?.[0]).toContain('type="button"');
    expect(match?.[0]).toContain('class="btn-icon-sm"');
    expect(match?.[0]).toContain('onclick="app.openFilePreviewInNewTab()"');
    expect(match?.[0]).toContain('title="Open in new tab"');
    expect(match?.[0]).toContain('aria-label="Open in new tab"');
    expect(match?.[0]).toMatch(/\sdisabled(?:\s|>)/);
  });

  it('resets and disables the action before each open and after close', async () => {
    const { proto } = loadPanelsUiPrototype();
    const metadata = deferred<Record<string, unknown>>();
    const button = { disabled: false };
    const host = makeOpenHost(proto, button, metadata.promise);
    host.filePreviewState = { externalPreviewUrl: '/old-preview' };

    const opening = proto.openFilePreview.call(host, 'report.md', 'session-1', null) as Promise<void>;

    expect(button.disabled).toBe(true);
    expect(host.filePreviewState?.externalPreviewUrl).toBeUndefined();

    metadata.resolve({ type: 'text', previewUrl: '/current-preview' });
    await opening;
    expect(button.disabled).toBe(false);

    host._stopFilePreviewPolling = vi.fn(() => {
      host.filePreviewState = null;
    });
    host._teardownOutlineScrollSpy = vi.fn();
    host._closeAnnotationPopover = vi.fn();
    proto.closeFilePreview.call(host);

    expect(host.filePreviewState).toBeNull();
    expect(button.disabled).toBe(true);
  });

  it('prefers previewUrl, normalizes it to a same-origin path, and enables the action', async () => {
    const { proto } = loadPanelsUiPrototype();
    const button = { disabled: true };
    const host = makeOpenHost(proto, button, {
      type: 'image',
      previewUrl: 'https://codeman.test/rendered/report.pdf?rev=2#page=3',
      url: '/raw/report.docx',
    });

    await (proto.openFilePreview.call(host, 'report.docx', 'session-1', null) as Promise<void>);

    expect(host.filePreviewState?.externalPreviewUrl).toBe('/rendered/report.pdf?rev=2#page=3');
    expect(button.disabled).toBe(false);
  });

  it('uses exact guarded attachment and workspace raw fallbacks', () => {
    const { proto } = loadPanelsUiPrototype();
    const host = Object.create(proto) as Record<string, unknown>;

    expect(
      proto._resolveFilePreviewExternalUrl.call(
        host,
        {},
        {
          sessionId: 'session-1',
          filePath: 'ignored.pdf',
          attachmentId: 'attachment 1',
        }
      )
    ).toBe('/api/sessions/session-1/attachments/attachment%201/raw');
    expect(
      proto._resolveFilePreviewExternalUrl.call(
        host,
        {},
        {
          sessionId: 'session-2',
          filePath: 'notes/final draft.md',
          attachmentId: null,
        }
      )
    ).toBe('/api/sessions/session-2/file-raw?path=notes%2Ffinal%20draft.md');
  });

  it('falls through unsafe metadata candidates in priority order', () => {
    const { proto } = loadPanelsUiPrototype();

    expect(
      proto._resolveFilePreviewExternalUrl.call(
        {},
        { previewUrl: 'https://evil.test/rendered.pdf', url: '/safe-raw.pdf?rev=2' },
        { sessionId: 'session-1', filePath: 'report.pdf', attachmentId: null }
      )
    ).toBe('/safe-raw.pdf?rev=2');
    expect(
      proto._resolveFilePreviewExternalUrl.call(
        {},
        { previewUrl: 'javascript:alert(1)', url: 'http://[' },
        { sessionId: 'session-1', filePath: 'report.pdf', attachmentId: null }
      )
    ).toBe('/api/sessions/session-1/file-raw?path=report.pdf');
  });

  it.each([
    ['cross-origin', 'https://evil.test/steal'],
    ['malformed', 'http://['],
    ['javascript', 'javascript:alert(1)'],
    ['non-http', 'ftp://codeman.test/report.pdf'],
  ])('rejects %s metadata URLs when no safe fallback exists', (_label, previewUrl) => {
    const { proto } = loadPanelsUiPrototype();
    const state = { sessionId: null, filePath: null, attachmentId: null };

    expect(proto._resolveFilePreviewExternalUrl.call({}, { previewUrl }, state)).toBeNull();
  });

  it('opens only the current approved URL with opener isolation', () => {
    const opened = { opener: { unsafe: true } as unknown };
    const open = vi.fn(() => opened);
    const { proto } = loadPanelsUiPrototype(open);
    const host = { filePreviewState: { externalPreviewUrl: '/safe-preview?rev=1' } };

    expect(() => proto.openFilePreviewInNewTab.call(host)).not.toThrow();
    expect(open).toHaveBeenCalledWith('/safe-preview?rev=1', '_blank', 'noopener');
    expect(opened.opener).toBeNull();

    open.mockReturnValueOnce(null as unknown as typeof opened);
    expect(() => proto.openFilePreviewInNewTab.call(host)).not.toThrow();
  });

  it('does not open without a current approved URL', () => {
    const open = vi.fn();
    const { proto } = loadPanelsUiPrototype(open);

    proto.openFilePreviewInNewTab.call({ filePreviewState: null });
    proto.openFilePreviewInNewTab.call({ filePreviewState: {} });

    expect(open).not.toHaveBeenCalled();
  });

  it('does not let stale metadata enable or replace a newer preview action', async () => {
    const { proto } = loadPanelsUiPrototype();
    const oldMetadata = deferred<Record<string, unknown>>();
    const button = { disabled: true };
    const host = makeOpenHost(proto, button, oldMetadata.promise);

    const oldOpen = proto.openFilePreview.call(host, 'old.pdf', 'session-old', null) as Promise<void>;
    host._fetchFilePreviewMetadata = vi.fn(async () => ({ type: 'image', previewUrl: '/new-preview' }));
    const newOpen = proto.openFilePreview.call(host, 'new.pdf', 'session-new', null) as Promise<void>;
    await newOpen;

    expect(host.filePreviewState?.externalPreviewUrl).toBe('/new-preview');
    expect(button.disabled).toBe(false);

    oldMetadata.resolve({ type: 'image', previewUrl: '/old-preview' });
    await oldOpen;

    expect(host.filePreviewState?.externalPreviewUrl).toBe('/new-preview');
    expect(button.disabled).toBe(false);
  });
});
