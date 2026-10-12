/**
 * @fileoverview COD-231 browser regression — a Files tree remains bound to its
 * originating session when a different terminal tab is active.
 *
 * Port: 3187 (dedicated browser-test port; no real tmux session is created).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import { WebServer } from '../src/web/server.js';

// Ephemeral port (test-ports-guard): set once the server has bound.
let BASE_URL = '';
const OWNER_SESSION_ID = '11111111-1111-4111-8111-111111111111';
const ACTIVE_SESSION_ID = '22222222-2222-4222-8222-222222222222';
const FILE_PATH = 'out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';
const FILE_NAME = 'fy27-airdc-messaging-market-story.docx';

type RequestRecord = {
  pathname: string;
  path: string | null;
};

function record(request: Request): RequestRecord {
  const url = new URL(request.url());
  return { pathname: url.pathname, path: url.searchParams.get('path') };
}

describe('COD-231 Files preview session ownership in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  const requests: RequestRecord[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    BASE_URL = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

    page.on('request', (request) => requests.push(record(request)));
    await page.route('**/api/sessions/**', async (route) => {
      const url = new URL(route.request().url());

      if (url.pathname === `/api/sessions/${OWNER_SESSION_ID}/files`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              tree: [
                {
                  name: FILE_NAME,
                  path: FILE_PATH,
                  type: 'file',
                  extension: 'docx',
                  size: 31_000,
                },
              ],
              totalFiles: 1,
              totalDirectories: 0,
              truncated: false,
            },
          }),
        });
        return;
      }

      if (
        url.pathname === `/api/sessions/${OWNER_SESSION_ID}/file-content` &&
        url.searchParams.get('path') === FILE_PATH
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              type: 'document',
              extension: 'docx',
              size: 31_000,
              mtimeMs: 1_783_912_643_064,
            },
          }),
        });
        return;
      }

      if (
        url.pathname === `/api/sessions/${OWNER_SESSION_ID}/file-preview` &&
        url.searchParams.get('path') === FILE_PATH
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/pdf',
          body: Buffer.from(
            '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
              '2 0 obj\n<< /Type /Pages /Count 0 >>\nendobj\n' +
              'trailer\n<< /Root 1 0 R >>\n%%EOF\n'
          ),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.body.classList.contains('app-loaded') && typeof (window as { app?: unknown }).app !== 'undefined'
    );
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60_000);

  it('keeps download and DOCX preview requests scoped to the Files tree owner', async () => {
    await page.evaluate(
      ({ activeSessionId, ownerSessionId }) => {
        const app = (
          window as unknown as {
            app: { activeSessionId: string | null; showFileBrowserPanel: (sessionId: string) => void };
          }
        ).app;
        app.activeSessionId = activeSessionId;
        app.showFileBrowserPanel(ownerSessionId);
      },
      { activeSessionId: ACTIVE_SESSION_ID, ownerSessionId: OWNER_SESSION_ID }
    );

    const fileRow = page.locator('.file-tree-item', { hasText: FILE_NAME });
    await fileRow.waitFor({ state: 'visible' });

    const downloadHref = await fileRow.locator('.file-tree-download').getAttribute('href');
    expect(downloadHref).not.toBeNull();
    const downloadUrl = new URL(downloadHref!, BASE_URL);
    expect(downloadUrl.pathname).toBe(`/api/sessions/${OWNER_SESSION_ID}/file-raw`);
    expect(downloadUrl.searchParams.get('path')).toBe(FILE_PATH);

    const contentRequestPromise = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith('/file-content')
    );
    const previewRequestPromise = page.waitForRequest((request) =>
      new URL(request.url()).pathname.endsWith('/file-preview')
    );
    await fileRow.locator('.file-tree-name').click();
    const [contentRequest, previewRequest] = await Promise.all([contentRequestPromise, previewRequestPromise]);

    expect(record(contentRequest)).toEqual({
      pathname: `/api/sessions/${OWNER_SESSION_ID}/file-content`,
      path: FILE_PATH,
    });
    expect(record(previewRequest)).toEqual({
      pathname: `/api/sessions/${OWNER_SESSION_ID}/file-preview`,
      path: FILE_PATH,
    });

    const iframe = page.locator('#filePreviewOverlay.visible .document-preview-frame');
    await iframe.waitFor({ state: 'attached' });
    const iframeSrc = await iframe.getAttribute('src');
    expect(iframeSrc).not.toBeNull();
    const previewUrl = new URL(iframeSrc!, BASE_URL);
    expect(previewUrl.pathname).toBe(`/api/sessions/${OWNER_SESSION_ID}/file-preview`);
    expect(previewUrl.searchParams.get('path')).toBe(FILE_PATH);

    const previewText = (await page.locator('#filePreviewBody').textContent()) ?? '';
    expect(previewText).not.toContain('Error: Failed to load file');

    const contentRequests = requests.filter(({ pathname }) => pathname.endsWith('/file-content'));
    expect(contentRequests.length).toBeGreaterThanOrEqual(1);
    expect(
      contentRequests.every(
        ({ pathname, path }) => pathname === `/api/sessions/${OWNER_SESSION_ID}/file-content` && path === FILE_PATH
      )
    ).toBe(true);
    expect(requests.some(({ pathname }) => pathname.endsWith('/input'))).toBe(false);
  }, 30_000);
});
