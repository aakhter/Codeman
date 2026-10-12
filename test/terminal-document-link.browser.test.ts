/**
 * @fileoverview COD-232 browser/touch activation regression for terminal file links.
 * Port: 3188 (dedicated browser-test port; no real tmux session is created).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page, type Request } from 'playwright';

const previousDataDir = process.env.CODEMAN_DATA_DIR;
const previousTmuxSocket = process.env.CODEMAN_TMUX_SOCKET;
const isolatedDataDir = mkdtempSync(join(tmpdir(), 'cod232-browser-'));
process.env.CODEMAN_DATA_DIR = isolatedDataDir;
process.env.CODEMAN_TMUX_SOCKET = `cod232-browser-${process.pid}`;
const [{ WebServer }, { TmuxManager }] = await Promise.all([
  import('../src/web/server.js'),
  import('../src/tmux-manager.js'),
]);

// The browser test never creates a terminal session. Avoid coupling WebServer
// construction to the host's tmux probe (which test/setup intentionally mocks).
vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

// Ephemeral port (test-ports-guard): set once the server has bound.
let BASE_URL = '';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const WORKING_DIR = '/workspace/project';
const FILE_PATH = 'out/airdc-fy27-roadmap-mapping/deliverables/fy27-airdc-messaging-market-story.docx';
const MISSING_PATH = 'out/airdc-fy27-roadmap-mapping/deliverables/missing-story.docx';

const require = createRequire(import.meta.url);

async function loadXtermBrowserAssets(): Promise<Map<string, { body: string; contentType: string }>> {
  const zerolagBundle = await build({
    entryPoints: [resolve(import.meta.dirname, '../packages/xterm-zerolag-input/src/zerolag-input-addon.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'XtermZerolagInput',
    platform: 'browser',
  });
  const zerolagSource = `${zerolagBundle.outputFiles[0].text}
window.LocalEchoOverlay = class extends XtermZerolagInput.ZerolagInputAddon {
  constructor(terminal) {
    super({ prompt: { type: 'character', char: '\u276f', offset: 2 } });
    this.activate(terminal);
  }
};`;

  const javascript = (packagePath: string) => ({
    body: readFileSync(require.resolve(packagePath), 'utf8'),
    contentType: 'application/javascript',
  });
  return new Map([
    ['/vendor/xterm.min.js', javascript('@xterm/xterm/lib/xterm.js')],
    ['/vendor/xterm-addon-fit.min.js', javascript('@xterm/addon-fit/lib/addon-fit.js')],
    ['/vendor/xterm-addon-serialize.min.js', javascript('@xterm/addon-serialize/lib/addon-serialize.js')],
    ['/vendor/xterm-addon-unicode11.min.js', javascript('@xterm/addon-unicode11/lib/addon-unicode11.js')],
    ['/vendor/xterm-addon-webgl.min.js', javascript('@xterm/addon-webgl/lib/addon-webgl.js')],
    ['/vendor/xterm-zerolag-input.js', { body: zerolagSource, contentType: 'application/javascript' }],
    [
      '/vendor/xterm.css',
      { body: readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8'), contentType: 'text/css' },
    ],
  ]);
}

describe('COD-232 terminal document link activation in a real browser', () => {
  let server: InstanceType<typeof WebServer>;
  let browser: Browser;
  let page: Page;
  let cdp: Awaited<ReturnType<ReturnType<Page['context']>['newCDPSession']>>;
  const requests: Request[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    BASE_URL = `http://localhost:${server.boundPort}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    cdp = await page.context().newCDPSession(page);
    page.on('request', (request) => requests.push(request));
    const xtermAssets = await loadXtermBrowserAssets();
    await page.route('**/vendor/xterm*', async (route) => {
      const asset = xtermAssets.get(new URL(route.request().url()).pathname);
      if (!asset) {
        await route.continue();
        return;
      }
      await route.fulfill({ status: 200, ...asset });
    });
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
    await page.waitForFunction(() => {
      const app = (window as unknown as { app?: any }).app;
      return (
        document.body.classList.contains('app-loaded') &&
        app?._terminalFilePathLinkProvider &&
        app.terminal?.element?.querySelector('.xterm-screen')
      );
    });
  }, 60_000);

  async function writePathAndGetTouchPoint(filePath: string): Promise<{
    x: number;
    y: number;
    diagnostics: {
      bufferLine: number;
      cell: { col: number; row: number } | null;
      links: Array<{
        text: string;
        range: { start: { x: number; y: number }; end: { x: number; y: number } };
      }>;
    };
  }> {
    return page.evaluate(
      async ({ sessionId, workingDir, path }) => {
        const app = (window as unknown as { app: any }).app;
        app.activeSessionId = sessionId;
        app.sessions.set(sessionId, { id: sessionId, workingDir, mode: 'codex' });
        app.closeFilePreview();
        app.hideWelcome();

        if (!app.__cod232TouchCounters) {
          app.__cod232TouchCounters = { touch: 0, sgr: 0, click: 0, input: 0 };
          for (const [name, key] of [
            // `_handleMobileTerminalTap` is what touchend calls now;
            // `_handleTerminalTouchTap` is no longer on the touch path at all, so
            // counting it made this assertion vacuous (always 0, never checked).
            ['_handleMobileTerminalTap', 'touch'],
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
        app.__cod232TouchCounters.touch = 0;
        app.__cod232TouchCounters.sgr = 0;
        app.__cod232TouchCounters.click = 0;
        app.__cod232TouchCounters.input = 0;

        app.terminal.reset();
        // Terminate the line. `f2d3a7e3` made a tap on the CARET's own logical line
        // mean "place the cursor in text the user typed" (`_tapIsOnCaretLine`), so
        // it classifies as 'input' and never activates a link. This fixture used to
        // leave the cursor parked on the path it had just written, which is not what
        // a session looks like — agent output scrolls above the composer.
        await new Promise<void>((resolve) => app.terminal.write(`Created ${path}\r\n`, resolve));
        app.terminal.scrollToBottom();

        const buffer = app.terminal.buffer.active;
        // The path row is the one ABOVE the caret now.
        const bufferLine = buffer.baseY + buffer.cursorY;
        const viewportRow = bufferLine - buffer.viewportY;
        const screen = app.terminal.element.querySelector('.xterm-screen');
        const rect = screen.getBoundingClientRect();
        const cell = app.terminal._core._renderService.dimensions.css.cell;
        const pathStartColumn = 'Created '.length + 1;
        const point = {
          x: rect.left + (pathStartColumn - 0.5) * cell.width,
          y: rect.top + (viewportRow - 0.5) * cell.height,
        };
        let links = [];
        app._terminalFilePathLinkProvider.provideLinks(bufferLine, (providedLinks) => {
          links = (providedLinks || []).map(({ text, range }) => ({ text, range }));
        });
        return {
          ...point,
          diagnostics: {
            bufferLine,
            cell: app._terminalCellFromClientPoint(point.x, point.y),
            links,
          },
        };
      },
      { sessionId: SESSION_ID, workingDir: WORKING_DIR, path: filePath }
    );
  }

  function expectPathHit(point: Awaited<ReturnType<typeof writePathAndGetTouchPoint>>, filePath: string): void {
    const { bufferLine, cell, links } = point.diagnostics;
    expect(bufferLine).toBe(1);
    expect(cell).toEqual({ col: 9, row: 1 });
    expect(links).toEqual([
      {
        text: filePath,
        range: { start: { x: 9, y: 1 }, end: { x: 8 + filePath.length, y: 1 } },
      },
    ]);
    expect(cell!.row).toBeGreaterThanOrEqual(links[0].range.start.y);
    expect(cell!.row).toBeLessThanOrEqual(links[0].range.end.y);
    expect(cell!.col).toBeGreaterThanOrEqual(links[0].range.start.x);
    expect(cell!.col).toBeLessThanOrEqual(links[0].range.end.x);
  }

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    rmSync(isolatedDataDir, { recursive: true, force: true });
    if (previousDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = previousDataDir;
    if (previousTmuxSocket === undefined) delete process.env.CODEMAN_TMUX_SOCKET;
    else process.env.CODEMAN_TMUX_SOCKET = previousTmuxSocket;
  }, 60_000);

  it('opens shared preview on touch activation without sending terminal input', async () => {
    requests.length = 0;
    const point = await writePathAndGetTouchPoint(FILE_PATH);
    expectPathHit(point, FILE_PATH);

    await page.touchscreen.tap(point.x, point.y);
    await page.locator('#filePreviewOverlay.visible .document-preview-frame').waitFor({ state: 'attached' });

    const sessionRequests = requests.map((request) => new URL(request.url()).pathname);
    expect(sessionRequests).toContain(`/api/sessions/${SESSION_ID}/file-content`);
    expect(sessionRequests).toContain(`/api/sessions/${SESSION_ID}/file-preview`);
    expect(sessionRequests.some((pathname) => pathname.endsWith('/input'))).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { app: any }).app.__cod232TouchCounters)).toEqual({
      touch: 1,
      sgr: 0,
      click: 0,
      input: 0,
    });
  }, 30_000);

  it('shows the API file-not-found state after touching a missing document link', async () => {
    requests.length = 0;
    const point = await writePathAndGetTouchPoint(MISSING_PATH);
    expectPathHit(point, MISSING_PATH);

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
    expect(await page.evaluate(() => (window as unknown as { app: any }).app.__cod232TouchCounters)).toEqual({
      touch: 1,
      sgr: 0,
      click: 0,
      input: 0,
    });
  }, 30_000);

  it('does not activate a link or terminal input for a horizontal swipe', async () => {
    requests.length = 0;
    const point = await writePathAndGetTouchPoint(FILE_PATH);
    expectPathHit(point, FILE_PATH);

    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: point.x, y: point.y, id: 7 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: point.x + 20, y: point.y, id: 7 }],
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

    await expect.poll(() => page.locator('#filePreviewOverlay.visible').count()).toBe(0);
    const sessionRequests = requests.map((request) => new URL(request.url()).pathname);
    expect(sessionRequests).not.toContain(`/api/sessions/${SESSION_ID}/file-content`);
    expect(sessionRequests.some((pathname) => pathname.endsWith('/input'))).toBe(false);
    expect(await page.evaluate(() => (window as unknown as { app: any }).app.__cod232TouchCounters)).toEqual({
      touch: 0,
      sgr: 0,
      click: 0,
      input: 0,
    });
  }, 30_000);
});
