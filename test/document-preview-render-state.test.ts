/**
 * @fileoverview COD-239 — the first (uncached) DOCX/PPTX preview must not open
 * blank. The office-conversion preview endpoint BLOCKS on a soffice→PDF
 * conversion, so instead of pointing an iframe straight at the blocking endpoint
 * (blank until it resolves), the frontend now paints a visible "Rendering
 * document…" state and fetches the SAME-ORIGIN preview URL as an abortable
 * readiness probe. On success it renders the iframe against that same
 * same-origin URL — a warm cache hit AND allowed by the app's `default-src
 * 'self'` CSP (a `blob:` iframe would be CSP-blocked and stay blank). A close or
 * switch aborts the in-flight probe so a late response can't clobber a newer
 * preview; failure renders a Retry control.
 *
 * These tests evaluate panels-ui.js in a plain node vm (same harness style as
 * file-preview-source-download.test.ts) and drive openFilePreview /
 * _renderFilePreviewBody directly.
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
    AbortController,
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn(), hidden: false },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    ...contextOverrides,
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Proto }).__proto;
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

function iframeSrc(html: string): string {
  const match = html.match(/<iframe[^>]+src="([^"]+)"/);
  if (!match) throw new Error(`missing iframe in ${html}`);
  return match[1];
}

function iframeUrl(html: string): URL {
  return new URL(iframeSrc(html), 'https://codeman.test');
}

// COD-239: the readiness probe just needs an ok/!ok response; the body is never
// read (cancelled to free it). No blob is created — the iframe reuses the URL.
function okProbe(): { ok: true; body: { cancel: () => void } } {
  return { ok: true, body: { cancel: () => {} } };
}

type AppHost = Record<string, unknown> & {
  filePreviewState: (Record<string, unknown> & { previewRenderPromise?: Promise<void> }) | null;
};

function makeApp(
  proto: Proto,
  parts: {
    body: PreviewElement;
    footer: PreviewElement;
    overlay?: { classList: { add: ReturnType<typeof vi.fn> } };
    title?: PreviewElement;
    metadata: Record<string, unknown> | ((url: string) => Record<string, unknown>);
    startPolling?: ReturnType<typeof vi.fn>;
  }
): AppHost {
  const overlay = parts.overlay ?? { classList: { add: vi.fn() } };
  const title = parts.title ?? previewElement();
  const app = Object.create(proto) as AppHost;
  app.filePreviewState = null;
  app.filePreviewContent = '';
  app._annotations = [];
  app.formatFileSize = () => '31 KB';
  app._restorePreviewSize = vi.fn();
  app._closeAnnotationTray = vi.fn();
  app._startFilePreviewPolling = parts.startPolling ?? vi.fn();
  app._fetchFilePreviewMetadata = vi.fn(async (url: string) =>
    typeof parts.metadata === 'function' ? parts.metadata(url) : parts.metadata
  );
  app.$ = vi.fn((id: string) =>
    id === 'filePreviewBody'
      ? parts.body
      : id === 'filePreviewFooter'
        ? parts.footer
        : id === 'filePreviewOverlay'
          ? overlay
          : id === 'filePreviewTitle'
            ? title
            : null
  );
  return app;
}

function docMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'document',
    extension: 'docx',
    size: 31_000,
    mtimeMs: 123,
    url: '/api/sessions/sess-1/file-raw?path=Report.docx',
    previewUrl: '/api/sessions/sess-1/file-preview?path=Report.docx',
    ...overrides,
  };
}

describe('COD-239 office conversion preview render state', () => {
  it('shows a rendering state before a slow docx conversion resolves, then a same-origin iframe', async () => {
    const probe = deferred<Record<string, unknown>>();
    const proto = loadPanelsUiPrototype({ fetch: vi.fn(() => probe.promise) });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, { body, footer, metadata: docMetadata() });

    const open = app.openFilePreview!('Report.docx', 'sess-1', null) as Promise<void>;
    await open;

    // The readiness probe is still in flight — the body must not be blank.
    expect(body.innerHTML).toContain('Rendering document');
    expect(body.innerHTML).not.toContain('<iframe');

    probe.resolve(okProbe());
    await app.filePreviewState!.previewRenderPromise;

    // CSP-safe: the iframe points at the same-origin file-preview URL (a warm
    // cache hit after the probe), NOT a blob: URL, and keeps the workspace
    // #toolbar=0 fragment.
    const url = iframeUrl(body.innerHTML);
    expect(url.pathname).toBe('/api/sessions/sess-1/file-preview');
    expect(url.searchParams.get('path')).toBe('Report.docx');
    expect(url.hash).toBe('#toolbar=0');
    expect(iframeSrc(body.innerHTML).startsWith('blob:')).toBe(false);
  });

  it('renders the same-origin iframe immediately when the conversion is already cached', async () => {
    const proto = loadPanelsUiPrototype({ fetch: vi.fn(async () => okProbe()) });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, { body, footer, metadata: docMetadata() });

    await (app.openFilePreview!('Report.docx', 'sess-1', null) as Promise<void>);
    await app.filePreviewState!.previewRenderPromise;

    expect(iframeUrl(body.innerHTML).pathname).toBe('/api/sessions/sess-1/file-preview');
    expect(iframeSrc(body.innerHTML).startsWith('blob:')).toBe(false);
  });

  it('renders a pptx presentation conversion through the same-origin probe', async () => {
    const proto = loadPanelsUiPrototype({ fetch: vi.fn(async () => okProbe()) });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, {
      body,
      footer,
      metadata: docMetadata({
        type: 'presentation',
        extension: 'pptx',
        url: '/api/sessions/sess-1/file-raw?path=Deck.pptx',
        previewUrl: '/api/sessions/sess-1/file-preview?path=Deck.pptx',
      }),
    });

    await (app.openFilePreview!('Deck.pptx', 'sess-1', null) as Promise<void>);
    await app.filePreviewState!.previewRenderPromise;

    const url = iframeUrl(body.innerHTML);
    expect(url.pathname).toBe('/api/sessions/sess-1/file-preview');
    expect(url.searchParams.get('path')).toBe('Deck.pptx');
  });

  it('renders an error state with a Retry control when the conversion fails', async () => {
    const proto = loadPanelsUiPrototype({
      fetch: vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Document preview conversion failed' }),
      })),
    });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, { body, footer, metadata: docMetadata() });

    await (app.openFilePreview!('Report.docx', 'sess-1', null) as Promise<void>);
    await app.filePreviewState!.previewRenderPromise;

    expect(body.innerHTML).toContain('Document preview conversion failed');
    expect(body.innerHTML).toContain('app.retryFilePreview()');
    expect(body.innerHTML).not.toContain('<iframe');
  });

  it('retryFilePreview re-opens the current preview from scratch', async () => {
    const proto = loadPanelsUiPrototype({
      fetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, { body, footer, metadata: docMetadata() });

    await (app.openFilePreview!('Report.docx', 'sess-1', null) as Promise<void>);
    await app.filePreviewState!.previewRenderPromise;

    const reopen = vi.fn();
    app.openFilePreview = reopen;
    app.retryFilePreview!();
    expect(reopen).toHaveBeenCalledWith('Report.docx', 'sess-1', null);
  });

  it('suppresses a stale conversion completion after the preview is closed', async () => {
    const probe = deferred<Record<string, unknown>>();
    const proto = loadPanelsUiPrototype({ fetch: vi.fn(() => probe.promise) });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, { body, footer, metadata: docMetadata() });

    await (app.openFilePreview!('Report.docx', 'sess-1', null) as Promise<void>);
    expect(body.innerHTML).toContain('Rendering document');

    // Simulate a close/navigation that drops the current preview state.
    const renderPromise = app.filePreviewState!.previewRenderPromise;
    app.filePreviewState = null;

    probe.resolve(okProbe());
    await renderPromise;

    // The stale completion must not inject an iframe.
    expect(body.innerHTML).toContain('Rendering document');
    expect(body.innerHTML).not.toContain('<iframe');
  });

  it('does not let a slow first conversion clobber a newer preview', async () => {
    const firstProbe = deferred<Record<string, unknown>>();
    const proto = loadPanelsUiPrototype({
      fetch: vi.fn((target: string) => (target.includes('sess-b') ? Promise.resolve(okProbe()) : firstProbe.promise)),
    });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, {
      body,
      footer,
      metadata: (metaUrl: string) =>
        metaUrl.includes('sess-b')
          ? docMetadata({
              url: '/api/sessions/sess-b/file-raw?path=B.docx',
              previewUrl: '/api/sessions/sess-b/file-preview?path=B.docx',
            })
          : docMetadata({
              url: '/api/sessions/sess-a/file-raw?path=A.docx',
              previewUrl: '/api/sessions/sess-a/file-preview?path=A.docx',
            }),
    });

    const openA = app.openFilePreview!('A.docx', 'sess-a', null) as Promise<void>;
    await openA;
    expect(body.innerHTML).toContain('Rendering document');

    const openB = app.openFilePreview!('B.docx', 'sess-b', null) as Promise<void>;
    await openB;
    await app.filePreviewState!.previewRenderPromise;

    // B won: its same-origin preview URL is shown.
    expect(iframeUrl(body.innerHTML).pathname).toBe('/api/sessions/sess-b/file-preview');
    const winningSrc = iframeSrc(body.innerHTML);

    // A's slow conversion now resolves — it must not overwrite B's preview.
    firstProbe.resolve(okProbe());
    await new Promise((r) => setTimeout(r, 0));

    expect(iframeSrc(body.innerHTML)).toBe(winningSrc);
    expect(iframeSrc(body.innerHTML)).not.toContain('sess-a');
  });

  it('aborts the in-flight readiness probe when the preview is closed', async () => {
    const probe = deferred<Record<string, unknown>>();
    const proto = loadPanelsUiPrototype({ fetch: vi.fn(() => probe.promise) });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, { body, footer, metadata: docMetadata() });

    await (app.openFilePreview!('Report.docx', 'sess-1', null) as Promise<void>);
    const controller = app.filePreviewState!.previewFetchAbort as AbortController;
    const abortSpy = vi.spyOn(controller, 'abort');

    // Default args => close semantics: abort the probe and drop the state.
    app._stopFilePreviewPolling!();
    expect(abortSpy).toHaveBeenCalled();
    expect(app.filePreviewState).toBeNull();
  });
});
