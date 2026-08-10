/** @fileoverview COD-273 — resolve terminal file URIs into the shared in-app preview. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

function loadPrototype(fetch: ReturnType<typeof vi.fn>): Proto {
  const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, error: vi.fn() },
    CodemanApp: class CodemanApp {},
    escapeHtml: (value: unknown) =>
      String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;'),
    fetch,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    URL,
    URLSearchParams,
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), hidden: false },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Proto }).__proto;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeHarness(fetch: ReturnType<typeof vi.fn>) {
  const proto = loadPrototype(fetch);
  const overlay = {
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => true) },
  };
  const title = { textContent: '' };
  const body = { innerHTML: '' };
  const footer = { textContent: '' };
  const openFilePreview = vi.fn(async () => undefined);
  const host = Object.assign(Object.create(proto), {
    filePreviewState: null,
    filePreviewContent: '',
    _annotations: [],
    $: vi.fn((id: string) =>
      id === 'filePreviewOverlay'
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
    _resetFilePreviewExternalAction: vi.fn(),
    _resetFilePreviewOriginalDownloadAction: vi.fn(),
    _hideFilePreviewNavigation: vi.fn(),
    _teardownOfficePreviewResources: vi.fn(),
    _teardownOutlineScrollSpy: vi.fn(),
    _closeAnnotationPopover: vi.fn(),
    _closeAnnotationTray: vi.fn(),
    openFilePreview,
  });
  return { proto, host, overlay, title, body, footer, openFilePreview };
}

describe('COD-273 file URI preview UI', () => {
  it('shows Loading immediately, posts the encoded originating session, and opens the canonical preview', async () => {
    const response = deferred<unknown>();
    const fetch = vi.fn(() => response.promise);
    const { proto, host, overlay, title, body, footer, openFilePreview } = makeHarness(fetch);
    const uri = 'file:///workspace/project/out/mockup%20one.png';

    const opening = proto.openFileUriPreview.call(host, uri, 'session / one') as Promise<void>;

    expect(overlay.classList.add).toHaveBeenCalledWith('visible');
    expect(title.textContent).toBe(uri);
    expect(body.innerHTML).toBe('<div class="binary-message">Loading...</div>');
    expect(footer.textContent).toBe('');
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%20%2F%20one/file-uri-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    });

    response.resolve({
      ok: true,
      json: vi.fn(async () => ({ success: true, data: { fileName: 'mockup one.png', attachmentId: 'att_1' } })),
    });
    await opening;

    expect(openFilePreview).toHaveBeenCalledWith('mockup one.png', 'session / one', 'att_1');
  });

  it('escapes a safe server error in the overlay and keeps the clicked URI only in the title', async () => {
    const fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ success: false, error: '<img src=x onerror=alert(1)> unavailable' }),
    }));
    const { proto, host, title, body, openFilePreview } = makeHarness(fetch);
    const uri = 'file:///private/generated/secret%20plan.pdf';

    await proto.openFileUriPreview.call(host, uri, 'session-1');

    expect(title.textContent).toBe(uri);
    expect(body.innerHTML).toBe(
      '<div class="binary-message">Error: &lt;img src=x onerror=alert(1)&gt; unavailable</div>'
    );
    expect(body.innerHTML).not.toContain('/private/generated');
    expect(openFilePreview).not.toHaveBeenCalled();
  });

  it('ignores a response whose JSON completes after the preview is closed', async () => {
    const json = deferred<unknown>();
    const fetch = vi.fn(async () => ({ ok: true, json: vi.fn(() => json.promise) }));
    const { proto, host, overlay, body, openFilePreview } = makeHarness(fetch);

    const opening = proto.openFileUriPreview.call(
      host,
      'file:///workspace/out/report.pdf',
      'session-1'
    ) as Promise<void>;
    await Promise.resolve();
    proto.closeFilePreview.call(host);
    json.resolve({ success: true, data: { fileName: 'report.pdf', attachmentId: 'att_old' } });
    await opening;

    expect(overlay.classList.remove).toHaveBeenCalledWith('visible');
    expect(host.filePreviewState).toBeNull();
    expect(body.innerHTML).toBe('<div class="binary-message">Loading...</div>');
    expect(openFilePreview).not.toHaveBeenCalled();
  });

  it('does not let an older URI response replace a newer request', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { proto, host, openFilePreview } = makeHarness(fetch);

    const oldOpening = proto.openFileUriPreview.call(
      host,
      'file:///workspace/out/old.pdf',
      'session-1'
    ) as Promise<void>;
    const newOpening = proto.openFileUriPreview.call(
      host,
      'file:///workspace/out/new.pdf',
      'session-1'
    ) as Promise<void>;
    second.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'new.pdf', attachmentId: 'att_new' } }),
    });
    await newOpening;
    first.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'old.pdf', attachmentId: 'att_old' } }),
    });
    await oldOpening;

    expect(openFilePreview).toHaveBeenCalledTimes(1);
    expect(openFilePreview).toHaveBeenCalledWith('new.pdf', 'session-1', 'att_new');
  });

  it('does not let a late URI response replace a newer ordinary file preview', async () => {
    const resolverResponse = deferred<unknown>();
    const metadata = deferred<unknown>();
    const fetch = vi.fn(() => resolverResponse.promise);
    const { proto, host, title } = makeHarness(fetch);
    Object.assign(host, {
      openFilePreview: proto.openFilePreview,
      _loadFilePreviewNavigation: vi.fn(),
      _fetchFilePreviewMetadata: vi.fn(() => metadata.promise),
      _renderFilePreviewBody: vi.fn(async () => true),
      _filePreviewSignature: vi.fn(() => 'signature'),
      _setFilePreviewExternalUrl: vi.fn(),
      _setFilePreviewOriginalDownloadAction: vi.fn(),
      _startFilePreviewPolling: vi.fn(),
    });

    const uriOpening = proto.openFileUriPreview.call(
      host,
      'file:///workspace/out/old.pdf',
      'session-1'
    ) as Promise<void>;
    const ordinaryOpening = proto.openFilePreview.call(host, 'current.pdf', 'session-1') as Promise<void>;
    resolverResponse.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'old.pdf', attachmentId: 'att_old' } }),
    });
    await uriOpening;

    expect(title.textContent).toBe('current.pdf');
    expect(host.filePreviewState).toMatchObject({ filePath: 'current.pdf', sessionId: 'session-1' });

    metadata.resolve({ type: 'text', mtimeMs: 1 });
    await ordinaryOpening;
  });

  it.each([
    [
      'a non-JSON response',
      vi.fn(async () => ({ ok: false, json: vi.fn(async () => Promise.reject(new Error('bad json'))) })),
    ],
    ['a fetch failure', vi.fn(async () => Promise.reject(new Error('network down')))],
  ])('renders a bounded fallback for %s', async (_label, fetch) => {
    const { proto, host, body, openFilePreview } = makeHarness(fetch);

    await proto.openFileUriPreview.call(host, 'file:///workspace/out/report.pdf', 'session-1');

    expect(body.innerHTML).toBe('<div class="binary-message">Error: Unable to preview file</div>');
    expect(openFilePreview).not.toHaveBeenCalled();
  });
});

describe('COD-288 external terminal path preview UI', () => {
  const absolutePath = '/mnt/c/kb-data/webex-archive/Isovalent and Cisco Unified Edge/report.pdf';

  it('registers the absolute path against the originating session and preserves it as the preview title', async () => {
    const response = deferred<unknown>();
    const fetch = vi.fn(() => response.promise);
    const { proto, host, overlay, title, body, footer, openFilePreview } = makeHarness(fetch);

    const opening = proto.openExternalPathPreview.call(host, absolutePath, 'session / one') as Promise<void>;

    expect(overlay.classList.add).toHaveBeenCalledWith('visible');
    expect(title.textContent).toBe(absolutePath);
    expect(body.innerHTML).toBe('<div class="binary-message">Loading...</div>');
    expect(footer.textContent).toBe('');
    expect(fetch).toHaveBeenCalledWith('/api/sessions/session%20%2F%20one/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: absolutePath }),
    });

    response.resolve({
      ok: true,
      json: vi.fn(async () => ({ success: true, data: { fileName: 'report.pdf', attachmentId: 'att_1' } })),
    });
    await opening;

    expect(openFilePreview).toHaveBeenCalledWith('report.pdf', 'session / one', 'att_1', {
      displayPath: absolutePath,
    });
  });

  it('deduplicates repeated activation while the same registration is pending', async () => {
    const response = deferred<unknown>();
    const fetch = vi.fn(() => response.promise);
    const { proto, host, openFilePreview } = makeHarness(fetch);

    const first = proto.openExternalPathPreview.call(host, absolutePath, 'session-1') as Promise<void>;
    const second = proto.openExternalPathPreview.call(host, absolutePath, 'session-1') as Promise<void>;
    expect(fetch).toHaveBeenCalledTimes(1);

    response.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'report.pdf', attachmentId: 'att_1' } }),
    });
    await Promise.all([first, second]);

    expect(openFilePreview).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh registration when the prior request no longer owns the overlay', async () => {
    const firstResponse = deferred<unknown>();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ success: true, data: { fileName: 'report.pdf', attachmentId: 'att_new' } }),
      }));
    const { proto, host, openFilePreview } = makeHarness(fetch);

    const staleOpening = proto.openExternalPathPreview.call(host, absolutePath, 'session-1') as Promise<void>;
    host.filePreviewState = { mode: 'ordinary-preview' };
    const reopened = proto.openExternalPathPreview.call(host, absolutePath, 'session-1') as Promise<void>;
    await reopened;
    firstResponse.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'report.pdf', attachmentId: 'att_old' } }),
    });
    await staleOpening;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(openFilePreview).toHaveBeenCalledTimes(1);
    expect(openFilePreview).toHaveBeenCalledWith('report.pdf', 'session-1', 'att_new', {
      displayPath: absolutePath,
    });
  });

  it('ignores a registration response after the preview is closed', async () => {
    const response = deferred<unknown>();
    const fetch = vi.fn(() => response.promise);
    const { proto, host, overlay, openFilePreview } = makeHarness(fetch);

    const opening = proto.openExternalPathPreview.call(host, absolutePath, 'session-1') as Promise<void>;
    proto.closeFilePreview.call(host);
    response.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'report.pdf', attachmentId: 'att_old' } }),
    });
    await opening;

    expect(overlay.classList.remove).toHaveBeenCalledWith('visible');
    expect(openFilePreview).not.toHaveBeenCalled();
  });

  it('does not let an older external-path response replace a newer request', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { proto, host, openFilePreview } = makeHarness(fetch);

    const oldOpening = proto.openExternalPathPreview.call(host, '/mnt/c/shared/old.pdf', 'session-1') as Promise<void>;
    const newOpening = proto.openExternalPathPreview.call(host, '/mnt/c/shared/new.pdf', 'session-1') as Promise<void>;
    second.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'new.pdf', attachmentId: 'att_new' } }),
    });
    await newOpening;
    first.resolve({
      ok: true,
      json: async () => ({ success: true, data: { fileName: 'old.pdf', attachmentId: 'att_old' } }),
    });
    await oldOpening;

    expect(openFilePreview).toHaveBeenCalledTimes(1);
    expect(openFilePreview).toHaveBeenCalledWith('new.pdf', 'session-1', 'att_new', {
      displayPath: '/mnt/c/shared/new.pdf',
    });
  });

  it('escapes and bounds server errors without exposing the path in the body', async () => {
    const unsafe = `<img src=x onerror=alert(1)>${'x'.repeat(400)}`;
    const fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({ success: false, error: unsafe }),
    }));
    const { proto, host, title, body, openFilePreview } = makeHarness(fetch);

    await proto.openExternalPathPreview.call(host, absolutePath, 'session-1');

    expect(title.textContent).toBe(absolutePath);
    const boundedEscapedError = unsafe.slice(0, 300).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    expect(body.innerHTML).toBe(`<div class="binary-message">Error: ${boundedEscapedError}</div>`);
    expect(body.innerHTML).not.toContain('/mnt/c/kb-data');
    expect(openFilePreview).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a malformed success response',
      vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { fileName: 'report.pdf' } }) })),
    ],
    [
      'a non-JSON response',
      vi.fn(async () => ({ ok: false, json: async () => Promise.reject(new Error('bad json')) })),
    ],
    ['a network failure', vi.fn(async () => Promise.reject(new Error('network down')))],
  ])('renders a safe fallback for %s', async (_label, fetch) => {
    const { proto, host, body, openFilePreview } = makeHarness(fetch);

    await proto.openExternalPathPreview.call(host, absolutePath, 'session-1');

    expect(body.innerHTML).toBe('<div class="binary-message">Error: Unable to preview file</div>');
    expect(openFilePreview).not.toHaveBeenCalled();
  });

  it('uses an optional display path without changing the registered preview identity', async () => {
    const fetch = vi.fn();
    const { proto, host, title } = makeHarness(fetch);
    const metadata = deferred<unknown>();
    Object.assign(host, {
      openFilePreview: proto.openFilePreview,
      _loadFilePreviewNavigation: vi.fn(),
      _fetchFilePreviewMetadata: vi.fn(() => metadata.promise),
      _renderFilePreviewBody: vi.fn(async () => true),
      _filePreviewSignature: vi.fn(() => 'signature'),
      _setFilePreviewExternalUrl: vi.fn(),
      _setFilePreviewOriginalDownloadAction: vi.fn(),
      _startFilePreviewPolling: vi.fn(),
    });

    const opening = proto.openFilePreview.call(host, 'report.pdf', 'session-1', 'att_1', {
      displayPath: absolutePath,
    }) as Promise<void>;

    expect(title.textContent).toBe(absolutePath);
    expect(host.filePreviewState).toMatchObject({
      sessionId: 'session-1',
      filePath: 'report.pdf',
      attachmentId: 'att_1',
    });
    metadata.resolve({ type: 'text', mtimeMs: 1 });
    await opening;
  });
});
