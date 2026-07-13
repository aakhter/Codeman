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
const MISSING_PATH = 'out/airdc-fy27-roadmap-mapping/deliverables/missing-story.docx';

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
      if (
        url.pathname === `/api/sessions/${SESSION_ID}/file-content` &&
        url.searchParams.get('path') === MISSING_PATH
      ) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'File not found' }),
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

  async function writePathAndGetTouchPoint(filePath: string): Promise<{ x: number; y: number }> {
    return page.evaluate(
      async ({ sessionId, workingDir, path }) => {
        const app = (window as unknown as { app: any }).app;
        if (!app.terminal) app.initTerminal();
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, { id: sessionId, workingDir, mode: 'codex' });
        app.hideWelcome();

        if (!app.__cod232TouchCounters) {
          app.__cod232TouchCounters = { sgr: 0, click: 0, input: 0 };
          for (const [name, key] of [
            ['_sendSyntheticSgrTap', 'sgr'],
            ['_dispatchSyntheticTerminalClick', 'click'],
            ['_sendInputAsync', 'input'],
          ]) {
            const original = app[name].bind(app);
            app[name] = (...args: unknown[]) => {
              app.__cod232TouchCounters[key]++;
              return original(...args);
            };
          }
        }
        app.__cod232TouchCounters.sgr = 0;
        app.__cod232TouchCounters.click = 0;
        app.__cod232TouchCounters.input = 0;

        app.terminal.reset();
        await new Promise<void>((resolve) => app.terminal.write(`Created ${path}`, resolve));
        app.terminal.scrollToBottom();

        const buffer = app.terminal.buffer.active;
        const bufferLine = buffer.baseY + buffer.cursorY + 1;
        const viewportRow = bufferLine - buffer.viewportY;
        const screen = app.terminal.element.querySelector('.xterm-screen');
        const rect = screen.getBoundingClientRect();
        const cell = app.terminal._core._renderService.dimensions.css.cell;
        const pathStartColumn = 'Created '.length + 1;
        return {
          x: rect.left + (pathStartColumn - 0.5) * cell.width,
          y: rect.top + (viewportRow - 0.5) * cell.height,
        };
      },
      { sessionId: SESSION_ID, workingDir: WORKING_DIR, path: filePath }
    );
  }

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60_000);

  it('opens shared preview on touch activation without sending terminal input', async () => {
    requests.length = 0;
    const point = await writePathAndGetTouchPoint(FILE_PATH);

    await page.touchscreen.tap(point.x, point.y);
    await page.locator('#filePreviewOverlay.visible .document-preview-frame').waitFor({ state: 'attached' });

    const sessionRequests = requests.map((request) => new URL(request.url()).pathname);
    expect(sessionRequests).toContain(`/api/sessions/${SESSION_ID}/file-content`);
    expect(sessionRequests).toContain(`/api/sessions/${SESSION_ID}/file-preview`);
    expect(sessionRequests.some((pathname) => pathname.endsWith('/input'))).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { app: any }).app.__cod232TouchCounters)).toEqual({
      sgr: 0,
      click: 0,
      input: 0,
    });
  }, 30_000);

  it('shows the API file-not-found state after touching a missing document link', async () => {
    requests.length = 0;
    const point = await writePathAndGetTouchPoint(MISSING_PATH);

    await page.touchscreen.tap(point.x, point.y);

    const previewBody = page.locator('#filePreviewOverlay.visible #filePreviewBody');
    await previewBody.waitFor({ state: 'visible' });
    await page.waitForFunction(() =>
      document.querySelector('#filePreviewBody')?.textContent?.includes('File not found')
    );
    expect(await previewBody.textContent()).toContain('Error: File not found');
    const sessionRequests = requests.map((request) => new URL(request.url()).pathname);
    expect(sessionRequests).toContain(`/api/sessions/${SESSION_ID}/file-content`);
    expect(sessionRequests.some((pathname) => pathname.endsWith('/file-preview'))).toBe(false);
    expect(sessionRequests.some((pathname) => pathname.endsWith('/input'))).toBe(false);
  }, 30_000);
});
