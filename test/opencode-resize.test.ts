/**
 * OpenCode session UI tests
 *
 * Tests OpenCode-specific UI behavior:
 * - Initial terminal resize (not stuck at 120x40)
 * - Close modal shows "Kill Tmux & OpenCode" (not "Claude Code")
 * - needsRefresh handler sends resize
 *
 * Port: ephemeral
 *
 * Run: npx vitest run test/opencode-resize.test.ts
 */

import { execSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

let baseUrl: string;

const HAS_OPENCODE = (() => {
  try {
    execSync('command -v opencode', { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
})();

let server: WebServer;
let browser: Browser;

async function freshPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  return { context, page };
}

async function navigateAndWait(page: Page): Promise<void> {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), {
    timeout: 5000,
  });
}

beforeAll(async () => {
  server = new WebServer(0, false, true); // testMode
  await server.start();
  baseUrl = `http://localhost:${server.boundPort}`;
  browser = await chromium.launch({ headless: true });
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

describe(`${targetPrefix} OpenCode session initial resize`, () => {
  let context: BrowserContext;
  let page: Page;

  afterAll(async () => {
    await context?.close();
  });

  it('selectSession is not bypassed when the shared launcher sets activeSessionId', async () => {
    // This test verifies at the code level that the OpenCode launch path does
    // NOT pre-set activeSessionId before calling selectSession. If it did,
    // selectSession would early-return and skip sendResize.
    //
    // PR B2 consolidated runOpenCode() (and 7 siblings) into one shared
    // _runCliMode(mode) — runOpenCode is now a one-line wrapper
    // (`return this._runCliMode('opencode')`), so inspecting ITS source would
    // never see the real launch logic and this check would pass vacuously
    // regardless of what _runCliMode actually does. Inspect _runCliMode itself.
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    const { selectIdx, assignIdx } = await page.evaluate(() => {
      const app = (window as unknown as { app: { _runCliMode: { toString: () => string } } }).app;
      const source = app._runCliMode.toString();

      // The launcher hands the FIRST created session to selectSession
      // (`_launchQuickStartInstances()` returns `firstSessionId`). An earlier
      // version of this check looked for `this.selectSession(data.sessionId)`,
      // a string that exists nowhere in session-ui.js, so both lookups came
      // back -1 and the assertion could never fail. Hence the anti-vacuity
      // check below: the select call itself must be found.
      const selectIdx = source.indexOf('this.selectSession(firstSessionId)');
      // ANY assignment to activeSessionId (whatever the right-hand side is
      // called), not `==`/`===` comparisons and not the comment that mentions
      // pre-setting it without a `this.` prefix.
      const assign = /this\.activeSessionId\s*=(?!=)/.exec(source);
      return { selectIdx, assignIdx: assign ? assign.index : -1 };
    });

    // Anti-vacuity: if the select call is renamed again, fail here rather
    // than pass on two -1s.
    expect(selectIdx).toBeGreaterThan(-1);
    // Correct: no assignment at all. Bug: an assignment that lands BEFORE
    // selectSession runs, which makes selectSession early-return.
    expect(
      assignIdx === -1 || assignIdx > selectIdx,
      `activeSessionId is assigned at ${assignIdx}, before selectSession at ${selectIdx}`
    ).toBe(true);
  });

  it('sends resize to server after creating a session via quick-start', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // COD-370 (`8bb9c972`) fenced the HTTP resize fallback off: viewer geometry
    // is ownership-sensitive and only the sizing token on the terminal socket may
    // resize the shared PTY, so `POST /api/sessions/:id/resize` is no longer on
    // this path at all. Watch the socket frame (`{t:'z',c,r}`) instead — routing
    // the retired endpoint made this assertion unsatisfiable, not merely stale.
    await page.addInitScript(() => {
      (window as any).__resizeFrames = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (payload: any) {
        try {
          const msg = JSON.parse(payload);
          if (msg?.t === 'z') (window as any).__resizeFrames.push({ url: this.url, cols: msg.c, rows: msg.r });
        } catch {}
        return send.call(this, payload);
      };
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 5000 });

    // Create a session via API (simulating what quick-start does)
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-resize-test' }),
      });
      const data = await res.json();
      // POST /api/sessions answers in the { success, data: { session } } envelope.
      return data.data?.session?.id;
    });

    expect(sessionId).toBeTruthy();

    // Only frames caused by the SELECTION count. The window-resize handler and
    // the pending-frame flush both put `t:'z'` on the same socket, so without
    // this reset the assertion passes even with sendResize stubbed out — which
    // is exactly what a mutation check caught.
    await page.evaluate(() => ((window as any).__resizeFrames.length = 0));

    // Call selectSession (which is what runOpenCode does after fix)
    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);

    // Wait for the resize to be sent (it's fire-and-forget in selectSession)
    await page.waitForFunction(() => ((window as any).__resizeFrames?.length ?? 0) >= 1, { timeout: 10_000 });

    // Verify resize was sent with reasonable dimensions (not the 120x40 default)
    const resizeCalls: Array<{ url: string; cols: number; rows: number }> = await page.evaluate(
      () => (window as any).__resizeFrames
    );
    expect(resizeCalls.length).toBeGreaterThanOrEqual(1);
    const lastResize = resizeCalls[resizeCalls.length - 1];
    expect(lastResize.url).toContain(sessionId);
    // Browser viewport is 1280x800 — terminal cols/rows should be substantially
    // different from the hardcoded 120x40 default. xterm.js calculates these
    // from container dimensions and cell size, but in headless mode with a
    // 1280x800 viewport, we should get something reasonable (>= 40 cols).
    expect(lastResize.cols).toBeGreaterThanOrEqual(40);
    expect(lastResize.rows).toBeGreaterThanOrEqual(10);
    // "Not stuck at 120x40" really means the frame carries what this xterm
    // actually measured, so pin it to the live dimensions rather than to a
    // floor that the 120x40 default would clear anyway.
    // Read xterm directly, not getTerminalDimensions(): the frame is built from
    // the same helper, so comparing against it would move both sides together
    // and assert nothing.
    expect(
      await page.evaluate(() => ({ cols: (window as any).app.terminal.cols, rows: (window as any).app.terminal.rows }))
    ).toEqual({
      cols: lastResize.cols,
      rows: lastResize.rows,
    });

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('selectSession does NOT early-return for a new session', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Create a session
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-earlyret-test' }),
      });
      const data = await res.json();
      // POST /api/sessions answers in the { success, data: { session } } envelope.
      return data.data?.session?.id;
    });

    expect(sessionId).toBeTruthy();

    // Verify activeSessionId is NOT the new session before selectSession
    const activeBeforeSelect = await page.evaluate(() => {
      const app = (window as unknown as { app: { activeSessionId: string | null } }).app;
      return app.activeSessionId;
    });

    // activeSessionId should be null or empty (welcome screen) — not our session
    expect(activeBeforeSelect).not.toBe(sessionId);

    // Now call selectSession and verify it actually runs (sets activeSessionId)
    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);

    const activeAfterSelect = await page.evaluate(() => {
      const app = (window as unknown as { app: { activeSessionId: string | null } }).app;
      return app.activeSessionId;
    });

    expect(activeAfterSelect).toBe(sessionId);

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('needsRefresh handler updates terminal resize state', async () => {
    // The needsRefresh handler is registered via connectSSE. For active sessions,
    // WS-backed sessions skip SSE refresh, so force the SSE fallback state in this
    // test before invoking _onSSENeedsRefresh.
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Force the SSE fallback path and then validate the needs-refresh + resize
    // state transition end-to-end.
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-refresh-test' }),
      });
      const data = await res.json();
      // POST /api/sessions answers in the { success, data: { session } } envelope.
      return data.data?.session?.id;
    });

    expect(sessionId).toBeTruthy();

    // Select the session first so activeSessionId is set
    await page.evaluate(async (sid: string) => {
      const app = (window as unknown as { app: { selectSession: (id: string) => Promise<void> } }).app;
      await app.selectSession(sid);
    }, sessionId);

    // The handler only resizes after it has replayed a NON-EMPTY terminal
    // buffer, so give the session a real PTY with some output first.
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}/shell`, { method: 'POST' });
      const deadline = Date.now() + 5000;
      for (;;) {
        await fetch(`/api/sessions/${sid}/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: 'echo needs-refresh-seed\r', useMux: false }),
        });
        await new Promise((r) => setTimeout(r, 400));
        const res = await fetch(`/api/sessions/${sid}/terminal?full=1`);
        if ((((await res.json())?.data?.terminalBuffer as string) ?? '').includes('needs-refresh-seed')) break;
        if (Date.now() > deadline) throw new Error('seed output never appeared');
      }
    }, sessionId);

    const stateBefore = await page.evaluate((sid) => {
      const app = (
        window as unknown as {
          app: {
            activeSessionId: string | null;
            _wsReady: boolean;
            _wsSessionId: string | null;
            _isLoadingBuffer: boolean;
            terminal: unknown;
            fitAddon: unknown;
            _lastResizeDims: { cols: number; rows: number } | null;
            getTerminalDimensions: () => { cols: number; rows: number } | null;
            sessions?: Map<string, { mode?: string }>;
          };
        }
      ).app;
      return {
        activeSessionId: app.activeSessionId,
        wsReady: app._wsReady,
        wsSessionId: app._wsSessionId,
        isLoadingBuffer: app._isLoadingBuffer,
        liveMirrorEnabled: (app as { _liveMirrorEnabled?: boolean })._liveMirrorEnabled,
        sessionMode: app.sessions?.get(sid as unknown as never)?.mode,
        hasTerminal: Boolean(app.terminal),
        hasFitAddon: Boolean(app.fitAddon),
        lastResizeDims: app._lastResizeDims,
        dims: app.getTerminalDimensions(),
      };
    }, sessionId);

    // Intercept terminal fetches so the refresh path has deterministic content.
    // Trailing `*` matters: `6866a617` made the recovery fetch ask for
    // `?full=1` (and fall back to `?tail=`), and a glob without it stops
    // matching the query string, so the route silently never fired and the
    // refresh saw the real server's empty buffer instead of the fixture.
    const terminalRoute = '**/api/sessions/*/terminal*';

    await page.route(terminalRoute, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            terminalBuffer: 'mock-buffer-after-needs-refresh',
          },
        }),
      });
    });

    // Confirm SSE wiring is present, then invoke the SSE path in fallback mode.
    const handlerBound = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            _sseHandlerWrappers?: Map<string, (event: { data: string }) => void>;
            _onSSENeedsRefresh: (data: { id?: string }) => Promise<void>;
          };
        }
      ).app;
      return Boolean(app._sseHandlerWrappers?.has('session:needsRefresh'));
    });

    expect(handlerBound).toBe(true);

    await page.evaluate(async (sid) => {
      const app = (
        window as unknown as {
          app: {
            _needsRefreshResizeCallCount: number;
            _lastResizeDims: { cols: number; rows: number } | null;
            sendResize: (sessionId: string) => Promise<unknown>;
            _wsReady: boolean;
            _wsSessionId: string | null;
            _isLoadingBuffer: boolean;
            sessions: Map<string, { mode?: string }>;
            _liveMirrorEnabled: boolean;
            selectSession?: (sessionId: string) => Promise<unknown>;
            _onSSENeedsRefresh: (data: { id?: string }) => Promise<void>;
          };
        }
      ).app;

      // Reset to make resize tracking a stable assertion signal for this test.
      app._lastResizeDims = null;
      app._needsRefreshResizeCallCount = 0;
      const originalSendResize = app.sendResize;
      app.sendResize = async function (sessionId: string) {
        app._needsRefreshResizeCallCount += 1;
        return originalSendResize.call(app, sessionId);
      };
      app._wsReady = false;
      app._wsSessionId = null;
      app._isLoadingBuffer = false;
      app._liveMirrorEnabled = false;
      const session = app.sessions.get(sid);
      if (session) {
        session.mode = 'shell';
      }
      await app._onSSENeedsRefresh({ id: sid });
    }, sessionId);

    // Wait for the async refresh pipeline to complete.
    await page.waitForFunction(() => {
      const app = (window as unknown as { app: { _needsRefreshResizeCallCount?: number } }).app;
      return (app._needsRefreshResizeCallCount ?? 0) > 0;
    });

    const stateAfter = await page.evaluate(() => {
      const app = (
        window as unknown as {
          app: {
            activeSessionId: string | null;
            _wsReady: boolean;
            _wsSessionId: string | null;
            _isLoadingBuffer: boolean;
            terminal: { buffer?: unknown } | null;
            _lastResizeDims: { cols: number; rows: number } | null;
          };
        }
      ).app;
      return {
        activeSessionId: app.activeSessionId,
        wsReady: app._wsReady,
        wsSessionId: app._wsSessionId,
        isLoadingBuffer: app._isLoadingBuffer,
        lastResizeDims: app._lastResizeDims,
      };
    });

    expect(stateAfter.lastResizeDims).toEqual(
      expect.objectContaining({
        cols: expect.any(Number),
        rows: expect.any(Number),
      })
    );
    expect(stateAfter.lastResizeDims?.cols).toBeGreaterThanOrEqual(40);
    expect(stateAfter.lastResizeDims?.rows).toBeGreaterThanOrEqual(10);

    // Cleanup
    await page.unroute(terminalRoute);
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });
});

describe(`${targetPrefix} OpenCode close modal text`, () => {
  let context: BrowserContext;
  let page: Page;

  afterAll(async () => {
    await context?.close();
  });

  it.skipIf(!HAS_OPENCODE)('shows "Kill Tmux & OpenCode" for opencode sessions', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Create a session and mark it as opencode mode in the frontend state.
    // The close-modal copy depends only on app.sessions mode, not an installed
    // OpenCode CLI.
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'oc-close-test' }),
      });
      const data = await res.json();
      // POST /api/sessions answers in the { success, data: { session } } envelope.
      return data.data?.session?.id;
    });

    expect(sessionId).toBeTruthy();

    await page.evaluate(async (sid: string) => {
      const app = (
        window as unknown as {
          app: { selectSession: (id: string) => Promise<void>; sessions: Map<string, { mode?: string }> };
        }
      ).app;
      await app.selectSession(sid);
      const session = app.sessions.get(sid);
      if (session) session.mode = 'opencode';
    }, sessionId);

    // Open the close confirmation modal
    await page.evaluate((sid: string) => {
      const app = (window as unknown as { app: { requestCloseSession: (id: string) => void } }).app;
      app.requestCloseSession(sid);
    }, sessionId);

    // Check the kill button text
    const killTitle = await page.locator('#closeConfirmKillTitle').textContent();
    expect(killTitle).toBe('Kill Tmux & OpenCode');

    // Close the modal
    await page.evaluate(() => {
      const app = (window as unknown as { app: { cancelCloseSession: () => void } }).app;
      app.cancelCloseSession();
    });

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });

  it('shows "Kill Tmux & Claude Code" for claude sessions', async () => {
    ({ context, page } = await freshPage());
    await navigateAndWait(page);

    // Create a standard claude session
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', name: 'cc-close-test' }),
      });
      const data = await res.json();
      // POST /api/sessions answers in the { success, data: { session } } envelope.
      return data.data?.session?.id;
    });

    expect(sessionId).toBeTruthy();

    await page.waitForTimeout(500);

    // Open the close confirmation modal
    await page.evaluate((sid: string) => {
      const app = (window as unknown as { app: { requestCloseSession: (id: string) => void } }).app;
      app.requestCloseSession(sid);
    }, sessionId);

    // Check the kill button text
    const killTitle = await page.locator('#closeConfirmKillTitle').textContent();
    expect(killTitle).toBe('Kill Tmux & Claude Code');

    // Close the modal
    await page.evaluate(() => {
      const app = (window as unknown as { app: { cancelCloseSession: () => void } }).app;
      app.cancelCloseSession();
    });

    // Cleanup
    await page.evaluate(async (sid: string) => {
      await fetch(`/api/sessions/${sid}`, { method: 'DELETE' });
    }, sessionId);
  });
});
