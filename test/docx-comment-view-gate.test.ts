/**
 * @fileoverview COD-418 — a .docx must offer the same Comment affordance
 * wherever it was opened from.
 *
 * The docx view switcher (PDF/HTML/Changes) and the Comment button used to be
 * gated on `!!attachmentId` rather than on the file being a docx. Only the
 * out-of-workspace terminal-link path registers an attachment
 * (`openExternalPathPreview`), so a docx opened by WORKSPACE PATH — from a
 * terminal file-path link (`terminal-ui.js:3056`) or the Files panel
 * (`panels-ui.js:3832`/`4413`), which make the identical
 * `openFilePreview(path, sessionId)` call — got no switcher, therefore no
 * selectable HTML view, therefore no Comment. A docx in /tmp was commentable
 * while the one in the repo was not, and nothing in the UI explained why.
 *
 * `Changes` (revision history) stays attachment-only: it needs stored versions.
 *
 * Same vm harness as document-preview-render-state.test.ts — drives the real
 * shipping panels-ui.js through openFilePreview / switchDocxView.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Proto = Record<string, (...args: never[]) => unknown>;

/** A preview element whose querySelector actually resolves the classes we assert on. */
type PreviewElement = {
  innerHTML: string;
  textContent: string;
  querySelector: (selector: string) => unknown;
  dataset: Record<string, string>;
};

function previewElement(): PreviewElement {
  const el: PreviewElement = {
    innerHTML: '',
    textContent: '',
    dataset: {},
    // Resolve a selector against the rendered markup: enough for the render paths
    // under test, which only ever ask "did the prose container get rendered?".
    querySelector(selector: string) {
      const classes = selector
        .split(',')
        .map((s) => s.trim().replace(/^\./, ''))
        .filter(Boolean);
      const hit = classes.find((cls) => el.innerHTML.includes(`class="${cls}`));
      return hit ? { className: hit, dataset: {}, addEventListener: vi.fn(), innerHTML: '' } : null;
    },
  };
  return el;
}

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
    document: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    ...contextOverrides,
  });
  vm.runInContext(`${source}\nglobalThis.__proto = CodemanApp.prototype;`, context);
  return (context as unknown as { __proto: Proto }).__proto;
}

type AppHost = Record<string, unknown> & {
  filePreviewState: (Record<string, unknown> & { previewRenderPromise?: Promise<void> }) | null;
};

/**
 * Invoke a prototype method on the loosely-typed host. Must `.apply(host, ...)` — these are real
 * prototype methods that read `this.$`, so extracting the function and calling it bare would strip
 * the binding and fail with `this.$ is not a function`.
 */
function call<T>(host: AppHost, method: string, ...args: unknown[]): T {
  return (host[method] as (...a: unknown[]) => T).apply(host, args);
}

function makeApp(proto: Proto, parts: { body: PreviewElement; footer: PreviewElement }): AppHost {
  const app = Object.create(proto) as AppHost;
  app.filePreviewState = null;
  app.filePreviewContent = '';
  app._annotations = [];
  app.formatFileSize = () => '28.7 KB';
  app._restorePreviewSize = vi.fn();
  app._closeAnnotationTray = vi.fn();
  app._startFilePreviewPolling = vi.fn();
  app._sanitizeHtml = (html: string) => html;
  app._bindDocxCommentInspector = vi.fn();
  app._applyCommentHighlights = vi.fn();
  app._fetchFilePreviewMetadata = vi.fn(async () => ({
    type: 'document',
    extension: 'docx',
    size: 28_700,
    mtimeMs: 123,
    url: '/api/sessions/sess-1/file-raw?path=outline.docx',
    previewUrl: '/api/sessions/sess-1/file-preview?path=outline.docx',
  }));
  app.$ = vi.fn((id: string) =>
    id === 'filePreviewBody'
      ? parts.body
      : id === 'filePreviewFooter'
        ? parts.footer
        : id === 'filePreviewOverlay'
          ? { classList: { add: vi.fn() } }
          : id === 'filePreviewTitle'
            ? previewElement()
            : null
  );
  return app;
}

/** The office-conversion readiness probe; body is cancelled, never read. */
function okProbe() {
  return { ok: true, body: { cancel: () => {} } };
}

/** Probe for the PDF branch, JSON for the /documents/html branch. */
function fetchStub(html = '<h1>What Production AI Requires from the Network</h1>') {
  return vi.fn(async (url: string) =>
    String(url).includes('/documents/html') ? { ok: true, json: async () => ({ data: { html } }) } : okProbe()
  );
}

async function openDocx(attachmentId: string | null, fetchImpl = fetchStub()) {
  const proto = loadPanelsUiPrototype({ fetch: fetchImpl });
  const body = previewElement();
  const footer = previewElement();
  const app = makeApp(proto, { body, footer });
  await call<Promise<void>>(app, 'openFilePreview', 'outline.docx', 'sess-1', attachmentId);
  await app.filePreviewState?.previewRenderPromise;
  return { app, body, footer };
}

describe('COD-418 docx comment affordance is gated on docx-ness, not on attachmentId', () => {
  it('offers the PDF/HTML switcher for a workspace-path docx (the reported case)', async () => {
    const { footer } = await openDocx(null);

    expect(footer.innerHTML).toContain(`switchDocxView('html')`);
    expect(footer.innerHTML).toContain(`switchDocxView('pdf')`);
  });

  it('withholds Changes for a workspace-path docx, which has no stored versions', async () => {
    const { footer } = await openDocx(null);

    expect(footer.innerHTML).not.toContain(`switchDocxView('changes')`);
  });

  it('keeps the full switcher including Changes for an attachment-backed docx', async () => {
    const { footer } = await openDocx('att-1');

    expect(footer.innerHTML).toContain(`switchDocxView('html')`);
    expect(footer.innerHTML).toContain(`switchDocxView('changes')`);
  });

  it('offers Comment on the HTML view of a workspace-path docx', async () => {
    const { app, body, footer } = await openDocx(null);
    await call<Promise<void>>(app, 'switchDocxView', 'html');

    expect(body.innerHTML).toContain('document-preview-html');
    expect(footer.innerHTML).toContain('commentOnSelection()');
  });

  it('requests the HTML render by path when there is no attachment', async () => {
    const fetchImpl = fetchStub();
    const { app } = await openDocx(null, fetchImpl);
    await call<Promise<void>>(app, 'switchDocxView', 'html');

    const htmlCall = fetchImpl.mock.calls.map(([url]) => String(url)).find((url) => url.includes('/documents/html'));
    expect(htmlCall).toBeDefined();
    expect(htmlCall).toContain('path=outline.docx');
    expect(htmlCall).not.toContain('attachmentId');
  });

  it('still shows no switcher for a non-docx document (pptx)', async () => {
    const proto = loadPanelsUiPrototype({ fetch: fetchStub() });
    const body = previewElement();
    const footer = previewElement();
    const app = makeApp(proto, { body, footer });
    app._fetchFilePreviewMetadata = vi.fn(async () => ({
      type: 'presentation',
      extension: 'pptx',
      size: 28_700,
      previewUrl: '/api/sessions/sess-1/file-preview?path=deck.pptx',
    }));

    await call<Promise<void>>(app, 'openFilePreview', 'deck.pptx', 'sess-1', null);
    await app.filePreviewState?.previewRenderPromise;

    expect(footer.innerHTML).not.toContain('switchDocxView');
  });
});

describe('COD-418 comment highlights survive a re-render on the docx HTML view', () => {
  it('re-applies highlights onto the rendered HTML prose', async () => {
    const { app } = await openDocx(null);
    await call<Promise<void>>(app, 'switchDocxView', 'html');

    expect(app._applyCommentHighlights).toHaveBeenCalled();
  });

  it('resolves .document-preview-html as the prose container for anchoring', () => {
    const proto = loadPanelsUiPrototype();
    const body = previewElement();
    const app = makeApp(proto, { body, footer: previewElement() });
    body.innerHTML = '<div class="document-preview-html rv-text"><p>Session purpose</p></div>';

    const prose = call<{ className: string } | null>(app, '_previewProseEl');
    expect(prose).not.toBeNull();
    expect(prose!.className).toBe('document-preview-html');
  });
});
