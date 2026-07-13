/**
 * @fileoverview COD-232 browser/touch activation regression for terminal file links.
 * Port: 3188 (dedicated browser-test port; no real tmux session is created).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page, type Request } from 'playwright';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';

// The browser test never creates a terminal session. Avoid coupling WebServer
// construction to the host's tmux probe (which test/setup intentionally mocks).
vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const PORT = 3188;
const BASE_URL = `http://localhost:${PORT}`;
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const WORKING_DIR = '/workspace/project';
const FILE_PATH = 'out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';

describe('COD-232 terminal document link activation in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  const requests: Request[] = [];

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    page.on('request', (request) => requests.push(request));
    await page.route('**/api/sessions/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === `/api/sessions/${SESSION_ID}/file-content` && url.searchParams.get('path') === FILE_PATH) {
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
              previewUrl: `/api/sessions/${SESSION_ID}/file-preview?path=${encodeURIComponent(FILE_PATH)}`,
            },
          }),
        });
        return;
      }
      if (url.pathname === `/api/sessions/${SESSION_ID}/file-preview` && url.searchParams.get('path') === FILE_PATH) {
        await route.fulfill({
          status: 200,
          contentType: 'application/pdf',
          body: Buffer.from('%PDF-1.4\n%%EOF\n'),
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

  it('opens shared preview on touch activation without sending terminal input', async () => {
    const activated = await page.evaluate(
      async ({ sessionId, workingDir, filePath }) => {
        type Link = { text: string; activate: (event: PointerEvent, text: string) => void };
        const app = (window as unknown as { app: any }).app;
        const originalTerminal = app.terminal;
        let provider: { provideLinks: (line: number, callback: (links?: Link[]) => void) => void } | undefined;
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, { id: sessionId, workingDir });
        app.terminal = {
          cols: 120,
          registerLinkProvider(value: typeof provider) {
            provider = value;
          },
          buffer: {
            active: {
              getLine() {
                return {
                  isWrapped: false,
                  translateToString() {
                    return `Created ${filePath}`;
                  },
                };
              },
            },
          },
        };
        app.registerFilePathLinkProvider();
        let links: Link[] | undefined;
        provider!.provideLinks(1, (value) => {
          links = value;
        });
        if (!links?.length) {
          app.terminal = originalTerminal;
          return false;
        }
        links[0].activate(new PointerEvent('pointerup', { pointerType: 'touch' }), links[0].text);
        app.terminal = originalTerminal;
        return true;
      },
      { sessionId: SESSION_ID, workingDir: WORKING_DIR, filePath: FILE_PATH }
    );

    expect(activated).toBe(true);
    await page.locator('#filePreviewOverlay.visible .document-preview-frame').waitFor({ state: 'attached' });

    const sessionRequests = requests.map((request) => new URL(request.url()).pathname);
    expect(sessionRequests).toContain(`/api/sessions/${SESSION_ID}/file-content`);
    expect(sessionRequests).toContain(`/api/sessions/${SESSION_ID}/file-preview`);
    expect(sessionRequests.some((pathname) => pathname.endsWith('/input'))).toBe(false);
  }, 30_000);
});
