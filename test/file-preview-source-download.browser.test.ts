/**
 * @fileoverview COD-238 deterministic browser regression for the Files-panel
 * shared viewer source-download control. This evaluates panels-ui.js in a minimal page
 * rather than starting Codeman, so it exercises real browser fetch/blob/download
 * behavior without depending on session bootstrap or a live tmux server.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';

const panelsSource = readFileSync(new URL('../src/web/public/panels-ui.js', import.meta.url), 'utf8');
const SESSION_ID = 'tree-owner-session';
const FILE_PATH = 'deliverables/Market Story Final.docx';
const SOURCE_BYTES = Buffer.from('PK\u0003\u0004 exact browser DOCX bytes');

describe('COD-238 Files-panel source download in a real browser', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('downloads the original spaced DOCX from the tree owner without navigating the SPA', async () => {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.route('https://codeman.test/api/sessions/**/file-raw?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        headers: { 'Content-Disposition': 'attachment; filename="Market Story Final.docx"' },
        body: SOURCE_BYTES,
      });
    });
    // COD-239: docx/pptx previews first fetch the same-origin preview URL as a
    // readiness probe (the endpoint blocks on the soffice conversion), then
    // render the iframe against that same URL — CSP-safe (a blob: iframe would be
    // blocked by default-src 'self') and a warm cache hit.
    await page.route('https://codeman.test/api/sessions/**/file-preview?**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 minimal') });
    });
    await page.setContent(`
      <base href="https://codeman.test/">
      <main id="spa-shell">terminal remains here</main>
      <button type="button" id="filePreviewDownloadOriginal" onclick="app.downloadFilePreviewOriginal()" disabled>Download</button>
      <section id="filePreviewBody"></section>
      <footer id="filePreviewFooter"></footer>
    `);
    await page.addScriptTag({
      content: `
        window.CodemanApp = class CodemanApp {};
        window.escapeHtml = value => String(value ?? '')
          .replaceAll('&', '&amp;')
          .replaceAll('"', '&quot;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;');
        ${panelsSource}
        window.app = new window.CodemanApp();
      `,
    });

    await page.evaluate(
      async ({ sessionId, filePath }) => {
        const app = (
          window as unknown as {
            app: {
              filePreviewState: Record<string, unknown>;
              filePreviewContent: string;
              $: (id: string) => HTMLElement | null;
              formatFileSize: () => string;
              _renderFilePreviewBody: (data: unknown, context: unknown) => Promise<void>;
            };
          }
        ).app;
        app.filePreviewState = { sessionId, filePath, attachmentId: null, docxView: 'pdf' };
        app.filePreviewContent = '';
        app.$ = (id) => document.getElementById(id);
        app.formatFileSize = () => '31 KB';
        app._setFilePreviewOriginalDownloadAction(app.filePreviewState);
        await app._renderFilePreviewBody(
          {
            type: 'document',
            extension: 'docx',
            size: 31_000,
            mtimeMs: 123,
            url: `/api/sessions/${sessionId}/file-raw?path=${encodeURIComponent(filePath)}`,
            previewUrl: `/api/sessions/${sessionId}/file-preview?path=${encodeURIComponent(filePath)}`,
          },
          { sessionId, filePath, attachmentId: null }
        );
      },
      { sessionId: SESSION_ID, filePath: FILE_PATH }
    );

    // COD-239: rendering is now async (the office loader probes readiness first);
    // wait for the iframe, which targets the same-origin preview URL with the
    // #toolbar=0 fragment (CSP-safe, not a blob: URL).
    await page.waitForSelector('.document-preview-frame');
    const frameSrc = await page.locator('.document-preview-frame').getAttribute('src');
    expect(frameSrc).not.toBeNull();
    const framedUrl = new URL(frameSrc!, 'https://codeman.test');
    expect(framedUrl.pathname).toBe(`/api/sessions/${SESSION_ID}/file-preview`);
    expect(framedUrl.hash).toBe('#toolbar=0');
    await expect.poll(() => page.locator('#filePreviewDownloadOriginal').isEnabled()).toBe(true);
    await expect.poll(() => page.locator('.document-export-btn').textContent()).toBe('Export PDF');

    const pageUrlBefore = page.url();
    const requestPromise = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith(`/api/sessions/${SESSION_ID}/file-raw`)
    );
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#filePreviewDownloadOriginal').click();
    const [request, download] = await Promise.all([requestPromise, downloadPromise]);

    const sourceUrl = new URL(request.url());
    expect(sourceUrl.pathname).toBe(`/api/sessions/${SESSION_ID}/file-raw`);
    expect(sourceUrl.searchParams.get('path')).toBe(FILE_PATH);
    expect(sourceUrl.searchParams.get('download')).toBe('true');
    expect(download.suggestedFilename()).toBe('Market Story Final.docx');
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    expect(readFileSync(downloadedPath!)).toEqual(SOURCE_BYTES);
    expect(page.url()).toBe(pageUrlBefore);
    await expect.poll(() => page.locator('#spa-shell').textContent()).toBe('terminal remains here');

    await page.close();
  }, 30_000);
});
